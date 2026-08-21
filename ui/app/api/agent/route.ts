import { NextResponse } from "next/server";
import { serverSelection, serverModelChoices, AgentNotConfiguredError } from "@/lib/agent/model";
import { runAgent } from "@/lib/agent/run";
import { logAgent } from "@/lib/agent/log";
import { readUserCredential, readModelChoice, KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "@/lib/agent/credentials";
import {
  isAgentError,
  providerSpecificHint,
  AgentBadRequestError,
  AgentRateLimitError,
} from "@/lib/agent/errors";
import { AGENT_RATE_LIMIT, clientAddress } from "@/lib/agent/ratelimit";
import { safeMessage } from "@/lib/agent/redact";
import { PROVIDERS } from "@/lib/agent/providers";
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
 * WHICH MODEL ANSWERS. In order:
 *   1. the caller's own credential, sent per request as
 *      `x-llm-api-key` + `x-llm-provider` + `x-llm-model`;
 *   2. the server environment, when a key is configured there.
 * With neither, the route returns 501 and a typed body saying so, rather than
 * inventing an answer. This deployment ships with no server key, so path 1 is
 * the normal path; a caller may still send their own key by header.
 *
 * THE KEY. It exists for the duration of one request. It is not stored, not
 * cached, not written to a cookie, and not logged: every log line and every
 * error string on this path goes through `safeMessage` first, and the GET
 * probe below reports only whether a key is set, never its value.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tool-calling answer runs 30-90 s, and the ceiling counts streaming time too, so 60 s
// truncated the slower questions. 300 s is the Vercel Hobby maximum with Fluid compute
// (default and maximum on that plan), which is the tightest platform we deploy to.
export const maxDuration = 300;

export type { AgentResponse, AgentToolCall, AgentEvidenceRow } from "@/lib/agent/types";

const NOT_CONFIGURED_HINT =
  "No model is configured on this deployment. Every question the agent answers is also answerable on the Questions page, which runs the same SQL rules in the browser with no model at all.";

function notConfigured(message = NOT_CONFIGURED_MESSAGE): NextResponse<AgentResponse> {
  return NextResponse.json(emptyResponse("not_implemented", message, NOT_CONFIGURED_HINT), {
    status: 501,
  });
}

/**
 * Turn a typed error into the same AgentResponse contract the UI already
 * renders. No path here produces a bare 500 with a stack trace, and every
 * message has been through redaction before it arrives.
 */
function toErrorResponse(
  error: unknown,
  secrets: (string | undefined)[],
  // Whose credential the turn used. A visitor can fix their own key; they cannot fix this
  // deployment's, so telling them to fix a key for a server side failure points at something they
  // do not control. Defaults to "user" because that is the safe thing to say when
  // the failure happened before a credential was resolved.
  credentialSource: "user" | "server" = "user",
): NextResponse<AgentResponse> {
  if (error instanceof AgentNotConfiguredError) return notConfigured(error.message);

  if (isAgentError(error)) {
    const hint =
      providerSpecificHint(error.message) ??
      (error.name === "AgentCredentialError"
        ? credentialSource === "server"
          ? "The provider rejected this deployment's own key, so there is nothing to fix on your side. The operator needs to attend to the server credential."
          : "The provider rejected that credential. Confirm the key belongs to the provider named in the x-llm-provider header, and test it against /api/agent/test before asking again."
        : error instanceof AgentRateLimitError
          ? error.scope === "provider"
            ? error.perDay
              ? "This deployment's model provider has hit its quota for the day, so waiting will not clear it. The operator needs to raise the provider's limit; the Questions page answers the same rules meanwhile with no model at all."
              : "The model provider is throttling this deployment's key, not you. Try again shortly; the Questions page answers the same rules meanwhile with no model at all."
            : "This is a public endpoint, so it is capped per address. Wait for the window to roll over, or supply your own key to keep your questions independent of everyone else's."
          : error.name === "AgentBadRequestError"
            ? "Fix the request headers and try again. GET /api/agent lists every provider and model this build supports."
            : "The model provider failed the call. Nothing was fabricated. Retrying, or picking a different model from the dropdown, is usually enough.");

    const headers: Record<string, string> = {};
    if (error instanceof AgentRateLimitError) headers["retry-after"] = String(error.retryAfterSeconds);

    return NextResponse.json(emptyResponse("error", error.message, hint), { status: error.status, headers });
  }

  const message = safeMessage(error, secrets);
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
  // Rate limit first, before any work and before touching the credential. A
  // public route on a 300 second function is worth protecting whoever pays.
  const decision = AGENT_RATE_LIMIT.check(clientAddress(request.headers));
  if (!decision.allowed) {
    logAgent("warn", "agent rate limited", { limit: decision.limit, retry_after_s: decision.retryAfterSeconds });
    return toErrorResponse(
      new AgentRateLimitError(
        `Too many questions from this address: the limit is ${decision.limit} per window. Try again in ${decision.retryAfterSeconds} seconds.`,
        decision.retryAfterSeconds,
      ),
      [],
    );
  }

  let credential;
  try {
    credential = readUserCredential(request.headers);
  } catch (error: unknown) {
    return toErrorResponse(error, []);
  }

  if (!credential && !serverSelection()) return notConfigured();

  const secrets = [credential?.apiKey];

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
    const response = await runAgent({
      messages,
      credential,
      modelChoice: readModelChoice(request.headers),
      abortSignal: request.signal,
    });
    return NextResponse.json(response);
  } catch (error: unknown) {
    return toErrorResponse(error, secrets, credential ? "user" : "server");
  }
}

/**
 * Health / capability probe for the chat page and for curl.
 *
 * Reports which provider and model would answer, the full supported registry,
 * and whether a server side key exists. It reports the NAME of the environment
 * variable that supplies a server key and never its value, and there is no
 * branch anywhere below that can emit a credential.
 *
 * The headers are read the same way POST reads them, so
 *   curl -H "x-llm-api-key: ..." -H "x-llm-provider: google" .../api/agent
 * answers "this is what would run", which is the cheapest way to confirm a
 * client is sending what it thinks it is sending.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const server = serverSelection();

  let active: { provider: string; model: string; source: "user" | "server" } | null = server
    ? { provider: server.provider, model: server.modelId, source: "server" }
    : null;
  let headerError: string | null = null;

  const choices = serverModelChoices();

  try {
    const credential = readUserCredential(request.headers);
    if (credential) active = { provider: credential.provider, model: credential.modelId, source: "user" };
    const picked = readModelChoice(request.headers);
    if (picked && active && choices.some((choice) => choice.id === picked)) active = { ...active, model: picked };
  } catch (error: unknown) {
    headerError = error instanceof AgentBadRequestError ? error.message : "credential headers rejected";
  }

  return NextResponse.json({
    configured: Boolean(server),
    // What would answer a question sent exactly like this one.
    active,
    // The server side default, by variable NAME. Never a value.
    server_default: server ? { provider: server.provider, model: server.modelId, env_key: server.envKey } : null,
    // What the model dropdown offers. Bounded to this deployment's own provider so a header cannot
    // point a billed key at an arbitrary model; see serverModelChoices.
    model_choices: choices,
    bring_your_own_key: {
      headers: { key: KEY_HEADER, provider: PROVIDER_HEADER, model: MODEL_HEADER },
      test_url: "/api/agent/test",
      storage: "sent per request, never stored server side",
    },
    header_error: headerError,
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      free_tier: provider.freeTier,
      key_url: provider.keyUrl,
      docs_url: provider.docsUrl,
      models: provider.models.map((model) => ({ id: model.id, label: model.label, free: model.free })),
    })),
    tools: ["get_schema", "run_sql", "preset_question", "get_property", "get_run_history"],
    rate_limit: { scope: "per client address", note: "in process, per instance; see lib/agent/ratelimit.ts" },
    message: active
      ? `agent will answer with ${active.provider}:${active.model} (${active.source} credential)`
      : NOT_CONFIGURED_MESSAGE,
  });
}
