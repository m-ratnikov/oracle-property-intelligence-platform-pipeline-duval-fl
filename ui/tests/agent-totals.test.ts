/**
 * The totals gate: a number reaches the reader only if a tool produced it.
 *
 * The defect this file locks shut. Asked demo prompt C ("strong candidates for further review
 * based on ownership age, roof age, and location signals") the deployed agent wrote a scored OR
 * query and then narrated its row count as a conjunction:
 *
 *     "Total matched: 357,350 properties meet these criteria"
 *
 * Measured on the published artifact (bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri,
 * 404,023 rows, 131 columns) the four way AND of the same signals is 5,441, and
 * owner_region_class = 'REGIONAL' is 34,649 rows in total. The printed number was therefore not
 * merely wrong, it was ten times the entire universe of one of its own conditions, which is the
 * shape of an impossible claim: a conjunction can never exceed its smallest conjunct.
 *
 * These tests do not ask whether the model behaves. They assert the three places where the code
 * makes the claim impossible to state:
 *   1. classifyCountShape refuses conjunction semantics to any statement that is not a plain AND,
 *      so run_sql cannot hand back a scored or OR row count under the name `total_matched`;
 *   2. count_criteria composes the AND itself and returns the conjunction, the disjunction and the
 *      per score counts under names that say which is which, each with its SQL;
 *   3. verifyAnswerTotals deletes any population count from the answer that no tool produced, and
 *      staples the predicate to any that came from a non conjunction query.
 *
 * The sample parquet is a faithful miniature of the failure: on its 480 rows the four signals give
 * roof 331, hold 340, transit 401, regional 28, all four 10, at least one 477. 477 exceeding 28 is
 * the same impossibility at 1/840th scale, so an assertion written here is an assertion about the
 * published artifact too.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { createAgentTools, newTrace, type ToolTrace } from "@/lib/agent/tools";
import { runAgent } from "@/lib/agent/run";
import type { ResolvedModel } from "@/lib/agent/model";
import { PRESET_NAME_LIST, presetFor } from "@/lib/agent/schema";
import {
  aggregateValueShape,
  classifyCountShape,
  formatCountLedger,
  MIN_POPULATION_COUNT,
  REMOVED_TOTAL,
  verifyAnswerTotals,
  type CountClaim,
} from "@/lib/agent/totals";

let db: PropertyDb;

type Tools = ReturnType<typeof createAgentTools>;

const callOptions = { toolCallId: "test", messages: [] } as never;

function tools(trace: ToolTrace = newTrace()): { tools: Tools; trace: ToolTrace } {
  return { tools: createAgentTools({ db, env: { ...process.env } }, trace), trace };
}

async function exec<T>(tool: { execute?: unknown }, input: unknown): Promise<T> {
  const run = tool.execute as (input: unknown, options: unknown) => Promise<T>;
  return run(input, callOptions);
}

/** The four signals demo prompt C combines, as SQL over the published columns. */
const ROOF = "roof_year_est IS NOT NULL AND roof_year_est <= EXTRACT(YEAR FROM CURRENT_DATE) - 15";
const HOLD = "years_since_last_sale IS NOT NULL AND years_since_last_sale >= 10";
const TRANSIT = "nearest_transit_stop_m IS NOT NULL AND nearest_transit_stop_m <= 800";
const REGIONAL = "owner_region_class = 'REGIONAL'";

/** The statement the deployed agent actually wrote for demo prompt C. */
const SCORED_QUERY = `SELECT property_id, address_street, owner_region_class,
  (CASE WHEN ${ROOF} THEN 1 ELSE 0 END
   + CASE WHEN ${HOLD} THEN 1 ELSE 0 END
   + CASE WHEN ${TRANSIT} THEN 1 ELSE 0 END
   + CASE WHEN ${REGIONAL} THEN 1 ELSE 0 END) AS score
FROM properties
WHERE ${ROOF} OR ${HOLD} OR ${TRANSIT} OR ${REGIONAL}
ORDER BY score DESC`;

beforeAll(async () => {
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
});

afterAll(async () => {
  await db.close();
});

describe("count shape classification", () => {
  it("calls a plain AND of conditions a conjunction", () => {
    expect(classifyCountShape(`SELECT property_id FROM properties WHERE ${ROOF} AND ${HOLD}`)).toBe("conjunction");
    expect(classifyCountShape(`${ROOF} AND ${HOLD} AND ${TRANSIT} AND ${REGIONAL}`)).toBe("conjunction");
  });

  it("classifies every preset predicate as a conjunction, which is why presets keep their total", () => {
    // If a preset ever gains an OR, it loses its conjunction total on the same commit rather than
    // quietly keeping a name that no longer describes what it counted.
    for (const name of PRESET_NAME_LIST) {
      expect(classifyCountShape(presetFor(name).predicate), name).toBe("conjunction");
    }
  });

  it("refuses conjunction semantics to a top level OR", () => {
    expect(classifyCountShape(`SELECT * FROM properties WHERE ${ROOF} OR ${REGIONAL}`)).toBe("disjunction");
  });

  it("refuses conjunction semantics to an OR nested inside an AND", () => {
    // Conservative on purpose. "a AND (b OR c)" counted 5 rows meeting a composite condition, which
    // is not the same claim as "5 rows meet all of these criteria", and the cost of being careful
    // here is one extra tool call.
    expect(classifyCountShape(`SELECT * FROM properties WHERE ${ROOF} AND (${TRANSIT} OR ${REGIONAL})`)).toBe(
      "disjunction",
    );
  });

  it("calls the statement behind the defect scored, not a conjunction", () => {
    expect(classifyCountShape(SCORED_QUERY)).toBe("scored");
  });

  it("calls a grouped or aggregated statement an aggregate, because its row count is result rows", () => {
    expect(classifyCountShape("SELECT owner_region_class, COUNT(*) AS n FROM properties GROUP BY 1")).toBe(
      "aggregate",
    );
    expect(classifyCountShape("SELECT COUNT(*) AS total FROM properties WHERE roof_year_est IS NOT NULL")).toBe(
      "aggregate",
    );
  });

  it("recovers the shape of the WHERE behind a hand written COUNT, so that route keeps a receipt", () => {
    expect(aggregateValueShape(`SELECT COUNT(*) AS total FROM properties WHERE ${ROOF} AND ${HOLD}`)).toBe(
      "conjunction",
    );
    expect(aggregateValueShape(`SELECT COUNT(*) AS total FROM properties WHERE ${ROOF} OR ${HOLD}`)).toBe(
      "disjunction",
    );
  });

  it("calls a statement with no WHERE unfiltered, which is still an exact count of what it selects", () => {
    expect(classifyCountShape("SELECT property_id FROM properties ORDER BY property_id")).toBe("unfiltered");
  });
});

describe("run_sql cannot name a non conjunction count total_matched", () => {
  interface SqlOutput {
    total_matched: number | null;
    rows_selected: number | null;
    count_shape: string;
    count_semantics: string;
    count_sql: string;
    row_count: number;
  }

  it("returns null total_matched for the scored OR query and the honest number under rows_selected", async () => {
    const { tools: t, trace } = tools();
    const output = await exec<SqlOutput>(t.run_sql, { sql: SCORED_QUERY, limit: 25 });
    expect(output.count_shape).toBe("scored");
    // This single assertion is the defect. Before the gate, this field held the OR row count and
    // the model read its name as permission to call it the total.
    expect(output.total_matched).toBeNull();
    expect(output.rows_selected).toBeGreaterThan(0);
    expect(output.count_semantics).toMatch(/not the number meeting all conditions/i);
    expect(output.count_sql).toContain("COUNT(*)");
    // The transcript line carries the caveat too, so a reader scanning the tool panel sees it.
    expect(trace.calls[0].output_summary).toMatch(/not a conjunction total/i);
    expect(trace.calls[0].count_shape).toBe("scored");
  });

  it("registers the count with the statement that produced it and the shape it had", async () => {
    const { tools: t, trace } = tools();
    await exec<SqlOutput>(t.run_sql, { sql: `SELECT property_id FROM properties WHERE ${ROOF} OR ${REGIONAL}` });
    const claim = trace.counts.find((entry) => entry.tool === "run_sql");
    expect(claim).toBeDefined();
    expect(claim!.shape).toBe("disjunction");
    expect(claim!.sql).toContain("OR");
    expect(trace.seen.has(claim!.value)).toBe(true);
  });

  it("keeps total_matched for a plain AND, so a correct conjunction query is not penalised", async () => {
    const { tools: t } = tools();
    const output = await exec<SqlOutput>(t.run_sql, {
      sql: `SELECT property_id FROM properties WHERE ${ROOF} AND ${HOLD}`,
      limit: 10,
    });
    expect(output.count_shape).toBe("conjunction");
    expect(output.total_matched).toBe(output.rows_selected);
    expect(output.total_matched).toBeGreaterThan(0);
  });
});

describe("count_criteria", () => {
  interface CriteriaOutput {
    universe_rows: number;
    all_criteria: { parcels: number; means: string; sql: string };
    any_criteria: { parcels: number; means: string; sql: string };
    per_criterion: { criterion: number; label: string; parcels: number; sql: string }[];
    by_criteria_met: { criteria_met: number; parcels: number }[];
    rows: Record<string, unknown>[];
    row_count: number;
    scoring_rule: string;
    error?: string;
  }

  const FOUR = [
    { label: "roof 15 years or older", expression: ROOF },
    { label: "held 10 years or longer", expression: HOLD },
    { label: "transit stop within 800 m", expression: TRANSIT },
    { label: "regional owner", expression: REGIONAL },
  ];

  async function four(): Promise<{ output: CriteriaOutput; trace: ToolTrace }> {
    const { tools: t, trace } = tools();
    const output = await exec<CriteriaOutput>(t.count_criteria, { criteria: FOUR });
    return { output, trace };
  }

  it("never lets the conjunction exceed its smallest conjunct, which is what the defect violated", async () => {
    const { output } = await four();
    // 357,350 reported against a REGIONAL universe of 34,649 was impossible for exactly this
    // reason. Stated as an invariant it holds on any data, so this assertion is a claim about the
    // published artifact as much as about the sample.
    for (const entry of output.per_criterion) {
      expect(output.all_criteria.parcels, entry.label).toBeLessThanOrEqual(entry.parcels);
    }
  });

  it("keeps the at-least-one count strictly apart from the all-of count, both labelled", async () => {
    const { output } = await four();
    expect(output.any_criteria.parcels).toBeGreaterThan(output.all_criteria.parcels);
    for (const entry of output.per_criterion) {
      expect(output.any_criteria.parcels).toBeGreaterThanOrEqual(entry.parcels);
    }
    expect(output.all_criteria.means).toMatch(/ALL 4 criteria/);
    expect(output.any_criteria.means).toMatch(/Never report this as the number meeting the criteria/);
  });

  it("returns the score breakdown, which sums to the universe and agrees with the conjunction", async () => {
    const { output } = await four();
    const total = output.by_criteria_met.reduce((sum, bucket) => sum + bucket.parcels, 0);
    expect(total).toBe(output.universe_rows);
    const full = output.by_criteria_met.find((bucket) => bucket.criteria_met === FOUR.length);
    expect(full?.parcels).toBe(output.all_criteria.parcels);
  });

  it("hands back every number with the SQL that produced it", async () => {
    const { output, trace } = await four();
    expect(output.all_criteria.sql).toContain("AND");
    expect(output.any_criteria.sql).toContain("OR");
    for (const entry of output.per_criterion) expect(entry.sql).toContain("COUNT(*)");
    // Every claim registered on the trace carries a statement, not just a number.
    expect(trace.counts.length).toBeGreaterThan(FOUR.length);
    for (const claim of trace.counts) expect(claim.sql.trim().length).toBeGreaterThan(0);
  });

  it("returns ranked rows with the per criterion flags, and records them as evidence", async () => {
    const { output, trace } = await four();
    expect(output.row_count).toBeGreaterThan(0);
    const first = output.rows[0];
    expect(first).toHaveProperty("criteria_met");
    expect(first).toHaveProperty("criterion_1_met");
    expect(first).toHaveProperty("criterion_4_met");
    expect(Number(first.criteria_met)).toBe(FOUR.length);
    expect(trace.evidence.length).toBe(output.row_count);
    expect(output.scoring_rule).toMatch(/missing signal scores 0/i);
  });

  it("says out loud that a missing signal scores 0 rather than counting against the parcel", async () => {
    const { trace } = await four();
    expect(trace.assumptions.some((note) => /scores 0, not negative/.test(note))).toBe(true);
    expect(trace.assumptions.some((note) => /is not an answer to "how many meet the criteria"/.test(note))).toBe(
      true,
    );
  });

  it("puts a criterion through the same guard as run_sql", async () => {
    const { tools: t } = tools();
    const output = await exec<{ error?: string; rejected?: boolean }>(t.count_criteria, {
      criteria: [
        { label: "ok", expression: ROOF },
        { label: "not ok", expression: "1=1) ; DROP TABLE properties --" },
      ],
    });
    expect(output.rejected).toBe(true);
    expect(output.error).toBeTruthy();
  });
});

describe("verifyAnswerTotals", () => {
  const claim: CountClaim = {
    value: 5441,
    counts: "parcels meeting ALL 4 criteria",
    sql: "SELECT COUNT(*) AS total FROM properties WHERE a AND b AND c AND d",
    shape: "conjunction",
    tool: "count_criteria",
  };
  const orClaim: CountClaim = {
    value: 357851,
    counts: "parcels meeting AT LEAST ONE of the criteria",
    sql: "SELECT COUNT(*) AS total FROM properties WHERE a OR b OR c",
    shape: "disjunction",
    tool: "run_sql",
  };

  it("deletes a total no tool produced", () => {
    const result = verifyAnswerTotals("Total matched: 357,350 properties meet these criteria.", [], new Set());
    expect(result.answer).not.toContain("357,350");
    expect(result.answer).toContain(REMOVED_TOTAL);
    expect(result.unverified).toEqual(["357,350"]);
  });

  it("keeps a total a tool computed, and cites its claim", () => {
    const result = verifyAnswerTotals(
      "Total matched: 5,441 properties meet all four criteria.",
      [claim],
      new Set([5441]),
    );
    expect(result.answer).toContain("5,441");
    expect(result.unverified).toEqual([]);
    expect(result.cited).toEqual([claim]);
  });

  it("staples the predicate to a total that came from a query containing OR", () => {
    const result = verifyAnswerTotals(
      "Total matched: 357,851 properties meet these criteria.",
      [orClaim],
      new Set([357851]),
    );
    expect(result.answer).toContain("357,851");
    // The number survives because it was computed, but it cannot be read apart from what it counted.
    expect(result.answer).toMatch(/predicate containing OR/i);
    expect(result.cited).toEqual([orClaim]);
  });

  it("keeps a number a tool returned even when no count claim carries it", () => {
    // get_schema documents dataset facts in its notes, and a value on a row is a number the model
    // legitimately saw. The allow list is "what came out of a tool", not "what was counted".
    const result = verifyAnswerTotals("Its market_value is 251,000 on the roll.", [], new Set([251000]));
    expect(result.answer).toContain("251,000");
    expect(result.unverified).toEqual([]);
  });

  it("leaves thresholds, years and display counts alone", () => {
    const text =
      "Showing 8 of the 25 retrieved rows. Roof age >= 15 years, within 800 m, roof_year_est=1998 for parcel 1998 built in 1900.";
    const result = verifyAnswerTotals(text, [], new Set());
    expect(result.answer).toBe(text);
    expect(result.unverified).toEqual([]);
    // Stated so the reason is checkable: no tool returns more than 200 rows, so a population count
    // above 200 is necessarily a claim about rows the model never saw.
    expect(MIN_POPULATION_COUNT).toBe(200);
  });

  it("leaves numbers inside code alone, because there they are quoted SQL and not a claim", () => {
    const text = "I ran `SELECT COUNT(*) FROM properties WHERE x > 357350 properties`.";
    expect(verifyAnswerTotals(text, [], new Set()).answer).toBe(text);
  });

  it("renders each cited count next to the statement that produced it", () => {
    const ledger = formatCountLedger([claim, orClaim], ["357,350"]);
    expect(ledger).toContain("Counts in this answer");
    expect(ledger).toContain("5,441");
    expect(ledger).toContain(claim.sql);
    expect(ledger).toContain(orClaim.sql);
    expect(ledger).toMatch(/1 number removed/);
  });
});

/** A model that runs a scripted list of tool calls, then writes text built from what it was given. */
function scriptedModel(
  script: Array<{ toolName: string; input: unknown } | { text: (seen: string) => string }>,
): LanguageModelV3 {
  let step = 0;
  const usage = {
    inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
    outputTokens: { total: 30, text: 30, reasoning: 0 },
  };
  return new MockLanguageModelV3({
    modelId: "mock-totals",
    doGenerate: async (options) => {
      const current = script[Math.min(step, script.length - 1)];
      step += 1;
      if ("toolName" in current) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${step}`,
              toolName: current.toolName,
              input: JSON.stringify(current.input),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: current.text(JSON.stringify(options.prompt)) }],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage,
        warnings: [],
      };
    },
  });
}

function resolved(model: LanguageModelV3): ResolvedModel {
  return {
    provider: "anthropic",
    modelId: "mock-totals",
    model,
    source: "server",
    instructions: (system) => ({ role: "system", content: system }),
  };
}

/**
 * Pull a number out of what the model was actually handed, the way a compliant model would.
 *
 * Searches from the end, because the serialised prompt starts with the system prompt, which names
 * several of these fields in prose, and the tool result is the most recent message in it.
 */
function fromToolResult(seen: string, anchor: string, key = anchor): number {
  const positions: number[] = [];
  for (let at = seen.indexOf(anchor); at >= 0; at = seen.indexOf(anchor, at + 1)) positions.push(at);
  expect(positions.length, `${anchor} was not in what the model was given`).toBeGreaterThan(0);
  const pattern = new RegExp(`${key}[^0-9]{0,10}(\\d+)`);
  // Latest first: the anchor also appears in the system prompt's prose and in SQL aliases inside
  // the result, and the value wanted here is the JSON field the tool returned.
  for (const position of positions.reverse()) {
    const match = pattern.exec(seen.slice(position, position + 400));
    if (match) return Number(match[1]);
  }
  throw new Error(`${key} was not a number near ${anchor}`);
}

describe("the answer gate, end to end through the loop", () => {
  it("removes the demo prompt C headline that no query produced", async () => {
    // The exact regression. The model runs the scored OR query, then writes the sentence the
    // deployed agent wrote, with a number that appears nowhere in what any tool returned.
    const model = scriptedModel([
      { toolName: "run_sql", input: { sql: SCORED_QUERY, limit: 25 } },
      { text: () => "Total matched: 357,350 properties meet these criteria." },
    ]);
    const response = await runAgent({
      messages: [
        {
          role: "user",
          content:
            "Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?",
        },
      ],
      model: resolved(model),
      db,
      env: {},
    });

    expect(response.answer).not.toContain("357,350");
    expect(response.answer).not.toContain("357350");
    expect(response.answer).toContain(REMOVED_TOTAL);
    expect(response.unverified_totals).toContain("357,350");
    // The removal is not silent: the counts that WERE computed are printed with their SQL.
    expect(response.answer).toContain("number removed");
    // And the tool that produced the OR row count refused to call it a total.
    const call = response.tool_calls.find((entry) => entry.name === "run_sql");
    expect(call?.count_shape).toBe("scored");
  });

  it("keeps a total the model read out of the tool result, and prints its query underneath", async () => {
    const model = scriptedModel([
      { toolName: "run_sql", input: { sql: SCORED_QUERY, limit: 25 } },
      {
        text: (seen) =>
          `Total matched: ${fromToolResult(seen, "rows_selected").toLocaleString("en-US")} properties meet these criteria.`,
      },
    ]);
    const response = await runAgent({
      messages: [{ role: "user", content: "strong candidates" }],
      model: resolved(model),
      db,
      env: {},
    });

    expect(response.unverified_totals).toEqual([]);
    // Computed, so it stands; disjunctive, so it cannot be read apart from its predicate.
    expect(response.answer).toMatch(/predicate containing OR|score threshold/i);
    expect(response.totals.length).toBeGreaterThan(0);
    expect(response.answer).toContain("Counts in this answer");
  });

  it("answers demo prompt C correctly through count_criteria without any number being removed", async () => {
    const model = scriptedModel([
      {
        toolName: "count_criteria",
        input: {
          criteria: [
            { label: "roof 15 years or older", expression: ROOF },
            { label: "held 10 years or longer", expression: HOLD },
            { label: "transit stop within 800 m", expression: TRANSIT },
            { label: "regional owner", expression: REGIONAL },
          ],
        },
      },
      {
        text: (seen) =>
          `${fromToolResult(seen, "all_criteria", "parcels").toLocaleString("en-US")} parcels meet all four criteria.`,
      },
    ]);
    const response = await runAgent({
      messages: [{ role: "user", content: "strong candidates" }],
      model: resolved(model),
      db,
      env: {},
    });
    expect(response.unverified_totals).toEqual([]);
    expect(response.evidence.length).toBeGreaterThan(0);
    const call = response.tool_calls.find((entry) => entry.name === "count_criteria");
    expect(call?.count_shape).toBe("conjunction");
    expect(call?.output_summary).toMatch(/meet all 4 criteria/);
  });
});

describe("demo prompts A and B are unaffected", () => {
  /** Prompt A and prompt B both run a preset, whose predicate is a plain AND. */
  const cases: Array<{ label: string; preset: string; question: string }> = [
    {
      label: "A",
      preset: "roof15_and_no_sale10y",
      question: "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
    },
    {
      label: "B",
      preset: "transit_and_regional",
      question: "Which properties are near public transportation and also have regional owners?",
    },
  ];

  for (const entry of cases) {
    it(`prompt ${entry.label} keeps its total verbatim, its evidence and its assumptions`, async () => {
      const model = scriptedModel([
        { toolName: "preset_question", input: { name: entry.preset, limit: 25 } },
        {
          text: (seen) => {
            const total = fromToolResult(seen, "total_matched");
            return `**${total.toLocaleString("en-US")} properties meet the rule; showing 8.**\n\nAssumptions and missing data follow.`;
          },
        },
      ]);
      const response = await runAgent({
        messages: [{ role: "user", content: entry.question }],
        model: resolved(model),
        db,
        env: {},
      });

      const call = response.tool_calls.find((tool) => tool.name === "preset_question");
      expect(call?.count_shape).toBe("conjunction");
      expect(call?.total_matched).toBeGreaterThan(0);

      // The number the model read out of the preset result reaches the reader unchanged, with no
      // tag and no removal: a conjunction total is exactly what may be called a total.
      expect(response.unverified_totals).toEqual([]);
      expect(response.answer).toContain(call!.total_matched!.toLocaleString("en-US"));
      expect(response.answer).not.toContain(REMOVED_TOTAL);
      expect(response.answer).not.toMatch(/predicate containing OR/i);

      // The shape the demo relies on: a tool transcript, the retrieved evidence rows, and the
      // stated assumptions, none of which the gate touches.
      expect(response.tool_calls.length).toBeGreaterThan(0);
      expect(response.evidence.length).toBe(call!.row_count);
      expect(response.assumptions.length).toBeGreaterThan(0);

      // The one addition: the count now arrives with the statement that produced it.
      //
      // Only above MIN_POPULATION_COUNT, because below it a number in the prose is a display count
      // or a threshold that the reader can check against the table on the same page. On the sample
      // parquet prompt B's total is 22 and falls under that line; on the published artifact both
      // prompts are far above it (prompt A matches 130,043 parcels and prompt B 26,917), so the
      // ledger is what a reviewer driving the live site sees for either one.
      if (call!.total_matched! > MIN_POPULATION_COUNT) {
        expect(response.answer).toContain("Counts in this answer");
        expect(response.totals.some((total) => total.shape === "conjunction")).toBe(true);
        expect(response.totals.some((total) => total.sql.includes("COUNT(*)"))).toBe(true);
      }
    });
  }
});
