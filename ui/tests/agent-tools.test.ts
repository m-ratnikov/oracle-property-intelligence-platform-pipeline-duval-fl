/**
 * The agent's tools against the sample parquet through a real DuckDB: schema
 * lists the expected columns, run_sql rejects mutations and enforces the cap,
 * every preset returns evidence backed rows, get_property finds a folio, and
 * get_run_history reads the sample history. No model, no network.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { openPropertyDb, SAMPLE_PARQUET_PATH, resolveQueryTableSource, toPlain, type PropertyDb } from "@/lib/agent/db";
import { createAgentTools, newTrace, predicateOf, withoutTrailingLimit, RUN_SQL_MAX_LIMIT, PRESET_DEFAULT_LIMIT, type ToolTrace } from "@/lib/agent/tools";
import { PRESET_NAME_LIST, presetFor } from "@/lib/agent/schema";
import { ALL_EXPECTED_COLUMNS } from "@/lib/columns";

let db: PropertyDb;

type Tools = ReturnType<typeof createAgentTools>;

function tools(trace: ToolTrace = newTrace()): { tools: Tools; trace: ToolTrace } {
  return { tools: createAgentTools({ db, env: { ...process.env } }, trace), trace };
}

// Tool execute signatures take (input, options); the options are not used by
// our tools, so tests pass a minimal stand in.
const callOptions = { toolCallId: "test", messages: [] } as never;

async function exec<T>(tool: { execute?: unknown }, input: unknown): Promise<T> {
  const run = tool.execute as (input: unknown, options: unknown) => Promise<T>;
  return run(input, callOptions);
}

beforeAll(async () => {
  expect(existsSync(SAMPLE_PARQUET_PATH), "run `pnpm sample` first").toBe(true);
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
});

afterAll(async () => {
  await db.close();
});

describe("db helpers", () => {
  it("falls back to the sample parquet when no URL is configured", () => {
    const resolved = resolveQueryTableSource({});
    expect(resolved.isSample).toBe(true);
    expect(resolved.source).toBe(SAMPLE_PARQUET_PATH);
  });

  it("prefers QUERY_TABLE_URL and appends the object name to an IPNS root", () => {
    const resolved = resolveQueryTableSource({ QUERY_TABLE_URL: "https://ipfs.filebase.io/ipns/k51abc/" });
    expect(resolved.isSample).toBe(false);
    expect(resolved.source).toBe("https://ipfs.filebase.io/ipns/k51abc/query-table.parquet");
  });

  it("converts DuckDB values to JSON safe values", () => {
    expect(toPlain(BigInt(42))).toBe(42);
    expect(toPlain(BigInt("92233720368547758070"))).toBe("92233720368547758070");
    expect(toPlain(null)).toBeNull();
    expect(toPlain({ toString: () => "2026-08-19 06:00:00" })).toBe("2026-08-19 06:00:00");
  });

  it("extracts predicates and strips trailing limits", () => {
    const sql = presetFor("roof_over_15").sql(10);
    expect(predicateOf(sql)).toContain("roof_year_est");
    expect(withoutTrailingLimit("SELECT 1 FROM properties LIMIT 5")).toBe("SELECT 1 FROM properties");
    expect(withoutTrailingLimit("SELECT * FROM (SELECT 1 LIMIT 2) t")).toBe("SELECT * FROM (SELECT 1 LIMIT 2) t");
  });
});

describe("get_schema", () => {
  it("lists every expected column with a meaning and the eight rules", async () => {
    const { tools: t, trace } = tools();
    const output = await exec<{
      columns: { name: string; meaning: string }[];
      provenance_families: { family: string; source: string; fetched_at: string }[];
      column_count: number;
      rules: unknown[];
      is_sample: boolean;
    }>(t.get_schema, {});
    // The per family provenance pairs follow one pattern, so they are described once in
    // provenance_families rather than repeating the same sentence twenty four times in a result
    // that is re-sent on every step of the loop. Between the two, every expected column is covered.
    const names = new Set(output.columns.map((column) => column.name));
    for (const family of output.provenance_families) {
      names.add(family.source);
      names.add(family.fetched_at);
    }
    for (const column of ALL_EXPECTED_COLUMNS) expect([...names]).toContain(column);
    for (const column of output.columns) expect(column.meaning.length).toBeGreaterThanOrEqual(8);
    expect(output.provenance_families.length).toBeGreaterThan(0);
    // column_count still reports the real width of the view, not the trimmed catalogue.
    expect(output.column_count).toBeGreaterThan(output.columns.length);
    expect(output.rules).toHaveLength(8);
    expect(output.is_sample).toBe(true);
    expect(trace.calls).toHaveLength(1);
    expect(trace.calls[0].name).toBe("get_schema");
    expect(trace.calls[0].elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("run_sql", () => {
  it.each([
    "DELETE FROM properties",
    "UPDATE properties SET owner_name = 'x'",
    "DROP VIEW properties",
    "CREATE TABLE x AS SELECT 1",
    "INSTALL httpfs",
    "ATTACH 'x.db'",
    "COPY properties TO 'out.csv'",
    "SELECT 1; SELECT 2",
  ])("rejects %s", async (sql) => {
    const { tools: t, trace } = tools();
    const output = await exec<{ error?: string; rejected?: boolean }>(t.run_sql, { sql });
    expect(output.rejected).toBe(true);
    expect(output.error).toBeTruthy();
    expect(trace.calls[0].error).toBeTruthy();
    expect(trace.evidence).toHaveLength(0);
  });

  it("runs a SELECT, enforces the limit and reports the total", async () => {
    const { tools: t, trace } = tools();
    const output = await exec<{ rows: unknown[]; row_count: number; total_matched: number | null; capped: boolean }>(
      t.run_sql,
      { sql: "SELECT property_id, address_street, source_system, source_url, fetched_at FROM properties ORDER BY property_id", limit: 7 },
    );
    expect(output.row_count).toBe(7);
    expect(output.rows).toHaveLength(7);
    expect(output.total_matched).toBeGreaterThan(7);
    expect(output.capped).toBe(true);
    expect(trace.calls[0].row_count).toBe(7);
    expect(trace.calls[0].total_matched).toBe(output.total_matched);
    expect(trace.evidence).toHaveLength(7);
    expect(trace.evidence[0].source_system).toBeTruthy();
  });

  it("never returns more than the hard cap", async () => {
    const { tools: t } = tools();
    const output = await exec<{ row_count: number }>(t.run_sql, {
      sql: "SELECT property_id FROM properties",
      limit: RUN_SQL_MAX_LIMIT,
    });
    expect(output.row_count).toBeLessThanOrEqual(RUN_SQL_MAX_LIMIT);
  });

  it("returns SQL errors as data, not exceptions", async () => {
    const { tools: t, trace } = tools();
    const output = await exec<{ error?: string }>(t.run_sql, { sql: "SELECT no_such_column FROM properties" });
    expect(output.error).toMatch(/no_such_column/i);
    expect(trace.calls[0].error).toBeTruthy();
  });
});

describe("preset_question", () => {
  it.each(PRESET_NAME_LIST)("%s returns evidence backed rows", async (name) => {
    const { tools: t, trace } = tools();
    const output = await exec<{
      rows: Record<string, unknown>[];
      row_count: number;
      total_matched: number | null;
      evidence_columns: string[];
      rule: string;
      assumptions: string[];
      // 10 is deliberately below the default: the floor should ignore it, because these rows are
      // the evidence returned to the caller and a display preference must not shrink the proof.
    }>(t.preset_question, { name, limit: 10 });
    expect(output.row_count, `${name} returned no rows`).toBeGreaterThan(0);
    expect(output.row_count).toBeLessThanOrEqual(PRESET_DEFAULT_LIMIT);
    expect(output.total_matched).toBeGreaterThanOrEqual(output.row_count);
    expect(output.rule.length).toBeGreaterThan(20);
    for (const column of output.evidence_columns) expect(Object.keys(output.rows[0])).toContain(column);
    for (const column of ["source_system", "source_url", "fetched_at"]) {
      expect(Object.keys(output.rows[0])).toContain(column);
    }
    expect(trace.calls[0].name).toBe("preset_question");
    expect(trace.calls[0].row_count).toBe(output.row_count);
    expect(trace.evidence.length).toBe(output.row_count);
    // The preset's own caveats are surfaced as assumptions.
    for (const assumption of output.assumptions) expect(trace.assumptions).toContain(assumption);
  });

  it("rejects an unknown preset name through the schema", async () => {
    const { tools: t } = tools();
    const schema = t.preset_question.inputSchema as { safeParse?: (value: unknown) => { success: boolean } };
    expect(schema.safeParse?.({ name: "not_a_preset" }).success).toBe(false);
  });
});

describe("get_property", () => {
  it("returns the full row and the sample open data JSON", async () => {
    const [first] = (await db.query("SELECT property_id FROM properties ORDER BY property_id LIMIT 1")).rows;
    const { tools: t, trace } = tools();
    const output = await exec<{ found: boolean; row: Record<string, unknown>; open_data: { url: string | null } }>(
      t.get_property,
      { property_id: String(first.property_id) },
    );
    expect(output.found).toBe(true);
    expect(String(output.row.property_id)).toBe(String(first.property_id));
    expect(Object.keys(output.row).length).toBeGreaterThan(30);
    expect(trace.evidence).toHaveLength(1);
    expect(trace.evidence[0].property_id).toBe(String(first.property_id));
    // Sample open data ships in public/sample/open-data, so the CID lookup resolves.
    expect(output.open_data.url).toMatch(/\/sample\/open-data\/.+\.json$/);
  });

  it("says not found for an unknown folio", async () => {
    const { tools: t } = tools();
    const output = await exec<{ found: boolean }>(t.get_property, { property_id: "no-such-folio" });
    expect(output.found).toBe(false);
  });
});

describe("get_run_history", () => {
  it("reads the sample run history and records freshness", async () => {
    const { tools: t, trace } = tools();
    const output = await exec<{ run_count: number; runs: { run_id: string; sources: unknown[] }[]; is_sample: boolean }>(
      t.get_run_history,
      { max_runs: 3 },
    );
    expect(output.run_count).toBeGreaterThan(0);
    expect(output.runs.length).toBeLessThanOrEqual(3);
    expect(output.runs[0].sources.length).toBeGreaterThan(0);
    expect(output.is_sample).toBe(true);
    expect(trace.freshness?.run_id).toBe(output.runs[0].run_id);
  });
});
