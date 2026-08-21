import type { DuckDBConnection } from "@duckdb/node-api";
import { z } from "zod";
import { COUNTY } from "../config.js";
import { all, count, one, q } from "../db.js";
import { SOURCES, type TrackName } from "../sources.js";

// ---------------------------------------------------------------------------
// Schemas copied from elephant-mcp src/types/oracleOpenData.ts (the consumer contract).
// ---------------------------------------------------------------------------
export const OracleDatasetCoverageRowSchema = z
  .object({
    county: z.string(),
    source: z.string(),
    ingested_count: z.number(),
    expected_count: z.number().nullable().optional(),
    first_loaded_at: z.string().nullable().optional(),
    last_loaded_at: z.string().nullable().optional(),
    cid: z.string().nullable().optional(),
    ipns_label: z.string().nullable().optional(),
  })
  .passthrough();
export type OracleDatasetCoverageRow = z.infer<typeof OracleDatasetCoverageRowSchema>;

export const OracleDatasetCoverageSnapshotSchema = z
  .object({
    county: z.string(),
    exportedAt: z.string().optional(),
    datasets: z.array(OracleDatasetCoverageRowSchema),
  })
  .passthrough();
export type OracleDatasetCoverageSnapshot = z.infer<typeof OracleDatasetCoverageSnapshotSchema>;

async function extraNotes(conn: DuckDBConnection, track: TrackName): Promise<Record<string, unknown>> {
  const n = async (sql: string) => Number((await one<{ n: string | number }>(conn, sql)).n);
  switch (track) {
    case "contractors":
      return (await count(conn, "contractors")) > 0
        ? { roofing_contractors_count_duval: await n("SELECT count(*) AS n FROM contractors WHERE is_roofing") }
        : { roofing_contractors_count_duval: null };
    case "transit":
      return (await count(conn, "transit_stops")) > 0
        ? { routes: await count(conn, "transit_routes"), parcels_near_transit_800m: await n("SELECT count(*) AS n FROM derived.properties_features WHERE near_transit_800m") }
        : {};
    case "places":
      return (await count(conn, "places")) > 0
        ? { starbucks: await n("SELECT count(*) AS n FROM places WHERE is_starbucks"), parcels_near_starbucks_800m: await n("SELECT count(*) AS n FROM derived.properties_features WHERE near_starbucks_800m") }
        : {};
    case "water":
      return (await count(conn, "water_bodies")) > 0
        ? { parcels_water_view_flag: await n("SELECT count(*) AS n FROM derived.properties_features WHERE water_view_flag") }
        : {};
    case "businesses":
      return (await count(conn, "businesses")) > 0
        ? { events: await count(conn, "business_events"), files_processed: await n("SELECT count(*) AS n FROM source_files WHERE track = 'businesses'"),
            parcels_linked_to_business: await n("SELECT count(DISTINCT to_id) AS n FROM entity_links WHERE link_type = 'business_parcel'") }
        : {};
    case "links":
      return { owners: await count(conn, "owners") };
    case "permits":
      return (await count(conn, "permits")) > 0
        ? { roof_permits: await n("SELECT count(*) AS n FROM permits WHERE is_roof_permit") }
        : { constrained: true, reason: "JaxEPICS API behind Akamai WAF; search/reports require login; no open dataset; PRR is the documented path" };
    case "coj_parcels":
      return (await count(conn, "coj_parcels")) > 0 ? { matched_to_nal: await n("SELECT count(*) AS n FROM coj_parcels WHERE parcel_id IS NOT NULL") } : {};
    default:
      return {};
  }
}

export interface CoverageArtifactRef {
  cid: string | null;
  ipnsLabel: string | null;
}

/**
 * One coverage row per registered source. `ingested_count` is the live table count;
 * `expected_count` is what the latest completed run saw in the source (rows staged), or the parcel
 * count for per-parcel enrichments; unimplemented sources report 0 / null so MCP consumers see the gap.
 */
export async function buildCoverageSnapshot(
  conn: DuckDBConnection,
  opts: { exportedAt: string; artifactRefs?: Partial<Record<TrackName, CoverageArtifactRef>> },
): Promise<OracleDatasetCoverageSnapshot> {
  const datasets: OracleDatasetCoverageRow[] = [];
  const parcelCount = await count(conn, "parcels");
  for (const source of Object.values(SOURCES)) {
    const ingested = await count(conn, source.targetTable);
    const latest = await all<{ rows_staged: string | number | null; run_id: string; status: string; finished_at: string | null }>(
      conn,
      `SELECT rows_staged, run_id, status, finished_at::VARCHAR AS finished_at FROM run_log_sources
       WHERE track = ${q(source.track)} AND status = 'completed' ORDER BY started_at DESC LIMIT 1`,
    );
    const last = latest[0];
    let expected: number | null = null;
    // delta feeds (Sunbiz daily files, COJ EDIT_DATE pulls) and derived links have no external total:
    // what is ingested is what the source offered, so expected == ingested (completion 100 %)
    const deltaFeed = source.track === "businesses" || source.track === "coj_addresses" || source.track === "links";
    if (source.knownExpectedCount !== undefined) expected = source.knownExpectedCount;
    else if (deltaFeed) expected = ingested > 0 ? ingested : null;
    else if (last?.rows_staged !== null && last?.rows_staged !== undefined) expected = Number(last.rows_staged);
    const skipRows = await all<{ limitations: string | null }>(
      conn,
      `SELECT limitations::VARCHAR AS limitations FROM run_log_sources WHERE track = ${q(source.track)} AND status = 'skipped' ORDER BY started_at DESC LIMIT 1`,
    );
    let lastSkip: string | null = null;
    if (skipRows[0]?.limitations) {
      try {
        const arr = JSON.parse(skipRows[0].limitations) as string[];
        lastSkip = arr.find((x) => x.startsWith("skipped")) ?? arr[arr.length - 1] ?? null;
      } catch {
        lastSkip = null;
      }
    }
    let parcelsWithCoordinates: number | null = null;
    if (source.track === "geometry" && parcelCount > 0) {
      parcelsWithCoordinates = Number(
        (await one<{ n: string | number }>(conn, "SELECT count(*) AS n FROM parcels WHERE latitude IS NOT NULL")).n,
      );
    }
    let first: string | null = null;
    let lastLoaded: string | null = null;
    if (ingested > 0) {
      // entity_links is derived (created_at); every source table carries fetched_at provenance
      const tsCol = source.targetTable === "entity_links" ? "created_at" : "fetched_at";
      const range = await one<{ first_loaded: string | null; last_loaded: string | null }>(
        conn,
        `SELECT strftime(min(${tsCol}), '%Y-%m-%dT%H:%M:%SZ') AS first_loaded,
                strftime(max(${tsCol}), '%Y-%m-%dT%H:%M:%SZ') AS last_loaded FROM ${source.targetTable}`,
      );
      first = range.first_loaded;
      lastLoaded = range.last_loaded;
    }
    const ref = opts.artifactRefs?.[source.track];
    datasets.push({
      county: COUNTY.key,
      source: source.coverageSource,
      ingested_count: ingested,
      expected_count: expected,
      first_loaded_at: first,
      last_loaded_at: lastLoaded,
      cid: ref?.cid ?? null,
      ipns_label: ref?.ipnsLabel ?? null,
      // extra keys are allowed by the consumer schema (passthrough)
      track: source.track,
      source_system: source.sourceSystem,
      source_url: source.url,
      table: source.targetTable,
      implemented: source.implemented,
      cadence: source.cadence,
      limitations: source.limitations,
      last_run_id: last?.run_id ?? null,
      last_run_status: last?.status ?? null,
      requires_us_egress: source.requiresUsEgress,
      last_skip_reason: lastSkip,
      ...(source.track === "geometry" ? { parcels_total: parcelCount, parcels_with_coordinates: parcelsWithCoordinates } : {}),
      ...(await extraNotes(conn, source.track)),
    });
  }
  const snapshot = { county: COUNTY.key, exportedAt: opts.exportedAt, datasets };
  return OracleDatasetCoverageSnapshotSchema.parse(snapshot);
}
