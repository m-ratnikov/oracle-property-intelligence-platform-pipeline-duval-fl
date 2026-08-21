import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { all, duckPath, ensureSchema, openDb, q, type Db } from "../src/db.js";
import { buildFeatures, COLUMN_FAMILIES, SOURCE_FAMILIES } from "../src/features/build.js";
import {
  exportQueryTable,
  QUERY_TABLE_COLUMN_FAMILY,
  queryTableSchemaMetadata,
  validateQueryTable,
} from "../src/features/export.js";
import { hasAdditionalOwners } from "../src/features/rules.js";

let db: Db;
let dir: string;
let out: string;

/** row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id */
const prov = (system: string, at: string) =>
  `'h', '${system}', 'https://src/${system}', '${system}/x', 'sha', TIMESTAMP '${at}', 'run1'`;

const NAL = prov("duval_appraiser", "2026-08-21 07:18:09");
const PAR = prov("fdor_par", "2026-08-21 07:02:43");
const SDF = prov("fdor_sdf", "2026-08-21 07:18:37");
const GTFS = prov("jta_gtfs", "2026-08-21 07:32:55");
const OVERTURE = prov("overture_places", "2026-08-21 08:00:31");
const HYDRO = prov("coj_nhd_hydrography", "2026-08-21 08:09:19");
const COJ = prov("coj_parcels", "2026-08-21 09:00:00");

/**
 * Two parcels that differ in which sources reached them:
 *  A has coordinates, an SDF sale, a COJ parcel row, transit and Starbucks neighbours and water;
 *  B has none of those (no coordinates at all), so every enrichment family must go NULL on it.
 */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "duval-provenance-"));
  out = join(dir, "query-table.parquet");
  db = await openDb(":memory:");
  await ensureSchema(db.conn);
  await db.conn.run(`
    INSERT INTO parcels (parcel_id, dor_uc, jv, lnd_val, av_nsd, lnd_sqfoot, act_yr_blt, eff_yr_blt, tot_lvg_area,
                         own_name, own_addr1, own_city, own_state, own_zipcd, phy_addr1, phy_city, phy_zipcd,
                         latitude, longitude, geometry_source,
                         row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES
      ('A', '01', 250000, 50000, 200000, 8712, 1998, 2005, 1800, 'DOE JOHN', '1 MAIN ST', 'JACKSONVILLE', 'FL', '32207', '1 MAIN ST', 'JACKSONVILLE', '32207', 30.30, -81.60, 'fdor_par', ${NAL}),
      ('B', '01', 100000, 10000, 90000, 4356, 1970, 0, 900, 'SMITH JOHN ET AL', '9 PINE RD', 'ATLANTA', 'GA', '30301', '9 PINE RD', 'JACKSONVILLE', '32210', NULL, NULL, NULL, ${NAL})`);
  await db.conn.run(`
    INSERT INTO parcel_geometry (parcel_id, latitude, longitude, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('A', 30.30, -81.60, ${PAR})`);
  await db.conn.run(`
    INSERT INTO sales_history (sale_key, parcel_id, sale_date, sale_year, sale_month, sale_price, sale_source,
                               row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('k1', 'A', DATE '2012-05-01', 2012, 5, 180000, 'SDF', ${SDF})`);
  await db.conn.run(`
    INSERT INTO coj_parcels (re, parcel_id, fld_zone, zoning, last_sale_date, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('000000-000A', 'A', 'X', 'RLD-60', DATE '2004-06-15', ${COJ})`);
  await db.conn.run(`
    INSERT INTO transit_stops (stop_id, stop_name, latitude, longitude, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('s1', 'Main St', 30.30, -81.60, ${GTFS})`);
  await db.conn.run(
    "CREATE TABLE derived.nn_transit AS SELECT * FROM (VALUES ('A', 120.0, 's1', 'Main St', '3', '1')) t(parcel_id, nearest_transit_stop_m, nearest_transit_stop_id, nearest_transit_stop_name, nearest_transit_stop_route_types, nearest_transit_stop_route_short_names)",
  );
  await db.conn.run(`
    INSERT INTO places (place_id, name, latitude, longitude, is_starbucks, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('p1', 'Starbucks', 30.30, -81.60, true, ${OVERTURE})`);
  await db.conn.run(
    "CREATE TABLE derived.nn_starbucks AS SELECT * FROM (VALUES ('A', 400.0, 'p1', 'Starbucks')) t(parcel_id, nearest_starbucks_m, nearest_starbucks_id, nearest_starbucks_name)",
  );
  await db.conn.run(`
    INSERT INTO water_bodies (water_id, name, water_type, layer, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
    VALUES ('w1', 'St. Johns River', 'river', 'coj_stjohnsriver', ${HYDRO})`);
  await db.conn.run(
    "CREATE TABLE derived.water_distance AS SELECT * FROM (VALUES ('A', 'w1', 'St. Johns River', 'river', 'coj_stjohnsriver', 90.0, false, true)) t(parcel_id, water_id, water_name, water_type, layer, water_dist_m, box_touch, water_view_flag)",
  );
  await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "test" });
  await exportQueryTable(db.conn, out);
});

afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function row(id: string): Promise<Record<string, unknown>> {
  const rows = await all<Record<string, unknown>>(
    db.conn,
    `SELECT * FROM read_parquet(${q(duckPath(out))}) WHERE property_id = '${id}'`,
  );
  const first = rows[0];
  if (first === undefined) throw new Error(`no row ${id}`);
  return first;
}

describe("per column family provenance", () => {
  it("names the source system behind each family, and NULL where the family gave nothing", async () => {
    const a = await row("A");
    const b = await row("B");

    // the canonical column stays put, and is now demonstrably appraisal scoped
    expect(a.source_system).toBe("duval_appraiser");
    expect(a.appraisal_source).toBe(a.source_system);
    expect(b.appraisal_source).toBe(b.source_system);

    expect(a).toMatchObject({
      sales_source: "fdor_sdf",
      geometry_source: "fdor_par",
      transit_source: "jta_gtfs",
      places_source: "overture_places",
      water_source: "coj_nhd_hydrography",
      parcel_layer_source: "coj_parcels",
    });
    expect(String(a.geometry_fetched_at)).toMatch(/^2026-08-21 07:02:43/);
    expect(String(a.sales_fetched_at)).toMatch(/^2026-08-21 07:18:37/);
    expect(String(a.parcel_layer_fetched_at)).toMatch(/^2026-08-21 09:00:00/);

    // B has no coordinates and no sale: every enrichment family must say so rather than inherit
    // the appraisal system
    expect(b).toMatchObject({
      sales_source: null,
      sales_fetched_at: null,
      geometry_source: null,
      transit_source: null,
      places_source: null,
      water_source: null,
      parcel_layer_source: null,
    });

    // sources that never loaded stay NULL for both rows rather than defaulting to anything
    for (const key of ["structure", "permit", "business", "contractor", "address"]) {
      expect(a[`${key}_source`], key).toBeNull();
      expect(b[`${key}_source`], key).toBeNull();
    }
  });

  it("rolls the row up into source_systems", async () => {
    const a = await row("A");
    const b = await row("B");
    expect(String(a.source_systems).split(",")).toEqual([
      "coj_nhd_hydrography", "coj_parcels", "duval_appraiser", "fdor_par", "fdor_sdf", "jta_gtfs", "overture_places",
    ]);
    // the parcel the enrichment never reached says exactly that: only the roll
    expect(b.source_systems).toBe("duval_appraiser");
  });

  it("has a family for every published column, and fails the gate when one is missing", async () => {
    const report = await validateQueryTable(db.conn, out);
    expect(report.undocumentedColumns).toEqual([]);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    for (const c of report.columns) expect(c.family, c.column).not.toBe("UNDOCUMENTED");

    await db.conn.run("ALTER TABLE derived.properties_features ADD COLUMN mystery_column VARCHAR");
    const undocumented = join(dir, "undocumented.parquet");
    await exportQueryTable(db.conn, undocumented);
    const bad = await validateQueryTable(db.conn, undocumented);
    expect(bad.undocumentedColumns).toEqual(["mystery_column"]);
    expect(bad.ok).toBe(false);
    await db.conn.run("ALTER TABLE derived.properties_features DROP COLUMN mystery_column");
  });

  it("ships the column to source dictionary inside the parquet", async () => {
    const kv = await all<{ k: string; v: string }>(
      db.conn,
      `SELECT decode(key) AS k, decode(value) AS v FROM parquet_kv_metadata(${q(duckPath(out))})`,
    );
    const byKey = new Map(kv.map((r) => [r.k, r.v]));
    expect(byKey.get("elephant_county")).toBe("duval");
    const meta = JSON.parse(byKey.get("elephant_column_provenance") ?? "{}") as ReturnType<typeof queryTableSchemaMetadata>;
    expect(meta.columns.nearest_transit_stop_m?.sourceSystem).toBe("jta_gtfs");
    expect(meta.columns.water_dist_m?.sourceSystem).toBe("coj_nhd_hydrography");
    expect(meta.columns.market_value?.sourceSystem).toBe("duval_appraiser");
    // and the map covers everything the file actually contains
    const cols = await all<{ column_name: string }>(db.conn, `DESCRIBE SELECT * FROM read_parquet(${q(duckPath(out))})`);
    for (const c of cols) expect(meta.columns[c.column_name], c.column_name).toBeDefined();
  });

  it("keeps the family registry disjoint and complete", () => {
    const seen = new Set<string>();
    for (const f of COLUMN_FAMILIES) {
      for (const c of f.columns) {
        expect(seen.has(c), `${c} is claimed by more than one family`).toBe(false);
        seen.add(c);
      }
    }
    for (const f of SOURCE_FAMILIES) {
      expect(QUERY_TABLE_COLUMN_FAMILY.get(`${f.key}_source`)).toBe(f.key);
      expect(QUERY_TABLE_COLUMN_FAMILY.get(`${f.key}_fetched_at`)).toBe(f.key);
    }
  });
});

describe("owner columns", () => {
  it("publishes owner_count NULL rather than a constant, and flags the roll's ET AL marker", async () => {
    const a = await row("A");
    const b = await row("B");
    expect(a.owner_count).toBeNull();
    expect(b.owner_count).toBeNull();
    expect(a.has_additional_owners).toBe(false);
    expect(b.has_additional_owners).toBe(true);
    // the SQL and its TS twin agree
    expect(hasAdditionalOwners("SMITH JOHN ET AL")).toBe(true);
    expect(hasAdditionalOwners("SMITH JOHN ETAL")).toBe(true);
    expect(hasAdditionalOwners("JONES ROBERT ET UX")).toBe(true);
    expect(hasAdditionalOwners("DOE JOHN")).toBe(false);
    // a company name that merely contains the letters is not a marker
    expect(hasAdditionalOwners("SWEET ALICE BAKERY")).toBe(false);
    expect(hasAdditionalOwners(null)).toBeNull();
  });
});
