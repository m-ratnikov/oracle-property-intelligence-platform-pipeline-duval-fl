import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ensureSchema, openDb, all } from "../src/db.js";
import { arcgisDateWhere, buildQueryUrl, epochToIso, fetchArcgisAll } from "../src/tracks/arcgis.js";
import { parseAddressPoint, stageAddressPoints } from "../src/tracks/coj_addresses.js";
import { cojSaleDate, parseCojParcel, stageCojParcels, type CojParcelRow } from "../src/tracks/coj_parcels.js";

const here = dirname(fileURLToPath(import.meta.url));
const page1 = JSON.parse(readFileSync(join(here, "fixtures/coj-parcels-page1.json"), "utf8")) as { features: { attributes: Record<string, unknown> }[] };
const page2 = JSON.parse(readFileSync(join(here, "fixtures/coj-parcels-page2.json"), "utf8")) as { features: { attributes: Record<string, unknown> }[] };
const addrPage = JSON.parse(readFileSync(join(here, "fixtures/coj-addresses-page.json"), "utf8")) as { features: { attributes: Record<string, unknown> }[] };

/** A fake ArcGIS server: count endpoint + two pages of 2 / 1 features. */
function fakeArcgis(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    if (u.searchParams.get("returnCountOnly") === "true") return new Response(JSON.stringify({ count: 3 }), { status: 200 });
    const offset = Number(u.searchParams.get("resultOffset") ?? "0");
    const body = offset === 0 ? page1 : page2;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("ArcGIS paging + COJ parcel parsing", () => {
  it("pages by resultOffset using the layer count, with the documented outFields", async () => {
    const calls: string[] = [];
    const res = await fetchArcgisAll({ baseUrl: "https://maps.coj.net/x/query", where: "1=1", outFields: "RE,LAT", pageSize: 2, fetchImpl: fakeArcgis(calls), concurrency: 2, delayMs: 0 });
    expect(res.total).toBe(3);
    expect(res.pages).toBe(2);
    expect(res.features.length).toBe(3);
    expect(res.errors).toEqual([]);
    expect(calls.some((c) => c.includes("returnCountOnly=true"))).toBe(true);
    expect(calls.filter((c) => c.includes("resultOffset=")).length).toBe(2);
    const u = new URL(buildQueryUrl({ baseUrl: "https://maps.coj.net/x/query", where: "1=1", outFields: "RE", pageSize: 2000 }, 4000));
    expect(u.searchParams.get("resultRecordCount")).toBe("2000");
    expect(u.searchParams.get("resultOffset")).toBe("4000");
    expect(u.searchParams.get("f")).toBe("json");
    expect(u.searchParams.get("returnGeometry")).toBe("false");
  });

  it("parses COJ parcel attributes incl. the SALESL* date and joins to NAL by normalized RE", async () => {
    const rows = [...page1.features, ...page2.features].map(parseCojParcel).filter((r): r is CojParcelRow => r !== null);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ re: "000001-0005", fld_zone: "A", zoning: "AGR", last_sale_date: "2004-06-15", acres: 73.42, latitude: 30.4441 });
    expect(rows[1]?.last_sale_date).toBe("2025-06-03");
    expect(rows[2]?.last_sale_date).toBeNull();
    expect(cojSaleDate(99, 12, 31)).toBe("1999-12-31");
    expect(cojSaleDate(0, 0, 0)).toBeNull();
    expect(cojSaleDate("2010", "7", null)).toBe("2010-07-01");

    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`INSERT INTO parcels (parcel_id, row_hash, source_system, fetched_at, run_id) VALUES ('0000010005R','h','duval_appraiser',now(),'r'), ('1688712134R','h','duval_appraiser',now(),'r')`);
    await stageCojParcels(db.conn, rows);
    const staged = await all<{ re: string; parcel_id: string | null; fld_zone: string }>(db.conn, "SELECT re, parcel_id, fld_zone FROM staging.coj_parcels ORDER BY re");
    expect(staged).toEqual([
      { re: "000001-0005", parcel_id: "0000010005R", fld_zone: "A" },
      { re: "000002-0010", parcel_id: null, fld_zone: "AE" },
      { re: "168871-2134", parcel_id: "1688712134R", fld_zone: "X" },
    ]);
    await db.close();
  });
});

describe("COJ address points (incremental by EDIT_DATE)", () => {
  it("parses epoch dates, drops rows without ADDRESS_ID, links to parcels, builds the date filter", async () => {
    const rows = addrPage.features.map(parseAddressPoint).filter((r): r is NonNullable<typeof r> => r !== null);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ address_id: "1001", re_raw: "168871-2134", floodzone: "X", subdivision: "DEFENDER PLACE" });
    expect(rows[0]?.edit_date).toBe("2025-08-21T00:00:00.000Z");
    expect(epochToIso(null)).toBeNull();
    expect(arcgisDateWhere("EDIT_DATE", "2026-08-21T07:00:00.000Z")).toBe("EDIT_DATE >= timestamp '2026-08-21 07:00:00'");

    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`INSERT INTO parcels (parcel_id, row_hash, source_system, fetched_at, run_id) VALUES ('1688712134R','h','duval_appraiser',now(),'r')`);
    await stageAddressPoints(db.conn, rows);
    const staged = await all<{ address_id: string; parcel_id: string | null }>(db.conn, "SELECT address_id, parcel_id FROM staging.address_points ORDER BY address_id");
    expect(staged).toEqual([
      { address_id: "1001", parcel_id: "1688712134R" },
      { address_id: "1002", parcel_id: null },
    ]);
    await db.close();
  });
});
