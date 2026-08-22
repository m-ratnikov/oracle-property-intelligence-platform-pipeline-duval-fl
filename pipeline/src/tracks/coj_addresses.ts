import { getTrackState, q, scalar, setTrackState } from "../db.js";
import { normalizeParcelIdSql } from "../features/normalize.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { COJ_ADDRESSES_URL } from "../sources.js";
import { arcgisDateWhere, epochToIso, fetchArcgisAll, fetchArcgisPage, type ArcgisFeature } from "./arcgis.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const COJ_ADDRESS_FIELDS = "ADDRESS_ID,RE,WHOLE_ADDRESS,ZIPCODE,LATITUDE,LONGITUDE,ZONING,LANDUSE,FLOODZONE,SUBDIVISION,EDIT_DATE";
export const STATE_KEY_LAST_EDIT = "last_edit_date_iso";
/** Consecutive runs whose page errors have held the watermark back. Reset by any complete pull. */
export const STATE_KEY_HELD_RUNS = "watermark_held_runs";

/**
 * How many consecutive error-holding runs before the watermark moves anyway.
 *
 * Three is enough for a transient 500 or a rate-limited page to clear on the next scheduled run
 * (the pipeline runs every six hours) without letting a permanently broken page pin the cursor for
 * a week.
 */
export const WATERMARK_HELD_RUNS_BUDGET = 3;

export interface AddressPointRow {
  address_id: string;
  re_raw: string | null;
  whole_address: string | null;
  zipcode: string | null;
  latitude: number | null;
  longitude: number | null;
  zoning: string | null;
  landuse: string | null;
  floodzone: string | null;
  subdivision: string | null;
  edit_date: string | null;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() === "" ? null : String(v).trim());
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseAddressPoint(f: ArcgisFeature): AddressPointRow | null {
  const a = f.attributes;
  const id = str(a.ADDRESS_ID);
  if (id === null) return null;
  return {
    address_id: id,
    re_raw: str(a.RE),
    whole_address: str(a.WHOLE_ADDRESS),
    zipcode: str(a.ZIPCODE),
    latitude: num(a.LATITUDE),
    longitude: num(a.LONGITUDE),
    zoning: str(a.ZONING),
    landuse: str(a.LANDUSE),
    floodzone: str(a.FLOODZONE),
    subdivision: str(a.SUBDIVISION),
    edit_date: epochToIso(a.EDIT_DATE),
  };
}

export async function stageAddressPoints(conn: import("@duckdb/node-api").DuckDBConnection, rows: AddressPointRow[]): Promise<void> {
  await conn.run(`CREATE OR REPLACE TABLE staging.address_points_raw (
    address_id VARCHAR, re_raw VARCHAR, whole_address VARCHAR, zipcode VARCHAR, latitude DOUBLE, longitude DOUBLE,
    zoning VARCHAR, landuse VARCHAR, floodzone VARCHAR, subdivision VARCHAR, edit_date TIMESTAMP)`);
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  for (let i = 0; i < rows.length; i += 1000) {
    const values = rows
      .slice(i, i + 1000)
      .map((r) => `(${q(r.address_id)}, ${q(r.re_raw)}, ${q(r.whole_address)}, ${q(r.zipcode)}, ${n(r.latitude)}, ${n(r.longitude)}, ${q(r.zoning)}, ${q(r.landuse)}, ${q(r.floodzone)}, ${q(r.subdivision)}, ${q(r.edit_date)}::TIMESTAMP)`);
    await conn.run(`INSERT INTO staging.address_points_raw VALUES ${values.join(",")}`);
  }
  await conn.run(`CREATE OR REPLACE TABLE staging.address_points AS
    SELECT r.address_id, r.re_raw, p.parcel_id, r.whole_address, r.zipcode, r.latitude, r.longitude, r.zoning, r.landuse, r.floodzone, r.subdivision, r.edit_date
    FROM (SELECT * FROM staging.address_points_raw QUALIFY row_number() OVER (PARTITION BY address_id ORDER BY edit_date DESC NULLS LAST) = 1) r
    LEFT JOIN (SELECT parcel_id, ${normalizeParcelIdSql("parcel_id")} AS norm FROM parcels) p ON p.norm = ${normalizeParcelIdSql("r.re_raw")}`);
}

/**
 * The `authoritativeScope` for the address_points merge: which target rows this pull can honestly
 * report as deleted at source.
 *
 * A complete, unbounded, error-free full pull IS the whole COJ address layer, and this track is the
 * only writer of `address_points`, so it may speak for the whole table (undefined = unscoped, on
 * purpose). An incremental pull only asked for `EDIT_DATE >= watermark`, so it can only speak for
 * rows at or after that watermark; a row whose edit_date is NULL falls out of scope, which is the
 * conservative direction. A bounded (COJ_MAX_PAGES) or partially failed pull saw an unknown subset
 * of the layer and can speak for nothing at all.
 */
export function addressPointsScope(opts: { mode: string; lastEdit: string | null; partial: boolean }): string | undefined {
  if (opts.partial) return "FALSE";
  if (opts.mode === "incremental" && opts.lastEdit !== null) return `t.edit_date >= ${q(opts.lastEdit)}::TIMESTAMP`;
  return undefined;
}

export interface WatermarkDecision {
  /** True when the cursor moves to `watermark`; false when it stays where the previous run left it. */
  advance: boolean;
  /** The value to persist when advancing. Null means there is nothing to persist. */
  watermark: string | null;
  /** Consecutive error-held runs after this one, to persist for the next run. */
  heldRuns: number;
  /** Recorded on the run source so a held or force-advanced cursor is visible without the DB. */
  limitation: string | null;
  reason: string;
}

/**
 * Where the EDIT_DATE cursor may move to, given what this pull actually covered.
 *
 * The cursor used to be set to `max(edit_date)` unconditionally, including on runs that had page
 * errors or that COJ_MAX_PAGES had truncated. Both leave rows inside the window unfetched, and
 * because the next run asks for `EDIT_DATE >= cursor` those rows are then never revisited: a single
 * failed page silently drops every address edit it contained, permanently. The runner already
 * computed both conditions for `addressPointsScope` and used them only to scope the merge.
 *
 * The two causes of a partial pull are NOT the same failure and are not treated the same:
 *
 *   - COJ_MAX_PAGES is a deterministic cap. The same tail offsets are missed on every run, so no
 *     amount of retrying covers them, and the rows are not lost - they are one config change away.
 *     The cursor therefore NEVER advances on a bounded pull. That is not a stall: while the cap is
 *     set the track simply cannot claim incremental coverage, and unsetting it is an operator
 *     action, not something a retry policy can do.
 *
 *   - Page errors are transient until they are not. The cursor is held so the next run re-pulls the
 *     same window, which recovers the rows for free when the error was a blip. Holding forever is
 *     the stall to avoid, and it buys nothing: rows behind a page that fails on every run are
 *     unreachable whatever the cursor says, while the held cursor makes every future run re-pull the
 *     entire window. So after WATERMARK_HELD_RUNS_BUDGET consecutive held runs the cursor advances
 *     and says loudly, in the run record, which window may contain rows that were never revisited.
 *
 * A complete pull resets the budget, so one clean run wipes the debt. So does an escape, on purpose:
 * a permanently broken page then settles into a cycle of three held runs (each of which re-pulls the
 * whole window and so gives the failing page three more chances) and one advance, which keeps the
 * window bounded instead of letting it grow without limit.
 */
export function nextAddressWatermark(opts: {
  /** max(edit_date) across the target table after the merge. */
  maxEdit: string | null;
  /** The cursor this run started from. */
  previous: string | null;
  bounded: boolean;
  pageErrors: number;
  heldRuns: number;
  budget?: number;
}): WatermarkDecision {
  const budget = opts.budget ?? WATERMARK_HELD_RUNS_BUDGET;
  const from = opts.previous ?? "the start of the layer";
  if (opts.maxEdit === null) {
    return { advance: false, watermark: null, heldRuns: opts.heldRuns, limitation: null, reason: "no edit_date on record yet" };
  }
  if (!opts.bounded && opts.pageErrors === 0) {
    return { advance: true, watermark: opts.maxEdit, heldRuns: 0, limitation: null, reason: "complete pull: the whole window was covered" };
  }
  if (opts.bounded) {
    return {
      advance: false,
      watermark: opts.previous,
      // Unchanged, not incremented: this counter measures how long page errors have persisted, and
      // a bounded pull says nothing about that. Incrementing it here would spend the error budget
      // on runs that never had an error.
      heldRuns: opts.heldRuns,
      limitation: `EDIT_DATE watermark held at ${from}: COJ_MAX_PAGES truncated this pull, so rows past the cap were never fetched. The cap is deterministic, so retrying cannot cover them; unset COJ_MAX_PAGES to let the watermark move.`,
      reason: "bounded pull: the uncovered tail is reachable only by removing the cap",
    };
  }
  const heldRuns = opts.heldRuns + 1;
  if (heldRuns <= budget) {
    return {
      advance: false,
      watermark: opts.previous,
      heldRuns,
      limitation: `EDIT_DATE watermark held at ${from}: ${opts.pageErrors} page(s) failed, so an unknown subset of this window was not fetched. Held run ${heldRuns} of ${budget}; the next run re-pulls the same window.`,
      reason: "partial pull within the retry budget: the next run re-covers this window",
    };
  }
  return {
    advance: true,
    watermark: opts.maxEdit,
    heldRuns: 0,
    limitation: `EDIT_DATE watermark ADVANCED to ${opts.maxEdit} over ${opts.pageErrors} failed page(s) after ${heldRuns} consecutive held runs. Address edits between ${from} and ${opts.maxEdit} that sat in a failed page will NOT be revisited by an incremental pull; re-run this track with --force for a full backfill.`,
    reason: "partial pull past the retry budget: the failing pages look permanent, so the cursor stops re-pulling a window it cannot complete",
  };
}

/**
 * COJ address points (US egress). First run: full paged pull. Later runs: `EDIT_DATE >= <last max>`
 * (ArcGIS `timestamp` literal); when the server rejects the date filter the run falls back to a full
 * pull and records it. Rows fetched per run are recorded: this is the true-incremental proof.
 */
export const runCojAddresses: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const lastEdit = await getTrackState(ctx.conn, source.track, STATE_KEY_LAST_EDIT);
  const heldRuns = Number(await getTrackState(ctx.conn, source.track, STATE_KEY_HELD_RUNS)) || 0;
  const maxPages = ctx.env.COJ_MAX_PAGES ? Number(ctx.env.COJ_MAX_PAGES) : undefined;
  let where = "1=1";
  let mode = "full";
  if (lastEdit !== null && !ctx.force) {
    const candidate = arcgisDateWhere("EDIT_DATE", lastEdit);
    const probe = await fetchArcgisPage({ baseUrl: COJ_ADDRESSES_URL, where: candidate, outFields: "ADDRESS_ID", pageSize: 1 }, 0);
    if (probe.error === null) {
      where = candidate;
      mode = "incremental";
    } else {
      result.limitations.push(`EDIT_DATE filter rejected (${probe.error}); full pull instead`);
    }
  }
  result.notes.mode = mode;
  result.notes.where = where;
  const started = Date.now();
  const res = await fetchArcgisAll({ baseUrl: COJ_ADDRESSES_URL, where, outFields: COJ_ADDRESS_FIELDS, pageSize: 2000, concurrency: 2, delayMs: 250, maxPages });
  result.notes.pages = res.pages;
  result.notes.total = res.total;
  result.notes.fetchMs = Date.now() - started;
  result.notes.rowsFetched = res.features.length;
  if (res.errors.length > 0) result.limitations.push(`${res.errors.length} page errors: ${res.errors.slice(0, 3).join("; ")}`);
  if (maxPages !== undefined) result.limitations.push(`COJ_MAX_PAGES=${maxPages}: bounded pull`);
  if (res.features.length === 0 && mode === "full") throw new Error(`COJ addresses: no features fetched (${res.errors[0] ?? "unknown error"})`);
  const rows = res.features.map(parseAddressPoint).filter((r): r is AddressPointRow => r !== null);
  await stageAddressPoints(ctx.conn, rows);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.address_points"));
  result.notes.matchedToNal = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.address_points WHERE parcel_id IS NOT NULL"));
  const hashed = await hashStaging(ctx.conn, "staging.address_points", {
    sourceSystem: source.sourceSystem, sourceUrl: COJ_ADDRESSES_URL, sourceArtifact: `coj_addresses/${mode}`, sourceSha256: null,
    fetchedAt: new Date().toISOString(), runId: ctx.runId,
  });
  const authoritativeScope = addressPointsScope({ mode, lastEdit, partial: maxPages !== undefined || res.errors.length > 0 });
  result.notes.authoritativeScope = authoritativeScope ?? "whole table (complete snapshot, sole writer)";
  result.merge = await mergeStaging(ctx.conn, { target: "address_points", staging: hashed, keys: ["address_id"], authoritativeScope });
  const maxEdit = await scalar<string | null>(ctx.conn, "SELECT strftime(max(edit_date), '%Y-%m-%dT%H:%M:%S') FROM address_points");
  const watermark = nextAddressWatermark({
    maxEdit,
    previous: lastEdit,
    bounded: maxPages !== undefined,
    pageErrors: res.errors.length,
    heldRuns,
  });
  if (watermark.advance && watermark.watermark !== null) {
    await setTrackState(ctx.conn, source.track, STATE_KEY_LAST_EDIT, watermark.watermark, ctx.runId);
  }
  await setTrackState(ctx.conn, source.track, STATE_KEY_HELD_RUNS, String(watermark.heldRuns), ctx.runId);
  if (watermark.limitation !== null) result.limitations.push(watermark.limitation);
  // The cursor the NEXT run will start from, which is the only reading of this field that is ever
  // useful; what this pull saw is maxEditSeen.
  result.notes.lastEditDate = watermark.advance ? watermark.watermark : lastEdit;
  result.notes.maxEditSeen = maxEdit;
  result.notes.watermark = { advanced: watermark.advance, heldRuns: watermark.heldRuns, reason: watermark.reason };
  log.info("merged", { table: "address_points", mode, ...result.merge });
  log.info("watermark", {
    track: source.track,
    advanced: watermark.advance,
    from: lastEdit,
    to: result.notes.lastEditDate,
    heldRuns: watermark.heldRuns,
    pageErrors: res.errors.length,
    bounded: maxPages !== undefined,
    reason: watermark.reason,
  });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
