import { describe, expect, it } from "vitest";
import { all, ensureSchema, openDb } from "../src/db.js";
import { buildFeatures, TENURE_QUALITY_VALUES, TENURE_RECORD_EPOCH } from "../src/features/build.js";
import { QUERY_TABLE_COLUMN_FAMILY, QUERY_TABLE_COLUMN_NOTES } from "../src/features/export.js";

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

    expect(a).toMatchObject({ last_sale_date: "2012-05-01", last_sale_date_any: "2012-05-01", tenure_basis: "FDOR_SALE", tenure_source: "duval_appraiser", tenure_quality: "PLAUSIBLE", has_sale_on_record: true, no_sale_10y_flag: true, fld_zone: "X", zoning: "RLD-60", coj_last_sale_date: "2004-06-15" });
    expect(Number(a.years_since_last_sale)).toBe(14);
    expect(b).toMatchObject({ last_sale_date: null, last_sale_date_any: "2020-01-10", tenure_basis: "COJ_SALESL", tenure_source: "duval_appraiser", tenure_quality: "PLAUSIBLE", has_sale_on_record: true, no_sale_10y_flag: false, fld_zone: "AE" });
    expect(Number(b.years_since_last_sale)).toBe(6);
    // no transfer in any source: tenure_basis says so out loud instead of going NULL, and
    // has_sale_on_record makes "no sale on record" filterable apart from "held a long time"
    expect(c).toMatchObject({ last_sale_date_any: null, tenure_basis: "NO_SALE_ON_RECORD", tenure_source: null, tenure_quality: "NO_SALE_ON_RECORD", has_sale_on_record: false, no_sale_10y_flag: null, years_since_last_sale: null, fld_zone: null });
    expect(d).toMatchObject({ tenure_basis: "FDOR_SALE", tenure_quality: "PLAUSIBLE", has_sale_on_record: true, no_sale_10y_flag: false });
    expect(Number(d.years_since_last_sale)).toBe(0);
    // tenure_basis always names a column in the same row that holds the date it was computed from
    for (const row of rows) {
      const expected = row.tenure_basis === "FDOR_SALE" ? row.last_sale_date : row.tenure_basis === "COJ_SALESL" ? row.coj_last_sale_date : null;
      expect(row.last_sale_date_any).toBe(expected);
    }

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

/**
 * tenure_quality on a fixture built from the shapes measured in the published artifact
 * (404,023 rows): the two 1899 filler dates and the 1800 one, the 1925/1926 municipal, cemetery
 * and railway dates that the UI's old `> 100 years` cut let through at exactly 100, a parcel whose
 * use code the roll does not carry, and a parcel with no transfer in any source.
 */
describe("tenure_quality", () => {
  const parcel = (id: string, dorUc: string | null) =>
    `('${id}', ${dorUc === null ? "NULL" : `'${dorUc}'`}, 'OWNER ${id}', 'https://src/nal.zip', 'h', 'duval_appraiser', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1')`;
  const cojSale = (id: string, date: string) =>
    `('re-${id}', '${id}', DATE '${date}', ${PROV})`;

  const build = async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`
      INSERT INTO parcels (parcel_id, dor_uc, own_name, source_url, row_hash, source_system, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ${[
        parcel("SENTINEL_1899", "001"),
        parcel("SENTINEL_CIVIC", "082"),
        parcel("EPOCH_MINUS_1", "001"),
        parcel("EPOCH", "001"),
        parcel("CIVIC_PARK_1925", "082"),
        parcel("CIVIC_CEMETERY", "076"),
        parcel("CIVIC_ROW", "094"),
        parcel("MARKET_RAILWAY", "048"),
        parcel("MARKET_HOME", "001"),
        parcel("NO_USE_CODE", null),
        parcel("NO_SALE_CIVIC", "089"),
      ].join(",")}`);
    await db.conn.run(`
      INSERT INTO coj_parcels (re, parcel_id, last_sale_date, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
      VALUES ${[
        cojSale("SENTINEL_1899", "1899-12-30"),
        cojSale("SENTINEL_CIVIC", "1800-01-01"),
        cojSale("EPOCH_MINUS_1", "1900-12-31"),
        cojSale("EPOCH", TENURE_RECORD_EPOCH),
        cojSale("CIVIC_PARK_1925", "1925-10-29"),
        cojSale("CIVIC_CEMETERY", "2019-05-01"),
        cojSale("CIVIC_ROW", "2010-01-04"),
        cojSale("MARKET_RAILWAY", "1925-12-15"),
        cojSale("MARKET_HOME", "2012-03-08"),
        cojSale("NO_USE_CODE", "2015-06-01"),
      ].join(",")}`);
    await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "t" });
    const rows = await all<{ property_id: string; tenure_quality: string; years_since_last_sale: number | null }>(
      db.conn,
      "SELECT property_id, tenure_quality, years_since_last_sale FROM derived.properties_features",
    );
    await db.close();
    return new Map(rows.map((r) => [r.property_id, r]));
  };

  it("classifies each row from the date and the use code, and is never NULL", async () => {
    const by = await build();
    const q = (id: string) => by.get(id)?.tenure_quality;

    // a date before the county's dated record is filler, whatever the parcel is
    expect(q("SENTINEL_1899")).toBe("IMPLAUSIBLE_DATE");
    expect(q("EPOCH_MINUS_1")).toBe("IMPLAUSIBLE_DATE");
    // a bad date outranks a civic parcel: the wrong number is the more actionable defect
    expect(q("SENTINEL_CIVIC")).toBe("IMPLAUSIBLE_DATE");

    // institutional (70-79), governmental (80-89) and miscellaneous (90-99) use codes
    expect(q("CIVIC_PARK_1925")).toBe("INSTITUTIONAL_OR_CIVIC");
    expect(q("CIVIC_CEMETERY")).toBe("INSTITUTIONAL_OR_CIVIC");
    expect(q("CIVIC_ROW")).toBe("INSTITUTIONAL_OR_CIVIC");
    // a civic parcel is demoted whatever its tenure length, so the label never drifts with as-of
    expect(by.get("CIVIC_CEMETERY")?.years_since_last_sale).toBe(7);

    // no transfer in any source outranks everything: there is no date to judge
    expect(q("NO_SALE_CIVIC")).toBe("NO_SALE_ON_RECORD");
    expect(by.get("NO_SALE_CIVIC")?.years_since_last_sale).toBeNull();

    expect(q("EPOCH")).toBe("PLAUSIBLE");
    expect(q("MARKET_HOME")).toBe("PLAUSIBLE");
    // documented residual: the use code is industrial, so a railway right of way dated by a 1925
    // conveyance stays PLAUSIBLE. Owner-name matching would catch it and was rejected; see
    // tenureQualitySql. One such row exists in the published artifact.
    expect(q("MARKET_RAILWAY")).toBe("PLAUSIBLE");
    // the roll carries no use code for this parcel, so nothing shows it is civic
    expect(q("NO_USE_CODE")).toBe("PLAUSIBLE");

    for (const [id, row] of by) {
      expect(row.tenure_quality, id).not.toBeNull();
      expect(TENURE_QUALITY_VALUES, id).toContain(row.tenure_quality);
    }
  });

  it("is registered for publication, so the undocumented-column gate passes", () => {
    expect(QUERY_TABLE_COLUMN_FAMILY.get("tenure_quality")).toBe("derived");
    const note = QUERY_TABLE_COLUMN_NOTES.tenure_quality ?? "";
    // the note is the only thing an MCP client reads about this column: DESCRIBE gives it a name
    // and a type and nothing else, so the filter instruction has to be in here
    expect(note).toMatch(/FILTER ANY TENURE QUESTION ON THIS COLUMN/);
    for (const value of TENURE_QUALITY_VALUES) expect(note, value).toContain(value);
  });
});
