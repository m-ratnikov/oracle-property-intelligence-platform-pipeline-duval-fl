import type { DuckDBConnection } from "@duckdb/node-api";
import { COUNTY } from "../config.js";
import { count, q, tableExists } from "../db.js";
import { DOR_USE_CODES, dorUseGroupSql, ownerRegionSql, yearsSinceSql } from "./rules.js";

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
 * Build derived.properties_features: one row per parcel, the 37 canonical query-table columns first
 * (order from elephant-query-db run-query-table-export.ts) followed by the Duval extras.
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
  const linksLoaded = (await count(conn, "entity_links")) > 0;
  const cidLoaded = (await tableExists(conn, "main", "consolidation_state")) && (await count(conn, "consolidation_state")) > 0;
  const paLoaded = (await tableExists(conn, "main", "pa_detail_buildings")) && (await count(conn, "pa_detail_buildings")) > 0;
  const cidJoin = cidLoaded ? "LEFT JOIN consolidation_state cs ON cs.property_id = p.parcel_id" : "";
  const paJoin = paLoaded
    ? `LEFT JOIN (SELECT parcel_id, min(roofing_cover) FILTER (WHERE roofing_cover IS NOT NULL) AS roofing_cover,
                        min(roof_structure) FILTER (WHERE roof_structure IS NOT NULL) AS roof_structure,
                        min(exterior_wall) FILTER (WHERE exterior_wall IS NOT NULL) AS exterior_wall,
                        max(actual_year_built) AS pa_year_built, sum(heated_area_sqft) AS pa_heated_area, sum(gross_area_sqft) AS pa_gross_area, count(*) AS pa_buildings
                 FROM pa_detail_buildings GROUP BY parcel_id) pa ON pa.parcel_id = p.parcel_id`
    : "";

  await conn.run("CREATE OR REPLACE TABLE derived.dor_use_codes (code VARCHAR, description VARCHAR)");
  const values = Object.entries(DOR_USE_CODES)
    .map(([code, desc]) => `(${q(code)}, ${q(desc)})`)
    .join(",");
  await conn.run(`INSERT INTO derived.dor_use_codes VALUES ${values}`);

  // has_sunbiz_tenant: a business linked to the parcel by situs address (entity_links), NULL until Sunbiz loads
  const sunbizJoin = businessesLoaded && linksLoaded
    ? `LEFT JOIN (SELECT to_id AS parcel_id, count(*) AS n, count(*) FILTER (WHERE match_method = 'situs_address_match') AS n_situs
                  FROM entity_links WHERE link_type = 'business_parcel' GROUP BY to_id) bz ON bz.parcel_id = p.parcel_id`
    : "";
  const hasSunbizExpr = businessesLoaded && linksLoaded ? "coalesce(bz.n_situs, 0) > 0" : "NULL::BOOLEAN";
  const sunbizCountExpr = businessesLoaded && linksLoaded ? "coalesce(bz.n, 0)::BIGINT" : "NULL::BIGINT";

  const permitJoin = permitsLoaded
    ? `LEFT JOIN (
         SELECT parcel_id, count(*) AS permit_count,
                count(*) FILTER (WHERE is_roof_permit) AS roof_permit_count,
                max(CASE WHEN is_roof_permit THEN year(coalesce(issue_date, applied_date)) END) AS last_roof_permit_year,
                max(CASE WHEN is_roof_permit THEN coalesce(issue_date, applied_date) END) AS last_roof_permit_date,
                max(coalesce(issue_date, applied_date)) AS last_permit_date
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
    ? `LEFT JOIN (SELECT parcel_id, any_value(floodzone) AS floodzone, any_value(zoning) AS zoning, any_value(subdivision) AS subdivision, count(*) AS address_point_count
                  FROM address_points WHERE parcel_id IS NOT NULL GROUP BY parcel_id) ap ON ap.parcel_id = p.parcel_id`
    : "";

  const nn = (loaded: boolean, expr: string) => (loaded ? expr : "NULL");
  // tenure: latest of the roll/SDF sale and the COJ last-sale date
  const rollSale = "ls.sale_date";
  const cojSale = cojParcelsLoaded ? "cj.last_sale_date" : "NULL::DATE";
  const anySale = `greatest(coalesce(${rollSale}, DATE '0001-01-01'), coalesce(${cojSale}, DATE '0001-01-01'))`;
  const anySaleExpr = `CASE WHEN ${rollSale} IS NULL AND ${cojSale} IS NULL THEN NULL ELSE ${anySale} END`;
  const tenureBasis = `CASE
      WHEN ${rollSale} IS NOT NULL AND (${cojSale} IS NULL OR ${rollSale} >= ${cojSale}) THEN 'FDOR_SALE'
      WHEN ${cojSale} IS NOT NULL THEN 'COJ_SALESL'
      ELSE NULL END`;

  const ownerRegion = ownerRegionSql("p");
  const yearsSince = yearsSinceSql(`(${anySaleExpr})`, opts.asOf);

  await conn.run(`
    CREATE OR REPLACE TABLE derived.properties_features AS
    WITH last_sale AS (
      SELECT parcel_id, sale_date, sale_price, sale_source, qual_cd, or_book, or_page,
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
      CASE WHEN p.own_name IS NOT NULL THEN 1 END::BIGINT AS owner_count,
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
      ls.sale_source                                AS last_sale_source,
      ls.qual_cd                                    AS last_sale_qual_cd,
      ls.or_book                                    AS last_sale_or_book,
      ls.or_page                                    AS last_sale_or_page,
      ls.sale_count::BIGINT                         AS sale_count,
      (${anySaleExpr})::VARCHAR                     AS last_sale_date_any,
      ${tenureBasis}                                AS tenure_basis,
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
      -- UI provenance contract (ui/lib/sql.ts): primary source URL, fetch time, run id
      p.source_url                                  AS source_url,
      p.fetched_at                                  AS fetched_at,
      ${q(opts.runId)}                              AS run_id
    FROM parcels p
    LEFT JOIN derived.dor_use_codes uc ON uc.code = p.dor_uc
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
  `);

  const rows = await count(conn, "derived.properties_features");
  return { rows, asOf: opts.asOf, permitsLoaded, businessesLoaded, transitLoaded, placesLoaded, waterLoaded, cojParcelsLoaded, addressesLoaded };
}
