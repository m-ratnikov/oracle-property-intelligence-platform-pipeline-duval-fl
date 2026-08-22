/**
 * The tool loop and the response contract, with the model mocked.
 *
 * A MockLanguageModelV3 from `ai/test` answers the first step with a tool call
 * (preset_question) and the second step with text. The real ToolLoopAgent,
 * the real tools and a real DuckDB over the sample parquet run in between, so
 * this proves the loop executes a tool, the transcript and evidence are
 * filled from the tool trace, and the JSON contract holds. No API calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { runAgent, toModelMessages } from "@/lib/agent/run";
import type { ResolvedModel } from "@/lib/agent/model";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";

let db: PropertyDb;

const usage = {
  inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
  outputTokens: { total: 30, text: 30, reasoning: 0 },
};

function scriptedModel(script: Array<{ toolName: string; input: unknown } | { text: string }>): {
  model: LanguageModelV3;
  calls: LanguageModelV3CallOptions[];
} {
  let step = 0;
  const calls: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    modelId: "mock-sonnet",
    doGenerate: async (options) => {
      calls.push(options);
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
        content: [{ type: "text" as const, text: current.text }],
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, calls };
}

function resolved(model: LanguageModelV3): ResolvedModel {
  return {
    provider: "anthropic",
    modelId: "mock-sonnet",
    model,
    source: "server",
    instructions: (system) => ({
      role: "system",
      content: system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    }),
  };
}

beforeAll(async () => {
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
});

afterAll(async () => {
  await db.close();
});

describe("message shaping", () => {
  it("keeps user/assistant turns, drops a dangling assistant turn, ends with the user", () => {
    const out = toModelMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    expect(out.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("agent loop with a mocked model", () => {
  it("calls preset_question, then answers, and returns the full contract", async () => {
    const { model, calls } = scriptedModel([
      { toolName: "preset_question", input: { name: "roof15_and_no_sale10y", limit: 5 } },
      { text: "Found rows. Rule: roof >= 15 years and hold >= 10 years.\n\n## Assumptions and missing data\n- proxy roof basis" },
    ]);

    const response = await runAgent({
      messages: [
        {
          role: "user",
          content: "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
        },
      ],
      model: resolved(model),
      db,
      env: { ...process.env },
    });

    // Contract.
    expect(response.status).toBe("ok");
    expect(response.answer).toContain("Rule:");
    expect(response.message).toBe(response.answer);
    expect(response.tool_calls).toBe(response.toolCalls);
    expect(response.model).toBe("anthropic:mock-sonnet");
    expect(response.usage?.steps).toBe(2);
    expect(response.usage?.input_tokens).toBe(240);
    expect(response.usage?.cache_read_tokens).toBe(200);
    expect(response.elapsed_ms).toBeGreaterThanOrEqual(0);

    // The loop executed the tool against DuckDB.
    expect(response.tool_calls).toHaveLength(1);
    const call = response.tool_calls[0];
    expect(call.name).toBe("preset_question");
    // the transcript records the limit that actually ran, not the one asked for: a request below
    // the default is floored so the evidence set survives
    expect(call.input).toEqual({ name: "roof15_and_no_sale10y", limit: 25 });
    expect(call.row_count).toBeGreaterThan(0);
    expect(call.row_count).toBeLessThanOrEqual(25);
    expect(call.total_matched).toBeGreaterThanOrEqual(call.row_count ?? 0);
    expect(call.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(call.output_summary).toContain("roof-and-long-hold");

    // Evidence rows carry provenance and the matched columns.
    expect(response.evidence.length).toBe(call.row_count);
    for (const row of response.evidence) {
      expect(row.property_id).toBeTruthy();
      expect(row.source_system).toBeTruthy();
      expect(String(row.source_url)).toMatch(/^https?:\/\//);
      expect(row.fetched_at).toBeTruthy();
      expect(row).toHaveProperty("roof_year_est");
      expect(row).toHaveProperty("years_since_last_sale");
    }

    // Assumptions include the preset caveats and the sample data note.
    expect(response.assumptions.some((text) => /SAMPLE/.test(text))).toBe(true);
    expect(response.assumptions.some((text) => /year_built_proxy|proxy/i.test(text))).toBe(true);

    // Freshness comes from the sample run history.
    expect(response.data_freshness?.run_id).toBeTruthy();
    expect(response.data_freshness?.is_sample).toBe(true);

    // The model saw the system prompt with the cache marker, the tools, and the tool result.
    expect(calls).toHaveLength(2);
    const firstPrompt = calls[0].prompt;
    expect(firstPrompt[0].role).toBe("system");
    expect((firstPrompt[0] as { content: string }).content).toBe(SYSTEM_PROMPT);
    expect((firstPrompt[0] as { providerOptions?: Record<string, unknown> }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    const toolNames = (calls[0].tools ?? []).map((tool) => tool.name).sort();
    expect(toolNames).toEqual([
      "count_criteria",
      "get_property",
      "get_run_history",
      "get_schema",
      "preset_question",
      "run_sql",
    ]);
    expect(calls[1].prompt.some((message) => message.role === "tool")).toBe(true);
  });

  it("returns rejected mutations to the model without breaking the loop", async () => {
    const { model } = scriptedModel([
      { toolName: "run_sql", input: { sql: "DELETE FROM properties" } },
      { text: "I cannot modify data; the tool rejected the statement." },
    ]);
    const response = await runAgent({
      messages: [{ role: "user", content: "delete everything" }],
      model: resolved(model),
      db,
      env: { ...process.env },
    });
    expect(response.status).toBe("ok");
    expect(response.tool_calls[0].name).toBe("run_sql");
    expect(response.tool_calls[0].error).toMatch(/read only/i);
    expect(response.evidence).toHaveLength(0);
    expect(response.answer).toMatch(/rejected/);
  });

  it("stops at the step cap and still returns a transcript", async () => {
    const { model } = scriptedModel([{ toolName: "get_schema", input: {} }]);
    const response = await runAgent({
      messages: [{ role: "user", content: "loop forever" }],
      model: resolved(model),
      db,
      env: { ...process.env },
      maxSteps: 3,
    });
    expect(response.tool_calls).toHaveLength(3);
    expect(response.usage?.steps).toBe(3);
    expect(response.answer).toMatch(/ran out of tool steps/);
  });
});
