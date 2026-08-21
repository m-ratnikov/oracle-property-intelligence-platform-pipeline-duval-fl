/**
 * The credential never leaves.
 *
 * This app is public and unauthenticated, and a visitor's own API key travels
 * to this server on every question. Three things have to hold, and each one
 * gets a test here rather than a paragraph in a README:
 *
 *   1. A provider error that quotes the key comes back redacted, as a typed
 *      error, not as a 500 with a stack trace.
 *   2. Nothing on the request path writes key material to stdout, including
 *      the error paths, which are the ones that get written carelessly.
 *   3. The GET config probe reports whether a key is set, never its value.
 *
 * Point 2 is checked twice: once by running the failure path with the console
 * captured, and once by reading the source of every file on the request path
 * and looking at what is actually passed to a logger. The static check is the
 * one that keeps holding after somebody adds a log line in six months.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import { runAgent } from "@/lib/agent/run";
import type { ResolvedModel } from "@/lib/agent/model";
import { redactSecrets, safeMessage, keyFingerprint, REDACTED } from "@/lib/agent/redact";
import {
  AgentCredentialError,
  AgentProviderError,
  AgentRateLimitError,
  classifyProviderError,
  isAgentError,
} from "@/lib/agent/errors";
import { GET } from "@/app/api/agent/route";
import { KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "@/lib/agent/credentials";

/** Shaped like a real Anthropic key so the pattern pass has something to bite on. */
const USER_KEY = "sk-ant-api03-ThisIsNotARealKeyAtAll000000";

let db: PropertyDb;

beforeAll(async () => {
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A model that fails the way a provider fails when the key is wrong. */
function rejectingModel(message: string, statusCode?: number): ResolvedModel {
  return {
    provider: "anthropic",
    modelId: "claude-opus-5",
    source: "user",
    model: new MockLanguageModelV3({
      modelId: "claude-opus-5",
      doGenerate: async () => {
        const error = new Error(message) as Error & { statusCode?: number };
        if (statusCode !== undefined) error.statusCode = statusCode;
        throw error;
      },
    }),
    instructions: (system) => ({ role: "system", content: system }),
  };
}

describe("redaction", () => {
  it("replaces a known secret wherever it appears", () => {
    const text = `401 unauthorized: key ${USER_KEY} is invalid (sent ${USER_KEY})`;
    const out = redactSecrets(text, [USER_KEY]);
    expect(out).not.toContain(USER_KEY);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, "\\$&"), "g"))).toHaveLength(2);
  });

  it("replaces vendor shaped keys we were never given", () => {
    // The case that matters: a provider quoting somebody else's key back, or a
    // visitor pasting an Anthropic key into the Google field.
    const cases = [
      "sk-ant-api03-abcdefghijklmnop",
      "AIzaSyA1234567890abcdefghijklmnopqrst",
      "gsk_abcdefghijklmnopqrstuvwx",
      "csk-abcdefghijklmnopqrstuvwx",
      "vck_abcdefghijklmnopqrstuvwx",
      "hf_abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
    ];
    for (const candidate of cases) {
      expect(redactSecrets(`provider said: ${candidate}`, [])).not.toContain(candidate);
    }
  });

  it("leaves ordinary error prose readable", () => {
    const text = "model claude-opus-5 is not enabled for this account in region us-east-1 (request id req_0123456789)";
    expect(redactSecrets(text, [USER_KEY])).toBe(text);
  });

  it("ignores short strings so it cannot corrupt unrelated text", () => {
    expect(redactSecrets("the model is ok", ["ok"])).toBe("the model is ok");
  });

  it("flattens and redacts a cause chain", () => {
    const cause = new Error(`upstream rejected ${USER_KEY}`);
    const error = new Error("provider call failed", { cause });
    const message = safeMessage(error, [USER_KEY]);
    expect(message).toContain("provider call failed");
    expect(message).not.toContain(USER_KEY);
  });

  it("fingerprints a key without exposing any part of it", () => {
    const fingerprint = keyFingerprint(USER_KEY) ?? "";
    expect(fingerprint).toMatch(/^fp_[0-9a-f]{8}$/);
    // No substring of the key survives, in either direction.
    for (let size = 4; size <= 8; size += 1) {
      for (let start = 0; start + size <= USER_KEY.length; start += 1) {
        expect(fingerprint).not.toContain(USER_KEY.slice(start, start + size));
      }
    }
    expect(keyFingerprint(USER_KEY)).toBe(keyFingerprint(USER_KEY));
    expect(keyFingerprint("a-different-key-entirely")).not.toBe(keyFingerprint(USER_KEY));
    expect(keyFingerprint(null)).toBeNull();
  });
});

describe("provider failure classification", () => {
  it("reads a 401 or 403 as a credential problem", () => {
    expect(classifyProviderError({ statusCode: 401 }, "nope", "user")).toBeInstanceOf(AgentCredentialError);
    expect(classifyProviderError({ statusCode: 403 }, "nope", "user")).toBeInstanceOf(AgentCredentialError);
  });

  it("reads a credential complaint in the body even when the status is 400", () => {
    // Google answers 400 for a bad key, so status alone is not enough.
    const error = classifyProviderError({ statusCode: 400 }, "API key not valid. Please pass a valid API key.", "user");
    expect(error).toBeInstanceOf(AgentCredentialError);
  });

  it("keeps a real outage separate from a bad key", () => {
    const error = classifyProviderError({ statusCode: 503 }, "upstream overloaded", "user");
    expect(error).toBeInstanceOf(AgentProviderError);
    expect(error.status).toBe(502);
  });

  it("passes a provider side 429 through as a rate limit", () => {
    expect(classifyProviderError({ statusCode: 429 }, "slow down", "user")).toBeInstanceOf(AgentRateLimitError);
  });
});

describe("an invalid key produces a typed error, not a 500 and not a leak", () => {
  it("throws AgentCredentialError with the key stripped out of the message", async () => {
    const promise = runAgent({
      messages: [{ role: "user", content: "how many parcels are there?" }],
      model: rejectingModel(`401 {"error":{"message":"invalid x-api-key: ${USER_KEY}"}}`, 401),
      db,
      env: {},
      credential: { provider: "anthropic", modelId: "claude-opus-5", apiKey: USER_KEY },
    });

    await expect(promise).rejects.toBeInstanceOf(AgentCredentialError);

    const error = await promise.catch((caught: unknown) => caught as Error);
    expect(isAgentError(error)).toBe(true);
    expect((error as AgentCredentialError).status).toBe(401);
    expect(error.message).not.toContain(USER_KEY);
    expect(error.message).toContain(REDACTED);
    // Still says something a person can act on.
    expect(error.message).toMatch(/invalid x-api-key/);
  });

  it("does not misread a genuine provider outage as a bad key", async () => {
    const promise = runAgent({
      messages: [{ role: "user", content: "how many parcels are there?" }],
      model: rejectingModel("529 overloaded_error: the provider is overloaded", 529),
      db,
      env: {},
      credential: { provider: "anthropic", modelId: "claude-opus-5", apiKey: USER_KEY },
    });
    await expect(promise).rejects.toBeInstanceOf(AgentProviderError);
  });
});

describe("nothing on the request path logs key material", () => {
  it("writes no key to the console when the provider rejects it", async () => {
    const written: string[] = [];
    const capture = (...args: unknown[]) => {
      written.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(capture);

    // logAgent is a no-op under NODE_ENV=test, which would make this test pass
    // for the wrong reason. Turn logging on for the duration.
    vi.stubEnv("NODE_ENV", "production");
    try {
      await runAgent({
        messages: [{ role: "user", content: "how many parcels are there?" }],
        model: rejectingModel(`401 invalid x-api-key: ${USER_KEY}`, 401),
        db,
        env: {},
        credential: { provider: "anthropic", modelId: "claude-opus-5", apiKey: USER_KEY },
      }).catch(() => undefined);
    } finally {
      vi.unstubAllEnvs();
    }

    // The failure really was logged, so this is not passing on silence.
    expect(written.join("\n")).toContain("provider call failed");
    for (const line of written) {
      expect(line).not.toContain(USER_KEY);
      // Not even a fragment of it.
      expect(line).not.toContain(USER_KEY.slice(0, 16));
      expect(line).not.toContain(USER_KEY.slice(-12));
    }
  });

  /**
   * Static guarantee, so this keeps holding after the next log line is added.
   *
   * Reads every file on the request path, finds each logger call, extracts the
   * whole call expression by balancing parentheses, and looks at what is being
   * handed to it. Two wrappers are stripped first because they exist precisely
   * to make a credential safe to pass: keyFingerprint, which is not reversible,
   * and safeMessage, which redacts.
   */
  it("hands no credential to any logger anywhere under lib/agent or app/api", () => {
    const roots = [join(process.cwd(), "lib", "agent"), join(process.cwd(), "app", "api")];
    const offenders: string[] = [];
    let inspected = 0;

    for (const file of roots.flatMap(walkTypeScript)) {
      const source = readFileSync(file, "utf8");
      for (const call of loggerCalls(source)) {
        inspected += 1;
        const stripped = call
          .replace(/keyFingerprint\([^)]*\)/g, "FINGERPRINT")
          .replace(/safeMessage\([^)]*\)/g, "SAFE")
          .replace(/redactSecrets\([^)]*\)/g, "SAFE");
        if (/apiKey|api_key|\bcredential\.key\b|process\.env\.[A-Z_]*KEY/.test(stripped)) {
          offenders.push(`${file}: ${call.slice(0, 160)}`);
        }
      }
    }

    // Guard against the scan silently finding nothing to inspect.
    expect(inspected).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("routes every log in lib/agent through the structured logger", () => {
    // One logger means one place to audit. log.ts is the logger itself.
    const offenders = walkTypeScript(join(process.cwd(), "lib", "agent"))
      .filter((file) => !file.endsWith("log.ts"))
      .filter((file) => /console\.(log|info|warn|error|debug)\s*\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("GET /api/agent reports configuration, never the credential", () => {
  it("names the model that would answer and omits the key", async () => {
    const request = new Request("https://example.test/api/agent", {
      headers: {
        [KEY_HEADER]: USER_KEY,
        [PROVIDER_HEADER]: "google",
        [MODEL_HEADER]: "gemini-3.7-flash",
      },
    });
    const response = await GET(request);
    const body = await response.text();

    expect(body).not.toContain(USER_KEY);
    const payload = JSON.parse(body) as {
      active: { provider: string; model: string; source: string };
      providers: { id: string }[];
      server_default: unknown;
    };
    expect(payload.active).toEqual({ provider: "google", model: "gemini-3.7-flash", source: "user" });
    expect(payload.providers.map((provider) => provider.id)).toContain("google");
    // No server key is configured in this deployment, so there is nothing to report.
    expect(payload.server_default).toBeNull();
  });

  it("rejects a malformed credential header without echoing it", async () => {
    // Under the 8 character minimum, and distinctive enough that finding it in
    // the body would mean the value itself was echoed.
    const tooShort = "zqx42";
    const request = new Request("https://example.test/api/agent", {
      headers: { [KEY_HEADER]: tooShort, [PROVIDER_HEADER]: "google" },
    });
    const body = await (await GET(request)).text();
    expect(body).not.toContain(tooShort);
    expect(JSON.parse(body).header_error).toMatch(/too short to be an API key/);
  });
});

/** Every .ts / .tsx file under a directory, recursively. */
function walkTypeScript(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
  };
  visit(root);
  return out;
}

/** Each logger call expression in a source file, parentheses balanced. */
function loggerCalls(source: string): string[] {
  const out: string[] = [];
  const opener = /(?:logAgent|console\.(?:log|info|warn|error|debug|trace))\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      index += 1;
    }
    out.push(source.slice(match.index, index));
  }
  return out;
}

describe("a 429 says whose limit was hit", () => {
  // Conflating the two tells the caller something false. Our own per-address cap rolls over on its
  // own; a provider quota does not, and the visitor can route around it with their own key.
  it("marks a provider 429 as provider scope", () => {
    const err = classifyProviderError({ statusCode: 429 }, "slow down", "user");
    expect(err).toBeInstanceOf(AgentRateLimitError);
    expect((err as AgentRateLimitError).scope).toBe("provider");
    expect((err as AgentRateLimitError).perDay).toBe(false);
  });

  it("recognises a per-day quota and does not promise it reopens in seconds", () => {
    // the exact text OpenRouter returned when the deployment's free quota ran out
    const err = classifyProviderError(
      { statusCode: 429 },
      "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      "server",
    ) as AgentRateLimitError;
    expect(err.scope).toBe("provider");
    expect(err.perDay).toBe(true);
    expect(err.retryAfterSeconds).toBeGreaterThan(60);
  });

  it("defaults to local scope, which is what this route's own limiter raises", () => {
    expect(new AgentRateLimitError("capped", 30).scope).toBe("local");
  });
});
