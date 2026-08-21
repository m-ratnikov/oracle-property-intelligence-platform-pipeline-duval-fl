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
    if (last?.rows_staged !== null && last?.rows_staged !== undefined) expected = Number(last.rows_staged);
    let parcelsWithCoordinates: number | null = null;
    if (source.track === "geometry" && parcelCount > 0) {
      parcelsWithCoordinates = Number(
        (await one<{ n: string | number }>(conn, "SELECT count(*) AS n FROM parcels WHERE latitude IS NOT NULL")).n,
      );
    }
    let first: string | null = null;
    let lastLoaded: string | null = null;
    if (ingested > 0) {
      const range = await one<{ first_loaded: string | null; last_loaded: string | null }>(
        conn,
        `SELECT strftime(min(fetched_at), '%Y-%m-%dT%H:%M:%SZ') AS first_loaded,
                strftime(max(fetched_at), '%Y-%m-%dT%H:%M:%SZ') AS last_loaded FROM ${source.targetTable}`,
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
      ...(source.track === "geometry" ? { parcels_total: parcelCount, parcels_with_coordinates: parcelsWithCoordinates } : {}),
    });
  }
  const snapshot = { county: COUNTY.key, exportedAt: opts.exportedAt, datasets };
  return OracleDatasetCoverageSnapshotSchema.parse(snapshot);
}
