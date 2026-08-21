import { all, count, scalar } from "../db.js";
import { normalizeAddressSql, normalizeNameSql, ownerKindSql, zip5Sql } from "../features/normalize.js";
import { hashStaging, mergeStaging } from "../merge.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

/**
 * Reconciliation across datasets:
 *  - owners: one row per (normalized owner name, normalized mailing line 1 + ZIP5), parcel_count;
 *  - entity_links parcel -> owner (owner_name_mailing_hash, 1.0);
 *  - entity_links business -> parcel by normalized situs address + ZIP5 (situs_address_match, 0.8)
 *    and by normalized owner name == business name (owner_name_match, 0.7);
 *  - entity_links coj_parcel -> parcel and address_point -> parcel by normalized RE (parcel_id_norm, 1.0).
 * entity_links is rebuilt from the current tables each run (deterministic, replaces the previous set).
 */
export const runLinks: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const now = new Date().toISOString();

  await ctx.conn.run(`
    CREATE OR REPLACE TABLE staging.owners AS
    WITH norm AS (
      SELECT parcel_id, own_name,
             ${normalizeNameSql("own_name")} AS name_norm,
             concat_ws('|', ${normalizeAddressSql("own_addr1")}, ${zip5Sql("own_zipcd")}) AS mailing_norm,
             own_addr1, own_city, own_state, ${zip5Sql("own_zipcd")} AS zip5
      FROM parcels WHERE own_name IS NOT NULL)
    SELECT md5(coalesce(name_norm, '') || '#' || coalesce(mailing_norm, '')) AS owner_id,
           min(own_name) AS owner_name, name_norm, mailing_norm,
           min(own_addr1) AS mailing_addr1, min(own_city) AS mailing_city, min(own_state) AS mailing_state, min(zip5) AS mailing_zip,
           ${ownerKindSql("min(own_name)")} AS owner_kind,
           count(*)::INTEGER AS parcel_count
    FROM norm GROUP BY name_norm, mailing_norm`);
  const prov = { sourceSystem: source.sourceSystem, sourceUrl: "derived:parcels", sourceArtifact: null, sourceSha256: null, fetchedAt: now, runId: ctx.runId };
  const hashed = await hashStaging(ctx.conn, "staging.owners", prov);
  result.merge = await mergeStaging(ctx.conn, { target: "owners", staging: hashed, keys: ["owner_id"] });
  result.rowsStaged = result.merge.staged;
  log.info("owners_merged", { ...result.merge });

  await ctx.conn.run("DELETE FROM entity_links");
  // parcel -> owner
  await ctx.conn.run(`
    INSERT INTO entity_links
    SELECT md5('parcel_owner|' || p.parcel_id) AS link_id, 'parcel_owner', 'parcel', p.parcel_id, 'owner', o.owner_id,
           'owner_name_mailing_hash', 1.0, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
    FROM parcels p
    JOIN owners o ON o.owner_id = md5(coalesce(${normalizeNameSql("p.own_name")}, '') || '#' ||
                                      coalesce(concat_ws('|', ${normalizeAddressSql("p.own_addr1")}, ${zip5Sql("p.own_zipcd")}), ''))
    WHERE p.own_name IS NOT NULL`);
  const businesses = await count(ctx.conn, "businesses");
  if (businesses > 0) {
    await ctx.conn.run(`
      CREATE OR REPLACE TEMP TABLE b_norm AS
      SELECT doc_number, name, ${normalizeNameSql("name")} AS name_norm,
             ${normalizeAddressSql("principal_addr1")} AS p_addr, ${zip5Sql("principal_zip")} AS p_zip,
             ${normalizeAddressSql("mail_addr1")} AS m_addr, ${zip5Sql("mail_zip")} AS m_zip
      FROM businesses`);
    await ctx.conn.run(`
      CREATE OR REPLACE TEMP TABLE p_norm AS
      SELECT parcel_id, ${normalizeAddressSql("phy_addr1")} AS s_addr, ${zip5Sql("phy_zipcd")} AS s_zip, ${normalizeNameSql("own_name")} AS owner_norm
      FROM parcels`);
    await ctx.conn.run(`
      INSERT INTO entity_links
      SELECT md5('business_parcel|' || b.doc_number || '|' || p.parcel_id || '|situs') , 'business_parcel', 'business', b.doc_number, 'parcel', p.parcel_id,
             'situs_address_match', 0.8, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
      FROM b_norm b JOIN p_norm p ON p.s_addr = b.p_addr AND p.s_zip = b.p_zip
      WHERE b.p_addr IS NOT NULL AND p.s_zip IS NOT NULL`);
    await ctx.conn.run(`
      INSERT INTO entity_links
      SELECT md5('business_parcel|' || b.doc_number || '|' || p.parcel_id || '|owner') , 'business_parcel', 'business', b.doc_number, 'parcel', p.parcel_id,
             'owner_name_match', 0.7, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
      FROM b_norm b JOIN p_norm p ON p.owner_norm = b.name_norm
      WHERE b.name_norm IS NOT NULL AND length(b.name_norm) >= 6
        AND NOT EXISTS (SELECT 1 FROM entity_links e WHERE e.from_id = b.doc_number AND e.to_id = p.parcel_id)`);
    await ctx.conn.run("DROP TABLE IF EXISTS b_norm; DROP TABLE IF EXISTS p_norm");
  }
  if ((await count(ctx.conn, "coj_parcels")) > 0) {
    await ctx.conn.run(`
      INSERT INTO entity_links
      SELECT md5('coj_parcel|' || c.re), 'coj_parcel_parcel', 'coj_parcel', c.re, 'parcel', p.parcel_id, 'parcel_id_norm', 1.0, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
      FROM coj_parcels c JOIN parcels p ON p.parcel_id = c.parcel_id WHERE c.parcel_id IS NOT NULL`);
  }
  if ((await count(ctx.conn, "address_points")) > 0) {
    await ctx.conn.run(`
      INSERT INTO entity_links
      SELECT md5('address_point|' || a.address_id), 'address_parcel', 'address_point', a.address_id, 'parcel', p.parcel_id, 'parcel_id_norm', 1.0, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
      FROM address_points a JOIN parcels p ON p.parcel_id = a.parcel_id WHERE a.parcel_id IS NOT NULL`);
  }
  if ((await count(ctx.conn, "permits")) > 0) {
    await ctx.conn.run(`
      INSERT INTO entity_links
      SELECT md5('permit_parcel|' || pm.permit_no), 'permit_parcel', 'permit', pm.permit_no, 'parcel', p.parcel_id, 'parcel_id_norm', 1.0, NULL, '${ctx.runId}', '${now}'::TIMESTAMP
      FROM permits pm JOIN parcels p ON p.parcel_id = pm.parcel_id WHERE pm.parcel_id IS NOT NULL`);
  }
  const byType = await all<{ link_type: string; match_method: string; n: string | number }>(
    ctx.conn,
    "SELECT link_type, match_method, count(*) AS n FROM entity_links GROUP BY 1, 2 ORDER BY 1, 2",
  );
  result.notes.links = byType.map((r) => ({ link_type: r.link_type, match_method: r.match_method, n: Number(r.n) }));
  result.notes.parcelsLinkedToBusiness = Number(await scalar(ctx.conn, "SELECT count(DISTINCT to_id) FROM entity_links WHERE link_type = 'business_parcel'"));
  result.notes.businessesLinkedToParcel = Number(await scalar(ctx.conn, "SELECT count(DISTINCT from_id) FROM entity_links WHERE link_type = 'business_parcel'"));
  result.notes.owners = await count(ctx.conn, "owners");
  log.info("links_built", { ...result.notes });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
