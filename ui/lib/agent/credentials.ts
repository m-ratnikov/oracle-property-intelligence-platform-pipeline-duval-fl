/**
 * Reading a visitor's own credential off a request.
 *
 * The contract, and the reasoning behind each rule:
 *
 *  - The key arrives in the `x-llm-api-key` header, not in the JSON body.
 *    Bodies get logged by well meaning middleware; a header that nothing in
 *    this app writes out is a smaller target. It is used to build one provider
 *    client for one request and then it is dropped.
 *
 *  - `x-llm-provider` and `x-llm-model` are honoured ONLY alongside a key.
 *    That is deliberate. If a server side key is ever configured, a stranger
 *    must not be able to point it at an expensive model by sending a header:
 *    without a key of their own, callers get the server's provider and the
 *    server's model or nothing at all.
 *
 *  - Both are checked against the registry. An unlisted provider or an
 *    unlisted model is a 400, not a pass through, so the request can never
 *    reach a code path this build has not declared support for.
 *
 * Nothing in this module logs, and nothing it throws contains the key.
 */

import { AgentBadRequestError } from "./errors";
import { findProvider, findModel, defaultModelFor, type AgentProvider } from "./providers";

export const KEY_HEADER = "x-llm-api-key";
export const PROVIDER_HEADER = "x-llm-provider";
export const MODEL_HEADER = "x-llm-model";

/** A credential the visitor supplied for this one request. */
export interface UserCredential {
  provider: AgentProvider;
  modelId: string;
  apiKey: string;
}

/** Keys are opaque strings, but they are not arbitrary bytes. */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;
/** Printable ASCII with no spaces. Rejects newlines, which is header injection hygiene. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

function requireKeyShape(raw: string): string {
  const key = raw.trim();
  // None of these messages quote the value, only its shape.
  if (key.length < MIN_KEY_LENGTH) {
    throw new AgentBadRequestError(
      `The ${KEY_HEADER} header is too short to be an API key (minimum ${MIN_KEY_LENGTH} characters).`,
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new AgentBadRequestError(
      `The ${KEY_HEADER} header is longer than ${MAX_KEY_LENGTH} characters, which no supported provider issues.`,
    );
  }
  if (!KEY_SHAPE.test(key)) {
    throw new AgentBadRequestError(
      `The ${KEY_HEADER} header contains characters no supported provider uses. Paste the key on its own, with no quotes or line breaks.`,
    );
  }
  return key;
}

/**
 * Parse the credential headers.
 *
 * Returns null when the caller sent no key, which is the "use whatever the
 * server is configured with" path. Throws AgentBadRequestError when the caller
 * sent something, but sent it wrong.
 */
export function readUserCredential(headers: Headers): UserCredential | null {
  const rawKey = headers.get(KEY_HEADER);
  const rawProvider = headers.get(PROVIDER_HEADER)?.trim().toLowerCase() || null;
  const rawModel = headers.get(MODEL_HEADER)?.trim() || null;

  if (!rawKey?.trim()) {
    // A model on its own is the dropdown, and it is validated against the server's own bounded
    // choices in resolveModel. A provider on its own is still refused: switching provider without a
    // key would mean asking this deployment to pay on an account it has not been configured with.
    if (rawProvider) {
      throw new AgentBadRequestError(
        `${PROVIDER_HEADER} only applies to a request that also carries ${KEY_HEADER}. Without your own key the server answers with its own configured provider.`,
      );
    }
    return null;
  }

  const apiKey = requireKeyShape(rawKey);

  if (!rawProvider) {
    throw new AgentBadRequestError(`A request carrying ${KEY_HEADER} must also send ${PROVIDER_HEADER}.`);
  }
  const provider = findProvider(rawProvider);
  if (!provider) {
    throw new AgentBadRequestError(`Unknown provider "${rawProvider}". See GET /api/agent for the supported list.`);
  }
  if (!provider.acceptsUserKey) {
    throw new AgentBadRequestError(`${provider.label} cannot be driven by a pasted key; configure it server side.`);
  }

  const modelId = rawModel ?? defaultModelFor(provider.id);
  if (!findModel(provider.id, modelId)) {
    throw new AgentBadRequestError(
      `Model "${modelId}" is not one this build supports for ${provider.label}. See GET /api/agent for the supported list.`,
    );
  }

  return { provider: provider.id, modelId, apiKey };
}

/**
 * The model a keyless caller picked from the dropdown, or null. Validation lives in resolveModel,
 * which is the only place that knows what this deployment is willing to run on its own key.
 */
export function readModelChoice(headers: Headers): string | null {
  if (headers.get(KEY_HEADER)?.trim()) return null;
  return headers.get(MODEL_HEADER)?.trim() || null;
}
