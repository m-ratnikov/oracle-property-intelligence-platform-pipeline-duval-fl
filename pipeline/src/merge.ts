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

/**
 * Merge a hashed staging table into its target, reporting inserted / updated / unchanged /
 * missing-in-source counts. Unchanged rows keep their original provenance (fetched_at / run_id say
 * when that row version was last loaded). Rows missing from the new source snapshot are kept
 * (counted, not deleted) so a partial source window never erases history.
 */
export async function mergeStaging(
  conn: DuckDBConnection,
  opts: { target: string; staging: string; keys: string[] },
): Promise<MergeStats> {
  const { target, staging, keys } = opts;
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
  const stats = await one<Record<string, string | number>>(
    conn,
    `SELECT
       count(*) FILTER (WHERE t.${firstKey} IS NULL AND s.${firstKey} IS NOT NULL) AS inserted,
       count(*) FILTER (WHERE t.${firstKey} IS NOT NULL AND s.${firstKey} IS NOT NULL AND t.row_hash <> s.row_hash) AS updated,
       count(*) FILTER (WHERE t.${firstKey} IS NOT NULL AND s.${firstKey} IS NOT NULL AND t.row_hash = s.row_hash) AS unchanged,
       count(*) FILTER (WHERE s.${firstKey} IS NULL AND t.${firstKey} IS NOT NULL) AS missing
     FROM ${staging} s FULL OUTER JOIN ${target} t ON ${keyEq("s", "t", keys)}`,
  );

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(
      `DELETE FROM ${target} t WHERE EXISTS (
         SELECT 1 FROM ${staging} s WHERE ${keyEq("s", "t", keys)} AND s.row_hash <> t.row_hash)`,
    );
    await conn.run(
      `INSERT INTO ${target} BY NAME
       SELECT s.* FROM ${staging} s
       WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE ${keyEq("s", "t", keys)})`,
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }

  const totalAfter = Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${target}`));
  const dupAfter = await all<{ n: string | number }>(
    conn,
    `SELECT count(*) AS n FROM (SELECT ${keys.map(ident).join(", ")} FROM ${target} GROUP BY ALL HAVING count(*) > 1)`,
  );
  if (Number(dupAfter[0]?.n ?? 0) > 0) {
    throw new Error(`Target ${target} has duplicate keys after merge; invariant violated`);
  }

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
