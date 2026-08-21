import { getTrackState, q, scalar, setTrackState } from "../db.js";
import { normalizeParcelIdSql } from "../features/normalize.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { COJ_ADDRESSES_URL } from "../sources.js";
import { arcgisDateWhere, epochToIso, fetchArcgisAll, fetchArcgisPage, type ArcgisFeature } from "./arcgis.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const COJ_ADDRESS_FIELDS = "ADDRESS_ID,RE,WHOLE_ADDRESS,ZIPCODE,LATITUDE,LONGITUDE,ZONING,LANDUSE,FLOODZONE,SUBDIVISION,EDIT_DATE";
export const STATE_KEY_LAST_EDIT = "last_edit_date_iso";

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
 * COJ address points (US egress). First run: full paged pull. Later runs: `EDIT_DATE >= <last max>`
 * (ArcGIS `timestamp` literal); when the server rejects the date filter the run falls back to a full
 * pull and records it. Rows fetched per run are recorded: this is the true-incremental proof.
 */
export const runCojAddresses: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const lastEdit = await getTrackState(ctx.conn, source.track, STATE_KEY_LAST_EDIT);
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
  result.merge = await mergeStaging(ctx.conn, { target: "address_points", staging: hashed, keys: ["address_id"] });
  const maxEdit = await scalar<string | null>(ctx.conn, "SELECT strftime(max(edit_date), '%Y-%m-%dT%H:%M:%S') FROM address_points");
  if (maxEdit) await setTrackState(ctx.conn, source.track, STATE_KEY_LAST_EDIT, maxEdit, ctx.runId);
  result.notes.lastEditDate = maxEdit;
  log.info("merged", { table: "address_points", mode, ...result.merge });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
