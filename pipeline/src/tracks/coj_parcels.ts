import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, q, scalar } from "../db.js";
import { normalizeParcelIdSql } from "../features/normalize.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { COJ_PARCELS_URL } from "../sources.js";
import { fetchArcgisAll, type ArcgisFeature } from "./arcgis.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const COJ_PARCEL_FIELDS =
  "RE,RE_NOSPACE,LNAMEOWNER,MAILADDR1,MAILCITY,MAILSTATE,MAILZIP,LONGNAME,PUSE,DESCPU,ZON_LABEL,FLD_ZONE,ACRES,LAT,LONG,SALESLDD,SALESLMM,SALESLYY,CAMA_VAL,TOT_BLD_VA,NBBLDGS";

export interface CojParcelRow {
  re: string;
  re_nospace: string | null;
  owner_name: string | null;
  mail_addr1: string | null;
  mail_city: string | null;
  mail_state: string | null;
  mail_zip: string | null;
  situs_address: string | null;
  property_use: string | null;
  property_use_desc: string | null;
  zoning: string | null;
  fld_zone: string | null;
  acres: number | null;
  latitude: number | null;
  longitude: number | null;
  last_sale_date: string | null;
  cama_value: number | null;
  building_value: number | null;
  building_count: number | null;
  source_payload: string;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() === "" ? null : String(v).trim());
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** SALESLYY / SALESLMM / SALESLDD (2- or 4-digit year) -> ISO date, or null. */
export function cojSaleDate(yy: unknown, mm: unknown, dd: unknown): string | null {
  const y = num(yy);
  const m = num(mm);
  const d = num(dd);
  if (y === null || m === null || y <= 0 || m < 1 || m > 12) return null;
  const year = y < 100 ? (y >= 50 ? 1900 + y : 2000 + y) : y;
  const day = d !== null && d >= 1 && d <= 31 ? d : 1;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseCojParcel(f: ArcgisFeature): CojParcelRow | null {
  const a = f.attributes;
  const re = str(a.RE);
  if (re === null) return null;
  return {
    re,
    re_nospace: str(a.RE_NOSPACE),
    owner_name: str(a.LNAMEOWNER),
    mail_addr1: str(a.MAILADDR1),
    mail_city: str(a.MAILCITY),
    mail_state: str(a.MAILSTATE),
    mail_zip: str(a.MAILZIP),
    situs_address: str(a.LONGNAME),
    property_use: str(a.PUSE),
    property_use_desc: str(a.DESCPU),
    zoning: str(a.ZON_LABEL),
    fld_zone: str(a.FLD_ZONE),
    acres: num(a.ACRES),
    latitude: num(a.LAT),
    longitude: num(a.LONG),
    last_sale_date: cojSaleDate(a.SALESLYY, a.SALESLMM, a.SALESLDD),
    cama_value: num(a.CAMA_VAL),
    building_value: num(a.TOT_BLD_VA),
    building_count: num(a.NBBLDGS) === null ? null : Math.round(num(a.NBBLDGS) as number),
    source_payload: JSON.stringify(a),
  };
}

export async function stageCojParcels(conn: import("@duckdb/node-api").DuckDBConnection, rows: CojParcelRow[]): Promise<void> {
  await conn.run(`CREATE OR REPLACE TABLE staging.coj_parcels_raw (
    re VARCHAR, re_nospace VARCHAR, owner_name VARCHAR, mail_addr1 VARCHAR, mail_city VARCHAR, mail_state VARCHAR, mail_zip VARCHAR,
    situs_address VARCHAR, property_use VARCHAR, property_use_desc VARCHAR, zoning VARCHAR, fld_zone VARCHAR, acres DOUBLE,
    latitude DOUBLE, longitude DOUBLE, last_sale_date DATE, cama_value DOUBLE, building_value DOUBLE, building_count INTEGER, source_payload JSON)`);
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  for (let i = 0; i < rows.length; i += 1000) {
    const values = rows
      .slice(i, i + 1000)
      .map(
        (r) =>
          `(${q(r.re)}, ${q(r.re_nospace)}, ${q(r.owner_name)}, ${q(r.mail_addr1)}, ${q(r.mail_city)}, ${q(r.mail_state)}, ${q(r.mail_zip)}, ${q(r.situs_address)}, ${q(r.property_use)}, ${q(r.property_use_desc)}, ${q(r.zoning)}, ${q(r.fld_zone)}, ${n(r.acres)}, ${n(r.latitude)}, ${n(r.longitude)}, ${q(r.last_sale_date)}::DATE, ${n(r.cama_value)}, ${n(r.building_value)}, ${n(r.building_count)}, ${q(r.source_payload)}::JSON)`,
      );
    await conn.run(`INSERT INTO staging.coj_parcels_raw VALUES ${values.join(",")}`);
  }
  await conn.run(`CREATE OR REPLACE TABLE staging.coj_parcels AS
    SELECT r.* EXCLUDE (source_payload), p.parcel_id, r.source_payload
    FROM (SELECT * FROM staging.coj_parcels_raw QUALIFY row_number() OVER (PARTITION BY re ORDER BY last_sale_date DESC NULLS LAST) = 1) r
    LEFT JOIN (SELECT parcel_id, ${normalizeParcelIdSql("parcel_id")} AS norm FROM parcels) p ON p.norm = ${normalizeParcelIdSql("r.re")}`);
}

/** COJ parcel layer (US egress) -> coj_parcels, joined to NAL parcels by normalized RE. */
export const runCojParcels: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "coj_parcels");
  mkdirSync(destDir, { recursive: true });
  const maxPages = ctx.env.COJ_MAX_PAGES ? Number(ctx.env.COJ_MAX_PAGES) : undefined;
  const started = Date.now();
  const res = await fetchArcgisAll({
    baseUrl: COJ_PARCELS_URL,
    where: "1=1",
    outFields: COJ_PARCEL_FIELDS,
    pageSize: 2000,
    concurrency: 2,
    delayMs: 250,
    maxPages,
    onPage: (p) => log.debug("coj_page", { ...p }),
  });
  result.notes.pages = res.pages;
  result.notes.total = res.total;
  result.notes.fetchMs = Date.now() - started;
  result.notes.featuresFetched = res.features.length;
  if (res.errors.length > 0) result.limitations.push(`${res.errors.length} page errors: ${res.errors.slice(0, 3).join("; ")}`);
  if (maxPages !== undefined) result.limitations.push(`COJ_MAX_PAGES=${maxPages}: bounded pull`);
  if (res.features.length === 0) throw new Error(`COJ parcels: no features fetched (${res.errors[0] ?? "unknown error"})`);
  const snapshot = join(destDir, "parcels-latest.json");
  writeFileSync(snapshot, JSON.stringify({ fetchedAt: new Date().toISOString(), total: res.total, features: res.features.length }));
  const rows = res.features.map(parseCojParcel).filter((r): r is CojParcelRow => r !== null);
  await stageCojParcels(ctx.conn, rows);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.coj_parcels"));
  result.notes.matchedToNal = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.coj_parcels WHERE parcel_id IS NOT NULL"));
  result.notes.withSaleDate = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.coj_parcels WHERE last_sale_date IS NOT NULL"));
  const fz = await all<{ fld_zone: string; n: string | number }>(ctx.conn, "SELECT fld_zone, count(*) AS n FROM staging.coj_parcels GROUP BY 1 ORDER BY 2 DESC LIMIT 8");
  result.notes.floodZones = Object.fromEntries(fz.map((r) => [r.fld_zone ?? "null", Number(r.n)]));
  const hashed = await hashStaging(ctx.conn, "staging.coj_parcels", {
    sourceSystem: source.sourceSystem, sourceUrl: COJ_PARCELS_URL, sourceArtifact: "coj_parcels/parcels-latest.json", sourceSha256: null,
    fetchedAt: new Date().toISOString(), runId: ctx.runId,
  });
  result.merge = await mergeStaging(ctx.conn, { target: "coj_parcels", staging: hashed, keys: ["re"] });
  log.info("merged", { table: "coj_parcels", ...result.merge, matchedToNal: result.notes.matchedToNal });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
