import { describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import {
  DOR_USE_CODES,
  classifyOwnerRegion,
  dorUseGroup,
  dorUseGroupSql,
  ownerRegionSql,
  yearsSinceLastSale,
  yearsSinceSql,
} from "../src/features/rules.js";

const FIXTURES: { state: string | null; city: string | null; zip: string | null; expected: string | null }[] = [
  { state: "FL", city: "JACKSONVILLE", zip: "32207", expected: "LOCAL" },
  { state: "FL", city: "JACKSONVILLE", zip: "32207-1234", expected: "LOCAL" },
  { state: "FL", city: "ATLANTIC BEACH", zip: "32233", expected: "LOCAL" },
  { state: "FL", city: "JACKSONVILLE", zip: null, expected: "LOCAL" },
  { state: "FL", city: "SAINT JOHNS", zip: "32259", expected: "REGIONAL" },
  { state: "FL", city: "MIAMI", zip: "33101", expected: "REGIONAL" },
  { state: "FL", city: "ORANGE PARK", zip: null, expected: "REGIONAL" },
  { state: "GA", city: "ATLANTA", zip: "30301", expected: "REGIONAL" },
  { state: "SC", city: "CHARLESTON", zip: "29401", expected: "REGIONAL" },
  { state: "AL", city: "MOBILE", zip: "36601", expected: "REGIONAL" },
  { state: "NY", city: "NEW YORK", zip: "10001", expected: "NATIONAL" },
  { state: "CA", city: "LOS ANGELES", zip: "90001", expected: "NATIONAL" },
  { state: "DC", city: "WASHINGTON", zip: "20001", expected: "NATIONAL" },
  { state: "PR", city: "SAN JUAN", zip: "00901", expected: "NATIONAL" },
  { state: "ON", city: "TORONTO", zip: "M5H 2N2", expected: "FOREIGN" },
  { state: "UK", city: "LONDON", zip: null, expected: "FOREIGN" },
  { state: null, city: "JACKSONVILLE", zip: "32207", expected: null },
  { state: "", city: null, zip: null, expected: null },
];

describe("owner_region_class rule", () => {
  it("classifies the fixtures (TS)", () => {
    for (const f of FIXTURES) {
      expect(classifyOwnerRegion({ ownState: f.state, ownCity: f.city, ownZip: f.zip }), JSON.stringify(f)).toBe(f.expected);
    }
  });

  it("SQL twin agrees with the TS rule on every fixture", async () => {
    const db = await openDb(":memory:");
    const values = FIXTURES.map(
      (f, i) =>
        `(${i}, ${f.state === null ? "NULL" : `'${f.state}'`}, ${f.city === null ? "NULL" : `'${f.city}'`}, ${f.zip === null ? "NULL" : `'${f.zip}'`})`,
    ).join(",");
    await db.conn.run(`CREATE TABLE p AS SELECT * FROM (VALUES ${values}) t(i, own_state, own_city, own_zipcd)`);
    const rows = await all<{ i: number; cls: string | null }>(db.conn, `SELECT i, ${ownerRegionSql("p")} AS cls FROM p ORDER BY i`);
    rows.forEach((r, idx) => expect(r.cls, JSON.stringify(FIXTURES[idx])).toBe(FIXTURES[idx]?.expected ?? null));
    await db.close();
  });
});

describe("years_since_last_sale", () => {
  const asOf = new Date("2026-08-21T00:00:00Z");
  it("floors whole years and handles nulls / future dates", () => {
    expect(yearsSinceLastSale("2016-08-01", asOf)).toBe(10);
    expect(yearsSinceLastSale("2016-09-01", asOf)).toBe(9);
    expect(yearsSinceLastSale("2026-08-01", asOf)).toBe(0);
    expect(yearsSinceLastSale("2027-01-01", asOf)).toBe(0);
    expect(yearsSinceLastSale(null, asOf)).toBeNull();
    expect(yearsSinceLastSale("not-a-date", asOf)).toBeNull();
  });

  it("SQL twin agrees with the TS rule", async () => {
    const db = await openDb(":memory:");
    const dates = ["2016-08-01", "2016-09-01", "2026-08-01", "2027-01-01", "1999-12-31", "2010-02-28"];
    await db.conn.run(`CREATE TABLE s AS SELECT * FROM (VALUES ${dates.map((d) => `(DATE '${d}')`).join(",")}) t(sale_date)`);
    const rows = await all<{ sale_date: string; y: number | null }>(
      db.conn,
      `SELECT sale_date::VARCHAR AS sale_date, ${yearsSinceSql("sale_date", "2026-08-21")} AS y FROM s`,
    );
    for (const r of rows) expect(Number(r.y)).toBe(yearsSinceLastSale(r.sale_date, asOf));
    await db.close();
  });
});

describe("DOR use code grouping", () => {
  it("groups by FDOR code families (TS + SQL)", async () => {
    expect(dorUseGroup("01")).toBe("RESIDENTIAL");
    expect(dorUseGroup("004")).toBe("RESIDENTIAL");
    expect(dorUseGroup("11")).toBe("COMMERCIAL");
    expect(dorUseGroup("48")).toBe("INDUSTRIAL");
    expect(dorUseGroup("55")).toBe("AGRICULTURAL");
    expect(dorUseGroup("71")).toBe("INSTITUTIONAL");
    expect(dorUseGroup("86")).toBe("GOVERNMENTAL");
    expect(dorUseGroup("95")).toBe("MISCELLANEOUS");
    expect(dorUseGroup(null)).toBeNull();
    const db = await openDb(":memory:");
    const rows = await all<{ c: string; g: string }>(
      db.conn,
      `SELECT c, ${dorUseGroupSql("c")} AS g FROM (VALUES ('01'),('11'),('48'),('55'),('71'),('86'),('95')) t(c)`,
    );
    for (const r of rows) expect(r.g).toBe(dorUseGroup(r.c));
    await db.close();
  });

  // The NAL roll writes dor_uc zero padded to three characters ("001"), and DOR_USE_CODES is keyed
  // on the two digit code ("01"). The features join compared them directly, so it never matched and
  // property_usage_type published the raw code on all 404,023 published parcels rather than a
  // description. The join now normalises through an integer; this asserts the normalisation lands on
  // a key the map actually holds, for both widths and for the codes that were wrong in production.
  it("resolves a three character dor_uc to a use code description", async () => {
    const db = await openDb(":memory:");
    const rows = await all<{ c: string; k: string }>(
      db.conn,
      `SELECT c, lpad(TRY_CAST(c AS INTEGER)::VARCHAR, 2, '0') AS k
       FROM (VALUES ('001'),('004'),('000'),('080'),('017'),('01'),('80'),('XX')) t(c)`,
    );
    const key = (c: string) => rows.find((r) => r.c === c)?.k;

    expect(key("001")).toBe("01");
    expect(DOR_USE_CODES[key("001") as string]).toBe("Single Family");
    expect(DOR_USE_CODES[key("000") as string]).toBe("Vacant Residential");
    expect(DOR_USE_CODES[key("080") as string]).toBeDefined();
    expect(key("017")).toBe("17");

    // The two character form already worked and must keep working.
    expect(key("01")).toBe("01");
    expect(key("80")).toBe("80");

    // A non numeric code yields NULL, which the coalesce in the features build turns back into the
    // raw value rather than dropping it.
    expect(key("XX")).toBeNull();

    await db.close();
  });
});
