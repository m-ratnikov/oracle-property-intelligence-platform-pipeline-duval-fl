import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { COUNTY } from "../config.js";
import { all, count, duckPath, ident, one, q, tableColumns } from "../db.js";
import { computeFileCid } from "../publish/cid.js";
import { SOURCES } from "../sources.js";
import { COLUMN_FAMILIES, SOURCE_FAMILIES } from "./build.js";

/** The 37 canonical query-table columns, in elephant-query-db run-query-table-export.ts order. */
export const QUERY_TABLE_CANONICAL_COLUMNS: readonly string[] = [
  "property_id", "property_cid", "request_identifier", "parcel_identifier", "source_system", "county_name",
  "state_code", "address_street", "address_city", "address_zip", "latitude", "longitude", "lot_size_acre",
  "lot_area_sqft", "exterior_wall_material", "roof_covering_material", "property_type", "property_usage_type",
  "built_year", "livable_floor_area", "total_area", "assessed_value", "market_value", "land_value", "avm_value",
  "owner_name", "owners_text", "owner_count", "owner_occupied", "last_sale_date", "last_sale_price", "subdivision",
  "has_permits", "permit_count", "has_sunbiz_tenant", "has_bbb_contractor", "hoa_flag",
];

/**
 * Column notes published with the parquet.
 *
 * Only columns whose meaning a reader could get wrong are listed; everything else is described by
 * its family label. These are the sentences a consumer sees when they ask the file what a column
 * means, so anything that is a proxy, a gap, or a derivation has to say so here.
 */
export const QUERY_TABLE_COLUMN_NOTES: Readonly<Record<string, string>> = {
  source_system:
    "Canonical Elephant column, scoped to the appraisal-roll spine this row is keyed on. It is the same value on every row and it does NOT describe the enrichment columns: use <family>_source, or source_systems for the whole row.",
  source_systems:
    "Every distinct source system that contributed a non-null value to this row, sorted and comma separated.",
  source_url: "Dataset URL of the appraisal roll (the appraisal family). Enrichment families resolve their URL through <family>_source.",
  fetched_at: "When the appraisal roll behind this row was fetched. Per family fetch times are in <family>_fetched_at.",
  owner_count:
    "Always NULL. FDOR NAL publishes one 30-character OWN_NAME per parcel and no co-owner column, so the source carries no owner count. Previously emitted a literal 1 for every row, which was a constant, not a count. has_additional_owners carries the only multi-owner signal the roll has.",
  owners_text:
    "OWN_NAME, plus 'c/o ' and FIDU_NAME when the roll names a fiduciary. FIDU_NAME is empty for every Duval parcel, so this equals owner_name for all 404,023 rows.",
  has_additional_owners:
    "True when the roll's owner name carries an ET AL / ET UX marker, meaning more owners exist than the one it names. It never says how many.",
  last_sale_date:
    "Sale date from the FDOR roll and SDF file ONLY, which cover the two most recent transfers (2025-2026). NULL on 87% of Duval parcels. A NULL here is not a long hold: use last_sale_date_any / years_since_last_sale, and has_sale_on_record to tell 'no transfer on record' apart.",
  last_sale_date_any:
    "The sale date actually used for tenure: the later of last_sale_date and coj_last_sale_date. tenure_basis names which column it came from.",
  tenure_basis:
    "Which column last_sale_date_any, years_since_last_sale and no_sale_10y_flag were computed from. FDOR_SALE = last_sale_date; COJ_SALESL = coj_last_sale_date; NO_SALE_ON_RECORD = no transfer in any source, and the three tenure columns are NULL for that reason, NOT because the property was held a long time. Never NULL.",
  tenure_source: "The source system that published the tenure date named by tenure_basis. NULL when tenure_basis is NO_SALE_ON_RECORD.",
  tenure_quality:
    "DERIVED. Whether years_since_last_sale can honestly be read as an ownership hold. FILTER ANY TENURE QUESTION ON THIS COLUMN: 'WHERE tenure_quality = ''PLAUSIBLE''' is the honest population, and a row outside it must never be presented as a long hold without saying which value it carries. Never NULL. PLAUSIBLE (388,444 rows) = a tenure a reader can act on. IMPLAUSIBLE_DATE (1,454) = last_sale_date_any is before 1901 and is filler in the City recorded-sales file, not a transfer: 1899-12-30 on 842 rows, 1899-01-01 on 609, one 1800-01-01, which render as 126, 127 and 226 year holds. INSTITUTIONAL_OR_CIVIC (11,934) = the FDOR use code puts the parcel in the institutional (70-79), governmental (80-89) or miscellaneous (90-99) groups - churches, cemeteries, schools, parks, municipal and state land, utility and right-of-way - so the date is usually real but it dates a public or institutional holding, not a household sale. It does NOT claim the transfer was a plat dedication: the City parcel layer publishes the sale as a bare date with no deed type, and last_sale_qual_cd exists on only the 2,924 FDOR_SALE rows. NO_SALE_ON_RECORD (2,191) = no source records any transfer, matching tenure_basis and has_sale_on_record = false; the tenure columns are NULL for that reason and NOT because the property was held a long time.",
  tenure_date_check:
    "DERIVED. Whether the row's own two dates corroborate its tenure. Never NULL, and carries no threshold: it only compares last_sale_date_any against built_year. CONFIRMED (127,421 rows) = the sale is not earlier than the building, so the two agree. CONTRADICTED (4,799) = the sale year precedes built_year, so the transfer cannot be a sale of the building now standing: the 1901 dates on houses built in 1943, 1952 and 1956 land here, as does the 1925 F E C RAILWAY CO parcel whose structure is dated 1958. UNVERIFIABLE (10,858) = no built_year to check against, so neither column can settle it. Read this beside tenure_quality, not instead of it: tenure_quality is drawn from the use code and therefore leaves a railway or utility parcel with an industrial or agricultural code marked PLAUSIBLE, and this column is what separates those from a genuine long hold. Counts are for rows matching the ten year tenure rule.",
  has_sale_on_record:
    "False when no source records any transfer for the parcel. Never NULL. This is the column that separates 'no sale on record' from 'held a long time'; years_since_last_sale is NULL in both directions only when this is false.",
  years_since_last_sale:
    "DERIVED. Whole years between last_sale_date_any (NOT last_sale_date) and features_as_of. NULL only when has_sale_on_record is false.",
  no_sale_10y_flag:
    "DERIVED. True when last_sale_date_any is at least 10 years before features_as_of. NULL when no sale is on record, which must not be read as true.",
  roof_age_basis:
    "DERIVED. Evidence behind roof_year_est: PERMIT (a re-roof permit) or EFF_YR_BLT_PROXY / ACT_YR_BLT_PROXY (year built standing in because no county roof date exists).",
  water_basis: "DERIVED. Per row statement of how water_view_flag was reached, including the layer and the distance.",
  has_bbb_contractor: "Always NULL. BBB terms forbid aggregation and no contractor source resolves to a parcel; the column exists only to keep the canonical list complete.",
  hoa_flag: "Always NULL. Placeholder in the Elephant contract; no Duval source publishes it.",
  avm_value: "Always NULL. No automated valuation is published for Duval.",
  coordinates_source: "Which layer the centroid came from (parcel polygons, not rooftop points).",
  nearest_transit_stop_m: "DERIVED. Straight line (haversine) metres from the parcel centroid, not network walking distance.",
  nearest_starbucks_m: "DERIVED. Straight line (haversine) metres from the parcel centroid, not network walking distance.",
};

/** column -> family key, covering the family provenance columns themselves. */
export const QUERY_TABLE_COLUMN_FAMILY: ReadonlyMap<string, string> = new Map<string, string>([
  ...COLUMN_FAMILIES.flatMap((f) => f.columns.map((c) => [c, f.key] as [string, string])),
  ...SOURCE_FAMILIES.flatMap((f) => [
    [`${f.key}_source`, f.key] as [string, string],
    [`${f.key}_fetched_at`, f.key] as [string, string],
  ]),
]);

/**
 * Bump when the published column set or the provenance contract changes.
 * 3: adds tenure_quality (131 -> 132 columns), the demotion that used to live only in the UI.
 * 4: adds tenure_date_check (132 -> 133), so a client sees the contradiction behind the ordering.
 */
export const QUERY_TABLE_SCHEMA_VERSION = "4";

export interface QueryTableSchemaMetadata {
  county: string;
  schemaVersion: string;
  families: {
    key: string;
    label: string;
    sourceSystem: string | null;
    sourceUrl: string | null;
    sourceColumn: string | null;
    fetchedAtColumn: string | null;
    note: string | null;
    columns: string[];
  }[];
  columns: Record<string, { family: string; sourceSystem: string | null; note?: string }>;
}

/**
 * The schema and provenance dictionary that travels inside the parquet.
 *
 * The MCP builds its `properties` view with `DESCRIBE`, so `getPropertyQuerySchema` only ever sees
 * names and types. This is where the meaning lives, and it is written into the parquet's key-value
 * metadata so a consumer holding nothing but the file can map any column to the system that
 * produced it. Adding a column to derived.properties_features without adding it to a family here
 * fails the publish gate (see validateQueryTable), which is the point: an undocumented column has
 * no provenance.
 */
export function queryTableSchemaMetadata(): QueryTableSchemaMetadata {
  const families = COLUMN_FAMILIES.map((f) => {
    const source = f.track === null ? null : SOURCES[f.track];
    return {
      key: f.key,
      label: f.label,
      sourceSystem: source?.sourceSystem ?? null,
      sourceUrl: source?.url ?? null,
      sourceColumn: source === null ? null : `${f.key}_source`,
      fetchedAtColumn: source === null ? null : `${f.key}_fetched_at`,
      note: f.note ?? null,
      columns: [...f.columns],
    };
  });
  const byKey = new Map(families.map((f) => [f.key, f]));
  const columns: QueryTableSchemaMetadata["columns"] = {};
  for (const [column, familyKey] of QUERY_TABLE_COLUMN_FAMILY) {
    const note = QUERY_TABLE_COLUMN_NOTES[column];
    columns[column] = {
      family: familyKey,
      sourceSystem: byKey.get(familyKey)?.sourceSystem ?? null,
      ...(note === undefined ? {} : { note }),
    };
  }
  return { county: COUNTY.key, schemaVersion: QUERY_TABLE_SCHEMA_VERSION, families, columns };
}

export interface ExportResult {
  path: string;
  rows: number;
  bytes: number;
}

export async function exportQueryTable(conn: DuckDBConnection, outPath: string): Promise<ExportResult> {
  mkdirSync(dirname(outPath), { recursive: true });
  const cols = await tableColumns(conn, "derived", "properties_features");
  const extras = cols.filter((c) => !QUERY_TABLE_CANONICAL_COLUMNS.includes(c));
  const ordered = [...QUERY_TABLE_CANONICAL_COLUMNS.filter((c) => cols.includes(c)), ...extras];
  const kv = [
    `elephant_county: ${q(COUNTY.key)}`,
    `elephant_query_table_schema_version: ${q(QUERY_TABLE_SCHEMA_VERSION)}`,
    `elephant_column_provenance: ${q(JSON.stringify(queryTableSchemaMetadata()))}`,
  ].join(", ");
  await conn.run(
    `COPY (SELECT ${ordered.map(ident).join(", ")} FROM derived.properties_features ORDER BY request_identifier)
     TO ${q(duckPath(outPath))} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000, KV_METADATA {${kv}})`,
  );
  const rows = await count(conn, "derived.properties_features");
  return { path: outPath, rows, bytes: statSync(outPath).size };
}

export interface ColumnCoverage {
  column: string;
  nonNull: number;
  pct: number;
  /** Which provenance family owns the column, and the system behind it (null for derived/pipeline). */
  family: string;
  sourceSystem: string | null;
}

export interface ValidationReport {
  ok: boolean;
  parquetPath: string;
  rows: number;
  distinctFolios: number;
  nullFolios: number;
  dupFolios: number;
  sourceDistinctFolios: number;
  propertyCidFilled: number;
  missingCanonical: string[];
  /** Published columns with no provenance family; these fail the gate. */
  undocumentedColumns: string[];
  problems: string[];
  columns: ColumnCoverage[];
}

/**
 * The publish GATE (elephant conventions): parquet rows == distinct folios in the source DB,
 * 0 null / 0 duplicate folios, every canonical column present, and every published column mapped
 * to a provenance family. Also reports per-column coverage so NULL columns are named rather than
 * hidden.
 */
export async function validateQueryTable(conn: DuckDBConnection, parquetPath: string): Promise<ValidationReport> {
  const src = q(duckPath(parquetPath));
  const cols = (await all<{ column_name: string }>(conn, `DESCRIBE SELECT * FROM read_parquet(${src})`)).map(
    (r) => r.column_name,
  );
  const missingCanonical = QUERY_TABLE_CANONICAL_COLUMNS.filter((c) => !cols.includes(c));
  const base = await one<Record<string, string | number>>(
    conn,
    `SELECT count(*) AS rows,
            count(DISTINCT request_identifier) AS distinct_folios,
            count(*) FILTER (WHERE request_identifier IS NULL OR trim(request_identifier) = '') AS null_folios,
            count(property_cid) AS cid_filled
     FROM read_parquet(${src})`,
  );
  const dup = await one<{ n: string | number }>(
    conn,
    `SELECT count(*) AS n FROM (SELECT request_identifier FROM read_parquet(${src}) GROUP BY 1 HAVING count(*) > 1)`,
  );
  const sourceDistinct = Number(await one<{ n: string | number }>(conn, "SELECT count(DISTINCT parcel_id) AS n FROM parcels").then((r) => r.n));
  const rows = Number(base.rows);
  const covRow = await one<Record<string, string | number>>(
    conn,
    `SELECT ${cols.map((c) => `count(${ident(c)}) AS ${ident(c)}`).join(", ")} FROM read_parquet(${src})`,
  );
  const meta = queryTableSchemaMetadata();
  const columns: ColumnCoverage[] = cols.map((c) => {
    const nonNull = Number(covRow[c] ?? 0);
    const doc = meta.columns[c];
    return {
      column: c,
      nonNull,
      pct: rows === 0 ? 0 : Math.round((nonNull / rows) * 10000) / 100,
      family: doc?.family ?? "UNDOCUMENTED",
      sourceSystem: doc?.sourceSystem ?? null,
    };
  });
  const undocumentedColumns = columns.filter((c) => c.family === "UNDOCUMENTED").map((c) => c.column);

  const problems: string[] = [];
  const distinctFolios = Number(base.distinct_folios);
  const nullFolios = Number(base.null_folios);
  const dupFolios = Number(dup.n);
  if (rows !== sourceDistinct) problems.push(`parquet rows (${rows}) != distinct parcel_id in parcels (${sourceDistinct})`);
  if (rows !== distinctFolios) problems.push(`parquet rows (${rows}) != distinct request_identifier (${distinctFolios})`);
  if (nullFolios > 0) problems.push(`${nullFolios} null/blank request_identifier rows`);
  if (dupFolios > 0) problems.push(`${dupFolios} duplicated request_identifier values`);
  if (missingCanonical.length > 0) problems.push(`missing canonical columns: ${missingCanonical.join(", ")}`);
  if (undocumentedColumns.length > 0) {
    problems.push(
      `columns with no provenance family (add them to COLUMN_FAMILIES in features/build.ts): ${undocumentedColumns.join(", ")}`,
    );
  }

  return {
    ok: problems.length === 0,
    parquetPath,
    rows,
    distinctFolios,
    nullFolios,
    dupFolios,
    sourceDistinctFolios: sourceDistinct,
    propertyCidFilled: Number(base.cid_filled),
    missingCanonical,
    undocumentedColumns,
    problems,
    columns,
  };
}

/**
 * The published object name of the query table.
 *
 * This exact string has to appear in three places or the evidence stops joining up: the run
 * record's `artifacts.queryTable.path`, the publish plan's object name in publish/index.ts, and
 * therefore the `name` of the entry in the published artifacts index. The UI joins a run's
 * artifacts to that index on it, so a run that records the object under any other name (or under
 * no name at all) reads as an artifact that was never published.
 */
export const QUERY_TABLE_OBJECT = "query-table.parquet";

/** What a run record says about the query table it produced. */
export interface QueryTableArtifact {
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
  cid: string;
  cidV1: string;
  validationOk: boolean;
  problems: string[];
}

/**
 * Describe a freshly exported query table for a run record.
 *
 * Every pass that writes `query-table.parquet` must call this, not roll its own record: the
 * consolidation pass republishes the parquet seconds after the ingestion run and used to record
 * only `{ rows, propertyCidFilled }`, so the bytes it actually published were recorded nowhere and
 * could never be matched against the published artifacts index. One function means the two passes
 * cannot drift on the object name or on how the CID is computed.
 */
export async function describeQueryTableArtifact(
  exported: ExportResult,
  validation: ValidationReport,
): Promise<QueryTableArtifact> {
  const cid = await computeFileCid(exported.path);
  return {
    path: QUERY_TABLE_OBJECT,
    rows: exported.rows,
    bytes: exported.bytes,
    sha256: cid.sha256,
    cid: cid.cid,
    cidV1: cid.cidV1,
    validationOk: validation.ok,
    problems: validation.problems,
  };
}

export function formatValidation(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`=== QUERY TABLE VALIDATION (${r.ok ? "PASS" : "FAIL"}) ===`);
  lines.push(`parquet:            ${r.parquetPath}`);
  lines.push(`rows:               ${r.rows}`);
  lines.push(`distinct folios:    ${r.distinctFolios} (source parcels: ${r.sourceDistinctFolios})`);
  lines.push(`null folios:        ${r.nullFolios}`);
  lines.push(`duplicate folios:   ${r.dupFolios}`);
  lines.push(`property_cid:       ${r.propertyCidFilled} filled${r.propertyCidFilled < r.rows ? " (run export:consolidation to fill the rest)" : ""}`);
  if (r.problems.length > 0) lines.push(`problems:           ${r.problems.join("; ")}`);
  lines.push("per-column non-null coverage (family / source system the value came from):");
  const width = Math.max(...r.columns.map((c) => c.column.length));
  const famWidth = Math.max(...r.columns.map((c) => c.family.length));
  for (const c of r.columns) {
    lines.push(
      `  ${c.column.padEnd(width)}  ${String(c.nonNull).padStart(8)}  ${c.pct.toFixed(2).padStart(6)}%  ${c.family.padEnd(famWidth)}  ${c.sourceSystem ?? "-"}`,
    );
  }
  return lines.join("\n");
}

export interface EntityExport {
  table: string;
  path: string;
  rows: number;
  bytes: number;
}

export const ENTITY_TABLES = [
  "parcels",
  "parcel_geometry",
  "sales_history",
  "permits",
  "contractors",
  "businesses",
  "places",
  "transit_stops",
  "water_bodies",
  "address_points",
  "entity_links",
] as const;

/** Export every entity table (non-empty ones) as parquet for publication alongside the query table. */
export async function exportEntityTables(conn: DuckDBConnection, outDir: string): Promise<EntityExport[]> {
  mkdirSync(outDir, { recursive: true });
  const out: EntityExport[] = [];
  for (const table of ENTITY_TABLES) {
    const rows = await count(conn, table);
    if (rows === 0) continue;
    const path = join(outDir, `${table}.parquet`);
    const orderBy = table === "entity_links" ? "link_id" : (await tableColumns(conn, "main", table))[0] ?? "1";
    await conn.run(
      `COPY (SELECT * FROM ${table} ORDER BY ${ident(orderBy)}) TO ${q(duckPath(path))} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
    );
    out.push({ table, path, rows, bytes: statSync(path).size });
  }
  return out;
}
