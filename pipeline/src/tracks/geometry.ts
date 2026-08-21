import { join } from "node:path";
import { all, duckPath, loadSpatial, one, q, scalar } from "../db.js";
import { downloadArtifact } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";
import { listZipEntries } from "./zip.js";

/**
 * FDOR PAR shapefile -> parcel_geometry (centroid lat/lon, area, bbox), then parcels.latitude /
 * longitude are refreshed from it. Reads straight out of the zip via GDAL's /vsizip/ handler, so the
 * 1 GB uncompressed shapefile is never extracted to disk.
 */
export const runGeometry: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "geometry");

  const artifact = await downloadArtifact({
    url: source.url,
    destDir,
    artifactsRoot: ctx.paths.artifactsDir,
    force: ctx.force,
    logger: log,
  });
  result.artifact = artifact;

  const shp = listZipEntries(artifact.path).find((e) => e.name.toLowerCase().endsWith(".shp"));
  if (shp === undefined) throw new Error(`No .shp entry inside ${artifact.path}`);
  const vsiPath = `/vsizip/${duckPath(artifact.path)}/${shp.name}`;

  await loadSpatial(ctx.conn);
  const meta = await one<{ feature_count: string | number; crs_wkt: string | null; crs_auth: string | null; crs_code: string | null; geom_field: string }>(
    ctx.conn,
    `SELECT layers[1].feature_count AS feature_count,
            layers[1].geometry_fields[1].crs.wkt AS crs_wkt,
            layers[1].geometry_fields[1].crs.auth_name AS crs_auth,
            layers[1].geometry_fields[1].crs.auth_code AS crs_code,
            layers[1].geometry_fields[1].name AS geom_field
     FROM ST_Read_Meta(${q(vsiPath)})`,
  );
  const crsLabel =
    meta.crs_auth && meta.crs_code ? `${meta.crs_auth}:${meta.crs_code}` : "NAD83(HARN) / Florida East (ftUS) [EPSG:2881]";
  const crsForTransform = meta.crs_auth && meta.crs_code ? `${meta.crs_auth}:${meta.crs_code}` : (meta.crs_wkt ?? "EPSG:2881");
  result.notes.shapefile = shp.name;
  result.notes.featureCount = Number(meta.feature_count);
  result.notes.sourceCrs = crsLabel;
  log.info("shapefile_meta", { shp: shp.name, features: Number(meta.feature_count), crs: crsLabel });

  const limitRaw = ctx.env.GEOMETRY_LIMIT?.trim();
  const limit = limitRaw !== undefined && limitRaw !== "" ? Number(limitRaw) : null;
  if (limit !== null) result.limitations.push(`GEOMETRY_LIMIT=${limit}: only the first ${limit} shapes were loaded (dev mode)`);
  const geomCol = meta.geom_field && meta.geom_field.length > 0 ? meta.geom_field : "geom";

  const started = Date.now();
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.parcel_geometry AS
    WITH src AS (
      SELECT TRIM(PARCELNO) AS parcel_id, ${geomCol} AS geom
      FROM ST_Read(${q(vsiPath)})
      WHERE PARCELNO IS NOT NULL AND TRIM(PARCELNO) <> ''
      ${limit !== null ? `LIMIT ${limit}` : ""}
    ),
    ranked AS (
      SELECT parcel_id, geom, ST_Area(geom) AS area_sqft,
             row_number() OVER (PARTITION BY parcel_id ORDER BY ST_Area(geom) DESC) AS rn,
             count(*) OVER (PARTITION BY parcel_id) AS parts
      FROM src
    ),
    t AS (
      SELECT parcel_id, area_sqft, parts,
             ST_Transform(ST_Centroid(geom), ${q(crsForTransform)}, 'EPSG:4326', always_xy := true) AS c,
             ST_Transform(ST_Envelope(geom), ${q(crsForTransform)}, 'EPSG:4326', always_xy := true) AS env,
             ST_GeometryType(geom)::VARCHAR AS geometry_type
      FROM ranked WHERE rn = 1
    )
    SELECT parcel_id,
           round(ST_Y(c), 7) AS latitude, round(ST_X(c), 7) AS longitude,
           round(area_sqft, 2) AS area_sqft,
           round(ST_XMin(env), 7) AS min_lon, round(ST_YMin(env), 7) AS min_lat,
           round(ST_XMax(env), 7) AS max_lon, round(ST_YMax(env), 7) AS max_lat,
           geometry_type,
           ${q(crsLabel)} AS source_crs
    FROM t
  `);
  const staged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.parcel_geometry"));
  result.rowsStaged = staged;
  result.notes.readMs = Date.now() - started;
  log.info("staged", { table: "staging.parcel_geometry", rows: staged, ms: result.notes.readMs });

  const hashed = await hashStaging(ctx.conn, "staging.parcel_geometry", {
    sourceSystem: source.sourceSystem,
    sourceUrl: source.url,
    sourceArtifact: artifact.relPath,
    sourceSha256: artifact.sha256,
    fetchedAt: artifact.fetchedAt,
    runId: ctx.runId,
  });
  result.merge = await mergeStaging(ctx.conn, { target: "parcel_geometry", staging: hashed, keys: ["parcel_id"] });
  log.info("merged", { table: "parcel_geometry", ...result.merge });

  // Propagate centroids onto parcels (coordinates are not part of the parcel content hash).
  await ctx.conn.run(`
    UPDATE parcels p SET latitude = g.latitude, longitude = g.longitude, geometry_source = g.source_system
    FROM parcel_geometry g
    WHERE g.parcel_id = p.parcel_id
      AND (p.latitude IS DISTINCT FROM g.latitude OR p.longitude IS DISTINCT FROM g.longitude)`);
  const joined = await all<{ with_coords: string | number; total: string | number }>(
    ctx.conn,
    "SELECT count(*) FILTER (WHERE latitude IS NOT NULL) AS with_coords, count(*) AS total FROM parcels",
  );
  result.notes.parcelsWithCoordinates = Number(joined[0]?.with_coords ?? 0);
  result.notes.parcelsTotal = Number(joined[0]?.total ?? 0);
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
