import { NextResponse } from "next/server";
import { serverSelection, serverModelChoices, AgentNotConfiguredError } from "@/lib/agent/model";
import { runAgent, TOOL_ORDER } from "@/lib/agent/run";
import { logAgent } from "@/lib/agent/log";
import { readUserCredential, readModelChoice, KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "@/lib/agent/credentials";
import {
  isAgentError,
  providerSpecificHint,
  AgentBadRequestError,
  AgentRateLimitError,
} from "@/lib/agent/errors";
import {
  AGENT_RATE_LIMIT,
  agentBudget,
  boundTranscript,
  clientAddress,
  spendCeilingSettings,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS_PER_STEP,
  MAX_TOOL_STEPS,
  MAX_TRANSCRIPT_CHARS,
  type BudgetDecision,
} from "@/lib/agent/ratelimit";
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
 * inventing an answer. Which of the two is the normal path depends on what the
 * deployment configured, and the code does not assume: GET /api/agent reports
 * which one would answer this request, by variable name, never by value.
 *
 * THE KEY. It exists for the duration of one request. It is not stored, not
 * cached, not written to a cookie, and not logged: every log line and every
 * error string on this path goes through `safeMessage` first, and the GET
 * probe below reports only whether a key is set, never its value.
 *
 * WHAT A STRANGER CAN SPEND. This route is public on purpose and stays public,
 * so the answer cannot be "add a login". It is bounded instead, by the three
 * ceilings in lib/agent/ratelimit.ts: a per address limit, one global budget
 * shared by every caller who does NOT bring a key, and hard per request caps on
 * tool steps and transcript size that give the global budget a known unit cost.
 * A caller who sends x-llm-api-key spends their own money and is exempt from
 * the global budget, which is why bringing a key is the advice on every ceiling
 * message here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A tool-calling answer runs 30-90 s, and the ceiling counts streaming time too, so 60 s
// truncated the slower questions. 300 s is the Vercel Hobby maximum with Fluid compute
// (default and maximum on that plan), which is the tightest platform we deploy to.
export const maxDuration = 300;

/** The streaming content type. One JSON object per line: progress events, then the result. */
const NDJSON = "application/x-ndjson";

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
      // Bounded before anything walks the array, so a pathological body cannot
      // make the filtering itself the expensive part of the request.
      .slice(-MAX_MESSAGES)
      .filter(
        (item): item is { role: string; content: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { role?: unknown }).role === "string" &&
          typeof (item as { content?: unknown }).content === "string",
      )
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
    return messages.length > 0 ? boundTranscript(messages) : null;
  }
  const single = (body as { message?: unknown }).message;
  if (typeof single === "string" && single.trim()) {
    return [{ role: "user", content: single.slice(0, MAX_MESSAGE_CHARS) }];
  }
  return null;
}

/** "3 hours", "12 minutes", "45 seconds". Retry-After is a number; a reader is not. */
function humanDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * The global budget is spent.
 *
 * Deliberately not routed through toErrorResponse: the generic 429 hint talks
 * about a per address cap, and telling a reader to wait for their own window
 * when what they hit is the deployment's daily budget is a small lie on the one
 * screen they read to understand what happened. This says what the cap is, what
 * the number was, and what still works, which is the difference between a
 * spending limit and a broken page.
 */
function budgetExceeded(decision: BudgetDecision): NextResponse<AgentResponse> {
  const windowLabel = humanDuration(Math.round(decision.windowMs / 1000));
  const message = [
    "This public demo answers on the operator's own model credential, so it runs under a spending cap, and the cap is spent.",
    `The cap is ${decision.globalLimit} questions per ${windowLabel} across every visitor, enforced here as ${decision.perInstanceLimit} on this server instance. It rolls over in ${humanDuration(decision.retryAfterSeconds)}.`,
  ].join(" ");

  return NextResponse.json(
    emptyResponse(
      "error",
      message,
      "Nothing is broken and no data is missing. The Questions page answers the same rules in the browser with no model at all, and sending your own credential in the x-llm-api-key header answers without counting against this cap. GET /api/agent reports the exact ceiling and how it is enforced.",
    ),
    { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
  );
}

export async function POST(request: Request): Promise<Response> {
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

  const modelChoice = readModelChoice(request.headers);

  // The global spend ceiling. Two placement decisions, both deliberate.
  //
  // Only a KEYLESS caller reaches it: someone who sent their own credential is
  // about to spend their own money, and capping that would protect nothing
  // while making the bring your own key path - the escape hatch every ceiling
  // message here points at - useless.
  //
  // And it is charged LAST, after the body has parsed and validated, so a flood
  // of malformed requests cannot drain the day's budget without ever reaching a
  // model. A spend control that can be turned into an availability attack has
  // traded one problem for another.
  if (!credential) {
    const budget = agentBudget().check();
    if (!budget.allowed) {
      logAgent("warn", "agent global budget exhausted", {
        global_limit: budget.globalLimit,
        per_instance_limit: budget.perInstanceLimit,
        used_on_this_instance: budget.usedOnThisInstance,
        retry_after_s: budget.retryAfterSeconds,
      });
      return budgetExceeded(budget);
    }
  }

  // Streaming is opt in by Accept header. A turn takes about ten seconds and has taken seventy, and
  // this route can only answer once, at the end, so a reader watching a spinner has no idea whether
  // anything is happening. A client that asks for NDJSON gets the real events as they occur and the
  // identical final payload as the last line; everything else - curl, the tests, any other consumer
  // - keeps the single JSON object it has always received.
  const wantsStream = (request.headers.get("accept") ?? "").includes(NDJSON);

  if (!wantsStream) {
    try {
      const response = await runAgent({
        messages,
        credential,
        modelChoice,
        // The per request output ceiling. run.ts defaults to 12 steps; the
        // route asks for fewer so the worst case a single call can cost is a
        // number this deployment chose rather than one the loop happened to
        // have. See MAX_TOOL_STEPS in lib/agent/ratelimit.ts.
        maxSteps: MAX_TOOL_STEPS,
        abortSignal: request.signal,
      });
      return NextResponse.json(response);
    } catch (error: unknown) {
      return toErrorResponse(error, secrets, credential ? "user" : "server");
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          // the reader went away mid turn; the abort signal ends the work
        }
      };
      // A turn can sit silent for a minute while the model thinks, and an idle connection is what
      // intermediaries drop first. Every observed POST was reported as net::ERR_ABORTED by the
      // browser, and an abort that lands before the result line surfaces to the reader as "could
      // not reach the agent endpoint" - most often on the first question of a session, which has
      // the longest silence because DuckDB is opening at the same time. A byte every ten seconds
      // keeps the connection provably alive; the client ignores these lines.
      const heartbeat = setInterval(() => send({ type: "ping" }), 10_000);
      try {
        const response = await runAgent({
          messages,
          credential,
          modelChoice,
          maxSteps: MAX_TOOL_STEPS,
          abortSignal: request.signal,
          onProgress: (event) => send({ type: "progress", ...event }),
        });
        send({ type: "result", response });
      } catch (error: unknown) {
        // Same typed shape the JSON path returns, so the client renders one error, not two.
        const failed = toErrorResponse(error, secrets, credential ? "user" : "server");
        send({ type: "result", response: await failed.json() });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": `${NDJSON}; charset=utf-8`,
      "cache-control": "no-store",
      // proxies that buffer would defeat the entire point of streaming
      "x-accel-buffering": "no",
    },
  });
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
  const ceiling = spendCeilingSettings();
  // peek, not check: a capability probe must not spend the budget it reports.
  const budget = agentBudget().peek();

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
    tools: [...TOOL_ORDER],
    rate_limit: { scope: "per client address", note: "in process, per instance; see lib/agent/ratelimit.ts" },
    // What a stranger can spend on this deployment, reported rather than
    // claimed. Every number here is the one the code enforces, and every
    // approximation says which way it is approximate: an operator reading this
    // should be able to work out the worst case bill without reading the code,
    // and a reviewer who trips a ceiling should be able to confirm it was a
    // budget and not a bug.
    spend_ceiling: {
      per_request: {
        max_tool_steps: MAX_TOOL_STEPS,
        max_output_tokens_per_step: MAX_OUTPUT_TOKENS_PER_STEP,
        max_output_tokens_per_request: MAX_TOOL_STEPS * MAX_OUTPUT_TOKENS_PER_STEP,
        max_transcript_chars: MAX_TRANSCRIPT_CHARS,
        max_message_chars: MAX_MESSAGE_CHARS,
        note: "Hard caps, and an environment variable can only tighten them. Input is bounded by the transcript cap plus the tool row limits in lib/agent/tools.ts, not by a single number, so it is not quoted as one.",
      },
      global: {
        applies_to: "questions answered on this deployment's own credential; a request carrying x-llm-api-key pays for itself and is not counted",
        declared_limit: budget.globalLimit,
        window_seconds: Math.round(budget.windowMs / 1000),
        enforced_on_this_instance: budget.perInstanceLimit,
        used_on_this_instance: budget.usedOnThisInstance,
        assumed_instances: ceiling.assumedInstances,
        enforcement:
          "in process, per instance. The declared limit is divided by assumed_instances and each instance enforces the share, so the sum lands on the declared limit only while that assumption holds. More warm instances than assumed, or instance churn resetting fresh counters, both raise the real total in proportion.",
      },
      provider_side: {
        // The only ceiling here that a recycled lambda cannot reset, which is
        // why it is reported even though this code cannot enforce it.
        declared_usd: ceiling.declaredCeilingUsd,
        env_key: "AGENT_SPEND_CEILING_USD",
        server_credential_is_billed: ceiling.serverCredentialIsBilled,
        clamped: ceiling.clamped,
        note: "The authoritative ceiling is a hard spend cap set on the key at the provider, because that is the only one instance churn cannot reset. This value is what the operator declared was set there; nothing here can verify it.",
      },
      basis: ceiling.basis,
    },
    message: active
      ? `agent will answer with ${active.provider}:${active.model} (${active.source} credential)`
      : NOT_CONFIGURED_MESSAGE,
  });
}
