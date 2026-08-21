import { describe, expect, it } from "vitest";
import { ensureSchema, openDb } from "../src/db.js";
import { buildCatalog, PublishedCountyCatalogSchema } from "../src/publish/catalog.js";
import { buildCoverageSnapshot, OracleDatasetCoverageSnapshotSchema } from "../src/publish/coverage.js";
import { ALL_TRACKS } from "../src/sources.js";

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
    expect(snap.datasets.find((d) => d.source === "permits")).toMatchObject({ ingested_count: 0, implemented: false });
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
         TIMESTAMP '2026-08-21 10:00:00', TIMESTAMP '2026-08-21 10:01:00', 'completed', '[]', NULL)`);
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
    const geometry = snap.datasets.find((d) => d.source === "geometry");
    expect(geometry).toMatchObject({ ingested_count: 0, expected_count: null, parcels_total: 2, parcels_with_coordinates: 0 });
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
