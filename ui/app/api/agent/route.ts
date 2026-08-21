import { NextResponse } from "next/server";
import { isAgentConfigured, AgentNotConfiguredError, readProvider } from "@/lib/agent/model";
import { runAgent } from "@/lib/agent/run";
import { logAgent } from "@/lib/agent/log";
import {
  emptyResponse,
  NOT_CONFIGURED_MESSAGE,
  type AgentChatMessage,
  type AgentResponse,
} from "@/lib/agent/types";

/**
 * The agent endpoint.
 *
 * POST { messages: [{ role, content }] } runs one ToolLoopAgent turn (Vercel AI
 * SDK) over five read only tools backed by a server side DuckDB view over the
 * published parquet, and returns the AgentResponse contract the chat page
 * renders: markdown answer, tool call transcript, evidence rows, assumptions,
 * data freshness, model and token usage.
 *
 * Without ANTHROPIC_API_KEY (or AWS credentials when AGENT_PROVIDER=bedrock)
 * the route returns 501 with the same typed body so the UI can say, honestly,
 * that the agent is not configured rather than fabricate an answer.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tool-calling answer runs 30-90 s, and the ceiling counts streaming time too, so 60 s
// truncated the slower questions. 300 s is the Vercel Hobby maximum with Fluid compute
// (default and maximum on that plan), which is the tightest platform we deploy to.
export const maxDuration = 300;

export type { AgentResponse, AgentToolCall, AgentEvidenceRow } from "@/lib/agent/types";

const NOT_CONFIGURED_HINT =
  "Set ANTHROPIC_API_KEY (and optionally AGENT_MODEL, default claude-opus-5) in the server environment, or AGENT_PROVIDER=bedrock with AWS credentials, then redeploy. Every question the agent answers is also answerable on the Questions page, which runs the same SQL rules in the browser.";

function notConfigured(message = NOT_CONFIGURED_MESSAGE): NextResponse<AgentResponse> {
  return NextResponse.json(emptyResponse("not_implemented", message, NOT_CONFIGURED_HINT), {
    status: 501,
  });
}

function parseMessages(body: unknown): AgentChatMessage[] | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { messages?: unknown; message?: unknown }).messages;
  if (Array.isArray(raw)) {
    const messages = raw
      .filter(
        (item): item is { role: string; content: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { role?: unknown }).role === "string" &&
          typeof (item as { content?: unknown }).content === "string",
      )
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ role: item.role as "user" | "assistant", content: item.content.slice(0, 8000) }));
    return messages.length > 0 ? messages : null;
  }
  const single = (body as { message?: unknown }).message;
  if (typeof single === "string" && single.trim()) return [{ role: "user", content: single.slice(0, 8000) }];
  return null;
}

export async function POST(request: Request): Promise<NextResponse<AgentResponse>> {
  if (!isAgentConfigured()) return notConfigured();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(emptyResponse("error", "Request body must be JSON with a messages array."), {
      status: 400,
    });
  }
  const messages = parseMessages(body);
  if (!messages || messages[messages.length - 1]?.role !== "user") {
    return NextResponse.json(
      emptyResponse("error", "Send { messages: [{ role: 'user' | 'assistant', content }] } ending with a user message."),
      { status: 400 },
    );
  }

  try {
    const response = await runAgent({ messages, abortSignal: request.signal });
    return NextResponse.json(response);
  } catch (error: unknown) {
    if (error instanceof AgentNotConfiguredError) return notConfigured(error.message);
    const message = error instanceof Error ? error.message : String(error);
    logAgent("error", "agent turn failed", { error: message });
    return NextResponse.json(
      emptyResponse(
        "error",
        `The agent could not complete this turn: ${message}`,
        "Nothing was generated. Check the server log for the failing tool or provider call.",
      ),
      { status: 500 },
    );
  }
}

/** Health / capability probe for the chat page and for curl. */
export async function GET(): Promise<NextResponse> {
  const configured = isAgentConfigured();
  const payload = {
    configured,
    provider: readProvider(),
    model: process.env.AGENT_MODEL?.trim() || null,
    tools: ["get_schema", "run_sql", "preset_question", "get_property", "get_run_history"],
    message: configured ? "agent configured" : NOT_CONFIGURED_MESSAGE,
  };
  return NextResponse.json(payload, { status: configured ? 200 : 501 });
}
