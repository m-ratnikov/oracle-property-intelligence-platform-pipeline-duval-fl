/**
 * How many tokens one answer actually costs, and whether that still fits the
 * free tiers of the providers the model registry lists.
 *
 * This exists because a free tier is not a yes or no property. Groq publishes
 * a free tier for `openai/gpt-oss-120b` that looks generous until you notice
 * the 8,000 tokens per minute ceiling, and this agent sends more than that in a
 * single request by its third step: the system prompt and five tool schemas are
 * resent every step, and the tool results accumulate on top. The free Groq tier
 * therefore cannot finish most questions here, which is stated in the registry
 * rather than discovered by a visitor.
 *
 * The numbers below are measured from a real ToolLoopAgent run against a real
 * DuckDB with the model mocked, so they move when the system prompt or the tool
 * schemas move, and also when the PUBLISHED TABLE GETS WIDER: `get_schema`
 * describes every column of the view, and that result is resent on every step.
 * If someone doubles the system prompt, or the pipeline publishes forty more
 * columns, this test fails and the registry notes get revisited, instead of the
 * free tier claims quietly becoming wrong.
 *
 * Token counts are characters / 4, the usual rough conversion. That is not
 * exact for any specific tokenizer and does not need to be: the thresholds here
 * are order of magnitude guards, not billing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { runAgent } from "@/lib/agent/run";

/** Characters per token, the standard rough conversion. */
const CHARS_PER_TOKEN = 4;

/**
 * The largest single request a typical answer sends. Anything above this and
 * the Groq free tier claim is not the only one that needs rewriting, so the
 * ceiling is deliberately close to the measured value.
 *
 * Raised from 12,000 when the sample parquet was widened from 88 columns to the
 * 131 the pipeline actually publishes. Nothing about the agent changed: the
 * narrower sample had been under reporting what this loop costs against the
 * published artifact, and `get_schema` describes 43 more columns on every step.
 *
 * Raised again from 15,000 to 17,000 when the totals gate landed. The measured
 * largest request went from 13,693 to 15,209 tokens, a 1,516 token rise made of
 * four things, all of them meaning rather than padding: the sixth tool
 * (`count_criteria`), whose schema is resent on every step and is what makes a
 * scored question answerable without inventing a total; the "Totals" section of
 * the system prompt, which states the rule the gate enforces so the model can
 * comply instead of being corrected; the count semantics fields on the run_sql
 * and preset_question descriptions; and the corrected roof and tenure figures,
 * which replaced "most or all rows" with the measured counts and cost words to
 * gain accuracy. The ceiling is set at 17,000 rather
 * than just above the measurement so it keeps its job, which is to fail when
 * something grows by an order of magnitude and the free tier notes in the
 * registry need rewriting, not to fail on the next honest sentence.
 */
const MAX_SINGLE_REQUEST_TOKENS = 17_000;

/** The free tier ceiling this agent is already known to exceed. */
const GROQ_FREE_TOKENS_PER_MINUTE = 8_000;

let db: PropertyDb;

beforeAll(async () => {
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
});

afterAll(async () => {
  await db.close();
});

/** Run a realistic three step answer and return the size of each request. */
async function measureSteps(): Promise<number[]> {
  const calls: LanguageModelV3CallOptions[] = [];
  const script: Array<{ toolName: string; input: unknown } | { text: string }> = [
    { toolName: "get_schema", input: {} },
    { toolName: "preset_question", input: { name: "roof15_and_no_sale10y", limit: 25 } },
    { text: "Here are the matched parcels and the rule applied." },
  ];
  let step = 0;

  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };

  const model = new MockLanguageModelV3({
    modelId: "budget-probe",
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

  await runAgent({
    messages: [
      {
        role: "user",
        content:
          "Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?",
      },
    ],
    model: {
      provider: "openrouter",
      modelId: "budget-probe",
      source: "user",
      model,
      instructions: (system) => ({ role: "system", content: system }),
    },
    db,
    env: {},
  });

  return calls.map((call) => {
    const promptChars = JSON.stringify(call.prompt).length;
    const toolChars = JSON.stringify(call.tools ?? []).length;
    return Math.round((promptChars + toolChars) / CHARS_PER_TOKEN);
  });
}

describe("prompt budget", () => {
  it("resends the system prompt and all five tool schemas on every step", async () => {
    const steps = await measureSteps();
    expect(steps.length).toBeGreaterThanOrEqual(3);
    // Each step is strictly larger than the last: the tool results accumulate.
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]).toBeGreaterThan(steps[index - 1]);
    }
  });

  it("sends more in one mid conversation request than the Groq free tier allows in a minute", async () => {
    // Not a wish, a measurement. This is the evidence behind the Groq entry in
    // the registry saying its free tier cannot finish most questions here.
    const steps = await measureSteps();
    const largest = Math.max(...steps);
    expect(largest).toBeGreaterThan(GROQ_FREE_TOKENS_PER_MINUTE);
  });

  it("keeps the largest single request inside a sane ceiling", async () => {
    // The guard that matters going forward: if the system prompt or the tool
    // schemas grow, more free tiers stop working and the registry notes need
    // rewriting. Failing here is the prompt to do that.
    const steps = await measureSteps();
    expect(Math.max(...steps)).toBeLessThan(MAX_SINGLE_REQUEST_TOKENS);
  });
});
