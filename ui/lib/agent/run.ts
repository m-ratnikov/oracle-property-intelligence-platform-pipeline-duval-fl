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
import { createAgentTools, newTrace, type AgentProgress } from "./tools";
import { formatCountLedger, verifyAnswerTotals } from "./totals";
import { logAgent } from "./log";
import type { AgentChatMessage, AgentResponse, AgentUsage } from "./types";

export { TOOL_ORDER } from "./toolOrder";
import { TOOL_ORDER } from "./toolOrder";

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
  /** Model picked from the dropdown by a caller with no key of their own. */
  modelChoice?: string | null;
  env?: Env;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  /** Called as the turn progresses, for a caller that is streaming the wait to a reader. */
  onProgress?: (event: AgentProgress) => void;
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

  const progress = options.onProgress;
  // The first wait a reader sees is this one: on a cold instance it downloads the published parquet.
  progress?.({ id: "open", phase: "started", label: "Opening the published query table" });
  const [resolved, db] = await Promise.all([
    options.model ? Promise.resolve(options.model) : resolveModel(env, options.credential, options.modelChoice),
    options.db ? Promise.resolve(options.db) : getPropertyDb(),
  ]);
  progress?.({
    id: "open",
    phase: "finished",
    label: "Opened the published query table",
    elapsed_ms: Date.now() - started,
  });

  const trace = newTrace(progress);
  const tools = createAgentTools({ db, env, fetchImpl: options.fetchImpl }, trace);

  const agent = new ToolLoopAgent({
    id: "duval-property-intelligence",
    model: resolved.model,
    instructions: resolved.instructions(SYSTEM_PROMPT),
    tools,
    // Stable tool order keeps the cached prefix identical across turns.
    // count_criteria is appended rather than slotted in beside run_sql: the cached prompt prefix is
    // the tool list in order, so adding a tool at the end leaves every earlier schema byte for byte
    // where it was and the cache keeps hitting.
    toolOrder: [...TOOL_ORDER],
    stopWhen: stepCountIs(options.maxSteps ?? MAX_STEPS),
    // Halved from 4096, which was the larger half of the worst case spend on a public route.
    //
    // Chosen against measurements, not a guess. A deployed prompt A answer renders 4,056 characters
    // of markdown. The largest answer the system prompt permits (eight example rows, sixteen
    // evidence columns, the full assumptions section) is 5,536 characters, and a markdown table of
    // dates and numbers tokenises near three characters per token, so that worst case is about
    // 1,845 tokens. 1,500 would clip it about a fifth of the way through the evidence table, and a
    // total truncated mid table is exactly the failure this file's totals gate exists to prevent.
    // 2,048 clears the measured worst case with headroom and still halves the ceiling. The "Counts
    // in this answer" table is appended below by the totals gate, server side, so it costs no model
    // output tokens and does not press on this number.
    maxOutputTokens: 2048,
    temperature: 0.2,
  });

  // The provider call is the one place a caller's key can come back at us,
  // because several providers quote the offending credential in the body of a
  // 401. Redact first, classify second, and never let the raw error escape.
  const secrets = [options.credential?.apiKey];
  let result;
  try {
    progress?.({ id: "model", phase: "started", label: `Asking ${resolved.modelId} to plan the query` });
    result = await agent.generate({ messages: modelMessages, abortSignal: options.abortSignal });
    // elapsed here is the whole turn so far, which is what a waiting reader wants to see
    progress?.({ id: "model", phase: "finished", label: "Answer written", elapsed_ms: Date.now() - started });
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

  // The totals gate. Everything above this line is the model's; everything a reader sees is
  // checked against what the tools returned first.
  //
  // This is the structural half of the source-backed claim. The system prompt can ask the model to
  // report only computed totals, and it mostly will, but "mostly" is not a property anyone can
  // verify. Here a numeral presented as a population count is either backed by a number a tool
  // returned this turn, in which case it stands and its query is listed underneath, or it is not,
  // in which case it is deleted from the text. The failure mode is a visible hole in the answer,
  // never a confident wrong number, and that trade is the whole point.
  const verified = verifyAnswerTotals(answer, trace.counts, trace.seen);
  answer = verified.answer;
  const ledger = formatCountLedger(verified.cited, verified.unverified);
  if (ledger) answer = `${answer.trimEnd()}\n\n${ledger}`;
  if (verified.unverified.length > 0) {
    logAgent("warn", "removed uncomputed totals from answer", {
      removed: verified.unverified,
      computed_counts: trace.counts.map((claim) => claim.value),
    });
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

  // Which model actually answered, which is not always the one that was asked
  // for: OpenRouter reroutes a busy free model to the next in the fallback list
  // and reports what it used. Claiming the requested id would be a small lie on
  // the one line a visitor reads to know what produced the answer.
  const servedModelId = result.steps[result.steps.length - 1]?.response?.modelId?.trim() || resolved.modelId;

  const usage = toUsage(result.totalUsage, result.steps.length);
  const response: AgentResponse = {
    status: "ok",
    message: answer,
    answer,
    toolCalls: trace.calls,
    tool_calls: trace.calls,
    evidence: trace.evidence,
    assumptions: trace.assumptions,
    totals: verified.cited,
    unverified_totals: verified.unverified,
    data_freshness: freshness,
    model: `${resolved.provider}:${servedModelId}`,
    usage,
    elapsed_ms: Date.now() - started,
  };

  logAgent("info", "agent turn", {
    provider: resolved.provider,
    model: servedModelId,
    requested_model: resolved.modelId,
    credential_source: resolved.source,
    // A fingerprint, not the key. See redact.ts for why this is not a prefix.
    key: keyFingerprint(options.credential?.apiKey),
    steps: result.steps.length,
    tool_calls: trace.calls.length,
    evidence_rows: trace.evidence.length,
    computed_counts: trace.counts.length,
    unverified_totals: verified.unverified.length,
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
