import { join } from "node:path";
import { all, duckPath, q, scalar } from "../db.js";
import { downloadArtifact } from "../download.js";
import { assertHeader, hashStaging, mergeStaging } from "../merge.js";
import { SALES_TRACK_SALE_SOURCES } from "../sources.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";
import { extractEntry } from "./zip.js";

/** FDOR SDF header (2026P layout, 23 columns). */
export const SDF_EXPECTED_COLUMNS: readonly string[] = [
  "CO_NO", "PARCEL_ID", "ASMNT_YR", "ATV_STRT", "GRP_NO", "DOR_UC", "NBRHD_CD", "MKT_AR", "CENSUS_BK",
  "SALE_ID_CD", "SAL_CHG_CD", "VI_CD", "OR_BOOK", "OR_PAGE", "CLERK_NO", "QUAL_CD", "SALE_YR", "SALE_MO",
  "SALE_PRC", "MULTI_PAR_SAL", "RS_ID", "MP_ID", "STATE_PARCEL_ID",
];

/**
 * Natural key of a sale across sources: parcel + year + month + book/page/clerk + price. Any two
 * source rows that agree on all of these are the same recorded transfer.
 */
export const SALE_KEY_SQL = (p: {
  parcel: string;
  yr: string;
  mo: string;
  book: string;
  page: string;
  clerk: string;
  price: string;
}): string =>
  `md5(concat_ws('|', ${p.parcel}, ${p.yr}::VARCHAR, ${p.mo}::VARCHAR, coalesce(${p.book}, ''), coalesce(${p.page}, ''), coalesce(${p.clerk}, ''), coalesce(${p.price}::BIGINT::VARCHAR, '')))`;

/**
 * SDF CSV + NAL SALE_*1/2 (from the already-merged parcels table) -> sales_history.
 * Source precedence when the same sale appears twice: SDF, then NAL sale 1, then NAL sale 2.
 */
export const runSales: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "sales");

  const artifact = await downloadArtifact({
    url: source.url,
    destDir,
    artifactsRoot: ctx.paths.artifactsDir,
    force: ctx.force,
    logger: log,
  });
  result.artifact = artifact;
  const csv = extractEntry({ zipPath: artifact.path, outDir: join(destDir, "extracted"), extension: ".csv" });
  const csvPath = duckPath(csv.path);

  const header = (await all<{ column_name: string }>(
    ctx.conn,
    `DESCRIBE SELECT * FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)`,
  )).map((r) => r.column_name);
  const drift = assertHeader({
    expected: SDF_EXPECTED_COLUMNS,
    actual: header,
    source: `SDF ${csv.entryName}`,
    allowNewColumns: ctx.env.ALLOW_NEW_COLUMNS === "1",
  });
  if (drift.newColumns.length > 0) result.limitations.push(`SDF has new columns not yet mapped: ${drift.newColumns.join(", ")}`);

  const parcelsLoaded = Number(await scalar(ctx.conn, "SELECT count(*) FROM parcels")) > 0;
  if (!parcelsLoaded) result.limitations.push("parcels table empty at sales time: NAL SALE_*1/2 not folded in this run");

  const nalPart = (n: 1 | 2) => `
    SELECT parcel_id,
           sale_yr${n} AS sale_year, sale_mo${n} AS sale_month, sale_prc${n} AS sale_price,
           or_book${n} AS or_book, or_page${n} AS or_page, clerk_no${n} AS clerk_no,
           qual_cd${n} AS qual_cd, vi_cd${n} AS vi_cd, sal_chng_cd${n} AS sale_change_cd,
           multi_par_sal${n} AS multi_parcel, NULL::VARCHAR AS sale_id_cd,
           'NAL_SALE${n}' AS sale_source, ${n + 1} AS priority
    FROM parcels WHERE sale_yr${n} IS NOT NULL AND sale_yr${n} > 0`;

  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.sales_history AS
    WITH sdf AS (
      SELECT TRIM(PARCEL_ID) AS parcel_id,
             TRY_CAST(SALE_YR AS INTEGER) AS sale_year, TRY_CAST(SALE_MO AS INTEGER) AS sale_month,
             TRY_CAST(SALE_PRC AS DOUBLE) AS sale_price,
             NULLIF(TRIM(OR_BOOK), '') AS or_book, NULLIF(TRIM(OR_PAGE), '') AS or_page, NULLIF(TRIM(CLERK_NO), '') AS clerk_no,
             NULLIF(TRIM(QUAL_CD), '') AS qual_cd, NULLIF(TRIM(VI_CD), '') AS vi_cd, NULLIF(TRIM(SAL_CHG_CD), '') AS sale_change_cd,
             NULLIF(TRIM(MULTI_PAR_SAL), '') AS multi_parcel, NULLIF(TRIM(SALE_ID_CD), '') AS sale_id_cd,
             'SDF' AS sale_source, 1 AS priority
      FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)
      WHERE NULLIF(TRIM(PARCEL_ID), '') IS NOT NULL
    ),
    unioned AS (
      SELECT * FROM sdf
      ${parcelsLoaded ? `UNION ALL ${nalPart(1)} UNION ALL ${nalPart(2)}` : ""}
    ),
    keyed AS (
      SELECT *,
        ${SALE_KEY_SQL({ parcel: "parcel_id", yr: "sale_year", mo: "sale_month", book: "or_book", page: "or_page", clerk: "clerk_no", price: "sale_price" })} AS sale_key
      FROM unioned
      WHERE sale_year IS NOT NULL AND sale_year > 0
    )
    SELECT sale_key, parcel_id,
           TRY_CAST(printf('%04d-%02d-01', sale_year, greatest(1, least(12, coalesce(sale_month, 1)))) AS DATE) AS sale_date,
           sale_year, sale_month, sale_price, or_book, or_page, clerk_no, qual_cd, vi_cd, sale_change_cd,
           multi_parcel, sale_id_cd, sale_source
    FROM keyed
    QUALIFY row_number() OVER (PARTITION BY sale_key ORDER BY priority) = 1
  `);

  const sdfRows = Number(await scalar(ctx.conn, `SELECT count(*) FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)`));
  const bySource = await all<{ sale_source: string; n: string | number }>(
    ctx.conn,
    "SELECT sale_source, count(*) AS n FROM staging.sales_history GROUP BY 1 ORDER BY 1",
  );
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.sales_history"));
  result.notes.sdfRows = sdfRows;
  result.notes.stagedBySource = Object.fromEntries(bySource.map((r) => [r.sale_source, Number(r.n)]));
  log.info("staged", { table: "staging.sales_history", rows: result.rowsStaged, sdfRows, bySource: result.notes.stagedBySource });

  const hashed = await hashStaging(ctx.conn, "staging.sales_history", {
    sourceSystem: source.sourceSystem,
    sourceUrl: source.url,
    sourceArtifact: artifact.relPath,
    sourceSha256: artifact.sha256,
    fetchedAt: artifact.fetchedAt,
    runId: ctx.runId,
  });
  // Rows that came from the NAL roll carry the NAL provenance, not the SDF artifact.
  await ctx.conn.run(`
    UPDATE ${hashed} h
    SET source_system = p.source_system, source_url = p.source_url, source_artifact = p.source_artifact,
        source_sha256 = p.source_sha256, fetched_at = p.fetched_at
    FROM parcels p
    WHERE h.sale_source LIKE 'NAL_%' AND p.parcel_id = h.parcel_id`);

  // sales_history also holds rows folded in by the pa_detail track. This staging table is the whole
  // of what SDF plus the NAL roll offered, and nothing more, so it can only speak for its own rows.
  result.merge = await mergeStaging(ctx.conn, {
    target: "sales_history",
    staging: hashed,
    keys: ["sale_key"],
    authoritativeScope: `t.sale_source IN (${SALES_TRACK_SALE_SOURCES.map((v) => q(v)).join(", ")})`,
  });
  log.info("merged", { table: "sales_history", ...result.merge });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
