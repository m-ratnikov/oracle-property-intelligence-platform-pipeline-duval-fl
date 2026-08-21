import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { consolidationArtifacts, type ConsolidationStats } from "../src/consolidation/export.js";
import { ensureSchema, openDb, type Db } from "../src/db.js";
import { buildFeatures } from "../src/features/build.js";
import {
  describeQueryTableArtifact,
  exportQueryTable,
  QUERY_TABLE_OBJECT,
  validateQueryTable,
  type ExportResult,
  type ValidationReport,
} from "../src/features/export.js";
import { computeFileCid, sameCid } from "../src/publish/cid.js";
import { planPublish } from "../src/publish/index.js";

/**
 * What these pin.
 *
 * A run record is the only thing that says which bytes a run produced, and the published artifacts
 * index is the only thing that says where those bytes went. The UI joins the two on the published
 * object name, so a pass that writes an object without recording its name and CID publishes
 * evidence that can never be followed.
 *
 * The consolidation pass did exactly that. It rebuilds `query-table.parquet` with property_cid
 * filled in, republishes it, and recorded `{ rows, propertyCidFilled }`: no path, no CID. The copy
 * it published, which is the one the gateway then serves, was recorded nowhere, and the ingestion
 * run's record went stale seconds after every run with nothing in history to explain why.
 */

let db: Db;
let dir: string;
let paths: Paths;

const PROV = `'h', 'duval_appraiser', 'https://src/nal.zip', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "duval-run-artifacts-"));
  const publishDir = join(dir, "artifacts", "publish", "duval");
  mkdirSync(publishDir, { recursive: true });
  paths = {
    dataDir: dir,
    dbPath: join(dir, "duval.duckdb"),
    artifactsDir: join(dir, "artifacts"),
    publishDir,
    runsDir: join(dir, "runs"),
  };
  db = await openDb(":memory:");
  await ensureSchema(db.conn);
  await db.conn.run(`
    INSERT INTO parcels (parcel_id, dor_uc, jv, lnd_val, av_nsd, lnd_sqfoot, act_yr_blt, eff_yr_blt, tot_lvg_area, own_name, own_addr1, own_city, own_state, own_zipcd, phy_addr1, phy_city, phy_zipcd, latitude, longitude,
                         row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('A', '01', 250000, 50000, 200000, 8712, 1998, 2005, 1800, 'DOE JOHN', '1 MAIN ST', 'JACKSONVILLE', 'FL', '32207', '1 MAIN ST', 'JACKSONVILLE', '32207', 30.3, -81.6, ${PROV}),
           ('B', '04', 150000, 20000, 140000, 0, 2015, 2015, 900, 'ACME LLC', '5 PARK AVE', 'NEW YORK', 'NY', '10001', '2 OCEAN DR', 'JACKSONVILLE BEACH', '32250', 30.29, -81.39, ${PROV})`);
  await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t" });
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function exportAndValidate(): Promise<{ exported: ExportResult; validation: ValidationReport }> {
  const target = join(paths.publishDir, QUERY_TABLE_OBJECT);
  const exported = await exportQueryTable(db.conn, target);
  const validation = await validateQueryTable(db.conn, target);
  return { exported, validation };
}

const STATS: ConsolidationStats = {
  candidates: 2,
  exported: 2,
  unchanged: 0,
  totalInState: 2,
  totalBytes: 4096,
  shards: 1,
  indexCid: "QmIndexCidFixture",
  manifestCid: "QmManifestCidFixture",
  ms: 12,
};

describe("a run record names the object it published", () => {
  it("describes the query table under the same name the publish plan gives it", async () => {
    const { exported, validation } = await exportAndValidate();
    const artifact = await describeQueryTableArtifact(exported, validation);

    expect(artifact.path).toBe(QUERY_TABLE_OBJECT);
    expect(artifact.rows).toBe(2);
    expect(artifact.bytes).toBeGreaterThan(0);
    expect(artifact.cid).toBe((await computeFileCid(exported.path)).cid);

    // The join the UI performs: run record path -> published object name.
    const planned = await planPublish(paths);
    const match = planned.find((object) => object.name === artifact.path);
    expect(match, "the publish plan has no object under the recorded name").toBeDefined();
    expect(sameCid(match?.cid, artifact.cid)).toBe(true);
    expect(match?.cidV1).toBe(artifact.cidV1);
  });
});

describe("the consolidation pass records the parquet it republished", () => {
  it("gives its query table a path and a CID, not just a row count", async () => {
    const { exported, validation } = await exportAndValidate();
    const artifacts = await consolidationArtifacts({
      outDir: join(paths.publishDir, "open-data"),
      stats: STATS,
      exported,
      validation,
    });

    expect(artifacts.queryTable.path).toBe(QUERY_TABLE_OBJECT);
    expect(artifacts.queryTable.cid).toBe((await computeFileCid(exported.path)).cid);
    expect(artifacts.queryTable.sha256).toHaveLength(64);
    expect(artifacts.queryTable.bytes).toBe(exported.bytes);

    // And it joins the publish plan, which is what makes the card resolvable.
    const planned = await planPublish(paths);
    expect(planned.map((object) => object.name)).toContain(artifacts.queryTable.path);
  });

  it("keeps the evidence the pass exists for", async () => {
    const { exported, validation } = await exportAndValidate();
    const artifacts = await consolidationArtifacts({
      outDir: "/tmp/open-data",
      stats: STATS,
      exported,
      validation,
    });

    expect(artifacts.queryTable.propertyCidFilled).toBe(validation.propertyCidFilled);
    expect(artifacts.openData).toMatchObject({
      outDir: "/tmp/open-data",
      indexCid: "QmIndexCidFixture",
      manifestCid: "QmManifestCidFixture",
      propertyCount: 2,
      shards: 1,
    });
  });

  it("describes the same bytes exactly as an ingestion run would", async () => {
    const { exported, validation } = await exportAndValidate();
    const fromIngestion = await describeQueryTableArtifact(exported, validation);
    const { propertyCidFilled, ...fromConsolidation } = (
      await consolidationArtifacts({ outDir: "o", stats: STATS, exported, validation })
    ).queryTable;

    expect(propertyCidFilled).toBe(validation.propertyCidFilled);
    // One helper for both passes: they cannot drift on the object name or the CID computation.
    expect(fromConsolidation).toEqual(fromIngestion);
  });
});
