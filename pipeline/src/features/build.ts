import type { DuckDBConnection } from "@duckdb/node-api";
import { COUNTY } from "../config.js";
import { count, q } from "../db.js";
import { DOR_USE_CODES, dorUseGroupSql, ownerRegionSql, yearsSinceSql } from "./rules.js";

export interface FeatureBuildStats {
  rows: number;
  asOf: string;
  permitsLoaded: boolean;
  businessesLoaded: boolean;
  transitLoaded: boolean;
  placesLoaded: boolean;
  waterLoaded: boolean;
}

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
  const transitLoaded = (await count(conn, "transit_stops")) > 0;
  const placesLoaded = (await count(conn, "places")) > 0;
  const waterLoaded = (await count(conn, "water_bodies")) > 0;

  await conn.run("CREATE OR REPLACE TABLE derived.dor_use_codes (code VARCHAR, description VARCHAR)");
  const values = Object.entries(DOR_USE_CODES)
    .map(([code, desc]) => `(${q(code)}, ${q(desc)})`)
    .join(",");
  await conn.run(`INSERT INTO derived.dor_use_codes VALUES ${values}`);

  const hasSunbizExpr = businessesLoaded
    ? `EXISTS (SELECT 1 FROM businesses b
         WHERE upper(trim(b.principal_addr1)) = upper(trim(p.phy_addr1))
           AND left(regexp_replace(coalesce(b.principal_zip, ''), '[^0-9]', '', 'g'), 5) = left(regexp_replace(coalesce(p.phy_zipcd, ''), '[^0-9]', '', 'g'), 5))`
    : "NULL::BOOLEAN";

  const permitJoin = permitsLoaded
    ? `LEFT JOIN (
         SELECT parcel_id, count(*) AS permit_count,
                max(CASE WHEN is_roof THEN year(issue_date) END) AS last_roof_permit_year,
                max(CASE WHEN is_roof THEN issue_date END) AS last_roof_permit_date
         FROM permits WHERE parcel_id IS NOT NULL GROUP BY parcel_id) pm ON pm.parcel_id = p.parcel_id`
    : "";
  const hasPermitsExpr = permitsLoaded ? "coalesce(pm.permit_count, 0) > 0" : "NULL::BOOLEAN";
  const permitCountExpr = permitsLoaded ? "coalesce(pm.permit_count, 0)::BIGINT" : "NULL::BIGINT";
  const lastRoofYearExpr = permitsLoaded ? "pm.last_roof_permit_year" : "NULL::INTEGER";
  const lastRoofDateExpr = permitsLoaded ? "pm.last_roof_permit_date::VARCHAR" : "NULL::VARCHAR";

  // Nearest-neighbour distances are filled by the enrichment tracks (transit/places/water) into
  // derived.parcel_distances; they stay NULL until those tracks load.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS derived.parcel_distances (
      parcel_id VARCHAR NOT NULL,
      nearest_transit_stop_m DOUBLE, nearest_transit_stop_id VARCHAR, nearest_transit_stop_name VARCHAR,
      nearest_starbucks_m DOUBLE, nearest_starbucks_id VARCHAR, nearest_starbucks_name VARCHAR,
      water_dist_m DOUBLE, water_name VARCHAR, water_basis VARCHAR,
      run_id VARCHAR, computed_at TIMESTAMP)`);
  const distJoin = "LEFT JOIN derived.parcel_distances d ON d.parcel_id = p.parcel_id";

  const ownerRegion = ownerRegionSql("p");
  const yearsSince = yearsSinceSql("ls.sale_date", opts.asOf);

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
      NULL::VARCHAR                                 AS property_cid,
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
      NULL::VARCHAR                                 AS exterior_wall_material,
      NULL::VARCHAR                                 AS roof_covering_material,
      ${dorUseGroupSql("p.dor_uc")}                 AS property_type,
      coalesce(uc.description, p.dor_uc)            AS property_usage_type,
      CASE WHEN p.act_yr_blt > 0 THEN p.act_yr_blt END::BIGINT AS built_year,
      CASE WHEN p.tot_lvg_area > 0 THEN p.tot_lvg_area END AS livable_floor_area,
      NULL::DOUBLE                                  AS total_area,
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
      NULL::VARCHAR                                 AS subdivision,
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
      ${yearsSince}                                 AS years_since_last_sale,
      ${lastRoofYearExpr}                           AS last_roof_permit_year,
      ${lastRoofDateExpr}                           AS last_roof_permit_date,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN ${lastRoofYearExpr}
           WHEN p.eff_yr_blt > 0 THEN p.eff_yr_blt
           WHEN p.act_yr_blt > 0 THEN p.act_yr_blt END::INTEGER AS roof_year_est,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN 'PERMIT'
           WHEN p.eff_yr_blt > 0 THEN 'EFF_YR_BLT_PROXY'
           WHEN p.act_yr_blt > 0 THEN 'ACT_YR_BLT_PROXY' END AS roof_age_basis,
      CASE WHEN ${lastRoofYearExpr} IS NOT NULL THEN year(DATE '${opts.asOf}') - ${lastRoofYearExpr}
           WHEN p.eff_yr_blt > 0 THEN year(DATE '${opts.asOf}') - p.eff_yr_blt
           WHEN p.act_yr_blt > 0 THEN year(DATE '${opts.asOf}') - p.act_yr_blt END::INTEGER AS roof_age_years,
      CASE WHEN ${waterLoaded ? "true" : "false"} AND d.water_dist_m IS NOT NULL THEN d.water_dist_m <= 150 END AS water_view_flag,
      CASE WHEN ${waterLoaded ? "true" : "false"} THEN d.water_dist_m END AS water_dist_m,
      CASE WHEN ${waterLoaded ? "true" : "false"} THEN d.water_basis END AS water_basis,
      CASE WHEN ${transitLoaded ? "true" : "false"} THEN d.nearest_transit_stop_m END AS nearest_transit_stop_m,
      CASE WHEN ${transitLoaded ? "true" : "false"} THEN d.nearest_transit_stop_id END AS nearest_transit_stop_id,
      CASE WHEN ${transitLoaded ? "true" : "false"} THEN d.nearest_transit_stop_name END AS nearest_transit_stop_name,
      CASE WHEN ${placesLoaded ? "true" : "false"} THEN d.nearest_starbucks_m END AS nearest_starbucks_m,
      CASE WHEN ${placesLoaded ? "true" : "false"} THEN d.nearest_starbucks_id END AS nearest_starbucks_id,
      CASE WHEN ${placesLoaded ? "true" : "false"} THEN d.nearest_starbucks_name END AS nearest_starbucks_name,
      p.geometry_source                             AS coordinates_source,
      p.source_artifact                             AS source_artifact,
      p.source_sha256                               AS source_sha256,
      p.fetched_at::VARCHAR                         AS source_fetched_at,
      p.run_id                                      AS source_run_id,
      ${q(opts.runId)}                              AS features_run_id,
      DATE '${opts.asOf}'::VARCHAR                  AS features_as_of
    FROM parcels p
    LEFT JOIN derived.dor_use_codes uc ON uc.code = p.dor_uc
    LEFT JOIN last_sale ls ON ls.parcel_id = p.parcel_id
    ${permitJoin}
    ${distJoin}
  `);

  const rows = await count(conn, "derived.properties_features");
  return { rows, asOf: opts.asOf, permitsLoaded, businessesLoaded, transitLoaded, placesLoaded, waterLoaded };
}
