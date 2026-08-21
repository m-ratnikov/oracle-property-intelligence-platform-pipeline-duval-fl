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

export const PROVENANCE_COLUMNS = ["source_system", "source_url", "fetched_at", "run_id"] as const;

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
    description: "Derived. roof_age_basis names the evidence behind roof_year_est.",
    columns: ["roof_year_est", "roof_age_basis"],
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
    description: "Owner of record plus the derived region class used by the regional owner question.",
    columns: [
      "owner_name",
      "owners_text",
      "owner_count",
      "owner_occupied",
      "owner_region_class",
      "hoa_flag",
    ],
  },
  {
    title: "Sales",
    description: "Most recent recorded transfer, and how long ago that was.",
    columns: ["last_sale_date", "last_sale_price", "years_since_last_sale"],
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
    description: "Where this row came from and when it was collected.",
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

/** Columns the pipeline adds beyond the canonical contract. */
export const EXTRA_COLUMNS = [
  "years_since_last_sale",
  "owner_region_class",
  "roof_year_est",
  "roof_age_basis",
  "water_view_flag",
  "water_dist_m",
  "water_basis",
  "nearest_transit_stop_m",
  "nearest_transit_stop_name",
  "nearest_starbucks_m",
  "nearest_starbucks_name",
  "source_url",
  "fetched_at",
  "run_id",
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
