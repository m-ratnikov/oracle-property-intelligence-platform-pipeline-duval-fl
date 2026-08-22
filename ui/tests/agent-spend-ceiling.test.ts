/**
 * What a stranger can spend on the public agent route.
 *
 * The route is unauthenticated on purpose and stays that way, so the only
 * defence is arithmetic: bound what one request costs, bound how many requests
 * the deployment will pay for, and make both numbers legible. Each of those is
 * a test here rather than a paragraph in a README, because the failure mode is
 * a bill rather than a broken page and nobody notices a broken bill in review.
 *
 * The load bearing cases:
 *
 *   1. The global budget is GLOBAL, not per address. The old per address limit
 *      capped nothing at all against anyone holding more than one address, and
 *      that is the hole these tests exist to keep shut.
 *   2. A billed server credential with no declared provider side cap is the
 *      exact configuration that was flagged, so it must clamp on its own with
 *      nobody remembering to set anything.
 *   3. An environment variable may TIGHTEN a per request cap and may never
 *      widen it, because those caps are the unit cost the global budget is
 *      priced against.
 *   4. The per request caps in this module must not drift away from the ones
 *      run.ts actually applies, or the whole worst case calculation is fiction.
 *   5. Tripping a ceiling reads as a spending cap, not as a broken page, and
 *      still names the two ways to keep going.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GlobalBudget,
  RateLimiter,
  boundTranscript,
  spendCeilingSettings,
  agentBudget,
  resetAgentBudget,
  HARD_MAX_TOOL_STEPS,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS_PER_STEP,
  MAX_TOOL_STEPS,
  MAX_TRANSCRIPT_CHARS,
} from "@/lib/agent/ratelimit";
import { MAX_STEPS } from "@/lib/agent/run";
import type { AgentResponse } from "@/lib/agent/types";

const RUN_SOURCE = join(process.cwd(), "lib", "agent", "run.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  resetAgentBudget();
  // Several cases below re-import the module graph to observe a constant that
  // is read at import time. Resetting here keeps a poisoned registry from
  // leaking into the next case, which otherwise fails on a stale singleton
  // rather than on anything real.
  vi.resetModules();
});

/**
 * Load the route and the module holding its budget FROM THE SAME REGISTRY.
 *
 * The per request caps are module level constants read from the environment at
 * import, so exercising them means re-importing. That makes module identity
 * load bearing: a statically imported `agentBudget` and the one the freshly
 * imported route closes over are different singletons, and draining one proves
 * nothing about the other.
 */
async function loadRoute() {
  vi.resetModules();
  const [route, ratelimit] = await Promise.all([
    import("@/app/api/agent/route"),
    import("@/lib/agent/ratelimit"),
  ]);
  ratelimit.resetAgentBudget();
  return { ...route, ...ratelimit };
}

describe("the global budget bounds every keyless caller together", () => {
  const options = { globalLimit: 12, assumedInstances: 4, windowMs: 60_000 };

  it("enforces this instance's share of the declared ceiling, not the whole of it", () => {
    const budget = new GlobalBudget({ ...options, now: () => 1_000 });
    // 12 declared across 4 assumed instances, so this one answers 3.
    expect(budget.perInstanceLimit).toBe(3);

    expect(budget.check().allowed).toBe(true);
    expect(budget.check().allowed).toBe(true);
    const last = budget.check();
    expect(last.allowed).toBe(true);
    expect(last.remainingOnThisInstance).toBe(0);

    const refused = budget.check();
    expect(refused.allowed).toBe(false);
    expect(refused.globalLimit).toBe(12);
    expect(refused.perInstanceLimit).toBe(3);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is one bucket for everyone, so a caller with many addresses gains nothing", () => {
    // The distinction this whole change turns on. The per address limiter hands
    // out a fresh allowance for every source address; the budget does not.
    const perAddress = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => 1_000 });
    for (let i = 0; i < 50; i += 1) {
      expect(perAddress.check(`10.0.0.${i}`).allowed).toBe(true);
    }

    const budget = new GlobalBudget({ globalLimit: 4, assumedInstances: 1, windowMs: 60_000, now: () => 1_000 });
    const allowed = Array.from({ length: 50 }, () => budget.check().allowed).filter(Boolean);
    expect(allowed).toHaveLength(4);
  });

  it("rolls over when the window elapses", () => {
    let now = 1_000;
    const budget = new GlobalBudget({ globalLimit: 1, assumedInstances: 1, windowMs: 60_000, now: () => now });
    expect(budget.check().allowed).toBe(true);
    expect(budget.check().allowed).toBe(false);

    now += 60_001;
    expect(budget.check().allowed).toBe(true);
  });

  it("peek reports without spending, so the capability probe is free", () => {
    const budget = new GlobalBudget({ globalLimit: 4, assumedInstances: 1, windowMs: 60_000, now: () => 1_000 });
    budget.check();
    for (let i = 0; i < 10; i += 1) budget.peek();
    expect(budget.peek().usedOnThisInstance).toBe(1);
    expect(budget.peek().remainingOnThisInstance).toBe(3);
  });
});

describe("a billed server credential clamps itself", () => {
  it("clamps when a paid key has no declared provider side cap", () => {
    // The flagged configuration exactly: a paid OpenAI key behind a public route.
    const settings = spendCeilingSettings({ OPENAI_API_KEY: "sk-not-a-real-key", AGENT_PROVIDER: "openai" });

    expect(settings.serverCredentialIsBilled).toBe(true);
    expect(settings.clamped).toBe(true);
    expect(settings.globalLimit).toBe(100);
    expect(settings.basis).toContain("AGENT_SPEND_CEILING_USD");
  });

  it("clamps even when the environment asks for a larger ceiling", () => {
    const settings = spendCeilingSettings({
      OPENAI_API_KEY: "sk-not-a-real-key",
      AGENT_PROVIDER: "openai",
      AGENT_GLOBAL_LIMIT: "100000",
    });
    expect(settings.globalLimit).toBe(100);
    expect(settings.clamped).toBe(true);
  });

  it("honours the configured ceiling once a provider side cap is declared", () => {
    const settings = spendCeilingSettings({
      OPENAI_API_KEY: "sk-not-a-real-key",
      AGENT_PROVIDER: "openai",
      AGENT_SPEND_CEILING_USD: "25",
      AGENT_GLOBAL_LIMIT: "500",
    });
    expect(settings.clamped).toBe(false);
    expect(settings.globalLimit).toBe(500);
    expect(settings.declaredCeilingUsd).toBe(25);
    expect(settings.basis).toContain("25 USD");
  });

  it("does not clamp a credential the registry lists as free of charge", () => {
    const settings = spendCeilingSettings({
      OPENROUTER_API_KEY: "sk-or-v1-not-a-real-key",
      AGENT_PROVIDER: "openrouter",
    });
    expect(settings.serverCredentialIsBilled).toBe(false);
    expect(settings.clamped).toBe(false);
    expect(settings.globalLimit).toBe(200);
  });

  it("says so plainly when there is no server credential to spend", () => {
    const settings = spendCeilingSettings({});
    expect(settings.serverCredentialIsBilled).toBe(false);
    expect(settings.basis).toContain("No server credential is configured");
  });

  it("divides the ceiling by the assumed instance count", () => {
    const settings = spendCeilingSettings({ AGENT_GLOBAL_LIMIT: "200", AGENT_ASSUMED_INSTANCES: "8" });
    expect(settings.perInstanceLimit).toBe(25);
  });
});

describe("per request caps can be tightened by environment and never widened", () => {
  it("ships below the loop's own ceiling", () => {
    expect(MAX_TOOL_STEPS).toBeLessThan(HARD_MAX_TOOL_STEPS);
  });

  it("refuses an environment variable that asks for more steps than the code guarantees", async () => {
    vi.stubEnv("AGENT_MAX_STEPS", "999");
    vi.resetModules();
    const reloaded = await import("@/lib/agent/ratelimit");
    expect(reloaded.MAX_TOOL_STEPS).toBe(HARD_MAX_TOOL_STEPS);
    vi.resetModules();
  });

  it("accepts an environment variable that asks for fewer", async () => {
    vi.stubEnv("AGENT_MAX_STEPS", "3");
    vi.resetModules();
    const reloaded = await import("@/lib/agent/ratelimit");
    expect(reloaded.MAX_TOOL_STEPS).toBe(3);
    vi.resetModules();
  });

  it("refuses an environment variable that asks for a larger transcript", async () => {
    vi.stubEnv("AGENT_MAX_TRANSCRIPT_CHARS", "10000000");
    vi.resetModules();
    const reloaded = await import("@/lib/agent/ratelimit");
    expect(reloaded.MAX_TRANSCRIPT_CHARS).toBe(24_000);
    vi.resetModules();
  });
});

describe("the transcript a caller controls is bounded", () => {
  it("drops the oldest turns to fit the budget", () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${i}`.padEnd(MAX_MESSAGE_CHARS, "x"),
    }));

    const bounded = boundTranscript(messages);
    const chars = bounded.reduce((total, message) => total + message.content.length, 0);

    expect(chars).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    // 12 messages at 8,000 characters is 96,000 characters resent on every step
    // of the loop. That was the largest free input lever a caller had.
    expect(bounded.length).toBeLessThan(messages.length);
    // The newest turns are the ones kept.
    expect(bounded[bounded.length - 1].content.startsWith("11")).toBe(true);
  });

  it("truncates a single oversized message rather than dropping the question", () => {
    const bounded = boundTranscript([{ role: "user", content: "q".repeat(500_000) }]);
    expect(bounded).toHaveLength(1);
    expect(bounded[0].content).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("leaves a normal conversation untouched", () => {
    const messages = [
      { role: "user" as const, content: "How many properties have a homestead exemption?" },
      { role: "assistant" as const, content: "12,345 of them." },
      { role: "user" as const, content: "And in the 32209 zip?" },
    ];
    expect(boundTranscript(messages)).toEqual(messages);
  });
});

describe("the per request caps match the ones run.ts actually applies", () => {
  // These constants are duplicated in ratelimit.ts on purpose: the credential
  // test route imports that module and must not drag DuckDB and the tool layer
  // in behind it. Duplication is only safe with a test that notices drift, and
  // drift here would not break anything visible, it would just quietly make the
  // published worst case wrong.
  it("agrees with run.ts on the hard step ceiling", () => {
    expect(HARD_MAX_TOOL_STEPS).toBe(MAX_STEPS);
  });

  it("agrees with run.ts on the per step output token cap", () => {
    const source = readFileSync(RUN_SOURCE, "utf8");
    const match = source.match(/maxOutputTokens:\s*([\d_]+)/);
    expect(match, "run.ts no longer sets maxOutputTokens on the agent").not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBe(MAX_OUTPUT_TOKENS_PER_STEP);
  });
});

describe("a reviewer who trips the ceiling sees a spending cap, not a failure", () => {
  /**
   * Drives the real route handler. The budget is drained first, so the request
   * is refused before anything reaches a provider: the assertion is about what
   * a reader sees, and it must not depend on a network call to make it.
   */
  async function postOnDrainedBudget() {
    vi.stubEnv("AGENT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-not-a-real-key");
    vi.stubEnv("AGENT_GLOBAL_LIMIT", "1");
    vi.stubEnv("AGENT_ASSUMED_INSTANCES", "1");

    const { POST, agentBudget: loadedBudget } = await loadRoute();

    const budget = loadedBudget();
    expect(budget.check().allowed).toBe(true);
    expect(budget.check().allowed).toBe(false);

    const response = await POST(
      new Request("https://example.test/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ messages: [{ role: "user", content: "How many parcels are there?" }] }),
      }),
    );
    return { response, payload: (await response.json()) as AgentResponse };
  }

  it("answers 429 with a typed body and a Retry-After", async () => {
    const { response, payload } = await postOnDrainedBudget();

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(payload.status).toBe("error");
    // The contract the chat page renders, so a tripped ceiling is a message in
    // the conversation rather than an unhandled fetch failure.
    expect(payload.evidence).toEqual([]);
    expect(payload.toolCalls).toEqual([]);
  });

  it("says what the cap is and what still works", async () => {
    const { payload } = await postOnDrainedBudget();

    expect(payload.message).toContain("spending cap");
    expect(payload.message).toMatch(/1 questions? per 24 hours/);
    expect(payload.hint).toContain("Questions page");
    expect(payload.hint).toContain("your own credential");
    // No reader should be able to read this as data loss or an outage.
    expect(payload.hint).toContain("Nothing is broken");
  });
});

describe("GET reports the ceiling honestly", () => {
  it("publishes every enforced number and admits where it is an approximation", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-a-real-key");

    const { GET } = await loadRoute();
    const response = await GET(new Request("https://example.test/api/agent"));
    const payload = (await response.json()) as {
      spend_ceiling: {
        per_request: Record<string, unknown>;
        global: Record<string, unknown>;
        provider_side: Record<string, unknown>;
        basis: string;
      };
      rate_limit: { note: string };
    };

    expect(payload.spend_ceiling.per_request.max_tool_steps).toBe(MAX_TOOL_STEPS);
    expect(payload.spend_ceiling.per_request.max_output_tokens_per_request).toBe(
      MAX_TOOL_STEPS * MAX_OUTPUT_TOKENS_PER_STEP,
    );
    expect(payload.spend_ceiling.global.declared_limit).toBe(100);
    expect(payload.spend_ceiling.provider_side.server_credential_is_billed).toBe(true);
    expect(payload.spend_ceiling.provider_side.clamped).toBe(true);

    // The honesty this change had to preserve: the in process, per instance
    // caveat was already there and must survive, on both counters.
    expect(String(payload.spend_ceiling.global.enforcement)).toContain("per instance");
    expect(payload.rate_limit.note).toContain("per instance");
    expect(String(payload.spend_ceiling.provider_side.note)).toContain("instance churn cannot reset");
  });

  it("never spends the budget it reports", async () => {
    vi.stubEnv("AGENT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-not-a-real-key");

    const { GET, agentBudget: loadedBudget } = await loadRoute();
    for (let i = 0; i < 5; i += 1) await GET(new Request("https://example.test/api/agent"));

    expect(loadedBudget().peek().usedOnThisInstance).toBe(0);
  });
});
