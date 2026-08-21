import { q, scalar, all } from "../db.js";
import { nearestNeighbourSql } from "../features/nn.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { DUVAL_BBOX } from "../sources.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const OVERTURE_RELEASE = "2026-08-19.0";
/** Categories kept beyond the Starbucks question (for later UI use). */
export const PLACE_CATEGORIES = [
  "coffee_shop", "cafe", "grocery_store", "supermarket", "pharmacy", "school", "elementary_school", "middle_school",
  "high_school", "public_school", "private_school", "hospital", "restaurant", "fast_food_restaurant",
];

/**
 * Overture Maps places (anonymous S3 via DuckDB httpfs) -> places; nearest Starbucks per parcel.
 * The release is pinned in the source URL; a new release changes source_url and re-stages everything
 * (GERS ids are stable, so the merge reports true inserted/updated/unchanged counts).
 */
export const runPlaces: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const release = /release\/([^/]+)\//.exec(source.url)?.[1] ?? OVERTURE_RELEASE;
  await ctx.conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET s3_access_key_id=''; SET s3_secret_access_key='';");
  const started = Date.now();
  const cats = PLACE_CATEGORIES.map((c) => q(c)).join(",");
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.places AS
    SELECT id AS place_id,
           names.primary AS name,
           categories.primary AS category_primary,
           to_json(categories) AS categories,
           brand.names.primary AS brand,
           addresses[1].freeform AS address,
           addresses[1].locality AS locality,
           addresses[1].postcode AS postcode,
           round((bbox.ymin + bbox.ymax) / 2, 7) AS latitude,
           round((bbox.xmin + bbox.xmax) / 2, 7) AS longitude,
           confidence,
           to_json(sources) AS sources,
           (names.primary ILIKE '%starbucks%' OR brand.names.primary ILIKE '%starbucks%') AS is_starbucks,
           ${q(release)} AS release
    FROM read_parquet(${q(source.url)}, hive_partitioning = 1)
    WHERE bbox.xmin BETWEEN ${DUVAL_BBOX.minLon} AND ${DUVAL_BBOX.maxLon}
      AND bbox.ymin BETWEEN ${DUVAL_BBOX.minLat} AND ${DUVAL_BBOX.maxLat}
      AND (categories.primary IN (${cats}) OR names.primary ILIKE '%starbucks%' OR brand.names.primary ILIKE '%starbucks%')`);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.places"));
  const byCat = await all<{ category_primary: string; n: string | number }>(ctx.conn, "SELECT category_primary, count(*) AS n FROM staging.places GROUP BY 1 ORDER BY 2 DESC");
  result.notes.readMs = Date.now() - started;
  result.notes.byCategory = Object.fromEntries(byCat.map((r) => [r.category_primary ?? "null", Number(r.n)]));
  result.notes.starbucks = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.places WHERE is_starbucks"));
  result.notes.release = release;
  log.info("staged", { rows: result.rowsStaged, starbucks: result.notes.starbucks, ms: result.notes.readMs });

  const hashed = await hashStaging(ctx.conn, "staging.places", {
    sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: `overture/${release}`,
    sourceSha256: null, fetchedAt: new Date().toISOString(), runId: ctx.runId,
  });
  result.merge = await mergeStaging(ctx.conn, { target: "places", staging: hashed, keys: ["place_id"] });
  log.info("merged", { table: "places", ...result.merge });

  const nn = await nearestNeighbourSql(ctx.conn, {
    outTable: "nn_starbucks",
    pointSql: "SELECT place_id AS id, name, latitude, longitude FROM places WHERE is_starbucks",
    prefix: "nearest_starbucks",
    cellDeg: 0.05,
  });
  result.notes.nearest = nn;
  log.info("nearest_starbucks_computed", { ...nn });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
