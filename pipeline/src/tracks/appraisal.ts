import { join } from "node:path";
import { all, duckPath, q, scalar, tableExists } from "../db.js";
import { downloadArtifact } from "../download.js";
import { assertHeader, hashStaging, mergeStaging } from "../merge.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";
import { extractEntry } from "./zip.js";

/** FDOR NAL header (2026P layout, 165 columns). Drift against this list fails the run. */
export const NAL_EXPECTED_COLUMNS: readonly string[] = [
  "CO_NO", "PARCEL_ID", "FILE_T", "ASMNT_YR", "BAS_STRT", "ATV_STRT", "GRP_NO", "DOR_UC", "PA_UC", "SPASS_CD",
  "JV", "JV_CHNG", "JV_CHNG_CD", "AV_SD", "AV_NSD", "TV_SD", "TV_NSD", "JV_HMSTD", "AV_HMSTD",
  "JV_NON_HMSTD_RESD", "AV_NON_HMSTD_RESD", "JV_RESD_NON_RESD", "AV_RESD_NON_RESD", "JV_CLASS_USE",
  "AV_CLASS_USE", "JV_H2O_RECHRGE", "AV_H2O_RECHRGE", "JV_CONSRV_LND", "AV_CONSRV_LND", "JV_HIST_COM_PROP",
  "AV_HIST_COM_PROP", "JV_HIST_SIGNF", "AV_HIST_SIGNF", "JV_WRKNG_WTRFNT", "AV_WRKNG_WTRFNT", "NCONST_VAL",
  "DEL_VAL", "PAR_SPLT", "DISTR_CD", "DISTR_YR", "LND_VAL", "LND_UNTS_CD", "NO_LND_UNTS", "LND_SQFOOT",
  "DT_LAST_INSPT", "IMP_QUAL", "CONST_CLASS", "EFF_YR_BLT", "ACT_YR_BLT", "TOT_LVG_AREA", "NO_BULDNG",
  "NO_RES_UNTS", "SPEC_FEAT_VAL", "MULTI_PAR_SAL1", "QUAL_CD1", "VI_CD1", "SALE_PRC1", "SALE_YR1", "SALE_MO1",
  "OR_BOOK1", "OR_PAGE1", "CLERK_NO1", "SAL_CHNG_CD1", "MULTI_PAR_SAL2", "QUAL_CD2", "VI_CD2", "SALE_PRC2",
  "SALE_YR2", "SALE_MO2", "OR_BOOK2", "OR_PAGE2", "CLERK_NO2", "SAL_CHNG_CD2", "OWN_NAME", "OWN_ADDR1",
  "OWN_ADDR2", "OWN_CITY", "OWN_STATE", "OWN_ZIPCD", "OWN_STATE_DOM", "FIDU_NAME", "FIDU_ADDR1", "FIDU_ADDR2",
  "FIDU_CITY", "FIDU_STATE", "FIDU_ZIPCD", "FIDU_CD", "S_LEGAL", "APP_STAT", "CO_APP_STAT", "MKT_AR", "NBRHD_CD",
  "PUBLIC_LND", "TAX_AUTH_CD", "TWN", "RNG", "SEC", "CENSUS_BK", "PHY_ADDR1", "PHY_ADDR2", "PHY_CITY", "PHY_ZIPCD",
  "ALT_KEY", "ASS_TRNSFR_FG", "PREV_HMSTD_OWN", "ASS_DIF_TRNS", "CONO_PRV_HM", "PARCEL_ID_PRV_HMSTD", "YR_VAL_TRNSF",
  ...Array.from({ length: 46 }, (_, i) => `EXMPT_${String(i + 1).padStart(2, "0")}`),
  "EXMPT_80", "EXMPT_81", "EXMPT_82", "SEQ_NO", "RS_ID", "MP_ID", "STATE_PAR_ID", "SPC_CIR_CD", "SPC_CIR_YR", "SPC_CIR_TXT",
];

const EXMPT_COLS = NAL_EXPECTED_COLUMNS.filter((c) => c.startsWith("EXMPT_"));

function num(col: string): string {
  return `TRY_CAST(NULLIF(TRIM(${col}), '') AS DOUBLE) AS ${col.toLowerCase()}`;
}
function int(col: string): string {
  return `TRY_CAST(TRY_CAST(NULLIF(TRIM(${col}), '') AS DOUBLE) AS INTEGER) AS ${col.toLowerCase()}`;
}
function str(col: string): string {
  return `NULLIF(TRIM(${col}), '') AS ${col.toLowerCase()}`;
}

/** NAL CSV -> parcels (one row per PARCEL_ID). */
export const runAppraisal: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "appraisal");

  const artifact = await downloadArtifact({
    url: source.url,
    destDir,
    artifactsRoot: ctx.paths.artifactsDir,
    force: ctx.force,
    logger: log,
  });
  result.artifact = artifact;

  const csv = extractEntry({ zipPath: artifact.path, outDir: join(destDir, "extracted"), extension: ".csv" });
  log.info("csv_ready", { csv: csv.entryName, extracted: csv.extracted });
  const csvPath = duckPath(csv.path);

  const header = (await all<{ column_name: string }>(
    ctx.conn,
    `DESCRIBE SELECT * FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)`,
  )).map((r) => r.column_name);
  const drift = assertHeader({
    expected: NAL_EXPECTED_COLUMNS,
    actual: header,
    source: `NAL ${csv.entryName}`,
    allowNewColumns: ctx.env.ALLOW_NEW_COLUMNS === "1",
  });
  if (drift.newColumns.length > 0) {
    result.limitations.push(`NAL has new columns not yet mapped: ${drift.newColumns.join(", ")}`);
  }

  const exmptExpr = `NULLIF(array_to_string(list_filter([${EXMPT_COLS.map((c) => `NULLIF(TRIM(${c}), '')`).join(", ")}], x -> x IS NOT NULL), ';'), '')`;

  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.parcels AS
    SELECT
      TRIM(PARCEL_ID) AS parcel_id,
      ${str("CO_NO")}, ${int("ASMNT_YR")}, ${str("FILE_T")}, ${str("DOR_UC")}, ${str("PA_UC")}, ${str("SPASS_CD")},
      ${num("JV")}, ${num("JV_CHNG")}, ${str("JV_CHNG_CD")}, ${num("AV_SD")}, ${num("AV_NSD")}, ${num("TV_SD")}, ${num("TV_NSD")},
      ${num("JV_HMSTD")}, ${num("AV_HMSTD")}, ${num("JV_NON_HMSTD_RESD")}, ${num("AV_NON_HMSTD_RESD")},
      ${num("NCONST_VAL")}, ${num("DEL_VAL")}, ${str("PAR_SPLT")},
      ${num("LND_VAL")}, ${str("LND_UNTS_CD")}, ${num("NO_LND_UNTS")}, ${num("LND_SQFOOT")}, ${str("DT_LAST_INSPT")},
      ${str("IMP_QUAL")}, ${str("CONST_CLASS")}, ${int("EFF_YR_BLT")}, ${int("ACT_YR_BLT")}, ${num("TOT_LVG_AREA")},
      ${int("NO_BULDNG")}, ${int("NO_RES_UNTS")}, ${num("SPEC_FEAT_VAL")},
      ${str("MULTI_PAR_SAL1")}, ${str("QUAL_CD1")}, ${str("VI_CD1")}, ${num("SALE_PRC1")}, ${int("SALE_YR1")}, ${int("SALE_MO1")},
      ${str("OR_BOOK1")}, ${str("OR_PAGE1")}, ${str("CLERK_NO1")}, ${str("SAL_CHNG_CD1")},
      ${str("MULTI_PAR_SAL2")}, ${str("QUAL_CD2")}, ${str("VI_CD2")}, ${num("SALE_PRC2")}, ${int("SALE_YR2")}, ${int("SALE_MO2")},
      ${str("OR_BOOK2")}, ${str("OR_PAGE2")}, ${str("CLERK_NO2")}, ${str("SAL_CHNG_CD2")},
      ${str("OWN_NAME")}, ${str("OWN_ADDR1")}, ${str("OWN_ADDR2")}, ${str("OWN_CITY")}, ${str("OWN_STATE")}, ${str("OWN_ZIPCD")}, ${str("OWN_STATE_DOM")},
      ${str("FIDU_NAME")}, ${str("FIDU_ADDR1")}, ${str("FIDU_ADDR2")}, ${str("FIDU_CITY")}, ${str("FIDU_STATE")}, ${str("FIDU_ZIPCD")}, ${str("FIDU_CD")},
      ${str("S_LEGAL")}, ${str("APP_STAT")}, ${str("CO_APP_STAT")}, ${str("MKT_AR")}, ${str("NBRHD_CD")}, ${str("PUBLIC_LND")}, ${str("TAX_AUTH_CD")},
      ${str("TWN")}, ${str("RNG")}, ${str("SEC")}, ${str("CENSUS_BK")},
      ${str("PHY_ADDR1")}, ${str("PHY_ADDR2")}, ${str("PHY_CITY")}, ${str("PHY_ZIPCD")},
      ${str("ALT_KEY")}, ${str("ASS_TRNSFR_FG")}, ${str("PREV_HMSTD_OWN")}, ${num("ASS_DIF_TRNS")}, ${str("CONO_PRV_HM")}, ${str("PARCEL_ID_PRV_HMSTD")}, ${int("YR_VAL_TRNSF")},
      ${exmptExpr} AS exmpt_codes,
      ${int("SEQ_NO")}, ${str("RS_ID")}, ${str("MP_ID")}, ${str("STATE_PAR_ID")}, ${str("SPC_CIR_CD")}, ${int("SPC_CIR_YR")}, ${str("SPC_CIR_TXT")}
    FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)
    WHERE NULLIF(TRIM(PARCEL_ID), '') IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY TRIM(PARCEL_ID) ORDER BY TRY_CAST(SEQ_NO AS INTEGER) DESC NULLS LAST) = 1
  `);
  const rawRows = Number(await scalar(ctx.conn, `SELECT count(*) FROM read_csv(${q(csvPath)}, header = true, all_varchar = true)`));
  const staged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.parcels"));
  result.rowsStaged = staged;
  result.notes.rawCsvRows = rawRows;
  if (rawRows !== staged) {
    result.notes.collapsedDuplicateParcelIds = rawRows - staged;
    result.limitations.push(`${rawRows - staged} NAL rows collapsed onto an existing PARCEL_ID (kept highest SEQ_NO)`);
  }
  log.info("staged", { table: "staging.parcels", rows: staged, rawCsvRows: rawRows });

  const hashed = await hashStaging(ctx.conn, "staging.parcels", {
    sourceSystem: source.sourceSystem,
    sourceUrl: source.url,
    sourceArtifact: artifact.relPath,
    sourceSha256: artifact.sha256,
    fetchedAt: artifact.fetchedAt,
    runId: ctx.runId,
  });
  // Coordinates are owned by the geometry track; carry any already-known centroid so re-inserted
  // rows do not lose it. They are added AFTER hashing so the parcel hash reflects NAL content only.
  await ctx.conn.run(`ALTER TABLE ${hashed} ADD COLUMN latitude DOUBLE`);
  await ctx.conn.run(`ALTER TABLE ${hashed} ADD COLUMN longitude DOUBLE`);
  await ctx.conn.run(`ALTER TABLE ${hashed} ADD COLUMN geometry_source VARCHAR`);
  if (await tableExists(ctx.conn, "main", "parcel_geometry")) {
    await ctx.conn.run(`
      UPDATE ${hashed} h SET latitude = g.latitude, longitude = g.longitude, geometry_source = g.source_system
      FROM parcel_geometry g WHERE g.parcel_id = h.parcel_id`);
  }

  result.merge = await mergeStaging(ctx.conn, { target: "parcels", staging: hashed, keys: ["parcel_id"] });
  log.info("merged", { table: "parcels", ...result.merge });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
