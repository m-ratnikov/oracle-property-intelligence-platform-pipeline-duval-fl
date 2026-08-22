/**
 * SQL the UI runs against the published query table.
 *
 * Everything here is a pure string builder so the same statements are exercised
 * by the node side tests (tests/presets.test.ts runs them through DuckDB against
 * the sample parquet) and by the browser engine.
 *
 * The view is always called `properties`, matching the view the Elephant MCP
 * server builds over the same artifact, so a SQL statement that works in this
 * workbench also works through MCP.
 */

import { SPINE_PROVENANCE_COLUMNS } from "./columns";

export const VIEW_NAME = "properties";
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

/** Walking distance used for both proximity questions, roughly a 10 minute walk. */
export const WALK_DISTANCE_M = 800;
/** Roof age threshold from the assignment. */
export const ROOF_AGE_YEARS = 15;
/** Ownership hold threshold from the assignment. */
export const OWNERSHIP_HOLD_YEARS = 10;
/** Centroid distance that sets water_view_flag in the pipeline (tracks/water.ts WATER_VIEW_DIST_M). */
export const WATER_VIEW_DIST_M = 150;
/** Parcel bounding box distance that also sets it (tracks/water.ts WATER_BUFFER_M). */
export const WATER_BBOX_DIST_M = 30;

/**
 * The first date Duval's recorded index actually covers.
 *
 * Measured, not chosen: the decade before it holds fifty times the parcels of the decade after,
 * on two repeated values. That is filler in the City recorded sales file, not deed dates.
 */
export const TENURE_RECORD_STARTS = "1901-01-01";

/**
 * The four values of tenure_quality. VARCHAR, never null.
 *
 * This is a contract shared with the pipeline, which publishes the same column on the artifact so
 * that an MCP client sees the same demotion the screen does. The values and the rules behind them
 * are the pipeline's; this file implements them identically for the artifact that does not carry
 * the column yet, and must be changed with it, never on its own.
 */
export const TENURE_QUALITY_VALUES = [
  "PLAUSIBLE",
  "IMPLAUSIBLE_DATE",
  "INSTITUTIONAL_OR_CIVIC",
  "NO_SALE_ON_RECORD",
] as const;

export type TenureQuality = (typeof TENURE_QUALITY_VALUES)[number];

/**
 * The published contract, computed locally for the artifact that predates it.
 *
 * Verified against the published artifact: these branches reproduce the pipeline's own populations
 * exactly, 388,444 / 11,934 / 2,191 / 1,454, summing to all 404,023 rows, and 143,078 / 8,708 / 0 /
 * 1,454 inside the ten year rule, summing to its 153,240 matches. So the column partitions the
 * flagship result set rather than changing what it counts.
 *
 * INSTITUTIONAL_OR_CIVIC is the FDOR use code being institutional (70 to 79), governmental (80 to
 * 89) or miscellaneous (90 to 99). It says the PARCEL is civic or institutional, which the roll
 * does support, and deliberately says nothing about the instrument: the COJ parcel layer, the
 * basis for 398,908 of 404,023 rows, publishes a sale as bare numbers with no deed type, no price
 * and no qualification code. last_sale_qual_cd, which would name a government or charitable
 * conveyance, exists on 2,924 rows, 0.72 percent. Calling any of these a plat dedication or a tax
 * deed would be inventing an instrument the data does not carry.
 *
 * It is applied regardless of tenure length on purpose, so the label describes the row rather than
 * the reading date, and cannot drift as the artifact ages.
 *
 * TRY_CAST rather than CAST on the use code: a code that is not a number is not evidence a parcel
 * is civic, and it must not take the statement down with it.
 */
const TENURE_QUALITY_COMPUTED = `CASE
    WHEN has_sale_on_record IS NOT TRUE OR years_since_last_sale IS NULL THEN 'NO_SALE_ON_RECORD'
    WHEN CAST(last_sale_date_any AS VARCHAR) < '${TENURE_RECORD_STARTS}' THEN 'IMPLAUSIBLE_DATE'
    WHEN TRY_CAST(property_usage_type AS INTEGER) BETWEEN 70 AND 99 THEN 'INSTITUTIONAL_OR_CIVIC'
    ELSE 'PLAUSIBLE' END`;

/**
 * tenure_quality, preferring the published column over the local copy.
 *
 * The pipeline is adding this column so the demotion stops existing only on this screen. Until
 * that republish lands (132 columns, schema version 3) the UI has to work against the 131 column
 * artifact, so the column is optional in both directions: published, it is read; absent, the same
 * rule is computed here under the same name, and nothing downstream can tell which one it got.
 */
function tenureQualityColumn(schema?: SchemaState): string {
  return publishes(schema, "tenure_quality")
    ? "tenure_quality"
    : `${TENURE_QUALITY_COMPUTED} AS tenure_quality`;
}

/**
 * Whether the row's own two dates agree, which is what decides the ORDER inside PLAUSIBLE.
 *
 * tenure_quality classifies the parcel, and it does that well, but on its own it does not fix the
 * reported defect. Measured under the contract alone, the rows that lead the ten year card are
 * CSX TRANSPORTATION at "125 years" (use code 055, so not civic), TINDAL FLORA B ESTATE at "125
 * years" on a house built in 1952, two SEABOARD COASTLINE parcels, CITY OF JACKSONVILLE BEACH,
 * CITY OF NEPTUNE BEACH and F E C RAILWAY CO (use code 048, industrial, so also not civic, and
 * dated 1925 on a structure built in 1958). Of the 44 PLAUSIBLE tenures over 75 years, 20 are
 * dated before their own building and 18 have no building date at all; 6 are internally
 * consistent.
 *
 * So this is a second, separate signal, and it is deliberately NOT folded into tenure_quality:
 * that column belongs to the pipeline and must mean the same thing in both places. This one says
 * only what the row says about itself, with no threshold anywhere in it:
 *
 *   CONFIRMED     the sale year is not earlier than built_year. 127,421 of the 143,078 plausible
 *                 long holds.
 *   UNVERIFIABLE  no built_year, so there is nothing to check against. 10,858. Not a finding
 *                 either way, which is why it sorts between the other two rather than last.
 *   CONTRADICTED  the sale predates the building it would have conveyed. 4,799.
 *
 * With this as the second sort key the card leads with use code 001 estates dated 1930, 1936 and
 * 1946, no row above 100 years and two above 80, and every row on screen supports the label it
 * carries.
 */
const TENURE_DATE_CHECK = `CASE
    WHEN built_year IS NULL OR last_sale_date_any IS NULL THEN 'UNVERIFIABLE'
    WHEN TRY_CAST(substr(CAST(last_sale_date_any AS VARCHAR), 1, 4) AS INTEGER) < built_year THEN 'CONTRADICTED'
    ELSE 'CONFIRMED' END AS tenure_date_check`;

/**
 * Tenures a reader can act on first, and inside those the ones the row itself corroborates.
 *
 * Ordering by the two labels rather than by age means the first screen answers the question that
 * was asked, and nothing is dropped: the civic parcels and the placeholder dates are still counted
 * and still reachable, they just stop being the first evidence a reader sees.
 */
const TENURE_ORDER = `(tenure_quality = 'PLAUSIBLE') DESC, (tenure_date_check = 'CONFIRMED') DESC, (tenure_quality = 'INSTITUTIONAL_OR_CIVIC') DESC, years_since_last_sale DESC`;

/**
 * The three canonical Elephant provenance columns, carried inline on every preset row.
 *
 * These describe the APPRAISAL ROLL SPINE, not the enrichment columns: source_system is the same
 * value on every row and says nothing about where a transit distance or a tenure date came from.
 * Presets whose evidence comes from an enrichment family select that family's own
 * `<family>_source` column as well, next to the value it produced.
 */
const PROVENANCE = SPINE_PROVENANCE_COLUMNS.join(", ");
const CURRENT_YEAR = "EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER";

/**
 * A share of the artifact a card reports beside the plain non-null coverage of its columns.
 *
 * Non-null coverage alone can be the reassuring half of a fact. roof_age_basis carries a value on
 * 88.9 percent of published parcels, which reads as a well covered column until you know that none
 * of those rows is permit derived. The preset therefore names the split it wants counted, the
 * number comes out of the same scan as the headline count, and the card cannot show one without
 * the other.
 */
export interface CoverageMeasure {
  /** Result alias suffix. Must be a bare identifier. */
  key: string;
  /** What the badge reads. */
  label: string;
  /** Boolean SQL counted with a FILTER over the whole published table. */
  predicate: string;
  /** Hover text: what the share means, in the reader's terms. */
  note: string;
}

export interface QuestionPreset {
  id: string;
  /** Short label for buttons. */
  label: string;
  /** Full question as the demo transcript phrases it. */
  question: string;
  /** The rule in plain English, shown on the card. */
  rule: string;
  /** Columns that must exist in the published parquet for this preset to run. */
  requires: string[];
  /** Extra shares of the artifact this card has to report next to its column coverage. */
  measures?: CoverageMeasure[];
  /**
   * The rule as a bare WHERE clause. The row query and the coverage query are built from this same
   * string, so the count under a result can never drift from the rows above it.
   */
  predicate: string;
  /** Honest notes about what the rule cannot see. */
  assumptions: string[];
  /** Columns that carry the evidence, highlighted in the result grid. */
  evidence: string[];
  /** Combined presets are listed separately on the questions page. */
  combined?: boolean;
  /**
   * The row query.
   *
   * `schema` is optional and only ever an optimisation of honesty: a caller that has already
   * described the artifact lets a preset read a column the artifact publishes instead of
   * recomputing it. Every caller that passes nothing still gets a statement that runs against the
   * artifact as published today, which is why the parameter could be added without touching one
   * call site.
   */
  sql: (limit?: number, schema?: SchemaState) => string;
}

function limitOf(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

const ROOF_PREDICATE = `roof_year_est IS NOT NULL AND roof_year_est <= ${CURRENT_YEAR} - ${ROOF_AGE_YEARS}`;
const HOLD_PREDICATE = `years_since_last_sale IS NOT NULL AND years_since_last_sale >= ${OWNERSHIP_HOLD_YEARS}`;
const TRANSIT_PREDICATE = `nearest_transit_stop_m IS NOT NULL AND nearest_transit_stop_m <= ${WALK_DISTANCE_M}`;
const STARBUCKS_PREDICATE = `nearest_starbucks_m IS NOT NULL AND nearest_starbucks_m <= ${WALK_DISTANCE_M}`;
const REGIONAL_PREDICATE = `owner_region_class IS NOT NULL AND upper(owner_region_class) = 'REGIONAL'`;
const WATER_PREDICATE = `water_view_flag IS NOT NULL AND CAST(water_view_flag AS BOOLEAN)`;

export const PRESETS: QuestionPreset[] = [
  {
    id: "roof-older-than-15",
    predicate: ROOF_PREDICATE,
    label: "Roof older than 15 years",
    question: "Which properties have roofs older than 15 years?",
    rule: `Keep a parcel when the estimated roof year is ${ROOF_AGE_YEARS} or more years before today. In this artifact roof_year_est is never an actual roof date. roof_age_basis carries one value and one only, EFF_YR_BLT_PROXY, on every parcel that carries a basis at all: it means no county roof date exists for that parcel and the appraiser's effective year built is standing in for one. PERMIT, the only basis that would make roof_year_est a re-roof date, is on no published row. So is ACT_YR_BLT_PROXY. The badges under the result measure both of those against the artifact you are reading, and roof_age_basis is on every row so the claim can be checked rather than trusted.`,
    requires: ["roof_year_est", "roof_age_basis"],
    measures: [
      {
        key: "permit_basis",
        label: "roof_age_basis = PERMIT",
        predicate: "roof_age_basis = 'PERMIT'",
        note: "parcels whose roof year came from a re-roof permit rather than from the year built proxy",
      },
    ],
    assumptions: [
      "A proxy basis is not a roof replacement date, and here every basis is a proxy. The JaxEPICS permit source ingested nothing at all: permit_count, roof_permit_count, last_roof_permit_year, last_roof_permit_date and has_permits are null on every published row. A parcel re-roofed last year and a parcel never re-roofed are therefore indistinguishable, and both over state roof age.",
      "Effective year built moves when the appraiser records a major improvement, so it is a better proxy than the actual year built. ACT_YR_BLT_PROXY, the fallback to the actual year built, is used on no published row: wherever the roll publishes a year at all it publishes eff_year_built, so the fallback is never reached.",
      "Parcels with no roof_year_est at all are excluded rather than guessed at. The coverage figure under the result says how many those are.",
      "roof_covering_material is not shown. It comes from the property appraiser detail pages, a slow source pulled in bounded windows, so it is populated on well under one percent of published rows and would be an empty column pretending to be evidence.",
    ],
    evidence: ["roof_year_est", "roof_age_years", "roof_age_basis", "built_year"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  address_zip,
  built_year,
  roof_year_est,
  ${CURRENT_YEAR} - roof_year_est AS roof_age_years,
  roof_age_basis,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${ROOF_PREDICATE}
ORDER BY roof_year_est ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "water-view",
    predicate: WATER_PREDICATE,
    label: "View of water",
    question: "Which properties have a view of water?",
    rule: `Keep a parcel where water_view_flag is true. Two tests set that flag: the parcel centroid is within ${WATER_VIEW_DIST_M} m of a mapped water body, OR the parcel's bounding box comes within ${WATER_BBOX_DIST_M} m of one, which is what catches a large waterfront lot whose centroid sits well inland. water_dist_m is always the centroid distance, so on a bounding box match it can read far larger than ${WATER_BBOX_DIST_M} m. water_basis names the water body, the source layer and which of the two tests fired.`,
    requires: ["water_view_flag", "water_dist_m", "water_basis", "water_source"],
    assumptions: [
      "This is a proximity proxy, not a line of sight calculation. A parcel 60 m from the St Johns with a building between it and the bank still passes.",
      `Distance is measured to the nearest mapped shoreline vertex, not to a continuous shoreline, so a body drawn with sparse vertices measures slightly long.`,
      "Only water bodies present in the published hydrography sources (COJ river polygons and USGS NHD) are considered. Private ponds and canals absent from those sources are invisible to the rule.",
    ],
    evidence: ["water_view_flag", "water_dist_m", "water_basis"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  latitude,
  longitude,
  water_view_flag,
  water_dist_m,
  water_basis,
  water_source,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${WATER_PREDICATE}
ORDER BY water_dist_m ASC NULLS LAST, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "no-sale-10-years",
    predicate: HOLD_PREDICATE,
    label: "No ownership change in 10+ years",
    question: "Which properties have not exchanged ownership in more than 10 years?",
    rule: `Keep a parcel where years_since_last_sale is ${OWNERSHIP_HOLD_YEARS} or more. years_since_last_sale is measured from last_sale_date_any, the later of the two sale dates the pipeline has for a folio: the FDOR roll and SDF sale, and the City of Jacksonville recorded sales file. tenure_basis names which column it came from (FDOR_SALE, COJ_SALESL, or NO_SALE_ON_RECORD when neither has one) and tenure_source names the system. The roll's own last_sale_date column is deliberately NOT the basis and is not shown here: the roll and SDF cover only the two most recent transfers, so that column is NULL on 87 percent of parcels and would read "not available" on almost every row of a rule it does not drive.`,
    requires: [
      "years_since_last_sale",
      "last_sale_date_any",
      "tenure_basis",
      "has_sale_on_record",
      "property_usage_type",
      "built_year",
    ],
    assumptions: [
      "Parcels with no transfer on record are excluded, not counted as long held. has_sale_on_record is false for them, tenure_basis reads NO_SALE_ON_RECORD, and years_since_last_sale is NULL for that reason rather than because the property was held a long time. No transfer on record and a long hold are different findings and this rule reports only the second.",
      `tenure_quality labels every row and none of them is dropped from the count. IMPLAUSIBLE_DATE means the sale date is before ${TENURE_RECORD_STARTS}, where the recorded index begins: 1,454 parcels, of which 1,451 carry one of two repeated values, 1899-12-30 and 1899-01-01. That is filler in the City recorded sales file, and the threshold is measured rather than chosen, because the decade before it holds fifty times the parcels of the decade after. INSTITUTIONAL_OR_CIVIC means the FDOR use code is institutional, governmental or miscellaneous (70 to 99): 11,934 parcels, 8,708 of them inside this rule. It says the PARCEL is civic, not that the transfer was a plat or a dedication; the roll carries no deed type or qualification code for 98.7 percent of rows, so the instrument is not something this dataset knows.`,
      "A second column, tenure_date_check, compares the row's own two dates and decides the order inside each label. CONTRADICTED means the sale year is earlier than built_year, so it cannot be a transfer of the building now standing: 4,799 rows here, including the 1901 dates on houses built in 1943, 1952 and 1956, and the 1925 F E C RAILWAY CO parcel built in 1958. UNVERIFIABLE means no built_year to check against, 10,858 rows. CONFIRMED means the two dates agree, 127,421 rows, and those lead the card.",
      "Neither label is a completeness claim, and the classification is known to be partial. It is drawn from the use code, so a railway, a utility or a farm parcel with an industrial or agricultural code stays PLAUSIBLE however civic it looks: F E C RAILWAY CO reads 048, CSX TRANSPORTATION reads 055. What keeps those off the top of the card is tenure_date_check, not tenure_quality, and where a parcel has no built_year neither column can settle it. PLAUSIBLE says a tenure can be read as an ownership hold, never that it has been confirmed as one.",
      "Non arms length transfers (quit claims, deeds between related parties) still count as an ownership change if the county recorded them, and a parcel whose deed was never re-recorded will read as a longer hold than it was.",
    ],
    evidence: [
      "last_sale_date_any",
      "tenure_basis",
      "tenure_source",
      "years_since_last_sale",
      "tenure_quality",
      "tenure_date_check",
    ],
    sql: (limit, schema) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  owner_name,
  property_usage_type,
  built_year,
  last_sale_date_any,
  tenure_basis,
  tenure_source,
  years_since_last_sale,
  ${tenureQualityColumn(schema)},
  ${TENURE_DATE_CHECK},
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${HOLD_PREDICATE}
ORDER BY ${TENURE_ORDER}, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "regional-owners",
    predicate: REGIONAL_PREDICATE,
    label: "Regional owners",
    question: "Which properties have regional owners?",
    rule: `Keep a parcel where owner_region_class is REGIONAL. The pipeline classifies each owner's mailing address against the parcel: LOCAL when the mailing ZIP is a Duval ZIP (or, with no ZIP, the mailing city is a Duval city), REGIONAL when the address is elsewhere in Florida or in GA, SC or AL, NATIONAL for the rest of the United States, FOREIGN otherwise, and null when the roll carries no owner state. owner_mailing_city and owner_mailing_state are the values the classifier read, shown here so the class can be checked rather than trusted.`,
    requires: ["owner_region_class", "owner_mailing_city", "owner_mailing_state"],
    assumptions: [
      "The classification uses the mailing address on the appraisal roll, which is where tax bills go. It is not proof of where the owner lives.",
      "Owners behind an LLC registered agent address classify by that agent's address, which can read as LOCAL for an out of state beneficial owner.",
      "owner_count and owners_text are not shown. The FDOR roll publishes one 30 character owner name per parcel and no co-owner column, so owner_count is published as NULL rather than as a constant 1, and owners_text repeats owner_name exactly. An ET AL or ET UX suffix inside owner_name is the only additional owner signal the source carries.",
    ],
    evidence: ["owner_region_class", "owner_mailing_city", "owner_mailing_state", "owner_occupied"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  owner_name,
  owner_mailing_city,
  owner_mailing_state,
  owner_occupied,
  owner_region_class,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${REGIONAL_PREDICATE}
ORDER BY property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "near-transit",
    predicate: TRANSIT_PREDICATE,
    label: "Walking distance to transit",
    question: "Which properties are within walking distance of public transportation?",
    rule: `Keep a parcel whose nearest published transit stop is ${WALK_DISTANCE_M} m or less from the parcel centroid, measured as a great circle (haversine) distance. ${WALK_DISTANCE_M} m is the usual 10 minute walk threshold.`,
    requires: ["nearest_transit_stop_m", "nearest_transit_stop_name", "latitude", "longitude", "transit_source"],
    assumptions: [
      "Straight line distance, not street network distance. A parcel across an unbridged creek from a stop still passes.",
      "Distance is from the parcel centroid, not the front door, which matters on large parcels.",
      "Only stops in the published transit feed count. Stops added since the last pipeline run are missing.",
    ],
    evidence: ["nearest_transit_stop_m", "nearest_transit_stop_name", "latitude", "longitude"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  latitude,
  longitude,
  nearest_transit_stop_name,
  nearest_transit_stop_m,
  transit_source,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${TRANSIT_PREDICATE}
ORDER BY nearest_transit_stop_m ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "near-starbucks",
    predicate: STARBUCKS_PREDICATE,
    label: "Walking distance to Starbucks",
    question: "Which properties are within walking distance of a Starbucks?",
    rule: `Keep a parcel whose nearest Starbucks is ${WALK_DISTANCE_M} m or less from the parcel centroid, measured as a great circle (haversine) distance against the published places table.`,
    requires: ["nearest_starbucks_m", "nearest_starbucks_name", "latitude", "longitude", "places_source"],
    assumptions: [
      "Straight line distance from the parcel centroid, same caveat as the transit rule.",
      "Licensed kiosks inside grocery stores appear in the places source under their own name and may not be matched as a Starbucks.",
    ],
    evidence: ["nearest_starbucks_m", "nearest_starbucks_name", "latitude", "longitude"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  latitude,
  longitude,
  nearest_starbucks_name,
  nearest_starbucks_m,
  places_source,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${STARBUCKS_PREDICATE}
ORDER BY nearest_starbucks_m ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "roof-and-long-hold",
    predicate: `${ROOF_PREDICATE} AND ${HOLD_PREDICATE}`,
    label: "Roof over 15 years AND no sale in 10 years",
    question:
      "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
    rule: `Both rules at once: roof_year_est is ${ROOF_AGE_YEARS} or more years old and years_since_last_sale is ${OWNERSHIP_HOLD_YEARS} or more. roof_age_basis is EFF_YR_BLT_PROXY on every row that carries it, so the roof year here is the appraiser's effective year built standing in for a roof date, never a permit date. The tenure comes from last_sale_date_any, with tenure_basis naming the column it came from. This is the first agent prompt in the demo transcript.`,
    requires: [
      "roof_year_est",
      "roof_age_basis",
      "years_since_last_sale",
      "last_sale_date_any",
      "tenure_basis",
      "property_usage_type",
      "built_year",
    ],
    measures: [
      {
        key: "permit_basis",
        label: "roof_age_basis = PERMIT",
        predicate: "roof_age_basis = 'PERMIT'",
        note: "parcels whose roof year came from a re-roof permit rather than from the year built proxy",
      },
    ],
    assumptions: [
      "Inherits every assumption of the two rules it combines: the roof basis is a year built proxy and not a roof date, and a sale date that predates the building or the recorded index can inflate the tenure. tenure_quality carries the same four values here and orders the rows the same way, so a parcel that leads this card is one where both halves of the claim are readable.",
      "Requires both signals to be present, so parcels with no roof year, or with no transfer on record, drop out entirely rather than being counted either way.",
    ],
    evidence: [
      "roof_year_est",
      "roof_age_basis",
      "years_since_last_sale",
      "last_sale_date_any",
      "tenure_basis",
    ],
    combined: true,
    sql: (limit, schema) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  property_usage_type,
  built_year,
  roof_year_est,
  ${CURRENT_YEAR} - roof_year_est AS roof_age_years,
  roof_age_basis,
  last_sale_date_any,
  tenure_basis,
  tenure_source,
  years_since_last_sale,
  ${tenureQualityColumn(schema)},
  ${TENURE_DATE_CHECK},
  owner_name,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${ROOF_PREDICATE}
  AND ${HOLD_PREDICATE}
ORDER BY ${TENURE_ORDER}, roof_year_est ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "transit-and-regional",
    predicate: `${TRANSIT_PREDICATE} AND ${REGIONAL_PREDICATE}`,
    label: "Near transit AND regional owner",
    question: "Which properties are near public transportation and also have regional owners?",
    rule: `Both rules at once: the nearest transit stop is ${WALK_DISTANCE_M} m or less and owner_region_class is REGIONAL, with owner_mailing_city and owner_mailing_state showing the address that produced the class. This is the second agent prompt in the demo transcript.`,
    requires: ["nearest_transit_stop_m", "owner_region_class", "owner_mailing_state"],
    assumptions: [
      "Inherits the straight line distance caveat and the mailing address caveat from the two rules it combines.",
    ],
    evidence: [
      "nearest_transit_stop_m",
      "nearest_transit_stop_name",
      "owner_region_class",
      "owner_mailing_state",
    ],
    combined: true,
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  latitude,
  longitude,
  nearest_transit_stop_name,
  nearest_transit_stop_m,
  owner_name,
  owner_mailing_city,
  owner_mailing_state,
  owner_region_class,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${TRANSIT_PREDICATE}
  AND ${REGIONAL_PREDICATE}
ORDER BY nearest_transit_stop_m ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
];

export const SIX_QUESTIONS = PRESETS.filter((preset) => !preset.combined);
export const COMBINED_QUESTIONS = PRESETS.filter((preset) => preset.combined);

/**
 * One query that answers "how many parcels actually match, out of how many published" plus, for
 * every column the rule depends on, how many rows carry a value at all. A rule that returns nothing
 * because a source has not loaded yet looks identical to a rule that legitimately matches nothing;
 * the coverage counts are what tell those two apart on screen.
 */
export function statsSql(preset: QuestionPreset): string {
  const parts = [
    ...preset.requires.map((column) => `  count(${column}) AS "coverage_${column}"`),
    ...(preset.measures ?? []).map(
      (measure) => `  count(*) FILTER (WHERE ${measure.predicate}) AS "measure_${measure.key}"`,
    ),
  ];
  const extraClause = parts.length > 0 ? `,\n${parts.join(",\n")}` : "";
  return `SELECT
  count(*) AS total_parcels,
  count(*) FILTER (WHERE ${preset.predicate}) AS matching_parcels${extraClause}
FROM ${VIEW_NAME}`;
}

/** Result alias a measure lands under, so the card and the SQL cannot disagree about the key. */
export function measureAlias(measure: CoverageMeasure): string {
  return `measure_${measure.key}`;
}

/** Result alias a required column's non-null count lands under. */
export function coverageAlias(column: string): string {
  return `coverage_${column}`;
}

export function presetById(id: string): QuestionPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/* --------------------------------------------------- what the UI knows yet */

/**
 * What the UI knows about the published schema, as a state rather than as a list.
 *
 * The empty array is the trap this type exists to remove. DuckDB-WASM takes seconds to boot and
 * attach the parquet over HTTP range reads, and for that whole window the engine's column list is
 * `[]` - which is indistinguishable, to any caller holding a plain array, from an artifact that
 * genuinely publishes none of the columns a rule needs. The Questions page drew the wrong
 * conclusion from it and told every arriving reviewer that the published table has no
 * roof_year_est, which is the exact opposite of what the artifact contains, for as long as the
 * engine took to attach.
 *
 * There is deliberately no value of this type that means "loaded, but nothing here yet".
 */
export type SchemaState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly columns: readonly string[] };

/** The schema is not known yet. Nothing may be concluded from it. */
export const SCHEMA_LOADING: SchemaState = { status: "loading" };

/** The engine has described the artifact: these are its columns, whatever they turn out to be. */
export function loadedSchema(columns: Iterable<string>): SchemaState {
  return { status: "loaded", columns: [...columns] };
}

/**
 * Whether the artifact is KNOWN to publish a column.
 *
 * Undefined and still loading both answer false, which is the safe direction for an optional
 * column: the caller computes the value locally instead of selecting one that may not be there.
 * A statement that names a missing column does not degrade, it fails to bind.
 */
export function publishes(schema: SchemaState | undefined, column: string): boolean {
  if (!schema || schema.status !== "loaded") return false;
  return schema.columns.some((name) => name.toLowerCase() === column.toLowerCase());
}

/**
 * Whether a card can answer, cannot answer, or does not yet know - one value, so a caller cannot
 * render the "cannot answer" branch without having proved the schema was loaded first.
 */
export type PresetAvailability =
  | { readonly status: "unknown" }
  | { readonly status: "runnable" }
  | { readonly status: "unanswerable"; readonly missing: readonly string[] };

/** The single decision every question card is built from. */
export function presetAvailability(
  preset: QuestionPreset,
  schema: SchemaState,
): PresetAvailability {
  if (schema.status === "loading") return { status: "unknown" };
  const have = new Set(schema.columns.map((column) => column.toLowerCase()));
  const missing = preset.requires.filter((column) => !have.has(column.toLowerCase()));
  return missing.length === 0 ? { status: "runnable" } : { status: "unanswerable", missing };
}

/* ------------------------------------------------------- workbench guard */

/**
 * `pragma` stays, and it is the one entry here that had to be argued rather than assumed.
 *
 * The case for dropping it: in DuckDB `PRAGMA name = value` is a spelling of SET, so the keyword is
 * not read only in general, and DESCRIBE, SHOW and SUMMARIZE already expose every introspection the
 * workbench offers, which makes PRAGMA look like surface bought for nothing.
 *
 * The case for keeping it, which won: the introspection forms (`PRAGMA table_info('properties')`,
 * `PRAGMA show_tables`, `PRAGMA database_list`, `PRAGMA version`) are exactly as read only as the
 * DESCRIBE this workbench already runs, and the /query page documents PRAGMA as accepted, so
 * refusing it would leave the page contradicting itself. The assignment form is what actually had
 * to go, and it is refused explicitly below rather than by dropping the whole keyword. Nothing
 * reachable through PRAGMA reads a file: the reader patterns below match on the function call, not
 * on the leading keyword, so `PRAGMA` gains an attacker no ground the other rules give up.
 */
const ALLOWED_STARTS = ["select", "with", "describe", "summarize", "show", "pragma", "explain"];

/** `PRAGMA x = y` is SET in disguise: a configuration change, not a read. */
const PRAGMA_ASSIGNMENT = /=/;

const FORBIDDEN = [
  "attach",
  "detach",
  "copy",
  "install",
  "load",
  "create",
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "export",
  "import",
  "vacuum",
  "checkpoint",
  "truncate",
  "grant",
  "revoke",
  // configuration and credential surfaces. The server engine locks its configuration, so these
  // cannot land, but a statement that tries has no business reaching the engine at all.
  "secret",
];

/**
 * Function families that reach the file system or the network.
 *
 * These are patterns rather than a fixed list on purpose: DuckDB gains readers with every release
 * (read_xlsx, delta_scan, iceberg_scan all arrived after this app was written), and a fixed list
 * silently stops covering the surface it was written for. Anything shaped like a reader is refused,
 * and the two published readers this app itself needs never come through here - lib/agent/db.ts
 * builds the `properties` view once at startup, before any caller supplied SQL exists.
 *
 * Matched against the statement with comments stripped, identifier quotes removed and case folded,
 * so `read_text (`, `READ_TEXT(`, `"read_text"(`, `main.read_text(` and a call nested three
 * subqueries deep all trip the same rule.
 */
const IO_FUNCTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // read_text, read_blob, read_csv, read_csv_auto, read_json_auto, read_parquet, read_ndjson, read_xlsx
  { pattern: /(^|[^a-z0-9_])read_[a-z0-9_]*\s*\(/, label: "read_* readers" },
  // parquet_scan, delta_scan, iceberg_scan, sqlite_scan, postgres_scan, mysql_scan, scan_arrow_ipc
  { pattern: /(^|[^a-z0-9_])[a-z0-9_]*_scan\s*\(/, label: "*_scan readers" },
  { pattern: /(^|[^a-z0-9_])scan_[a-z0-9_]*\s*\(/, label: "scan_* readers" },
  // glob, sniff_csv, parquet_metadata / parquet_schema / parquet_file_metadata / parquet_kv_metadata
  { pattern: /(^|[^a-z0-9_])glob\s*\(/, label: "glob" },
  { pattern: /(^|[^a-z0-9_])sniff_csv\s*\(/, label: "sniff_csv" },
  { pattern: /(^|[^a-z0-9_])parquet_[a-z0-9_]*\s*\(/, label: "parquet_* metadata readers" },
  { pattern: /(^|[^a-z0-9_])iceberg_[a-z0-9_]*\s*\(/, label: "iceberg_*" },
  { pattern: /(^|[^a-z0-9_])delta_[a-z0-9_]*\s*\(/, label: "delta_*" },
  // spatial readers, external database bridges, cloud credential helpers
  { pattern: /(^|[^a-z0-9_])st_read[a-z0-9_]*\s*\(/, label: "st_read*" },
  { pattern: /(^|[^a-z0-9_])(postgres|mysql|sqlite)_[a-z0-9_]*\s*\(/, label: "external database bridges" },
  { pattern: /(^|[^a-z0-9_])(load_aws_credentials|which_secret|duckdb_secrets)\s*\(/, label: "credential helpers" },
  // process and environment access
  { pattern: /(^|[^a-z0-9_])(getenv|shell|system)\s*\(/, label: "process and environment access" },
  /*
   * query() runs SQL built from a string and query_table() opens a name that the replacement scan
   * resolves, so both read a file while naming no reader: `FROM query('SELECT * FROM ''/etc/passwd''')`
   * was measured returning rows. The position rule below already refuses both, because their
   * argument sits inside a FROM clause. This pattern is the belt to that rule's braces, kept
   * because these two are demonstrated rather than imagined.
   */
  { pattern: /(^|[^a-z0-9_])query(_table)?\s*\(/, label: "query() and query_table()" },
];

/**
 * A string constant where a table name belongs. This is a file read with no reader named.
 *
 * DuckDB's replacement scan turns `FROM <string>` into an implicit read of that path or URL:
 * `FROM '/etc/passwd'` IS `read_parquet('/etc/passwd')` with the function elided. Every rule above
 * looks for a function call, so none of them sees it.
 *
 * The first version of this rule was a regex over the raw text, `(from|join)\s*\(?\s*'`, and it
 * closed the two forms that had been reported. A reviewer then produced four more that it allowed,
 * and measuring against a real engine (tests/sql-guard-literals.test.ts) turned up four more again
 * that nobody had reported, including `DESCRIBE '/etc/passwd'`, which needs no FROM at all. The
 * lesson is that the SPELLING of the string and the KEYWORD in front of it are not the variable
 * worth tracking, and a rule that chases them is always one form behind.
 *
 * What is actually true of every one of those forms is POSITION: a string constant sitting where a
 * table reference may appear. So the guard reasons about position, in two independent steps, and
 * neither step knows any attack by name:
 *
 *   1. `readSqlForms` recognises a string constant in every spelling DuckDB's scanner accepts and
 *      masks all of them to one indistinguishable token. After that pass `'/etc/passwd'`,
 *      `E'/etc/passwd'`, `$$/etc/passwd$$` and `$tag$/etc/passwd$tag$` are the same three
 *      characters, so a spelling nobody has met yet is a scanner change in ONE place rather than a
 *      new rule.
 *   2. `hasStringInTableReference` walks the masked tokens and refuses a masked string that sits
 *      anywhere a table reference may appear: after any introducer, at any parenthesis depth, in
 *      any comma separated slot, through any alias or join type.
 *
 * It fails closed by construction, and that is the answer to "how do you know this is complete
 * rather than one form further along". The walk does not enumerate the shapes that ARE reads. It
 * enumerates the keywords that END a table reference list and treats everything in between as
 * still being in table position. A form nobody anticipated - a join type added in a later release,
 * a table function this app has never heard of - is not on the ending list, so it stays inside the
 * clause and its string argument is refused. Being wrong about a keyword costs a false refusal
 * with a message that says how to rewrite, never a silent file read.
 *
 * The one thing the rule genuinely depends on is that step 1 agrees with DuckDB about where a
 * string ENDS. That is not taken on trust: the literal spellings are pinned against a live engine
 * in tests/sql-guard-literals.test.ts, including the case that separates them (`E'a\'b'` is one
 * literal because a backslash escapes there, `'a\'b'` is not because it does not).
 *
 * Known and accepted false positive, unchanged: `EXTRACT(YEAR FROM '1899-01-01')` puts a string in
 * this position and is refused. The fix is the better spelling anyway - `EXTRACT(YEAR FROM DATE
 * '1899-01-01')`, or a cast - and the refusal message says so, so nobody is left guessing.
 */
const TABLE_REFERENCE_INTRODUCERS = new Set([
  "from",
  "join",
  // These take a table reference with no FROM in sight, and DESCRIBE, SUMMARIZE and SHOW are all
  // in ALLOWED_STARTS: `DESCRIBE '/etc/passwd'` returns that file's schema on an unsealed engine.
  "describe",
  "summarize",
  "show",
  "table",
  "pivot",
  "unpivot",
]);

/**
 * Keywords that end a table reference list.
 *
 * This list is the whole safety argument, so it is the one to be generous with: anything NOT here
 * leaves the walk inside the clause, which refuses. Under-listing costs a false refusal that the
 * reader can see and rewrite. Over-listing would open a hole, so nothing goes in that cannot
 * appear where a table reference has genuinely finished.
 */
const TABLE_REFERENCE_ENDS = new Set([
  "select",
  "with",
  "where",
  "group",
  "having",
  "qualify",
  "window",
  "order",
  "limit",
  "offset",
  "union",
  "except",
  "intersect",
  "on",
  "using",
  "values",
  "returning",
  "fetch",
  "into",
  "tablesample",
  "prepare",
  "execute",
  "explain",
  "pragma",
  "call",
  "set",
]);

/** Masked tokens the walk cares about: a masked string, a word, or one of `( ) ,`. */
const MASKED_TOKEN = /''|[a-z_][a-z0-9_]*|[(),]/g;

/**
 * Whether a string constant sits anywhere a table reference may appear.
 *
 * Reads the masked form only, so what is INSIDE a string can never reach this decision and a
 * keyword that is only ever data cannot be mistaken for code.
 */
function hasStringInTableReference(masked: string): boolean {
  // One flag per parenthesis level: whether that level is currently in table position.
  const inTableReference: boolean[] = [false];
  MASKED_TOKEN.lastIndex = 0;
  let previousWord = "";
  let previousToken = "";

  let match: RegExpExecArray | null;
  while ((match = MASKED_TOKEN.exec(masked)) !== null) {
    const token = match[0];
    const depth = inTableReference.length - 1;

    if (token === "''") {
      /*
       * A string that IS a table reference is always preceded by the introducer, a comma or an
       * open parenthesis. A string preceded by a bare WORD is a typed literal or an operand -
       * `DATE '1899-01-01'` - and never reaches the replacement scan. That is measured, not
       * assumed: every `FROM <word> '<path>'` shape is a parser error on a live engine while the
       * bare form reads the file, which tests/sql-guard-literals.test.ts pins.
       *
       * Without this the guard refused `EXTRACT(YEAR FROM DATE '1899-01-01')`, which is the exact
       * rewrite its own refusal message tells the reader to use.
       */
      const couldBeTableReference =
        previousToken === "," || previousToken === "(" || TABLE_REFERENCE_INTRODUCERS.has(previousToken);
      if (inTableReference[depth] && couldBeTableReference) return true;
      previousToken = token;
      continue;
    }
    if (token === "(") {
      /*
       * A parenthesis opened in table position is either a subquery or a parenthesised table
       * reference, and only the subquery leaves table position - which its own SELECT, WITH or
       * VALUES announces on the very next token. So the level INHERITS, and `(('/etc/passwd'))`
       * is still a read at any depth, while `FROM (SELECT ... WHERE x LIKE '%a%')` is not.
       */
      inTableReference.push(inTableReference[depth]);
      previousToken = token;
      continue;
    }
    if (token === ")") {
      if (inTableReference.length > 1) inTableReference.pop();
      previousToken = token;
      continue;
    }
    // A comma is the next slot in the same list, which is what `FROM properties, '/etc/passwd'`
    // relies on, so it changes nothing.
    if (token === ",") {
      previousToken = token;
      continue;
    }

    /*
     * `IS DISTINCT FROM 'x'` is a comparison operator that happens to be spelled with FROM, and
     * treating its FROM as an introducer refused `WHERE property_type IS DISTINCT FROM
     * 'RESIDENTIAL'`, which is an ordinary query over this dataset. Suppressing the introducer is
     * safe in a way that adding DISTINCT to the ENDS list would not be: it only stops this FROM
     * SETTING the flag and can never clear one, so a literal already inside a table reference is
     * still refused.
     */
    const isComparisonFrom = token === "from" && previousWord === "distinct";
    if (!isComparisonFrom && TABLE_REFERENCE_INTRODUCERS.has(token)) inTableReference[depth] = true;
    else if (TABLE_REFERENCE_ENDS.has(token)) inTableReference[depth] = false;
    previousWord = token;
    previousToken = token;
  }

  return false;
}

/**
 * URL schemes that only ever appear in an attempt to make the engine fetch something.
 *
 * http and https are deliberately NOT here: source_url is a published column, so
 * `WHERE source_url LIKE 'https://paopropertysearch%'` is a legitimate query over this dataset and
 * refusing it would be a false positive.
 *
 * This list is a third cheap check, not the thing that stops a remote fetch. Two separate rules do
 * that: the reader patterns above cover a fetch that names its reader, and STRING_IN_TABLE_POSITION
 * covers one that does not.
 */
const FORBIDDEN_URL_SCHEMES = /(^|[^a-z0-9_])(file|s3|gs|gcs|az|azure|abfss?|r2|hf|ipfs|ipns):\/\//;

export interface GuardResult {
  ok: boolean;
  /** The statement to actually execute, limit enforced. */
  sql?: string;
  reason?: string;
}

/**
 * The three forms of a statement the guard reasons over, produced in one pass.
 *
 * A regex cannot separate code from text in SQL, and the previous version tried. `WHERE
 * address_street LIKE '%--%'` has a line comment marker inside a string literal; blind stripping
 * rewrote it to `WHERE address_street LIKE '%`, a different and unterminated statement - and the
 * rewritten text was what went on to execute. So this walks the statement instead, tracking
 * whether it is inside a comment, a single quoted literal (`''` escapes) or a double quoted
 * identifier (`""` escapes).
 */
interface SqlForms {
  /**
   * Caller text with comments replaced by a space, literals untouched. This is the text that
   * executes: a comment cannot smuggle anything past the wrapper once it is gone, and with the
   * walk above nothing inside a literal is touched to get there.
   */
  code: string;
  /** `code`, case folded, identifier quotes removed so `"read_text"(` cannot hide behind them. */
  folded: string;
  /**
   * `folded` with every string constant emptied to `''`, in EVERY spelling. Structural rules read
   * this one, so a keyword or a semicolon that is only ever DATA - `WHERE owner_name LIKE
   * '%COPY%'`, `WHERE legal_description LIKE '%LOT 3; BLK 2%'` - cannot be mistaken for code, and
   * a string cannot dodge a rule by changing how it is quoted.
   */
  masked: string;
}

/**
 * Opens a dollar quote. The tag is required to be an identifier so `$1` stays a bind parameter,
 * which is what DuckDB does with it, rather than being read as an unterminated quote.
 */
const DOLLAR_QUOTE_OPEN = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** A name that needs no quotes. Anything else, in table position, is naming something else. */
const PLAIN_IDENTIFIER = /^[a-z0-9_]+$/;

/** True where an `E` may begin an escape string rather than end an identifier such as `LIKE`. */
function atTokenBoundary(sql: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9_"]/.test(sql[index - 1]);
}

/**
 * The one place that decides where a comment, a string constant or a quoted name starts and ends.
 *
 * Every spelling here was verified against a live DuckDB in tests/sql-guard-literals.test.ts, not
 * recalled from the documentation, because the guard is only as closed as this function's
 * agreement with the engine's own scanner:
 *
 *   '...'          doubled `''` is the only escape; a backslash is data
 *   E'...'         backslash escapes AS WELL AS `''`, so `E'a\'b'` is ONE literal
 *   $$...$$        no escape at all
 *   $tag$...$tag$  tag is an identifier
 *   "..."          a name, but the replacement scan reads it too: `FROM "/etc/passwd"` is a file
 *
 * B'...', X'...', R'...' and U&'...' are deliberately absent: each one is a parse error or an
 * unimplemented path in table position, so DuckDB will not read a file through them.
 *
 * Adjacent string constants concatenate (`'a' 'b'`) and need no rule of their own: each masks to
 * the same token, and in table position the first one already decides.
 */
function readSqlForms(sql: string): SqlForms {
  let code = "";
  let folded = "";
  let masked = "";
  let i = 0;

  /** Keep the caller's text byte for byte, fold it for the reader rules, hide it from the walk. */
  const pushConstant = (raw: string) => {
    code += raw;
    folded += raw.toLowerCase();
    masked += "''";
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      code += " ";
      folded += " ";
      masked += " ";
      continue;
    }

    if (char === "/" && next === "*") {
      /*
       * DuckDB NESTS block comments: `/* a /* b *\/ c *\/` is one comment to the engine. A scanner
       * that stopped at the first close would hand the engine text it had already treated as code,
       * which is the same class of defect as mis-stripping `LIKE '%--%'`: the statement that runs
       * stops being the statement that was checked.
       */
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      code += " ";
      folded += " ";
      masked += " ";
      continue;
    }

    const dollarQuote = char === "$" ? DOLLAR_QUOTE_OPEN.exec(sql.slice(i)) : null;
    if (dollarQuote) {
      const tag = dollarQuote[0];
      const close = sql.indexOf(tag, i + tag.length);
      // An unterminated quote runs to the end, the way the engine reads it, so nothing past it is
      // read back as code by a guard the engine would disagree with.
      const stop = close === -1 ? sql.length : close + tag.length;
      pushConstant(sql.slice(i, stop));
      i = stop;
      continue;
    }

    const escapeString = (char === "e" || char === "E") && next === "'" && atTokenBoundary(sql, i);
    if (escapeString || char === "'") {
      const start = i;
      i += escapeString ? 2 : 1;
      while (i < sql.length) {
        // Backslash escapes a quote in E'...' and ONLY there. Getting this backwards desyncs the
        // guard from the engine, which is exactly how a string smuggles code out of itself.
        if (escapeString && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      pushConstant(sql.slice(start, i));
      continue;
    }

    if (char === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      const quoted = sql.slice(start, i);
      const inner = quoted.replace(/"/g, "").toLowerCase();
      code += quoted;
      // Unquoted, so `"read_text"(` cannot hide a reader behind the quotes.
      folded += inner;
      /*
       * The replacement scan reads a double quoted name too: `FROM "/etc/passwd"` returns the file
       * on an unsealed engine, which no reported bypass mentioned. A name that needs the quotes
       * only because it holds a path separator, a dot, a colon or a space is not naming a table in
       * a session whose catalog holds one view, so it masks as a constant and the position walk
       * judges it. `"properties"` is a plain identifier and stays one.
       */
      masked += PLAIN_IDENTIFIER.test(inner) ? inner : "''";
      continue;
    }

    code += char;
    folded += char.toLowerCase();
    masked += char.toLowerCase();
    i += 1;
  }

  return { code, folded, masked };
}

/**
 * Remove line and block comments so they cannot hide a second statement, without touching text
 * inside a string literal or a quoted identifier.
 */
export function stripSqlComments(sql: string): string {
  return readSqlForms(sql).code;
}

/**
 * The second of two layers, and the weaker one. Say what each layer is for, because a reader who
 * believes this function is the security boundary will eventually widen it to be helpful.
 *
 * Layer one is the engine. lib/agent/db.ts opens DuckDB with `allowed_paths` set to the single
 * published parquet, `enable_external_access = false` and `lock_configuration = true`, so the
 * process cannot open any other file or URL and cannot be talked into unlocking itself. That is
 * what actually stops `SELECT content FROM read_text('/proc/self/environ')` on a server that holds
 * a model provider API key, and it holds even if every rule below is bypassed.
 *
 * Layer two is this function. It refuses the statement earlier, with a reason the caller (a person
 * in the /query workbench, or the model through the run_sql tool) can act on, and it keeps result
 * sets bounded. It is a denylist, so treat it as defence in depth, never as the boundary.
 *
 * The browser workbench (/query) runs DuckDB-WASM in the reader's own tab against a virtual file
 * system with no host paths and no server credentials in the process, so it has layer two only.
 * That is the correct trade there: the only thing a reader can reach is their own browser.
 *
 * What executes is the caller's statement with comments removed and nothing else rewritten. The
 * structural rules read a masked copy in which literals are emptied, so text can never be mistaken
 * for code, and code can never hide inside text.
 */
export function guardSql(raw: string, limit: number = DEFAULT_LIMIT): GuardResult {
  const forms = readSqlForms(raw);
  if (forms.code.trim() === "") return { ok: false, reason: "Enter a statement first." };

  const statement = forms.code.trim().replace(/;+\s*$/, "").trim();
  const masked = forms.masked.trim().replace(/;+\s*$/, "").trim();
  const folded = forms.folded;

  if (masked.includes(";")) {
    return {
      ok: false,
      reason: "One statement at a time. Remove the extra semicolon.",
    };
  }

  const firstWord = masked.split(/\s+/, 1)[0] ?? "";
  if (!ALLOWED_STARTS.includes(firstWord)) {
    return {
      ok: false,
      reason: `Read only workbench. Statements must start with one of: ${ALLOWED_STARTS.join(", ")}.`,
    };
  }

  if (firstWord === "pragma" && PRAGMA_ASSIGNMENT.test(masked)) {
    return {
      ok: false,
      reason: "Read only workbench. PRAGMA may inspect the database, not set an option.",
    };
  }

  for (const keyword of FORBIDDEN) {
    if (new RegExp(`(^|[^a-z0-9_])${keyword}([^a-z0-9_]|$)`).test(masked)) {
      return { ok: false, reason: `Read only workbench. "${keyword}" is not allowed.` };
    }
  }

  if (hasStringInTableReference(masked)) {
    return {
      ok: false,
      reason: `Read only workbench. A string where a table name belongs is a file or URL read, not a table: DuckDB's replacement scan makes FROM '<path>' the same thing as read_parquet('<path>'), whichever way the string is quoted. This session may only read the published "${VIEW_NAME}" view. If you meant a date or a cast, name the type first, as in EXTRACT(YEAR FROM DATE '1899-01-01'); if you meant a value, put it in a subquery's SELECT list rather than in the FROM clause.`,
    };
  }

  for (const { pattern, label } of IO_FUNCTION_PATTERNS) {
    if (pattern.test(folded)) {
      return {
        ok: false,
        reason: `Read only workbench. ${label} cannot be called: this session may only read the published "${VIEW_NAME}" view, never a file or a URL.`,
      };
    }
  }

  if (FORBIDDEN_URL_SCHEMES.test(folded)) {
    return {
      ok: false,
      reason: `Read only workbench. Only the published "${VIEW_NAME}" view can be read, not a file or object store URL.`,
    };
  }

  const effectiveLimit = limitOf(limit);
  const needsWrapping = firstWord === "select" || firstWord === "with";
  const sql = needsWrapping
    ? `SELECT * FROM (\n${statement}\n) AS guarded_query LIMIT ${effectiveLimit}`
    : statement;

  return { ok: true, sql };
}

export const STARTER_SQL = `-- The published query table is exposed as the view "properties",
-- the same view name the Elephant MCP server builds over this artifact.
SELECT
  property_id,
  address_street,
  address_city,
  built_year,
  market_value,
  owner_region_class
FROM properties
WHERE market_value IS NOT NULL
ORDER BY market_value DESC`;

export const TOTAL_ALIAS = "__row_total";

/**
 * Non null coverage for every column, computed inside DuckDB in a single pass.
 * One COUNT per column in one row beats a UNION ALL of one query per column,
 * which would scan the parquet once for every column.
 */
export function columnCoverageSql(columns: string[]): string {
  if (columns.length === 0) return `SELECT 0 AS ${TOTAL_ALIAS}`;
  const counts = columns
    .map((column) => {
      const quoted = column.replace(/"/g, '""');
      return `COUNT("${quoted}") AS "${quoted}"`;
    })
    .join(",\n  ");
  return `SELECT\n  COUNT(*) AS ${TOTAL_ALIAS},\n  ${counts}\nFROM ${VIEW_NAME}`;
}

/** Value distribution for a low cardinality column, for the honesty panels. */
export function valueBreakdownSql(column: string, limit = 12): string {
  const quoted = column.replace(/"/g, '""');
  return `SELECT
  COALESCE(CAST("${quoted}" AS VARCHAR), '(null)') AS value,
  COUNT(*) AS rows
FROM ${VIEW_NAME}
GROUP BY 1
ORDER BY rows DESC
LIMIT ${limitOf(limit)}`;
}

/** Row counts grouped by the source system that produced them. */
export const SOURCE_SYSTEM_BREAKDOWN_SQL = `SELECT
  COALESCE(source_system, '(null)') AS source_system,
  COUNT(*) AS rows,
  MIN(fetched_at) AS first_fetched_at,
  MAX(fetched_at) AS last_fetched_at
FROM ${VIEW_NAME}
GROUP BY 1
ORDER BY rows DESC`;

/** How many parcels each pipeline run last touched. */
export const RUN_BREAKDOWN_SQL = `SELECT
  COALESCE(CAST(run_id AS VARCHAR), '(null)') AS run_id,
  COUNT(*) AS parcels_touched,
  MAX(fetched_at) AS last_fetched_at
FROM ${VIEW_NAME}
GROUP BY 1
ORDER BY run_id DESC`;

export function propertyByIdSql(propertyId: string): string {
  const escaped = propertyId.replace(/'/g, "''");
  return `SELECT * FROM ${VIEW_NAME} WHERE CAST(property_id AS VARCHAR) = '${escaped}' OR CAST(parcel_identifier AS VARCHAR) = '${escaped}' OR CAST(request_identifier AS VARCHAR) = '${escaped}' LIMIT 1`;
}

export function searchPropertiesSql(term: string, limit = 25): string {
  const escaped = term.replace(/'/g, "''").toLowerCase();
  return `SELECT property_id, parcel_identifier, address_street, address_city, address_zip, owner_name
FROM ${VIEW_NAME}
WHERE lower(COALESCE(address_street, '')) LIKE '%${escaped}%'
   OR lower(COALESCE(owner_name, '')) LIKE '%${escaped}%'
   OR lower(CAST(property_id AS VARCHAR)) LIKE '%${escaped}%'
   OR lower(COALESCE(CAST(parcel_identifier AS VARCHAR), '')) LIKE '%${escaped}%'
ORDER BY property_id
LIMIT ${limitOf(limit)}`;
}
