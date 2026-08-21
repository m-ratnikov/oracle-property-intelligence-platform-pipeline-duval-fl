import type { DuckDBConnection } from "@duckdb/node-api";
import { scalar } from "../db.js";

/**
 * Nearest-neighbour (great-circle) from every parcel centroid to a small point set (transit stops,
 * Starbucks...). Two stages, all in DuckDB:
 *   1. grid join: points bucketed in `cellDeg` cells, each parcel compared with the 3x3 cell
 *      neighbourhood (guarantees every point within one cell size is a candidate);
 *   2. parcels with no candidate in stage 1 fall back to a brute-force pass (few, rural).
 * Result table `derived.<outTable>` has parcel_id, <prefix>_m, <prefix>_id, <prefix>_name (+ extra cols).
 */
export async function nearestNeighbourSql(
  conn: DuckDBConnection,
  opts: {
    outTable: string;
    pointSql: string; // SELECT id, name, latitude, longitude[, extra...] FROM ...
    extraColumns?: string[]; // extra columns of pointSql to carry over
    prefix: string;
    cellDeg?: number;
  },
): Promise<{ parcels: number; withNeighbour: number; fallback: number }> {
  const cell = opts.cellDeg ?? 0.02;
  const extras = opts.extraColumns ?? [];
  const extraSel = extras.map((c) => `, pt.${c} AS ${opts.prefix}_${c}`).join("");
  const extraSelF = extras.map((c) => `, f.${opts.prefix}_${c}`).join("");
  const dist = `ST_Distance_Sphere(ST_Point(p.longitude, p.latitude), ST_Point(pt.longitude, pt.latitude))`;

  await conn.run("LOAD spatial");
  await conn.run(`CREATE OR REPLACE TEMP TABLE nn_points AS
    SELECT *, floor(latitude / ${cell})::BIGINT AS cy, floor(longitude / ${cell})::BIGINT AS cx FROM (${opts.pointSql}) WHERE latitude IS NOT NULL AND longitude IS NOT NULL`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE nn_parcels AS
    SELECT parcel_id, latitude, longitude, floor(latitude / ${cell})::BIGINT AS cy, floor(longitude / ${cell})::BIGINT AS cx
    FROM parcels WHERE latitude IS NOT NULL AND longitude IS NOT NULL`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE nn_stage1 AS
    SELECT p.parcel_id, pt.id AS ${opts.prefix}_id, pt.name AS ${opts.prefix}_name, ${dist} AS ${opts.prefix}_m ${extraSel}
    FROM nn_parcels p
    JOIN (SELECT * FROM nn_points) pt
      ON pt.cy BETWEEN p.cy - 1 AND p.cy + 1 AND pt.cx BETWEEN p.cx - 1 AND p.cx + 1
    QUALIFY row_number() OVER (PARTITION BY p.parcel_id ORDER BY ${opts.prefix}_m) = 1`);
  await conn.run(`CREATE OR REPLACE TEMP TABLE nn_fallback AS
    SELECT p.parcel_id, pt.id AS ${opts.prefix}_id, pt.name AS ${opts.prefix}_name, ${dist} AS ${opts.prefix}_m ${extraSel}
    FROM nn_parcels p
    CROSS JOIN nn_points pt
    WHERE p.parcel_id NOT IN (SELECT parcel_id FROM nn_stage1)
    QUALIFY row_number() OVER (PARTITION BY p.parcel_id ORDER BY ${opts.prefix}_m) = 1`);
  await conn.run(`CREATE OR REPLACE TABLE derived.${opts.outTable} AS
    SELECT parcel_id, round(${opts.prefix}_m, 1) AS ${opts.prefix}_m, ${opts.prefix}_id, ${opts.prefix}_name ${extraSelF.replace(/f\./g, "")}
    FROM (SELECT * FROM nn_stage1 UNION ALL SELECT * FROM nn_fallback) f`);
  const parcels = Number(await scalar(conn, "SELECT count(*) FROM nn_parcels"));
  const withNeighbour = Number(await scalar(conn, `SELECT count(*) FROM derived.${opts.outTable}`));
  const fallback = Number(await scalar(conn, "SELECT count(*) FROM nn_fallback"));
  await conn.run("DROP TABLE IF EXISTS nn_points; DROP TABLE IF EXISTS nn_parcels; DROP TABLE IF EXISTS nn_stage1; DROP TABLE IF EXISTS nn_fallback");
  return { parcels, withNeighbour, fallback };
}
