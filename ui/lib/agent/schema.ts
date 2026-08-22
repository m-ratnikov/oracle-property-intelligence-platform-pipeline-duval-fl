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
import {
  ALL_EXPECTED_COLUMNS,
  PROVENANCE_COLUMNS,
  SOURCE_FAMILIES,
  SPINE_PROVENANCE_COLUMNS,
} from "@/lib/columns";

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
  latitude: "Parcel centroid latitude (WGS84), computed from the FDOR parcel polygons, not a rooftop point.",
  longitude: "Parcel centroid longitude (WGS84), same basis as latitude.",
  coordinates_source: "Which layer the centroid came from (parcel polygons, not rooftop points).",
  subdivision: "Subdivision name from the roll.",
  property_type: "Broad property class from the DOR use code.",
  property_usage_type: "Finer use description from the DOR use code.",
  built_year: "Year the main structure was built, as recorded by the appraiser.",
  livable_floor_area: "Heated / living area in square feet.",
  roof_year_est:
    "DERIVED. Best estimate of the year the current roof went on. On every published row it is a PROXY, not a roof date: roof_age_basis is EFF_YR_BLT_PROXY on all 359,129 rows that have a value and PERMIT on none, so this is the appraiser's effective year built standing in. Always read roof_age_basis beside it.",
  roof_age_basis:
    "DERIVED. Evidence behind roof_year_est. Measured on the published artifact: EFF_YR_BLT_PROXY on 359,129 of 404,023 rows and NULL on the other 44,894. PERMIT appears on ZERO published rows, so no roof date here comes from a re-roof permit, and ACT_YR_BLT_PROXY appears on ZERO rows as well, because eff_year_built is populated on exactly the 359,129 rows that have a roof year at all and the actual-year-built fallback is never reached. Every published roof year is therefore the appraiser's effective year built standing in, which over states roof age. Do not describe a basis this data does not contain.",
  roof_age_years:
    "DERIVED. Whole years between roof_year_est and the pipeline run date. Inherits the proxy caveat above.",
  roof_covering_material:
    "From the Duval Property Appraiser detail pages, a slow US-egress-only source pulled in bounded windows, so it covers only the parcels visited so far: non null on 930 of 404,023 published rows (0.23 percent). Do not cite it as evidence.",
  exterior_wall_material:
    "From the appraiser detail pages, same bounded window caveat: non null on 930 of 404,023 published rows (0.23 percent).",
  total_area:
    "From the appraiser detail pages, same bounded window caveat: non null on 930 of 404,023 published rows (0.23 percent). Use livable_floor_area, which the roll publishes directly.",
  lot_size_acre: "Lot size in acres.",
  lot_area_sqft: "Lot area in square feet.",
  assessed_value: "Assessed value on the roll, USD.",
  market_value: "Just / market value on the roll, USD.",
  land_value: "Land value on the roll, USD.",
  avm_value: "Always NULL. No automated valuation is published for Duval.",
  owner_name:
    "Owner of record, truncated by the source to 30 characters. An ET AL or ET UX suffix is the roll's only additional owner signal.",
  owners_text:
    "OWN_NAME, plus 'c/o ' and FIDU_NAME when the roll names a fiduciary. FIDU_NAME is empty for every Duval parcel, so this equals owner_name for all 404,023 rows. Do not present it as a second fact.",
  owner_count:
    "Always NULL. FDOR NAL publishes one 30 character OWN_NAME per parcel and no co-owner column, so the source carries no owner count. It previously emitted a literal 1 on every row, which was a constant, not a count. Cite has_additional_owners instead, and never render this as a number.",
  has_additional_owners:
    "True when the roll owner name carries an ET AL / ET UX marker, meaning more owners exist than the one it names. It never says how many. This is the only multi owner signal the roll has.",
  owner_occupied: "True when the mailing address matches the situs address.",
  owner_mailing_city: "Owner mailing city from the roll. This is what owner_region_class classified.",
  owner_mailing_state: "Owner mailing state from the roll. This is what owner_region_class classified.",
  owner_mailing_zip: "Owner mailing ZIP5 from the roll. A Duval ZIP here is what makes a parcel LOCAL.",
  owner_region_class:
    "DERIVED. Owner mailing address classified against the parcel: LOCAL (in county), REGIONAL (elsewhere in FL/GA/SC/AL), NATIONAL (rest of US), FOREIGN, or null when no mailing address.",
  hoa_flag: "Always NULL. Placeholder in the Elephant contract; no Duval source publishes it.",
  last_sale_date:
    "Sale date from the FDOR roll and SDF file ONLY, which cover the two most recent transfers. NULL on 351,742 of 404,023 Duval parcels (87.06 percent). A NULL here is NOT a long hold: use last_sale_date_any and years_since_last_sale, and has_sale_on_record to tell 'no transfer on record' apart. Never cite this as tenure evidence.",
  last_sale_price: "Price of that FDOR roll transfer, USD. Null wherever last_sale_date is null.",
  last_sale_date_any:
    "DERIVED. The sale date actually used for tenure: the later of last_sale_date and coj_last_sale_date. Populated on 401,832 of 404,023 parcels (99.46 percent). tenure_basis names which column it came from. This is the column to cite for ownership hold questions.",
  tenure_basis:
    "DERIVED. Which column last_sale_date_any, years_since_last_sale and no_sale_10y_flag were computed from. FDOR_SALE = last_sale_date; COJ_SALESL = coj_last_sale_date; NO_SALE_ON_RECORD = no transfer in any source, and the three tenure columns are NULL for that reason, NOT because the property was held a long time. NEVER NULL, so do not test it with IS NULL.",
  tenure_source:
    "DERIVED. The source system that published the tenure date named by tenure_basis (coj_parcels or fdor_sdf). NULL when tenure_basis is NO_SALE_ON_RECORD.",
  tenure_quality:
    "DERIVED. Whether years_since_last_sale can honestly be read as an ownership hold. FILTER ANY TENURE QUESTION ON THIS COLUMN: tenure_quality = 'PLAUSIBLE' is the honest population, and a row outside it must never be presented as a long hold without saying which value it carries. NEVER NULL. PLAUSIBLE (388,444) = a tenure a reader can act on. IMPLAUSIBLE_DATE (1,454) = last_sale_date_any is before 1901 and is filler in the City recorded-sales file, not a transfer: 1899-12-30 on 842 rows, 1899-01-01 on 609, one 1800-01-01, which render as 126, 127 and 226 year holds. INSTITUTIONAL_OR_CIVIC (11,934) = the FDOR use code puts the parcel in the institutional, governmental or miscellaneous groups, so the date is usually real but it dates a public or institutional holding rather than a household sale. It does NOT claim the transfer was a plat dedication: no deed type is published. NO_SALE_ON_RECORD (2,191) = no source records a transfer.",
  tenure_date_check:
    "DERIVED. Whether the row's own two dates corroborate its tenure. NEVER NULL, and carries no threshold: it compares last_sale_date_any against built_year and nothing else. CONFIRMED = the sale is not earlier than the building. CONTRADICTED = the sale year precedes built_year, so the transfer cannot be a sale of the building now standing, which is what separates a 1901 date on a house built in 1952 from a genuine long hold. UNVERIFIABLE = no built_year to check against. Read it beside tenure_quality, never instead of it: tenure_quality comes from the use code, so a railway or utility parcel with an industrial or agricultural code stays PLAUSIBLE however civic it looks, and this column is what tells those apart.",
  has_sale_on_record:
    "DERIVED. False when no source records any transfer for the parcel (2,191 of 404,023). Never NULL. This is the column that separates 'no sale on record' from 'held a long time': years_since_last_sale is NULL exactly when this is false.",
  coj_last_sale_date: "The City of Jacksonville recorded sales date on its own, before the two sources are combined.",
  years_since_last_sale:
    "DERIVED. Whole years between last_sale_date_any (NOT last_sale_date) and features_as_of. NULL only when has_sale_on_record is false, and such a parcel is EXCLUDED from the long hold rule rather than counted as a long hold. A value above 100 is a placeholder date in the recorded sales file (1899 and 1800 appear as 127 and 226), not a real century long hold.",
  no_sale_10y_flag:
    "DERIVED. True when last_sale_date_any is at least 10 years before features_as_of. NULL when no sale is on record, which must NOT be read as true.",
  sale_count: "How many recorded sales the pipeline holds for the folio.",
  last_sale_source: "Which sales feed the FDOR roll sale row came from.",
  has_permits: "True when at least one building permit was reconciled to the folio.",
  permit_count: "Number of reconciled permits.",
  has_sunbiz_tenant: "True when a Sunbiz business entity was matched to the address.",
  has_bbb_contractor:
    "Always NULL. BBB terms forbid aggregation and no contractor source resolves to a parcel; the column exists only to keep the canonical list complete.",
  water_view_flag:
    "DERIVED. True when the parcel centroid is within 150 m of a mapped water body OR the parcel bounding box is within 30 m of one. A proximity proxy, not line of sight.",
  water_view_major_flag:
    "DERIVED. The same test restricted to the St Johns and the other major COJ / NHD river polygons.",
  water_dist_m:
    "DERIVED. Metres from the parcel centroid to the nearest mapped shoreline vertex. On a bounding box match this reads larger than 30 m, which is expected, not an error.",
  water_body_name: "DERIVED. Name of that nearest water body, where the source names it.",
  water_body_type: "DERIVED. NHD or COJ feature type of that water body.",
  water_basis: "DERIVED. Which water body, which source layer, and which of the two tests set water_view_flag.",
  nearest_transit_stop_m:
    "DERIVED. Straight line (haversine) metres from the parcel centroid to the nearest JTA GTFS stop, not network walking distance. Null means the transit feed was not loaded for this parcel yet.",
  nearest_transit_stop_name: "DERIVED. Name of that nearest stop.",
  nearest_starbucks_m:
    "DERIVED. Straight line (haversine) metres from the parcel centroid to the nearest Starbucks in the Overture places table, not network walking distance. Null means the places source was not loaded for this parcel yet.",
  nearest_starbucks_name: "DERIVED. Name of that nearest Starbucks place.",
  source_system:
    "PROVENANCE. Canonical Elephant column, scoped to the appraisal roll spine this row is keyed on. It is the same value on every row and it does NOT describe the enrichment columns: use <family>_source, or source_systems for the whole row.",
  source_systems:
    "PROVENANCE. Every distinct source system that contributed a non null value to this row, sorted and comma separated. This is the honest answer to where the whole row came from.",
  source_url:
    "PROVENANCE. Dataset URL of the appraisal roll (the appraisal family). Enrichment families resolve their URL through <family>_source.",
  fetched_at:
    "PROVENANCE. When the appraisal roll behind this row was fetched. Per family fetch times are in <family>_fetched_at.",
  run_id: "PROVENANCE. The pipeline run that last touched the row.",
};

/**
 * One meaning per family provenance column, generated rather than typed out.
 *
 * Twenty four near identical lines written by hand is twenty four chances for one of them to say
 * the wrong family, and the pipeline adds a family whenever it adds a source. Generating them means
 * a new family arrives documented.
 */
for (const family of SOURCE_FAMILIES) {
  COLUMN_MEANINGS[`${family.key}_source`] =
    `PROVENANCE. The source system behind this row's ${family.key} columns: ${family.label}. NULL when that family contributed nothing to this row.`;
  COLUMN_MEANINGS[`${family.key}_fetched_at`] =
    `PROVENANCE. When the ${family.key} family (${family.label}) was fetched for this row.`;
}

export function describeColumn(column: string): string {
  return COLUMN_MEANINGS[column] ?? "Published by the pipeline; not documented in the UI yet.";
}

/**
 * Every provenance column, spine and per family.
 *
 * The tools return this to the model as `provenance_columns`, and tools.ts keeps them out of the
 * inline evidence table: twenty four provenance cells beside four evidence cells would bury the
 * evidence. The spine three still ride along on every preset row.
 */
export const PROVENANCE = [...PROVENANCE_COLUMNS];
export const SPINE_PROVENANCE = [...SPINE_PROVENANCE_COLUMNS];
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

/**
 * What questions exist and which columns answer them, for the get_schema catalogue.
 *
 * Deliberately NOT the rule prose or the assumptions. get_schema is re-sent on every step of the
 * loop, so anything it carries is paid for again each time, while the system prompt caches. The
 * rule text and its caveats are exactly what preset_question returns beside the rows, and the
 * system prompt requires preset_question for these eight questions, so carrying a second copy here
 * buys nothing and costs about 800 tokens per step. Cutting it is what keeps a three step answer
 * inside the request ceiling tests/agent-prompt-budget.test.ts guards, which in turn is what keeps
 * a single answer affordable on the operator credential this deployment runs on.
 */
export function ruleCatalogue(): Pick<RuleDescription, "name" | "question" | "evidence_columns">[] {
  return ruleDescriptions().map(({ name, question, evidence_columns }) => ({
    name,
    question,
    evidence_columns,
  }));
}

/** The evidence guide without the reasons, which the system prompt already spells out in full. */
export function evidenceGuideCompact(): { topic: string; use: string[]; avoid: string[] }[] {
  return EVIDENCE_GUIDE.map((entry) => ({
    topic: entry.topic,
    use: [...entry.use],
    avoid: [...entry.avoid],
  }));
}

/**
 * The family provenance columns described once, instead of once per column.
 *
 * Twenty four near identical column lines in every get_schema result is a quarter of the catalogue
 * spent saying the same sentence twelve times. The pattern is stated once and the per column list
 * omits them.
 */
export function provenanceFamilies(): { family: string; label: string; source: string; fetched_at: string }[] {
  return SOURCE_FAMILIES.map((family) => ({
    family: family.key,
    label: family.label,
    source: `${family.key}_source`,
    fetched_at: `${family.key}_fetched_at`,
  }));
}

export const THRESHOLDS = {
  roof_age_years: ROOF_AGE_YEARS,
  ownership_hold_years: OWNERSHIP_HOLD_YEARS,
  walk_distance_m: WALK_DISTANCE_M,
} as const;

/**
 * Which column to cite for each question, and which lookalike column to leave alone.
 *
 * This exists because the model kept reaching for the obvious name. Asked about ownership tenure it
 * selected last_sale_date, which is null on 87.06 percent of parcels, and printed a table of
 * "not available" next to a correct count. The column that carries the answer is
 * last_sale_date_any. Naming both halves - use this, not that, and why - is what stops it, and it
 * is the same list the Questions page presets use, so the two surfaces cannot drift apart.
 */
export const EVIDENCE_GUIDE = [
  {
    topic: "ownership tenure / no sale in N years",
    use: ["last_sale_date_any", "tenure_basis", "tenure_source", "years_since_last_sale", "has_sale_on_record"],
    avoid: ["last_sale_date", "last_sale_price"],
    why: "last_sale_date comes from the FDOR roll and SDF only, which cover the two most recent transfers, so it is NULL on 351,742 of 404,023 parcels (87.06 percent). years_since_last_sale is computed from last_sale_date_any, tenure_basis says which column that came from, and has_sale_on_record = false is what a parcel with no transfer on record looks like. tenure_basis is never NULL, so do not test it with IS NULL.",
  },
  {
    topic: "roof age",
    use: ["roof_year_est", "roof_age_basis", "roof_age_years", "built_year"],
    avoid: ["roof_covering_material"],
    why: "roof_age_basis is EFF_YR_BLT_PROXY on 359,129 of 404,023 published rows and NULL on the other 44,894. PERMIT and ACT_YR_BLT_PROXY are on ZERO rows, so no published roof year is a permit date: every one is the appraiser's effective year built standing in, and roof age is over stated everywhere. roof_covering_material comes from the appraiser detail pages, a bounded window source, and is non null on only 930 of 404,023 rows.",
  },
  {
    topic: "owner region",
    use: ["owner_region_class", "owner_mailing_city", "owner_mailing_state", "owner_occupied"],
    avoid: ["owner_count", "owners_text"],
    why: "owner_count is NULL on every row (the roll has no co-owner column) and owners_text repeats owner_name exactly, so neither adds a fact. has_additional_owners carries the ET AL marker, and the mailing city and state are what the classifier actually read.",
  },
  {
    topic: "provenance",
    use: ["source_systems", "water_source", "transit_source", "places_source", "tenure_source"],
    avoid: [],
    why: "source_system, source_url and fetched_at describe the appraisal roll spine only and are identical on every row. Each family publishes its own <family>_source and <family>_fetched_at, and source_systems lists every system that contributed to the row. Cite the family column beside the value it produced.",
  },
  {
    topic: "water view",
    use: ["water_view_flag", "water_dist_m", "water_basis"],
    avoid: [],
    why: "water_dist_m is the centroid distance; a parcel can pass on the 30 m bounding box test with a much larger centroid distance, and water_basis says which test fired.",
  },
  {
    topic: "walking distance",
    use: ["nearest_transit_stop_m", "nearest_transit_stop_name", "nearest_starbucks_m", "nearest_starbucks_name"],
    avoid: [],
    why: "Straight line metres from the parcel centroid. NULL means the feature was not loaded for that parcel, not that nothing is nearby.",
  },
] as const;
