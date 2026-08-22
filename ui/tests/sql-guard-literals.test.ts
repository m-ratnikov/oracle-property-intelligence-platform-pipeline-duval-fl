/**
 * Two holes in the browser side guard, and the reason each one was a hole.
 *
 * tests/sql-guard.test.ts covers the reader functions at both layers. This file covers what that
 * one did not: a read that names no reader at all, and a statement the guard rewrote into a
 * different statement before running it.
 *
 * 1. DuckDB's replacement scan makes a bare single quoted string in FROM position a file or URL
 *    read. `SELECT * FROM '/etc/passwd'` and `SELECT * FROM 'https://evil.example.com/x.parquet'`
 *    both passed every rule, because every rule was looking for a function call. The first test
 *    below proves the replacement scan is real against the sample parquet rather than asserting it.
 *
 * 2. Comment stripping was a pair of regexes with no idea what a string literal is, so
 *    `LIKE '%--%'` was rewritten into an unterminated statement - and the rewritten text was what
 *    executed, which the guard's own docstring said it was not.
 *
 * The server engine is sealed separately (lib/agent/db.ts: allowed_paths, enable_external_access
 * off, lock_configuration on) and tests/sql-guard.test.ts proves that layer. Nothing here relies
 * on it: this is the browser tab's only layer, so it is asserted on its own.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBInstance as Instance } from "@duckdb/node-api";
import { guardSql, stripSqlComments, PRESETS, STARTER_SQL, VIEW_NAME } from "@/lib/sql";

const SAMPLE = resolve(process.cwd(), "public", "sample", "query-table.parquet")
  .replace(/\\/g, "/")
  .replace(/'/g, "''");

describe("a bare string literal in table position is a file read", () => {
  let instance: Instance;
  let connection: DuckDBConnection;

  beforeAll(async () => {
    // A plain, unsealed DuckDB, on purpose: the point is what the ENGINE does with this syntax,
    // which is what makes the guard rule necessary. Sealing it here would prove the seal instead.
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
  }, 60_000);

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  it("reads a parquet file with no reader function named anywhere in the statement", async () => {
    const result = await connection.runAndReadAll(`SELECT count(*) AS n FROM '${SAMPLE}'`);
    const [row] = result.getRowObjects() as Record<string, unknown>[];
    expect(
      Number(row.n),
      "if this ever stops reading the file, the guard rule below can be revisited",
    ).toBeGreaterThan(0);
  });

  it.each([
    ["an attacker chosen https parquet", `SELECT * FROM 'https://evil.example.com/x.parquet'`],
    ["a local path", `SELECT * FROM '/etc/passwd'`],
    ["a relative path", `SELECT * FROM 'query-table.parquet'`],
    ["a joined file", `SELECT p.property_id FROM ${VIEW_NAME} p JOIN '/etc/passwd' f ON true`],
    ["wrapped in parentheses", `SELECT * FROM ('/etc/passwd')`],
    ["split across lines", `SELECT *\nFROM\n  '/etc/passwd'`],
    ["hidden behind a comment", `SELECT * FROM /* table */ 'https://evil.example.com/x.parquet'`],
    ["inside a CTE", `WITH leak AS (SELECT * FROM '/etc/passwd') SELECT * FROM leak`],
    ["in a scalar subquery", `SELECT (SELECT count(*) FROM '/etc/passwd') AS n`],
  ])("guardSql refuses %s", (_name, sql) => {
    const result = guardSql(sql);
    expect(result.ok).toBe(false);
    expect(result.sql).toBeUndefined();
    expect(result.reason).toMatch(/file or URL read|only read|not allowed/i);
  });

  it("still accepts a normal query over the published view", () => {
    expect(guardSql(`SELECT * FROM ${VIEW_NAME}`).ok).toBe(true);
    expect(guardSql(`SELECT * FROM "${VIEW_NAME}" AS p WHERE p.built_year > 1990`).ok).toBe(true);
  });
});

describe("comment stripping knows what a string literal is", () => {
  it("leaves a comment marker inside a literal alone", () => {
    const sql = `SELECT * FROM ${VIEW_NAME} WHERE legal_description LIKE '%--%'`;
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("does not rewrite a statement it is about to execute", () => {
    /*
     * The bug: `LIKE '%--%'` was stripped to `LIKE '%`, and THAT text is what the guard handed to
     * the engine. Either the reader got a syntax error on a statement they never wrote, or worse,
     * a valid statement that meant something else. What comes back must still be the caller's
     * query.
     */
    const sql = `SELECT property_id FROM ${VIEW_NAME} WHERE legal_description LIKE '%--%'`;
    const result = guardSql(sql, 10);
    expect(result.ok, result.reason).toBe(true);
    expect(result.sql).toContain(`LIKE '%--%'`);
    expect(result.sql).toContain("LIMIT 10");
  });

  it("still removes a real comment before the statement executes", () => {
    const result = guardSql(`SELECT 1 AS a -- trailing note\n`, 5);
    expect(result.ok, result.reason).toBe(true);
    expect(result.sql).not.toContain("--");
    expect(result.sql).not.toContain("trailing note");
  });

  it("still refuses a second statement hidden behind a comment", () => {
    expect(guardSql(`SELECT 1 -- harmless\n; DROP TABLE ${VIEW_NAME}`).ok).toBe(false);
    expect(guardSql(`SELECT 1 /* x */ ; DROP TABLE ${VIEW_NAME}`).ok).toBe(false);
  });

  it("still refuses a reader split by a block comment", () => {
    expect(guardSql(`SELECT * FROM read_text/* nothing */('/etc/passwd')`).ok).toBe(false);
  });

  it("does not mistake data for code", () => {
    // A semicolon and a forbidden keyword inside a literal are text, not statements. Refusing
    // these was a false positive that taught readers the guard was noise.
    expect(guardSql(`SELECT * FROM ${VIEW_NAME} WHERE legal_description LIKE '%LOT 3; BLK 2%'`).ok).toBe(
      true,
    );
    expect(guardSql(`SELECT * FROM ${VIEW_NAME} WHERE owner_name LIKE '%COPY%'`).ok).toBe(true);
  });
});

describe("PRAGMA may inspect, not assign", () => {
  it("accepts the introspection form the /query page documents", () => {
    expect(guardSql(`PRAGMA show_tables`).ok).toBe(true);
    expect(guardSql(`PRAGMA table_info('${VIEW_NAME}')`).ok).toBe(true);
  });

  it("refuses the assignment form, which is SET under another name", () => {
    for (const sql of [
      `PRAGMA memory_limit='4GB'`,
      `PRAGMA enable_external_access = true`,
      `PRAGMA threads=1`,
    ]) {
      const result = guardSql(sql);
      expect(result.ok, sql).toBe(false);
      expect(result.reason).toMatch(/not set an option/i);
    }
  });
});

describe("nothing the app itself runs regressed", () => {
  it("accepts the workbench starter statement", () => {
    expect(guardSql(STARTER_SQL, 50).ok).toBe(true);
  });

  it.each(PRESETS.map((preset) => [preset.id, preset.sql(25)] as const))(
    "accepts the %s preset statement",
    (_id, sql) => {
      const result = guardSql(sql, 25);
      expect(result.ok, result.reason).toBe(true);
    },
  );

  it("still accepts a LIKE over the published source_url column", () => {
    const result = guardSql(
      `SELECT property_id FROM ${VIEW_NAME} WHERE source_url LIKE 'https://paopropertysearch%'`,
    );
    expect(result.ok, result.reason).toBe(true);
  });
});
