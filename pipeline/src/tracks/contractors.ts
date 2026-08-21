import { closeSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { duckPath, q, scalar } from "../db.js";
import { downloadArtifact } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { BROWSER_UA } from "./http.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const DBPR_EXTRACTS = [
  { name: "cilb_certified", url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_certified.csv" },
  { name: "cilb_registered", url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_registered.csv" },
] as const;

/** Roofing licence type codes in the CILB extracts (CCC certified roofing, RC registered roofing). */
export const ROOFING_CODES = ["CCC", "RC", "CC", "RCC"];

/**
 * The real layout, read off the files from a US runner (probe run 32474146746). These extracts are
 * HEADERLESS and every row is one continuing-education course completion, not one licensee - which
 * is why cilb_certified carries 4.1 M rows for a few hundred thousand contractors. There is no
 * county column and no licence status column; position is the only contract the file offers.
 *
 *   0 licence type code      CGC / RA / CCC / RC
 *   1 licence type text      "Cert General" / "Reg Air" / "Cert Roofing"
 *   2 licence number         CGC058548
 *   3 licensee name          "AALDERINK, JAMES"
 *   4 address line 1         623 SE 19 CT
 *   5 address line 2         usually empty
 *   6 city, state and zip    "CAPE CORAL, FL  33990"   (one field, comma inside)
 *   7 licence expiry         08/31/2028
 *   8 course number          0008545
 *   9 course title           UNDERSTANDING WORKERS COMPENSATION
 *  10 credit hours           1
 *  11 completion date        07/29/2020
 */
export const DBPR_COLUMNS = [
  "lic_type_code", "lic_type_text", "license_no", "name", "addr1", "addr2",
  "city_state_zip", "expiration", "course_no", "course_title", "course_hours", "course_date",
] as const;

/**
 * DBPR extracts are quote/comma files that break DuckDB's dialect sniffer (stray quotes, ragged rows,
 * non-UTF8 bytes). Read them with an explicit dialect, no sniffing, rejects tolerated and counted.
 */
export function dbprReadCsv(csvPath: string, columns: readonly string[] = DBPR_COLUMNS): string {
  // auto_detect = false + an explicit all-VARCHAR column list skips the dialect sniffer entirely
  // (the sniffer rejects files with an unterminated quote even when delim/quote/escape are given)
  const cols = columns.map((c) => `'${c.replace(/'/g, "''")}': 'VARCHAR'`).join(", ");
  // parallel = false is required, not a tuning choice: DuckDB's parallel scanner refuses
  // null_padding together with quoted newlines, and these extracts have both (a ragged row and a
  // licensee address containing a newline inside quotes). It errors out mid-file rather than
  // degrading, which is how this failed at line 8321 of cilb_certified.csv.
  return `read_csv(${q(duckPath(csvPath))}, auto_detect = false, columns = {${cols}}, delim = ',', quote = '"', escape = '"', header = false,
    strict_mode = false, ignore_errors = true, null_padding = true, parallel = false, max_line_size = 4000000)`;
}

/**
 * Read the header line of a CSV (comma separated, quotes stripped) without DuckDB.
 *
 * Reads a bounded prefix rather than the file. cilb_certified.csv is ~754 MB and a whole-file read
 * into a JS string throws "Cannot create a string longer than 0x1fffffe8 characters" (V8 caps strings
 * near 512 MB), which is how this track died in CI. Nothing past the first newline is ever needed.
 */
export function readCsvHeader(csvPath: string): string[] {
  const firstLine = readFirstLine(csvPath).replace(/\r$/, "");
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

/** Bytes read per chunk when scanning or transcoding a multi-hundred-megabyte extract. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** The first line of a file, read a chunk at a time so file size does not matter. */
function readFirstLine(csvPath: string): string {
  const fd = openSync(csvPath, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let acc = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buf, 0, buf.length, position);
      if (bytes === 0) return acc.toString("utf8");
      position += bytes;
      const newline = buf.indexOf(0x0a, 0);
      if (newline !== -1 && newline < bytes) {
        return Buffer.concat([acc, buf.subarray(0, newline)]).toString("utf8");
      }
      acc = Buffer.concat([acc, buf.subarray(0, bytes)]);
      // A header this long is a malformed file, not a header; stop rather than buffer the whole extract.
      if (acc.length > CHUNK_BYTES * 4) return acc.toString("utf8");
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * If the file is not valid UTF-8, transcode latin-1 -> UTF-8 in place (returns true when transcoded).
 *
 * Streams in chunks: decoding a 754 MB extract in one call exceeds V8's maximum string length and
 * throws, which the old `catch` misread as "invalid UTF-8" and then hit again while transcoding.
 * TextDecoder is given `stream: true` so a multi-byte character split across a chunk boundary is
 * carried into the next chunk instead of being reported as invalid.
 */
export function ensureUtf8(csvPath: string): boolean {
  if (isValidUtf8(csvPath)) return false;
  const tmp = `${csvPath}.utf8`;
  const src = openSync(csvPath, "r");
  const out = openSync(tmp, "w");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytes = readSync(src, buf, 0, buf.length, position);
      if (bytes === 0) break;
      position += bytes;
      // latin-1 is single byte, so a chunk boundary can never split a character
      writeSync(out, Buffer.from(buf.subarray(0, bytes).toString("latin1"), "utf8"));
    }
  } finally {
    closeSync(src);
    closeSync(out);
  }
  renameSync(tmp, csvPath);
  return true;
}

function isValidUtf8(csvPath: string): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fd = openSync(csvPath, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buf, 0, buf.length, position);
      if (bytes === 0) {
        // flush: an incomplete character left at end of file is invalid
        decoder.decode(new Uint8Array(0));
        return true;
      }
      position += bytes;
      decoder.decode(buf.subarray(0, bytes), { stream: true });
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
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

/**
 * Map a DBPR extract onto the contractors staging columns by POSITION, because the file has no
 * header. Columns the extract simply does not carry (board number, DBA, licence status, original
 * licensure and effective dates) are selected as NULL rather than guessed at, and the run records
 * that as a limitation.
 *
 * City, state and zip arrive as one field, "CAPE CORAL, FL  33990", so they are split here. Rows
 * are course completions, so this yields many rows per licence; the caller aggregates.
 */
export function contractorSelectSql(csvPath: string, extractName: string): string {
  const t = (col: string) => `NULLIF(TRIM(${col}), '')`;
  const csz = "city_state_zip";
  return `
    SELECT ${t("license_no")} AS license_no,
           NULL::VARCHAR AS board_number,
           upper(${t("lic_type_code")}) AS occupation_code,
           ${t("name")} AS name,
           NULL::VARCHAR AS dba,
           ${t("lic_type_text")} AS license_class,
           NULLIF(TRIM(concat_ws(' ', ${t("addr1")}, ${t("addr2")})), '') AS address,
           ${t(`regexp_extract(${csz}, '^(.*),[^,]*$', 1)`)} AS city,
           ${t(`regexp_extract(${csz}, ',\\s*([A-Za-z]{2})\\s', 1)`)} AS state,
           ${t(`regexp_extract(${csz}, '([0-9]{5})(?:-[0-9]{4})?\\s*$', 1)`)} AS zip,
           NULL::VARCHAR AS county_code,
           NULL::VARCHAR AS primary_status,
           NULL::VARCHAR AS secondary_status,
           NULL::DATE AS original_license_date,
           NULL::DATE AS effective_date,
           TRY_CAST(TRY_STRPTIME(${t("expiration")}, '%m/%d/%Y') AS DATE) AS expiration_date,
           TRY_CAST(TRY_STRPTIME(${t("course_date")}, '%m/%d/%Y') AS DATE) AS course_date,
           TRY_CAST(${t("course_hours")} AS DOUBLE) AS course_hours,
           ${q(extractName)} AS extract_file
    FROM ${dbprReadCsv(csvPath)}`;
}

/** Duval municipalities. DBPR publishes no county field, so the county has to come from the address. */
export const DUVAL_CITIES = ["JACKSONVILLE", "JACKSONVILLE BEACH", "ATLANTIC BEACH", "NEPTUNE BEACH", "BALDWIN"];

/**
 * Collapse the course-completion rows to one row per licence, filtered to Duval.
 *
 * Duval is matched on its municipalities plus the 322xx zip range. That range is not exactly Duval
 * (32259 for example is St Johns), so the city list leads and the zip range only widens it; the
 * bleed is recorded as a limitation rather than hidden. Course activity is kept as signal, since a
 * contractor still filing continuing education is an active one.
 */
export function duvalContractorsSql(from: string): string {
  const cityMatch = DUVAL_CITIES.map((c) => `upper(city) = ${q(c)}`).join(" OR ");
  const duvalWhere = `state = 'FL' AND ((${cityMatch}) OR zip LIKE '322%')`;
  return `SELECT license_no,
           any_value(board_number) AS board_number,
           any_value(occupation_code) AS occupation_code,
           any_value(name) AS name,
           any_value(dba) AS dba,
           any_value(license_class) AS license_class,
           any_value(address) AS address,
           any_value(city) AS city,
           any_value(state) AS state,
           any_value(zip) AS zip,
           any_value(county_code) AS county_code,
           any_value(primary_status) AS primary_status,
           any_value(secondary_status) AS secondary_status,
           any_value(original_license_date) AS original_license_date,
           any_value(effective_date) AS effective_date,
           max(expiration_date) AS expiration_date,
           bool_or(occupation_code IN (${ROOFING_CODES.map((c) => q(c)).join(",")}))
             OR bool_or(upper(coalesce(license_class, '')) LIKE '%ROOF%') AS is_roofing,
           any_value(extract_file) AS extract_file,
           to_json({
             'ce_course_count': count(*),
             'ce_hours_total': sum(course_hours),
             'last_ce_date': max(course_date)
           }) AS source_payload
    FROM ${from}
    WHERE license_no IS NOT NULL AND (${duvalWhere})
    GROUP BY license_no`;
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
    // headerless file: record the first row so a layout change shows up in the run record
    result.notes[`${ex.name}_first_row`] = readCsvHeader(artifact.path);
    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.${ex.name} AS ${contractorSelectSql(artifact.path, ex.name)}`);
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
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.contractors AS ${duvalContractorsSql("staging.contractors_all")}`);
  result.limitations.push(
    "DBPR CILB extracts are headerless course-completion rows, mapped by column position; they carry no county, licence status, board number or DBA, so those stay NULL",
  );
  result.limitations.push(
    "Duval matched on municipality name plus the 322xx zip range, which overlaps a few neighbouring-county zips (e.g. 32259 St Johns); DBPR publishes no county field",
  );
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.contractors"));
  result.notes.roofingContractorsDuval = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.contractors WHERE is_roofing"));
  result.notes.duvalContractorsAllTrades = result.rowsStaged;
  const hashed = await hashStaging(ctx.conn, "staging.contractors", {
    sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: "contractors/<extract_file>.csv", sourceSha256: null,
    fetchedAt: firstArtifact?.fetchedAt ?? new Date().toISOString(), runId: ctx.runId,
  });
  await ctx.conn.run(`UPDATE ${hashed} SET source_artifact = 'contractors/' || extract_file || '.csv'`);
  for (const ex of DBPR_EXTRACTS) {
    await ctx.conn.run(`UPDATE ${hashed} SET source_url = ${q(ex.url)}, source_sha256 = ${q(String(result.notes[`${ex.name}_sha256`] ?? ""))} WHERE extract_file = ${q(ex.name)}`);
  }
  // Deliberately unscoped, unlike businesses / permits / coj_addresses. Both CILB extracts are full
  // statewide snapshots re-read in full on every run (downloadArtifact only skips the network when
  // the bytes are unchanged; the CSV is re-scanned either way), the Duval filter is applied to the
  // whole of both files, and this track is the only writer of `contractors`. So a licence held here
  // and absent from the staging really is a licence the source dropped, and missing_in_source may
  // speak for the whole table.
  result.merge = await mergeStaging(ctx.conn, { target: "contractors", staging: hashed, keys: ["license_no"] });
  log.info("merged", { table: "contractors", ...result.merge, duval: result.rowsStaged, roofing: result.notes.roofingContractorsDuval });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
