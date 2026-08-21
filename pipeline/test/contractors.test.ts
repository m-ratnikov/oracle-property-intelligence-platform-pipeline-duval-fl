import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import { contractorSelectSql, pickColumn, ROOFING_CODES } from "../src/tracks/contractors.js";

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
      ].join("\n"),
    );
    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");
    const cols = (await all<{ column_name: string }>(db.conn, `DESCRIBE SELECT * FROM read_csv('${csv.replace(/\\/g, "/")}', header = true, all_varchar = true)`)).map((r) => r.column_name);
    expect(pickColumn(cols, "License Number")).toBe("License Number");
    expect(pickColumn(["LICENSENUMBER"], "License Number")).toBe("LICENSENUMBER");
    expect(pickColumn(cols, "Nope")).toBeNull();
    await db.conn.run(`CREATE TABLE staging.c AS ${contractorSelectSql(cols, csv, "cilb_certified")}`);
    const rows = await all<Record<string, unknown>>(db.conn, "SELECT * FROM staging.c ORDER BY license_no");
    expect(rows.length).toBe(3);
    expect(rows[1]).toMatchObject({ license_no: "CCC1330001", occupation_code: "CCC", county_code: "16", city: "JACKSONVILLE", original_license_date: "2015-05-01", expiration_date: "2026-08-31", extract_file: "cilb_certified" });
    expect(rows[0]?.original_license_date).toBeNull();
    const code = await all<{ county_code: string; n: string | number }>(
      db.conn,
      "SELECT county_code, count(*) AS n FROM staging.c WHERE upper(city) LIKE 'JACKSONVILLE%' AND state = 'FL' GROUP BY 1 ORDER BY 2 DESC LIMIT 1",
    );
    expect(code[0]?.county_code).toBe("16");
    expect(ROOFING_CODES).toContain("CCC");
    await db.close();
  });
});
