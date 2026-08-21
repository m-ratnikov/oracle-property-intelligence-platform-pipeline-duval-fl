import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duckPath, ensureSchema, openDb, q, type Db } from "../src/db.js";
import { buildFeatures } from "../src/features/build.js";
import { exportQueryTable, QUERY_TABLE_CANONICAL_COLUMNS, validateQueryTable } from "../src/features/export.js";

let db: Db;
let dir: string;

const PROV = `'h', 'duval_appraiser', 'https://src', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "duval-validator-"));
  db = await openDb(":memory:");
  await ensureSchema(db.conn);
  await db.conn.run(`
    INSERT INTO parcels (parcel_id, dor_uc, jv, lnd_val, av_nsd, lnd_sqfoot, act_yr_blt, eff_yr_blt, tot_lvg_area,
                         own_name, own_addr1, own_city, own_state, own_zipcd, phy_addr1, phy_city, phy_zipcd,
                         row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES
      ('000001-0001R', '01', 250000, 50000, 200000, 8712, 1998, 2005, 1800, 'DOE JOHN', '1 MAIN ST', 'JACKSONVILLE', 'FL', '32207', '1 MAIN ST', 'JACKSONVILLE', '32207', ${PROV}),
      ('000001-0002R', '04', 150000, 20000, 140000, 0, 2015, 2015, 900, 'ACME LLC', '5 PARK AVE', 'NEW YORK', 'NY', '10001', '2 OCEAN DR', 'JACKSONVILLE BEACH', '32250', ${PROV}),
      ('000001-0003R', '00', 10000, 10000, 10000, 43560, 0, 0, 0, 'SMITH JANE', '9 PINE RD', 'ATLANTA', 'GA', '30301', '9 PINE RD', 'JACKSONVILLE', '32210', ${PROV})`);
  await db.conn.run(`
    INSERT INTO sales_history (sale_key, parcel_id, sale_date, sale_year, sale_month, sale_price, sale_source,
                               row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('k1', '000001-0001R', DATE '2012-05-01', 2012, 5, 180000, 'SDF', ${PROV}),
           ('k2', '000001-0001R', DATE '2001-01-01', 2001, 1, 90000, 'SDF', ${PROV}),
           ('k3', '000001-0002R', DATE '2025-11-01', 2025, 11, 300000, 'SDF', ${PROV})`);
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("query table builder + validator", () => {
  it("builds one row per parcel with the 37 canonical columns first and passes the gate", async () => {
    const stats = await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "test" });
    expect(stats.rows).toBe(3);
    const out = join(dir, "query-table.parquet");
    const exp = await exportQueryTable(db.conn, out);
    expect(exp.rows).toBe(3);
    const report = await validateQueryTable(db.conn, out);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.rows).toBe(3);
    expect(report.distinctFolios).toBe(3);
    expect(report.columns.slice(0, QUERY_TABLE_CANONICAL_COLUMNS.length).map((c) => c.column)).toEqual([...QUERY_TABLE_CANONICAL_COLUMNS]);

    const rows = (await db.conn.runAndReadAll(`SELECT * FROM read_parquet(${q(duckPath(out))}) ORDER BY request_identifier`)).getRowObjectsJson() as Record<string, unknown>[];
    const r1 = rows[0]!;
    expect(r1.property_id).toBe("000001-0001R");
    expect(r1.owner_occupied).toBe(true);
    expect(r1.owner_region_class).toBe("LOCAL");
    expect(r1.last_sale_date).toBe("2012-05-01");
    expect(Number(r1.years_since_last_sale)).toBe(14);
    expect(Number(r1.lot_size_acre)).toBeCloseTo(0.2, 3);
    expect(r1.roof_age_basis).toBe("EFF_YR_BLT_PROXY");
    expect(Number(r1.roof_year_est)).toBe(2005);
    expect(r1.property_type).toBe("RESIDENTIAL");
    expect(r1.property_usage_type).toBe("Single Family");
    // sources not loaded stay NULL, never false/0
    expect(r1.has_permits).toBeNull();
    expect(r1.permit_count).toBeNull();
    expect(r1.has_sunbiz_tenant).toBeNull();
    expect(r1.nearest_transit_stop_m).toBeNull();
    expect(r1.water_view_flag).toBeNull();
    const r2 = rows[1]!;
    expect(r2.owner_region_class).toBe("NATIONAL");
    expect(r2.owner_occupied).toBe(false);
    expect(r2.lot_size_acre).toBeNull();
    const r3 = rows[2]!;
    expect(r3.owner_region_class).toBe("REGIONAL");
    expect(r3.built_year).toBeNull();
    expect(r3.roof_age_basis).toBeNull();
    expect(r3.last_sale_date).toBeNull();
  });

  it("fails the gate on duplicate folios", async () => {
    const out = join(dir, "dup.parquet");
    await db.conn.run(
      `COPY (SELECT * FROM derived.properties_features UNION ALL SELECT * FROM derived.properties_features LIMIT 4) TO ${q(duckPath(out))} (FORMAT PARQUET)`,
    );
    const report = await validateQueryTable(db.conn, out);
    expect(report.ok).toBe(false);
    expect(report.dupFolios).toBeGreaterThan(0);
    expect(report.problems.join(" ")).toMatch(/duplicated request_identifier/);
  });

  it("fails the gate on null folios and on row count mismatch", async () => {
    const out = join(dir, "null.parquet");
    await db.conn.run(
      `COPY (SELECT * REPLACE (CASE WHEN property_id = '000001-0003R' THEN NULL ELSE request_identifier END AS request_identifier) FROM derived.properties_features)
       TO ${q(duckPath(out))} (FORMAT PARQUET)`,
    );
    const report = await validateQueryTable(db.conn, out);
    expect(report.ok).toBe(false);
    expect(report.nullFolios).toBe(1);
    const out2 = join(dir, "short.parquet");
    await db.conn.run(`COPY (SELECT * FROM derived.properties_features LIMIT 2) TO ${q(duckPath(out2))} (FORMAT PARQUET)`);
    const report2 = await validateQueryTable(db.conn, out2);
    expect(report2.ok).toBe(false);
    expect(report2.problems.join(" ")).toMatch(/!= distinct parcel_id/);
  });
});
