import { NextResponse } from "next/server";
import { z } from "zod";
import { generateText, stepCountIs, tool } from "ai";
import { resolveModel } from "@/lib/agent/model";
import { readUserCredential } from "@/lib/agent/credentials";
import {
  classifyProviderError,
  isAgentError,
  providerSpecificHint,
  AgentBadRequestError,
} from "@/lib/agent/errors";
import { TEST_RATE_LIMIT, clientAddress } from "@/lib/agent/ratelimit";
import { safeMessage } from "@/lib/agent/redact";
import { logAgent } from "@/lib/agent/log";

/**
 * Credential test: does this key actually work, before the visitor spends a
 * 90 second question finding out that it does not.
 *
 * This makes a real call to the real provider with the real key. A syntax
 * check on the key would be theatre: the failure modes that matter are a
 * revoked key, a key for the wrong provider, a model the account cannot reach,
 * and a region or billing block, and none of those are visible from the string.
 *
 * It also checks something the registry cannot promise: whether the model will
 * actually emit a tool call. This agent is a five tool loop and is useless with
 * a model that will not call tools, so the response reports `tool_calling` as a
 * separate signal from `ok`. A key that authenticates but cannot drive tools is
 * a green credential and a bad choice, and the UI says both.
 *
 * The key is used to build one client, then dropped. It is never stored and
 * never logged, and every error string leaving here is redacted first.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single short completion. Well inside the default, but a cold provider
// connection plus a slow free tier queue can still take a while.
export const maxDuration = 60;

interface TestResult {
  ok: boolean;
  provider: string | null;
  model: string | null;
  /** True when the model emitted a tool call for the probe tool. */
  tool_calling: boolean;
  elapsed_ms: number;
  /** Set when ok is false. Redacted, never contains key material. */
  error?: string;
  error_kind?: string;
  hint?: string;
}

const PROBE_PROMPT =
  "Call the health_check tool exactly once with ok set to true. Then reply with the single word: ready.";

export async function POST(request: Request): Promise<NextResponse<TestResult>> {
  const started = Date.now();

  const decision = TEST_RATE_LIMIT.check(clientAddress(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      {
        ok: false,
        provider: null,
        model: null,
        tool_calling: false,
        elapsed_ms: Date.now() - started,
        error: `Too many credential tests from this address: the limit is ${decision.limit} per minute.`,
        error_kind: "AgentRateLimitError",
        hint: "An unlimited test endpoint is a way to validate stolen keys at someone else's expense, so it is capped harder than the agent itself. Wait a minute.",
      },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
    );
  }

  let credential;
  try {
    credential = readUserCredential(request.headers);
  } catch (error: unknown) {
    const message = error instanceof AgentBadRequestError ? error.message : "credential headers rejected";
    return NextResponse.json(
      {
        ok: false,
        provider: null,
        model: null,
        tool_calling: false,
        elapsed_ms: Date.now() - started,
        error: message,
        error_kind: "AgentBadRequestError",
      },
      { status: 400 },
    );
  }

  if (!credential) {
    return NextResponse.json(
      {
        ok: false,
        provider: null,
        model: null,
        tool_calling: false,
        elapsed_ms: Date.now() - started,
        error: "Send a key to test: x-llm-api-key, x-llm-provider and x-llm-model.",
        error_kind: "AgentBadRequestError",
        hint: "There is nothing to test without a credential. GET /api/agent lists the supported providers and models.",
      },
      { status: 400 },
    );
  }

  const secrets = [credential.apiKey];

  try {
    const resolved = await resolveModel(process.env, credential);
    const result = await generateText({
      model: resolved.model,
      system: "You are a connectivity probe. Follow the instruction exactly and keep every reply under five words.",
      prompt: PROBE_PROMPT,
      tools: {
        health_check: tool({
          description: "Confirms the model can call a tool. Call it once, with ok true.",
          inputSchema: z.object({ ok: z.boolean().describe("always true") }),
          execute: async () => ({ status: "ok" }),
        }),
      },
      // One round trip to call the tool, one to answer. No further looping.
      stopWhen: stepCountIs(2),
      maxOutputTokens: 64,
      abortSignal: request.signal,
    });

    const toolCalling = result.steps.some((step) => step.toolCalls.length > 0);

    logAgent("info", "credential test", {
      provider: credential.provider,
      model: credential.modelId,
      ok: true,
      tool_calling: toolCalling,
      elapsed_ms: Date.now() - started,
    });

    return NextResponse.json({
      ok: true,
      provider: credential.provider,
      model: credential.modelId,
      tool_calling: toolCalling,
      elapsed_ms: Date.now() - started,
      hint: toolCalling
        ? undefined
        : "The key works, but this model did not call the probe tool. The property agent is a five tool loop, so it will most likely answer without looking at any data. Pick a model that supports tool calling.",
    });
  } catch (error: unknown) {
    const safe = safeMessage(error, secrets);
    const typed = isAgentError(error) ? error : classifyProviderError(error, safe, "user");

    logAgent("warn", "credential test failed", {
      provider: credential.provider,
      model: credential.modelId,
      error_name: typed.name,
      // Redacted above. Safe to keep for diagnosing a provider outage.
      error: typed.message,
      elapsed_ms: Date.now() - started,
    });

    return NextResponse.json(
      {
        ok: false,
        provider: credential.provider,
        model: credential.modelId,
        tool_calling: false,
        elapsed_ms: Date.now() - started,
        error: typed.message,
        error_kind: typed.name,
        hint:
          providerSpecificHint(typed.message) ??
          (typed.name === "AgentCredentialError"
            ? "The provider rejected this credential. Check that the key belongs to the provider you selected and has not been revoked."
            : "The provider was reached but the call failed. The model id may not be enabled on this account."),
      },
      { status: typed.status },
    );
  }
}
