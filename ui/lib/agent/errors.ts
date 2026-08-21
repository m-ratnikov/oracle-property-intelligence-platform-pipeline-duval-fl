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

/** The per IP budget for this public route is spent. */
export class AgentRateLimitError extends Error {
  readonly status = 429 as const;
  constructor(
    message: string,
    /** Seconds until the window rolls over, for the Retry-After header. */
    readonly retryAfterSeconds: number,
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
  if (status === 429) {
    return new AgentRateLimitError(safeText, 30);
  }
  return new AgentProviderError(safeText);
}
