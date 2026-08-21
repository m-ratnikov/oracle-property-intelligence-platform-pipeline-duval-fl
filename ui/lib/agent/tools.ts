/**
 * The five tools, registered explicitly, all read only.
 *
 * Every tool is a typed `tool()` with a zod input schema. Each one records a
 * transcript entry (input, one line summary, elapsed_ms, row_count) and pushes
 * the property rows it saw into the evidence list, so the route can return a
 * faithful transcript and evidence table regardless of how the model phrases
 * its answer. Tool errors are returned as data, not thrown, so the loop keeps
 * going and the model can tell the user what failed.
 */

import type { Env } from "./types";
import { tool } from "ai";
import { z } from "zod";
import { guardSql, propertyByIdSql, VIEW_NAME } from "@/lib/sql";
import type { PropertyDb, Row } from "./db";
import { loadPropertyJson, loadRunHistory } from "./artifacts";
import {
  PRESET_NAME_LIST,
  PROVENANCE,
  describeColumn,
  presetFor,
  ruleDescriptions,
  THRESHOLDS,
  type PresetName,
} from "./schema";
import type { AgentDataFreshness, AgentEvidenceRow, AgentToolCall } from "./types";
import { logAgent } from "./log";

export const RUN_SQL_MAX_LIMIT = 200;
export const RUN_SQL_DEFAULT_LIMIT = 50;
export const PRESET_MAX_LIMIT = 200;
export const PRESET_DEFAULT_LIMIT = 25;
export const EVIDENCE_CAP = 60;

export interface ToolContext {
  db: PropertyDb;
  env?: Env;
  fetchImpl?: typeof fetch;
}

/** Mutable per request record the tools write into. */
export interface ToolTrace {
  calls: AgentToolCall[];
  evidence: AgentEvidenceRow[];
  assumptions: string[];
  freshness: AgentDataFreshness | null;
}

export function newTrace(): ToolTrace {
  return { calls: [], evidence: [], assumptions: [], freshness: null };
}

function addAssumption(trace: ToolTrace, text: string) {
  if (!trace.assumptions.includes(text)) trace.assumptions.push(text);
}

const ADDRESS_COLUMNS = ["address_street", "address_city", "address_zip"];
const SKIP_IN_EVIDENCE = new Set([
  "property_id",
  "parcel_identifier",
  "request_identifier",
  "property_cid",
  "county_name",
  "state_code",
  ...ADDRESS_COLUMNS,
  ...PROVENANCE,
]);

function addressOf(row: Row): string | null {
  const parts = [row.address_street, row.address_city, row.address_zip]
    .map((value) => (value === null || value === undefined ? "" : String(value).trim()))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Fold rows into the evidence list: one entry per property_id, matched
 * columns merged, capped so a 200 row SQL result does not flood the panel.
 */
function recordEvidence(trace: ToolTrace, rows: Row[], via: string, matchedColumns?: string[]) {
  for (const row of rows) {
    if (trace.evidence.length >= EVIDENCE_CAP) return;
    const id = row.property_id;
    if (id === null || id === undefined) continue;
    const propertyId = String(id);
    const columns = matchedColumns ?? Object.keys(row).filter((column) => !SKIP_IN_EVIDENCE.has(column));
    const matched: Record<string, unknown> = {};
    for (const column of columns) if (column in row) matched[column] = row[column];

    const existing = trace.evidence.find((entry) => entry.property_id === propertyId);
    if (existing) {
      Object.assign(existing, matched);
      continue;
    }
    trace.evidence.push({
      property_id: propertyId,
      address: addressOf(row),
      source_system: row.source_system === undefined ? null : (row.source_system as string | null),
      source_url: row.source_url === undefined ? null : (row.source_url as string | null),
      fetched_at: row.fetched_at === undefined ? null : (row.fetched_at as string | null),
      via,
      ...matched,
    });
  }
}

/** Notes the data itself forces, derived from the rows the tools returned. */
function noteDataCaveats(trace: ToolTrace, rows: Row[]) {
  const proxy = rows.filter((row) =>
    /proxy/i.test(String(row.roof_age_basis ?? "")),
  ).length;
  if (proxy > 0) {
    addAssumption(
      trace,
      `${proxy} of ${rows.length} returned rows have roof_age_basis = year built proxy (EFF_YR_BLT_PROXY): the county publishes no roof date for them, so built_year stands in for the roof year. Re-roofs without a permit on file are over counted.`,
    );
  }
  const nullTransit = rows.filter(
    (row) => "nearest_transit_stop_m" in row && row.nearest_transit_stop_m === null,
  ).length;
  if (nullTransit > 0) {
    addAssumption(
      trace,
      `${nullTransit} of ${rows.length} returned rows have NULL nearest_transit_stop_m: the transit feature was not loaded for those parcels yet, so they are neither near nor far from a stop.`,
    );
  }
  const nullStarbucks = rows.filter(
    (row) => "nearest_starbucks_m" in row && row.nearest_starbucks_m === null,
  ).length;
  if (nullStarbucks > 0) {
    addAssumption(
      trace,
      `${nullStarbucks} of ${rows.length} returned rows have NULL nearest_starbucks_m: the places feature was not loaded for those parcels yet.`,
    );
  }
  const nullSale = rows.filter(
    (row) => "years_since_last_sale" in row && row.years_since_last_sale === null,
  ).length;
  if (nullSale > 0) {
    addAssumption(
      trace,
      `${nullSale} of ${rows.length} returned rows have no recorded sale (years_since_last_sale NULL). A missing sale is not evidence of a long hold.`,
    );
  }
}

function record(trace: ToolTrace, entry: AgentToolCall) {
  trace.calls.push(entry);
  logAgent(entry.error ? "warn" : "info", "tool call", {
    tool: entry.name,
    elapsed_ms: entry.elapsed_ms,
    row_count: entry.row_count,
    total_matched: entry.total_matched ?? null,
    error: entry.error ?? null,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pull the WHERE clause out of a preset statement so the total can be counted. */
export function predicateOf(sql: string): string | null {
  const match = /\bWHERE\b([\s\S]*?)\bORDER BY\b/i.exec(sql);
  return match ? match[1].trim() : null;
}

/**
 * Strip a trailing LIMIT so a COUNT over the statement reports the full match,
 * not the capped one. Only a final `LIMIT n` (optionally `OFFSET m`) is
 * removed; limits inside subqueries are left alone.
 */
export function withoutTrailingLimit(sql: string): string {
  return sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*;?\s*$/i, "");
}

export function createAgentTools(context: ToolContext, trace: ToolTrace) {
  const { db } = context;
  const env = context.env ?? process.env;
  const fetchImpl = context.fetchImpl ?? fetch;

  if (db.isSample) {
    addAssumption(
      trace,
      "The query table in use is the synthetic SAMPLE parquet shipped with the UI, not published county records. Set QUERY_TABLE_URL to the IPFS artifact for real data.",
    );
  }

  const get_schema = tool({
    description:
      "Describe the `properties` view: every column with its DuckDB type and a one line meaning, plus the six standard question rules in plain English (thresholds, evidence columns, known caveats). Call once before writing SQL.",
    inputSchema: z.object({}),
    execute: async () => {
      const started = Date.now();
      try {
        const described = await db.query(`DESCRIBE ${VIEW_NAME}`);
        const columns = described.rows.map((row) => ({
          name: String(row.column_name),
          type: String(row.column_type),
          meaning: describeColumn(String(row.column_name)),
        }));
        const output = {
          view: VIEW_NAME,
          source: db.source,
          is_sample: db.isSample,
          column_count: columns.length,
          columns,
          provenance_columns: PROVENANCE,
          thresholds: THRESHOLDS,
          rules: ruleDescriptions(),
          notes: [
            "One row per folio (property_id). Extra derived columns sit next to the 37 canonical Elephant columns.",
            "DuckDB SQL dialect. Use EXTRACT(YEAR FROM CURRENT_DATE) for the current year.",
            "run_sql accepts a single SELECT or WITH statement; results are capped at 200 rows.",
          ],
        };
        record(trace, {
          name: "get_schema",
          input: {},
          summary: `${columns.length} columns, ${output.rules.length} rules`,
          output_summary: `${columns.length} columns, ${output.rules.length} rules`,
          elapsed_ms: Date.now() - started,
          row_count: columns.length,
          result: { column_count: columns.length, is_sample: db.isSample },
        });
        return output;
      } catch (error) {
        const message = errorMessage(error);
        record(trace, {
          name: "get_schema",
          input: {},
          summary: `error: ${message}`,
          output_summary: `error: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message };
      }
    },
  });

  const run_sql = tool({
    description:
      "Run ONE read only SELECT or WITH statement against the `properties` view in DuckDB and return the rows. Mutations, multiple statements, ATTACH/COPY/INSTALL are rejected. The result is capped at `limit` rows (default 50, max 200); `total_matched` reports the full match when the cap cut rows off. Use for combinations, rankings and aggregates the presets do not cover.",
    inputSchema: z.object({
      sql: z.string().min(1).describe("A single SELECT or WITH statement over `properties`."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(RUN_SQL_MAX_LIMIT)
        .optional()
        .describe(`Row cap, 1 to ${RUN_SQL_MAX_LIMIT}. Default ${RUN_SQL_DEFAULT_LIMIT}.`),
    }),
    execute: async ({ sql, limit }) => {
      const started = Date.now();
      const effectiveLimit = Math.min(limit ?? RUN_SQL_DEFAULT_LIMIT, RUN_SQL_MAX_LIMIT);
      const input = { sql, limit: effectiveLimit };
      const guarded = guardSql(sql, effectiveLimit);
      if (!guarded.ok || !guarded.sql) {
        const message = guarded.reason ?? "statement rejected";
        record(trace, {
          name: "run_sql",
          input,
          summary: `rejected: ${message}`,
          output_summary: `rejected: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message, rejected: true };
      }
      try {
        const result = await db.query(guarded.sql);
        let totalMatched: number | null = result.rows.length;
        if (result.rows.length >= effectiveLimit) {
          try {
            const inner = withoutTrailingLimit(sql.replace(/;+\s*$/, "").trim());
            const counted = await db.query(`SELECT COUNT(*) AS total FROM (\n${inner}\n) AS counted`);
            totalMatched = Number(counted.rows[0]?.total ?? result.rows.length);
          } catch {
            totalMatched = null;
          }
        }
        recordEvidence(trace, result.rows, "run_sql");
        noteDataCaveats(trace, result.rows);
        const summary = `${result.rows.length} rows${
          totalMatched !== null && totalMatched !== result.rows.length ? ` of ${totalMatched} matched` : ""
        } in ${result.elapsed_ms} ms`;
        record(trace, {
          name: "run_sql",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: result.rows.length,
          total_matched: totalMatched,
          result: { columns: result.columns, row_count: result.rows.length, total_matched: totalMatched },
        });
        return {
          columns: result.columns,
          rows: result.rows,
          row_count: result.rows.length,
          total_matched: totalMatched,
          capped: totalMatched !== null && totalMatched > result.rows.length,
          elapsed_ms: result.elapsed_ms,
          is_sample: db.isSample,
        };
      } catch (error) {
        const message = errorMessage(error);
        record(trace, {
          name: "run_sql",
          input,
          summary: `error: ${message}`,
          output_summary: `error: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message };
      }
    },
  });

  const preset_question = tool({
    description:
      "Run one of the eight standard question presets (the exact SQL the UI's Questions page runs) and return matching rows with their evidence and provenance columns, the rule in plain English, the total match count and the preset's known caveats. Prefer this over run_sql for the six standard questions and the two standard combinations.",
    inputSchema: z.object({
      name: z.enum(PRESET_NAME_LIST as [PresetName, ...PresetName[]]).describe(
        "roof_over_15 | water_view | no_sale_10y | regional_owner | near_transit | near_starbucks | roof15_and_no_sale10y | transit_and_regional",
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(PRESET_MAX_LIMIT)
        .optional()
        .describe(`Row cap, 1 to ${PRESET_MAX_LIMIT}. Default ${PRESET_DEFAULT_LIMIT}.`),
    }),
    execute: async ({ name, limit }) => {
      const started = Date.now();
      const effectiveLimit = Math.min(limit ?? PRESET_DEFAULT_LIMIT, PRESET_MAX_LIMIT);
      const input = { name, limit: effectiveLimit };
      try {
        const preset = presetFor(name);
        const sql = preset.sql(effectiveLimit);
        const predicate = predicateOf(sql);
        const [result, counted] = await Promise.all([
          db.query(sql),
          predicate
            ? db.query(`SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${predicate}`)
            : Promise.resolve(null),
        ]);
        const totalMatched = counted ? Number(counted.rows[0]?.total ?? result.rows.length) : null;
        recordEvidence(trace, result.rows, `preset_question:${name}`, preset.evidence);
        for (const assumption of preset.assumptions) addAssumption(trace, assumption);
        noteDataCaveats(trace, result.rows);
        const summary = `${preset.id}: ${result.rows.length} rows${
          totalMatched !== null ? ` of ${totalMatched} matched` : ""
        } in ${result.elapsed_ms} ms`;
        record(trace, {
          name: "preset_question",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: result.rows.length,
          total_matched: totalMatched,
          result: { preset_id: preset.id, row_count: result.rows.length, total_matched: totalMatched },
        });
        return {
          preset: name,
          preset_id: preset.id,
          question: preset.question,
          rule: preset.rule,
          evidence_columns: preset.evidence,
          provenance_columns: PROVENANCE,
          assumptions: preset.assumptions,
          sql,
          rows: result.rows,
          row_count: result.rows.length,
          total_matched: totalMatched,
          capped: totalMatched !== null && totalMatched > result.rows.length,
          elapsed_ms: result.elapsed_ms,
          is_sample: db.isSample,
        };
      } catch (error) {
        const message = errorMessage(error);
        record(trace, {
          name: "preset_question",
          input,
          summary: `error: ${message}`,
          output_summary: `error: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message };
      }
    },
  });

  const get_property = tool({
    description:
      "Fetch the full published row for one parcel by property_id (folio), parcel_identifier or request_identifier, plus the per property open data JSON from IPFS when it is published. Use to show everything known about one parcel.",
    inputSchema: z.object({
      property_id: z.string().min(1).describe("Folio / parcel number as it appears in property_id."),
    }),
    execute: async ({ property_id }) => {
      const started = Date.now();
      const input = { property_id };
      try {
        const result = await db.query(propertyByIdSql(property_id));
        const row = result.rows[0];
        if (!row) {
          record(trace, {
            name: "get_property",
            input,
            summary: "not found",
            output_summary: "not found",
            elapsed_ms: Date.now() - started,
            row_count: 0,
          });
          return { found: false, property_id, note: "No row with that folio in the published query table." };
        }
        recordEvidence(trace, [row], "get_property");
        noteDataCaveats(trace, [row]);
        const cid = row.property_cid ? String(row.property_cid) : "";
        const openData = cid ? await loadPropertyJson(cid, env, fetchImpl) : null;
        const summary = `found ${row.property_id}${openData ? ", open data JSON attached" : ""}`;
        record(trace, {
          name: "get_property",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: 1,
          result: { property_id: row.property_id, open_data_url: openData?.url ?? null },
        });
        return {
          found: true,
          row,
          open_data: openData
            ? { url: openData.url, document: openData.document }
            : { url: null, note: "No per property JSON reachable for this parcel (not published yet, or OPEN_DATA_INDEX_URL unset)." },
          is_sample: db.isSample,
        };
      } catch (error) {
        const message = errorMessage(error);
        record(trace, {
          name: "get_property",
          input,
          summary: `error: ${message}`,
          output_summary: `error: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message };
      }
    },
  });

  const get_run_history = tool({
    description:
      "Read the pipeline run history (run-history.json): every run with timestamps, trigger, per source record counts, inserted/updated/delta, documented source limitations and the IPFS artifacts (CIDs / IPNS) each run published. Use to state data freshness, sources and limitations.",
    inputSchema: z.object({
      max_runs: z.number().int().min(1).max(50).optional().describe("How many most recent runs to return. Default 10."),
    }),
    execute: async ({ max_runs }) => {
      const started = Date.now();
      const input = { max_runs: max_runs ?? 10 };
      try {
        const loaded = await loadRunHistory(env, fetchImpl);
        trace.freshness = loaded.freshness;
        const runs = [...loaded.history.runs]
          .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
          .slice(0, input.max_runs)
          .map((run) => ({
            run_id: run.run_id,
            started_at: run.started_at,
            finished_at: run.finished_at,
            trigger: run.trigger,
            git_sha: run.git_sha,
            sources: run.sources.map((source) => ({
              source: source.source,
              rows_fetched: source.rows_fetched,
              inserted: source.inserted,
              updated: source.updated,
              unchanged: source.unchanged,
              delta_vs_previous: source.delta_vs_previous,
              source_url: source.source_url,
              limitations: source.limitations,
            })),
            artifacts: run.artifacts,
          }));
        if (loaded.location.isSample) {
          addAssumption(
            trace,
            "The run history in use is the synthetic SAMPLE file shipped with the UI. Set RUN_HISTORY_URL to the published artifact for real run records.",
          );
        }
        const summary = `${loaded.history.runs.length} runs, latest ${loaded.freshness.run_id ?? "unknown"}`;
        record(trace, {
          name: "get_run_history",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: runs.length,
          result: { runs: loaded.history.runs.length, latest_run_id: loaded.freshness.run_id },
        });
        return {
          county: loaded.history.county,
          generated_at: loaded.history.generatedAt,
          source: loaded.location.source,
          is_sample: loaded.location.isSample,
          run_count: loaded.history.runs.length,
          latest: loaded.freshness,
          runs,
        };
      } catch (error) {
        const message = errorMessage(error);
        record(trace, {
          name: "get_run_history",
          input,
          summary: `error: ${message}`,
          output_summary: `error: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message };
      }
    },
  });

  return { get_schema, run_sql, preset_question, get_property, get_run_history };
}

export type AgentTools = ReturnType<typeof createAgentTools>;
export const TOOL_NAMES = ["get_schema", "run_sql", "preset_question", "get_property", "get_run_history"] as const;
