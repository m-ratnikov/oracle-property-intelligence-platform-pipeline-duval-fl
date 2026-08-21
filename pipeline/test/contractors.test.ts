import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import {
  contractorSelectSql,
  dbprRejectedCount,
  duvalContractorsSql,
  ensureUtf8,
  readCsvHeader,
  ROOFING_CODES,
} from "../src/tracks/contractors.js";

/**
 * Fixtures follow the real file, read off DBPR from a US runner (probe run 32474146746):
 * headerless, twelve quoted fields, one row per continuing-education course completion rather than
 * one row per licensee, city/state/zip in a single field, and no county column anywhere.
 */

const dir = mkdtempSync(join(tmpdir(), "duval-dbpr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** type, type text, licence, name, addr1, addr2, "CITY, ST  ZIP", expiry, course#, title, hours, date */
const row = (...f: string[]) => f.map((v) => `"${v}"`).join(",");

describe("DBPR CILB extract mapping", () => {
  it("maps by position, splits city/state/zip, and tolerates ragged and quoted rows", async () => {
    const csv = join(dir, "cilb_certified.csv");
    writeFileSync(
      csv,
      [
        row("CCC", "Cert Roofing", "CCC1330001", "RIVERSIDE ROOFING LLC", "1303 W DEFENDER CT", "", "JACKSONVILLE, FL  32218", "08/31/2026", "0008545", "LIEN LAW", "1", "07/29/2020"),
        // same licence, second course: the extract repeats the licensee on every completion
        row("CCC", "Cert Roofing", "CCC1330001", "RIVERSIDE ROOFING LLC", "1303 W DEFENDER CT", "", "JACKSONVILLE, FL  32218", "08/31/2026", "0008546", "WORKSITE SAFETY", "2", "08/30/2022"),
        row("CGC", "Cert General", "CGC1500002", "ACME BUILDERS INC", "1 MAIN ST", "", "ORLANDO, FL  32801", "08/31/2026", "0008545", "LIEN LAW", "1", "01/02/2021"),
        row("CBC", "Cert Building", "CBC1200003", "BEACH BUILD CO", "2 OCEAN DR", "STE 4", "JACKSONVILLE BEACH, FL  32250", "bad date", "0008545", "LIEN LAW", "1", "03/04/2019"),
        // a comma and escaped quotes inside a name, which is why the dialect sniffer cannot be used
        row("CGC", "Cert General", "CGC1500004", 'O\'BRIEN, PAT ""PJ"" CONSTRUCTION', "3 ELM ST", "", "JACKSONVILLE, FL  32205", "08/31/2026", "0008545", "LIEN LAW", "1", "05/06/2020"),
        // ragged row: fewer fields than the layout, kept by null_padding
        row("RC", "Reg Roofing", "RC1000005", "SHORT ROW ROOFING", "9 PINE ST", "", "NEPTUNE BEACH, FL  32266"),
      ].join("\n"),
    );
    // a latin-1 byte makes the file invalid UTF-8; ensureUtf8 transcodes it, then leaves it alone
    appendFileSync(csv, `\n${row("CCC", "Cert Roofing", "CCC1330006", "CAF\xc9 ROOFING", "4 OAK ST", "", "JACKSONVILLE, FL  32205", "08/31/2026", "0008545", "LIEN LAW", "1", "07/08/2021")}`, { encoding: "latin1" });
    expect(ensureUtf8(csv)).toBe(true);
    expect(ensureUtf8(csv)).toBe(false);

    // the file is headerless, so the "header" reader returns the first record; it exists to record
    // the layout in the run notes, not to name columns
    expect(readCsvHeader(csv)[0]).toBe("CCC");

    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");
    await db.conn.run(`CREATE TABLE staging.contractors_all AS ${contractorSelectSql(csv, "cilb_certified")}`);
    const staged = await all<Record<string, unknown>>(db.conn, "SELECT * FROM staging.contractors_all ORDER BY license_no, expiration_date");

    expect(staged).toHaveLength(7);
    expect(staged.find((r) => r.license_no === "CCC1330001")).toMatchObject({
      occupation_code: "CCC",
      license_class: "Cert Roofing",
      city: "JACKSONVILLE",
      state: "FL",
      zip: "32218",
      county_code: null, // the extract has no county field; nothing is invented
      primary_status: null,
      expiration_date: "2026-08-31",
      extract_file: "cilb_certified",
    });
    // address lines are joined, an unparseable date becomes NULL rather than a wrong date
    expect(staged.find((r) => r.license_no === "CBC1200003")).toMatchObject({ address: "2 OCEAN DR STE 4", expiration_date: null });
    expect(staged.find((r) => r.license_no === "CGC1500004")?.name).toBe('O\'BRIEN, PAT "PJ" CONSTRUCTION');
    expect(staged.find((r) => r.license_no === "CCC1330006")?.name).toBe("CAFÉ ROOFING");
    // the ragged row survives with its missing tail nulled
    expect(staged.find((r) => r.license_no === "RC1000005")).toMatchObject({ city: "NEPTUNE BEACH", expiration_date: null });
    expect(await dbprRejectedCount(db.conn, csv, staged.length)).toBe(0);
    await db.close();
  });

  it("collapses course rows to one row per licence, keeps Duval only, and flags roofing", async () => {
    const csv = join(dir, "agg.csv");
    writeFileSync(
      csv,
      [
        row("CCC", "Cert Roofing", "CCC1330001", "RIVERSIDE ROOFING LLC", "1303 W DEFENDER CT", "", "JACKSONVILLE, FL  32218", "08/31/2024", "0008545", "LIEN LAW", "1", "07/29/2020"),
        row("CCC", "Cert Roofing", "CCC1330001", "RIVERSIDE ROOFING LLC", "1303 W DEFENDER CT", "", "JACKSONVILLE, FL  32218", "08/31/2026", "0008546", "WORKSITE SAFETY", "2", "08/30/2022"),
        row("CGC", "Cert General", "CGC1500002", "ACME BUILDERS INC", "1 MAIN ST", "", "ORLANDO, FL  32801", "08/31/2026", "0008545", "LIEN LAW", "1", "01/02/2021"),
        row("CGC", "Cert General", "CGC1500007", "JAX GENERAL CO", "7 BAY ST", "", "JACKSONVILLE, FL  32202", "08/31/2027", "0008545", "LIEN LAW", "3", "02/03/2023"),
      ].join("\n"),
    );
    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");
    await db.conn.run(`CREATE TABLE staging.contractors_all AS ${contractorSelectSql(csv, "cilb_certified")}`);
    await db.conn.run(`CREATE TABLE staging.contractors AS ${duvalContractorsSql("staging.contractors_all")}`);
    const rows = await all<Record<string, unknown>>(db.conn, "SELECT * FROM staging.contractors ORDER BY license_no");

    // ORLANDO is dropped; the two RIVERSIDE course rows become one licence
    expect(rows.map((r) => r.license_no)).toEqual(["CCC1330001", "CGC1500007"]);
    const riverside = rows.find((r) => r.license_no === "CCC1330001");
    expect(riverside?.is_roofing).toBe(true);
    // the later expiry wins
    expect(riverside?.expiration_date).toBe("2026-08-31");
    const payload = JSON.parse(String(riverside?.source_payload)) as { ce_course_count: number; ce_hours_total: number; last_ce_date: string };
    expect(payload.ce_course_count).toBe(2);
    expect(payload.ce_hours_total).toBe(3);
    expect(payload.last_ce_date).toBe("2022-08-30");
    // a general contractor in Duval is kept but not flagged as roofing
    expect(rows.find((r) => r.license_no === "CGC1500007")?.is_roofing).toBe(false);
    expect(ROOFING_CODES).toContain("CCC");
    await db.close();
  });

  it("keeps a Duval zip whose city is not a known municipality, and drops out-of-state rows", async () => {
    const csv = join(dir, "zip.csv");
    writeFileSync(
      csv,
      [
        row("RC", "Reg Roofing", "RC2000001", "ZIP ONLY ROOFING", "1 A ST", "", "JAX, FL  32210", "08/31/2026", "1", "C", "1", "01/01/2024"),
        row("RC", "Reg Roofing", "RC2000002", "OUT OF STATE ROOFING", "2 B ST", "", "SAVANNAH, GA  31401", "08/31/2026", "1", "C", "1", "01/01/2024"),
      ].join("\n"),
    );
    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");
    await db.conn.run(`CREATE TABLE staging.contractors_all AS ${contractorSelectSql(csv, "cilb_registered")}`);
    await db.conn.run(`CREATE TABLE staging.contractors AS ${duvalContractorsSql("staging.contractors_all")}`);
    const rows = await all<{ license_no: string }>(db.conn, "SELECT license_no FROM staging.contractors");
    expect(rows.map((r) => r.license_no)).toEqual(["RC2000001"]);
    await db.close();
  });
});
