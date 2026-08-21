/**
 * The read only claim, tested at both layers.
 *
 * /api/agent is public, unauthenticated, runs in a process holding a model provider API key, and
 * executes SQL a model wrote after reading a caller's message. "Read only" therefore has to mean
 * the process cannot open a file or a URL, not merely that it will not write one. Two reviewers
 * found that it did not: the guard was a mutation keyword denylist, so
 * `SELECT content FROM read_text('/proc/self/environ')` walked straight through it.
 *
 * Layer one is the engine (lib/agent/db.ts): allowed_paths pinned to the one published parquet,
 * enable_external_access off, lock_configuration on. Layer two is guardSql (lib/sql.ts), which
 * refuses the statement earlier and with a usable reason.
 *
 * Every attack below is asserted against BOTH layers, because the point of two layers is that
 * either one alone still holds. A test that only proved the string guard would be testing the
 * layer that is expected to be incomplete.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { guardSql, PRESETS, STARTER_SQL, VIEW_NAME } from "@/lib/sql";

/**
 * Each entry is a statement that read a file, listed a directory or fetched a URL before this
 * change. The name says what it reaches for, so a failure names the hole rather than an index.
 */
const FILESYSTEM_ATTACKS: [name: string, sql: string][] = [
  ["read_text of the process environment", `SELECT content FROM read_text('/proc/self/environ')`],
  ["read_blob of a local file", `SELECT * FROM read_blob('/etc/passwd')`],
  ["glob of the whole filesystem", `SELECT * FROM glob('/**')`],
  ["read_csv_auto over a file:// URL", `SELECT * FROM read_csv_auto('file:///etc/passwd')`],
  ["read_json_auto of a local file", `SELECT * FROM read_json_auto('/etc/passwd')`],
  ["read_parquet of an attacker chosen URL", `SELECT * FROM read_parquet('https://attacker.example/x.parquet')`],
  ["read_csv over an attacker chosen URL", `SELECT * FROM read_csv('https://attacker.example/x.csv')`],
  ["parquet_metadata of a local file", `SELECT * FROM parquet_metadata('/etc/passwd')`],
  ["sniff_csv of a local file", `SELECT * FROM sniff_csv('/etc/passwd')`],
  ["parquet_scan of another path", `SELECT * FROM parquet_scan('/var/task/.env')`],
  ["an s3:// object", `SELECT * FROM read_parquet('s3://attacker-bucket/x.parquet')`],
];

/** The same reads, hidden. Obfuscation is the whole point of a second layer, so it gets its own list. */
const OBFUSCATED_ATTACKS: [name: string, sql: string][] = [
  [
    "nested in a subquery",
    `SELECT property_id FROM ${VIEW_NAME} WHERE property_id IN (SELECT content FROM read_text('/proc/self/environ'))`,
  ],
  [
    "aliased inside a CTE",
    `WITH leak AS (SELECT * FROM read_text('/proc/self/environ')) SELECT * FROM leak`,
  ],
  [
    "split by a block comment",
    `SELECT * FROM read_text/* nothing to see */('/proc/self/environ')`,
  ],
  [
    "hidden behind a line comment",
    `SELECT 1 -- and also\nUNION ALL SELECT content FROM read_text('/etc/hosts')`,
  ],
  [
    "quoted as an identifier",
    `SELECT * FROM "read_text"('/proc/self/environ')`,
  ],
  [
    "schema qualified",
    `SELECT * FROM main.read_text('/proc/self/environ')`,
  ],
  [
    "upper case with a space before the paren",
    `SELECT * FROM READ_TEXT ('/proc/self/environ')`,
  ],
  [
    "correlated in a scalar subquery",
    `SELECT property_id, (SELECT content FROM read_blob('/etc/passwd')) AS x FROM ${VIEW_NAME}`,
  ],
  [
    "joined onto the published view",
    `SELECT p.property_id FROM ${VIEW_NAME} p JOIN glob('/**') g ON true`,
  ],
];

/** Statements that try to unpick the engine settings rather than read a file directly. */
const ESCALATION_ATTACKS: [name: string, sql: string][] = [
  ["re-enabling external access", `SET enable_external_access = true`],
  ["widening allowed_paths", `SET allowed_paths = ['/etc/passwd']`],
  ["installing an extension", `INSTALL httpfs`],
  ["attaching another database", `ATTACH '/etc/passwd' AS leak`],
  ["copying rows out to disk", `COPY (SELECT 1) TO '/tmp/leak.csv'`],
];

describe("guardSql refuses every file system and network reader", () => {
  it.each(FILESYSTEM_ATTACKS)("rejects %s", (_name, sql) => {
    const result = guardSql(sql);
    expect(result.ok).toBe(false);
    expect(result.sql).toBeUndefined();
    // The reason has to be usable: the model reads it and retries, and a reader in the workbench
    // has to understand why. "rejected" would send both of them round the same loop.
    expect(result.reason).toMatch(/only|not allowed|cannot be called/i);
  });

  it.each(OBFUSCATED_ATTACKS)("rejects the same read %s", (_name, sql) => {
    expect(guardSql(sql).ok).toBe(false);
  });

  it.each(ESCALATION_ATTACKS)("rejects %s", (_name, sql) => {
    expect(guardSql(sql).ok).toBe(false);
  });
});

describe("guardSql still passes the statements the app actually runs", () => {
  it("accepts the workbench starter statement", () => {
    const result = guardSql(STARTER_SQL, 50);
    expect(result.ok, result.reason).toBe(true);
    expect(result.sql).toContain("LIMIT 50");
  });

  it.each(PRESETS.map((preset) => [preset.id, preset.sql(25)] as const))(
    "accepts the %s preset statement",
    (_id, sql) => {
      expect(guardSql(sql, 25).ok).toBe(true);
    },
  );

  it("does not refuse a legitimate LIKE over the published source_url column", () => {
    // source_url is a published column, so an https literal in a predicate is normal here. A
    // scheme denylist that caught it would be a guard people route around.
    const result = guardSql(
      `SELECT property_id FROM ${VIEW_NAME} WHERE source_url LIKE 'https://paopropertysearch%'`,
    );
    expect(result.ok, result.reason).toBe(true);
  });

  it("accepts an aggregate with a CASE and a window function", () => {
    const result = guardSql(
      `WITH ranked AS (SELECT property_id, years_since_last_sale,
         row_number() OVER (ORDER BY years_since_last_sale DESC) AS rn
       FROM ${VIEW_NAME} WHERE years_since_last_sale IS NOT NULL)
       SELECT * FROM ranked WHERE rn <= 5`,
    );
    expect(result.ok, result.reason).toBe(true);
  });
});

describe("the engine itself refuses the same reads, with the guard bypassed", () => {
  let db: PropertyDb;

  beforeAll(async () => {
    db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each([...FILESYSTEM_ATTACKS, ...OBFUSCATED_ATTACKS])(
    "the sealed database refuses %s",
    async (_name, sql) => {
      // db.query runs the raw statement: no guardSql anywhere on this path. This is the layer that
      // has to hold when the denylist above does not.
      await expect(db.query(sql)).rejects.toThrow();
    },
  );

  it.each(ESCALATION_ATTACKS)("the sealed database refuses %s", async (_name, sql) => {
    await expect(db.query(sql)).rejects.toThrow();
  });

  it("names configuration lock or disabled file system as the reason, not a syntax error", async () => {
    // A statement that failed for the wrong reason would leave this suite passing while the hole
    // stayed open, so the message is asserted rather than just the rejection.
    await expect(db.query(`SELECT * FROM read_text('/etc/hosts')`)).rejects.toThrow(
      /disabled by configuration|Permission Error/i,
    );
    await expect(db.query(`SET enable_external_access = true`)).rejects.toThrow(
      /locked|Cannot change configuration/i,
    );
  });

  it("still reads the one parquet it was opened over", async () => {
    const result = await db.query(`SELECT count(*) AS n FROM ${VIEW_NAME}`);
    expect(Number(result.rows[0].n)).toBeGreaterThan(0);
  });

  it("runs every preset against the sealed database", async () => {
    for (const preset of PRESETS) {
      const result = await db.query(preset.sql(5));
      expect(result.rows.length, `${preset.id} returned no rows`).toBeGreaterThan(0);
    }
  });

  it("runs the workbench starter statement against the sealed database", async () => {
    const guarded = guardSql(STARTER_SQL, 10);
    expect(guarded.ok).toBe(true);
    const result = await db.query(guarded.sql!);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
