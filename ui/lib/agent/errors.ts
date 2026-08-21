/**
 * Typed agent errors.
 *
 * The route maps each of these onto a status code and a typed AgentResponse
 * body. The point is that a caller can tell "you sent me a bad key" apart from
 * "the model provider fell over" apart from "nothing is configured here", and
 * that none of those paths is ever a bare 500 with a stack trace.
 *
 * Every message that reaches a constructor here has already been through
 * `safeMessage` in redact.ts when it originated from a provider.
 */

import { NOT_CONFIGURED_MESSAGE } from "./types";

/** Nothing is configured: no user key on the request, no key in the server env. */
export class AgentNotConfiguredError extends Error {
  readonly status = 501 as const;
  constructor(message = NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "AgentNotConfiguredError";
  }
}

/** The request itself is malformed: unknown provider, unlisted model, unusable key shape. */
export class AgentBadRequestError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "AgentBadRequestError";
  }
}

/** The provider rejected the credential. This is the "invalid key" path. */
export class AgentCredentialError extends Error {
  readonly status = 401 as const;
  constructor(
    message: string,
    /** Whose credential failed, so the UI knows whether to point at settings. */
    readonly credentialSource: "user" | "server" = "user",
  ) {
    super(message);
    this.name = "AgentCredentialError";
  }
}

/**
 * A 429. `scope` says WHOSE limit was hit, because the two need different advice and conflating
 * them tells the caller something false: "local" is this route's per address budget, which rolls
 * over on its own; "provider" is the model provider refusing, which no amount of waiting here
 * fixes and which the visitor can route around with their own key.
 */
export type RateLimitScope = "local" | "provider";

export class AgentRateLimitError extends Error {
  readonly status = 429 as const;
  constructor(
    message: string,
    /** Seconds until the window rolls over, for the Retry-After header. */
    readonly retryAfterSeconds: number,
    readonly scope: RateLimitScope = "local",
    /** True when the provider named a per-day quota, which will not roll over in seconds. */
    readonly perDay: boolean = false,
  ) {
    super(message);
    this.name = "AgentRateLimitError";
  }
}

/** The provider was reachable and authenticated but failed the call. */
export class AgentProviderError extends Error {
  readonly status = 502 as const;
  constructor(message: string) {
    super(message);
    this.name = "AgentProviderError";
  }
}

export type AgentError =
  | AgentNotConfiguredError
  | AgentBadRequestError
  | AgentCredentialError
  | AgentRateLimitError
  | AgentProviderError;

const TYPED = [
  "AgentNotConfiguredError",
  "AgentBadRequestError",
  "AgentCredentialError",
  "AgentRateLimitError",
  "AgentProviderError",
];

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof Error && TYPED.includes(error.name);
}

/**
 * Provider specific gotchas that a generic "the call failed" hint cannot fix.
 *
 * There is exactly one so far and it is worth the special case, because it is
 * the single most likely way a visitor's first OpenRouter attempt fails and the
 * raw message does not tell them what to do. OpenRouter routes free models only
 * to providers that may train on the prompt, and an account that has not opted
 * into that gets "No endpoints found matching your data policy" on every call,
 * which reads like a broken model id rather than a setting.
 *
 * Returns null when nothing specific applies, so the caller falls back to its
 * normal hint.
 */
export function providerSpecificHint(safeText: string): string | null {
  if (/data policy|no endpoints found/i.test(safeText)) {
    return "OpenRouter routes its free models only to providers that may train on your prompt, so a free model needs prompt training enabled at openrouter.ai/settings/privacy. Turn it on, or pick a provider whose free tier does not have that condition.";
  }
  if (/rate-limited upstream|shared pool/i.test(safeText)) {
    return "This is the free model pool being busy, not your key and not your daily quota. Free models are already sent with the rest of the free list as fallbacks, so every one of them was busy at once. Wait a moment and ask again, or bring a key for a provider with a dedicated free tier.";
  }
  return null;
}

/**
 * Classify a raw provider failure.
 *
 * The AI SDK surfaces provider HTTP failures as errors carrying `statusCode`,
 * so a 401 or 403 is read as a credential problem. Providers that answer 400
 * for a bad key (Google does this) are caught by the message probe instead.
 * The message handed in here must already be redacted.
 */
export function classifyProviderError(error: unknown, safeText: string, source: "user" | "server"): AgentError {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  const status = typeof statusCode === "number" ? statusCode : null;

  const looksLikeCredential =
    status === 401 ||
    status === 403 ||
    /api[\s_-]?key|unauthorized|unauthenticated|permission denied|invalid.{0,20}credential|invalid authentication/i.test(
      safeText,
    );

  if (looksLikeCredential) {
    return new AgentCredentialError(safeText, source);
  }
  // The status code does not always survive the SDK's retry wrapper, so the
  // text is checked too. A shared pool 429 from OpenRouter arrives as a generic
  // "Provider returned error" with the real reason in the response body.
  if (status === 429 || /rate[\s-]?limit|too many requests|quota exceeded|\b429\b/i.test(safeText)) {
    // A daily quota does not reopen in thirty seconds; saying it does sends the caller back to
    // retry all day. OpenRouter phrases it "free-models-per-day"; others say "per day" or "daily".
    const perDay = /per[\s-]?day|daily/i.test(safeText);
    return new AgentRateLimitError(safeText, perDay ? 3600 : 30, "provider", perDay);
  }
  return new AgentProviderError(safeText);
}
