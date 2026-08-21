import { describe, expect, it } from "vitest";
import { ensureSchema, openDb } from "../src/db.js";
import { buildCatalog, PublishedCountyCatalogSchema } from "../src/publish/catalog.js";
import { buildCoverageSnapshot, OracleDatasetCoverageSnapshotSchema } from "../src/publish/coverage.js";
import { insertRunSource, type InsertableRunSource } from "../src/runLog.js";
import { ALL_TRACKS } from "../src/sources.js";

/** A completed run source, as the pipeline writes one. Tests override the fields they care about. */
const sourceRow: InsertableRunSource = {
  track: "appraisal",
  source_system: "duval_appraiser",
  target_table: "parcels",
  source_url: "https://example.invalid/nal.zip",
  artifact_path: "appraisal/nal.zip",
  artifact_sha256: "s",
  artifact_etag: "e",
  artifact_last_modified: "lm",
  artifact_bytes: 10,
  download_status: "downloaded",
  rows_staged: 2,
  inserted: 1,
  updated: 0,
  unchanged: 1,
  missing_in_source: 0,
  table_total_after: 2,
  delta_vs_prev_total: null,
  started_at: "2026-08-21 10:00:00",
  finished_at: "2026-08-21 10:01:00",
  status: "completed",
  limitations: [],
  notes: {},
  error: null,
};

describe("dataset-coverage.json", () => {
  it("matches the elephant-mcp snapshot schema with one row per registered source, empty DB", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    const snap = await buildCoverageSnapshot(db.conn, { exportedAt: "2026-08-21T00:00:00.000Z" });
    expect(OracleDatasetCoverageSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.county).toBe("duval");
    expect(snap.datasets.length).toBe(ALL_TRACKS.length);
    const appraisal = snap.datasets.find((d) => d.source === "appraisal");
    expect(appraisal).toMatchObject({ county: "duval", ingested_count: 0, expected_count: null, first_loaded_at: null, last_loaded_at: null, cid: null, ipns_label: null });
    // the non-implemented sources are still reported (coverage honesty)
    expect(snap.datasets.find((d) => d.source === "permits")).toMatchObject({ ingested_count: 0, implemented: true, requires_us_egress: true, last_skip_reason: null });
    await db.close();
  });

  it("reports counts, expected rows from the last completed run and load window from provenance", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`
      INSERT INTO parcels (parcel_id, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ('A', 'h', 'duval_appraiser', 'u', 'a', 's', TIMESTAMP '2026-08-20 10:00:00', 'r1'),
             ('B', 'h', 'duval_appraiser', 'u', 'a', 's', TIMESTAMP '2026-08-21 10:00:00', 'r2')`);
    await db.conn.run(`
      INSERT INTO run_log_sources VALUES
        ('r2', 'appraisal', 'duval_appraiser', 'parcels', 'u', 'a', 's', 'e', 'lm', 10, 'downloaded', 2, 1, 0, 1, 0, 2, 1,
         TIMESTAMP '2026-08-21 10:00:00', TIMESTAMP '2026-08-21 10:01:00', 'completed', '[]', NULL, FALSE)`);
    const snap = await buildCoverageSnapshot(db.conn, {
      exportedAt: "2026-08-21T00:00:00.000Z",
      artifactRefs: { appraisal: { cid: "QmTest", ipnsLabel: "duval-oracle-artifacts" } },
    });
    const appraisal = snap.datasets.find((d) => d.source === "appraisal");
    expect(appraisal).toMatchObject({
      ingested_count: 2,
      expected_count: 2,
      first_loaded_at: "2026-08-20T10:00:00Z",
      last_loaded_at: "2026-08-21T10:00:00Z",
      cid: "QmTest",
      ipns_label: "duval-oracle-artifacts",
      last_run_id: "r2",
    });
    await db.conn.run(`INSERT INTO entity_links VALUES ('l1', 'parcel_owner', 'parcel', 'A', 'owner', 'o1', 'owner_name_mailing_hash', 1.0, NULL, 'r2', TIMESTAMP '2026-08-21 11:00:00')`);
    const snap2 = await buildCoverageSnapshot(db.conn, { exportedAt: "2026-08-21T00:00:00.000Z" });
    expect(snap2.datasets.find((d) => d.source === "entity_links")).toMatchObject({ ingested_count: 1, first_loaded_at: "2026-08-21T11:00:00Z", owners: 0 });
    const geometry = snap.datasets.find((d) => d.source === "geometry");
    expect(geometry).toMatchObject({ ingested_count: 0, expected_count: null, parcels_total: 2, parcels_with_coordinates: 0 });
    expect(OracleDatasetCoverageSnapshotSchema.safeParse(snap).success).toBe(true);
    await db.close();
  });

  /**
   * The counterpart to previousTotal's rule. `rows_staged` is what the track observed in the
   * SOURCE, so it is the same number whichever cache lineage staged it, and a rolled cache that
   * only has rehydrated rows must still report `expected_count` rather than falling back to null.
   * The `last_skip_reason` lookup reads the same table for the same reason.
   */
  it("answers expected_count and the last skip reason from a rehydrated row", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`
      INSERT INTO parcels (parcel_id, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ('A', 'h', 'duval_appraiser', 'u', 'a', 's', TIMESTAMP '2026-08-20 10:00:00', 'r1')`);
    await insertRunSource(db, "r1", { ...sourceRow, track: "appraisal", source_system: "duval_appraiser", target_table: "parcels" }, { rehydrated: true });
    await insertRunSource(
      db,
      "r1",
      {
        ...sourceRow,
        track: "permits",
        source_system: "jaxepics",
        target_table: "permits",
        status: "skipped",
        rows_staged: 0,
        table_total_after: null,
        limitations: ["skipped: non-US egress (HTTP 403)"],
      },
      { rehydrated: true },
    );

    const snap = await buildCoverageSnapshot(db.conn, { exportedAt: "2026-08-21T00:00:00.000Z" });
    expect(snap.datasets.find((d) => d.source === "appraisal")).toMatchObject({
      ingested_count: 1,
      expected_count: 2,
      last_run_id: "r1",
      last_run_status: "completed",
    });
    expect(snap.datasets.find((d) => d.source === "permits")).toMatchObject({
      last_skip_reason: "skipped: non-US egress (HTTP 403)",
    });
    expect(OracleDatasetCoverageSnapshotSchema.safeParse(snap).success).toBe(true);
    await db.close();
  });

  it("scopes a target table written by more than one track to the rows that track owns", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    // sales_history is fed by the sales track (SDF + the NAL roll fold) and by pa_detail
    // (PA_DETAIL). Only the first three rows below belong to the sales track.
    const sale = (key: string, parcel: string, saleSource: string, fetchedAt: string) =>
      `('${key}', '${parcel}', DATE '2026-01-01', 2026, 1, 100.0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '${saleSource}',
        'h', 'fdor_sdf', 'u', 'a', 's', TIMESTAMP '${fetchedAt}', 'r1')`;
    await db.conn.run(`INSERT INTO sales_history VALUES
      ${sale("k1", "A", "SDF", "2026-08-20 10:00:00")},
      ${sale("k2", "B", "SDF", "2026-08-20 11:00:00")},
      ${sale("k3", "C", "NAL_SALE1", "2026-08-20 12:00:00")},
      ${sale("k4", "D", "PA_DETAIL", "2026-08-25 09:00:00")},
      ${sale("k5", "E", "PA_DETAIL", "2026-08-26 09:00:00")}`);
    // the sales run staged only its own three rows, which is the denominator the row must use
    await db.conn.run(`
      INSERT INTO run_log_sources VALUES
        ('r1', 'sales', 'fdor_sdf', 'sales_history', 'u', 'a', 's', 'e', 'lm', 10, 'downloaded', 3, 3, 0, 0, 0, 3, 3,
         TIMESTAMP '2026-08-20 10:00:00', TIMESTAMP '2026-08-20 10:05:00', 'completed', '[]', NULL, FALSE)`);

    const snap = await buildCoverageSnapshot(db.conn, { exportedAt: "2026-08-27T00:00:00.000Z" });
    const sales = snap.datasets.find((d) => d.source === "sales");
    expect(sales).toMatchObject({
      ingested_count: 3,
      expected_count: 3,
      table_rows_total: 5,
      rows_from_other_tracks: 2,
      additional_rows_by_source: { PA_DETAIL: 2 },
      // the load window describes the SDF/NAL rows, not the later pa_detail merges
      first_loaded_at: "2026-08-20T10:00:00Z",
      last_loaded_at: "2026-08-20T12:00:00Z",
    });
    // the track that contributed the extra rows says so rather than leaving them uncounted
    expect(snap.datasets.find((d) => d.source === "pa_detail")).toMatchObject({ sales_history_rows_contributed: 2 });
    // a single-writer table is untouched: whole-table count, no shared-table fields
    const appraisal = snap.datasets.find((d) => d.source === "appraisal");
    expect(appraisal).not.toHaveProperty("table_rows_total");
    expect(appraisal).not.toHaveProperty("rows_from_other_tracks");
    expect(OracleDatasetCoverageSnapshotSchema.safeParse(snap).success).toBe(true);
    await db.close();
  });
});

describe("published-counties catalog", () => {
  it("matches the elephant-mcp catalog schema", () => {
    const cat = buildCatalog({
      generatedAt: "2026-08-21T00:00:00.000Z",
      queryTableUrl: "https://ipfs.filebase.io/ipns/k51abc",
      datasetCoverageUrl: "https://ipfs.filebase.io/ipns/k51def",
    });
    expect(PublishedCountyCatalogSchema.safeParse(cat).success).toBe(true);
    expect(cat.counties[0]).toMatchObject({ countyKey: "duval", countyName: "Duval", stateCode: "FL", countyFips: "12031", status: "published", permitQueryTableUrl: null });
  });
  it("rejects a bad county key or non-URL", () => {
    expect(() => buildCatalog({ generatedAt: "2026-08-21T00:00:00.000Z", queryTableUrl: "not a url", datasetCoverageUrl: "https://x" })).toThrow();
  });
});
