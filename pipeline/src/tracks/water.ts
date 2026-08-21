import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, duckPath, loadSpatial, q, scalar } from "../db.js";
import { downloadArtifact, sha256File } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { DUVAL_BBOX } from "../sources.js";
import { getJson } from "./http.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";
import { listZipEntries } from "./zip.js";

export const AGO_LAYERS = [
  { name: "stjohnsriver", url: "https://services1.arcgis.com/NXfNVaFp7QMxnE3j/arcgis/rest/services/stjohnsriver/FeatureServer/0" },
  { name: "jax_river", url: "https://services1.arcgis.com/NXfNVaFp7QMxnE3j/arcgis/rest/services/Jax_River/FeatureServer/0" },
] as const;
export const NHD_URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU4/GDB/NHD_H_0307_HU4_GDB.zip";
/** NHD FType codes kept. */
export const NHD_KEEP = {
  NHDWaterbody: { 390: "lake/pond", 436: "reservoir", 493: "estuary" },
  NHDArea: { 460: "stream/river (area)", 445: "sea/ocean", 312: "bay/inlet", 336: "canal/ditch (area)", 364: "foreshore", 403: "inundation area", 431: "rapids", 455: "spillway", 484: "wash" },
  NHDFlowline: { 460: "stream/river", 558: "artificial path" },
} as const;
/** Metric CRS used for buffers/distances (UTM 17N, metres). */
export const METRIC_CRS = "EPSG:26917";
export const WATER_VIEW_DIST_M = 150;
export const WATER_BUFFER_M = 30;
/** Grid neighbourhood used for the vertex search (3 x 0.01 deg, about 1.1 km). */
export const WATER_SEARCH_M = 1100;

/**
 * COJ river polygons (AGO geojson, EPSG:4326 requested) + USGS NHD (waterbody/area/flowline in the Duval
 * bbox, read from the FileGDB inside the zip via /vsizip/) -> water_bodies (WKB, 4326). Then per-parcel
 * distance to the nearest water feature within 2 km (derived.water_distance) using a metric CRS.
 */
export const runWater: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "water");
  mkdirSync(destDir, { recursive: true });
  await loadSpatial(ctx.conn);
  const bb = DUVAL_BBOX;
  const fetchedAt = new Date().toISOString();
  const stagingParts: string[] = [];

  // 1. COJ AGO layers (small; fetched every run, hashed)
  for (const layer of AGO_LAYERS) {
    const url = `${layer.url}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`;
    const r = await getJson<{ features?: unknown[] }>(url, { retries: 3, timeoutMs: 120_000 });
    if (!r.ok || r.text === null) {
      result.limitations.push(`${layer.name}: fetch failed (${r.error})`);
      continue;
    }
    const path = join(destDir, `${layer.name}.geojson`);
    writeFileSync(path, r.text);
    const sha = await sha256File(path);
    result.notes[`${layer.name}_features`] = r.body?.features?.length ?? 0;
    result.notes[`${layer.name}_sha256`] = sha;
    stagingParts.push(`
      SELECT 'coj:' || ${q(layer.name)} || ':' || OGC_FID::VARCHAR AS water_id,
             coalesce(${layer.name === "stjohnsriver" ? "'St. Johns River'" : "'Jacksonville rivers (COJ Jax_River)'"}) AS name,
             'river' AS water_type, ${q(`coj_${layer.name}`)} AS layer, NULL::VARCHAR AS ftype,
             ST_AsWKB(geom) AS geom_wkb, ST_GeometryType(geom)::VARCHAR AS geom_kind,
             round(ST_Area(ST_Transform(geom, 'EPSG:4326', ${q(METRIC_CRS)}, always_xy := true)) / 1e6, 4) AS area_sqkm,
             NULL::DOUBLE AS length_km,
             ${q(url)} AS src_url, ${q(`water/${layer.name}.geojson`)} AS src_artifact, ${q(sha)} AS src_sha
      FROM ST_Read(${q(duckPath(path))})`);
  }

  // 2. NHD HU4 0307 (97 MB zip; read in place)
  const nhd = await downloadArtifact({ url: NHD_URL, destDir, artifactsRoot: ctx.paths.artifactsDir, fileName: "nhd_h_0307_hu4_gdb.zip", force: ctx.force, logger: log });
  result.artifact = nhd;
  const gdb = listZipEntries(nhd.path).map((e) => e.name).find((n) => /\.gdb\//i.test(n))?.split("/")[0];
  if (gdb === undefined) throw new Error("No .gdb folder inside the NHD zip");
  const vsi = `/vsizip/${duckPath(nhd.path)}/${gdb}`;
  // geometry column name per layer (FileGDB exposes "SHAPE", geojson "geom")
  const layerMeta = await all<{ name: string; geom_field: string | null; feature_count: string | number }>(
    ctx.conn,
    `SELECT l.name AS name, l.geometry_fields[1].name AS geom_field, l.feature_count AS feature_count
     FROM (SELECT unnest(layers) AS l FROM ST_Read_Meta(${q(vsi)}))`,
  );
  const geomCol = (layer: string) => {
    const m = layerMeta.find((x) => x.name === layer);
    const g = m?.geom_field && m.geom_field.length > 0 ? m.geom_field : "geom";
    return g.toLowerCase() === "geom" ? "geom" : `"${g}"`;
  };
  result.notes.nhdLayers = Object.fromEntries(layerMeta.filter((x) => x.name.startsWith("NHD")).map((x) => [x.name, Number(x.feature_count)]));
  // DuckDB spatial 1.5 dropped ST_Read's spatial_filter_box; clip with a WHERE on the envelope instead
  const box = (g: string) => `ST_Intersects(${g}, ST_MakeEnvelope(${bb.minLon}, ${bb.minLat}, ${bb.maxLon}, ${bb.maxLat}))`;
  const ftypeCase = (map: Record<number, string>) => `CASE FType ${Object.entries(map).map(([k, v]) => `WHEN ${k} THEN ${q(v)}`).join(" ")} END`;
  const nhdPart = (layer: keyof typeof NHD_KEEP, extraWhere: string, lengthExpr: string, areaExpr: string) => `
      SELECT 'nhd:' || ${q(layer)} || ':' || Permanent_Identifier AS water_id,
             NULLIF(GNIS_Name, '') AS name, ${ftypeCase(NHD_KEEP[layer] as Record<number, string>)} AS water_type,
             ${q(`nhd_${layer}`)} AS layer, FType::VARCHAR AS ftype,
             ST_AsWKB(${geomCol(layer)}) AS geom_wkb, ST_GeometryType(${geomCol(layer)})::VARCHAR AS geom_kind,
             ${areaExpr} AS area_sqkm, ${lengthExpr} AS length_km,
             ${q(NHD_URL)} AS src_url, ${q(nhd.relPath)} AS src_artifact, ${q(nhd.sha256)} AS src_sha
      FROM ST_Read(${q(vsi)}, layer = ${q(layer)})
      WHERE ${box(geomCol(layer))} AND FType IN (${Object.keys(NHD_KEEP[layer]).join(",")}) ${extraWhere}`;
  stagingParts.push(nhdPart("NHDWaterbody", "AND AreaSqKm >= 0.01", "NULL::DOUBLE", "round(AreaSqKm, 4)"));
  stagingParts.push(nhdPart("NHDArea", "", "NULL::DOUBLE", "round(AreaSqKm, 4)"));
  stagingParts.push(nhdPart("NHDFlowline", "AND GNIS_Name IS NOT NULL AND GNIS_Name <> ''", "round(LengthKM, 3)", "NULL::DOUBLE"));

  const started = Date.now();
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.water_raw AS ${stagingParts.join(" UNION ALL BY NAME ")}`);
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.water_bodies AS
    SELECT water_id, name, water_type, layer, ftype, geom_wkb, geom_kind, area_sqkm, length_km
    FROM staging.water_raw QUALIFY row_number() OVER (PARTITION BY water_id ORDER BY area_sqkm DESC NULLS LAST) = 1`);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.water_bodies"));
  const byLayer = await all<{ layer: string; n: string | number }>(ctx.conn, "SELECT layer, count(*) AS n FROM staging.water_bodies GROUP BY 1 ORDER BY 1");
  result.notes.byLayer = Object.fromEntries(byLayer.map((r) => [r.layer, Number(r.n)]));
  result.notes.readMs = Date.now() - started;
  log.info("staged", { rows: result.rowsStaged, byLayer: result.notes.byLayer, ms: result.notes.readMs });

  const hashed = await hashStaging(ctx.conn, "staging.water_bodies", {
    sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: nhd.relPath, sourceSha256: nhd.sha256, fetchedAt, runId: ctx.runId,
  });
  // per-row provenance: AGO rows point at their geojson, NHD rows at the zip
  await ctx.conn.run(`UPDATE ${hashed} h SET source_url = r.src_url, source_artifact = r.src_artifact, source_sha256 = r.src_sha
                      FROM staging.water_raw r WHERE r.water_id = h.water_id`);
  result.merge = await mergeStaging(ctx.conn, { target: "water_bodies", staging: hashed, keys: ["water_id"] });
  log.info("merged", { table: "water_bodies", ...result.merge });

  // 3. distances. Exact point-to-polygon distance against 2 km buffers of the river polygons blew past
  //    25 GB in DuckDB, so the distance is measured to the nearest mapped shoreline VERTEX (geometries
  //    simplified to ~10 m, every vertex dumped to a point), which bounds the error by half a segment
  //    length on dense hydrography while streaming through a grid join + aggregate (no pair
  //    materialisation). Parcels with no vertex inside the 3x3 grid neighbourhood (~1.1 km) get NULL.
  const t1 = Date.now();
  const cell = 0.01;
  await ctx.conn.run(`
    CREATE OR REPLACE TEMP TABLE w_pts AS
    WITH g AS (SELECT water_id, name, water_type, layer, ST_Simplify(ST_GeomFromWKB(geom_wkb), 0.0001) AS geom FROM water_bodies),
         d AS (SELECT water_id, name, water_type, layer, unnest(ST_Dump(ST_Points(geom))) AS dd FROM g)
    SELECT water_id, name, water_type, layer, ST_X(dd.geom) AS lon, ST_Y(dd.geom) AS lat,
           floor(ST_Y(dd.geom) / ${cell})::BIGINT AS cy, floor(ST_X(dd.geom) / ${cell})::BIGINT AS cx
    FROM d`);
  await ctx.conn.run(`
    CREATE OR REPLACE TEMP TABLE p_pts AS
    SELECT p.parcel_id, p.latitude AS lat, p.longitude AS lon, g.min_lon, g.min_lat, g.max_lon, g.max_lat,
           floor(p.latitude / ${cell})::BIGINT AS cy, floor(p.longitude / ${cell})::BIGINT AS cx
    FROM parcels p LEFT JOIN parcel_geometry g ON g.parcel_id = p.parcel_id
    WHERE p.latitude IS NOT NULL`);
  await ctx.conn.run(`
    CREATE OR REPLACE TABLE derived.water_distance AS
    WITH pairs AS (
      SELECT p.parcel_id, w.water_id, w.name, w.water_type, w.layer,
             ST_Distance_Sphere(ST_Point(p.lon, p.lat), ST_Point(w.lon, w.lat)) AS d_centroid,
             CASE WHEN p.min_lon IS NULL THEN NULL
                  ELSE ST_Distance_Sphere(ST_Point(least(greatest(w.lon, p.min_lon), p.max_lon), least(greatest(w.lat, p.min_lat), p.max_lat)), ST_Point(w.lon, w.lat)) END AS d_box
      FROM p_pts p JOIN w_pts w ON w.cy BETWEEN p.cy - 1 AND p.cy + 1 AND w.cx BETWEEN p.cx - 1 AND p.cx + 1),
    agg AS (
      SELECT parcel_id, min(d_centroid) AS dist_m, arg_min(water_id, d_centroid) AS water_id,
             arg_min(name, d_centroid) AS name, arg_min(water_type, d_centroid) AS water_type, arg_min(layer, d_centroid) AS layer,
             min(d_box) AS box_dist_m
      FROM pairs GROUP BY parcel_id)
    SELECT parcel_id, water_id, name AS water_name, water_type, layer,
           round(dist_m, 1) AS water_dist_m,
           coalesce(box_dist_m <= ${WATER_BUFFER_M}, false) AS box_touch,
           (dist_m <= ${WATER_VIEW_DIST_M} OR coalesce(box_dist_m <= ${WATER_BUFFER_M}, false)) AS water_view_flag
    FROM agg`);
  result.notes.waterVertices = Number(await scalar(ctx.conn, "SELECT count(*) FROM w_pts"));
  await ctx.conn.run("DROP TABLE IF EXISTS w_pts; DROP TABLE IF EXISTS p_pts");
  const withWater = Number(await scalar(ctx.conn, "SELECT count(*) FROM derived.water_distance"));
  const view = Number(await scalar(ctx.conn, "SELECT count(*) FROM derived.water_distance WHERE water_view_flag"));
  const distanceStats = { parcelsWithin1km: withWater, waterViewFlag: view, ms: Date.now() - t1 };
  result.notes.distance = distanceStats;
  log.info("water_distance_computed", { ...distanceStats });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};

export function readJsonIfExists(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
