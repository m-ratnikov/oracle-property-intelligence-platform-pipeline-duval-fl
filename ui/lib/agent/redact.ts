/**
 * Key redaction.
 *
 * A visitor supplied API key reaches this server on every question. It must
 * never leave again: not in a log line, not in a response body, not inside a
 * provider's error text. Providers are not careful about this. Some echo the
 * offending key back in the message of a 401, and that message is exactly what
 * an error path is tempted to log.
 *
 * So every string that comes off an error path goes through `safeMessage`
 * first, and every log line that could carry provider text goes through it too.
 * Two passes run:
 *
 *  1. Exact: replace the literal secret we were handed, if we still hold it.
 *  2. Shaped: replace anything that looks like a vendor key even when we never
 *     saw it, which covers a key the caller mistyped into the wrong field and a
 *     key belonging to somebody else that a provider quoted back at us.
 *
 * The redaction placeholder is deliberately boring and greppable.
 */

export const REDACTED = "[redacted]";

/**
 * Vendor key shapes, longest prefix first. These are matched against arbitrary
 * provider prose, so each one anchors on a distinctive prefix rather than on
 * length alone: a bare "20 or more base64 characters" rule would eat request
 * ids, model ids and trace ids and make errors unreadable.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /AIza[A-Za-z0-9_-]{20,}/g, // Google AI Studio
  /gsk_[A-Za-z0-9]{20,}/g, // Groq
  /csk-[A-Za-z0-9-]{20,}/g, // Cerebras
  /vck_[A-Za-z0-9]{20,}/g, // Vercel AI Gateway
  /hf_[A-Za-z0-9]{20,}/g, // Hugging Face user access token
  /sk-or-v1-[A-Za-z0-9]{20,}/g, // OpenRouter
  /ABSK[A-Za-z0-9+/=]{20,}/g, // Bedrock bearer token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

/** Escape a literal so it can be used inside a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every known secret, and everything key shaped, with `[redacted]`.
 *
 * Secrets shorter than 8 characters are ignored on the exact pass: they are
 * not credentials, and blanket replacing a 3 character string would corrupt
 * unrelated text.
 */
export function redactSecrets(value: string, secrets: Iterable<string | null | undefined> = []): string {
  let out = value;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed || trimmed.length < 8) continue;
    out = out.replace(new RegExp(escapeLiteral(trimmed), "g"), REDACTED);
  }
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * The message of an unknown error, flattened to a string and redacted.
 *
 * Errors from the AI SDK carry `cause` chains and `responseBody` blobs that
 * routinely quote the request, so the whole error is serialised before being
 * scrubbed rather than only its top level `message`.
 */
export function safeMessage(error: unknown, secrets: Iterable<string | null | undefined> = []): string {
  const parts: string[] = [];

  // Walk a short cause chain. The AI SDK wraps a provider failure in a retry
  // error whose own message is only "Failed after 3 attempts", so the useful
  // text is always one or two levels down.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);

    // `responseBody` is where an OpenAI compatible provider puts the reason it
    // actually refused. Without it a shared pool 429 reads as the useless
    // "Provider returned error", which tells a visitor nothing they can act on.
    const body = (current as { responseBody?: unknown }).responseBody;
    if (typeof body === "string" && body.trim() && !parts.includes(body)) parts.push(body.trim());

    current = current instanceof Error ? current.cause : undefined;
  }

  return redactSecrets(parts.join(": "), secrets).slice(0, 600);
}

/**
 * A non reversible fingerprint, so a log can say "the same key as the previous
 * request" without containing any part of the key.
 *
 * Deliberately not a substring: printing even the last few characters of a
 * credential is still key material in a log file. This is FNV-1a over the key,
 * which is not a password hash and is not meant to be one. It exists to make
 * two different keys look different in a log, nothing more.
 */
export function keyFingerprint(key: string | null | undefined): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= trimmed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, "0")}`;
}
