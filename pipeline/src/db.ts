import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

/** Provenance columns present on every entity table (the assignment's "preserve source provenance"). */
export const PROVENANCE_COLUMNS = `
  row_hash        VARCHAR NOT NULL,
  source_system   VARCHAR NOT NULL,
  source_url      VARCHAR,
  source_artifact VARCHAR,
  source_sha256   VARCHAR,
  fetched_at      TIMESTAMP NOT NULL,
  run_id          VARCHAR NOT NULL`;

export const PROVENANCE_COLUMN_NAMES = [
  "row_hash",
  "source_system",
  "source_url",
  "source_artifact",
  "source_sha256",
  "fetched_at",
  "run_id",
] as const;

/** Entity tables and their natural keys (used by the generic merge). */
export const ENTITY_KEYS: Record<string, string[]> = {
  parcels: ["parcel_id"],
  parcel_geometry: ["parcel_id"],
  sales_history: ["sale_key"],
  permits: ["permit_no"],
  contractors: ["license_no"],
  businesses: ["doc_number"],
  places: ["place_id"],
  transit_stops: ["stop_id"],
  water_bodies: ["water_id"],
  address_points: ["address_id"],
};

const DDL = `
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS derived;

CREATE TABLE IF NOT EXISTS parcels (
  parcel_id        VARCHAR NOT NULL,
  co_no            VARCHAR,
  asmnt_yr         INTEGER,
  file_t           VARCHAR,
  dor_uc           VARCHAR,
  pa_uc            VARCHAR,
  spass_cd         VARCHAR,
  jv               DOUBLE,
  jv_chng          DOUBLE,
  jv_chng_cd       VARCHAR,
  av_sd            DOUBLE,
  av_nsd           DOUBLE,
  tv_sd            DOUBLE,
  tv_nsd           DOUBLE,
  jv_hmstd         DOUBLE,
  av_hmstd         DOUBLE,
  jv_non_hmstd_resd DOUBLE,
  av_non_hmstd_resd DOUBLE,
  nconst_val       DOUBLE,
  del_val          DOUBLE,
  par_splt         VARCHAR,
  lnd_val          DOUBLE,
  lnd_unts_cd      VARCHAR,
  no_lnd_unts      DOUBLE,
  lnd_sqfoot       DOUBLE,
  dt_last_inspt    VARCHAR,
  imp_qual         VARCHAR,
  const_class      VARCHAR,
  eff_yr_blt       INTEGER,
  act_yr_blt       INTEGER,
  tot_lvg_area     DOUBLE,
  no_buldng        INTEGER,
  no_res_unts      INTEGER,
  spec_feat_val    DOUBLE,
  multi_par_sal1   VARCHAR,
  qual_cd1         VARCHAR,
  vi_cd1           VARCHAR,
  sale_prc1        DOUBLE,
  sale_yr1         INTEGER,
  sale_mo1         INTEGER,
  or_book1         VARCHAR,
  or_page1         VARCHAR,
  clerk_no1        VARCHAR,
  sal_chng_cd1     VARCHAR,
  multi_par_sal2   VARCHAR,
  qual_cd2         VARCHAR,
  vi_cd2           VARCHAR,
  sale_prc2        DOUBLE,
  sale_yr2         INTEGER,
  sale_mo2         INTEGER,
  or_book2         VARCHAR,
  or_page2         VARCHAR,
  clerk_no2        VARCHAR,
  sal_chng_cd2     VARCHAR,
  own_name         VARCHAR,
  own_addr1        VARCHAR,
  own_addr2        VARCHAR,
  own_city         VARCHAR,
  own_state        VARCHAR,
  own_zipcd        VARCHAR,
  own_state_dom    VARCHAR,
  fidu_name        VARCHAR,
  fidu_addr1       VARCHAR,
  fidu_addr2       VARCHAR,
  fidu_city        VARCHAR,
  fidu_state       VARCHAR,
  fidu_zipcd       VARCHAR,
  fidu_cd          VARCHAR,
  s_legal          VARCHAR,
  app_stat         VARCHAR,
  co_app_stat      VARCHAR,
  mkt_ar           VARCHAR,
  nbrhd_cd         VARCHAR,
  public_lnd       VARCHAR,
  tax_auth_cd      VARCHAR,
  twn              VARCHAR,
  rng              VARCHAR,
  sec              VARCHAR,
  census_bk        VARCHAR,
  phy_addr1        VARCHAR,
  phy_addr2        VARCHAR,
  phy_city         VARCHAR,
  phy_zipcd        VARCHAR,
  alt_key          VARCHAR,
  ass_trnsfr_fg    VARCHAR,
  prev_hmstd_own   VARCHAR,
  ass_dif_trns     DOUBLE,
  cono_prv_hm      VARCHAR,
  parcel_id_prv_hmstd VARCHAR,
  yr_val_trnsf     INTEGER,
  exmpt_codes      VARCHAR,
  seq_no           INTEGER,
  rs_id            VARCHAR,
  mp_id            VARCHAR,
  state_par_id     VARCHAR,
  spc_cir_cd       VARCHAR,
  spc_cir_yr       INTEGER,
  spc_cir_txt      VARCHAR,
  latitude         DOUBLE,
  longitude        DOUBLE,
  geometry_source  VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS parcel_geometry (
  parcel_id    VARCHAR NOT NULL,
  latitude     DOUBLE,
  longitude    DOUBLE,
  area_sqft    DOUBLE,
  min_lon      DOUBLE,
  min_lat      DOUBLE,
  max_lon      DOUBLE,
  max_lat      DOUBLE,
  geometry_type VARCHAR,
  source_crs   VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS sales_history (
  sale_key       VARCHAR NOT NULL,
  parcel_id      VARCHAR NOT NULL,
  sale_date      DATE,
  sale_year      INTEGER,
  sale_month     INTEGER,
  sale_price     DOUBLE,
  or_book        VARCHAR,
  or_page        VARCHAR,
  clerk_no       VARCHAR,
  qual_cd        VARCHAR,
  vi_cd          VARCHAR,
  sale_change_cd VARCHAR,
  multi_parcel   VARCHAR,
  sale_id_cd     VARCHAR,
  sale_source    VARCHAR NOT NULL,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS permits (
  permit_no         VARCHAR NOT NULL,
  parcel_id         VARCHAR,
  address           VARCHAR,
  permit_type       VARCHAR,
  work_type         VARCHAR,
  description       VARCHAR,
  status            VARCHAR,
  issue_date        DATE,
  final_date        DATE,
  job_cost          DOUBLE,
  contractor_name   VARCHAR,
  contractor_license VARCHAR,
  is_roof           BOOLEAN,
  source_payload    JSON,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS contractors (
  license_no        VARCHAR NOT NULL,
  board_number      VARCHAR,
  occupation_code   VARCHAR,
  name              VARCHAR,
  dba               VARCHAR,
  license_class     VARCHAR,
  address           VARCHAR,
  city              VARCHAR,
  state             VARCHAR,
  zip               VARCHAR,
  county_code       VARCHAR,
  primary_status    VARCHAR,
  secondary_status  VARCHAR,
  original_license_date DATE,
  effective_date    DATE,
  expiration_date   DATE,
  is_roofing        BOOLEAN,
  source_payload    JSON,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS businesses (
  doc_number        VARCHAR NOT NULL,
  name              VARCHAR,
  status            VARCHAR,
  filing_type       VARCHAR,
  principal_addr1   VARCHAR,
  principal_addr2   VARCHAR,
  principal_city    VARCHAR,
  principal_state   VARCHAR,
  principal_zip     VARCHAR,
  mail_addr1        VARCHAR,
  mail_addr2        VARCHAR,
  mail_city         VARCHAR,
  mail_state        VARCHAR,
  mail_zip          VARCHAR,
  file_date         DATE,
  fei_number        VARCHAR,
  registered_agent  VARCHAR,
  officers          JSON,
  source_payload    JSON,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS places (
  place_id          VARCHAR NOT NULL,
  name              VARCHAR,
  category_primary  VARCHAR,
  categories        JSON,
  brand             VARCHAR,
  address           VARCHAR,
  latitude          DOUBLE,
  longitude         DOUBLE,
  confidence        DOUBLE,
  is_starbucks      BOOLEAN,
  release           VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS transit_stops (
  stop_id           VARCHAR NOT NULL,
  stop_name         VARCHAR,
  latitude          DOUBLE,
  longitude         DOUBLE,
  location_type     VARCHAR,
  route_types       VARCHAR,
  feed_version      VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS water_bodies (
  water_id          VARCHAR NOT NULL,
  name              VARCHAR,
  water_type        VARCHAR,
  layer             VARCHAR,
  geom_wkb          BLOB,
  area_sqm          DOUBLE,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS address_points (
  address_id        VARCHAR NOT NULL,
  parcel_id         VARCHAR,
  whole_address     VARCHAR,
  zipcode           VARCHAR,
  latitude          DOUBLE,
  longitude         DOUBLE,
  zoning            VARCHAR,
  landuse           VARCHAR,
  floodzone         VARCHAR,
  subdivision       VARCHAR,
  edit_date         TIMESTAMP,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS entity_links (
  link_id       VARCHAR NOT NULL,
  link_type     VARCHAR NOT NULL,
  from_entity   VARCHAR NOT NULL,
  from_id       VARCHAR NOT NULL,
  to_entity     VARCHAR NOT NULL,
  to_id         VARCHAR NOT NULL,
  match_method  VARCHAR NOT NULL,
  confidence    DOUBLE,
  distance_m    DOUBLE,
  run_id        VARCHAR NOT NULL,
  created_at    TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS run_log (
  run_id        VARCHAR NOT NULL,
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,
  status        VARCHAR NOT NULL,
  trigger       VARCHAR,
  git_sha       VARCHAR,
  tracks        VARCHAR,
  "window"      VARCHAR,
  sources       JSON,
  limitations   JSON,
  totals        JSON,
  artifacts     JSON,
  error         VARCHAR
);

CREATE TABLE IF NOT EXISTS run_log_sources (
  run_id               VARCHAR NOT NULL,
  track                VARCHAR NOT NULL,
  source_system        VARCHAR NOT NULL,
  target_table         VARCHAR NOT NULL,
  source_url           VARCHAR,
  artifact_path        VARCHAR,
  artifact_sha256      VARCHAR,
  artifact_etag        VARCHAR,
  artifact_last_modified VARCHAR,
  artifact_bytes       BIGINT,
  download_status      VARCHAR,
  rows_staged          BIGINT,
  inserted             BIGINT,
  updated              BIGINT,
  unchanged            BIGINT,
  missing_in_source    BIGINT,
  table_total_after    BIGINT,
  delta_vs_prev_total  BIGINT,
  started_at           TIMESTAMP NOT NULL,
  finished_at          TIMESTAMP,
  status               VARCHAR NOT NULL,
  limitations          JSON,
  error                VARCHAR
);
`;

export interface Db {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  close(): Promise<void>;
}

export async function openDb(path: string, opts: { readOnly?: boolean } = {}): Promise<Db> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const instance = await DuckDBInstance.create(path, opts.readOnly ? { access_mode: "READ_ONLY" } : {});
  const conn = await instance.connect();
  return {
    instance,
    conn,
    close: async () => {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

export async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(DDL);
}

/** Load DuckDB spatial (downloads the extension the first time). */
export async function loadSpatial(conn: DuckDBConnection): Promise<void> {
  await conn.run("INSTALL spatial; LOAD spatial;");
}

/** Quote a SQL string literal. */
export function q(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote an identifier. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Forward-slash a filesystem path for DuckDB/GDAL on Windows. */
export function duckPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function one<T = Record<string, unknown>>(conn: DuckDBConnection, sql: string): Promise<T> {
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjectsJson() as unknown as T[];
  const first = rows[0];
  if (first === undefined) throw new Error(`Query returned no rows: ${sql.slice(0, 200)}`);
  return first;
}

export async function all<T = Record<string, unknown>>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJson() as unknown as T[];
}

export async function scalar<T = unknown>(conn: DuckDBConnection, sql: string): Promise<T> {
  const row = await one<Record<string, unknown>>(conn, sql);
  const values = Object.values(row);
  return values[0] as T;
}

export async function count(conn: DuckDBConnection, table: string): Promise<number> {
  return Number(await scalar<string | number>(conn, `SELECT count(*) AS n FROM ${table}`));
}

export async function tableExists(conn: DuckDBConnection, schema: string, table: string): Promise<boolean> {
  const n = await scalar<string | number>(
    conn,
    `SELECT count(*) FROM information_schema.tables WHERE table_schema = ${q(schema)} AND table_name = ${q(table)}`,
  );
  return Number(n) > 0;
}

export async function tableColumns(conn: DuckDBConnection, schema: string, table: string): Promise<string[]> {
  const rows = await all<{ column_name: string }>(
    conn,
    `SELECT column_name FROM information_schema.columns WHERE table_schema = ${q(schema)} AND table_name = ${q(table)} ORDER BY ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}
