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
  SPINE_PROVENANCE,
  describeColumn,
  evidenceGuideCompact,
  presetFor,
  provenanceFamilies,
  ruleCatalogue,
  THRESHOLDS,
  type PresetName,
} from "./schema";
import { FAMILY_PROVENANCE_COLUMNS } from "@/lib/columns";
import type { AgentDataFreshness, AgentEvidenceRow, AgentToolCall } from "./types";
import {
  aggregateValueShape,
  classifyCountShape,
  conjunctionTotal,
  COUNT_COLUMN,
  COUNT_SEMANTICS,
  harvestNumbers,
  SHAPE_IN_WORDS,
  type CountClaim,
} from "./totals";
import { logAgent } from "./log";

export const RUN_SQL_MAX_LIMIT = 200;
export const RUN_SQL_DEFAULT_LIMIT = 50;
export const PRESET_MAX_LIMIT = 200;
export const PRESET_DEFAULT_LIMIT = 25;
export const EVIDENCE_CAP = 60;
/** Criteria per count_criteria call. Six is more signals than any question here combines. */
export const COUNT_CRITERIA_MAX = 6;

export interface ToolContext {
  db: PropertyDb;
  env?: Env;
  fetchImpl?: typeof fetch;
}

/**
 * A progress note, emitted while the turn is still running.
 *
 * The route can only answer once, at the end, so without this the page has nothing truthful to
 * show during a wait that is usually ten seconds and has been seventy. These are the real events
 * as they happen - never a scripted sequence on a timer, which would keep animating after the work
 * had stalled and would be a lie exactly when the reader most needs the truth.
 */
export interface AgentProgress {
  /**
   * Pairs a "finished" with its "started". Without it the client has to guess which line to close,
   * and guessing "the newest open one" put "Answer written" on top of "Asking the model", so the
   * log read as though the answer arrived before the queries that produced it.
   */
  id: string;
  /** "started" fires before the work, "finished" after it, so the page can show a live spinner. */
  phase: "started" | "finished";
  /** What is happening, in the reader's language rather than the code's. */
  label: string;
  tool?: string;
  elapsed_ms?: number;
  row_count?: number | null;
  error?: string | null;
}

/** Mutable per request record the tools write into. */
export interface ToolTrace {
  calls: AgentToolCall[];
  evidence: AgentEvidenceRow[];
  assumptions: string[];
  freshness: AgentDataFreshness | null;
  /**
   * Every count a tool computed this turn, with the statement that produced it. run.ts checks the
   * answer's totals against this before the answer is returned, which is why a count is registered
   * here at the moment it is computed rather than being reconstructed from the prose afterwards.
   */
  counts: CountClaim[];
  /**
   * Every number any tool returned this turn, including numbers inside prose a tool returned. A
   * numeral the answer presents as a population count has to be in here or it is not printed.
   */
  seen: Set<number>;
  /** Set by a caller that is streaming; absent for curl, tests and the plain JSON path. */
  onProgress?: (event: AgentProgress) => void;
}

export function newTrace(onProgress?: (event: AgentProgress) => void): ToolTrace {
  return { calls: [], evidence: [], assumptions: [], freshness: null, counts: [], seen: new Set(), onProgress };
}

/** Register a computed count and its receipt. */
function recordCount(trace: ToolTrace, claim: CountClaim) {
  trace.counts.push(claim);
  trace.seen.add(claim.value);
}

/**
 * Take everything a tool is about to hand the model and remember the numbers in it.
 *
 * Called with the exact object returned, so the allow list is by construction "what the model
 * saw", not a hand maintained list of fields that someone has to remember to extend.
 */
function harvest(trace: ToolTrace, output: unknown) {
  harvestNumbers(output, trace.seen);
  return output;
}

/** Human wording for each tool, used in the progress log. */
const TOOL_LABELS: Record<string, string> = {
  get_schema: "Reading the published table's columns",
  preset_question: "Running the question's SQL rule",
  run_sql: "Running SQL against the published parquet",
  count_criteria: "Counting each criterion, all of them together, and every score level",
  get_property: "Fetching one parcel's full record",
  get_run_history: "Checking how fresh the data is",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name}`;
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
      `${proxy} of ${rows.length} returned rows have a PROXY roof_age_basis (EFF_YR_BLT_PROXY): no county roof date exists for them, so the appraiser's effective year built stands in and the row is NOT a permit derived roof date. roof_age_basis = PERMIT would be a roof date, but it is on ZERO published rows, because the JaxEPICS permit source is enumerated in bounded windows and no re-roof permit reconciled to a folio in them. Every roof age here is therefore a proxy and over states roof age; a parcel that was re-roofed last year looks the same as one never re-roofed.`,
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
      `${nullSale} of ${rows.length} returned rows have years_since_last_sale NULL, which happens only when has_sale_on_record is false and tenure_basis reads NO_SALE_ON_RECORD: no source records any transfer for the parcel. The long hold rule EXCLUDES them. No transfer on record is a gap in the record, NOT evidence of a long hold, and the two must be reported as different findings.`,
    );
  }
  // The 87.06 percent null column. If the model selected it anyway, the answer is about to show a
  // table of "not available" beside a correct count, which reads as a fabricated answer.
  const nullRollSale = rows.filter(
    (row) => "last_sale_date" in row && row.last_sale_date === null,
  ).length;
  if (nullRollSale > 0) {
    addAssumption(
      trace,
      `${nullRollSale} of ${rows.length} returned rows have last_sale_date NULL. That column comes from the FDOR roll and SDF only, which cover the two most recent transfers, so it is null on 351,742 of 404,023 Duval parcels (87.06 percent). It is NOT what years_since_last_sale is measured from. Cite last_sale_date_any, tenure_basis and tenure_source instead.`,
    );
  }
  const noSaleOnRecord = rows.filter(
    (row) => row.has_sale_on_record === false || row.tenure_basis === "NO_SALE_ON_RECORD",
  ).length;
  if (noSaleOnRecord > 0) {
    addAssumption(
      trace,
      `${noSaleOnRecord} of ${rows.length} returned rows have has_sale_on_record = false (tenure_basis NO_SALE_ON_RECORD). No source records any transfer for those parcels, so their tenure columns are NULL for that reason and not because the property was held a long time.`,
    );
  }
  // Read from the published judgement rather than from a cut on years_since_last_sale. An age cut
  // was what let 1925 and 1926 plat dates through at exactly 100.0 years, and it moved with the
  // as-of date; tenure_quality is fixed in the data. The date fallback covers an artifact published
  // before the column existed, and it uses the same 1901 boundary the column is built on rather
  // than reintroducing a duration threshold.
  const implausibleTenure = rows.filter((row) => {
    const quality = row.tenure_quality;
    if (typeof quality === "string") return quality === "IMPLAUSIBLE_DATE";
    const sale = row.last_sale_date_any;
    return typeof sale === "string" && sale.slice(0, 4) < "1901";
  }).length;
  if (implausibleTenure > 0) {
    addAssumption(
      trace,
      `${implausibleTenure} of ${rows.length} returned rows carry tenure_quality = 'IMPLAUSIBLE_DATE': the recorded sale predates 1901 and is filler in the City recorded sales file, not a transfer (1899 and 1800 arrive as 127 and 226 year holds). They satisfy the rule and stay in the count, but do not present one as an example.`,
    );
  }
  const contradictedTenure = rows.filter((row) => row.tenure_date_check === "CONTRADICTED").length;
  if (contradictedTenure > 0) {
    addAssumption(
      trace,
      `${contradictedTenure} of ${rows.length} returned rows carry tenure_date_check = 'CONTRADICTED': the recorded sale year precedes the parcel's own built_year, so it cannot be a transfer of the building now standing. Report the tenure as unconfirmed rather than as a long hold.`,
    );
  }
}

function record(trace: ToolTrace, entry: AgentToolCall) {
  trace.calls.push(entry);
  trace.onProgress?.({
    // each tool call is its own line; it never pairs with a started event
    id: `tool-${trace.calls.length}`,
    phase: "finished",
    label: toolLabel(entry.name),
    tool: entry.name,
    elapsed_ms: entry.elapsed_ms,
    row_count: entry.row_count ?? null,
    error: entry.error ?? null,
  });
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
      "Describe the `properties` view: every column with its DuckDB type and a one line meaning, the six standard question rules in plain English (thresholds, evidence columns, known caveats), and `evidence_guide`, which names the column to cite for each question and the lookalike column to avoid. Call once before writing SQL. Read evidence_guide before choosing columns: for ownership tenure the answer is in last_sale_date_any and tenure_basis, not in last_sale_date, which is null on 87.06 percent of parcels.",
    inputSchema: z.object({}),
    execute: async () => {
      const started = Date.now();
      try {
        const rowCountSql = `SELECT COUNT(*) AS total FROM ${VIEW_NAME}`;
        const [described, counted] = await Promise.all([
          db.query(`DESCRIBE ${VIEW_NAME}`),
          // Measured, not quoted from a note. The size of the universe is the number every other
          // total has to be plausible against, so it is registered as a computed count like any
          // other, which is what lets the answer say it out loud.
          db.query(rowCountSql),
        ]);
        const rowCount = Number(counted.rows[0]?.total ?? 0);
        recordCount(trace, {
          value: rowCount,
          counts: `rows in the published ${VIEW_NAME} view, one per parcel`,
          sql: rowCountSql,
          shape: "aggregate",
          tool: "get_schema",
        });
        // The per family provenance pairs follow one pattern and are described once, below, rather
        // than repeating the same sentence twenty four times in a result that is re-sent on every
        // step of the loop.
        const familyColumns = new Set(FAMILY_PROVENANCE_COLUMNS);
        const allNames = described.rows.map((row) => String(row.column_name));
        const columns = described.rows
          .filter((row) => !familyColumns.has(String(row.column_name)))
          .map((row) => ({
            name: String(row.column_name),
            type: String(row.column_type),
            meaning: describeColumn(String(row.column_name)),
          }));
        const output = {
          view: VIEW_NAME,
          source: db.source,
          is_sample: db.isSample,
          column_count: allNames.length,
          row_count: rowCount,
          columns,
          spine_provenance_columns: SPINE_PROVENANCE,
          provenance_families: provenanceFamilies().filter((family) =>
            allNames.includes(family.source),
          ),
          thresholds: THRESHOLDS,
          rules: ruleCatalogue(),
          evidence_guide: evidenceGuideCompact(),
          notes: [
            "One row per folio (property_id). Extra derived columns sit next to the 37 canonical Elephant columns.",
            "DuckDB SQL dialect. Use EXTRACT(YEAR FROM CURRENT_DATE) for the current year.",
            "run_sql accepts a single SELECT or WITH statement; results are capped at 200 rows.",
            "Ownership tenure comes from last_sale_date_any (401,832 of 404,023 rows) with tenure_basis and tenure_source naming where it came from, never from last_sale_date (NULL on 351,742 rows). years_since_last_sale is NULL exactly when has_sale_on_record is false, and such a parcel is EXCLUDED from the long hold rule, never counted as a long hold. tenure_basis is never NULL: it reads NO_SALE_ON_RECORD instead, so do not test it with IS NULL.",
            "owner_count is NULL on every row. The FDOR roll has no co-owner column, so has_additional_owners (the ET AL / ET UX marker) is the only multi owner signal; never present owner_count as a number.",
            "roof_age_basis is EFF_YR_BLT_PROXY on 359,129 of 404,023 rows and NULL on the other 44,894. PERMIT and ACT_YR_BLT_PROXY are on ZERO rows, so NO published roof year is a permit date and every one is the appraiser's effective year built standing in, which over states roof age. Do not tell a reader a row might be PERMIT: none is.",
            "source_system, source_url and fetched_at describe the appraisal roll spine only and are identical on every row. Per family provenance is in <family>_source / <family>_fetched_at, and source_systems lists every system that contributed to a row.",
            "This session can read only the published `properties` view. The engine is opened with external file system and network access disabled and its configuration locked, so file and URL readers (read_text, read_blob, read_csv_auto, glob, a read_parquet of any other path) will fail. That is by design; do not try to work around it.",
          ],
        };
        record(trace, {
          name: "get_schema",
          input: {},
          summary: `${allNames.length} columns, ${output.rules.length} rules, ${rowCount} rows`,
          output_summary: `${allNames.length} columns, ${output.rules.length} rules, ${rowCount} rows`,
          elapsed_ms: Date.now() - started,
          row_count: allNames.length,
          total_matched: rowCount,
          result: { column_count: allNames.length, row_count: rowCount, is_sample: db.isSample },
        });
        return harvest(trace, output);
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
      "Run ONE read only SELECT or WITH statement against the `properties` view in DuckDB and return the rows. Use for combinations, rankings and aggregates the presets do not cover. `properties` is the ONLY readable object: mutations, multiple statements, ATTACH/COPY/INSTALL, and every file or URL reader (read_text, read_blob, read_csv_auto, read_json_auto, glob, read_parquet of any other path) are rejected, and the engine itself refuses them too. The result is capped at `limit` rows (default 50, max 200). COUNTS: `total_matched` is returned ONLY when this statement's predicate is a plain AND of conditions; for any other shape it is null and the honest number is `rows_selected`, with `count_shape`, `count_sql` and `count_semantics` saying what it does and does not mean. A scored, weighted or OR query therefore has NO total_matched, by construction: use count_criteria to get the conjunction total. Select the evidence columns from get_schema's evidence_guide: for ownership tenure that is last_sale_date_any, tenure_basis, tenure_source and years_since_last_sale, plus has_sale_on_record to separate no transfer on record from a long hold, and NOT last_sale_date, which is NULL on 351,742 of 404,023 parcels; for roof age it is roof_year_est with roof_age_basis beside it, which is EFF_YR_BLT_PROXY or NULL on every published row and never PERMIT, and roof_covering_material is non null on only 930 of 404,023 rows. owner_count is NULL on every row: use has_additional_owners.",
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .describe(
          "A single SELECT or WITH statement over `properties`. No other table, file or URL can be read.",
        ),
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
        const inner = withoutTrailingLimit(sql.replace(/;+\s*$/, "").trim());
        let countSql = `SELECT COUNT(*) AS total FROM (\n${inner}\n) AS counted`;
        let totalMatched: number | null = result.rows.length;
        if (result.rows.length >= effectiveLimit) {
          try {
            const counted = await db.query(countSql);
            totalMatched = Number(counted.rows[0]?.total ?? result.rows.length);
          } catch {
            totalMatched = null;
          }
        } else {
          // Fewer rows than the cap means the rows ARE the whole match, so no second query is
          // needed. The receipt for the count is then the statement itself.
          countSql = inner;
        }
        // Classify the model's own statement, never the COUNT wrapper: the wrapper puts the
        // interesting WHERE one paren deep, where a depth aware scan would not find it.
        const shape = classifyCountShape(inner);
        const strictTotal = conjunctionTotal(shape, totalMatched);
        if (totalMatched !== null) {
          recordCount(trace, {
            value: totalMatched,
            counts:
              shape === "conjunction"
                ? "rows matching this statement's predicate, a plain AND of conditions"
                : `rows selected by this statement, whose predicate is ${SHAPE_IN_WORDS[shape]}`,
            sql: countSql,
            shape,
            tool: "run_sql",
          });
        }
        // A hand written `SELECT COUNT(*) ... WHERE ...` is the honest way to get a total, and the
        // number is inside the one row it returns rather than in its row count. Register it with the
        // shape of the WHERE that produced it, so that route arrives with a receipt too.
        if (shape === "aggregate" && result.rows.length === 1) {
          const valueShape = aggregateValueShape(inner);
          for (const [column, value] of Object.entries(result.rows[0])) {
            if (typeof value !== "number" || !Number.isInteger(value) || !COUNT_COLUMN.test(column)) continue;
            recordCount(trace, {
              value,
              counts: `${column} from this aggregate, over a predicate that is ${SHAPE_IN_WORDS[valueShape]}`,
              sql: inner,
              shape: valueShape,
              tool: "run_sql",
            });
          }
        }
        recordEvidence(trace, result.rows, "run_sql");
        noteDataCaveats(trace, result.rows);
        // The shape rides in the transcript line as well, so a reader scanning the tool panel meets
        // the caveat next to the number instead of having to open the JSON to find it.
        const summary = `${result.rows.length} rows${
          totalMatched !== null && totalMatched !== result.rows.length ? ` of ${totalMatched} selected` : ""
        }${shape === "conjunction" ? "" : `, ${shape} predicate: not a conjunction total`} in ${result.elapsed_ms} ms`;
        record(trace, {
          name: "run_sql",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: result.rows.length,
          total_matched: totalMatched,
          count_shape: shape,
          result: {
            columns: result.columns,
            row_count: result.rows.length,
            rows_selected: totalMatched,
            total_matched: strictTotal,
            count_shape: shape,
          },
        });
        return harvest(trace, {
          columns: result.columns,
          rows: result.rows,
          row_count: result.rows.length,
          // Non null ONLY when the predicate is a plain AND of conditions. Every other shape gets
          // null here and the honest number under rows_selected, so the field named "total matched"
          // cannot carry a number that did not match all of the criteria.
          total_matched: strictTotal,
          rows_selected: totalMatched,
          count_shape: shape,
          count_sql: countSql,
          count_semantics: COUNT_SEMANTICS[shape],
          capped: totalMatched !== null && totalMatched > result.rows.length,
          elapsed_ms: result.elapsed_ms,
          is_sample: db.isSample,
        });
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
      "Run one of the eight standard question presets (the exact SQL the UI's Questions page runs) and return matching rows with their evidence and provenance columns, the rule in plain English, the total match count and the preset's known caveats. Prefer this over run_sql for the six standard questions and the two standard combinations. The `rule` and `assumptions` it returns are the same text the Questions page card shows, so describe the rule the way this tool states it and do not paraphrase it into a different rule.",
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
        .describe(
          `Row cap, up to ${PRESET_MAX_LIMIT}. Use it to ask for MORE than the default ${PRESET_DEFAULT_LIMIT}; a smaller number is ignored, because these rows are the evidence handed to the caller and shrinking them to suit an inline table would throw away the proof.`,
        ),
    }),
    execute: async ({ name, limit }) => {
      const started = Date.now();
      // Floored, not just capped. The model asks for a small limit when it only intends to print a
      // few rows, but this result IS the evidence returned alongside the answer, so a display
      // preference must not shrink the proof. Asking for more than the default still works.
      const effectiveLimit = Math.min(Math.max(limit ?? PRESET_DEFAULT_LIMIT, PRESET_DEFAULT_LIMIT), PRESET_MAX_LIMIT);
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
        const countSql = predicate ? `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${predicate}` : sql;
        // Every preset predicate is a plain AND, but it is classified rather than assumed: a preset
        // that gains an OR one day must lose its conjunction total on the same commit, not later.
        const shape = predicate ? classifyCountShape(predicate) : "unknown";
        if (totalMatched !== null) {
          recordCount(trace, {
            value: totalMatched,
            counts: `parcels matching the ${preset.id} rule (predicate is ${SHAPE_IN_WORDS[shape]})`,
            sql: countSql,
            shape,
            tool: "preset_question",
          });
        }
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
          count_shape: shape,
          result: { preset_id: preset.id, row_count: result.rows.length, total_matched: totalMatched },
        });
        return harvest(trace, {
          preset: name,
          preset_id: preset.id,
          question: preset.question,
          rule: preset.rule,
          evidence_columns: preset.evidence,
          provenance_columns: SPINE_PROVENANCE,
          assumptions: preset.assumptions,
          sql,
          rows: result.rows,
          row_count: result.rows.length,
          total_matched: conjunctionTotal(shape, totalMatched),
          count_shape: shape,
          count_sql: countSql,
          count_semantics: COUNT_SEMANTICS[shape],
          capped: totalMatched !== null && totalMatched > result.rows.length,
          elapsed_ms: result.elapsed_ms,
          is_sample: db.isSample,
        });
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
        return harvest(trace, {
          found: true,
          row,
          open_data: openData
            ? { url: openData.url, document: openData.document }
            : { url: null, note: "No per property JSON reachable for this parcel (not published yet, or OPEN_DATA_INDEX_URL unset)." },
          is_sample: db.isSample,
        });
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
        return harvest(trace, {
          county: loaded.history.county,
          generated_at: loaded.history.generatedAt,
          source: loaded.location.source,
          is_sample: loaded.location.isSample,
          run_count: loaded.history.runs.length,
          latest: loaded.freshness,
          runs,
        });
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

  /**
   * The affirmative half of the totals fix.
   *
   * "Strong candidates for further review" is a scored question, and a scored question is exactly
   * where a model composes an OR or a weighted sum and then narrates its row count as though every
   * condition held. This tool takes the criteria as a LIST and does the composing itself, so the
   * conjunction total, the disjunction total and the per score counts all come back at once, each
   * under a name that says what it is. There is no way to get a number out of it that is not
   * labelled with the predicate it came from.
   */
  const count_criteria = tool({
    description:
      "Count a set of criteria properly. Give 2 to 6 boolean SQL conditions over `properties`, each with a plain English label, and this returns: `all_criteria` (parcels where EVERY condition holds, which is the number to report as the total matched), `any_criteria` (parcels where at least one holds, which is NOT that number), `per_criterion` counts, `by_criteria_met` (how many parcels met 4 of 4, 3 of 4 and so on), the universe row count, the exact SQL behind each number, and the top ranked rows with the per criterion flags as evidence. ALWAYS use this instead of hand writing a scored, weighted or OR query for a multi signal question such as strong candidates for further review: run_sql returns no total_matched for such a statement, on purpose.",
    inputSchema: z.object({
      criteria: z
        .array(
          z.object({
            label: z.string().min(1).describe("The condition in plain English, for the answer to quote."),
            expression: z
              .string()
              .min(1)
              .describe(
                "A boolean SQL expression over `properties`, for example \"roof_year_est IS NOT NULL AND roof_year_est <= EXTRACT(YEAR FROM CURRENT_DATE) - 15\". No SELECT, no subquery over another table.",
              ),
          }),
        )
        .min(2)
        .max(COUNT_CRITERIA_MAX)
        .describe("The criteria, in the order the answer will present them."),
      columns: z
        .array(z.string())
        .max(12)
        .optional()
        .describe("Extra evidence columns to return on each row, on top of the identity and provenance columns."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(PRESET_MAX_LIMIT)
        .optional()
        .describe(`Rows to return, up to ${PRESET_MAX_LIMIT}. Default ${PRESET_DEFAULT_LIMIT}.`),
    }),
    execute: async ({ criteria, columns, limit }) => {
      const started = Date.now();
      const effectiveLimit = Math.min(
        Math.max(limit ?? PRESET_DEFAULT_LIMIT, PRESET_DEFAULT_LIMIT),
        PRESET_MAX_LIMIT,
      );
      const input = { criteria, columns: columns ?? [], limit: effectiveLimit };
      const fail = (message: string, extra: Record<string, unknown> = {}) => {
        record(trace, {
          name: "count_criteria",
          input,
          summary: `rejected: ${message}`,
          output_summary: `rejected: ${message}`,
          elapsed_ms: Date.now() - started,
          row_count: null,
          error: message,
        });
        return { error: message, ...extra };
      };

      // Each expression goes through the same guard run_sql uses. The DuckDB instance is sealed as
      // well, so this is defence in depth rather than the only boundary, but a criterion is model
      // written SQL and model written SQL is checked wherever it enters.
      for (const criterion of criteria) {
        const probe = guardSql(`SELECT COUNT(*) FROM ${VIEW_NAME} WHERE (${criterion.expression})`, 1);
        if (!probe.ok) return fail(`criterion "${criterion.label}" was rejected: ${probe.reason}`, { rejected: true });
      }

      try {
        const described = await db.query(`DESCRIBE ${VIEW_NAME}`);
        const known = new Set(described.rows.map((row) => String(row.column_name)));
        const extra = (columns ?? []).filter((column) => known.has(column));
        const unknownColumns = (columns ?? []).filter((column) => !known.has(column));

        const flags = criteria.map((criterion, index) => ({
          alias: `criterion_${index + 1}_met`,
          label: criterion.label,
          expression: criterion.expression,
          caseExpr: `CASE WHEN (${criterion.expression}) THEN 1 ELSE 0 END`,
        }));
        const allPredicate = criteria.map((criterion) => `(${criterion.expression})`).join(" AND ");
        const anyPredicate = criteria.map((criterion) => `(${criterion.expression})`).join(" OR ");
        const scoreExpr = flags.map((flag) => flag.caseExpr).join(" + ");

        const countsSql = `SELECT COUNT(*) AS universe_rows,\n  ${flags
          .map((flag, index) => `COUNT(*) FILTER (WHERE (${criteria[index].expression})) AS ${flag.alias}`)
          .join(",\n  ")},\n  COUNT(*) FILTER (WHERE ${allPredicate}) AS all_criteria,\n  COUNT(*) FILTER (WHERE ${anyPredicate}) AS any_criteria\nFROM ${VIEW_NAME}`;
        const histogramSql = `SELECT criteria_met, COUNT(*) AS parcels FROM (SELECT ${scoreExpr} AS criteria_met FROM ${VIEW_NAME}) AS scored GROUP BY 1 ORDER BY 1 DESC`;
        const rowSelect = [
          "property_id",
          ...ADDRESS_COLUMNS,
          ...flags.map((flag) => `${flag.caseExpr} AS ${flag.alias}`),
          `${scoreExpr} AS criteria_met`,
          ...extra,
          ...SPINE_PROVENANCE,
        ].join(",\n  ");
        const rowsSql = `SELECT ${rowSelect}\nFROM ${VIEW_NAME}\nORDER BY criteria_met DESC, property_id\nLIMIT ${effectiveLimit}`;

        const [countsResult, histogramResult, rowsResult] = await Promise.all([
          db.query(countsSql),
          db.query(histogramSql),
          db.query(rowsSql),
        ]);

        const counts = countsResult.rows[0] ?? {};
        const universeRows = Number(counts.universe_rows ?? 0);
        const allCriteria = Number(counts.all_criteria ?? 0);
        const anyCriteria = Number(counts.any_criteria ?? 0);
        const perCriterion = flags.map((flag, index) => ({
          criterion: index + 1,
          label: flag.label,
          expression: flag.expression,
          parcels: Number(counts[flag.alias] ?? 0),
          sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE (${flag.expression})`,
        }));
        const histogram = histogramResult.rows.map((row) => ({
          criteria_met: Number(row.criteria_met ?? 0),
          parcels: Number(row.parcels ?? 0),
        }));

        recordCount(trace, {
          value: universeRows,
          counts: `rows in the published ${VIEW_NAME} view, one per parcel`,
          sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME}`,
          shape: "aggregate",
          tool: "count_criteria",
        });
        for (const entry of perCriterion) {
          recordCount(trace, {
            value: entry.parcels,
            counts: `parcels meeting criterion ${entry.criterion} on its own: ${entry.label}`,
            sql: entry.sql,
            shape: "conjunction",
            tool: "count_criteria",
          });
        }
        // The conjunction is composed here, by this tool, from the criteria as given. That is why
        // it can be labelled a conjunction with a straight face even when one criterion is itself
        // an OR: what the number counts is rows where every listed criterion holds.
        recordCount(trace, {
          value: allCriteria,
          counts: `parcels meeting ALL ${criteria.length} criteria`,
          sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${allPredicate}`,
          shape: "conjunction",
          tool: "count_criteria",
        });
        recordCount(trace, {
          value: anyCriteria,
          counts: `parcels meeting AT LEAST ONE of the ${criteria.length} criteria, which is not the number meeting all of them`,
          sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${anyPredicate}`,
          shape: "disjunction",
          tool: "count_criteria",
        });
        for (const bucket of histogram) {
          recordCount(trace, {
            value: bucket.parcels,
            counts: `parcels meeting exactly ${bucket.criteria_met} of the ${criteria.length} criteria`,
            sql: `${histogramSql} (row where criteria_met = ${bucket.criteria_met})`,
            shape: "scored",
            tool: "count_criteria",
          });
        }

        recordEvidence(trace, rowsResult.rows, "count_criteria");
        noteDataCaveats(trace, rowsResult.rows);
        addAssumption(
          trace,
          `A criterion a parcel has no data for scores 0, not negative: criteria_met counts conditions PROVED true, so a parcel with a NULL signal is indistinguishable here from one that fails that condition. ${allCriteria.toLocaleString(
            "en-US",
          )} of ${universeRows.toLocaleString("en-US")} parcels meet all ${criteria.length} criteria; ${anyCriteria.toLocaleString(
            "en-US",
          )} meet at least one, and that larger number is not an answer to "how many meet the criteria".`,
        );

        const summary = `${allCriteria} of ${universeRows} meet all ${criteria.length} criteria (${anyCriteria} meet at least one)`;
        record(trace, {
          name: "count_criteria",
          input,
          summary,
          output_summary: summary,
          elapsed_ms: Date.now() - started,
          row_count: rowsResult.rows.length,
          total_matched: allCriteria,
          count_shape: "conjunction",
          result: { all_criteria: allCriteria, any_criteria: anyCriteria, universe_rows: universeRows },
        });

        return harvest(trace, {
          universe_rows: universeRows,
          all_criteria: {
            parcels: allCriteria,
            means: `parcels meeting ALL ${criteria.length} criteria. THIS is the number to report as the total matched.`,
            sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${allPredicate}`,
          },
          any_criteria: {
            parcels: anyCriteria,
            means:
              "parcels meeting AT LEAST ONE criterion. Never report this as the number meeting the criteria, and if you cite it, say in the same sentence that it is the at-least-one count.",
            sql: `SELECT COUNT(*) AS total FROM ${VIEW_NAME} WHERE ${anyPredicate}`,
          },
          per_criterion: perCriterion,
          by_criteria_met: histogram,
          counts_sql: countsSql,
          histogram_sql: histogramSql,
          rows_sql: rowsSql,
          rows: rowsResult.rows,
          row_count: rowsResult.rows.length,
          scoring_rule: `criteria_met = ${flags.map((flag) => `(${flag.label} ? 1 : 0)`).join(" + ")}. A missing signal scores 0, not negative.`,
          ignored_columns: unknownColumns,
          elapsed_ms: countsResult.elapsed_ms + histogramResult.elapsed_ms + rowsResult.elapsed_ms,
          is_sample: db.isSample,
        });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  });

  return { get_schema, run_sql, preset_question, count_criteria, get_property, get_run_history };
}

export type AgentTools = ReturnType<typeof createAgentTools>;
export const TOOL_NAMES = [
  "get_schema",
  "run_sql",
  "preset_question",
  "count_criteria",
  "get_property",
  "get_run_history",
] as const;
