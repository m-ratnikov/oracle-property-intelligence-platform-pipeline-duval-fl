import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, openDb } from "../src/db.js";
import { contractorSelectSql, dbprReadCsv } from "../src/tracks/contractors.js";

/**
 * The DBPR extracts contain both a newline inside a quoted field and ragged rows. DuckDB's parallel
 * CSV scanner refuses null_padding together with quoted newlines and aborts the whole read - it does
 * not degrade - which killed the contractors track at line 8321 of cilb_certified.csv in Actions run
 * 32469673797. dbprReadCsv therefore pins parallel = false.
 *
 * Scope, honestly: the abort only happens once DuckDB actually parallelises, which it decides from
 * file size. Measured on this machine, a 60k row file reads fine either way, so no fixture of a
 * sane size reproduces the failure - it needs the real 754 MB extract. The first test covers what
 * IS reproducible (quoted newlines and ragged rows parse correctly); the guard against someone
 * removing the option is the second test, which asserts on the generated SQL.
 */

const dir = mkdtempSync(join(tmpdir(), "duval-dbpr-qnl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The real layout: headerless, twelve quoted fields, one row per course completion. */
const row = (...f: string[]) => f.map((v) => `"${v}"`).join(",");

describe("DBPR extract with newlines inside quoted fields", () => {
  it("parses quoted newlines and ragged rows without losing a row", async () => {
    const csv = join(dir, "quoted-newline.csv");
    writeFileSync(
      csv,
      [
        row("CCC", "Cert Roofing", "CCC1000001", "PLAIN ROOFING CO", "1 MAIN ST", "", "JACKSONVILLE, FL  32205", "08/31/2026", "1", "LIEN LAW", "1", "01/01/2020"),
        // a newline inside a quoted address: legal CSV, and fatal to the parallel scanner
        row("CCC", "Cert Roofing", "CCC1000002", "MULTILINE ROOFING", "2 OCEAN DR\nSUITE 400", "", "JACKSONVILLE, FL  32250", "08/31/2026", "1", "LIEN LAW", "1", "01/01/2020"),
        // a ragged row, which is what null_padding is there to tolerate
        row("RC", "Reg Roofing", "RC1000003", "SHORT ROW ROOFING", "3 ELM ST", "", "JACKSONVILLE, FL  32205"),
        row("CCC", "Cert Roofing", "CCC1000004", "LAST ROOFING CO", "4 OAK ST", "", "JACKSONVILLE, FL  32205", "08/31/2026", "1", "LIEN LAW", "1", "01/01/2020"),
      ].join("\n"),
    );

    const db = await openDb(":memory:");
    await db.conn.run("CREATE SCHEMA staging");

    // the reader itself must not throw on this file
    await db.conn.run(`CREATE TABLE staging.c AS ${contractorSelectSql(csv, "cilb_certified")}`);
    const rows = await all<Record<string, unknown>>(db.conn, "SELECT * FROM staging.c ORDER BY license_no");

    // all four rows survive: the quoted newline is one row, not two, and the ragged row is padded
    expect(rows).toHaveLength(4);
    // ordered by license_no, so the registered (RC) ragged row sorts last
    expect(rows.map((r) => r.license_no)).toEqual(["CCC1000001", "CCC1000002", "CCC1000004", "RC1000003"]);
    expect(String(rows[1]?.address)).toContain("SUITE 400");
    // the ragged row kept its data and was padded, not dropped
    expect(rows[3]?.name).toBe("SHORT ROW ROOFING");
    expect(rows[3]?.expiration_date).toBeNull();
    await db.close();
  });

  it("pins parallel = false in the generated reader", () => {
    // an accidental removal reintroduces a failure that only appears on the full 754 MB extract
    expect(dbprReadCsv(join(dir, "x.csv"))).toContain("parallel = false");
  });
});
