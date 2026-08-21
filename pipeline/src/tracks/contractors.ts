import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, duckPath, q, scalar } from "../db.js";
import { downloadArtifact } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { BROWSER_UA } from "./http.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const DBPR_EXTRACTS = [
  { name: "cilb_certified", url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_certified.csv" },
  { name: "cilb_registered", url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_registered.csv" },
] as const;

/** Roofing occupation codes in the CILB extracts (CCC certified roofing, RC registered roofing). */
export const ROOFING_CODES = ["CCC", "RC", "CC", "RCC"];

/**
 * DBPR extracts are quote/comma files that break DuckDB's dialect sniffer (stray quotes, ragged rows,
 * non-UTF8 bytes). Read them with an explicit dialect, no sniffing, rejects tolerated and counted.
 */
export function dbprReadCsv(csvPath: string, columns: string[]): string {
  // auto_detect = false + an explicit all-VARCHAR column list skips the dialect sniffer entirely
  // (the sniffer rejects files with an unterminated quote even when delim/quote/escape are given)
  const cols = columns.map((c) => `'${c.replace(/'/g, "''")}': 'VARCHAR'`).join(", ");
  return `read_csv(${q(duckPath(csvPath))}, auto_detect = false, columns = {${cols}}, delim = ',', quote = '"', escape = '"', header = true,
    strict_mode = false, ignore_errors = true, null_padding = true, max_line_size = 4000000)`;
}

/** Read the header line of a CSV (comma separated, quotes stripped) without DuckDB. */
export function readCsvHeader(csvPath: string): string[] {
  const buf = readFileSync(csvPath, { encoding: "utf8", flag: "r" });
  const firstLine = buf.slice(0, buf.indexOf("
") === -1 ? buf.length : buf.indexOf("
")).replace(/$/, "");
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.map((c, i) => (c.length === 0 ? `column${i}` : c));
}

/** Rows the tolerant reader dropped: physical data lines minus parsed rows (DuckDB's rejects table does
 *  not record every non-strict drop, so count from the raw line total). */
export async function dbprRejectedCount(conn: import("@duckdb/node-api").DuckDBConnection, csvPath: string, parsedRows: number): Promise<number> {
  const lines = Number(await scalar(conn, `SELECT count(*) FROM read_csv(${q(duckPath(csvPath))}, header = false, columns = {'raw': 'VARCHAR'}, delim = chr(1), quote = '', escape = '', ignore_errors = true)`));
  return Math.max(0, lines - 1 - parsedRows);
}

/** If the file is not valid UTF-8, transcode latin-1 -> UTF-8 in place (returns true when transcoded). */
export function ensureUtf8(csvPath: string): boolean {
  const buf = readFileSync(csvPath);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    writeFileSync(csvPath, Buffer.from(buf.toString("latin1"), "utf8"));
    return true;
  }
}

/** Resolve a header name case/space-insensitively (DBPR headers vary in casing and spacing). */
export function pickColumn(columns: string[], ...candidates: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const c of candidates) {
    const hit = columns.find((col) => norm(col) === norm(c));
    if (hit) return hit;
  }
  return null;
}

/** SQL that maps a DBPR extract (all varchar) onto the contractors staging columns. */
export function contractorSelectSql(columns: string[], csvPath: string, extractName: string): string {
  const col = (...c: string[]) => {
    const hit = pickColumn(columns, ...c);
    return hit === null ? "NULL::VARCHAR" : `NULLIF(TRIM("${hit.replace(/"/g, '""')}"), '')`;
  };
  const date = (...c: string[]) => `TRY_CAST(TRY_STRPTIME(${col(...c)}, '%m/%d/%Y') AS DATE)`;
  return `
    SELECT ${col("License Number", "LicenseNumber", "Lic Number", "License")} AS license_no,
           ${col("Board Number", "BoardNumber", "Board")} AS board_number,
           ${col("Occupation Code", "OccupationCode", "Occupation", "Profession Code")} AS occupation_code,
           ${col("Licensee Name", "Name", "LicenseeName")} AS name,
           ${col("DBA Name", "DBA", "D/B/A", "Doing Business As")} AS dba,
           ${col("Class", "License Class", "Rank")} AS license_class,
           ${col("Address", "Address Line 1", "Address1", "Street Address")} AS address,
           ${col("City")} AS city,
           ${col("State")} AS state,
           ${col("Zip", "Zip Code", "ZipCode")} AS zip,
           ${col("County Code", "CountyCode", "County")} AS county_code,
           ${col("Primary Status", "PrimaryStatus", "Status", "License Status")} AS primary_status,
           ${col("Secondary Status", "SecondaryStatus")} AS secondary_status,
           ${date("Original Licensure Date", "Original License Date", "OriginalLicensureDate", "Original Date")} AS original_license_date,
           ${date("Effective Date", "EffectiveDate")} AS effective_date,
           ${date("Expiration Date", "ExpirationDate", "Expires")} AS expiration_date,
           ${q(extractName)} AS extract_file,
           to_json(r) AS source_payload
    FROM ${dbprReadCsv(csvPath, columns)} r`;
}

/**
 * DBPR CILB licensee extracts (US egress; ~750 MB certified) -> contractors filtered to Duval.
 * The Duval county code is read from the data itself: the most common County Code among rows whose
 * city is JACKSONVILLE (DBPR codes are alphabetical county numbers; Duval is expected to be 16).
 */
export const runContractors: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "contractors");
  const headersFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "User-Agent": BROWSER_UA, Accept: "text/csv,*/*" } });

  const parts: string[] = [];
  let firstArtifact: Awaited<ReturnType<typeof downloadArtifact>> | null = null;
  for (const ex of DBPR_EXTRACTS) {
    const artifact = await downloadArtifact({ url: ex.url, destDir, artifactsRoot: ctx.paths.artifactsDir, fileName: `${ex.name}.csv`, force: ctx.force, logger: log, fetchImpl: headersFetch });
    if (firstArtifact === null) firstArtifact = artifact;
    if (artifact.status !== "unchanged" && ensureUtf8(artifact.path)) {
      result.limitations.push(`${ex.name}: file was not valid UTF-8; transcoded from latin-1`);
    }
    const columns = readCsvHeader(artifact.path);
    result.notes[`${ex.name}_columns`] = columns;
    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.${ex.name} AS ${contractorSelectSql(columns, artifact.path, ex.name)}`);
    const n = Number(await scalar(ctx.conn, `SELECT count(*) FROM staging.${ex.name}`));
    result.notes[`${ex.name}_rows_statewide`] = n;
    const rejected = await dbprRejectedCount(ctx.conn, artifact.path, n);
    result.notes[`${ex.name}_rows_rejected`] = rejected;
    if (rejected > 0) result.limitations.push(`${ex.name}: ${rejected} malformed CSV rows rejected (ragged/quoted lines), see DuckDB rejects`);
    result.notes[`${ex.name}_sha256`] = artifact.sha256;
    parts.push(`SELECT * FROM staging.${ex.name}`);
    log.info("extract_staged", { extract: ex.name, rows: n, bytes: artifact.bytes, status: artifact.status });
  }
  result.artifact = firstArtifact;
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.contractors_all AS ${parts.join(" UNION ALL ")}`);
  const codeRow = await all<{ county_code: string; n: string | number }>(
    ctx.conn,
    `SELECT county_code, count(*) AS n FROM staging.contractors_all WHERE upper(city) LIKE 'JACKSONVILLE%' AND state = 'FL' AND county_code IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
  );
  const duvalCode = codeRow[0]?.county_code ?? null;
  result.notes.countyCodeCandidates = codeRow.map((r) => ({ code: r.county_code, n: Number(r.n) }));
  result.notes.duvalCountyCode = duvalCode;
  const where = duvalCode !== null ? `county_code = ${q(duvalCode)} OR upper(city) LIKE 'JACKSONVILLE%'` : `upper(city) LIKE 'JACKSONVILLE%'`;
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.contractors AS
    SELECT *, occupation_code IN (${ROOFING_CODES.map((c) => q(c)).join(",")}) OR upper(coalesce(occupation_code, '')) LIKE '%ROOF%' AS is_roofing
    FROM staging.contractors_all WHERE license_no IS NOT NULL AND (${where})
    QUALIFY row_number() OVER (PARTITION BY license_no ORDER BY expiration_date DESC NULLS LAST) = 1`);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.contractors"));
  result.notes.roofingContractorsDuval = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.contractors WHERE is_roofing"));
  const hashed = await hashStaging(ctx.conn, "staging.contractors", {
    sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: "contractors/<extract_file>.csv", sourceSha256: null,
    fetchedAt: firstArtifact?.fetchedAt ?? new Date().toISOString(), runId: ctx.runId,
  });
  await ctx.conn.run(`UPDATE ${hashed} SET source_artifact = 'contractors/' || extract_file || '.csv'`);
  for (const ex of DBPR_EXTRACTS) {
    await ctx.conn.run(`UPDATE ${hashed} SET source_url = ${q(ex.url)}, source_sha256 = ${q(String(result.notes[`${ex.name}_sha256`] ?? ""))} WHERE extract_file = ${q(ex.name)}`);
  }
  result.merge = await mergeStaging(ctx.conn, { target: "contractors", staging: hashed, keys: ["license_no"] });
  log.info("merged", { table: "contractors", ...result.merge, duvalCode, roofing: result.notes.roofingContractorsDuval });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
