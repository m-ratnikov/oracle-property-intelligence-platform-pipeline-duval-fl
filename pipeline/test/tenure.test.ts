import { describe, expect, it } from "vitest";
import { all, ensureSchema, openDb } from "../src/db.js";
import { buildFeatures } from "../src/features/build.js";

const PROV = `'h', 'duval_appraiser', 'https://src/nal.zip', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'`;

/**
 * Tenure / proximity / water feature rules on a 4-parcel fixture:
 *  A: FDOR sale 2012 and COJ sale 2004 -> latest 2012, FDOR_SALE basis, 14 y, no_sale_10y true
 *  B: only COJ sale 2020 -> COJ_SALESL basis, 6 y, flag false
 *  C: no sale anywhere -> NULL tenure, flag NULL
 *  D: FDOR 2026 -> 0 y
 * Transit / Starbucks / water tables are filled directly (the NN helpers are exercised by the live run).
 */
describe("tenure, transit, starbucks and water features", () => {
  it("derives years_since_last_sale / no_sale_10y_flag / basis and proximity flags", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`
      INSERT INTO parcels (parcel_id, own_name, own_state, own_zipcd, phy_addr1, phy_zipcd, latitude, longitude, eff_yr_blt, source_url, row_hash, source_system, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ('A', 'DOE JOHN', 'FL', '32207', '1 MAIN ST', '32207', 30.30, -81.60, 2000, 'https://src/nal.zip', 'h', 'duval_appraiser', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'),
             ('B', 'ACME LLC', 'NY', '10001', '2 OAK ST', '32207', 30.31, -81.61, 0, 'https://src/nal.zip', 'h', 'duval_appraiser', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'),
             ('C', 'ROE JANE', 'GA', '30301', '3 PINE ST', '32207', 30.32, -81.62, 1990, 'https://src/nal.zip', 'h', 'duval_appraiser', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'),
             ('D', 'POE EDGAR', 'FL', '32207', '4 ELM ST', '32207', NULL, NULL, 2015, 'https://src/nal.zip', 'h', 'duval_appraiser', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1')`);
    await db.conn.run(`
      INSERT INTO sales_history (sale_key, parcel_id, sale_date, sale_year, sale_month, sale_price, sale_source, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ('k1', 'A', DATE '2012-05-01', 2012, 5, 180000, 'SDF', ${PROV}), ('k2', 'D', DATE '2026-03-01', 2026, 3, 300000, 'SDF', ${PROV})`);
    await db.conn.run(`
      INSERT INTO coj_parcels (re, parcel_id, fld_zone, zoning, last_sale_date, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ('000000-000A', 'A', 'X', 'RLD-60', DATE '2004-06-15', ${PROV}), ('000000-000B', 'B', 'AE', 'CCG-1', DATE '2020-01-10', ${PROV})`);
    // transit / starbucks / water derived tables as the tracks would leave them
    await db.conn.run(`INSERT INTO transit_stops (stop_id, stop_name, latitude, longitude, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id) VALUES ('s1', 'Main St', 30.30, -81.60, ${PROV})`);
    await db.conn.run(`CREATE TABLE derived.nn_transit AS SELECT * FROM (VALUES ('A', 120.0, 's1', 'Main St', '3', '1'), ('B', 950.0, 's1', 'Main St', '3', '1')) t(parcel_id, nearest_transit_stop_m, nearest_transit_stop_id, nearest_transit_stop_name, nearest_transit_stop_route_types, nearest_transit_stop_route_short_names)`);
    await db.conn.run(`INSERT INTO places (place_id, name, latitude, longitude, is_starbucks, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id) VALUES ('p1', 'Starbucks', 30.30, -81.60, true, ${PROV})`);
    await db.conn.run(`CREATE TABLE derived.nn_starbucks AS SELECT * FROM (VALUES ('A', 400.0, 'p1', 'Starbucks'), ('C', 3000.0, 'p1', 'Starbucks')) t(parcel_id, nearest_starbucks_m, nearest_starbucks_id, nearest_starbucks_name)`);
    await db.conn.run(`INSERT INTO water_bodies (water_id, name, water_type, layer, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id) VALUES ('w1', 'St. Johns River', 'river', 'coj_stjohnsriver', ${PROV})`);
    await db.conn.run(`CREATE TABLE derived.water_distance AS SELECT * FROM (VALUES ('A', 'w1', 'St. Johns River', 'river', 'coj_stjohnsriver', 90.0, false, true), ('B', 'w1', 'St. Johns River', 'river', 'coj_stjohnsriver', 1200.0, false, false)) t(parcel_id, water_id, water_name, water_type, layer, water_dist_m, box_touch, water_view_flag)`);

    const stats = await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t" });
    expect(stats).toMatchObject({ rows: 4, transitLoaded: true, placesLoaded: true, waterLoaded: true, cojParcelsLoaded: true });
    const rows = await all<Record<string, unknown>>(db.conn, "SELECT * FROM derived.properties_features ORDER BY property_id");
    const [a, b, c, d] = rows as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];

    expect(a).toMatchObject({ last_sale_date: "2012-05-01", last_sale_date_any: "2012-05-01", tenure_basis: "FDOR_SALE", no_sale_10y_flag: true, fld_zone: "X", zoning: "RLD-60", coj_last_sale_date: "2004-06-15" });
    expect(Number(a.years_since_last_sale)).toBe(14);
    expect(b).toMatchObject({ last_sale_date: null, last_sale_date_any: "2020-01-10", tenure_basis: "COJ_SALESL", no_sale_10y_flag: false, fld_zone: "AE" });
    expect(Number(b.years_since_last_sale)).toBe(6);
    expect(c).toMatchObject({ last_sale_date_any: null, tenure_basis: null, no_sale_10y_flag: null, years_since_last_sale: null, fld_zone: null });
    expect(d).toMatchObject({ tenure_basis: "FDOR_SALE", no_sale_10y_flag: false });
    expect(Number(d.years_since_last_sale)).toBe(0);

    // proximity + water
    expect(a).toMatchObject({ nearest_transit_stop_m: 120, near_transit_800m: true, nearest_transit_route_types: "3", nearest_starbucks_m: 400, near_starbucks_800m: true, water_view_flag: true, water_view_major_flag: true, water_dist_m: 90, water_body_name: "St. Johns River" });
    expect(String(a.water_basis)).toMatch(/centroid 90.0 m from shoreline of St. Johns River/);
    expect(b).toMatchObject({ near_transit_800m: false, nearest_starbucks_m: null, near_starbucks_800m: null, water_view_flag: false, water_dist_m: 1200 });
    expect(c).toMatchObject({ nearest_transit_stop_m: null, near_transit_800m: null, near_starbucks_800m: false, water_view_flag: false, water_dist_m: null });
    expect(String(c.water_basis)).toMatch(/no mapped water within ~1 km/);
    // no coordinates: every proximity feature stays NULL
    expect(d).toMatchObject({ nearest_transit_stop_m: null, water_view_flag: null, water_basis: null, nearest_starbucks_m: null });
    // UI provenance contract columns
    expect(a.source_url).toBe("https://src/nal.zip");
    expect(a.run_id).toBe("t");
    expect(String(a.fetched_at)).toMatch(/^2026-08-21/);
    // roof proxy unchanged when no permits
    expect(a).toMatchObject({ roof_age_basis: "EFF_YR_BLT_PROXY", roof_year_est: 2000, has_permits: null });
    await db.close();
  });
});
