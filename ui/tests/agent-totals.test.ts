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
  findPopulationClaims,
  formatCountLedger,
  harvestNumbers,
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

/**
 * The three ways the defect could come back, found by adversarial review of the gate rather than by
 * the live site.
 *
 * None of these ever fired in production, which is exactly why they need tests: a deployed answer
 * cannot tell anyone whether a hole is shut, only that nothing walked through it that day. Each
 * assertion below was first run against the version of totals.ts that shipped the live fix, where
 * the numeral was not removed because it was never inspected.
 *
 * What the gate now guarantees, in one sentence with two load bearing halves: a numeral the answer
 * presents as a population count is one this turn computed AS a population count. The first half is
 * detection, which now fails closed; the second is backing, which is now separated by role.
 */
describe("the gate closes the class, not three instances", () => {
  /** Hole 1. A measured `357,350` reached the reader verbatim because code spans were skipped. */
  it("reads a bare numeral in backticks as a claim, because backticks are not a receipt", () => {
    const result = verifyAnswerTotals("The population is `357,350` on this reading.", [], new Set());
    expect(result.unverified).toEqual(["357,350"]);
    expect(result.answer).toContain(REMOVED_TOTAL);
  });

  it("still leaves quoted SQL and column names alone, which is what skipping code was ever for", () => {
    // The reason to skip a code span is that SQL and identifiers must not be rewritten. That is a
    // different question from whether a bare number in backticks is a claim, so a span is now
    // skipped only when it carries evidence of being code.
    for (const text of [
      "I ran `SELECT COUNT(*) FROM properties WHERE x > 357350 properties`.",
      "The threshold column is `nearest_transit_stop_m <= 800`.",
      "```sql\nSELECT property_id FROM properties WHERE market_value > 357350\n```",
    ]) {
      expect(verifyAnswerTotals(text, [], new Set()).answer, text).toBe(text);
    }
  });

  /** Hole 2. Detection keyed on phrasings it recognised, so an unanticipated sentence was unguarded. */
  it("fails closed on phrasings nobody anticipated", () => {
    // There is no finite list of ways to say "N of them", so the gate stopped trying to keep one.
    for (const text of [
      "The scored population is 357,350.",
      "Roughly 357,350 fall into this bucket.",
      "That leaves 357,350 after the score threshold is applied.",
      "Population: 357,350",
      "357,350 is the size of the group.",
    ]) {
      expect(verifyAnswerTotals(text, [], new Set()).unverified, text).toEqual(["357,350"]);
    }
  });

  /** Hole 3. Any number a tool emitted anywhere was allowed, per row cell values included. */
  it("refuses a per row cell value as backing for a population claim", () => {
    // 200 rows times many numeric columns is a lot of chances for a fabricated total to collide
    // with some cell. A market_value of 357,350 is a real number the turn saw; it is not a count of
    // parcels, and the old allow list could not tell those apart.
    const seen = new Set<number>();
    harvestNumbers(
      {
        columns: ["property_id", "market_value", "total_value"],
        rows: [{ property_id: "1760825000R", market_value: 357350, total_value: 357350 }],
        row_count: 1,
        count_shape: "conjunction",
      },
      seen,
    );
    expect(seen.has(357350)).toBe(false);
    expect(verifyAnswerTotals("Total matched: 357,350 properties meet these criteria.", [], seen).unverified).toEqual([
      "357,350",
    ]);
  });

  it("refuses a literal the model aliased as a count, because only an aggregate computes one", () => {
    // "SELECT 357350 AS total_matched" puts a fabricated number under a count name. It is not an
    // aggregate, and the shape is decided by the code reading the statement, never by the alias.
    const seen = new Set<number>();
    harvestNumbers({ rows: [{ total_matched: 357350 }], row_count: 1, count_shape: "unfiltered" }, seen);
    expect(seen.has(357350)).toBe(false);
  });

  it("keeps a grouped count, so a breakdown table is still printable", () => {
    // "SELECT owner_region_class, COUNT(*) AS n ... GROUP BY 1" returns counts inside rows, and
    // 34,649 REGIONAL parcels is a number a reader may legitimately be told. What makes the column
    // name trustworthy here and untrustworthy above is that the enclosing statement was classified
    // as an aggregate by classifyCountShape, which no alias can bring about on its own.
    const seen = new Set<number>();
    harvestNumbers(
      {
        columns: ["owner_region_class", "n"],
        rows: [{ owner_region_class: "REGIONAL", n: 34649 }],
        count_shape: "aggregate",
      },
      seen,
    );
    expect(seen.has(34649)).toBe(true);
  });

  it("does not let an echoed statement vouch for the numbers inside it", () => {
    // count_sql is the model's own text handed back as a receipt. Treating a literal in it as a
    // number the tool asserted would let the model launder any value through a WHERE clause.
    const seen = new Set<number>();
    harvestNumbers(
      { count_sql: "SELECT COUNT(*) AS total FROM properties WHERE market_value > 357350", row_count: 1 },
      seen,
    );
    expect(seen.has(357350)).toBe(false);
  });

  it("lets the model repeat a dataset fact a tool stated in words", () => {
    // The same reading is applied to tool prose and to the answer, so anything a tool said as a
    // count the model may say back. This is what keeps get_schema's notes citable now that the
    // allow list is no longer "every numeral anywhere".
    const note = "roof_age_basis is EFF_YR_BLT_PROXY on 359,129 of 404,023 rows and NULL on the other 44,894.";
    const seen = new Set<number>();
    harvestNumbers({ notes: [note] }, seen);
    expect([...seen].sort((a, b) => a - b)).toEqual([44894, 359129, 404023]);
    expect(verifyAnswerTotals(note, [], seen).unverified).toEqual([]);
  });

  it("removes a number the turn derived by arithmetic rather than computed", () => {
    // 404,023 minus 130,043 is true and still not a computed count, and recognising the sentence
    // that carries it is precisely the game the gate stopped playing. Failing closed here is the
    // deliberate price of not losing to the next unanticipated phrasing.
    const total: CountClaim = {
      value: 130043,
      counts: "parcels matching the roof-and-long-hold rule",
      sql: "SELECT COUNT(*) AS total FROM properties WHERE roof AND hold",
      shape: "conjunction",
      tool: "preset_question",
    };
    const result = verifyAnswerTotals(
      "130,043 meet both rules and the remaining 273,980 do not.",
      [total],
      new Set([130043, 404023]),
    );
    expect(result.answer).toContain("130,043");
    expect(result.unverified).toEqual(["273,980"]);
  });
});

/**
 * False positives, checked against the shapes real answers actually have.
 *
 * The fixtures below are the deployed answers to demo prompts A, B and C re-rendered as the
 * markdown the model emits: a headline, an evidence table, a prose example row, a provenance line
 * and an assumptions list. Their numbers are the measured ones from the published artifact
 * (bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri, 404,023 rows, 131 columns):
 * A matches 130,043, B matches 26,917, C's four way AND is 5,441 against 381,275 meeting at least
 * one, and the score histogram is 5,441 / 120,570 / 173,577 / 81,687 / 22,748, which sums to the
 * 404,023 row universe.
 *
 * A stricter gate is only worth having if it leaves a correct answer intact, so these assert that
 * every house number, year, postcode, distance, market value and quoted statement survives while
 * every population count in the same text is still checked.
 */
describe("a correct answer is left intact", () => {
  const schemaNotes = [
    "Ownership tenure comes from last_sale_date_any (401,832 of 404,023 rows) with tenure_basis and tenure_source naming where it came from, never from last_sale_date (NULL on 351,742 rows).",
    "roof_age_basis is EFF_YR_BLT_PROXY on 359,129 of 404,023 rows and NULL on the other 44,894.",
  ];

  function counted(value: number, shape: CountClaim["shape"], counts: string): CountClaim {
    return { value, shape, counts, sql: `SELECT COUNT(*) AS total FROM properties -- ${counts}`, tool: "test" };
  }

  const ANSWER_A = `**130,043 properties meet the rule; showing 8.**

There are 130,043 properties in Duval County with roofs older than 15 years (roof_year_est <= current year - 15) and that have not exchanged ownership in more than 10 years (years_since_last_sale >= 10). Of the 404,023 parcels on the roll, 130,043 meet both rules.

| property_id | address_street | address_city | built_year | roof_year_est | roof_age_years | years_since_last_sale | market_value |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| 1760825000R | 829 S 1ST ST | JACKSONVILLE BEACH | 1900 | 1900 | 126 | 127 | 251,000 |
| 1029170000R | 2400 JAMMES RD | JACKSONVILLE | 1903 | 1903 | 123 | 127 | 1,250,400 |
| 0694020000R | 4212 IRVINGTON AVE | JACKSONVILLE | 1921 | 1921 | 105 | 127 | 84,900 |

One example parcel is 1760825000R at 829 S 1ST ST, JACKSONVILLE BEACH FL 32250, whose market_value is 251,000 and whose nearest transit stop is 194.5 m away. Its assessed value is 316,700.

Provenance: Duval County Property Appraiser (duval_appraiser), fetched at 2026-08-21 13:58:56 from https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/NAL/2026P/Duval%2026%20Preliminary%20NAL%202026.zip.

## Assumptions and missing data
- roof_age_basis is EFF_YR_BLT_PROXY on all 359,129 rows that carry one and PERMIT on zero rows.
- last_sale_date is NULL on 351,742 of 404,023 rows, so tenure comes from last_sale_date_any (401,832 of 404,023 rows).
- 44,894 rows carry no roof year at all.
`;

  const ANSWER_B = `**26,917 properties meet the rule; showing 8.**

There are 26,917 properties near public transportation (nearest_transit_stop_m <= 800 m) with owner_region_class = REGIONAL. Only 8 of 26,917 matching properties are shown; the remaining retrieved rows are in the evidence panel.

| property_id | address_street | nearest_transit_stop_m | owner_region_class |
| --- | --- | ---: | --- |
| 0038090206R | 6765 DUNN AVE 322-330 | 1.8 | REGIONAL |
| 1671980000R | 13642 ATLANTIC BLVD | 3.7 | REGIONAL |
| 0465520900R | 1989 W 13TH ST | 4 | REGIONAL |

The universe is 404,023 parcels, of which 34,649 are REGIONAL.
`;

  const ANSWER_C = `5,441 parcels meet all four criteria, out of 404,023. 381,275 meet at least one, which is a different question.

| Criteria met | Parcels |
| ---: | ---: |
| 4 | 5,441 |
| 3 | 120,570 |
| 2 | 173,577 |
| 1 | 81,687 |
| 0 | 22,748 |

The transit leg alone is 326,112 and the regional leg alone is 34,649. The parcel at 6765 DUNN AVE scores 4 of 4.
`;

  it("prompt A keeps 130,043 and every per row value around it", () => {
    const seen = new Set<number>([130043]);
    harvestNumbers({ notes: schemaNotes, row_count: 404023 }, seen);
    const claims = [counted(130043, "conjunction", "parcels matching the roof-and-long-hold rule")];
    const result = verifyAnswerTotals(ANSWER_A, claims, seen);
    expect(result.unverified).toEqual([]);
    expect(result.answer).toContain("130,043 properties meet the rule");
    // The numbers a reader can check on the page: house numbers, years, a postcode, a distance and
    // three money amounts, none of which is a population and none of which the gate may touch.
    for (const value of [
      "829 S 1ST ST",
      "4212 IRVINGTON AVE",
      "FL 32250",
      "251,000",
      "1,250,400",
      "316,700",
      "194.5 m",
    ]) {
      expect(result.answer, value).toContain(value);
    }
    expect(result.cited.map((entry) => entry.value)).toEqual([130043]);
  });

  it("prompt B keeps 26,917, and the county universe beside it is still checked", () => {
    const seen = new Set<number>([26917]);
    harvestNumbers({ notes: schemaNotes, row_count: 404023 }, seen);
    harvestNumbers(
      {
        columns: ["owner_region_class", "n"],
        rows: [{ owner_region_class: "REGIONAL", n: 34649 }],
        count_shape: "aggregate",
      },
      seen,
    );
    const claims = [counted(26917, "conjunction", "parcels matching the transit-and-regional rule")];
    const result = verifyAnswerTotals(ANSWER_B, claims, seen);
    expect(result.unverified).toEqual([]);
    expect(result.answer).toContain("26,917 properties meet the rule");
    expect(result.answer).toContain("34,649 are REGIONAL");
    expect(result.answer).toContain("6765 DUNN AVE 322-330");
    // 404,023 and 34,649 were read as claims rather than skipped: withdraw their backing and both
    // go, which is what says the surviving pair above is a verification and not an oversight.
    expect(verifyAnswerTotals(ANSWER_B, claims, new Set([26917])).unverified).toEqual(["404,023", "34,649"]);
  });

  it("prompt C keeps 5,441 and labels the at-least-one count beside it", () => {
    const claims = [
      counted(404023, "aggregate", "rows in the published properties view"),
      counted(5441, "conjunction", "parcels meeting ALL 4 criteria"),
      counted(381275, "disjunction", "parcels meeting AT LEAST ONE of the 4 criteria"),
      counted(326112, "conjunction", "parcels meeting criterion 3 on its own"),
      counted(34649, "conjunction", "parcels meeting criterion 4 on its own"),
      ...[120570, 173577, 81687, 22748].map((value, index) =>
        counted(value, "scored", `parcels meeting exactly ${3 - index} of the 4 criteria`),
      ),
    ];
    const seen = new Set(claims.map((entry) => entry.value));
    const result = verifyAnswerTotals(ANSWER_C, claims, seen);
    expect(result.unverified).toEqual([]);
    expect(result.answer).toContain("5,441 parcels meet all four criteria");
    // The at-least-one number survives because it was computed, and cannot be read apart from the
    // predicate that produced it. This is the sentence the original defect got wrong.
    expect(result.answer).toMatch(/381,275 \(rows selected by a predicate containing OR/);
    // The score breakdown is a summary table, so its Parcels column is gated like any other count.
    expect(result.cited.map((entry) => entry.value)).toContain(120570);
  });

  it("checks a count in a Parcels column but not a value in a market_value column", () => {
    // The header decides. A parcel table is per row evidence printed next to the parcel it belongs
    // to; a summary table's Parcels column is a population and gets the same treatment as prose.
    const table = [
      "| property_id | market_value |",
      "| --- | ---: |",
      "| 1760825000R | 357,350 |",
      "",
      "| Criteria met | Parcels |",
      "| ---: | ---: |",
      "| 4 | 357,350 |",
    ].join("\n");
    expect(findPopulationClaims(table)).toHaveLength(1);
    const result = verifyAnswerTotals(table, [], new Set());
    expect(result.unverified).toEqual(["357,350"]);
    // The market_value cell is untouched, so the evidence table still reads.
    expect(result.answer).toContain("| 1760825000R | 357,350 |");
  });
});
