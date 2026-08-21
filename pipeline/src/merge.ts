import type { DuckDBConnection } from "@duckdb/node-api";
import { PROVENANCE_COLUMN_NAMES, all, ident, one, q, scalar, tableColumns } from "./db.js";

export interface Provenance {
  sourceSystem: string;
  sourceUrl: string | null;
  sourceArtifact: string | null;
  sourceSha256: string | null;
  fetchedAt: string;
  runId: string;
}

export interface MergeStats {
  staged: number;
  inserted: number;
  updated: number;
  unchanged: number;
  missingInSource: number;
  totalBefore: number;
  totalAfter: number;
}

function keyEq(a: string, b: string, keys: string[]): string {
  return keys.map((k) => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(" AND ");
}

/**
 * Add `row_hash` (md5 of the JSON form of the content row, so any content change flips it) and the
 * provenance columns to a staging table. Returns the name of the hashed staging table.
 */
export async function hashStaging(
  conn: DuckDBConnection,
  stagingTable: string,
  prov: Provenance,
): Promise<string> {
  const hashed = `${stagingTable}__h`;
  await conn.run(`
    CREATE OR REPLACE TABLE ${hashed} AS
    SELECT s.*,
           md5(to_json(s)::VARCHAR) AS row_hash,
           ${q(prov.sourceSystem)}::VARCHAR AS source_system,
           ${q(prov.sourceUrl)}::VARCHAR AS source_url,
           ${q(prov.sourceArtifact)}::VARCHAR AS source_artifact,
           ${q(prov.sourceSha256)}::VARCHAR AS source_sha256,
           ${q(prov.fetchedAt)}::TIMESTAMP AS fetched_at,
           ${q(prov.runId)}::VARCHAR AS run_id
    FROM ${stagingTable} s`);
  return hashed;
}

/** A DuckDB-safe temp-table name derived from a target table name. */
function tempName(target: string): string {
  return `__merge_new_${target.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * Merge a hashed staging table into its target, reporting inserted / updated / unchanged /
 * missing-in-source counts. Unchanged rows keep their original provenance (fetched_at / run_id say
 * when that row version was last loaded). Rows missing from the new source snapshot are kept
 * (counted, not deleted) so a partial source window never erases history.
 *
 * An update overwrites only the columns the staging table actually carries. Everything is written
 * as delete-then-insert (DuckDB has no UPDATE ... FROM by natural key here), so the replacement row
 * is built first, taking staged columns from the staging row and every other target column from the
 * row being replaced. Without that, a track staging a subset of the columns would NULL the rest:
 * `sales_history` is written by both the sales track and pa_detail with different column sets, and
 * whichever ran last would blank the other's columns.
 *
 * `missingInSource` only means "the source dropped a row we hold" while two things are true: this
 * staging table is the whole of what the source offered, and this track is the only writer of the
 * target. Neither holds everywhere here. `sales_history` is written by the sales track and by
 * pa_detail, so each would count the other's rows as missing, and the pa_detail merges stage one
 * bounded window per run, so every row loaded by an earlier window would count as missing too.
 * `authoritativeScope` fixes that: it is a SQL predicate over the target row (alias `t`) naming the
 * rows this staging table is authoritative over, and it narrows the missing count to those rows
 * only. It deliberately touches nothing else - inserted / updated / unchanged and the delete and
 * insert behaviour are all unscoped, because the merge really is authoritative over any key it
 * stages, wherever that row came from. `totalBefore` / `totalAfter` stay whole-table counts: the
 * run log calls them table totals and that is what they should say.
 */
export async function mergeStaging(
  conn: DuckDBConnection,
  opts: { target: string; staging: string; keys: string[]; authoritativeScope?: string },
): Promise<MergeStats> {
  const { target, staging, keys, authoritativeScope } = opts;
  const [stgSchema, stgTable] = staging.includes(".") ? staging.split(".") : ["main", staging];
  const stagingCols = await tableColumns(conn, stgSchema ?? "main", stgTable ?? staging);
  const targetCols = await tableColumns(conn, "main", target);
  const missingInTarget = stagingCols.filter((c) => !targetCols.includes(c));
  if (missingInTarget.length > 0) {
    throw new Error(
      `Schema drift: staging ${staging} has columns not present in ${target}: ${missingInTarget.join(", ")}`,
    );
  }
  for (const p of PROVENANCE_COLUMN_NAMES) {
    if (!stagingCols.includes(p)) throw new Error(`Staging ${staging} lacks provenance column ${p}; call hashStaging first`);
  }

  const dupKeys = Number(
    await scalar<string | number>(
      conn,
      `SELECT count(*) FROM (SELECT ${keys.map(ident).join(", ")} FROM ${staging} GROUP BY ALL HAVING count(*) > 1)`,
    ),
  );
  if (dupKeys > 0) {
    throw new Error(`Staging ${staging} has ${dupKeys} duplicate natural keys (${keys.join(",")}); refusing to merge`);
  }
  const nullKeys = Number(
    await scalar<string | number>(
      conn,
      `SELECT count(*) FROM ${staging} WHERE ${keys.map((k) => `${ident(k)} IS NULL`).join(" OR ")}`,
    ),
  );
  if (nullKeys > 0) throw new Error(`Staging ${staging} has ${nullKeys} rows with NULL keys; refusing to merge`);

  const totalBefore = Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${target}`));
  const staged = Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${staging}`));

  const firstKey = ident(keys[0] ?? "");
  const inScope = authoritativeScope === undefined ? "TRUE" : `coalesce(${authoritativeScope}, false)`;
  const stats = await one<Record<string, string | number>>(
    conn,
    `SELECT
       count(*) FILTER (WHERE t.${firstKey} IS NULL AND s.${firstKey} IS NOT NULL) AS inserted,
       count(*) FILTER (WHERE t.${firstKey} IS NOT NULL AND s.${firstKey} IS NOT NULL AND t.row_hash <> s.row_hash) AS updated,
       count(*) FILTER (WHERE t.${firstKey} IS NOT NULL AND s.${firstKey} IS NOT NULL AND t.row_hash = s.row_hash) AS unchanged,
       count(*) FILTER (WHERE s.${firstKey} IS NULL AND t.${firstKey} IS NOT NULL AND ${inScope}) AS missing
     FROM ${staging} s FULL OUTER JOIN ${target} t ON ${keyEq("s", "t", keys)}`,
  );

  // Build the replacement rows before anything is deleted: staged columns come from the staging row,
  // every other target column is carried over from the row being replaced (NULL for a brand-new key).
  const stagedCols = new Set(stagingCols);
  const newRows = tempName(target);
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE ${newRows} AS
    SELECT ${targetCols.map((c) => `${stagedCols.has(c) ? "s" : "t"}.${ident(c)} AS ${ident(c)}`).join(", ")}
    FROM ${staging} s LEFT JOIN ${target} t ON ${keyEq("s", "t", keys)}
    WHERE t.${firstKey} IS NULL OR t.row_hash IS DISTINCT FROM s.row_hash`);

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(
      `DELETE FROM ${target} t WHERE EXISTS (SELECT 1 FROM ${newRows} n WHERE ${keyEq("n", "t", keys)})`,
    );
    await conn.run(`INSERT INTO ${target} BY NAME SELECT * FROM ${newRows}`);
    // Inside the transaction on purpose: after COMMIT the offending rows are already durable.
    const dupAfter = await all<{ n: string | number }>(
      conn,
      `SELECT count(*) AS n FROM (SELECT ${keys.map(ident).join(", ")} FROM ${target} GROUP BY ALL HAVING count(*) > 1)`,
    );
    if (Number(dupAfter[0]?.n ?? 0) > 0) {
      throw new Error(`Target ${target} has duplicate keys after merge; invariant violated`);
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  } finally {
    await conn.run(`DROP TABLE IF EXISTS ${newRows}`).catch(() => undefined);
  }

  const totalAfter = Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${target}`));

  return {
    staged,
    inserted: Number(stats.inserted),
    updated: Number(stats.updated),
    unchanged: Number(stats.unchanged),
    missingInSource: Number(stats.missing),
    totalBefore,
    totalAfter,
  };
}

/**
 * Validate an incoming header against the expected one. Missing columns are always fatal (schema
 * drift breaks the transform); new unknown columns are fatal unless explicitly allowed, because an
 * unreviewed column means data we silently fail to extract.
 */
export function assertHeader(opts: {
  expected: readonly string[];
  actual: readonly string[];
  source: string;
  allowNewColumns?: boolean;
}): { newColumns: string[] } {
  const actualSet = new Set(opts.actual.map((c) => c.toUpperCase()));
  const expectedSet = new Set(opts.expected.map((c) => c.toUpperCase()));
  const missing = opts.expected.filter((c) => !actualSet.has(c.toUpperCase()));
  const extra = opts.actual.filter((c) => !expectedSet.has(c.toUpperCase()));
  if (missing.length > 0) {
    throw new Error(`Schema drift in ${opts.source}: missing expected columns ${missing.join(", ")}`);
  }
  if (extra.length > 0 && !opts.allowNewColumns) {
    throw new Error(
      `Schema drift in ${opts.source}: unexpected new columns ${extra.join(", ")} (set ALLOW_NEW_COLUMNS=1 to proceed)`,
    );
  }
  return { newColumns: extra };
}
