import type { DuckDBConnection } from "@duckdb/node-api";
import { COUNTY } from "../config.js";
import { count, one, q, tableExists } from "../db.js";
import { SOURCES, type TrackName } from "../sources.js";
import { DOR_USE_CODES, dorUseGroupSql, hasAdditionalOwnersSql, ownerRegionSql, yearsSinceSql } from "./rules.js";

export interface FeatureBuildStats {
  rows: number;
  asOf: string;
  permitsLoaded: boolean;
  businessesLoaded: boolean;
  transitLoaded: boolean;
  placesLoaded: boolean;
  waterLoaded: boolean;
  cojParcelsLoaded: boolean;
  addressesLoaded: boolean;
}

export const WALK_M = 800;

/**
 * The four values of `tenure_quality`, the column that says whether a row's tenure can honestly be
 * read as an ownership hold. Never NULL.
 */
export const TENURE_QUALITY_VALUES = [
  "PLAUSIBLE",
  "IMPLAUSIBLE_DATE",
  "INSTITUTIONAL_OR_CIVIC",
  "NO_SALE_ON_RECORD",
] as const;

export type TenureQuality = (typeof TENURE_QUALITY_VALUES)[number];

/**
 * The first date the county's transfer record can be read as real, measured rather than chosen.
 *
 * Dated `last_sale_date_any` values form a smooth attrition curve backwards through the record:
 * 193,923 in the 2020s, 108,027 in the 2010s, 56,290 in the 2000s, then 26,251 / 11,018 / 4,348 /
 * 233 / 149 / 50 / 23 / 24 / 16 / 27 per decade back to the 1900s. Before 1901 the curve does not
 * continue, it spikes: 1,453 rows sitting on two values (1899-12-30 on 842 rows, 1899-01-01 on
 * 609) plus a single 1800-01-01, which is 50x the adjacent decade. That is filler in the City
 * recorded-sales file, not surviving Victorian conveyances, so 1901-01-01 is where a date stops
 * being evidence.
 *
 * Two thresholds were tried and rejected. The UI's `> 100 years` cut is as-of dependent, so a row
 * changes label as the artifact ages and never because the source changed, and it let 1925/1926
 * municipal, railway and cemetery dates through at exactly 100 years. A "sale predates the
 * structure" rule adds nothing: of the 946 rows whose sale is more than 50 years before
 * `built_year`, 932 are already before 1901.
 */
export const TENURE_RECORD_EPOCH = "1901-01-01";

/**
 * DOR use-code groups whose parcels are not held in a household market.
 *
 * FDOR use codes 70-79 (churches, private schools, hospitals, cemeteries, clubs), 80-89 (military,
 * parks, county/state/federal/municipal land) and 90-99 (leaseholds on public land, utility,
 * right-of-way, submerged land, waste land, centrally assessed) cover 13,413 of the 404,023 Duval
 * parcels. Their `last_sale_date_any` is usually a real date, so it is NOT an implausible date; it
 * is the date a public body or institution took the land and has held it since. Read as an
 * ownership tenure it is a category error, which is why it gets its own value rather than sharing
 * PLAUSIBLE.
 */
export const NON_MARKET_DOR_GROUPS = ["INSTITUTIONAL", "GOVERNMENTAL", "MISCELLANEOUS"] as const;

/**
 * `tenure_quality`, published so every consumer of the parquet inherits the same judgement.
 *
 * This demotion used to live only in the UI's SQL, which meant the website ranked sentinel dates
 * last while every MCP client and everyone reading the published parquet still got a 1800-01-01
 * rendered as a 226-year ownership hold. The data product is the parquet, so the judgement belongs
 * in the parquet.
 *
 * Order matters and is deliberate: an absent date beats a bad date beats a real date on a parcel
 * that does not change hands. A row that is both a 1899 sentinel and a City park is reported as
 * IMPLAUSIBLE_DATE (313 rows), because the wrong number is the more actionable defect.
 *
 * INSTITUTIONAL_OR_CIVIC is keyed on the appraiser's own use code and nothing else. Owner-name
 * matching was measured and rejected: patterns for CITY / STATE / RAILWAY / CEMETERY and the like
 * add 1,965 rows, and the additions are dominated by false positives that the roll's 30-character
 * OWN_NAME truncation makes impossible to separate out - FORESTAR USA REAL ESTATE GROUP (345
 * rows), MCP RIVER CITY LP (134), TPG AG EHC III LEN MULTI STATE (107), RUBBER CITY PARTNERS,
 * CITY NATIONAL BANK OF FLORIDA, UNITED STATES GYPSUM COMPANY. The use code is the appraiser's
 * published classification of the parcel and is present on all 404,023 rows.
 *
 * Nothing here claims to know the transfer INSTRUMENT. The City parcel layer publishes the sale as
 * three bare numbers (SALESLYY / SALESLMM / SALESLDD) with no deed type, no price and no
 * qualification code, and it is the basis for 398,908 of the 404,023 rows. `last_sale_qual_cd`,
 * which would name a government or charitable conveyance, exists only on the 2,924 FDOR_SALE rows.
 * So the value says the PARCEL is civic or institutional, which the roll does support, and does
 * not say the transfer was a plat dedication, which no ingested column carries.
 *
 * @param saleDateExpr the DATE expression behind last_sale_date_any; NULL means no sale on record
 * @param dorUcCol     the parcels DOR use-code column
 */
/**
 * `tenure_date_check`, the second half of the tenure judgement.
 *
 * `tenure_quality` is drawn from the use code, so a railway, utility or farm parcel with an
 * industrial or agricultural code stays PLAUSIBLE however civic it looks: F E C RAILWAY CO reads
 * 048 and CSX TRANSPORTATION reads 055. This column carries no threshold and no classification. It
 * only compares the row's own two dates, which is a question the row can always answer for itself.
 *
 * CONTRADICTED means the sale year precedes built_year, so the transfer cannot be a sale of the
 * building now standing, which is what separates a 1901 date on a house built in 1952 from a
 * genuine long hold. It is published rather than left in the browser because the classification is
 * useless to an MCP client that can see the label and not the contradiction behind the ordering.
 */
export function tenureDateCheckSql(saleDateExpr: string, builtYearExpr: string): string {
  return `CASE
    WHEN (${builtYearExpr}) IS NULL OR (${saleDateExpr}) IS NULL THEN 'UNVERIFIABLE'
    WHEN TRY_CAST(substr(CAST((${saleDateExpr}) AS VARCHAR), 1, 4) AS INTEGER) < (${builtYearExpr}) THEN 'CONTRADICTED'
    ELSE 'CONFIRMED' END`;
}

export function tenureQualitySql(saleDateExpr: string, dorUcCol: string): string {
  const groups = NON_MARKET_DOR_GROUPS.map((g) => `'${g}'`).join(", ");
  return `CASE
      WHEN ${saleDateExpr} IS NULL THEN 'NO_SALE_ON_RECORD'
      WHEN ${saleDateExpr} < DATE '${TENURE_RECORD_EPOCH}' THEN 'IMPLAUSIBLE_DATE'
      WHEN ${dorUseGroupSql(dorUcCol)} IN (${groups}) THEN 'INSTITUTIONAL_OR_CIVIC'
      ELSE 'PLAUSIBLE' END`;
}

/**
 * A group of query-table columns that all come from one source system.
 *
 * WHY THIS EXISTS. `source_system` is one of the 37 canonical Elephant columns and it is a single
 * scalar per row, so it can only ever name one system. This table joins twelve of them: the FDOR
 * NAL roll is the spine, but roughly forty of the published columns come from the FDOR SDF sales
 * file, the FDOR PAR shapefile, the Duval PA detail pages, JaxEPICS permits, Sunbiz, DBPR, JTA
 * GTFS, Overture places, COJ/NHD hydrography, the COJ parcel layer and the COJ address points.
 * Emitting `duval_appraiser` on every row and calling that "provenance on every row" is false for
 * every one of those columns.
 *
 * WHAT WE PUBLISH INSTEAD. `source_system` stays exactly as the canonical contract expects, but it
 * is now scoped honestly: it names the source of the appraisal-roll spine the row is keyed on, and
 * nothing else (`appraisal_source` carries the identical value, which makes that scope visible in
 * the data itself). Each family below then publishes its own `<key>_source` / `<key>_fetched_at`
 * pair, NULL on any row the family contributed nothing to, and `source_systems` lists every system
 * that did contribute to the row. The column-to-family map travels with the parquet in its
 * key-value metadata (see features/export.ts), so a consumer holding only the file can resolve any
 * column to the system and fetch time behind it.
 *
 * TRUTHFUL PR SENTENCE (the one claim this design supports, quoted in the report):
 *   "Every row of the query table carries provenance per column family, not just per parcel:
 *    `source_system` names the source of the appraisal-roll spine the row is keyed on,
 *    `source_systems` lists every system that contributed a value to that row, and a
 *    `<family>_source` / `<family>_fetched_at` pair names the system and fetch time behind each
 *    group of columns, with the column-to-family map published inside the parquet metadata."
 */
export interface ColumnFamily {
  /** Column-name prefix: the family publishes `<key>_source` and `<key>_fetched_at`. */
  key: string;
  label: string;
  /**
   * The `SOURCES` track that fetched the family, or null for families computed from more than one
   * source (`derived`), produced by the pipeline itself (`pipeline`), or present only as a
   * canonical placeholder the sources never fill (`placeholder`). Only families with a track emit
   * a `<key>_source` / `<key>_fetched_at` pair.
   */
  track: TrackName | null;
  /** Every column of derived.properties_features belongs to exactly one family. */
  columns: readonly string[];
  /** Anything a reader has to know before trusting the family's columns. */
  note?: string;
}

export const COLUMN_FAMILIES: readonly ColumnFamily[] = [
  {
    key: "appraisal",
    label: "FDOR NAL tax roll (Duval property appraiser)",
    track: "appraisal",
    note:
      "The spine: one row per folio. `source_system` names this family and only this family. " +
      "OWN_NAME is truncated to 30 characters by the roll and there is no co-owner column, which " +
      "is why owner_count is NULL and has_additional_owners carries the ET AL / ET UX marker.",
    columns: [
      "property_id", "request_identifier", "parcel_identifier", "source_system", "county_name", "state_code",
      "address_street", "address_city", "address_zip", "lot_size_acre", "lot_area_sqft", "property_type",
      "property_usage_type", "built_year", "livable_floor_area", "assessed_value", "market_value", "land_value",
      "owner_name", "owners_text", "owner_count", "owner_occupied", "has_additional_owners", "dor_uc", "pa_uc",
      "eff_year_built", "taxable_value", "assessed_value_school", "homestead_flag", "building_count",
      "residential_units", "legal_description", "neighborhood_code", "census_block", "owner_mailing_address",
      "owner_mailing_city", "owner_mailing_state", "owner_mailing_zip", "owner_region_class",
      "source_artifact", "source_sha256", "source_fetched_at", "source_run_id", "source_url", "fetched_at",
    ],
  },
  {
    key: "sales",
    label: "FDOR SDF sales data file (plus the roll's own SALE_*1/2 columns)",
    track: "sales",
    note: "Covers the 2025-2026 transfers only; sale dates carry year and month, stored as the first of the month.",
    columns: [
      "last_sale_date", "last_sale_price", "last_sale_source", "last_sale_qual_cd", "last_sale_or_book",
      "last_sale_or_page", "sale_count",
    ],
  },
  {
    key: "geometry",
    label: "FDOR PAR parcel shapefile",
    track: "geometry",
    note: "Centroids computed from parcel polygons, not rooftop points.",
    columns: ["latitude", "longitude", "coordinates_source"],
  },
  {
    key: "structure",
    label: "Duval Property Appraiser Detail pages (vendored Elephant lexicon transform)",
    track: "pa_detail",
    note: "Slow, US-egress-only source pulled in bounded windows, so these columns cover only the parcels visited so far.",
    columns: [
      "exterior_wall_material", "roof_covering_material", "total_area", "roof_structure", "pa_actual_year_built",
      "pa_building_count",
    ],
  },
  {
    key: "permit",
    label: "City of Jacksonville JaxEPICS permits",
    track: "permits",
    columns: [
      "has_permits", "permit_count", "roof_permit_count", "last_roof_permit_year", "last_roof_permit_date",
      "last_permit_date",
    ],
  },
  {
    key: "business",
    label: "Florida Division of Corporations (Sunbiz)",
    track: "businesses",
    note: "Linked to the parcel by normalized situs address plus ZIP5 (entity_links), not by a county key.",
    columns: ["has_sunbiz_tenant", "sunbiz_business_count"],
  },
  {
    key: "contractor",
    label: "Florida DBPR CILB licensees",
    track: "contractors",
    note: "has_bbb_contractor is never populated: BBB terms forbid aggregation and DBPR carries no per-parcel link.",
    columns: ["has_bbb_contractor"],
  },
  {
    key: "transit",
    label: "JTA GTFS static feed",
    track: "transit",
    note: "Straight-line (haversine) distance from the parcel centroid, not network walking distance.",
    columns: [
      "nearest_transit_stop_m", "nearest_transit_stop_id", "nearest_transit_stop_name",
      "nearest_transit_route_types", "nearest_transit_routes", "near_transit_800m",
    ],
  },
  {
    key: "places",
    label: "Overture Maps places",
    track: "places",
    columns: ["nearest_starbucks_m", "nearest_starbucks_id", "nearest_starbucks_name", "near_starbucks_800m"],
  },
  {
    key: "water",
    label: "COJ river polygons and USGS NHD hydrography",
    track: "water",
    note: "Proximity proxy, not a sightline analysis; water_basis states the method per row.",
    columns: ["water_view_flag", "water_view_major_flag", "water_dist_m", "water_body_name", "water_body_type", "water_basis"],
  },
  {
    key: "parcel_layer",
    label: "COJ parcel layer (CityBiz/Parcels)",
    track: "coj_parcels",
    note:
      "fld_zone and zoning fall back to the COJ address-point layer when the parcel layer has not been " +
      "loaded; on those rows parcel_layer_source is NULL and address_source carries the system instead.",
    columns: ["fld_zone", "zoning", "coj_last_sale_date"],
  },
  {
    key: "address",
    label: "COJ address points (ERAT)",
    track: "coj_addresses",
    columns: ["subdivision", "address_point_count"],
  },
  {
    key: "derived",
    label: "Computed by this pipeline from more than one of the families above",
    track: null,
    note: "Each of these names its own evidence in a sibling column (roof_age_basis, tenure_basis, water_basis).",
    columns: [
      "source_systems", "roof_year_est", "roof_age_basis", "roof_age_years",
      "last_sale_date_any", "tenure_basis", "tenure_source", "tenure_quality", "tenure_date_check",
      "has_sale_on_record",
      "years_since_last_sale", "no_sale_10y_flag",
    ],
  },
  {
    key: "pipeline",
    label: "Pipeline run bookkeeping",
    track: null,
    columns: ["property_cid", "features_run_id", "features_as_of", "run_id"],
  },
  {
    key: "placeholder",
    label: "Canonical Elephant columns no Duval source publishes",
    track: null,
    note: "Held NULL on purpose so the canonical column list stays complete; never defaulted to a value.",
    columns: ["avm_value", "hoa_flag"],
  },
];

/** Families that publish a `<key>_source` / `<key>_fetched_at` pair, in column order. */
export const SOURCE_FAMILIES: readonly ColumnFamily[] = COLUMN_FAMILIES.filter((f) => f.track !== null);

/** The provenance columns the families add, in the order buildFeatures emits them. */
export const FAMILY_PROVENANCE_COLUMNS: readonly string[] = [
  ...SOURCE_FAMILIES.flatMap((f) => [`${f.key}_source`, `${f.key}_fetched_at`]),
  "source_systems",
];

/** Latest fetch of a whole-feed source (GTFS, Overture, hydrography): one fetch covers every row. */
async function feedProvenance(
  conn: DuckDBConnection,
  table: string,
): Promise<{ system: string; fetchedAt: string } | null> {
  const r = await one<{ s: string | null; f: string | null }>(
    conn,
    `SELECT any_value(source_system) AS s, max(fetched_at)::VARCHAR AS f FROM ${table}`,
  );
  if (r.s === null || r.s === undefined) return null;
  return { system: r.s, fetchedAt: r.f ?? "" };
}

/**
 * Build derived.properties_features: one row per parcel, the 37 canonical query-table columns first
 * (order from elephant-query-db run-query-table-export.ts) followed by the Duval extras and the
 * per-family provenance pairs described on {@link ColumnFamily}.
 * Columns whose source is not loaded yet are NULL, never defaulted to false/0.
 */
export async function buildFeatures(
  conn: DuckDBConnection,
  opts: { asOf: string; runId: string },
): Promise<FeatureBuildStats> {
  const permitsLoaded = (await count(conn, "permits")) > 0;
  const businessesLoaded = (await count(conn, "businesses")) > 0;
  const transitLoaded = (await count(conn, "transit_stops")) > 0 && (await tableExists(conn, "derived", "nn_transit"));
  const placesLoaded = (await count(conn, "places")) > 0 && (await tableExists(conn, "derived", "nn_starbucks"));
  const waterLoaded = (await count(conn, "water_bodies")) > 0 && (await tableExists(conn, "derived", "water_distance"));
  const cojParcelsLoaded = (await count(conn, "coj_parcels")) > 0;
  const addressesLoaded = (await count(conn, "address_points")) > 0;
  const geometryLoaded = (await count(conn, "parcel_geometry")) > 0;
  const linksLoaded = (await count(conn, "entity_links")) > 0;
  const cidLoaded = (await tableExists(conn, "main", "consolidation_state")) && (await count(conn, "consolidation_state")) > 0;
  const paLoaded = (await tableExists(conn, "main", "pa_detail_buildings")) && (await count(conn, "pa_detail_buildings")) > 0;
  const cidJoin = cidLoaded ? "LEFT JOIN consolidation_state cs ON cs.property_id = p.parcel_id" : "";
  const paJoin = paLoaded
    ? `LEFT JOIN (SELECT parcel_id, min(roofing_cover) FILTER (WHERE roofing_cover IS NOT NULL) AS roofing_cover,
                        min(roof_structure) FILTER (WHERE roof_structure IS NOT NULL) AS roof_structure,
                        min(exterior_wall) FILTER (WHERE exterior_wall IS NOT NULL) AS exterior_wall,
                        max(actual_year_built) AS pa_year_built, sum(heated_area_sqft) AS pa_heated_area, sum(gross_area_sqft) AS pa_gross_area, count(*) AS pa_buildings,
                        any_value(source_system) AS src_system, max(fetched_at)::VARCHAR AS src_fetched_at
                 FROM pa_detail_buildings GROUP BY parcel_id) pa ON pa.parcel_id = p.parcel_id`
    : "";
  const geomJoin = geometryLoaded ? "LEFT JOIN parcel_geometry pg ON pg.parcel_id = p.parcel_id" : "";

  await conn.run("CREATE OR REPLACE TABLE derived.dor_use_codes (code VARCHAR, description VARCHAR)");
  const values = Object.entries(DOR_USE_CODES)
    .map(([code, desc]) => `(${q(code)}, ${q(desc)})`)
    .join(",");
  await conn.run(`INSERT INTO derived.dor_use_codes VALUES ${values}`);

  // has_sunbiz_tenant: a business linked to the parcel by situs address (entity_links), NULL until Sunbiz loads
  const sunbizJoin = businessesLoaded && linksLoaded
    ? `LEFT JOIN (SELECT l.to_id AS parcel_id, count(*) AS n, count(*) FILTER (WHERE l.match_method = 'situs_address_match') AS n_situs,
                        any_value(b.source_system) AS src_system, max(b.fetched_at)::VARCHAR AS src_fetched_at
                  FROM entity_links l LEFT JOIN businesses b ON b.doc_number = l.from_id
                  WHERE l.link_type = 'business_parcel' GROUP BY l.to_id) bz ON bz.parcel_id = p.parcel_id`
    : "";
  const hasSunbizExpr = businessesLoaded && linksLoaded ? "coalesce(bz.n_situs, 0) > 0" : "NULL::BOOLEAN";
  const sunbizCountExpr = businessesLoaded && linksLoaded ? "coalesce(bz.n, 0)::BIGINT" : "NULL::BIGINT";

  const permitJoin = permitsLoaded
    ? `LEFT JOIN (
         SELECT parcel_id, count(*) AS permit_count,
                count(*) FILTER (WHERE is_roof_permit) AS roof_permit_count,
                max(CASE WHEN is_roof_permit THEN year(coalesce(issue_date, applied_date)) END) AS last_roof_permit_year,
                max(CASE WHEN is_roof_permit THEN coalesce(issue_date, applied_date) END) AS last_roof_permit_date,
                max(coalesce(issue_date, applied_date)) AS last_permit_date,
                any_value(source_system) AS src_system, max(fetched_at)::VARCHAR AS src_fetched_at
         FROM permits WHERE parcel_id IS NOT NULL GROUP BY parcel_id) pm ON pm.parcel_id = p.parcel_id`
    : "";
  const hasPermitsExpr = permitsLoaded ? "coalesce(pm.permit_count, 0) > 0" : "NULL::BOOLEAN";
  const permitCountExpr = permitsLoaded ? "coalesce(pm.permit_count, 0)::BIGINT" : "NULL::BIGINT";
  const roofPermitCountExpr = permitsLoaded ? "coalesce(pm.roof_permit_count, 0)::BIGINT" : "NULL::BIGINT";
  const lastRoofYearExpr = permitsLoaded ? "pm.last_roof_permit_year" : "NULL::INTEGER";
  const lastRoofDateExpr = permitsLoaded ? "pm.last_roof_permit_date::VARCHAR" : "NULL::VARCHAR";
  const lastPermitDateExpr = permitsLoaded ? "pm.last_permit_date::VARCHAR" : "NULL::VARCHAR";

  const transitJoin = transitLoaded ? "LEFT JOIN derived.nn_transit tr ON tr.parcel_id = p.parcel_id" : "";
  const starbucksJoin = placesLoaded ? "LEFT JOIN derived.nn_starbucks sb ON sb.parcel_id = p.parcel_id" : "";
  const waterJoin = waterLoaded ? "LEFT JOIN derived.water_distance wd ON wd.parcel_id = p.parcel_id" : "";
  const cojJoin = cojParcelsLoaded ? "LEFT JOIN (SELECT * FROM coj_parcels QUALIFY row_number() OVER (PARTITION BY parcel_id ORDER BY last_sale_date DESC NULLS LAST) = 1) cj ON cj.parcel_id = p.parcel_id" : "";
  const addrJoin = addressesLoaded
    ? `LEFT JOIN (SELECT parcel_id, any_value(floodzone) AS floodzone, any_value(zoning) AS zoning, any_value(subdivision) AS subdivision, count(*) AS address_point_count,
                         any_value(source_system) AS src_system, max(fetched_at)::VARCHAR AS src_fetched_at
                  FROM address_points WHERE parcel_id IS NOT NULL GROUP BY parcel_id) ap ON ap.parcel_id = p.parcel_id`
    : "";

  const nn = (loaded: boolean, expr: string) => (loaded ? expr : "NULL");

  // Whole-feed sources: nn_transit / nn_starbucks / water_distance are derived tables that carry no
  // provenance of their own, so the feed's own source system and fetch time stand in for every row
  // they cover. One fetch produced all of them, so this is the literal truth, not an approximation.
  const transitFeed = transitLoaded ? await feedProvenance(conn, "transit_stops") : null;
  const placesFeed = placesLoaded ? await feedProvenance(conn, "places") : null;
  const waterFeed = waterLoaded ? await feedProvenance(conn, "water_bodies") : null;
  // Permits and Sunbiz answer for every parcel once loaded, including the negative answers
  // (has_permits false, has_sunbiz_tenant false), so their family covers every row and the
  // feed-level fetch time stands in where the parcel itself has no matched record.
  const permitFeed = permitsLoaded ? await feedProvenance(conn, "permits") : null;
  const businessFeed = businessesLoaded && linksLoaded ? await feedProvenance(conn, "businesses") : null;

  /** `<key>_source` / `<key>_fetched_at` expression pair per family, NULL where the family gave nothing. */
  const famWhen = (guard: string | null, system: string, fetchedAt: string): { src: string; at: string } =>
    guard === null
      ? { src: "NULL::VARCHAR", at: "NULL::VARCHAR" }
      : { src: `CASE WHEN ${guard} THEN ${system} END`, at: `CASE WHEN ${guard} THEN ${fetchedAt} END` };
  const feedFamily = (feed: { system: string; fetchedAt: string } | null, guard: string) =>
    feed === null ? famWhen(null, "", "") : famWhen(guard, q(feed.system), q(feed.fetchedAt));

  const familyProvenance: Record<string, { src: string; at: string }> = {
    // the spine is present on every row by construction
    appraisal: { src: `${q(SOURCES.appraisal.sourceSystem)}::VARCHAR`, at: "p.fetched_at::VARCHAR" },
    sales: famWhen("ls.parcel_id IS NOT NULL", "ls.source_system", "ls.fetched_at::VARCHAR"),
    geometry: geometryLoaded
      ? famWhen(
          "p.latitude IS NOT NULL",
          "coalesce(pg.source_system, p.geometry_source)",
          "coalesce(pg.fetched_at::VARCHAR, p.fetched_at::VARCHAR)",
        )
      : famWhen("p.latitude IS NOT NULL AND p.geometry_source IS NOT NULL", "p.geometry_source", "p.fetched_at::VARCHAR"),
    structure: paLoaded ? famWhen("pa.parcel_id IS NOT NULL", "pa.src_system", "pa.src_fetched_at") : famWhen(null, "", ""),
    permit: permitFeed === null
      ? famWhen(null, "", "")
      : famWhen("TRUE", `coalesce(pm.src_system, ${q(permitFeed.system)})`, `coalesce(pm.src_fetched_at, ${q(permitFeed.fetchedAt)})`),
    business: businessFeed === null
      ? famWhen(null, "", "")
      : famWhen("TRUE", `coalesce(bz.src_system, ${q(businessFeed.system)})`, `coalesce(bz.src_fetched_at, ${q(businessFeed.fetchedAt)})`),
    // has_bbb_contractor is a documented gap: no contractor source resolves to a parcel
    contractor: famWhen(null, "", ""),
    transit: feedFamily(transitFeed, "tr.parcel_id IS NOT NULL"),
    places: feedFamily(placesFeed, "sb.parcel_id IS NOT NULL"),
    water: feedFamily(waterFeed, "p.latitude IS NOT NULL"),
    parcel_layer: cojParcelsLoaded
      ? famWhen("cj.parcel_id IS NOT NULL", "cj.source_system", "cj.fetched_at::VARCHAR")
      : famWhen(null, "", ""),
    address: addressesLoaded ? famWhen("ap.parcel_id IS NOT NULL", "ap.src_system", "ap.src_fetched_at") : famWhen(null, "", ""),
  };

  const familySql = SOURCE_FAMILIES.flatMap((f) => {
    const pair = familyProvenance[f.key];
    if (pair === undefined) throw new Error(`no provenance expression for column family "${f.key}"`);
    return [`(${pair.src}) AS ${f.key}_source`, `(${pair.at}) AS ${f.key}_fetched_at`];
  }).join(",\n      ");
  // Row-level roll-up: every distinct source system that put a value in this row, sorted, comma joined.
  const sourceSystemsSql = `array_to_string(list_sort(list_distinct(list_filter([${SOURCE_FAMILIES.map(
    (f) => `(${familyProvenance[f.key]?.src ?? "NULL::VARCHAR"})`,
  ).join(", ")}], x -> x IS NOT NULL))), ',')`;

  // tenure: latest of the roll/SDF sale and the COJ last-sale date
  const rollSale = "ls.sale_date";
  const cojSale = cojParcelsLoaded ? "cj.last_sale_date" : "NULL::DATE";
  const anySale = `greatest(coalesce(${rollSale}, DATE '0001-01-01'), coalesce(${cojSale}, DATE '0001-01-01'))`;
  const anySaleExpr = `CASE WHEN ${rollSale} IS NULL AND ${cojSale} IS NULL THEN NULL ELSE ${anySale} END`;
  /**
   * tenure_basis names the column `last_sale_date_any` was taken from, and therefore the column
   * `years_since_last_sale` and `no_sale_10y_flag` were computed from:
   *   FDOR_SALE          -> last_sale_date       (FDOR SDF / NAL roll sale, 12.94% of Duval rows)
   *   COJ_SALESL         -> coj_last_sale_date   (COJ parcel layer SALESL, 99.43% of Duval rows)
   *   NO_SALE_ON_RECORD  -> no sale in any source; last_sale_date_any, years_since_last_sale and
   *                         no_sale_10y_flag are all NULL and MUST NOT be read as a long hold.
   * The value is never NULL, so "no transfer on record" and "a transfer we could not date" can
   * never be confused with each other, and has_sale_on_record makes the same split filterable.
   */
  const tenureBasis = `CASE
      WHEN ${rollSale} IS NOT NULL AND (${cojSale} IS NULL OR ${rollSale} >= ${cojSale}) THEN 'FDOR_SALE'
      WHEN ${cojSale} IS NOT NULL THEN 'COJ_SALESL'
      ELSE 'NO_SALE_ON_RECORD' END`;
  const tenureSource = `CASE
      WHEN ${rollSale} IS NOT NULL AND (${cojSale} IS NULL OR ${rollSale} >= ${cojSale}) THEN ls.source_system
      WHEN ${cojSale} IS NOT NULL THEN ${cojParcelsLoaded ? "cj.source_system" : "NULL::VARCHAR"}
      END`;

  const tenureQuality = tenureQualitySql(`(${anySaleExpr})`, "p.dor_uc");

  const ownerRegion = ownerRegionSql("p");
  const yearsSince = yearsSinceSql(`(${anySaleExpr})`, opts.asOf);

  await conn.run(`
    CREATE OR REPLACE TABLE derived.properties_features AS
    WITH last_sale AS (
      SELECT parcel_id, sale_date, sale_price, sale_source, qual_cd, or_book, or_page,
             source_system, fetched_at,
             count(*) OVER (PARTITION BY parcel_id) AS sale_count
      FROM sales_history
      WHERE sale_date IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY parcel_id ORDER BY sale_date DESC, sale_price DESC NULLS LAST, sale_source) = 1
    )
    SELECT
      -- canonical 37 columns (elephant-query-db order)
      p.parcel_id                                   AS property_id,
      ${cidLoaded ? "cs.cid" : "NULL::VARCHAR"}        AS property_cid,
      p.parcel_id                                   AS request_identifier,
      p.parcel_id                                   AS parcel_identifier,
      -- Canonical Elephant column, deliberately narrow: it names the source of the appraisal-roll
      -- spine this row is keyed on and NOTHING else. Enrichment columns carry their own
      -- <family>_source; source_systems lists every system that contributed to the row.
      ${q(COUNTY.sourceSystem)}                     AS source_system,
      ${q(COUNTY.name)}                             AS county_name,
      ${q(COUNTY.stateCode)}                        AS state_code,
      NULLIF(trim(concat_ws(' ', p.phy_addr1, p.phy_addr2)), '') AS address_street,
      p.phy_city                                    AS address_city,
      CASE WHEN length(regexp_replace(coalesce(p.phy_zipcd, ''), '[^0-9]', '', 'g')) >= 5
           THEN left(regexp_replace(p.phy_zipcd, '[^0-9]', '', 'g'), 5) END AS address_zip,
      p.latitude                                    AS latitude,
      p.longitude                                   AS longitude,
      CASE WHEN p.lnd_sqfoot > 0 THEN round(p.lnd_sqfoot / 43560.0, 4) END AS lot_size_acre,
      CASE WHEN p.lnd_sqfoot > 0 THEN p.lnd_sqfoot END AS lot_area_sqft,
      ${paLoaded ? "pa.exterior_wall" : "NULL::VARCHAR"} AS exterior_wall_material,
      ${paLoaded ? "regexp_replace(pa.roofing_cover, '^[0-9]+ ', '')" : "NULL::VARCHAR"} AS roof_covering_material,
      ${dorUseGroupSql("p.dor_uc")}                 AS property_type,
      coalesce(uc.description, p.dor_uc)            AS property_usage_type,
      CASE WHEN p.act_yr_blt > 0 THEN p.act_yr_blt END::BIGINT AS built_year,
      CASE WHEN p.tot_lvg_area > 0 THEN p.tot_lvg_area END AS livable_floor_area,
      ${paLoaded ? "pa.pa_gross_area" : "NULL::DOUBLE"}  AS total_area,
      p.av_nsd                                      AS assessed_value,
      p.jv                                          AS market_value,
      p.lnd_val                                     AS land_value,
      NULL::DOUBLE                                  AS avm_value,
      p.own_name                                    AS owner_name,
      NULLIF(concat_ws('; ', p.own_name, CASE WHEN p.fidu_name IS NOT NULL THEN 'c/o ' || p.fidu_name END), '') AS owners_text,
      -- owner_count is NULL on purpose. FDOR NAL publishes one 30-character OWN_NAME per parcel and
      -- no co-owner column (FIDU_NAME is a fiduciary and is empty for all 404,023 Duval parcels), so
      -- the number of owners is not in the source. It used to emit a literal 1, which is a constant
      -- dressed up as a count. Splitting the name on "&"/" AND " is not honest either: the 30-char
      -- truncation strips entity suffixes, so "SOUTHERN BELL TELEPHONE AND TE" is indistinguishable
      -- from two co-owners. has_additional_owners below publishes the one multi-owner signal the
      -- roll does carry.
      NULL::BIGINT                                  AS owner_count,
      CASE WHEN p.own_addr1 IS NULL OR p.phy_addr1 IS NULL THEN NULL
           ELSE upper(trim(p.own_addr1)) = upper(trim(p.phy_addr1))
            AND left(regexp_replace(coalesce(p.own_zipcd, ''), '[^0-9]', '', 'g'), 5) = left(regexp_replace(coalesce(p.phy_zipcd, ''), '[^0-9]', '', 'g'), 5) END AS owner_occupied,
      ls.sale_date::VARCHAR                         AS last_sale_date,
      ls.sale_price                                 AS last_sale_price,
      ${addressesLoaded ? "ap.subdivision" : "NULL::VARCHAR"} AS subdivision,
      ${hasPermitsExpr}                             AS has_permits,
      ${permitCountExpr}                            AS permit_count,
      ${hasSunbizExpr}                              AS has_sunbiz_tenant,
      NULL::BOOLEAN                                 AS has_bbb_contractor,
      NULL::BOOLEAN                                 AS hoa_flag,
      -- Duval extras
      p.dor_uc                                      AS dor_uc,
      p.pa_uc                                       AS pa_uc,
      CASE WHEN p.eff_yr_blt > 0 THEN p.eff_yr_blt END AS eff_year_built,
      p.tv_nsd                                      AS taxable_value,
      p.av_sd                                       AS assessed_value_school,
      coalesce(p.jv_hmstd, 0) > 0                   AS homestead_flag,
      p.no_buldng                                   AS building_count,
      p.no_res_unts                                 AS residential_units,
      p.s_legal                                     AS legal_description,
      p.nbrhd_cd                                    AS neighborhood_code,
      p.census_bk                                   AS census_block,
      p.own_addr1                                   AS owner_mailing_address,
      p.own_city                                    AS owner_mailing_city,
      p.own_state                                   AS owner_mailing_state,
      CASE WHEN length(regexp_replace(coalesce(p.own_zipcd, ''), '[^0-9]', '', 'g')) >= 5
           THEN left(regexp_replace(p.own_zipcd, '[^0-9]', '', 'g'), 5) END AS owner_mailing_zip,
      ${ownerRegion}                                AS owner_region_class,
      -- the roll's ET AL / ET UX marker: more owners exist than the one OWN_NAME names
      ${hasAdditionalOwnersSql("p.own_name")}       AS has_additional_owners,
      ls.sale_source                                AS last_sale_source,
      ls.qual_cd                                    AS last_sale_qual_cd,
      ls.or_book                                    AS last_sale_or_book,
      ls.or_page                                    AS last_sale_or_page,
      ls.sale_count::BIGINT                         AS sale_count,
      -- the date years_since_last_sale and no_sale_10y_flag are computed from; tenure_basis says
      -- which column it was taken from and tenure_source which system published it
      (${anySaleExpr})::VARCHAR                     AS last_sale_date_any,
      ${tenureBasis}                                AS tenure_basis,
      ${tenureSource}                               AS tenure_source,
      -- whether that tenure can be read as an ownership hold at all; see tenureQualitySql
      ${tenureQuality}                              AS tenure_quality,
      -- whether the row's own two dates corroborate that tenure; see tenureDateCheckSql
      ${tenureDateCheckSql(`(${anySaleExpr})`, "CASE WHEN p.act_yr_blt > 0 THEN p.act_yr_blt END")} AS tenure_date_check,
      ((${anySaleExpr}) IS NOT NULL)                AS has_sale_on_record,
      ${yearsSince}                                 AS years_since_last_sale,
      CASE WHEN (${anySaleExpr}) IS NULL THEN NULL
           ELSE (${anySaleExpr}) <= DATE '${opts.asOf}' - INTERVAL 10 YEAR END AS no_sale_10y_flag,
      ${sunbizCountExpr}                            AS sunbiz_business_count,
      ${roofPermitCountExpr}                        AS roof_permit_count,
      ${lastRoofYearExpr}                           AS last_roof_permit_year,
      ${lastRoofDateExpr}                           AS last_roof_permit_date,
      ${lastPermitDateExpr}                         AS last_permit_date,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN ${lastRoofYearExpr}
           WHEN p.eff_yr_blt > 0 THEN p.eff_yr_blt
           WHEN p.act_yr_blt > 0 THEN p.act_yr_blt END::INTEGER AS roof_year_est,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN 'PERMIT'
           WHEN p.eff_yr_blt > 0 THEN 'EFF_YR_BLT_PROXY'
           WHEN p.act_yr_blt > 0 THEN 'ACT_YR_BLT_PROXY' END AS roof_age_basis,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN year(DATE '${opts.asOf}') - ${lastRoofYearExpr}
           WHEN p.eff_yr_blt > 0 THEN year(DATE '${opts.asOf}') - p.eff_yr_blt
           WHEN p.act_yr_blt > 0 THEN year(DATE '${opts.asOf}') - p.act_yr_blt END::INTEGER AS roof_age_years,
      ${nn(waterLoaded, "CASE WHEN p.latitude IS NULL THEN NULL ELSE coalesce(wd.water_view_flag, false) END")}::BOOLEAN AS water_view_flag,
      ${nn(waterLoaded, "CASE WHEN p.latitude IS NULL THEN NULL ELSE coalesce(wd.water_view_flag AND wd.layer IN ('coj_stjohnsriver', 'coj_jax_river', 'nhd_NHDArea'), false) END")}::BOOLEAN AS water_view_major_flag,
      ${nn(waterLoaded, "wd.water_dist_m")}::DOUBLE   AS water_dist_m,
      ${nn(waterLoaded, "wd.water_name")}::VARCHAR    AS water_body_name,
      ${nn(waterLoaded, "wd.water_type")}::VARCHAR    AS water_body_type,
      ${nn(waterLoaded, `CASE WHEN p.latitude IS NULL THEN NULL
             WHEN wd.parcel_id IS NULL THEN 'no mapped water within ~1 km of centroid (COJ rivers + NHD)'
             WHEN wd.box_touch THEN 'parcel bbox within 30 m of ' || coalesce(wd.water_name, wd.water_type) || ' (' || wd.layer || ')'
             ELSE 'centroid ' || wd.water_dist_m::VARCHAR || ' m from shoreline of ' || coalesce(wd.water_name, wd.water_type) || ' (' || wd.layer || ')' END`)}::VARCHAR AS water_basis,
      ${nn(transitLoaded, "tr.nearest_transit_stop_m")}::DOUBLE      AS nearest_transit_stop_m,
      ${nn(transitLoaded, "tr.nearest_transit_stop_id")}::VARCHAR    AS nearest_transit_stop_id,
      ${nn(transitLoaded, "tr.nearest_transit_stop_name")}::VARCHAR  AS nearest_transit_stop_name,
      ${nn(transitLoaded, "tr.nearest_transit_stop_route_types")}::VARCHAR AS nearest_transit_route_types,
      ${nn(transitLoaded, "tr.nearest_transit_stop_route_short_names")}::VARCHAR AS nearest_transit_routes,
      ${nn(transitLoaded, `CASE WHEN tr.nearest_transit_stop_m IS NULL THEN NULL ELSE tr.nearest_transit_stop_m <= ${WALK_M} END`)}::BOOLEAN AS near_transit_800m,
      ${nn(placesLoaded, "sb.nearest_starbucks_m")}::DOUBLE        AS nearest_starbucks_m,
      ${nn(placesLoaded, "sb.nearest_starbucks_id")}::VARCHAR      AS nearest_starbucks_id,
      ${nn(placesLoaded, "sb.nearest_starbucks_name")}::VARCHAR    AS nearest_starbucks_name,
      ${nn(placesLoaded, `CASE WHEN sb.nearest_starbucks_m IS NULL THEN NULL ELSE sb.nearest_starbucks_m <= ${WALK_M} END`)}::BOOLEAN AS near_starbucks_800m,
      ${cojParcelsLoaded ? "cj.fld_zone" : addressesLoaded ? "ap.floodzone" : "NULL::VARCHAR"} AS fld_zone,
      ${cojParcelsLoaded ? "cj.zoning" : addressesLoaded ? "ap.zoning" : "NULL::VARCHAR"} AS zoning,
      ${cojParcelsLoaded ? "cj.last_sale_date::VARCHAR" : "NULL::VARCHAR"} AS coj_last_sale_date,
      ${addressesLoaded ? "ap.address_point_count::BIGINT" : "NULL::BIGINT"} AS address_point_count,
      ${paLoaded ? "pa.roof_structure" : "NULL::VARCHAR"} AS roof_structure,
      ${paLoaded ? "pa.pa_year_built" : "NULL::INTEGER"}  AS pa_actual_year_built,
      ${paLoaded ? "pa.pa_buildings::BIGINT" : "NULL::BIGINT"} AS pa_building_count,
      p.geometry_source                             AS coordinates_source,
      p.source_artifact                             AS source_artifact,
      p.source_sha256                               AS source_sha256,
      p.fetched_at::VARCHAR                         AS source_fetched_at,
      p.run_id                                      AS source_run_id,
      ${q(opts.runId)}                              AS features_run_id,
      DATE '${opts.asOf}'::VARCHAR                  AS features_as_of,
      -- per-family provenance (see ColumnFamily above): <family>_source / <family>_fetched_at is
      -- NULL on any row the family contributed nothing to
      ${familySql},
      NULLIF(${sourceSystemsSql}, '')               AS source_systems,
      -- UI provenance contract (ui/lib/sql.ts): primary source URL, fetch time, run id
      p.source_url                                  AS source_url,
      p.fetched_at                                  AS fetched_at,
      ${q(opts.runId)}                              AS run_id
    FROM parcels p
    -- DOR_USE_CODES is keyed on the two digit code ("01"), and the NAL roll writes it zero padded
    -- to three characters ("001"), so a direct equality never matched and coalesce fell back to the
    -- raw code on every row: property_usage_type published "001" rather than "Single Family" on all
    -- 404,023 parcels. Normalising through an integer handles both widths and yields NULL on a non
    -- numeric code, which the coalesce below still turns into the raw value.
    LEFT JOIN derived.dor_use_codes uc ON uc.code = lpad(TRY_CAST(p.dor_uc AS INTEGER)::VARCHAR, 2, '0')
    LEFT JOIN last_sale ls ON ls.parcel_id = p.parcel_id
    ${permitJoin}
    ${sunbizJoin}
    ${transitJoin}
    ${starbucksJoin}
    ${waterJoin}
    ${cojJoin}
    ${addrJoin}
    ${cidJoin}
    ${paJoin}
    ${geomJoin}
  `);

  const rows = await count(conn, "derived.properties_features");
  return { rows, asOf: opts.asOf, permitsLoaded, businessesLoaded, transitLoaded, placesLoaded, waterLoaded, cojParcelsLoaded, addressesLoaded };
}
