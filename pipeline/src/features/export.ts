import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { all, count, duckPath, ident, one, q, tableColumns } from "../db.js";
import { computeFileCid } from "../publish/cid.js";

/** The 37 canonical query-table columns, in elephant-query-db run-query-table-export.ts order. */
export const QUERY_TABLE_CANONICAL_COLUMNS: readonly string[] = [
  "property_id", "property_cid", "request_identifier", "parcel_identifier", "source_system", "county_name",
  "state_code", "address_street", "address_city", "address_zip", "latitude", "longitude", "lot_size_acre",
  "lot_area_sqft", "exterior_wall_material", "roof_covering_material", "property_type", "property_usage_type",
  "built_year", "livable_floor_area", "total_area", "assessed_value", "market_value", "land_value", "avm_value",
  "owner_name", "owners_text", "owner_count", "owner_occupied", "last_sale_date", "last_sale_price", "subdivision",
  "has_permits", "permit_count", "has_sunbiz_tenant", "has_bbb_contractor", "hoa_flag",
];

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
  await conn.run(
    `COPY (SELECT ${ordered.map(ident).join(", ")} FROM derived.properties_features ORDER BY request_identifier)
     TO ${q(duckPath(outPath))} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
  );
  const rows = await count(conn, "derived.properties_features");
  return { path: outPath, rows, bytes: statSync(outPath).size };
}

export interface ColumnCoverage {
  column: string;
  nonNull: number;
  pct: number;
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
  problems: string[];
  columns: ColumnCoverage[];
}

/**
 * The publish GATE (elephant conventions): parquet rows == distinct folios in the source DB,
 * 0 null / 0 duplicate folios, every canonical column present. Also reports per-column coverage so
 * NULL columns are named rather than hidden.
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
  const columns: ColumnCoverage[] = cols.map((c) => {
    const nonNull = Number(covRow[c] ?? 0);
    return { column: c, nonNull, pct: rows === 0 ? 0 : Math.round((nonNull / rows) * 10000) / 100 };
  });

  const problems: string[] = [];
  const distinctFolios = Number(base.distinct_folios);
  const nullFolios = Number(base.null_folios);
  const dupFolios = Number(dup.n);
  if (rows !== sourceDistinct) problems.push(`parquet rows (${rows}) != distinct parcel_id in parcels (${sourceDistinct})`);
  if (rows !== distinctFolios) problems.push(`parquet rows (${rows}) != distinct request_identifier (${distinctFolios})`);
  if (nullFolios > 0) problems.push(`${nullFolios} null/blank request_identifier rows`);
  if (dupFolios > 0) problems.push(`${dupFolios} duplicated request_identifier values`);
  if (missingCanonical.length > 0) problems.push(`missing canonical columns: ${missingCanonical.join(", ")}`);

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
  lines.push("per-column non-null coverage:");
  const width = Math.max(...r.columns.map((c) => c.column.length));
  for (const c of r.columns) {
    lines.push(`  ${c.column.padEnd(width)}  ${String(c.nonNull).padStart(8)}  ${c.pct.toFixed(2).padStart(6)}%`);
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
