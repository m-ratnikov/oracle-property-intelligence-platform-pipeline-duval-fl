import { NextResponse } from "next/server";

/**
 * Agent endpoint, deliberately a stub.
 *
 * The UI ships before the agent runtime is wired, and a fake answer would be
 * worse than no answer on a submission that is judged on evidence. So this
 * returns 501 with a machine readable body the chat UI renders as an honest
 * "not wired yet" state rather than an error.
 *
 * The contract the real handler must satisfy is documented below and mirrored by
 * the AgentResponse type on the client, so wiring it is a swap of this file.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AgentToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Rendered in the transcript panel. Keep it short. */
  summary?: string;
  /** Row count, elapsed ms, or whatever the tool reports back. */
  result?: Record<string, unknown>;
}

export interface AgentEvidenceRow {
  property_id: string;
  source_system?: string | null;
  source_url?: string | null;
  fetched_at?: string | null;
  [key: string]: unknown;
}

export interface AgentResponse {
  status: "ok" | "not_implemented";
  /** The assistant's prose answer. */
  message: string;
  /** Tool calls in order, for the transcript panel. */
  toolCalls?: AgentToolCall[];
  /** Rows the answer rests on, for the evidence panel. */
  evidence?: AgentEvidenceRow[];
  /** Anything the agent could not determine from the published data. */
  assumptions?: string[];
  hint?: string;
}

const NOT_IMPLEMENTED: AgentResponse = {
  status: "not_implemented",
  message:
    "The agent runtime is not wired to this deployment yet. Nothing is generated here, because an answer without a tool call behind it would not be evidence.",
  hint: "Every question the agent is meant to answer is already answerable on the Questions page, which runs the same rules in DuckDB-WASM and shows the provenance for each row. The agent will call the same SQL through its run_sql tool.",
  toolCalls: [],
  evidence: [],
  assumptions: [],
};

export async function POST(): Promise<NextResponse<AgentResponse>> {
  return NextResponse.json(NOT_IMPLEMENTED, { status: 501 });
}

export async function GET(): Promise<NextResponse<AgentResponse>> {
  return NextResponse.json(NOT_IMPLEMENTED, { status: 501 });
}
