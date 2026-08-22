/**
 * The contract between /api/agent and the chat page.
 *
 * This extends the shape the original stub published (status, message,
 * toolCalls, evidence, assumptions, hint) without breaking it: every field the
 * stub had is still here with the same meaning, and the fields the agent
 * brief asks for (answer, tool_calls, data_freshness, model, usage) sit next to
 * them. `message` and `answer` always carry the same markdown; `toolCalls` and
 * `tool_calls` are the same array. Readers can use either spelling.
 */

import type { CountClaim, CountShape } from "./totals";

export interface AgentToolCall {
  name: string;
  input: Record<string, unknown>;
  /** One line the transcript panel shows next to the tool name. */
  summary?: string;
  /** Same text as summary, under the name the agent brief uses. */
  output_summary: string;
  /** Wall clock time the tool took, in milliseconds. */
  elapsed_ms: number;
  /** Rows the tool returned, when that is meaningful. */
  row_count: number | null;
  /** Total rows that matched before the limit was applied, when known. */
  total_matched?: number | null;
  /**
   * What the tool's predicate actually was. A count over a disjunction or a score is not a count of
   * rows meeting every criterion, and the transcript says which it was next to the number.
   */
  count_shape?: CountShape;
  /** Set when the tool returned an error message instead of data. */
  error?: string;
  /** Kept for the original stub's consumers; a compact view of the output. */
  result?: Record<string, unknown>;
}

export interface AgentEvidenceRow {
  property_id: string;
  address?: string | null;
  source_system?: string | null;
  source_url?: string | null;
  fetched_at?: string | null;
  /** Which tool produced the row. */
  via?: string;
  /** The matched columns and their values, kept as published. */
  [key: string]: unknown;
}

export interface AgentDataFreshness {
  run_id: string | null;
  finished_at: string | null;
  /** Where the run history came from, so the badge can link to it. */
  source_url?: string | null;
  /** True when the run history is the synthetic sample file. */
  is_sample?: boolean;
}

export interface AgentUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Model round trips inside the tool loop. */
  steps: number;
}

export interface AgentResponse {
  status: "ok" | "not_implemented" | "error";
  /** The assistant's prose answer, markdown. Same as `answer`. */
  message: string;
  /** The assistant's prose answer, markdown. Same as `message`. */
  answer: string;
  /** Tool calls in order. Same array as `tool_calls`. */
  toolCalls: AgentToolCall[];
  /** Tool calls in order. Same array as `toolCalls`. */
  tool_calls: AgentToolCall[];
  /** Rows the answer rests on. */
  evidence: AgentEvidenceRow[];
  /** What the agent or the rules could not determine from the published data. */
  assumptions: string[];
  /**
   * Every count the answer cites, with the exact statement that produced each one and whether that
   * statement was a conjunction. The answer's own "Counts in this answer" table is rendered from
   * this, so a total on the page always arrives attached to its predicate.
   */
  totals: CountClaim[];
  /**
   * Numbers the model wrote as population counts that no tool produced this turn. They were removed
   * from the answer text rather than shown, and are kept here so the removal is auditable.
   */
  unverified_totals: string[];
  data_freshness: AgentDataFreshness | null;
  model: string | null;
  usage: AgentUsage | null;
  /** Wall clock time for the whole request, in milliseconds. */
  elapsed_ms?: number;
  hint?: string;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRequestBody {
  messages: AgentChatMessage[];
}

export const NOT_CONFIGURED_MESSAGE =
  "agent not configured: no model credential is set on the server, and no key was sent in the x-llm-api-key header";

export function emptyResponse(
  status: AgentResponse["status"],
  message: string,
  hint?: string,
): AgentResponse {
  return {
    status,
    message,
    answer: message,
    toolCalls: [],
    tool_calls: [],
    evidence: [],
    assumptions: [],
    totals: [],
    unverified_totals: [],
    data_freshness: null,
    model: null,
    usage: null,
    hint,
  };
}

/** Environment shape the agent reads; a plain record so tests can pass partial envs. */
export type Env = Record<string, string | undefined>;
