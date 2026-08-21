import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import { contractorSelectSql, dbprRejectedCount, ensureUtf8, pickColumn, readCsvHeader, ROOFING_CODES } from "../src/tracks/contractors.js";

const dir = mkdtempSync(join(tmpdir(), "duval-dbpr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DBPR CILB extract mapping", () => {
  it("resolves header variants and maps rows; Duval county code inferred from JACKSONVILLE rows", async () => {
    const csv = join(dir, "cilb_certified.csv");
    writeFileSync(
      csv,
      [
        "Board Number,Occupation Code,Licensee Name,DBA Name,Class,Address,City,State,Zip,County Code,License Number,Primary Status,Secondary Status,Original Licensure Date,Effective Date,Expiration Date",
        "06,CCC,RIVERSIDE ROOFING LLC,RIVERSIDE ROOFING,CERT,1303 W DEFENDER CT,JACKSONVILLE,FL,32218,16,CCC1330001,Current,Active,05/01/2015,09/01/2024,08/31/2026",
        "06,CGC,ACME BUILDERS INC,,CERT,1 MAIN ST,ORLANDO,FL,32801,48,CGC1500002,Current,Active,01/15/2010,09/01/2024,08/31/2026",
        "06,CBC,BEACH BUILD CO,,CERT,2 OCEAN DR,JACKSONVILLE BEACH,FL,32250,16,CBC1200003,Current,Active,bad date,09/01/2024,08/31/2026",
        // ragged row (missing trailing columns) and a quoted name with a comma + stray quote: the sniffer chokes on files like this
        "06,CGC,\"O'BRIEN, PAT \"\"PJ\"\" CONSTRUCTION\",,CERT,3 ELM ST,JACKSONVILLE,FL,32205,16,CGC1500004,Current",
        "06,CCC,BROKEN ROW WITH TOO,MANY,COLUMNS,HERE,X,FL,32205,16,CCC9999999,Current,Active,01/01/2020,09/01/2024,08/31/2026,EXTRA1,EXTRA2",
      ].join("\n"),
    );
    // a latin-1 byte sequence makes the file invalid UTF-8; ensureUtf8 transcodes it
    const { appendFileSync } = await import("node:fs");
    appendFileSync(csv, Buffer.from("\n06,CCC,CAF\xc9 ROOFING,,CERT,4 OAK ST,JACKSONVILLE,FL,32205,16,CCC1330005,Current,Active,01/01/2020,09/01/2024,08/31/2026", "latin1"));
    expect(ensureUtf8(csv)).toBe(true);
    expect(ensureUtf8(csv)).toBe(false);
    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");
    const cols = readCsvHeader(csv);
    expect(cols).toHaveLength(16);
    expect(cols[0]).toBe("Board Number");
    expect(pickColumn(cols, "License Number")).toBe("License Number");
    expect(pickColumn(["LICENSENUMBER"], "License Number")).toBe("LICENSENUMBER");
    expect(pickColumn(cols, "Nope")).toBeNull();
    await db.conn.run(`CREATE TABLE staging.c AS ${contractorSelectSql(cols, csv, "cilb_certified")}`);
    const rows = await all<Record<string, unknown>>(db.conn, "SELECT * FROM staging.c ORDER BY license_no");
    // 3 clean rows + the quoted-name row (ragged, null padded) + the over-long row (extras dropped) + the latin-1 row
    expect(rows.length).toBe(6);
    expect(rows.find((r) => r.license_no === "CCC1330001")).toMatchObject({ occupation_code: "CCC", county_code: "16", city: "JACKSONVILLE", original_license_date: "2015-05-01", expiration_date: "2026-08-31", extract_file: "cilb_certified" });
    expect(rows.find((r) => r.license_no === "CBC1200003")?.original_license_date).toBeNull();
    expect(rows.find((r) => r.license_no === "CGC1500004")).toMatchObject({ name: "O'BRIEN, PAT \"PJ\" CONSTRUCTION", secondary_status: null, expiration_date: null });
    expect(rows.find((r) => r.license_no === "CCC1330005")?.name).toBe("CAF\u00c9 ROOFING");
    // the over-long row is kept with its extra columns dropped (non-strict); nothing parseable is lost
    expect(rows.find((r) => r.license_no === "CCC9999999")).toMatchObject({ occupation_code: "CCC" });
    expect(await dbprRejectedCount(db.conn, csv, rows.length)).toBe(0);
    // a row that cannot be parsed at all (unterminated quote) is dropped and counted
    appendFileSync(csv, "\n06,CGC,\"UNTERMINATED QUOTE,,CERT,5 ASH ST,JACKSONVILLE,FL,32205,16,CGC1500006,Current,Active,01/01/2020,09/01/2024,08/31/2026");
    await db.conn.run(`CREATE OR REPLACE TABLE staging.c2 AS ${contractorSelectSql(cols, csv, "cilb_certified")}`);
    const rows2 = await all<Record<string, unknown>>(db.conn, "SELECT license_no FROM staging.c2");
    expect(await dbprRejectedCount(db.conn, csv, rows2.length)).toBe(1 + (6 - rows2.length));
    const code = await all<{ county_code: string; n: string | number }>(
      db.conn,
      "SELECT county_code, count(*) AS n FROM staging.c WHERE upper(city) LIKE 'JACKSONVILLE%' AND state = 'FL' GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
    );
    expect(code[0]?.county_code).toBe("16");
    expect(ROOFING_CODES).toContain("CCC");
    await db.close();
  });
});
