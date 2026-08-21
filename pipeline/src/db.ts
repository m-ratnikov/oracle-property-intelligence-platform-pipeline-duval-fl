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
  business_events: ["event_key"],
  places: ["place_id"],
  transit_stops: ["stop_id"],
  transit_routes: ["route_id"],
  water_bodies: ["water_id"],
  address_points: ["address_id"],
  coj_parcels: ["re"],
  owners: ["owner_id"],
  pa_detail_buildings: ["building_key"],
  pa_detail_sales: ["pa_sale_key"],
};

/** Bump when a table definition below changes; empty tables are recreated, non-empty ones are kept
 *  (and the run fails loudly in mergeStaging if the new staging columns do not fit). */
export const SCHEMA_VERSION = 3;

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
  re_raw            VARCHAR,
  address           VARCHAR,
  permit_type       VARCHAR,
  work_type         VARCHAR,
  description       VARCHAR,
  status            VARCHAR,
  applied_date      DATE,
  issue_date        DATE,
  final_date        DATE,
  job_cost          DOUBLE,
  contractor_name   VARCHAR,
  contractor_license VARCHAR,
  is_roof_permit    BOOLEAN,
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
  extract_file      VARCHAR,
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
  principal_country VARCHAR,
  mail_addr1        VARCHAR,
  mail_addr2        VARCHAR,
  mail_city         VARCHAR,
  mail_state        VARCHAR,
  mail_zip          VARCHAR,
  mail_country      VARCHAR,
  file_date         DATE,
  fei_number        VARCHAR,
  last_trx_date     DATE,
  state_country     VARCHAR,
  registered_agent  VARCHAR,
  registered_agent_type VARCHAR,
  ra_addr1          VARCHAR,
  ra_city           VARCHAR,
  ra_state          VARCHAR,
  ra_zip            VARCHAR,
  officers          JSON,
  officer_count     INTEGER,
  source_file       VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS business_events (
  event_key         VARCHAR NOT NULL,
  doc_number        VARCHAR,
  raw_line          VARCHAR,
  source_file       VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS places (
  place_id          VARCHAR NOT NULL,
  name              VARCHAR,
  category_primary  VARCHAR,
  categories        JSON,
  brand             VARCHAR,
  address           VARCHAR,
  locality          VARCHAR,
  postcode          VARCHAR,
  latitude          DOUBLE,
  longitude         DOUBLE,
  confidence        DOUBLE,
  sources           JSON,
  is_starbucks      BOOLEAN,
  release           VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS transit_stops (
  stop_id           VARCHAR NOT NULL,
  stop_code         VARCHAR,
  stop_name         VARCHAR,
  latitude          DOUBLE,
  longitude         DOUBLE,
  location_type     VARCHAR,
  wheelchair_boarding VARCHAR,
  route_types       VARCHAR,
  route_short_names VARCHAR,
  route_count       INTEGER,
  feed_version      VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS transit_routes (
  route_id          VARCHAR NOT NULL,
  route_short_name  VARCHAR,
  route_long_name   VARCHAR,
  route_type        INTEGER,
  route_type_name   VARCHAR,
  route_color       VARCHAR,
  feed_version      VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS water_bodies (
  water_id          VARCHAR NOT NULL,
  name              VARCHAR,
  water_type        VARCHAR,
  layer             VARCHAR,
  ftype             VARCHAR,
  geom_wkb          BLOB,
  geom_kind         VARCHAR,
  area_sqkm         DOUBLE,
  length_km         DOUBLE,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS address_points (
  address_id        VARCHAR NOT NULL,
  re_raw            VARCHAR,
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

CREATE TABLE IF NOT EXISTS coj_parcels (
  re                VARCHAR NOT NULL,
  re_nospace        VARCHAR,
  parcel_id         VARCHAR,
  owner_name        VARCHAR,
  mail_addr1        VARCHAR,
  mail_city         VARCHAR,
  mail_state        VARCHAR,
  mail_zip          VARCHAR,
  situs_address     VARCHAR,
  property_use      VARCHAR,
  property_use_desc VARCHAR,
  zoning            VARCHAR,
  fld_zone          VARCHAR,
  acres             DOUBLE,
  latitude          DOUBLE,
  longitude         DOUBLE,
  last_sale_date    DATE,
  cama_value        DOUBLE,
  building_value    DOUBLE,
  building_count    INTEGER,
  source_payload    JSON,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS pa_detail_buildings (
  building_key      VARCHAR NOT NULL,
  parcel_id         VARCHAR NOT NULL,
  building_no       INTEGER,
  building_type     VARCHAR,
  actual_year_built INTEGER,
  roof_structure    VARCHAR,
  roofing_cover     VARCHAR,
  exterior_wall     VARCHAR,
  heated_area_sqft  DOUBLE,
  gross_area_sqft   DOUBLE,
  effective_area_sqft DOUBLE,
  elements          JSON,
  owner_name        VARCHAR,
  mailing_address   VARCHAR,
  site_address      VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS pa_detail_sales (
  pa_sale_key       VARCHAR NOT NULL,
  parcel_id         VARCHAR NOT NULL,
  sale_date         DATE,
  sale_price        DOUBLE,
  or_book           VARCHAR,
  or_page           VARCHAR,
  book_page         VARCHAR,
  document_url      VARCHAR,
  deed_instrument   VARCHAR,
  qualified         VARCHAR,
  vacant_improved   VARCHAR,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS owners (
  owner_id          VARCHAR NOT NULL,
  owner_name        VARCHAR,
  name_norm         VARCHAR,
  mailing_norm      VARCHAR,
  mailing_addr1     VARCHAR,
  mailing_city      VARCHAR,
  mailing_state     VARCHAR,
  mailing_zip       VARCHAR,
  owner_kind        VARCHAR,
  parcel_count      INTEGER,
  ${PROVENANCE_COLUMNS}
);

CREATE TABLE IF NOT EXISTS source_files (
  track         VARCHAR NOT NULL,
  file_name     VARCHAR NOT NULL,
  remote_path   VARCHAR,
  bytes         BIGINT,
  sha256        VARCHAR,
  rows_parsed   BIGINT,
  rows_kept     BIGINT,
  processed_at  TIMESTAMP NOT NULL,
  run_id        VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS track_state (
  track      VARCHAR NOT NULL,
  key        VARCHAR NOT NULL,
  value      VARCHAR,
  updated_at TIMESTAMP NOT NULL,
  run_id     VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   VARCHAR NOT NULL,
  value VARCHAR
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
  error                VARCHAR,
  -- TRUE when the row was loaded from a committed runs/*.json by rehydrateRunLog rather than
  -- written by a track running against THIS database. See REHYDRATED_COLUMN below.
  rehydrated           BOOLEAN DEFAULT FALSE
);
`;

/**
 * `run_log_sources.rehydrated` marks a row this database did not produce.
 *
 * The committed `runs/*.json` records come from both Actions cache lineages (the feature branch's
 * and the default branch's), and those two databases hold different amounts of data. A rehydrated
 * row is still history for display, provenance and coverage, but its `table_total_after` describes
 * a table this database does not have: subtracting it produced run 01M0JZHQY2SM's published
 * "sales -7,528" on a run that inserted nothing. `previousTotal` therefore reads only rows this
 * database wrote, and answers null when it has none (see run.ts).
 *
 * Two shapes have to agree, because both are in the fleet:
 *
 *   - a database created by the DDL above, which has the column from birth;
 *   - a warm Actions cache created before the column existed, which gets it by ALTER TABLE.
 *
 * DuckDB cannot add a constrained column ("Adding columns with constraints not yet supported"), so
 * the column is declared WITHOUT `NOT NULL` in the DDL too, and the two paths produce the same
 * column definition rather than a constraint that only half the fleet carries. Every write goes
 * through `insertRunSource`, which always supplies the value, and the one read that must not cross
 * lineages tests `rehydrated IS FALSE`, so a NULL from any path is excluded rather than trusted.
 *
 * Rows that predate the column have UNKNOWN provenance: a warm main-lineage cache holds both its
 * own rows and the foreign ones the first rehydrate pass inserted, and nothing on disk tells them
 * apart. They are marked rehydrated, which costs that database one run reporting "no previous run
 * recorded" and then compares every run after it against its own row. The alternative, assuming
 * they are local, republishes the same negative delta one more time.
 */
const REHYDRATED_COLUMN = "rehydrated";

async function ensureRehydratedColumn(conn: DuckDBConnection): Promise<void> {
  const columns = await tableColumns(conn, "main", "run_log_sources");
  if (columns.includes(REHYDRATED_COLUMN)) return;
  await conn.run(`ALTER TABLE run_log_sources ADD COLUMN IF NOT EXISTS ${REHYDRATED_COLUMN} BOOLEAN DEFAULT FALSE`);
  // Runs once, on the migration itself: the column-existence check above stops a later start from
  // re-marking rows written since.
  await conn.run(`UPDATE run_log_sources SET ${REHYDRATED_COLUMN} = TRUE`);
}

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

/** Tables safe to recreate when empty on a schema bump (never parcels / sales / geometry / run_log). */
const RECREATE_WHEN_EMPTY = [
  "permits", "contractors", "businesses", "business_events", "places", "transit_stops", "transit_routes",
  "water_bodies", "address_points", "coj_parcels", "owners", "entity_links", "pa_detail_buildings", "pa_detail_sales",
];

export async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(DDL);
  // `CREATE TABLE IF NOT EXISTS` leaves an existing run_log_sources exactly as it found it, and
  // run_log_sources is never in RECREATE_WHEN_EMPTY, so a warm cache needs the column added.
  await ensureRehydratedColumn(conn);
  const rows = await all<{ value: string }>(conn, "SELECT value FROM schema_meta WHERE key = 'schema_version'");
  const current = rows[0] ? Number(rows[0].value) : 1;
  if (current < SCHEMA_VERSION) {
    for (const t of RECREATE_WHEN_EMPTY) {
      if (await tableExists(conn, "main", t)) {
        const n = Number(await scalar<string | number>(conn, `SELECT count(*) FROM ${t}`));
        if (n === 0) await conn.run(`DROP TABLE ${t}`);
      }
    }
    await conn.run(DDL);
    await conn.run("DELETE FROM schema_meta WHERE key = 'schema_version'");
    await conn.run(`INSERT INTO schema_meta VALUES ('schema_version', '${SCHEMA_VERSION}')`);
  }
}

/** Read / write small per-track state (cursors, last EDIT_DATE, discovered endpoints). */
export async function getTrackState(conn: DuckDBConnection, track: string, key: string): Promise<string | null> {
  const rows = await all<{ value: string | null }>(
    conn,
    `SELECT value FROM track_state WHERE track = ${q(track)} AND key = ${q(key)} ORDER BY updated_at DESC LIMIT 1`,
  );
  return rows[0]?.value ?? null;
}

export async function setTrackState(conn: DuckDBConnection, track: string, key: string, value: string, runId: string): Promise<void> {
  await conn.run(`DELETE FROM track_state WHERE track = ${q(track)} AND key = ${q(key)}`);
  await conn.run(
    `INSERT INTO track_state VALUES (${q(track)}, ${q(key)}, ${q(value)}, ${q(new Date().toISOString())}::TIMESTAMP, ${q(runId)})`,
  );
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
