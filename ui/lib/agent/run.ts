/**
 * The agent turn: one ToolLoopAgent over the five tools, with the transcript
 * and evidence lifted out of the tool trace into the AgentResponse contract.
 *
 * The model is injectable so the loop can be tested with `ai/test` mocks, and
 * the database is injectable so tests run against the sample parquet without
 * touching the process wide cache.
 */

import type { Env } from "./types";
import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";
import { getPropertyDb, type PropertyDb } from "./db";
import { loadRunHistory } from "./artifacts";
import { resolveModel, type ResolvedModel } from "./model";
import type { UserCredential } from "./credentials";
import { classifyProviderError } from "./errors";
import { keyFingerprint, safeMessage } from "./redact";
import { SYSTEM_PROMPT } from "./prompt";
import { createAgentTools, newTrace } from "./tools";
import { logAgent } from "./log";
import type { AgentChatMessage, AgentResponse, AgentUsage } from "./types";

export const MAX_STEPS = 12;
export const MAX_HISTORY_MESSAGES = 12;

export interface RunAgentOptions {
  messages: AgentChatMessage[];
  /** Injected for tests; resolved from env otherwise. */
  model?: ResolvedModel;
  /** Injected for tests; the cached process wide database otherwise. */
  db?: PropertyDb;
  /**
   * The visitor's own credential for this one request. Beats the server
   * environment when present, and is dropped when the turn ends: nothing here
   * writes it anywhere, and every error path that could quote it is redacted.
   */
  credential?: UserCredential | null;
  env?: Env;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

export function toModelMessages(messages: AgentChatMessage[]): ModelMessage[] {
  const trimmed = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  // The conversation has to end with the user's turn; drop a dangling assistant message.
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].role !== "user") trimmed.pop();
  return trimmed.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : { role: "assistant", content: message.content },
  );
}

function toUsage(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  },
  steps: number,
): AgentUsage {
  return {
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
    cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    steps,
  };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResponse> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const modelMessages = toModelMessages(options.messages);
  if (modelMessages.length === 0) {
    throw new Error("messages must contain at least one user message");
  }

  const [resolved, db] = await Promise.all([
    options.model ? Promise.resolve(options.model) : resolveModel(env, options.credential),
    options.db ? Promise.resolve(options.db) : getPropertyDb(),
  ]);

  const trace = newTrace();
  const tools = createAgentTools({ db, env, fetchImpl: options.fetchImpl }, trace);

  const agent = new ToolLoopAgent({
    id: "duval-property-intelligence",
    model: resolved.model,
    instructions: resolved.instructions(SYSTEM_PROMPT),
    tools,
    // Stable tool order keeps the cached prefix identical across turns.
    toolOrder: ["get_schema", "preset_question", "run_sql", "get_property", "get_run_history"],
    stopWhen: stepCountIs(options.maxSteps ?? MAX_STEPS),
    maxOutputTokens: 4096,
    temperature: 0.2,
  });

  // The provider call is the one place a caller's key can come back at us,
  // because several providers quote the offending credential in the body of a
  // 401. Redact first, classify second, and never let the raw error escape.
  const secrets = [options.credential?.apiKey];
  let result;
  try {
    result = await agent.generate({ messages: modelMessages, abortSignal: options.abortSignal });
  } catch (error: unknown) {
    const safe = safeMessage(error, secrets);
    const typed = classifyProviderError(error, safe, resolved.source);
    logAgent("warn", "provider call failed", {
      provider: resolved.provider,
      model: resolved.modelId,
      credential_source: resolved.source,
      error_name: typed.name,
      // Already redacted. Logged so a real outage is diagnosable.
      error: safe,
    });
    throw typed;
  }

  let answer = result.text.trim();
  if (!answer) {
    answer =
      result.finishReason === "tool-calls"
        ? "I ran out of tool steps before writing an answer. The transcript and evidence panels show everything retrieved so far; ask a narrower question or ask me to continue."
        : "The model returned no text. The transcript shows the tool calls that were made.";
  }

  // Freshness: whatever get_run_history recorded, else a best effort read so
  // the badge is always populated.
  let freshness = trace.freshness;
  if (!freshness) {
    try {
      freshness = (await loadRunHistory(env, options.fetchImpl)).freshness;
    } catch (error) {
      logAgent("warn", "run history unavailable for freshness badge", { error: safeMessage(error, secrets) });
      freshness = null;
    }
  }

  const usage = toUsage(result.totalUsage, result.steps.length);
  const response: AgentResponse = {
    status: "ok",
    message: answer,
    answer,
    toolCalls: trace.calls,
    tool_calls: trace.calls,
    evidence: trace.evidence,
    assumptions: trace.assumptions,
    data_freshness: freshness,
    model: `${resolved.provider}:${resolved.modelId}`,
    usage,
    elapsed_ms: Date.now() - started,
  };

  logAgent("info", "agent turn", {
    provider: resolved.provider,
    model: resolved.modelId,
    credential_source: resolved.source,
    // A fingerprint, not the key. See redact.ts for why this is not a prefix.
    key: keyFingerprint(options.credential?.apiKey),
    steps: result.steps.length,
    tool_calls: trace.calls.length,
    evidence_rows: trace.evidence.length,
    finish_reason: result.finishReason,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    elapsed_ms: response.elapsed_ms,
    is_sample: db.isSample,
  });

  return response;
}
