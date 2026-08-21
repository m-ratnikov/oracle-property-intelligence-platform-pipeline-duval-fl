/**
 * How the query table columns are grouped for the property detail page, and
 * which of them the UI treats as provenance.
 *
 * The canonical 37 columns come from the Elephant query table export. The
 * pipeline adds derived columns on top; anything not listed here still renders,
 * under "Other published columns", so a new pipeline column never goes missing
 * just because the UI has not been taught about it.
 */

export interface ColumnGroup {
  title: string;
  description: string;
  columns: string[];
}

/**
 * The families the pipeline publishes a `<key>_source` / `<key>_fetched_at` pair for.
 *
 * Mirrors SOURCE_FAMILIES in pipeline/src/features/build.ts. Order matters only for display.
 */
export const SOURCE_FAMILIES = [
  { key: "appraisal", label: "FDOR NAL tax roll (Duval property appraiser)" },
  { key: "sales", label: "FDOR SDF sales data file and the roll's own sale columns" },
  { key: "geometry", label: "FDOR PAR parcel shapefile" },
  { key: "structure", label: "Duval Property Appraiser detail pages" },
  { key: "permit", label: "City of Jacksonville JaxEPICS permits" },
  { key: "business", label: "Florida Division of Corporations (Sunbiz)" },
  { key: "contractor", label: "Florida DBPR CILB licensees" },
  { key: "transit", label: "JTA GTFS static feed" },
  { key: "places", label: "Overture Maps places" },
  { key: "water", label: "COJ river polygons and USGS NHD hydrography" },
  { key: "parcel_layer", label: "COJ parcel layer" },
  { key: "address", label: "COJ address points (ERAT)" },
] as const;

export const FAMILY_PROVENANCE_COLUMNS = SOURCE_FAMILIES.flatMap((family) => [
  `${family.key}_source`,
  `${family.key}_fetched_at`,
]);

/**
 * Provenance, at two levels.
 *
 * source_system / source_url / fetched_at are the canonical Elephant columns and they describe the
 * APPRAISAL ROLL SPINE only. They are the same value on every row and they say nothing about where
 * a transit distance or a water flag came from. The per family pairs are what answer that, and
 * source_systems lists every system that put a value on the row.
 *
 * Both levels are listed here because both are provenance: the UI must not present the canonical
 * three as if they covered the whole row, which is what it did before the pipeline published the
 * family columns.
 */
export const PROVENANCE_COLUMNS = [
  "source_system",
  "source_url",
  "fetched_at",
  "run_id",
  "source_systems",
  ...FAMILY_PROVENANCE_COLUMNS,
] as const;

/** The three canonical columns every preset carries inline beside its evidence rows. */
export const SPINE_PROVENANCE_COLUMNS = ["source_system", "source_url", "fetched_at"] as const;

export const COLUMN_GROUPS: ColumnGroup[] = [
  {
    title: "Identity",
    description: "Keys that tie this row back to the county roll and to the IPFS artifacts.",
    columns: [
      "property_id",
      "property_cid",
      "request_identifier",
      "parcel_identifier",
      "county_name",
      "state_code",
    ],
  },
  {
    title: "Location",
    description: "Situs address and parcel centroid. This is the mailing address only when they match.",
    columns: ["address_street", "address_city", "address_zip", "latitude", "longitude", "subdivision"],
  },
  {
    title: "Structure",
    description: "What is built on the parcel, as recorded by the property appraiser.",
    columns: [
      "property_type",
      "property_usage_type",
      "built_year",
      "livable_floor_area",
      "total_area",
      "exterior_wall_material",
      "roof_covering_material",
    ],
  },
  {
    title: "Roof age",
    description:
      "Derived. roof_age_basis names what stands behind roof_year_est, and for this county that is the appraiser's effective year built on every row: no re-roof permit feed was harvested, so nothing here is a permit derived roof date.",
    columns: ["roof_year_est", "roof_age_basis", "roof_age_years"],
  },
  {
    title: "Land",
    description: "Parcel size as published.",
    columns: ["lot_size_acre", "lot_area_sqft"],
  },
  {
    title: "Valuation",
    description: "Appraisal roll values. Not a sale price and not an appraisal for lending.",
    columns: ["assessed_value", "market_value", "land_value", "avm_value"],
  },
  {
    title: "Ownership",
    description:
      "Owner of record, the mailing address the region class was computed from, and the class itself. owner_count is NULL on every row: the FDOR NAL roll publishes one 30 character owner name per parcel and no co-owner column, so has_additional_owners (the ET AL / ET UX marker) is the only multi owner signal the source has, and owners_text equals owner_name on every row.",
    columns: [
      "owner_name",
      "owners_text",
      "owner_count",
      "has_additional_owners",
      "owner_occupied",
      "owner_mailing_city",
      "owner_mailing_state",
      "owner_mailing_zip",
      "owner_region_class",
      "hoa_flag",
    ],
  },
  {
    title: "Sales and tenure",
    description:
      "last_sale_date_any is the date tenure is measured from: the later of the FDOR roll sale and the COJ recorded sale, with tenure_basis naming which column it came from and tenure_source naming the system. has_sale_on_record is what separates no transfer on record from a long hold. last_sale_date is the roll's own column and is NULL on 87 percent of parcels, because the roll and SDF cover only the two most recent transfers.",
    columns: [
      "last_sale_date_any",
      "tenure_basis",
      "tenure_source",
      "has_sale_on_record",
      "years_since_last_sale",
      "no_sale_10y_flag",
      "last_sale_date",
      "coj_last_sale_date",
      "last_sale_price",
      "sale_count",
    ],
  },
  {
    title: "Permits and businesses",
    description: "Cross dataset links reconciled by the pipeline.",
    columns: ["has_permits", "permit_count", "has_sunbiz_tenant", "has_bbb_contractor"],
  },
  {
    title: "Water",
    description: "Derived proximity to mapped water, the basis for the water view question.",
    columns: ["water_view_flag", "water_dist_m", "water_basis"],
  },
  {
    title: "Walkability",
    description: "Derived straight line distance from the parcel centroid to the nearest stop and store.",
    columns: [
      "nearest_transit_stop_m",
      "nearest_transit_stop_name",
      "nearest_starbucks_m",
      "nearest_starbucks_name",
    ],
  },
  {
    title: "Provenance",
    description:
      "source_system, source_url and fetched_at describe the appraisal roll spine only, not the enrichment columns. source_systems lists every system that contributed a value to this row, and each <family>_source / <family>_fetched_at pair says where one family of columns came from and when.",
    columns: [...PROVENANCE_COLUMNS],
  },
];

const GROUPED = new Set(COLUMN_GROUPS.flatMap((group) => group.columns));

export function ungroupedColumns(available: string[]): string[] {
  return available.filter((column) => !GROUPED.has(column)).sort();
}

/** The 37 canonical columns the Elephant query table contract requires. */
export const CANONICAL_COLUMNS = [
  "property_id",
  "property_cid",
  "request_identifier",
  "parcel_identifier",
  "source_system",
  "county_name",
  "state_code",
  "address_street",
  "address_city",
  "address_zip",
  "latitude",
  "longitude",
  "lot_size_acre",
  "lot_area_sqft",
  "exterior_wall_material",
  "roof_covering_material",
  "property_type",
  "property_usage_type",
  "built_year",
  "livable_floor_area",
  "total_area",
  "assessed_value",
  "market_value",
  "land_value",
  "avm_value",
  "owner_name",
  "owners_text",
  "owner_count",
  "owner_occupied",
  "last_sale_date",
  "last_sale_price",
  "subdivision",
  "has_permits",
  "permit_count",
  "has_sunbiz_tenant",
  "has_bbb_contractor",
  "hoa_flag",
] as const;

/**
 * Columns the pipeline adds beyond the canonical contract.
 *
 * This list is the UI's contract with the pipeline, not a description of it: the Data page reports
 * anything here that the published parquet does not carry, and tests/presets.test.ts fails when one
 * goes missing. Adding a column here is how the UI says it depends on it.
 */
export const EXTRA_COLUMNS = [
  "last_sale_date_any",
  "tenure_basis",
  "tenure_source",
  "has_sale_on_record",
  "no_sale_10y_flag",
  "coj_last_sale_date",
  "years_since_last_sale",
  "has_additional_owners",
  "owner_mailing_city",
  "owner_mailing_state",
  "owner_region_class",
  "roof_year_est",
  "roof_age_basis",
  "roof_age_years",
  "water_view_flag",
  "water_dist_m",
  "water_basis",
  "nearest_transit_stop_m",
  "nearest_transit_stop_name",
  "nearest_starbucks_m",
  "nearest_starbucks_name",
  ...PROVENANCE_COLUMNS.filter((column) => column !== "source_system"),
] as const;

export const ALL_EXPECTED_COLUMNS = [...CANONICAL_COLUMNS, ...EXTRA_COLUMNS];

/** Money columns render as USD, distances as metres, everything else raw. */
export const CURRENCY_COLUMNS = new Set([
  "assessed_value",
  "market_value",
  "land_value",
  "avm_value",
  "last_sale_price",
]);

export const METRE_COLUMNS = new Set([
  "water_dist_m",
  "nearest_transit_stop_m",
  "nearest_starbucks_m",
]);
