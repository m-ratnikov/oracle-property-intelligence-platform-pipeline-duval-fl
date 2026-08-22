/**
 * The provenance beside a value has to be the provenance OF THAT VALUE.
 *
 * The defect these tests exist to stop is a false claim, not a wrong number. The pipeline resolves
 * provenance per column family and publishes it honestly: twelve `<family>_source` /
 * `<family>_fetched_at` pairs plus a `source_systems` list on every row. The results grid threw all
 * of that away and printed `source_system`, which names the appraisal roll spine the row is keyed
 * on and is the same value on all 404,023 rows. So the Starbucks walking distance from Overture and
 * the transit distance from the JTA GTFS feed were both displayed as the work of the county
 * property appraiser. Attributing one organisation's data to another is the one error a product
 * that sells provenance cannot make.
 *
 * Every assertion below fails against the cell as it was, which printed exactly one badge.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { createAgentTools, newTrace } from "@/lib/agent/tools";
import type { PresetName } from "@/lib/agent/schema";
import type { AgentEvidenceRow } from "@/lib/agent/types";
import { PRESETS } from "@/lib/sql";
import { SOURCE_FAMILIES, SPINE_PROVENANCE_COLUMNS } from "@/lib/columns";
import {
  fallbackRowSources,
  formatTimestampShort,
  parseColumnProvenance,
  rowSources,
  type ColumnProvenanceMap,
  type RowSource,
} from "@/lib/format";

/**
 * The column to family map exactly as the published artifact carries it.
 *
 * Read out of the parquet footer of
 * bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri (404,023 rows, 131 columns) with
 * `SELECT decode(value) FROM parquet_kv_metadata(...) WHERE decode(key) =
 * 'elephant_column_provenance'`, with only the per family `columns` arrays and the prose `note` and
 * `sourceUrl` fields dropped. Nothing else is edited, because a fixture that paraphrases the
 * artifact proves nothing about the artifact. Refresh it from the published file when the pipeline
 * changes the map.
 */
const PUBLISHED_COLUMN_PROVENANCE =
  "{\"county\":\"duval\",\"schemaVersion\":\"2\",\"families\":[{\"key\":\"appraisal\",\"label\":\"FDOR NAL tax roll (Duval propert" +
  "y appraiser)\",\"sourceSystem\":\"duval_appraiser\",\"sourceColumn\":\"appraisal_source\",\"fetchedAtColumn\":\"appraisal_" +
  "fetched_at\"},{\"key\":\"sales\",\"label\":\"FDOR SDF sales data file (plus the roll's own SALE_*1/2 columns)\",\"source" +
  "System\":\"fdor_sdf\",\"sourceColumn\":\"sales_source\",\"fetchedAtColumn\":\"sales_fetched_at\"},{\"key\":\"geometry\",\"labe" +
  "l\":\"FDOR PAR parcel shapefile\",\"sourceSystem\":\"fdor_par\",\"sourceColumn\":\"geometry_source\",\"fetchedAtColumn\":\"g" +
  "eometry_fetched_at\"},{\"key\":\"structure\",\"label\":\"Duval Property Appraiser Detail pages (vendored Elephant lexi" +
  "con transform)\",\"sourceSystem\":\"duval_pa_detail\",\"sourceColumn\":\"structure_source\",\"fetchedAtColumn\":\"structur" +
  "e_fetched_at\"},{\"key\":\"permit\",\"label\":\"City of Jacksonville JaxEPICS permits\",\"sourceSystem\":\"coj_jaxepics\",\"" +
  "sourceColumn\":\"permit_source\",\"fetchedAtColumn\":\"permit_fetched_at\"},{\"key\":\"business\",\"label\":\"Florida Divisi" +
  "on of Corporations (Sunbiz)\",\"sourceSystem\":\"sunbiz\",\"sourceColumn\":\"business_source\",\"fetchedAtColumn\":\"busin" +
  "ess_fetched_at\"},{\"key\":\"contractor\",\"label\":\"Florida DBPR CILB licensees\",\"sourceSystem\":\"dbpr_cilb\",\"sourceC" +
  "olumn\":\"contractor_source\",\"fetchedAtColumn\":\"contractor_fetched_at\"},{\"key\":\"transit\",\"label\":\"JTA GTFS stati" +
  "c feed\",\"sourceSystem\":\"jta_gtfs\",\"sourceColumn\":\"transit_source\",\"fetchedAtColumn\":\"transit_fetched_at\"},{\"ke" +
  "y\":\"places\",\"label\":\"Overture Maps places\",\"sourceSystem\":\"overture_places\",\"sourceColumn\":\"places_source\",\"fe" +
  "tchedAtColumn\":\"places_fetched_at\"},{\"key\":\"water\",\"label\":\"COJ river polygons and USGS NHD hydrography\",\"sour" +
  "ceSystem\":\"coj_nhd_hydrography\",\"sourceColumn\":\"water_source\",\"fetchedAtColumn\":\"water_fetched_at\"},{\"key\":\"pa" +
  "rcel_layer\",\"label\":\"COJ parcel layer (CityBiz/Parcels)\",\"sourceSystem\":\"coj_parcels\",\"sourceColumn\":\"parcel_l" +
  "ayer_source\",\"fetchedAtColumn\":\"parcel_layer_fetched_at\"},{\"key\":\"address\",\"label\":\"COJ address points (ERAT)\"" +
  ",\"sourceSystem\":\"coj_address_points\",\"sourceColumn\":\"address_source\",\"fetchedAtColumn\":\"address_fetched_at\"},{" +
  "\"key\":\"derived\",\"label\":\"Computed by this pipeline from more than one of the families above\",\"sourceSystem\":nu" +
  "ll,\"sourceColumn\":null,\"fetchedAtColumn\":null},{\"key\":\"pipeline\",\"label\":\"Pipeline run bookkeeping\",\"sourceSys" +
  "tem\":null,\"sourceColumn\":null,\"fetchedAtColumn\":null},{\"key\":\"placeholder\",\"label\":\"Canonical Elephant columns" +
  " no Duval source publishes\",\"sourceSystem\":null,\"sourceColumn\":null,\"fetchedAtColumn\":null}],\"columns\":{\"prope" +
  "rty_id\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"request_identifier\":{\"family\":\"appraisal\",\"so" +
  "urceSystem\":\"duval_appraiser\"},\"parcel_identifier\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"so" +
  "urce_system\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"county_name\":{\"family\":\"appraisal\",\"sour" +
  "ceSystem\":\"duval_appraiser\"},\"state_code\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"address_str" +
  "eet\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"address_city\":{\"family\":\"appraisal\",\"sourceSyste" +
  "m\":\"duval_appraiser\"},\"address_zip\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"lot_size_acre\":{\"" +
  "family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"lot_area_sqft\":{\"family\":\"appraisal\",\"sourceSystem\":\"du" +
  "val_appraiser\"},\"property_type\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"property_usage_type\":" +
  "{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"built_year\":{\"family\":\"appraisal\",\"sourceSystem\":\"duv" +
  "al_appraiser\"},\"livable_floor_area\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"assessed_value\":{" +
  "\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"market_value\":{\"family\":\"appraisal\",\"sourceSystem\":\"du" +
  "val_appraiser\"},\"land_value\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"owner_name\":{\"family\":\"a" +
  "ppraisal\",\"sourceSystem\":\"duval_appraiser\"},\"owners_text\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraise" +
  "r\"},\"owner_count\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"owner_occupied\":{\"family\":\"appraisa" +
  "l\",\"sourceSystem\":\"duval_appraiser\"},\"has_additional_owners\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appra" +
  "iser\"},\"dor_uc\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"pa_uc\":{\"family\":\"appraisal\",\"sourceS" +
  "ystem\":\"duval_appraiser\"},\"eff_year_built\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"taxable_va" +
  "lue\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"assessed_value_school\":{\"family\":\"appraisal\",\"so" +
  "urceSystem\":\"duval_appraiser\"},\"homestead_flag\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"build" +
  "ing_count\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"residential_units\":{\"family\":\"appraisal\",\"" +
  "sourceSystem\":\"duval_appraiser\"},\"legal_description\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"" +
  "neighborhood_code\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"census_block\":{\"family\":\"appraisal" +
  "\",\"sourceSystem\":\"duval_appraiser\"},\"owner_mailing_address\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_apprai" +
  "ser\"},\"owner_mailing_city\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"owner_mailing_state\":{\"fam" +
  "ily\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"owner_mailing_zip\":{\"family\":\"appraisal\",\"sourceSystem\":\"d" +
  "uval_appraiser\"},\"owner_region_class\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"source_artifact" +
  "\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"source_sha256\":{\"family\":\"appraisal\",\"sourceSystem\"" +
  ":\"duval_appraiser\"},\"source_fetched_at\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"source_run_id" +
  "\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"source_url\":{\"family\":\"appraisal\",\"sourceSystem\":\"d" +
  "uval_appraiser\"},\"fetched_at\":{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"last_sale_date\":{\"famil" +
  "y\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"last_sale_price\":{\"family\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"last_sal" +
  "e_source\":{\"family\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"last_sale_qual_cd\":{\"family\":\"sales\",\"sourceSystem\":\"f" +
  "dor_sdf\"},\"last_sale_or_book\":{\"family\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"last_sale_or_page\":{\"family\":\"sale" +
  "s\",\"sourceSystem\":\"fdor_sdf\"},\"sale_count\":{\"family\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"latitude\":{\"family\":\"" +
  "geometry\",\"sourceSystem\":\"fdor_par\"},\"longitude\":{\"family\":\"geometry\",\"sourceSystem\":\"fdor_par\"},\"coordinates_" +
  "source\":{\"family\":\"geometry\",\"sourceSystem\":\"fdor_par\"},\"exterior_wall_material\":{\"family\":\"structure\",\"source" +
  "System\":\"duval_pa_detail\"},\"roof_covering_material\":{\"family\":\"structure\",\"sourceSystem\":\"duval_pa_detail\"},\"t" +
  "otal_area\":{\"family\":\"structure\",\"sourceSystem\":\"duval_pa_detail\"},\"roof_structure\":{\"family\":\"structure\",\"sou" +
  "rceSystem\":\"duval_pa_detail\"},\"pa_actual_year_built\":{\"family\":\"structure\",\"sourceSystem\":\"duval_pa_detail\"},\"" +
  "pa_building_count\":{\"family\":\"structure\",\"sourceSystem\":\"duval_pa_detail\"},\"has_permits\":{\"family\":\"permit\",\"s" +
  "ourceSystem\":\"coj_jaxepics\"},\"permit_count\":{\"family\":\"permit\",\"sourceSystem\":\"coj_jaxepics\"},\"roof_permit_cou" +
  "nt\":{\"family\":\"permit\",\"sourceSystem\":\"coj_jaxepics\"},\"last_roof_permit_year\":{\"family\":\"permit\",\"sourceSystem" +
  "\":\"coj_jaxepics\"},\"last_roof_permit_date\":{\"family\":\"permit\",\"sourceSystem\":\"coj_jaxepics\"},\"last_permit_date\"" +
  ":{\"family\":\"permit\",\"sourceSystem\":\"coj_jaxepics\"},\"has_sunbiz_tenant\":{\"family\":\"business\",\"sourceSystem\":\"su" +
  "nbiz\"},\"sunbiz_business_count\":{\"family\":\"business\",\"sourceSystem\":\"sunbiz\"},\"has_bbb_contractor\":{\"family\":\"c" +
  "ontractor\",\"sourceSystem\":\"dbpr_cilb\"},\"nearest_transit_stop_m\":{\"family\":\"transit\",\"sourceSystem\":\"jta_gtfs\"}" +
  ",\"nearest_transit_stop_id\":{\"family\":\"transit\",\"sourceSystem\":\"jta_gtfs\"},\"nearest_transit_stop_name\":{\"family" +
  "\":\"transit\",\"sourceSystem\":\"jta_gtfs\"},\"nearest_transit_route_types\":{\"family\":\"transit\",\"sourceSystem\":\"jta_g" +
  "tfs\"},\"nearest_transit_routes\":{\"family\":\"transit\",\"sourceSystem\":\"jta_gtfs\"},\"near_transit_800m\":{\"family\":\"t" +
  "ransit\",\"sourceSystem\":\"jta_gtfs\"},\"nearest_starbucks_m\":{\"family\":\"places\",\"sourceSystem\":\"overture_places\"}," +
  "\"nearest_starbucks_id\":{\"family\":\"places\",\"sourceSystem\":\"overture_places\"},\"nearest_starbucks_name\":{\"family\"" +
  ":\"places\",\"sourceSystem\":\"overture_places\"},\"near_starbucks_800m\":{\"family\":\"places\",\"sourceSystem\":\"overture_" +
  "places\"},\"water_view_flag\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"water_view_major_flag\":{\"f" +
  "amily\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"water_dist_m\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_" +
  "hydrography\"},\"water_body_name\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"water_body_type\":{\"fa" +
  "mily\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"water_basis\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_hy" +
  "drography\"},\"fld_zone\":{\"family\":\"parcel_layer\",\"sourceSystem\":\"coj_parcels\"},\"zoning\":{\"family\":\"parcel_layer" +
  "\",\"sourceSystem\":\"coj_parcels\"},\"coj_last_sale_date\":{\"family\":\"parcel_layer\",\"sourceSystem\":\"coj_parcels\"},\"s" +
  "ubdivision\":{\"family\":\"address\",\"sourceSystem\":\"coj_address_points\"},\"address_point_count\":{\"family\":\"address\"" +
  ",\"sourceSystem\":\"coj_address_points\"},\"source_systems\":{\"family\":\"derived\",\"sourceSystem\":null},\"roof_year_est" +
  "\":{\"family\":\"derived\",\"sourceSystem\":null},\"roof_age_basis\":{\"family\":\"derived\",\"sourceSystem\":null},\"roof_age" +
  "_years\":{\"family\":\"derived\",\"sourceSystem\":null},\"last_sale_date_any\":{\"family\":\"derived\",\"sourceSystem\":null}" +
  ",\"tenure_basis\":{\"family\":\"derived\",\"sourceSystem\":null},\"tenure_quality\":{\"family\":\"derived\",\"sourceSystem\":null},\"tenure_date_check\":{\"family\":\"derived\",\"sourceSystem\":null},\"tenure_source\":{\"family\":\"derived\",\"sourceSystem\":nu" +
  "ll},\"has_sale_on_record\":{\"family\":\"derived\",\"sourceSystem\":null},\"years_since_last_sale\":{\"family\":\"derived\"," +
  "\"sourceSystem\":null},\"no_sale_10y_flag\":{\"family\":\"derived\",\"sourceSystem\":null},\"property_cid\":{\"family\":\"pip" +
  "eline\",\"sourceSystem\":null},\"features_run_id\":{\"family\":\"pipeline\",\"sourceSystem\":null},\"features_as_of\":{\"fam" +
  "ily\":\"pipeline\",\"sourceSystem\":null},\"run_id\":{\"family\":\"pipeline\",\"sourceSystem\":null},\"avm_value\":{\"family\":" +
  "\"placeholder\",\"sourceSystem\":null},\"hoa_flag\":{\"family\":\"placeholder\",\"sourceSystem\":null},\"appraisal_source\":" +
  "{\"family\":\"appraisal\",\"sourceSystem\":\"duval_appraiser\"},\"appraisal_fetched_at\":{\"family\":\"appraisal\",\"sourceSy" +
  "stem\":\"duval_appraiser\"},\"sales_source\":{\"family\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"sales_fetched_at\":{\"fami" +
  "ly\":\"sales\",\"sourceSystem\":\"fdor_sdf\"},\"geometry_source\":{\"family\":\"geometry\",\"sourceSystem\":\"fdor_par\"},\"geom" +
  "etry_fetched_at\":{\"family\":\"geometry\",\"sourceSystem\":\"fdor_par\"},\"structure_source\":{\"family\":\"structure\",\"sou" +
  "rceSystem\":\"duval_pa_detail\"},\"structure_fetched_at\":{\"family\":\"structure\",\"sourceSystem\":\"duval_pa_detail\"},\"" +
  "permit_source\":{\"family\":\"permit\",\"sourceSystem\":\"coj_jaxepics\"},\"permit_fetched_at\":{\"family\":\"permit\",\"sourc" +
  "eSystem\":\"coj_jaxepics\"},\"business_source\":{\"family\":\"business\",\"sourceSystem\":\"sunbiz\"},\"business_fetched_at\"" +
  ":{\"family\":\"business\",\"sourceSystem\":\"sunbiz\"},\"contractor_source\":{\"family\":\"contractor\",\"sourceSystem\":\"dbpr" +
  "_cilb\"},\"contractor_fetched_at\":{\"family\":\"contractor\",\"sourceSystem\":\"dbpr_cilb\"},\"transit_source\":{\"family\":" +
  "\"transit\",\"sourceSystem\":\"jta_gtfs\"},\"transit_fetched_at\":{\"family\":\"transit\",\"sourceSystem\":\"jta_gtfs\"},\"plac" +
  "es_source\":{\"family\":\"places\",\"sourceSystem\":\"overture_places\"},\"places_fetched_at\":{\"family\":\"places\",\"source" +
  "System\":\"overture_places\"},\"water_source\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"water_fetch" +
  "ed_at\":{\"family\":\"water\",\"sourceSystem\":\"coj_nhd_hydrography\"},\"parcel_layer_source\":{\"family\":\"parcel_layer\"," +
  "\"sourceSystem\":\"coj_parcels\"},\"parcel_layer_fetched_at\":{\"family\":\"parcel_layer\",\"sourceSystem\":\"coj_parcels\"}" +
  ",\"address_source\":{\"family\":\"address\",\"sourceSystem\":\"coj_address_points\"},\"address_fetched_at\":{\"family\":\"add" +
  "ress\",\"sourceSystem\":\"coj_address_points\"}}}";

const FAMILY_KEYS = SOURCE_FAMILIES.map((family) => family.key);
const SPINE = new Set<string>([...SPINE_PROVENANCE_COLUMNS]);

/** The columns the grid actually renders: the collapse hides the three spine columns. */
function displayColumnsOf(columns: string[]): string[] {
  return columns.filter((column) => !SPINE.has(column));
}

function systemsOf(sources: RowSource[]): string[] {
  return sources.filter((source) => source.kind === "system").map((source) => source.system);
}

function entryFor(sources: RowSource[], system: string): RowSource | undefined {
  return sources.find((source) => source.kind === "system" && source.system === system);
}

let map: ColumnProvenanceMap;
let db: PropertyDb;

beforeAll(async () => {
  const parsed = parseColumnProvenance(PUBLISHED_COLUMN_PROVENANCE);
  expect(parsed, "the published map must parse").not.toBeNull();
  map = parsed as ColumnProvenanceMap;
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("the map the artifact publishes", () => {
  it("carries a family for every column the sample parquet publishes", async () => {
    const result = await db.query("SELECT * FROM properties LIMIT 1");
    const unmapped = result.columns.filter((column) => map.columns[column] === undefined);
    expect(unmapped, "columns the published map does not place in a family").toEqual([]);
    // 133 since tenure_quality and tenure_date_check were published: the demotion the tenure card
    // applies now ships in the data, so an MCP client inherits it instead of seeing raw sentinels.
    expect(result.columns.length).toBe(133);
  });

  it("declares a source column and a fetch column for each fetched family", () => {
    const fetched = Object.values(map.families).filter((family) => family.sourceSystem !== null);
    expect(fetched.length).toBe(12);
    for (const family of fetched) {
      expect(family.sourceColumn, family.key).toBe(`${family.key}_source`);
      expect(family.fetchedAtColumn, family.key).toBe(`${family.key}_fetched_at`);
    }
    // The families this pipeline computes name no system, and must not be given one.
    for (const key of ["derived", "pipeline", "placeholder"]) {
      expect(map.families[key]?.sourceSystem, key).toBeNull();
      expect(map.families[key]?.sourceColumn, key).toBeNull();
    }
  });

  it("knows every system name the artifact uses, and only those", () => {
    expect([...map.systems].sort()).toEqual([
      "coj_address_points",
      "coj_jaxepics",
      "coj_nhd_hydrography",
      "coj_parcels",
      "dbpr_cilb",
      "duval_appraiser",
      "duval_pa_detail",
      "fdor_par",
      "fdor_sdf",
      "jta_gtfs",
      "overture_places",
      "sunbiz",
    ]);
  });

  it("refuses anything it cannot trust rather than half reading it", () => {
    expect(parseColumnProvenance(null)).toBeNull();
    expect(parseColumnProvenance("")).toBeNull();
    expect(parseColumnProvenance("not json")).toBeNull();
    expect(parseColumnProvenance("[]")).toBeNull();
    expect(parseColumnProvenance('{"families":[],"columns":{}}')).toBeNull();
    expect(parseColumnProvenance('{"families":[{"key":"a"}]}')).toBeNull();
  });
});

describe("a preset row names the systems behind the values it shows", () => {
  /**
   * The two proximity questions are the sharp cases the reviewer named: the distance on screen is
   * Overture's and the JTA's work, and the cell credited the county property appraiser for it.
   */
  it.each([
    ["near-starbucks", "nearest_starbucks_m", "overture_places"],
    ["near-transit", "nearest_transit_stop_m", "jta_gtfs"],
    ["water-view", "water_dist_m", "coj_nhd_hydrography"],
  ])("%s attributes %s to %s and not to the roll", async (id, evidence, expected) => {
    const preset = PRESETS.find((entry) => entry.id === id);
    expect(preset, id).toBeDefined();
    const result = await db.query(preset!.sql(5));
    expect(result.rows.length).toBeGreaterThan(0);

    const columns = displayColumnsOf(result.columns);
    const sources = rowSources(map, columns, result.rows[0]);

    // The bug: one badge, reading source_system, for a row spanning several families.
    expect(systemsOf(sources).length).toBeGreaterThan(1);
    expect(systemsOf(sources)).toContain(expected);

    // The evidence column is credited to the system that produced it, and to no other.
    const owner = entryFor(sources, expected);
    expect(owner?.columns, `${evidence} must be attributed to ${expected}`).toContain(evidence);
    for (const source of sources) {
      if (source === owner) continue;
      expect(source.columns, `${source.system || source.kind} must not claim ${evidence}`).not.toContain(
        evidence,
      );
    }
  });

  it("credits the parcel centroid to the shapefile, not to the roll it sits beside", async () => {
    const preset = PRESETS.find((entry) => entry.id === "near-starbucks");
    const result = await db.query(preset!.sql(5));
    const sources = rowSources(map, displayColumnsOf(result.columns), result.rows[0]);

    const geometry = entryFor(sources, "fdor_par");
    expect(geometry?.columns).toEqual(expect.arrayContaining(["latitude", "longitude"]));

    const roll = entryFor(sources, "duval_appraiser");
    expect(roll?.columns).toEqual(expect.arrayContaining(["property_id", "address_street"]));
    expect(roll?.columns).not.toContain("latitude");
    expect(roll?.columns).not.toContain("nearest_starbucks_m");
  });

  it("lets a derived column name its own system through tenure_source", async () => {
    const preset = PRESETS.find((entry) => entry.id === "no-sale-10-years");
    const result = await db.query(preset!.sql(5));
    const row = result.rows[0];
    const sources = rowSources(map, displayColumnsOf(result.columns), row);

    /*
     * tenure_source sits in the `derived` family because the pipeline computes the tenure date, but
     * its value is the system that actually published that date. Reading it is what keeps the
     * ownership question from crediting the appraisal roll for a City of Jacksonville sale record.
     */
    const named = String(row.tenure_source);
    expect(map.systems.has(named), `${named} should be a system the artifact declares`).toBe(true);
    expect(systemsOf(sources)).toContain(named);
    expect(named).not.toBe(String(row.source_system));
  });

  it("marks pipeline-derived values as derived instead of crediting a system", async () => {
    const preset = PRESETS.find((entry) => entry.id === "roof-older-than-15");
    const result = await db.query(preset!.sql(5));
    const sources = rowSources(map, displayColumnsOf(result.columns), result.rows[0]);

    const derived = sources.find((source) => source.kind === "derived");
    expect(derived?.columns).toEqual(expect.arrayContaining(["roof_year_est", "roof_age_basis"]));
    // built_year is the roll's own column and must stay with the roll.
    expect(entryFor(sources, "duval_appraiser")?.columns).toContain("built_year");
    expect(derived?.columns).not.toContain("built_year");
  });

  it("never collapses a multi family row to the spine alone", async () => {
    for (const preset of PRESETS) {
      const result = await db.query(preset.sql(5));
      if (result.rows.length === 0) continue;
      const columns = displayColumnsOf(result.columns);
      const row = result.rows[0];
      const sources = rowSources(map, columns, row);

      const families = new Set(
        columns
          .filter((column) => row[column] !== null && row[column] !== undefined)
          .map((column) => map.columns[column])
          .filter((family): family is string => family !== undefined),
      );
      expect(sources.length, `${preset.id} produced no provenance at all`).toBeGreaterThan(0);
      // One entry per family is the floor: the cell must not lose a family it displayed.
      expect(
        sources.length,
        `${preset.id} shows ${families.size} families but names ${sources.length} sources`,
      ).toBeGreaterThanOrEqual(Math.min(families.size, 2));
    }
  });
});

describe("each source carries its own fetch time", () => {
  /** The epoch a reviewer photographed in a provenance cell, and the instant it stands for. */
  const SPINE_EPOCH_MS = 1787320736294;

  const row = {
    property_id: "0707810100R",
    nearest_starbucks_m: 412,
    source_system: "duval_appraiser",
    fetched_at: SPINE_EPOCH_MS,
    places_source: "overture_places",
    places_fetched_at: "2026-08-21 18:35:49.38",
  };

  it("dates the roll by fetched_at and Overture by its own column", () => {
    const sources = rowSources(map, ["property_id", "nearest_starbucks_m"], row);

    const roll = entryFor(sources, "duval_appraiser");
    expect(formatTimestampShort(roll?.fetchedAt)).toBe("2026-08-21 13:58Z");

    const places = entryFor(sources, "overture_places");
    expect(formatTimestampShort(places?.fetchedAt)).toBe("2026-08-21 18:35Z");
  });

  it("does not lend the roll's clock to a system that published at another time", () => {
    const sources = rowSources(map, ["property_id", "nearest_starbucks_m"], {
      ...row,
      places_fetched_at: null,
    });
    // No time for Overture on this row is honest; the roll's time would be a fabrication.
    expect(entryFor(sources, "overture_places")?.fetchedAt).toBeNull();
    expect(entryFor(sources, "duval_appraiser")?.fetchedAt).toBe(SPINE_EPOCH_MS);
  });

  it("puts the spine first so the row still reads from the key it is joined on", () => {
    const sources = rowSources(map, ["nearest_starbucks_m", "property_id"], row);
    expect(sources[0]?.system).toBe("duval_appraiser");
  });
});

describe("a source column that is not a source", () => {
  it("does not read last_sale_source as a system", () => {
    /*
     * last_sale_source ends in _source like every family source column, but it names which column
     * inside the sales family supplied the date ("SDF", "PA_DETAIL"), not who published it. Reading
     * it as a system would put a badge on screen that no source system is called.
     */
    const sources = rowSources(map, ["last_sale_date", "last_sale_source"], {
      last_sale_date: "2019-04-01",
      last_sale_source: "SDF",
      sales_source: "fdor_sdf",
      sales_fetched_at: "2026-08-21 12:00:00",
      source_system: "duval_appraiser",
    });
    expect(systemsOf(sources)).toEqual(["fdor_sdf"]);
    expect(systemsOf(sources)).not.toContain("SDF");
  });

  it("reports a value whose family names no system rather than guessing one", () => {
    const sources = rowSources(map, ["subdivision"], {
      subdivision: "SAN MARCO",
      address_source: null,
      source_system: "duval_appraiser",
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("unattributed");
    expect(sources[0].columns).toEqual(["subdivision"]);
  });

  it("says nothing about a column the artifact never named", () => {
    const sources = rowSources(map, ["some_workbench_alias"], {
      some_workbench_alias: 12,
      source_system: "duval_appraiser",
    });
    expect(sources).toEqual([]);
  });
});

describe("an artifact with no published map", () => {
  /**
   * The generated sample parquet carries all 131 columns and no KV metadata, and it is what every
   * e2e run and every unconfigured deployment reads. Without a fallback the sample would show the
   * single spine badge that is the bug being fixed.
   */
  it.each([
    ["near-starbucks", "overture_places"],
    ["near-transit", "jta_gtfs"],
    ["water-view", "coj_nhd_hydrography"],
    ["no-sale-10-years", "coj_parcels"],
  ])("%s still names %s from the row's own source columns", async (id, expected) => {
    const preset = PRESETS.find((entry) => entry.id === id);
    const result = await db.query(preset!.sql(5));
    const sources = fallbackRowSources(
      FAMILY_KEYS,
      displayColumnsOf(result.columns),
      result.rows[0],
    );
    expect(systemsOf(sources)).toContain("duval_appraiser");
    expect(systemsOf(sources)).toContain(expected);
    expect(sources[0].system).toBe("duval_appraiser");
  });

  it("uses source_systems verbatim when the query selected it", () => {
    const sources = fallbackRowSources(FAMILY_KEYS, ["property_id"], {
      property_id: "1",
      source_system: "duval_appraiser",
      source_systems: "coj_parcels,duval_appraiser,jta_gtfs,overture_places",
    });
    expect(systemsOf(sources)).toEqual([
      "duval_appraiser",
      "coj_parcels",
      "jta_gtfs",
      "overture_places",
    ]);
  });

  it("returns nothing when the row names no system at all", () => {
    expect(fallbackRowSources(FAMILY_KEYS, ["property_id"], { property_id: "1" })).toEqual([]);
    expect(rowSources(null, ["property_id"], { property_id: "1" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * The Agent page's evidence table
 * ------------------------------------------------------------------------- */

/**
 * The agent's evidence rows are NOT preset rows, and that is what made this the surface the fix
 * missed. lib/agent/tools.ts strips every provenance column out of the matched set before an
 * evidence row is built (SKIP_IN_EVIDENCE spreads PROVENANCE_COLUMNS), so an evidence row carries
 * the three spine columns and nothing else that names a system. `fallbackRowSources` therefore has
 * nothing to work with on this surface: the published column to family map is the ONLY thing that
 * can say a walking distance came from Overture, which is why the Agent page reads the same map the
 * results grid does instead of printing `row.source_system` on its own.
 *
 * The rows are produced by running the real agent tool over the sample parquet, not written by
 * hand, so a change to what the tool puts in an evidence row shows up here.
 */
describe("the agent's evidence rows name the systems behind their values", () => {
  /** Mirrors EvidenceTable in app/agent/page.tsx: meta columns are the source cell, not data. */
  const EVIDENCE_META = new Set([
    "property_id",
    "address",
    "source_system",
    "source_url",
    "fetched_at",
    "via",
  ]);
  const EVIDENCE_COLUMN_CAP = 14;

  function evidenceRowsFor(name: PresetName): Promise<AgentEvidenceRow[]> {
    const trace = newTrace();
    const tools = createAgentTools({ db, env: {} }, trace);
    const execute = tools.preset_question.execute as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    return execute({ name, limit: 5 }, { toolCallId: "test", messages: [] } as never).then(
      () => trace.evidence,
    );
  }

  /** The columns the Agent page actually renders, and therefore claims provenance for. */
  function displayedColumns(rows: AgentEvidenceRow[]): string[] {
    const matched = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!EVIDENCE_META.has(key)) matched.add(key);
    }
    return ["property_id", ...[...matched].slice(0, EVIDENCE_COLUMN_CAP)];
  }

  it.each([
    ["near_starbucks", "nearest_starbucks_m", "overture_places"],
    ["near_transit", "nearest_transit_stop_m", "jta_gtfs"],
    ["water_view", "water_dist_m", "coj_nhd_hydrography"],
  ] as [PresetName, string, string][])(
    "%s credits %s to %s rather than to the appraisal roll",
    async (name, evidence, expected) => {
      const rows = await evidenceRowsFor(name);
      expect(rows.length, `${name} produced no evidence`).toBeGreaterThan(0);

      const columns = displayedColumns(rows);
      expect(columns, `${name} does not show ${evidence}`).toContain(evidence);

      const sources = rowSources(map, columns, rows[0]);
      // The defect: one badge reading source_system, which is duval_appraiser on every row.
      expect(systemsOf(sources).length).toBeGreaterThan(1);
      expect(systemsOf(sources)).toContain(expected);
      expect(entryFor(sources, expected)?.columns).toContain(evidence);
      expect(entryFor(sources, "duval_appraiser")?.columns).not.toContain(evidence);
      // The spine still reads first: the row is keyed on the roll and says so.
      expect(sources[0]?.system).toBe("duval_appraiser");
    },
  );

  it("carries no per family source column, so the map is the only attribution it has", async () => {
    const rows = await evidenceRowsFor("near_starbucks");
    const familySourceColumns = FAMILY_KEYS.map((family) => `${family}_source`);
    for (const column of [...familySourceColumns, "source_systems", "tenure_source"]) {
      expect(Object.keys(rows[0]), `evidence unexpectedly carries ${column}`).not.toContain(column);
    }
    // Which is exactly why the fallback cannot help here, and must not be mistaken for coverage.
    const columns = displayedColumns(rows);
    expect(systemsOf(fallbackRowSources(FAMILY_KEYS, columns, rows[0]))).toEqual([
      "duval_appraiser",
    ]);
  });

  it("resolves a row that carries only a couple of family columns", () => {
    /*
     * A get_property or count_criteria answer can put two columns on a row. The cell has to name
     * the systems behind those two and claim nothing else, rather than needing a full preset row.
     */
    const sources = rowSources(map, ["property_id", "nearest_transit_stop_m", "zoning"], {
      property_id: "0707810100R",
      address: "1 MAIN ST, JACKSONVILLE",
      nearest_transit_stop_m: 214,
      zoning: "RLD-60",
      source_system: "duval_appraiser",
      source_url: "https://example.invalid/roll",
      fetched_at: "2026-08-21T13:58:56Z",
      via: "preset_question:near-transit",
    });
    expect(systemsOf(sources)).toEqual(["duval_appraiser", "coj_parcels", "jta_gtfs"]);
    expect(entryFor(sources, "jta_gtfs")?.columns).toEqual(["nearest_transit_stop_m"]);
    expect(entryFor(sources, "coj_parcels")?.columns).toEqual(["zoning"]);
    expect(entryFor(sources, "duval_appraiser")?.columns).toEqual(["property_id"]);
  });

  it("does not attribute the row's own meta columns to anyone", () => {
    /*
     * `address` and `via` are the Agent page's own fields, not published columns: `address` is
     * joined from three roll columns by the tool and `via` names the tool that returned the row.
     * The map has never heard of either, and inventing a source for them would be the same class of
     * false claim this whole module exists to stop.
     */
    const sources = rowSources(map, ["address", "via"], {
      address: "1 MAIN ST, JACKSONVILLE",
      via: "run_sql",
      source_system: "duval_appraiser",
    });
    expect(sources).toEqual([]);
  });
});
