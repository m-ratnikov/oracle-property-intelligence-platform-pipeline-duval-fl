/**
 * What the agent is told about the table: one line per column and the six
 * question rules in plain English. The column list mirrors lib/columns.ts;
 * the rules mirror the presets in lib/sql.ts, so the agent and the Questions
 * page describe the same thing.
 */

import {
  OWNERSHIP_HOLD_YEARS,
  PRESETS,
  ROOF_AGE_YEARS,
  WALK_DISTANCE_M,
  type QuestionPreset,
} from "@/lib/sql";
import { ALL_EXPECTED_COLUMNS, PROVENANCE_COLUMNS } from "@/lib/columns";

export const COLUMN_MEANINGS: Record<string, string> = {
  property_id: "Primary key. The county folio / parcel number as published by the appraiser.",
  property_cid: "IPFS CID of the per property JSON in the open data artifact.",
  request_identifier: "Elephant request identifier, equal to the folio for this county.",
  parcel_identifier: "Parcel identifier on the roll; usually the same as property_id.",
  county_name: "Always Duval.",
  state_code: "Always FL.",
  address_street: "Situs (physical) street address, not the mailing address.",
  address_city: "Situs city.",
  address_zip: "Situs ZIP code.",
  latitude: "Parcel centroid latitude (WGS84) from the county address points.",
  longitude: "Parcel centroid longitude (WGS84).",
  subdivision: "Subdivision name from the roll.",
  property_type: "Broad property class from the DOR use code.",
  property_usage_type: "Finer use description from the DOR use code.",
  built_year: "Year the main structure was built, as recorded by the appraiser.",
  livable_floor_area: "Heated / living area in square feet.",
  total_area: "Total building area in square feet.",
  exterior_wall_material: "Exterior wall material as recorded by the appraiser.",
  roof_covering_material: "Roof cover material as recorded by the appraiser.",
  roof_year_est:
    "DERIVED. Best estimate of the year the current roof went on. See roof_age_basis for where it came from.",
  roof_age_basis:
    "DERIVED. Evidence behind roof_year_est: a re-roof permit (PERMIT), an appraiser roof field (APPRAISER), or the year built used as a proxy (EFF_YR_BLT_PROXY / year_built_proxy). A proxy basis means no roof date exists in county data.",
  lot_size_acre: "Lot size in acres.",
  lot_area_sqft: "Lot area in square feet.",
  assessed_value: "Assessed value on the roll, USD.",
  market_value: "Just / market value on the roll, USD.",
  land_value: "Land value on the roll, USD.",
  avm_value: "Automated valuation if published, USD. Often null.",
  owner_name: "Primary owner of record.",
  owners_text: "All owners of record, concatenated.",
  owner_count: "Number of owners of record.",
  owner_occupied: "True when the mailing address matches the situs address.",
  owner_region_class:
    "DERIVED. Owner mailing address classified against the parcel: LOCAL (in county), REGIONAL (elsewhere in FL/GA/SC/AL), NATIONAL (rest of US), FOREIGN, or null when no mailing address.",
  hoa_flag: "Null placeholder in the Elephant contract; never populated.",
  last_sale_date: "Date of the most recent recorded transfer for the folio.",
  last_sale_price: "Price of that transfer, USD.",
  years_since_last_sale:
    "DERIVED. Whole years between last_sale_date and the pipeline run. Null when no sale is recorded.",
  has_permits: "True when at least one building permit was reconciled to the folio.",
  permit_count: "Number of reconciled permits.",
  has_sunbiz_tenant: "True when a Sunbiz business entity was matched to the address.",
  has_bbb_contractor: "True when a BBB listed contractor was matched to the address.",
  water_view_flag:
    "DERIVED. True when the parcel centroid is within the water proximity threshold of a mapped water body. A proximity proxy, not line of sight.",
  water_dist_m: "DERIVED. Metres from the parcel centroid to the nearest mapped water body.",
  water_basis: "DERIVED. Method and source behind water_view_flag.",
  nearest_transit_stop_m:
    "DERIVED. Great circle metres from the parcel centroid to the nearest published transit stop. Null means the transit feed was not loaded for this parcel yet.",
  nearest_transit_stop_name: "DERIVED. Name of that nearest stop.",
  nearest_starbucks_m:
    "DERIVED. Great circle metres from the parcel centroid to the nearest Starbucks in the places table. Null means the places source was not loaded for this parcel yet.",
  nearest_starbucks_name: "DERIVED. Name of that nearest Starbucks place.",
  source_system: "PROVENANCE. Which source system the row was built from (for example duval_appraiser).",
  source_url: "PROVENANCE. URL of the county record or dataset the row was built from.",
  fetched_at: "PROVENANCE. When the pipeline fetched the row from the source.",
  run_id: "PROVENANCE. The pipeline run that last touched the row.",
};

export function describeColumn(column: string): string {
  return COLUMN_MEANINGS[column] ?? "Published by the pipeline; not documented in the UI yet.";
}

export const PROVENANCE = [...PROVENANCE_COLUMNS];
export const EXPECTED_COLUMNS = [...ALL_EXPECTED_COLUMNS];

/** Tool facing names for the presets, stable and snake_case. */
export const PRESET_NAMES = {
  roof_over_15: "roof-older-than-15",
  water_view: "water-view",
  no_sale_10y: "no-sale-10-years",
  regional_owner: "regional-owners",
  near_transit: "near-transit",
  near_starbucks: "near-starbucks",
  roof15_and_no_sale10y: "roof-and-long-hold",
  transit_and_regional: "transit-and-regional",
} as const;

export type PresetName = keyof typeof PRESET_NAMES;
export const PRESET_NAME_LIST = Object.keys(PRESET_NAMES) as PresetName[];

export function presetFor(name: PresetName): QuestionPreset {
  const id = PRESET_NAMES[name];
  const preset = PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`preset ${name} (${id}) is not defined in lib/sql.ts`);
  return preset;
}

export interface RuleDescription {
  name: PresetName;
  question: string;
  rule: string;
  evidence_columns: string[];
  assumptions: string[];
}

export function ruleDescriptions(): RuleDescription[] {
  return PRESET_NAME_LIST.map((name) => {
    const preset = presetFor(name);
    return {
      name,
      question: preset.question,
      rule: preset.rule,
      evidence_columns: preset.evidence,
      assumptions: preset.assumptions,
    };
  });
}

export const THRESHOLDS = {
  roof_age_years: ROOF_AGE_YEARS,
  ownership_hold_years: OWNERSHIP_HOLD_YEARS,
  walk_distance_m: WALK_DISTANCE_M,
} as const;
