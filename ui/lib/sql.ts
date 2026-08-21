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

export const VIEW_NAME = "properties";
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

/** Walking distance used for both proximity questions, roughly a 10 minute walk. */
export const WALK_DISTANCE_M = 800;
/** Roof age threshold from the assignment. */
export const ROOF_AGE_YEARS = 15;
/** Ownership hold threshold from the assignment. */
export const OWNERSHIP_HOLD_YEARS = 10;

const PROVENANCE = "source_system, source_url, fetched_at";
const CURRENT_YEAR = "EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER";

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
  /** Honest notes about what the rule cannot see. */
  assumptions: string[];
  /** Columns that carry the evidence, highlighted in the result grid. */
  evidence: string[];
  /** Combined presets are listed separately on the questions page. */
  combined?: boolean;
  sql: (limit?: number) => string;
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
    label: "Roof older than 15 years",
    question: "Which properties have roofs older than 15 years?",
    rule: `Keep a parcel when the estimated roof year is 15 or more years before today. roof_year_est is the pipeline's best estimate of when the current roof went on, and roof_age_basis says where that estimate came from (a re-roof permit, an appraiser roof field, or the year built used as a proxy).`,
    requires: ["roof_year_est", "roof_age_basis"],
    assumptions: [
      "Where roof_age_basis is year_built_proxy the county publishes no roof date, so the year the house was built stands in for the roof. That over counts houses that were re-roofed without a permit on file.",
      "Parcels with no roof_year_est at all are excluded rather than guessed at. The Data page shows how many those are.",
    ],
    evidence: ["roof_year_est", "roof_age_years", "roof_age_basis", "roof_covering_material"],
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
  roof_covering_material,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${ROOF_PREDICATE}
ORDER BY roof_year_est ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "water-view",
    label: "View of water",
    question: "Which properties have a view of water?",
    rule: `Keep a parcel where water_view_flag is true. The pipeline sets that flag from the parcel centroid's distance to a mapped water body (water_dist_m) and records the method in water_basis.`,
    requires: ["water_view_flag", "water_dist_m", "water_basis"],
    assumptions: [
      "This is a proximity proxy, not a line of sight calculation. A parcel 60 m from the St Johns with a building between it and the bank still passes.",
      "Only water bodies present in the published hydrography source are considered. Private ponds and canals absent from that source are invisible to the rule.",
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
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${WATER_PREDICATE}
ORDER BY water_dist_m ASC NULLS LAST, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "no-sale-10-years",
    label: "No ownership change in 10+ years",
    question: "Which properties have not exchanged ownership in more than 10 years?",
    rule: `Keep a parcel where years_since_last_sale is 10 or more. years_since_last_sale is measured from last_sale_date, the most recent recorded transfer the pipeline found for that folio.`,
    requires: ["years_since_last_sale", "last_sale_date"],
    assumptions: [
      "Parcels with no recorded sale date are excluded, not counted as long held. A missing sale can mean a long hold or a gap in the recorded sales source, and the two are not distinguishable from this artifact.",
      "Non arms length transfers (quit claims, deeds between related parties) still count as an ownership change if the county recorded them.",
    ],
    evidence: ["last_sale_date", "last_sale_price", "years_since_last_sale"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  owner_name,
  last_sale_date,
  last_sale_price,
  years_since_last_sale,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${HOLD_PREDICATE}
ORDER BY years_since_last_sale DESC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "regional-owners",
    label: "Regional owners",
    question: "Which properties have regional owners?",
    rule: `Keep a parcel where owner_region_class is REGIONAL. The pipeline classifies each owner's mailing address against the parcel: LOCAL when the mailing address is inside the county, REGIONAL when it is elsewhere in the south east (FL, GA, SC, AL), NATIONAL for the rest of the United States, FOREIGN otherwise.`,
    requires: ["owner_region_class"],
    assumptions: [
      "The classification uses the mailing address on the appraisal roll, which is where tax bills go. It is not proof of where the owner lives.",
      "Owners behind an LLC registered agent address classify by that agent's address, which can read as LOCAL for an out of state beneficial owner.",
    ],
    evidence: ["owner_region_class", "owner_name", "owners_text", "owner_occupied"],
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  owner_name,
  owners_text,
  owner_count,
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
    label: "Walking distance to transit",
    question: "Which properties are within walking distance of public transportation?",
    rule: `Keep a parcel whose nearest published transit stop is ${WALK_DISTANCE_M} m or less from the parcel centroid, measured as a great circle (haversine) distance. ${WALK_DISTANCE_M} m is the usual 10 minute walk threshold.`,
    requires: ["nearest_transit_stop_m", "nearest_transit_stop_name", "latitude", "longitude"],
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
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${TRANSIT_PREDICATE}
ORDER BY nearest_transit_stop_m ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "near-starbucks",
    label: "Walking distance to Starbucks",
    question: "Which properties are within walking distance of a Starbucks?",
    rule: `Keep a parcel whose nearest Starbucks is ${WALK_DISTANCE_M} m or less from the parcel centroid, measured as a great circle (haversine) distance against the published places table.`,
    requires: ["nearest_starbucks_m", "nearest_starbucks_name", "latitude", "longitude"],
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
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${STARBUCKS_PREDICATE}
ORDER BY nearest_starbucks_m ASC, property_id ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "roof-and-long-hold",
    label: "Roof over 15 years AND no sale in 10 years",
    question:
      "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
    rule: `Both rules at once: roof_year_est is ${ROOF_AGE_YEARS} or more years old and years_since_last_sale is ${OWNERSHIP_HOLD_YEARS} or more. This is the first agent prompt in the demo transcript.`,
    requires: ["roof_year_est", "roof_age_basis", "years_since_last_sale"],
    assumptions: [
      "Inherits every assumption of the two rules it combines, so a year_built_proxy roof basis plus a missing sale record can both distort this list.",
      "Requires both signals to be present, so parcels missing either column drop out entirely.",
    ],
    evidence: ["roof_year_est", "roof_age_basis", "years_since_last_sale", "last_sale_date"],
    combined: true,
    sql: (limit) => `SELECT
  property_id,
  parcel_identifier,
  address_street,
  address_city,
  built_year,
  roof_year_est,
  ${CURRENT_YEAR} - roof_year_est AS roof_age_years,
  roof_age_basis,
  last_sale_date,
  years_since_last_sale,
  owner_name,
  ${PROVENANCE}
FROM ${VIEW_NAME}
WHERE ${ROOF_PREDICATE}
  AND ${HOLD_PREDICATE}
ORDER BY years_since_last_sale DESC, roof_year_est ASC
LIMIT ${limitOf(limit)}`,
  },
  {
    id: "transit-and-regional",
    label: "Near transit AND regional owner",
    question: "Which properties are near public transportation and also have regional owners?",
    rule: `Both rules at once: the nearest transit stop is ${WALK_DISTANCE_M} m or less and owner_region_class is REGIONAL. This is the second agent prompt in the demo transcript.`,
    requires: ["nearest_transit_stop_m", "owner_region_class"],
    assumptions: [
      "Inherits the straight line distance caveat and the mailing address caveat from the two rules it combines.",
    ],
    evidence: [
      "nearest_transit_stop_m",
      "nearest_transit_stop_name",
      "owner_region_class",
      "owner_name",
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

export function presetById(id: string): QuestionPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Columns missing from the published parquet that this preset needs. */
export function missingColumns(preset: QuestionPreset, available: Iterable<string>): string[] {
  const have = new Set([...available].map((column) => column.toLowerCase()));
  return preset.requires.filter((column) => !have.has(column.toLowerCase()));
}

/* ------------------------------------------------------- workbench guard */

const ALLOWED_STARTS = ["select", "with", "describe", "summarize", "show", "pragma", "explain"];

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
];

export interface GuardResult {
  ok: boolean;
  /** The statement to actually execute, limit enforced. */
  sql?: string;
  reason?: string;
}

/** Remove line and block comments so they cannot hide a second statement. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

/**
 * The workbench is read only by construction: DuckDB-WASM runs in an in memory
 * database in the user's own tab, so nothing here can touch the published
 * artifacts. The guard exists to keep the tab honest and predictable, and to
 * make sure a result set can never be unbounded.
 */
export function guardSql(raw: string, limit: number = DEFAULT_LIMIT): GuardResult {
  const stripped = stripSqlComments(raw).trim();
  if (stripped === "") return { ok: false, reason: "Enter a statement first." };

  const withoutTrailing = stripped.replace(/;+\s*$/, "").trim();
  if (withoutTrailing.includes(";")) {
    return {
      ok: false,
      reason: "One statement at a time. Remove the extra semicolon.",
    };
  }

  const firstWord = withoutTrailing.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!ALLOWED_STARTS.includes(firstWord)) {
    return {
      ok: false,
      reason: `Read only workbench. Statements must start with one of: ${ALLOWED_STARTS.join(", ")}.`,
    };
  }

  const lowered = withoutTrailing.toLowerCase();
  for (const keyword of FORBIDDEN) {
    if (new RegExp(`(^|[^a-z0-9_])${keyword}([^a-z0-9_]|$)`).test(lowered)) {
      return { ok: false, reason: `Read only workbench. "${keyword}" is not allowed.` };
    }
  }

  const effectiveLimit = limitOf(limit);
  const needsWrapping = firstWord === "select" || firstWord === "with";
  const sql = needsWrapping
    ? `SELECT * FROM (\n${withoutTrailing}\n) AS guarded_query LIMIT ${effectiveLimit}`
    : withoutTrailing;

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
