import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { PIPELINE_DIR } from "../config.js";
import { all, one, q, scalar, setTrackState } from "../db.js";
import { downloadArtifact, sha256File } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { PA_DETAIL_SALE_SOURCE } from "../sources.js";
import { SALE_KEY_SQL } from "./sales.js";
import { BROWSER_UA, mapLimit, sleep } from "./http.js";
import { parsePaDetail, type PaDetail } from "./pa_detail_parse.js";
import type { TrackContext, TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const PA_DETAIL_URL = "https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=";
export const SEED_DRIVE_ID = "17Nb7JLA5Lz7bVNwJ6IJz0hhuOsnBJL2m";
export const SEED_DRIVE_URL = `https://drive.usercontent.google.com/download?id=${SEED_DRIVE_ID}&export=download&confirm=t`;
export const STATE_CURSOR = "seed_cursor";
/** Temp table naming every seed parcel this track already has evidence for; see refreshDoneParcels. */
export const DONE_PARCELS = "pa_detail_done_parcels";
/** Appended once a run's merges commit, listing the parcels it read a page for; see refreshDoneParcels. */
export const MERGED_LOG = "merged-parcels.txt";
export const VENDOR_DIR = resolve(PIPELINE_DIR, "vendor", "duval-transform");
export const TRANSFORM_SCRIPTS = ["ownerMapping.js", "structureMapping.js", "utilityMapping.js", "layoutMapping.js", "data_extractor.js"];

/** `--window 300` | `300 parcels` -> parcels per run (default 300). */
export function paWindow(window: string | null, fallback = 300): number {
  if (window === null) return fallback;
  const m = /^(\d+)\s*(parcels?|p)?$/i.exec(window.trim());
  return m ? Math.max(1, Number(m[1])) : fallback;
}

/** Ensure DATA_DIR/seed/Duval.csv exists (copy the local zip next to it, or download from Google Drive in CI). */
export async function ensureSeed(ctx: TrackContext): Promise<string> {
  const seedDir = join(ctx.paths.dataDir, "seed");
  const csv = join(seedDir, "Duval.csv");
  if (existsSync(csv)) return csv;
  mkdirSync(seedDir, { recursive: true });
  const zipPath = join(seedDir, "Duval.zip");
  if (!existsSync(zipPath)) {
    await downloadArtifact({ url: SEED_DRIVE_URL, destDir: seedDir, artifactsRoot: ctx.paths.dataDir, fileName: "Duval.zip", logger: ctx.logger });
  }
  const { extractEntry } = await import("./zip.js");
  const out = extractEntry({ zipPath, outDir: seedDir, extension: ".csv" });
  if (out.path !== csv) cpSync(out.path, csv);
  return csv;
}

/** The seed CSV as a DuckDB relation (forward slashes so a Windows path survives quoting). */
function seedRead(seedCsv: string): string {
  return `read_csv(${q(seedCsv.replace(/\\/g, "/"))}, header = true, all_varchar = true)`;
}

/**
 * Rebuild, from the data itself, the set of seed parcels this track has already done.
 *
 * The resume position used to be a counter in `track_state`. That counter lives in the DuckDB
 * working set, the working set lives in a branch-scoped GitHub Actions cache, and such a cache is
 * evicted after 7 days and cannot be read from another branch. When the cache went away the counter
 * rewound to 0 while the tables it was meant to describe did not, so the track re-walked parcels it
 * already held and `pa_detail_buildings` went backwards (1,619 rows -> 466). Deriving the position
 * every run removes the thing that can desynchronise: a cold database with a warm table resumes
 * where the table ends, and a genuinely empty table starts at the beginning.
 *
 * Two kinds of evidence. Rows in `pa_detail_buildings` or `pa_detail_sales` are the normal case,
 * and the second table has to be there because vacant land parses to zero building rows while
 * usually still carrying sales. `merged-parcels.txt` covers the parcel whose page yields neither.
 * Without that term such a parcel would be selected again on every run, the backlog would grow each
 * time, and the track would eventually stall on a window it had already read. The log is appended
 * only once a run's merges have committed, so a run that died between fetching and merging claims
 * nothing and is retried from its cached pages. It sits in the same cached data directory as the
 * DuckDB, so the two are warm and cold together, and losing it costs a re-read, never a row.
 */
export async function refreshDoneParcels(conn: DuckDBConnection, mergedLog: string, table = DONE_PARCELS): Promise<number> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE ${table} (parcel_id VARCHAR)`);
  await conn.run(`INSERT INTO ${table} SELECT parcel_id FROM pa_detail_buildings UNION SELECT parcel_id FROM pa_detail_sales`);
  if (existsSync(mergedLog)) {
    await conn.run(`INSERT INTO ${table} SELECT p FROM (
        SELECT DISTINCT trim(parcel_id) AS p FROM read_csv(${q(mergedLog.replace(/\\/g, "/"))}, header = false, columns = {'parcel_id': 'VARCHAR'})
      ) WHERE p NOT IN (SELECT parcel_id FROM ${table})`);
  }
  return Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${table}`));
}

/**
 * The next `window` seed parcels with no evidence yet, in seed order.
 *
 * `rn` is reported, never stored. Two consecutive runs cannot overlap, because the first run's
 * parcels are in the done set by the time the second one asks. That also disarms `row_number()`
 * here: it has no ORDER BY and the CSV read is parallel, so it was never safe to count a stored
 * offset against it.
 */
export function seedWindowSql(seedCsv: string, window: number, table = DONE_PARCELS): string {
  return `SELECT parcel_id, address, rn FROM (
      SELECT trim(parcel_id) AS parcel_id, address, row_number() OVER () AS rn FROM ${seedRead(seedCsv)}
    ) s
    WHERE NOT EXISTS (SELECT 1 FROM ${table} d WHERE d.parcel_id = s.parcel_id)
    ORDER BY rn LIMIT ${Math.max(1, Math.trunc(window))}`;
}

export interface SeedPosition {
  seedTotal: number;
  /** seed parcels with no evidence yet */
  remaining: number;
  /** seedTotal - remaining, the figure reported as the cursor */
  done: number;
}

/**
 * Where the track stands in the seed, measured rather than remembered. `done` counts seed parcels
 * only, so a row for a parcel outside the seed cannot inflate it, and it is derived from the same
 * evidence the window is chosen by, so the reported figure and the work actually done cannot drift.
 */
export async function seedPosition(conn: DuckDBConnection, seedCsv: string, table = DONE_PARCELS): Promise<SeedPosition> {
  const row = await one<{ seed_total: string | number; remaining: string | number }>(
    conn,
    `SELECT count(*) AS seed_total, count(*) FILTER (WHERE d.parcel_id IS NULL) AS remaining
     FROM ${seedRead(seedCsv)} s LEFT JOIN (SELECT DISTINCT parcel_id FROM ${table}) d ON d.parcel_id = trim(s.parcel_id)`,
  );
  const seedTotal = Number(row.seed_total);
  const remaining = Number(row.remaining);
  return { seedTotal, remaining, done: seedTotal - remaining };
}

/** Run the vendored Elephant transform scripts on one saved page; returns the lexicon output dir or null. */
export function runLexiconTransform(re: string, html: string, unnormalizedAddress: string, outRoot: string, log: { warn: (e: string, f?: Record<string, unknown>) => void }): { ok: boolean; files: string[]; error: string | null } {
  const work = mkdtempSync(join(tmpdir(), "duval-pa-"));
  try {
    writeFileSync(join(work, "input.html"), html);
    writeFileSync(join(work, "unnormalized_address.json"), JSON.stringify({ full_address: unnormalizedAddress, source_http_request: { method: "GET", url: `${PA_DETAIL_URL}${re}` }, request_identifier: re }, null, 2));
    writeFileSync(join(work, "property_seed.json"), JSON.stringify({ parcel_id: re, request_identifier: re }));
    mkdirSync(join(work, "owners"), { recursive: true });
    mkdirSync(join(work, "data"), { recursive: true });
    for (const script of TRANSFORM_SCRIPTS) {
      try {
        execFileSync(process.execPath, [join(VENDOR_DIR, script)], { cwd: work, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
      } catch (err) {
        log.warn("lexicon_script_failed", { re, script, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      }
    }
    const dataDir = join(work, "data");
    const files = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => f.endsWith(".json")) : [];
    if (files.length === 0) return { ok: false, files: [], error: "no data/*.json produced" };
    const dest = join(outRoot, re);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(dataDir, join(dest, "data"), { recursive: true });
    if (existsSync(join(work, "owners"))) cpSync(join(work, "owners"), join(dest, "owners"), { recursive: true });
    return { ok: true, files, error: null };
  } catch (err) {
    return { ok: false, files: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface PaFetchOutcome {
  re: string;
  status: number;
  fromCache: boolean;
  detail: PaDetail | null;
  error: string | null;
}

/**
 * PA detail pilot (US egress): iterate the seed in order, taking the next N parcels the track holds
 * no rows and no completed read for (the window is derived from the data, never from a stored
 * counter), concurrency 2, 400 ms delay, save raw HTML (skip existing), parse buildings + sales +
 * owner, run the vendored lexicon transform, merge into pa_detail_buildings / pa_detail_sales and
 * fold PA sales into sales_history (source_system duval_pa_detail). Throughput, errors and the
 * reported seed position recorded in run_log.
 */
export const runPaDetail: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "pa_detail");
  const htmlDir = join(destDir, "html");
  const lexiconDir = join(destDir, "lexicon");
  const mergedLog = join(destDir, MERGED_LOG);
  mkdirSync(htmlDir, { recursive: true });
  mkdirSync(lexiconDir, { recursive: true });
  const seedCsv = await ensureSeed(ctx);
  const window = paWindow(ctx.window, Number(ctx.env.PA_DETAIL_WINDOW ?? 300));
  // Resume from the data, not from a stored counter: refreshDoneParcels + seedWindowSql select the
  // next parcels with no rows and no completed read, whatever track_state happens to say.
  await refreshDoneParcels(ctx.conn, mergedLog);
  const before = await seedPosition(ctx.conn, seedCsv);
  const seedRows = await all<{ parcel_id: string; address: string | null; rn: string | number }>(ctx.conn, seedWindowSql(seedCsv, window));
  const seedTotal = before.seedTotal;
  const cursor = before.done;
  result.notes.seedTotal = seedTotal;
  result.notes.cursorStart = cursor;
  result.notes.remainingStart = before.remaining;
  result.notes.window = window;
  log.info("pa_detail_plan", { cursor, window, seedTotal, remaining: before.remaining, first: seedRows[0]?.parcel_id ?? null });

  const t0 = Date.now();
  let hits = 0;
  let cached = 0;
  let misses = 0;
  let errors = 0;
  let lexiconOk = 0;
  const outcomes: PaFetchOutcome[] = await mapLimit(seedRows, 2, 400, async (row) => {
    const re = row.parcel_id.trim();
    const file = join(htmlDir, `${re}.html`);
    let html: string | null = null;
    let status = 200;
    let fromCache = false;
    if (existsSync(file)) {
      html = readFileSync(file, "utf8");
      fromCache = true;
      cached += 1;
    } else {
      try {
        const res = await fetch(`${PA_DETAIL_URL}${encodeURIComponent(re)}`, {
          headers: { "User-Agent": BROWSER_UA, Accept: "text/html,*/*" },
          signal: AbortSignal.timeout(45_000),
          redirect: "follow",
        });
        status = res.status;
        const text = await res.text();
        if (res.ok && text.includes("cphBody")) {
          html = text;
          writeFileSync(file, text);
          hits += 1;
        } else {
          misses += 1;
          return { re, status, fromCache, detail: null, error: res.ok ? "page without detail content" : `HTTP ${res.status}` };
        }
      } catch (err) {
        errors += 1;
        await sleep(1000);
        return { re, status: 0, fromCache, detail: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const detail = parsePaDetail(html);
    if (detail.ok) {
      const lex = runLexiconTransform(re, html, row.address ?? detail.site_address ?? "", lexiconDir, log);
      if (lex.ok) lexiconOk += 1;
    }
    return { re, status, fromCache, detail, error: detail.ok ? null : "parse: no RE number found" };
  });
  const elapsedMin = (Date.now() - t0) / 60_000;
  const parsed = outcomes.filter((o) => o.detail?.ok);
  result.notes.throughput = { fetched: hits, cached, misses, errors, parsed: parsed.length, lexiconOk, minutes: Math.round(elapsedMin * 100) / 100, pagesPerMin: elapsedMin > 0 ? Math.round((hits / elapsedMin) * 10) / 10 : null };
  result.limitations.push(`measured: ${hits} pages fetched (+${cached} cached) in ${Math.round(elapsedMin * 10) / 10} min at concurrency 2 / 400 ms; ${misses} misses, ${errors} errors`);

  // stage buildings + sales
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.pa_detail_buildings (parcel_id VARCHAR, building_no INTEGER, building_type VARCHAR, actual_year_built INTEGER, roof_structure VARCHAR, roofing_cover VARCHAR,
    exterior_wall VARCHAR, heated_area_sqft DOUBLE, gross_area_sqft DOUBLE, effective_area_sqft DOUBLE, elements JSON, owner_name VARCHAR, mailing_address VARCHAR, site_address VARCHAR, html_sha256 VARCHAR)`);
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.pa_detail_sales (parcel_id VARCHAR, sale_date DATE, sale_price DOUBLE, or_book VARCHAR, or_page VARCHAR, book_page VARCHAR, document_url VARCHAR, deed_instrument VARCHAR, qualified VARCHAR, vacant_improved VARCHAR, html_sha256 VARCHAR)`);
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  const bRows: string[] = [];
  const sRows: string[] = [];
  for (const o of parsed) {
    const d = o.detail as PaDetail;
    const sha = await sha256File(join(htmlDir, `${o.re}.html`));
    const mailing = d.mailing_lines.join(", ");
    for (const b of d.buildings) {
      bRows.push(`(${q(o.re)}, ${b.building_no}, ${q(b.building_type)}, ${n(b.actual_year_built)}, ${q(b.roof_structure)}, ${q(b.roofing_cover)}, ${q(b.exterior_wall)}, ${n(b.heated_area_sqft)}, ${n(b.gross_area_sqft)}, ${n(b.effective_area_sqft)}, ${q(JSON.stringify(b.elements))}::JSON, ${q(d.owner_name)}, ${q(mailing || null)}, ${q(d.site_address)}, ${q(sha)})`);
    }
    for (const s of d.sales) {
      sRows.push(`(${q(o.re)}, ${q(s.sale_date)}::DATE, ${n(s.sale_price)}, ${q(s.or_book)}, ${q(s.or_page)}, ${q(s.book_page)}, ${q(s.document_url)}, ${q(s.deed_instrument)}, ${q(s.qualified)}, ${q(s.vacant_improved)}, ${q(sha)})`);
    }
  }
  for (let i = 0; i < bRows.length; i += 500) await ctx.conn.run(`INSERT INTO staging.pa_detail_buildings VALUES ${bRows.slice(i, i + 500).join(",")}`);
  for (let i = 0; i < sRows.length; i += 500) await ctx.conn.run(`INSERT INTO staging.pa_detail_sales VALUES ${sRows.slice(i, i + 500).join(",")}`);
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.pa_detail_buildings_k AS SELECT parcel_id || '#' || building_no AS building_key, * FROM staging.pa_detail_buildings QUALIFY row_number() OVER (PARTITION BY parcel_id, building_no) = 1`);
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.pa_detail_sales_k AS
    SELECT md5(concat_ws('|', parcel_id, sale_date::VARCHAR, coalesce(or_book, ''), coalesce(or_page, ''), coalesce(sale_price::BIGINT::VARCHAR, ''))) AS pa_sale_key, * FROM staging.pa_detail_sales
    WHERE sale_date IS NOT NULL QUALIFY row_number() OVER (PARTITION BY pa_sale_key) = 1`);
  // The parcels this run actually re-read and parsed. Each run stages one bounded window, so this
  // is the only set the three merges below can speak for: outside it, "not in staging" just means
  // "not read this run". Empty when nothing parsed, which scopes the missing counts to zero.
  // Since the window is now chosen as parcels with no rows held, these merges own nothing inside
  // their own scope and so report no missing rows; the scope stays because it is what makes that
  // true rather than accidental, and it is still what bounds the sales_history fold below.
  await ctx.conn.run("CREATE OR REPLACE TABLE staging.pa_detail_window_parcels (parcel_id VARCHAR)");
  const windowParcels = parsed.map((o) => `(${q(o.re)})`);
  for (let i = 0; i < windowParcels.length; i += 500) {
    await ctx.conn.run(`INSERT INTO staging.pa_detail_window_parcels VALUES ${windowParcels.slice(i, i + 500).join(",")}`);
  }
  const inWindow = "t.parcel_id IN (SELECT parcel_id FROM staging.pa_detail_window_parcels)";
  result.rowsStaged = parsed.length;
  const fetchedAt = new Date().toISOString();
  const prov = { sourceSystem: source.sourceSystem, sourceUrl: PA_DETAIL_URL, sourceArtifact: "pa_detail/html/<re>.html", sourceSha256: null, fetchedAt, runId: ctx.runId };
  const hb = await hashStaging(ctx.conn, "staging.pa_detail_buildings_k", prov);
  await ctx.conn.run(`UPDATE ${hb} SET source_url = ${q(PA_DETAIL_URL)} || parcel_id, source_artifact = 'pa_detail/html/' || parcel_id || '.html', source_sha256 = html_sha256`);
  await ctx.conn.run(`ALTER TABLE ${hb} DROP COLUMN html_sha256`);
  result.merge = await mergeStaging(ctx.conn, { target: "pa_detail_buildings", staging: hb, keys: ["building_key"], authoritativeScope: inWindow });
  const hs = await hashStaging(ctx.conn, "staging.pa_detail_sales_k", prov);
  await ctx.conn.run(`UPDATE ${hs} SET source_url = ${q(PA_DETAIL_URL)} || parcel_id, source_artifact = 'pa_detail/html/' || parcel_id || '.html', source_sha256 = html_sha256`);
  await ctx.conn.run(`ALTER TABLE ${hs} DROP COLUMN html_sha256`);
  result.notes.salesMerge = await mergeStaging(ctx.conn, { target: "pa_detail_sales", staging: hs, keys: ["pa_sale_key"], authoritativeScope: inWindow });

  // fold PA sales into sales_history (same natural key as SDF/NAL so duplicates collapse; PA wins on conflict? no: SDF precedence kept by merge on existing keys)
  // _all is every PA sale in this window, before the precedence filter. The merge stages only the
  // new keys, so this complete set is what says whether a row we already hold is still on the page.
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.sales_history_pa_all AS
    SELECT ${SALE_KEY_SQL({ parcel: "parcel_id", yr: "year(sale_date)", mo: "month(sale_date)", book: "or_book", page: "or_page", clerk: "NULL", price: "sale_price" })} AS sale_key,
           parcel_id, sale_date, year(sale_date) AS sale_year, month(sale_date) AS sale_month, sale_price, or_book, or_page, NULL::VARCHAR AS clerk_no,
           CASE WHEN upper(coalesce(qualified, '')) LIKE 'Q%' THEN 'Q' WHEN upper(coalesce(qualified, '')) LIKE 'U%' THEN 'U' ELSE NULL END AS qual_cd,
           CASE WHEN upper(coalesce(vacant_improved, '')) LIKE 'V%' THEN 'V' WHEN upper(coalesce(vacant_improved, '')) LIKE 'I%' THEN 'I' ELSE NULL END AS vi_cd,
           NULL::VARCHAR AS sale_change_cd, NULL::VARCHAR AS multi_parcel, deed_instrument AS sale_id_cd, ${q(PA_DETAIL_SALE_SOURCE)} AS sale_source
    FROM staging.pa_detail_sales_k`);
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.sales_history_pa AS
    SELECT * FROM staging.sales_history_pa_all WHERE sale_key NOT IN (SELECT sale_key FROM sales_history)`);
  const hsh = await hashStaging(ctx.conn, "staging.sales_history_pa", prov);
  await ctx.conn.run(`UPDATE ${hsh} SET source_url = ${q(PA_DETAIL_URL)} || parcel_id, source_artifact = 'pa_detail/html/' || parcel_id || '.html'`);
  result.notes.salesHistoryMerge = await mergeStaging(ctx.conn, {
    target: "sales_history",
    staging: hsh,
    keys: ["sale_key"],
    // a row this track wrote, for a parcel it just re-read, that the page no longer lists. The
    // staging above is a delta (keys already held are kept back so SDF wins), so the complete window
    // set decides whether a row is gone rather than merely already loaded.
    authoritativeScope: `t.sale_source = ${q(PA_DETAIL_SALE_SOURCE)} AND ${inWindow}
      AND t.sale_key NOT IN (SELECT sale_key FROM staging.sales_history_pa_all)`,
  });

  // Claim this run's parcels only now that the merges have committed. A run that dies before this
  // line claims nothing, so the next one reads its pages again (from cache, no refetch) instead of
  // skipping past them, and a parcel whose page holds neither a building nor a sale is still
  // claimed, so it is not offered forever.
  const processed = outcomes.filter((o) => o.detail !== null).map((o) => o.re);
  if (processed.length > 0) appendFileSync(mergedLog, `${processed.join("\n")}\n`);

  // Report the position, do not keep one: the same evidence the next run will select against, read
  // back after this run's rows and claims have landed. STATE_CURSOR is still written because runs/
  // snapshots it, but nothing reads it back to decide what to fetch.
  await refreshDoneParcels(ctx.conn, mergedLog);
  const after = await seedPosition(ctx.conn, seedCsv);
  await setTrackState(ctx.conn, source.track, STATE_CURSOR, String(after.done), ctx.runId);
  result.notes.cursorEnd = after.done;
  result.notes.remainingEnd = after.remaining;
  result.limitations.push(`seed position ${cursor} -> ${after.done} of ${seedTotal} parcels done (${seedRows.length} attempted this window of ${window}); derived from pa_detail_buildings / pa_detail_sales / ${MERGED_LOG}, never from a stored cursor`);
  log.info("pa_detail_done", { ...(result.notes.throughput as Record<string, unknown>), buildings: result.merge, sales: result.notes.salesMerge });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
