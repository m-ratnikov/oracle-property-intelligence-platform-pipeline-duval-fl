import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { COUNTY } from "../config.js";
import { all, count, one, q, scalar, tableExists } from "../db.js";
import type { Logger } from "../log.js";
import { computeCid } from "../publish/cid.js";
import { describeQueryTableArtifact, type ExportResult, type QueryTableArtifact, type ValidationReport } from "../features/export.js";
import { tableDelta, type RunSourceRecord } from "../run.js";

/**
 * Elephant open-data consolidation export (county-open-data-publish convention):
 *   properties/<property_id>.json  one consolidated record per property (uploaded under <cid>.json)
 *   shards/shard-NNNN.json         {schemaVersion "1", shardIndex, fromParcel, toParcel, count, entries[]}
 *   index.json                     {schemaVersion "1", county, exportedAt, completedAt, propertyCount, shardSize, totalBytes, shards[]}
 *   manifest.json                  flat back-compat {county, propertyCount, entries:[{propertyId, parcelIdentifier, filePath, fileSizeBytes, sha256, cid}]}
 * Incremental: consolidation_state keeps property_id -> content hash + cid; only changed/new records are
 * rebuilt and re-hashed; shards/index/manifest are always rebuilt from state.
 * The record deliberately excludes run timestamps and as-of dependent ages so an unchanged property
 * keeps its CID across runs.
 */
export const CONSOLIDATION_SCHEMA_VERSION = "1";

export interface ConsolidationOptions {
  outDir: string;
  shardSize: number;
  since: "all" | "changed" | string;
  limit: number | null;
  runId: string;
  logger: Logger;
  /** Lexicon JSON folders from the pa_detail track: <dir>/<re>/data/*.json */
  lexiconDir: string | null;
}

export interface ConsolidationStats {
  candidates: number;
  exported: number;
  unchanged: number;
  totalInState: number;
  totalBytes: number;
  shards: number;
  indexCid: string;
  manifestCid: string;
  ms: number;
}

/** The track name the consolidation pass records itself under in `run_log_sources`. */
export const CONSOLIDATION_TRACK = "consolidation";

export interface ConsolidationSourceInput {
  stats: ConsolidationStats;
  /** ISO-8601 UTC, the same shape every other run source is stamped with. */
  startedAt: string;
  finishedAt: string;
  /** Where this pass wrote its open-data tree, relative to the publish directory. */
  artifactPath: string;
  /** `table_total_after` of the previous recorded consolidation pass; null when there is none. */
  prevTotal: number | null;
  since: string;
  limit: number | null;
}

/**
 * How a consolidation pass describes itself as a run source.
 *
 * This exists so the pass stops hand rolling its own `INSERT INTO run_log_sources` with positional
 * literals. It built the published `sources` JSON and the table row from two separate expressions,
 * and they disagreed: the row put `stats.exported` in `delta_vs_prev_total`, the JSON carried no
 * such key at all, and the UI's fallback then derived `inserted + updated`, which is the same wrong
 * number by a different route. Both now come from this one record.
 *
 * `delta_vs_prev_total` is movement in `consolidation_state`'s own total against the previous
 * recorded consolidation pass, exactly as `tableDelta` defines it for every ingestion track.
 * `stats.exported` is how many property records THIS pass re-hashed and republished. A pass that
 * re-exported 337 unchanged-in-count properties moved the table by 0, and it published "+337".
 * Null stays null: no previous consolidation pass recorded is unknown, never zero.
 */
export function consolidationSourceRecord(input: ConsolidationSourceInput): RunSourceRecord {
  const { stats, prevTotal } = input;
  return {
    track: CONSOLIDATION_TRACK,
    source_system: "duval_consolidation",
    target_table: "consolidation_state",
    source_url: "derived",
    artifact_path: input.artifactPath,
    artifact_sha256: null,
    artifact_etag: null,
    artifact_last_modified: null,
    artifact_bytes: null,
    download_status: "derived",
    rows_staged: stats.candidates,
    // Every candidate whose content hash moved is deleted from consolidation_state and written
    // back, so this counts republished records: new properties and re-hashed ones together. See
    // the note in cli.ts; it is not split into inserted vs updated because the pass never
    // measures the split.
    inserted: stats.exported,
    updated: 0,
    unchanged: stats.unchanged,
    missing_in_source: 0,
    table_total_after: stats.totalInState,
    delta_vs_prev_total: tableDelta(stats.totalInState, prevTotal),
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    status: "completed",
    limitations: [],
    notes: {
      shards: stats.shards,
      totalBytes: stats.totalBytes,
      indexCid: stats.indexCid,
      manifestCid: stats.manifestCid,
      ms: stats.ms,
      limit: input.limit,
      since: input.since,
    },
    error: null,
  };
}

export async function ensureConsolidationState(conn: DuckDBConnection): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS consolidation_state (
    property_id VARCHAR NOT NULL, parcel_id VARCHAR, content_hash VARCHAR NOT NULL, cid VARCHAR NOT NULL, cid_v1 VARCHAR,
    sha256 VARCHAR, bytes BIGINT, file_path VARCHAR, address VARCHAR, zip VARCHAR, latitude DOUBLE, longitude DOUBLE,
    exported_at TIMESTAMP NOT NULL, run_id VARCHAR NOT NULL)`);
}

/** The SQL that renders one consolidated record per property as JSON (deterministic key order). */
function recordSql(opts: { permits: boolean; businesses: boolean; links: boolean; paBuildings: boolean; paSales: boolean; where: string; limit: number | null }): string {
  const permitsAgg = opts.permits
    ? `(SELECT coalesce(list(struct_pack(permit_no := pm.permit_no, permit_type := pm.permit_type, work_type := pm.work_type, description := pm.description, status := pm.status,
          issue_date := pm.issue_date::VARCHAR, applied_date := pm.applied_date::VARCHAR, job_cost := pm.job_cost, contractor_name := pm.contractor_name, contractor_license := pm.contractor_license,
          is_roof_permit := pm.is_roof_permit, source_url := pm.source_url) ORDER BY pm.issue_date DESC NULLS LAST, pm.permit_no), [])
        FROM permits pm WHERE pm.parcel_id = p.parcel_id)`
    : "[]::STRUCT(permit_no VARCHAR)[]";
  const businessesAgg = opts.businesses && opts.links
    ? `(SELECT coalesce(list(struct_pack(doc_number := b.doc_number, name := b.name, status := b.status, filing_type := b.filing_type, principal_address := concat_ws(', ', b.principal_addr1, b.principal_city, b.principal_state, b.principal_zip),
          file_date := b.file_date::VARCHAR, match_method := e.match_method, confidence := e.confidence) ORDER BY b.doc_number), [])
        FROM entity_links e JOIN businesses b ON b.doc_number = e.from_id WHERE e.link_type = 'business_parcel' AND e.to_id = p.parcel_id)`
    : "[]::STRUCT(doc_number VARCHAR)[]";
  const ownerId = opts.links
    ? "(SELECT any_value(e.to_id) FROM entity_links e WHERE e.link_type = 'parcel_owner' AND e.from_id = p.parcel_id)"
    : "NULL::VARCHAR";
  const paBuildings = opts.paBuildings
    ? `(SELECT coalesce(list(struct_pack(building_no := b.building_no, building_type := b.building_type, actual_year_built := b.actual_year_built, roof_structure := b.roof_structure,
          roofing_cover := b.roofing_cover, exterior_wall := b.exterior_wall, heated_area_sqft := b.heated_area_sqft, gross_area_sqft := b.gross_area_sqft, effective_area_sqft := b.effective_area_sqft,
          source_url := b.source_url, fetched_at := b.fetched_at::VARCHAR) ORDER BY b.building_no), [])
        FROM pa_detail_buildings b WHERE b.parcel_id = p.parcel_id)`
    : "[]::STRUCT(building_no INTEGER)[]";
  return `
    SELECT p.parcel_id AS property_id, p.parcel_id,
      f.address_street AS address, f.address_zip AS zip, p.latitude, p.longitude,
      to_json(struct_pack(
        schemaVersion := '${CONSOLIDATION_SCHEMA_VERSION}',
        county := '${COUNTY.key}',
        countyName := '${COUNTY.name}',
        stateCode := '${COUNTY.stateCode}',
        propertyId := p.parcel_id,
        parcelIdentifier := p.parcel_id,
        sourceSystem := '${COUNTY.sourceSystem}',
        address := struct_pack(street := f.address_street, city := f.address_city, zip := f.address_zip, latitude := p.latitude, longitude := p.longitude,
                               coordinatesSource := p.geometry_source, legalDescription := p.s_legal, neighborhoodCode := p.nbrhd_cd, censusBlock := p.census_bk,
                               fldZone := f.fld_zone, zoning := f.zoning, subdivision := f.subdivision),
        property := struct_pack(dorUseCode := p.dor_uc, paUseCode := p.pa_uc, propertyType := f.property_type, propertyUsageType := f.property_usage_type,
                                landSqft := p.lnd_sqfoot, lotSizeAcre := f.lot_size_acre, landUnitsCode := p.lnd_unts_cd, landUnits := p.no_lnd_unts,
                                buildings := p.no_buldng, residentialUnits := p.no_res_unts, township := p.twn, range := p.rng, section := p.sec, marketArea := p.mkt_ar),
        structure := struct_pack(actualYearBuilt := nullif(p.act_yr_blt, 0), effectiveYearBuilt := nullif(p.eff_yr_blt, 0), totalLivingArea := nullif(p.tot_lvg_area, 0),
                                 improvementQuality := p.imp_qual, constructionClass := p.const_class, specialFeatureValue := p.spec_feat_val,
                                 roofCoveringMaterial := f.roof_covering_material, paBuildings := ${paBuildings}),
        valuation := struct_pack(assessmentYear := p.asmnt_yr, justValue := p.jv, justValueChange := p.jv_chng, assessedValueSchool := p.av_sd, assessedValueNonSchool := p.av_nsd,
                                 taxableValueSchool := p.tv_sd, taxableValueNonSchool := p.tv_nsd, landValue := p.lnd_val, homesteadJustValue := p.jv_hmstd, homesteadAssessedValue := p.av_hmstd,
                                 newConstructionValue := p.nconst_val, deletionValue := p.del_val, exemptionCodes := p.exmpt_codes, homesteadFlag := f.homestead_flag),
        owners := struct_pack(ownerId := ${ownerId}, ownerName := p.own_name, ownersText := f.owners_text, ownerCount := f.owner_count, hasAdditionalOwners := f.has_additional_owners,
                              mailingAddress := struct_pack(line1 := p.own_addr1, line2 := p.own_addr2, city := p.own_city, state := p.own_state, zip := p.own_zipcd, stateOfDomicile := p.own_state_dom),
                              fiduciary := struct_pack(name := p.fidu_name, line1 := p.fidu_addr1, line2 := p.fidu_addr2, city := p.fidu_city, state := p.fidu_state, zip := p.fidu_zipcd, code := p.fidu_cd),
                              ownerOccupied := f.owner_occupied, ownerRegionClass := f.owner_region_class,
                              previousHomesteadOwner := p.prev_hmstd_own, assessmentTransferFlag := p.ass_trnsfr_fg),
        sales := (SELECT coalesce(list(struct_pack(saleDate := s.sale_date::VARCHAR, saleYear := s.sale_year, saleMonth := s.sale_month, price := s.sale_price, orBook := s.or_book, orPage := s.or_page,
                        clerkNo := s.clerk_no, qualificationCode := s.qual_cd, vacantImprovedCode := s.vi_cd, saleChangeCode := s.sale_change_cd, multiParcel := s.multi_parcel,
                        source := s.sale_source, sourceSystem := s.source_system, sourceUrl := s.source_url, sourceArtifact := s.source_artifact) ORDER BY s.sale_date DESC, s.sale_price DESC), [])
                  FROM sales_history s WHERE s.parcel_id = p.parcel_id),
        permits := ${permitsAgg},
        businesses := ${businessesAgg},
        features := struct_pack(
          roofYearEst := f.roof_year_est, roofAgeBasis := f.roof_age_basis, roofPermitCount := f.roof_permit_count, lastRoofPermitYear := f.last_roof_permit_year,
          waterViewFlag := f.water_view_flag, waterViewMajorFlag := f.water_view_major_flag, waterDistM := f.water_dist_m, waterBodyName := f.water_body_name, waterBodyType := f.water_body_type, waterBasis := f.water_basis,
          lastSaleDateAny := f.last_sale_date_any, tenureBasis := f.tenure_basis, tenureSource := f.tenure_source,
          tenureQuality := f.tenure_quality,
          tenureDateCheck := f.tenure_date_check,
          hasSaleOnRecord := f.has_sale_on_record, cojLastSaleDate := f.coj_last_sale_date,
          ownerRegionClass := f.owner_region_class,
          nearestTransitStopM := f.nearest_transit_stop_m, nearestTransitStopName := f.nearest_transit_stop_name, nearestTransitRouteTypes := f.nearest_transit_route_types, nearTransit800m := f.near_transit_800m,
          nearestStarbucksM := f.nearest_starbucks_m, nearestStarbucksName := f.nearest_starbucks_name, nearStarbucks800m := f.near_starbucks_800m,
          hasPermits := f.has_permits, permitCount := f.permit_count, hasSunbizTenant := f.has_sunbiz_tenant, sunbizBusinessCount := f.sunbiz_business_count),
        provenance := struct_pack(source_system := p.source_system, source_systems := f.source_systems, source_url := p.source_url, source_artifact := p.source_artifact, source_sha256 := p.source_sha256,
                                  fetched_at := p.fetched_at::VARCHAR, run_id := p.run_id,
                                  geometry := struct_pack(source_system := g.source_system, source_url := g.source_url, source_artifact := g.source_artifact, source_sha256 := g.source_sha256, fetched_at := g.fetched_at::VARCHAR, run_id := g.run_id))
      ))::VARCHAR AS record
    FROM parcels p
    JOIN derived.properties_features f ON f.property_id = p.parcel_id
    LEFT JOIN parcel_geometry g ON g.parcel_id = p.parcel_id
    ${opts.where}
    ORDER BY p.parcel_id
    ${opts.limit !== null ? `LIMIT ${opts.limit}` : ""}`;
}

function readLexicon(lexiconDir: string | null, parcelId: string): Record<string, unknown> | null {
  if (lexiconDir === null) return null;
  const dir = join(lexiconDir, parcelId, "data");
  if (!existsSync(dir)) return null;
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      out[f.replace(/\.json$/, "")] = null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function exportConsolidation(conn: DuckDBConnection, opts: ConsolidationOptions): Promise<ConsolidationStats> {
  const t0 = Date.now();
  const log = opts.logger.child({ stage: "consolidation" });
  await ensureConsolidationState(conn);
  const propsDir = join(opts.outDir, "properties");
  mkdirSync(propsDir, { recursive: true });
  if (!(await tableExists(conn, "derived", "properties_features"))) throw new Error("derived.properties_features missing; run the pipeline first");

  const flags = {
    permits: (await count(conn, "permits")) > 0,
    businesses: (await count(conn, "businesses")) > 0,
    links: (await count(conn, "entity_links")) > 0,
    paBuildings: (await tableExists(conn, "main", "pa_detail_buildings")) && (await count(conn, "pa_detail_buildings")) > 0,
    paSales: (await tableExists(conn, "main", "pa_detail_sales")) && (await count(conn, "pa_detail_sales")) > 0,
  };
  let where = "";
  if (opts.since !== "all" && opts.since !== "changed") {
    // a run id: only properties whose source rows were loaded by that run or later (ULIDs sort lexically)
    where = `WHERE p.run_id >= ${q(opts.since)} OR EXISTS (SELECT 1 FROM sales_history s WHERE s.parcel_id = p.parcel_id AND s.run_id >= ${q(opts.since)})`;
  }
  // 1. render candidate records and their content hash in DuckDB
  await conn.run(`CREATE OR REPLACE TABLE staging.consolidation_candidates AS
    SELECT property_id, parcel_id, address, zip, latitude, longitude, record, md5(record) AS content_hash FROM (${recordSql({ ...flags, where, limit: opts.limit })})`);
  const candidates = await count(conn, "staging.consolidation_candidates");
  // 2. diff against state
  const changed = await all<{ property_id: string; parcel_id: string; address: string | null; zip: string | null; latitude: number | null; longitude: number | null; record: string; content_hash: string }>(
    conn,
    `SELECT c.property_id, c.parcel_id, c.address, c.zip, c.latitude, c.longitude, c.record, c.content_hash
     FROM staging.consolidation_candidates c LEFT JOIN consolidation_state s ON s.property_id = c.property_id
     WHERE s.property_id IS NULL OR s.content_hash <> c.content_hash OR ${opts.since === "all" ? "true" : "false"}
     ORDER BY c.property_id`,
  );
  const unchanged = candidates - changed.length;
  log.info("consolidation_plan", { candidates, changed: changed.length, unchanged, flags });

  // 3. write changed records, compute CIDs, upsert state (batched)
  const exportedAt = new Date().toISOString();
  let totalBytesChanged = 0;
  const batch: string[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await conn.run(`INSERT INTO consolidation_state VALUES ${batch.join(",")}`);
    batch.length = 0;
  };
  await conn.run("BEGIN TRANSACTION");
  try {
    if (changed.length > 0) {
      await conn.run(`DELETE FROM consolidation_state WHERE property_id IN (SELECT property_id FROM staging.consolidation_candidates c LEFT JOIN consolidation_state s USING (property_id) WHERE s.property_id IS NULL OR s.content_hash <> c.content_hash OR ${opts.since === "all" ? "true" : "false"})`);
    }
    let i = 0;
    for (const row of changed) {
      const parsed = JSON.parse(row.record) as Record<string, unknown>;
      const lexicon = readLexicon(opts.lexiconDir, row.parcel_id);
      if (lexicon !== null) parsed.lexicon = lexicon;
      const json = `${JSON.stringify(parsed, null, 2)}\n`;
      const buf = Buffer.from(json, "utf8");
      const cid = await computeCid(buf);
      const fileName = `${row.property_id}.json`;
      writeFileSync(join(propsDir, fileName), buf);
      totalBytesChanged += buf.length;
      const n = (v: number | null) => (v === null ? "NULL" : String(v));
      batch.push(
        `(${q(row.property_id)}, ${q(row.parcel_id)}, ${q(row.content_hash)}, ${q(cid.cid)}, ${q(cid.cidV1)}, ${q(cid.sha256)}, ${buf.length}, ${q(`properties/${fileName}`)}, ${q(row.address)}, ${q(row.zip)}, ${n(row.latitude)}, ${n(row.longitude)}, ${q(exportedAt)}::TIMESTAMP, ${q(opts.runId)})`,
      );
      i += 1;
      if (batch.length >= 500) await flush();
      if (i % 20000 === 0) log.info("consolidation_progress", { written: i, of: changed.length, ms: Date.now() - t0 });
    }
    await flush();
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }

  // 4. shards, index, manifest from the full state (property_id order)
  const shardsDir = join(opts.outDir, "shards");
  if (existsSync(shardsDir)) rmSync(shardsDir, { recursive: true, force: true });
  mkdirSync(shardsDir, { recursive: true });
  const entries = await all<{ property_id: string; parcel_id: string; cid: string; bytes: string | number; sha256: string; file_path: string; address: string | null; zip: string | null; latitude: number | null; longitude: number | null }>(
    conn,
    "SELECT property_id, parcel_id, cid, bytes, sha256, file_path, address, zip, latitude, longitude FROM consolidation_state ORDER BY parcel_id",
  );
  const totalBytes = entries.reduce((a, e) => a + Number(e.bytes), 0);
  const shards: { shardIndex: number; fromParcel: string; toParcel: string; count: number; shardCid: string }[] = [];
  for (let s = 0; s * opts.shardSize < entries.length; s += 1) {
    const chunk = entries.slice(s * opts.shardSize, (s + 1) * opts.shardSize);
    const first = chunk[0] as (typeof entries)[number];
    const last = chunk[chunk.length - 1] as (typeof entries)[number];
    const shardFile = {
      schemaVersion: "1",
      shardIndex: s,
      fromParcel: first.parcel_id,
      toParcel: last.parcel_id,
      count: chunk.length,
      entries: chunk.map((e) => ({
        propertyId: e.property_id,
        parcelIdentifier: e.parcel_id,
        cid: e.cid,
        fileSizeBytes: Number(e.bytes),
        address: e.address,
        zip: e.zip,
        lat: e.latitude,
        lon: e.longitude,
      })),
    };
    const buf = Buffer.from(`${JSON.stringify(shardFile, null, 2)}\n`, "utf8");
    writeFileSync(join(shardsDir, `shard-${String(s).padStart(4, "0")}.json`), buf);
    const shardCid = await computeCid(buf);
    shards.push({ shardIndex: s, fromParcel: first.parcel_id, toParcel: last.parcel_id, count: chunk.length, shardCid: shardCid.cid });
  }
  const completedAt = new Date().toISOString();
  const index = {
    schemaVersion: "1",
    county: COUNTY.key,
    exportedAt,
    completedAt,
    generatedAt: completedAt,
    runId: opts.runId,
    propertyCount: entries.length,
    shardSize: opts.shardSize,
    totalBytes,
    shards,
  };
  const indexBuf = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  writeFileSync(join(opts.outDir, "index.json"), indexBuf);
  const indexCid = await computeCid(indexBuf);
  const manifest = {
    schemaVersion: "1",
    county: COUNTY.key,
    exportedAt,
    completedAt,
    propertyCount: entries.length,
    totalBytes,
    entries: entries.map((e) => ({
      propertyId: e.property_id,
      parcelIdentifier: e.parcel_id,
      filePath: e.file_path,
      fileSizeBytes: Number(e.bytes),
      sha256: e.sha256,
      cid: e.cid,
    })),
  };
  const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(opts.outDir, "manifest.json"), manifestBuf);
  const manifestCid = await computeCid(manifestBuf);
  const summary = {
    county: COUNTY.key,
    runId: opts.runId,
    exportedAt,
    completedAt,
    candidates,
    exported: changed.length,
    unchanged,
    propertyCount: entries.length,
    totalBytes,
    shardSize: opts.shardSize,
    shards: shards.length,
    indexCid: indexCid.cid,
    indexCidV1: indexCid.cidV1,
    manifestCid: manifestCid.cid,
    bytesWrittenThisRun: totalBytesChanged,
    ms: Date.now() - t0,
  };
  writeFileSync(join(opts.outDir, "export-summary.json"), JSON.stringify(summary, null, 2));
  log.info("consolidation_done", summary);
  return { candidates, exported: changed.length, unchanged, totalInState: entries.length, totalBytes, shards: shards.length, indexCid: indexCid.cid, manifestCid: manifestCid.cid, ms: Date.now() - t0 };
}

/** Quick stats for run_log / status. */
/**
 * The `artifacts` record a consolidation pass writes to its run log.
 *
 * It publishes two things and must record both as published objects. The open-data index is
 * CID-addressed under its own publish step and carries no object name in this publish plan, so it
 * stays as it was. The query table does have one: the pass rebuilds `query-table.parquet` with
 * property_cid filled in and republishes it, which is the copy the artifacts index ends up
 * serving. Recording it under the same object name and CID shape as the ingestion run is what lets
 * a reader follow the run to the bytes on the gateway.
 */
export async function consolidationArtifacts(opts: {
  outDir: string;
  stats: ConsolidationStats;
  exported: ExportResult;
  validation: ValidationReport;
}): Promise<{ openData: Record<string, unknown>; queryTable: QueryTableArtifact & { propertyCidFilled: number } }> {
  const { outDir, stats, exported, validation } = opts;
  return {
    openData: {
      outDir,
      indexCid: stats.indexCid,
      manifestCid: stats.manifestCid,
      propertyCount: stats.totalInState,
      totalBytes: stats.totalBytes,
      shards: stats.shards,
    },
    queryTable: {
      ...(await describeQueryTableArtifact(exported, validation)),
      // The reason this pass exists, kept alongside the published-object fields.
      propertyCidFilled: validation.propertyCidFilled,
    },
  };
}

export async function consolidationStateStats(conn: DuckDBConnection): Promise<{ properties: number; bytes: number; lastExportedAt: string | null }> {
  if (!(await tableExists(conn, "main", "consolidation_state"))) return { properties: 0, bytes: 0, lastExportedAt: null };
  const r = await one<{ n: string | number; b: string | number | null; last: string | null }>(
    conn,
    "SELECT count(*) AS n, sum(bytes) AS b, strftime(max(exported_at), '%Y-%m-%dT%H:%M:%SZ') AS last FROM consolidation_state",
  );
  return { properties: Number(r.n), bytes: Number(r.b ?? 0), lastExportedAt: r.last };
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function stateCount(conn: DuckDBConnection): Promise<number> {
  return Number(await scalar(conn, "SELECT count(*) FROM consolidation_state"));
}
