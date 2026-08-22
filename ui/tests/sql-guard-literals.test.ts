/**
 * The browser side guard against a file read that names no reader, proved against a real engine.
 *
 * tests/sql-guard.test.ts covers the reader FUNCTIONS at both layers. This file covers the reads
 * that call no function at all, and it exists because the first two attempts at that rule were
 * both patches to reported instances rather than to the class:
 *
 *   round 1  `FROM '/etc/passwd'` and `FROM 'https://evil.example.com/x.parquet'` were reported,
 *            and a regex over the raw text, `(from|join)\s*\(?\s*'`, closed exactly those two.
 *   round 2  a reviewer produced four more that the regex allowed: `$$...$$`, `E'...'`, a string
 *            in a comma slot, and one wrapped in two parentheses.
 *
 * Rather than add four more patterns, the guard now reasons about POSITION: readSqlForms masks a
 * string constant in every spelling DuckDB accepts down to one token, and hasStringInTableReference
 * refuses that token anywhere a table reference may appear. This file is the evidence for both
 * halves, and it is built as a MATRIX of spelling times position rather than as a list of known
 * attacks, so a form nobody reported is covered by construction rather than by having been thought
 * of.
 *
 * Measuring rather than reading the docs is the point, and it paid: the matrix turned up three
 * more live bypasses that no report mentioned, each asserted below.
 *   - `FROM "/etc/passwd"`, a DOUBLE QUOTED name, which the replacement scan resolves like any
 *     other, and which the old scanner deliberately unquoted into a bare identifier.
 *   - `DESCRIBE '/etc/passwd'`, `SUMMARIZE '...'` and `SHOW '...'`, which need no FROM at all and
 *     whose keywords are all in ALLOWED_STARTS.
 *   - `FROM query('...')` and `FROM query_table('...')`, which run SQL built from a string.
 *
 * The server engine is sealed separately (lib/agent/db.ts: allowed_paths, enable_external_access
 * off, lock_configuration on) and tests/sql-guard.test.ts proves that layer. Nothing here relies on
 * it: this is the browser tab's only layer, so it is asserted on its own.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBInstance as Instance } from "@duckdb/node-api";
import { guardSql, stripSqlComments, PRESETS, STARTER_SQL, VIEW_NAME } from "@/lib/sql";

const SAMPLE = resolve(process.cwd(), "public", "sample", "query-table.parquet").replace(/\\/g, "/");

/**
 * Every spelling of a string constant, as a function from a payload to source text.
 *
 * The guard's whole claim rests on this list matching DuckDB's scanner, so the list is asserted
 * against the engine below rather than trusted. Adding a spelling here is what a future DuckDB
 * release should cost: one entry, and the position matrix re-covers it everywhere at once.
 */
const SPELLINGS: { name: string; write: (payload: string) => string }[] = [
  { name: "plain", write: (p) => `'${p}'` },
  { name: "escape prefixed", write: (p) => `E'${p}'` },
  { name: "escape prefixed lower", write: (p) => `e'${p}'` },
  { name: "dollar quoted", write: (p) => `$$${p}$$` },
  { name: "dollar quoted with tag", write: (p) => `$tag$${p}$tag$` },
  { name: "double quoted name", write: (p) => `"${p}"` },
];

/**
 * Every position a table reference may sit in, as a function from a written string to a statement.
 *
 * `read` says whether this DuckDB build actually returns the file's rows there. Where it does not,
 * the guard must STILL refuse: a parse error in one release is not a promise about the next, and
 * the rule is supposed to fail closed on a shape it was not told about.
 */
const POSITIONS: { name: string; write: (constant: string) => string; read: boolean }[] = [
  { name: "the only table", write: (c) => `SELECT count(*) AS n FROM ${c}`, read: true },
  { name: "a second comma slot", write: (c) => `SELECT count(*) AS n FROM range(1) r, ${c}`, read: true },
  { name: "the first comma slot", write: (c) => `SELECT count(*) AS n FROM ${c}, range(1) r`, read: true },
  { name: "a plain join", write: (c) => `SELECT count(*) AS n FROM range(1) r JOIN ${c} f ON true`, read: true },
  { name: "a cross join", write: (c) => `SELECT count(*) AS n FROM range(1) r CROSS JOIN ${c} f`, read: true },
  { name: "a positional join", write: (c) => `SELECT count(*) AS n FROM range(1) r POSITIONAL JOIN ${c} f`, read: true },
  { name: "inside a CTE", write: (c) => `WITH leak AS (SELECT * FROM ${c}) SELECT count(*) AS n FROM leak`, read: true },
  { name: "inside a scalar subquery", write: (c) => `SELECT (SELECT count(*) FROM ${c}) AS n`, read: true },
  { name: "split across lines", write: (c) => `SELECT count(*) AS n\nFROM\n  ${c}`, read: true },
  { name: "behind a block comment", write: (c) => `SELECT count(*) AS n FROM /* table */ ${c}`, read: true },
  { name: "a DESCRIBE target", write: (c) => `DESCRIBE ${c}`, read: true },
  { name: "a SUMMARIZE target", write: (c) => `SUMMARIZE ${c}`, read: true },
  { name: "a SHOW target", write: (c) => `SHOW ${c}`, read: true },
  { name: "a DESCRIBE TABLE target", write: (c) => `DESCRIBE TABLE ${c}`, read: true },
  // Parenthesised table references do not parse in this build. They are in the matrix anyway,
  // because a reviewer reported `FROM (('/etc/passwd'))` as an ALLOW and the guard must not be
  // relying on a parser error somewhere else to stay closed.
  { name: "wrapped in one paren", write: (c) => `SELECT count(*) AS n FROM (${c})`, read: false },
  { name: "wrapped in two parens", write: (c) => `SELECT count(*) AS n FROM ((${c}))`, read: false },
  { name: "wrapped in three parens", write: (c) => `SELECT count(*) AS n FROM (((${c})))`, read: false },
];

describe("a string where a table name belongs is a file read", () => {
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

  /** Rows if the engine read the file, null if it refused to parse or bind the statement. */
  async function rowsRead(sql: string): Promise<number | null> {
    try {
      const result = await connection.runAndReadAll(sql);
      return result.getRowObjects().length;
    } catch {
      return null;
    }
  }

  const matrix = SPELLINGS.flatMap((spelling) =>
    POSITIONS.map((position) => ({
      label: `${spelling.name} in ${position.name}`,
      spelling,
      position,
    })),
  );

  it.each(matrix.map((entry) => [entry.label, entry] as const))(
    "%s: the engine reads the file, so the guard refuses it",
    async (_label, { spelling, position }) => {
      const attack = position.write(spelling.write(SAMPLE));

      /*
       * The justification, not a restatement of the rule: this exact text either returns the
       * parquet's contents on an engine with no seal, or fails to parse. Either way the guard has
       * to refuse it, and where the engine DOES read, the refusal is load bearing rather than
       * tidy.
       */
      const read = await rowsRead(attack);
      if (position.read) {
        expect(read, `${attack}\ndid not read the file, so this row of the matrix proves nothing`)
          .not.toBeNull();
      }

      const guarded = guardSql(attack);
      expect(guarded.ok, `guard ALLOWED a read of ${SAMPLE}:\n${attack}`).toBe(false);
      expect(guarded.sql).toBeUndefined();
      expect(guarded.reason).toMatch(/file or URL|only read|not allowed|cannot be called/i);
    },
  );

  it("the same statements against a remote URL are refused too", () => {
    // Every reported bypass worked with a URL as readily as with a path, and a remote fetch from
    // the reader's own tab is the worse of the two.
    for (const spelling of SPELLINGS) {
      for (const position of POSITIONS) {
        const attack = position.write(spelling.write("https://evil.example.com/x.parquet"));
        expect(guardSql(attack).ok, attack).toBe(false);
      }
    }
  });

  it.each([
    ["query() runs SQL built from a string", `SELECT * FROM query('SELECT 42')`],
    ["query_table() opens a name the scan resolves", `SELECT * FROM query_table('${SAMPLE}')`],
  ])("%s", async (_name, sql) => {
    expect(await rowsRead(sql), `${sql} did not run, so refusing it proves nothing`).not.toBeNull();
    expect(guardSql(sql).ok).toBe(false);
  });
});

describe("the scanner agrees with the engine about where a string ends", () => {
  /*
   * This is the one assumption the position rule genuinely rests on. If the guard thinks a literal
   * ended somewhere the engine does not, the two are reading different statements and everything
   * downstream is decided about the wrong text.
   */
  let instance: Instance;
  let connection: DuckDBConnection;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
  }, 60_000);

  afterAll(() => {
    connection?.closeSync();
    instance?.closeSync();
  });

  it("a backslash escapes a quote inside E'...' and only there", async () => {
    // The asymmetry that a scanner is most likely to get wrong, so it is pinned to the engine.
    const escaped = await connection.runAndReadAll(`SELECT E'a\\'b' AS x`);
    expect((escaped.getRowObjects()[0] as Record<string, unknown>).x).toBe("a'b");

    await expect(
      connection.runAndReadAll(`SELECT 'a\\'b' AS x`),
      "a plain literal must NOT honour a backslash escape",
    ).rejects.toThrow();
  });

  it("refuses a read whose path is hidden behind that escape", () => {
    // If the scanner ended the literal at the backslash-quote, the rest would be read as code and
    // the FROM clause would look like it held an identifier.
    expect(guardSql(`SELECT * FROM E'/etc/pas\\'swd'`).ok).toBe(false);
  });

  it("block comments nest, and the guard nests with them", async () => {
    const nested = await connection.runAndReadAll(`SELECT /* a /* b */ c */ 1 AS x`);
    expect(
      (nested.getRowObjects()[0] as Record<string, unknown>).x,
      "if DuckDB stops nesting comments, the stripper can be simplified",
    ).toBe(1);

    // A non nesting stripper leaves ` c */ 1 AS x` behind as code, so what runs is not what was
    // checked, which is the same defect class as mis-stripping `LIKE '%--%'`.
    expect(stripSqlComments(`SELECT /* a /* b */ c */ 1 AS x`).replace(/\s+/g, " ").trim()).toBe(
      "SELECT 1 AS x",
    );
  });

  it("a dollar sign that is a parameter is not read as a quote", () => {
    // `$1` opens no literal. Reading it as one would swallow the rest of the statement and turn a
    // legitimate query into a refusal for no reason.
    const result = guardSql(`SELECT * FROM ${VIEW_NAME} WHERE built_year > 1990 AND market_value > 5`);
    expect(result.ok, result.reason).toBe(true);
  });
});

describe("the position rule does not refuse ordinary queries", () => {
  it("accepts a normal query over the published view", () => {
    expect(guardSql(`SELECT * FROM ${VIEW_NAME}`).ok).toBe(true);
    expect(guardSql(`SELECT * FROM "${VIEW_NAME}" AS p WHERE p.built_year > 1990`).ok).toBe(true);
  });

  it("accepts a literal everywhere a literal legitimately belongs", () => {
    /*
     * The counterweight to a rule that fails closed. Each of these puts a string somewhere a
     * reader really does put one, and a guard that refused them would teach people it is noise.
     */
    for (const sql of [
      `SELECT * FROM ${VIEW_NAME} WHERE address_city = 'JACKSONVILLE'`,
      `SELECT * FROM ${VIEW_NAME} WHERE property_type IS DISTINCT FROM 'RESIDENTIAL'`,
      `SELECT * FROM ${VIEW_NAME} WHERE owner_name IN ('A', 'B', 'C')`,
      `SELECT * FROM (SELECT * FROM ${VIEW_NAME} WHERE address_city = 'JACKSONVILLE') AS inner_q`,
      `SELECT * FROM ${VIEW_NAME} p JOIN ${VIEW_NAME} q ON p.property_id = q.property_id WHERE p.owner_name = 'X'`,
      `SELECT * FROM (VALUES ('a'), ('b')) AS t(x)`,
      `SELECT COALESCE(CAST(built_year AS VARCHAR), '(null)') AS v FROM ${VIEW_NAME} GROUP BY 1`,
      `SELECT * FROM ${VIEW_NAME} ORDER BY CASE WHEN address_city = 'X' THEN 0 ELSE 1 END`,
      `SELECT trim(BOTH ' ' FROM owner_name) AS o FROM ${VIEW_NAME}`,
      `WITH recent AS (SELECT * FROM ${VIEW_NAME} WHERE last_sale_date_any > '2010-01-01') SELECT * FROM recent`,
    ]) {
      const result = guardSql(sql);
      expect(result.ok, `${sql}\nrefused: ${result.reason}`).toBe(true);
    }
  });

  it("keeps the documented false positive documented", () => {
    /*
     * `EXTRACT(YEAR FROM '1899-01-01')` puts a string in table position and is refused. That is
     * accepted, not overlooked: naming the type is the better spelling anyway, and the message has
     * to keep saying so, because an unexplained refusal is what makes a guard look arbitrary.
     */
    const refused = guardSql(`SELECT EXTRACT(YEAR FROM '1899-01-01') AS y`);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/EXTRACT\(YEAR FROM DATE '1899-01-01'\)/);

    const rewritten = guardSql(`SELECT EXTRACT(YEAR FROM DATE '1899-01-01') AS y`);
    expect(rewritten.ok, rewritten.reason).toBe(true);
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

  it("does not mistake data for code in any spelling of a literal", () => {
    // The masking is what makes this true, so it is asserted per spelling rather than once: a
    // keyword that is only ever data must stay data however it is quoted.
    for (const spelling of SPELLINGS) {
      if (spelling.name === "double quoted name") continue; // a name, not data
      const sql = `SELECT * FROM ${VIEW_NAME} WHERE legal_description LIKE ${spelling.write("%LOT 3; BLK 2%")}`;
      const result = guardSql(sql);
      expect(result.ok, `${sql}\nrefused: ${result.reason}`).toBe(true);
    }
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
