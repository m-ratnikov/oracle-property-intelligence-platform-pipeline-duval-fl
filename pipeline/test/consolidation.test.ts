import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { exportConsolidation } from "../src/consolidation/export.js";
import { all, duckPath, ensureSchema, openDb, q, type Db } from "../src/db.js";
import { buildFeatures } from "../src/features/build.js";
import { exportQueryTable, validateQueryTable } from "../src/features/export.js";
import { createLogger } from "../src/log.js";
import { computeCid } from "../src/publish/cid.js";
import { formatOpenDataPlan, planOpenData } from "../src/publish/openData.js";

// Copied from elephant-mcp src/types/oracleOpenData.ts (consumer contract for shards / index / manifest).
const ShardEntrySchema = z.object({ propertyId: z.string(), parcelIdentifier: z.string(), cid: z.string().nullable(), fileSizeBytes: z.number() });
const ShardFileSchema = z.object({ schemaVersion: z.literal("1"), shardIndex: z.number().int().nonnegative(), fromParcel: z.string(), toParcel: z.string(), count: z.number().int().positive(), entries: z.array(ShardEntrySchema) });
const ShardRefSchema = z.object({ shardIndex: z.number().int().nonnegative(), fromParcel: z.string(), toParcel: z.string(), count: z.number().int().nonnegative(), shardCid: z.string().nullable() });
const OracleIndexSchema = z.object({ schemaVersion: z.literal("1"), county: z.string(), exportedAt: z.string(), completedAt: z.string(), propertyCount: z.number().int().nonnegative(), shardSize: z.number().int().positive(), totalBytes: z.number().nonnegative(), shards: z.array(ShardRefSchema) });
const OracleManifestSchema = z.object({ schemaVersion: z.string().optional(), county: z.string(), exportedAt: z.string().optional(), completedAt: z.string().optional(), propertyCount: z.number(), totalBytes: z.number().optional(), entries: z.array(z.object({ propertyId: z.string(), parcelIdentifier: z.string(), filePath: z.string(), fileSizeBytes: z.number(), sha256: z.string(), cid: z.string() })) });

let db: Db;
let dir: string;
const logger = createLogger({}, "error", () => undefined);
const PROV = `'h', 'duval_appraiser', 'https://src/nal.zip', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "duval-consolidation-"));
  db = await openDb(":memory:");
  await ensureSchema(db.conn);
  await db.conn.run(`
    INSERT INTO parcels (parcel_id, dor_uc, jv, lnd_val, av_nsd, lnd_sqfoot, act_yr_blt, eff_yr_blt, tot_lvg_area, own_name, own_addr1, own_city, own_state, own_zipcd, phy_addr1, phy_city, phy_zipcd, latitude, longitude,
                         row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('A', '01', 250000, 50000, 200000, 8712, 1998, 2005, 1800, 'DOE JOHN', '1 MAIN ST', 'JACKSONVILLE', 'FL', '32207', '1 MAIN ST', 'JACKSONVILLE', '32207', 30.3, -81.6, ${PROV}),
           ('B', '04', 150000, 20000, 140000, 0, 2015, 2015, 900, 'ACME LLC', '5 PARK AVE', 'NEW YORK', 'NY', '10001', '2 OCEAN DR', 'JACKSONVILLE BEACH', '32250', 30.29, -81.39, ${PROV}),
           ('C', '00', 10000, 10000, 10000, 43560, 0, 0, 0, 'SMITH JANE', '9 PINE RD', 'ATLANTA', 'GA', '30301', '9 PINE RD', 'JACKSONVILLE', '32210', NULL, NULL, ${PROV})`);
  await db.conn.run(`INSERT INTO sales_history (sale_key, parcel_id, sale_date, sale_year, sale_month, sale_price, or_book, or_page, sale_source, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('k1', 'A', DATE '2012-05-01', 2012, 5, 180000, '15000', '100', 'SDF', ${PROV})`);
  await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t" });
});
afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("open-data consolidation export", () => {
  it("writes one record per property with lexicon-style groups + provenance, shards, index, manifest; CID == file CID", async () => {
    const stats = await exportConsolidation(db.conn, { outDir: dir, shardSize: 2, since: "all", limit: null, runId: "r1", logger, lexiconDir: null });
    expect(stats).toMatchObject({ candidates: 3, exported: 3, unchanged: 0, totalInState: 3, shards: 2 });
    const rec = JSON.parse(readFileSync(join(dir, "properties", "A.json"), "utf8")) as Record<string, unknown>;
    expect(rec).toMatchObject({ schemaVersion: "1", county: "duval", propertyId: "A", parcelIdentifier: "A", sourceSystem: "duval_appraiser" });
    expect(rec.address).toMatchObject({ street: "1 MAIN ST", city: "JACKSONVILLE", zip: "32207", latitude: 30.3 });
    expect(rec.owners).toMatchObject({ ownerName: "DOE JOHN", ownerRegionClass: "LOCAL", ownerOccupied: true });
    expect(rec.valuation).toMatchObject({ justValue: 250000, landValue: 50000 });
    expect(rec.structure).toMatchObject({ actualYearBuilt: 1998, effectiveYearBuilt: 2005, totalLivingArea: 1800 });
    expect((rec.sales as unknown[]).length).toBe(1);
    expect((rec.sales as Record<string, unknown>[])[0]).toMatchObject({ saleDate: "2012-05-01", price: 180000, orBook: "15000", source: "SDF", sourceSystem: "duval_appraiser" });
    expect(rec.features).toMatchObject({ roofYearEst: 2005, roofAgeBasis: "EFF_YR_BLT_PROXY", lastSaleDateAny: "2012-05-01", tenureBasis: "FDOR_SALE" });
    expect(rec.provenance).toMatchObject({ source_system: "duval_appraiser", source_url: "https://src/nal.zip", source_artifact: "appraisal/x.zip", source_sha256: "sha", run_id: "run1" });
    expect(rec).not.toHaveProperty("lexicon");
    // no run timestamps or as-of dependent ages inside the record (stable CID)
    expect(JSON.stringify(rec)).not.toMatch(/yearsSinceLastSale|features_run_id|generatedAt/);

    const state = await all<{ property_id: string; cid: string; bytes: string | number }>(db.conn, "SELECT property_id, cid, bytes FROM consolidation_state ORDER BY property_id");
    expect(state.map((s) => s.property_id)).toEqual(["A", "B", "C"]);
    const fileCid = await computeCid(readFileSync(join(dir, "properties", "A.json")));
    expect(state[0]?.cid).toBe(fileCid.cid);

    const shardFiles = readdirSync(join(dir, "shards")).sort();
    expect(shardFiles).toEqual(["shard-0000.json", "shard-0001.json"]);
    const shard0 = JSON.parse(readFileSync(join(dir, "shards", "shard-0000.json"), "utf8"));
    expect(ShardFileSchema.safeParse(shard0).success).toBe(true);
    expect(shard0.entries[0]).toMatchObject({ propertyId: "A", parcelIdentifier: "A", cid: fileCid.cid, address: "1 MAIN ST", zip: "32207", lat: 30.3, lon: -81.6 });
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(OracleIndexSchema.safeParse(index).success).toBe(true);
    expect(index).toMatchObject({ county: "duval", propertyCount: 3, shardSize: 2, runId: "r1" });
    expect(index.shards[0].shardCid).toBe((await computeCid(readFileSync(join(dir, "shards", "shard-0000.json")))).cid);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(OracleManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.entries[0]).toMatchObject({ propertyId: "A", filePath: "properties/A.json", cid: fileCid.cid });
  });

  it("is incremental: unchanged properties are skipped, a changed one is re-exported with a new CID; query table gets property_cid", async () => {
    const before = await all<{ cid: string }>(db.conn, "SELECT cid FROM consolidation_state WHERE property_id = 'B'");
    const second = await exportConsolidation(db.conn, { outDir: dir, shardSize: 2, since: "changed", limit: null, runId: "r2", logger, lexiconDir: null });
    expect(second).toMatchObject({ candidates: 3, exported: 0, unchanged: 3, totalInState: 3 });
    await db.conn.run("UPDATE parcels SET jv = 260000, row_hash = 'h2', run_id = 'run2' WHERE parcel_id = 'B'");
    await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t2" });
    const third = await exportConsolidation(db.conn, { outDir: dir, shardSize: 2, since: "changed", limit: null, runId: "r3", logger, lexiconDir: null });
    expect(third).toMatchObject({ exported: 1, unchanged: 2, totalInState: 3 });
    const after = await all<{ cid: string }>(db.conn, "SELECT cid FROM consolidation_state WHERE property_id = 'B'");
    expect(after[0]?.cid).not.toBe(before[0]?.cid);
    // --since <run_id> limits candidates to rows loaded at/after that run
    const fourth = await exportConsolidation(db.conn, { outDir: dir, shardSize: 2, since: "run2", limit: null, runId: "r4", logger, lexiconDir: null });
    expect(fourth.candidates).toBe(1);

    await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t3" });
    const qt = join(dir, "query-table.parquet");
    await exportQueryTable(db.conn, qt);
    const report = await validateQueryTable(db.conn, qt);
    expect(report.ok).toBe(true);
    expect(report.propertyCidFilled).toBe(3);
    const row = await all<{ property_cid: string }>(db.conn, `SELECT property_cid FROM read_parquet(${q(duckPath(qt))}) WHERE property_id = 'B'`);
    expect(row[0]?.property_cid).toBe(after[0]?.cid);
  });

  it("plans the open-data publish (counts + bytes) from manifest/shards/index", async () => {
    const plan = await planOpenData(dir, null);
    expect(plan).toMatchObject({ propertyFiles: 3, shardFiles: 2, propertyCount: 3, alreadyUploaded: 0, toUpload: 3 });
    expect(plan.propertyBytes).toBeGreaterThan(0);
    expect(formatOpenDataPlan(plan, null)).toMatch(/total objects:\s+7/);
    expect(existsSync(join(dir, "export-summary.json"))).toBe(true);
  });
});
