import { join } from "node:path";
import { all, duckPath, q, scalar } from "../db.js";
import { downloadArtifact } from "../download.js";
import { nearestNeighbourSql } from "../features/nn.js";
import { hashStaging, mergeStaging } from "../merge.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";
import { extractEntry } from "./zip.js";

/** GTFS route_type codes (static GTFS spec). */
export const GTFS_ROUTE_TYPES: Record<number, string> = {
  0: "tram", 1: "subway/people mover", 2: "rail", 3: "bus", 4: "ferry", 5: "cable tram", 6: "aerial lift", 7: "funicular", 11: "trolleybus", 12: "monorail",
};

/** JTA GTFS -> transit_stops (+ routes served) and transit_routes; nearest stop per parcel. */
export const runTransit: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "transit");
  const artifact = await downloadArtifact({ url: source.url, destDir, artifactsRoot: ctx.paths.artifactsDir, fileName: "gtfs.zip", force: ctx.force, logger: log });
  result.artifact = artifact;

  const ex = join(destDir, "extracted");
  const stops = extractEntry({ zipPath: artifact.path, outDir: ex, extension: "stops.txt", force: artifact.status === "downloaded" });
  const routes = extractEntry({ zipPath: artifact.path, outDir: ex, extension: "routes.txt", force: artifact.status === "downloaded" });
  const trips = extractEntry({ zipPath: artifact.path, outDir: ex, extension: "trips.txt", force: artifact.status === "downloaded" });
  const stopTimes = extractEntry({ zipPath: artifact.path, outDir: ex, extension: "stop_times.txt", force: artifact.status === "downloaded" });
  const feedVersion = artifact.lastModified ?? artifact.sha256.slice(0, 12);

  const csv = (p: string) => `read_csv(${q(duckPath(p))}, header = true, all_varchar = true)`;
  const typeCase = `CASE route_type ${Object.entries(GTFS_ROUTE_TYPES).map(([k, v]) => `WHEN ${k} THEN ${q(v)}`).join(" ")} ELSE 'other' END`;
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.transit_routes AS
    SELECT route_id, NULLIF(route_short_name, '') AS route_short_name, NULLIF(route_long_name, '') AS route_long_name,
           TRY_CAST(route_type AS INTEGER) AS route_type,
           (SELECT ${typeCase} FROM (SELECT TRY_CAST(r.route_type AS INTEGER) AS route_type)) AS route_type_name,
           NULLIF(route_color, '') AS route_color, ${q(feedVersion)} AS feed_version
    FROM ${csv(routes.path)} r`);
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.transit_stops AS
    WITH served AS (
      SELECT st.stop_id,
             list_sort(list_distinct(list(r.route_type))) AS types,
             list_sort(list_distinct(list(coalesce(r.route_short_name, r.route_id)))) AS names
      FROM (SELECT DISTINCT trip_id, stop_id FROM ${csv(stopTimes.path)}) st
      JOIN ${csv(trips.path)} t ON t.trip_id = st.trip_id
      JOIN staging.transit_routes r ON r.route_id = t.route_id
      GROUP BY st.stop_id)
    SELECT s.stop_id, NULLIF(s.stop_code, '') AS stop_code, NULLIF(s.stop_name, '') AS stop_name,
           TRY_CAST(s.stop_lat AS DOUBLE) AS latitude, TRY_CAST(s.stop_lon AS DOUBLE) AS longitude,
           NULLIF(s.location_type, '') AS location_type, NULLIF(s.wheelchair_boarding, '') AS wheelchair_boarding,
           array_to_string(list_transform(sv.types, x -> x::VARCHAR), ',') AS route_types,
           array_to_string(sv.names, ',') AS route_short_names,
           length(sv.names) AS route_count,
           ${q(feedVersion)} AS feed_version
    FROM ${csv(stops.path)} s LEFT JOIN served sv ON sv.stop_id = s.stop_id
    WHERE s.stop_id IS NOT NULL AND s.stop_id <> ''`);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.transit_stops"));
  const routeCount = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.transit_routes"));
  const typeMix = await all<{ route_type_name: string; n: string | number }>(ctx.conn, "SELECT route_type_name, count(*) AS n FROM staging.transit_routes GROUP BY 1 ORDER BY 2 DESC");
  result.notes.routes = routeCount;
  result.notes.routeTypes = Object.fromEntries(typeMix.map((r) => [r.route_type_name, Number(r.n)]));
  result.notes.stopsWithoutService = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.transit_stops WHERE route_count IS NULL"));
  log.info("staged", { stops: result.rowsStaged, routes: routeCount, routeTypes: result.notes.routeTypes });

  const prov = { sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: artifact.relPath, sourceSha256: artifact.sha256, fetchedAt: artifact.fetchedAt, runId: ctx.runId };
  const hr = await hashStaging(ctx.conn, "staging.transit_routes", prov);
  const mr = await mergeStaging(ctx.conn, { target: "transit_routes", staging: hr, keys: ["route_id"] });
  result.notes.routesMerge = mr;
  const hs = await hashStaging(ctx.conn, "staging.transit_stops", prov);
  result.merge = await mergeStaging(ctx.conn, { target: "transit_stops", staging: hs, keys: ["stop_id"] });
  log.info("merged", { table: "transit_stops", ...result.merge });

  const nn = await nearestNeighbourSql(ctx.conn, {
    outTable: "nn_transit",
    pointSql: "SELECT stop_id AS id, stop_name AS name, latitude, longitude, route_types, route_short_names FROM transit_stops",
    extraColumns: ["route_types", "route_short_names"],
    prefix: "nearest_transit_stop",
  });
  result.notes.nearest = nn;
  log.info("nearest_transit_computed", { ...nn });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
