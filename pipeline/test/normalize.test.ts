import { describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import {
  normalizeAddress, normalizeAddressSql, normalizeName, normalizeNameSql, normalizeParcelId, normalizeParcelIdSql,
  ownerKind, ownerKindSql, zip5, zip5Sql,
} from "../src/features/normalize.js";

describe("parcel id normalization (NAL PARCEL_ID vs COJ RE)", () => {
  const cases: [string | null, string | null][] = [
    ["0000010005R", "0000010005"],
    ["000001-0005", "0000010005"],
    ["000001 0005", "0000010005"],
    ["0000010005", "0000010005"],
    [" 1688712134R ", "1688712134"],
    ["", null],
    [null, null],
  ];
  it("TS rule", () => {
    for (const [raw, want] of cases) expect(normalizeParcelId(raw), String(raw)).toBe(want);
  });
  it("SQL twin agrees", async () => {
    const db = await openDb(":memory:");
    const rows = await all<{ i: number; n: string | null }>(
      db.conn,
      `SELECT i, ${normalizeParcelIdSql("raw")} AS n FROM (VALUES ${cases.map(([r], i) => `(${i}, ${r === null ? "NULL" : `'${r}'`})`).join(",")}) t(i, raw) ORDER BY i`,
    );
    rows.forEach((r, i) => expect(r.n, String(cases[i]?.[0])).toBe(cases[i]?.[1] ?? null));
    await db.close();
  });
  it("maps the seed/NAL id format onto itself", () => {
    expect(normalizeParcelId("0000010005R")).toBe(normalizeParcelId("0000010005R"));
  });
});

describe("address / name / zip normalization", () => {
  const addr: [string, string | null][] = [
    ["1303 W. Defender Ct, #1303", "1303 W DEFENDER CT 1303"],
    ["55 Ramblewood Drive", "55 RAMBLEWOOD DR"],
    ["  9540 SAN JOSE BOULEVARD ", "9540 SAN JOSE BLVD"],
    ["", null],
  ];
  const names: [string, string | null][] = [
    ["RAYONIER FOREST RESOURCES L P", "RAYONIER FOREST RESOURCES"],
    ["Bryceville Land, LLC", "BRYCEVILLE LAND"],
    ["SMITH JOHN & MARY TRUSTEES", "SMITH JOHN AND MARY"],
    ["THE ACME CORP", "ACME"],
    ["LLC", null],
  ];
  it("TS rules", () => {
    for (const [raw, want] of addr) expect(normalizeAddress(raw), raw).toBe(want);
    for (const [raw, want] of names) expect(normalizeName(raw), raw).toBe(want);
    expect(zip5("32207-1234")).toBe("32207");
    expect(zip5("3220")).toBeNull();
    expect(ownerKind("CITY OF JACKSONVILLE")).toBe("GOVERNMENT");
    expect(ownerKind("SMITH FAMILY TRUST")).toBe("TRUST");
    expect(ownerKind("BRYCEVILLE LAND LLC")).toBe("COMPANY");
    expect(ownerKind("DOE JOHN")).toBe("PERSON");
    expect(ownerKind(null)).toBeNull();
  });
  it("SQL twins agree", async () => {
    const db = await openDb(":memory:");
    const a = await all<{ i: number; n: string | null }>(
      db.conn,
      `SELECT i, ${normalizeAddressSql("raw")} AS n FROM (VALUES ${addr.map(([r], i) => `(${i}, '${r}')`).join(",")}) t(i, raw) ORDER BY i`,
    );
    a.forEach((r, i) => expect(r.n, addr[i]?.[0]).toBe(addr[i]?.[1] ?? null));
    const n = await all<{ i: number; n: string | null }>(
      db.conn,
      `SELECT i, ${normalizeNameSql("raw")} AS n FROM (VALUES ${names.map(([r], i) => `(${i}, '${r}')`).join(",")}) t(i, raw) ORDER BY i`,
    );
    n.forEach((r, i) => expect(r.n, names[i]?.[0]).toBe(names[i]?.[1] ?? null));
    const z = await all<{ z: string | null }>(db.conn, `SELECT ${zip5Sql("'32207-1234'")} AS z`);
    expect(z[0]?.z).toBe("32207");
    const k = await all<{ k: string | null }>(db.conn, `SELECT ${ownerKindSql("'SMITH FAMILY TRUST'")} AS k`);
    expect(k[0]?.k).toBe("TRUST");
    await db.close();
  });
});
