/**
 * The provider registry, the credential headers, and the per request override.
 *
 * The registry is the single source of truth the settings UI and the server
 * both read, so the tests here are mostly integrity tests: if the two could
 * ever disagree about what is supported, that disagreement shows up as a
 * failure in this file rather than as a 400 in front of a reviewer.
 *
 * No network. Building a provider client from a key does not call the
 * provider, so every resolution below runs offline against fake keys.
 */

import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_IDS,
  FREE_TIER_VERIFIED_ON,
  defaultModelFor,
  findModel,
  findProvider,
  isSupported,
  modelLabel,
  type AgentProvider,
} from "@/lib/agent/providers";
import { resolveModel, serverSelection, serverModelChoices, isSelectableModel, isAgentConfigured, readProvider } from "@/lib/agent/model";
import { readUserCredential, readModelChoice, KEY_HEADER, PROVIDER_HEADER, MODEL_HEADER } from "@/lib/agent/credentials";
import { AgentBadRequestError, AgentNotConfiguredError } from "@/lib/agent/errors";
import { RateLimiter, clientAddress } from "@/lib/agent/ratelimit";

const FAKE_KEY = "test-key-not-a-real-credential-0000";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("provider registry integrity", () => {
  it("has unique provider ids and at least one model each", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDER_IDS).toEqual(ids);
    for (const provider of PROVIDERS) {
      expect(provider.models.length).toBeGreaterThan(0);
      const modelIds = provider.models.map((model) => model.id);
      expect(new Set(modelIds).size).toBe(modelIds.length);
    }
  });

  it("gives every provider a key source, a docs link and a key link", () => {
    for (const provider of PROVIDERS) {
      expect(provider.envKeys.length).toBeGreaterThan(0);
      for (const key of provider.envKeys) expect(key).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(provider.docsUrl).toMatch(/^https:\/\//);
      expect(provider.keyUrl).toMatch(/^https:\/\//);
      expect(provider.keyHint.length).toBeGreaterThan(10);
    }
  });

  it("dates and sources every free tier claim", () => {
    for (const provider of PROVIDERS) {
      expect(provider.freeTier.source).toMatch(/^https:\/\//);
      expect(provider.freeTier.readOn).toBe(FREE_TIER_VERIFIED_ON);
      expect(provider.freeTier.summary.length).toBeGreaterThan(20);
    }
  });

  it("never marks a model free under a provider that has no free tier", () => {
    for (const provider of PROVIDERS) {
      if (provider.freeTier.available) continue;
      expect(provider.models.every((model) => !model.free)).toBe(true);
    }
  });

  it("explains every model, so the UI never shows a bare id", () => {
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        expect(model.label.length).toBeGreaterThan(2);
        expect(model.notes.length).toBeGreaterThan(20);
      }
    }
  });

  it("writes no em-dashes into user facing registry text", () => {
    // A house rule for this repo, and the registry is the biggest block of
    // prose that reaches the UI straight out of source.
    const prose = PROVIDERS.flatMap((provider) => [
      provider.label,
      provider.keyHint,
      provider.freeTier.summary,
      ...provider.models.flatMap((model) => [model.label, model.notes]),
    ]).join("\n");
    expect(prose).not.toContain("—");
  });

  it("keeps the Hugging Face entry pointed at models the router says take tools", () => {
    // The router publishes supports_tools per model at
    // https://router.huggingface.co/v1/models. Nothing there is priced at zero,
    // so the free tier is the monthly credit and every model note has to say
    // roughly how far that credit goes rather than implying it is unlimited.
    const hf = findProvider("huggingface");
    expect(hf).not.toBeNull();
    expect(hf?.freeTier.available).toBe(true);
    expect(hf?.freeTier.summary).toContain("$0.10");
    for (const model of hf?.models ?? []) {
      expect(model.notes).toMatch(/\$0?\.\d|credit|questions/);
    }
  });

  it("resolves lookups and rejects anything unlisted", () => {
    expect(findProvider("google")?.id).toBe("google");
    expect(findProvider("not-a-provider")).toBeNull();
    expect(findProvider(null)).toBeNull();
    expect(findModel("google", "gemini-3.5-flash")?.free).toBe(true);
    expect(findModel("google", "gpt-4")).toBeNull();
    expect(isSupported("anthropic", "claude-opus-5")).toBe(true);
    expect(isSupported("anthropic", "claude-opus-4")).toBe(false);
    expect(modelLabel("groq", "openai/gpt-oss-120b")).toBe("groq:openai/gpt-oss-120b");
  });

  it("defaults each provider to one of its own models, preferring a free one", () => {
    for (const provider of PROVIDERS) {
      const fallback = defaultModelFor(provider.id);
      const model = findModel(provider.id, fallback);
      expect(model).not.toBeNull();
      if (provider.models.some((candidate) => candidate.free)) {
        expect(model?.free).toBe(true);
      }
    }
  });

  it("can build a client for every registry provider, so no id lacks a branch", async () => {
    // This is the test that stops the registry and the switch in model.ts from
    // drifting apart: adding a provider entry without a client branch fails here.
    for (const provider of PROVIDERS) {
      const modelId = defaultModelFor(provider.id);
      const resolved = await resolveModel({}, { provider: provider.id, modelId, apiKey: FAKE_KEY });
      expect(resolved.provider).toBe(provider.id);
      expect(resolved.modelId).toBe(modelId);
      expect(resolved.source).toBe("user");
      expect(resolved.model).toBeTruthy();
      expect(resolved.instructions("system prompt").role).toBe("system");
    }
  });

  it("marks the system prompt as cacheable for Anthropic only", async () => {
    const anthropic = await resolveModel({}, { provider: "anthropic", modelId: "claude-opus-5", apiKey: FAKE_KEY });
    expect(anthropic.instructions("s")).toHaveProperty("providerOptions.anthropic.cacheControl");

    const google = await resolveModel({}, { provider: "google", modelId: "gemini-3.5-flash", apiKey: FAKE_KEY });
    expect(google.instructions("s")).not.toHaveProperty("providerOptions");
  });
});

describe("credential headers", () => {
  it("returns null when the caller sends nothing", () => {
    expect(readUserCredential(headers({}))).toBeNull();
  });

  it("parses a complete credential", () => {
    const credential = readUserCredential(
      headers({
        [KEY_HEADER]: FAKE_KEY,
        [PROVIDER_HEADER]: "google",
        [MODEL_HEADER]: "gemini-3.5-flash",
      }),
    );
    expect(credential).toEqual({ provider: "google", modelId: "gemini-3.5-flash", apiKey: FAKE_KEY });
  });

  it("falls back to the provider's free default when no model is named", () => {
    const credential = readUserCredential(headers({ [KEY_HEADER]: FAKE_KEY, [PROVIDER_HEADER]: "groq" }));
    expect(credential?.modelId).toBe(defaultModelFor("groq"));
  });

  it("normalises a provider id that arrives with different casing or padding", () => {
    const credential = readUserCredential(
      headers({ [KEY_HEADER]: FAKE_KEY, [PROVIDER_HEADER]: "  Vercel-AI-Gateway  " }),
    );
    expect(credential?.provider).toBe("vercel-ai-gateway");
  });

  it("refuses a provider header without a key, because switching provider means switching who pays", () => {
    expect(() => readUserCredential(headers({ [PROVIDER_HEADER]: "anthropic" }))).toThrow(AgentBadRequestError);
  });

  it("allows a bare model header, which is the dropdown, and reads it as a choice", () => {
    // No credential is produced: the model is only a preference until resolveModel checks it
    // against what this deployment actually offers.
    expect(readUserCredential(headers({ [MODEL_HEADER]: "gpt-4.1-mini" }))).toBeNull();
    expect(readModelChoice(headers({ [MODEL_HEADER]: "gpt-4.1-mini" }))).toBe("gpt-4.1-mini");
  });

  it("ignores the model header when the caller brought their own key", () => {
    // With a key the model belongs to the credential, not to the dropdown, so the two cannot
    // disagree about which model was asked for.
    const withKey = headers({ [KEY_HEADER]: FAKE_KEY, [PROVIDER_HEADER]: "google", [MODEL_HEADER]: "gemini-3.5-flash" });
    expect(readModelChoice(withKey)).toBeNull();
  });

  it("refuses a key with no provider", () => {
    expect(() => readUserCredential(headers({ [KEY_HEADER]: FAKE_KEY }))).toThrow(/must also send/);
  });

  it("refuses an unknown provider and an unlisted model", () => {
    // deliberately not a real vendor name: "openai" used to stand in here and became a listed
    // provider, which quietly turned this assertion into a test of nothing
    expect(() =>
      readUserCredential(headers({ [KEY_HEADER]: FAKE_KEY, [PROVIDER_HEADER]: "definitely-not-a-provider" })),
    ).toThrow(/Unknown provider/);
    expect(() =>
      readUserCredential(
        headers({ [KEY_HEADER]: FAKE_KEY, [PROVIDER_HEADER]: "google", [MODEL_HEADER]: "gemini-9-ultra" }),
      ),
    ).toThrow(/not one this build supports/);
  });

  it("refuses key shapes that are not credentials, without quoting the value", () => {
    const tooShort = "abc";
    try {
      readUserCredential(headers({ [KEY_HEADER]: tooShort, [PROVIDER_HEADER]: "google" }));
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentBadRequestError);
      expect((error as Error).message).not.toContain(tooShort);
    }

    expect(() =>
      readUserCredential(headers({ [KEY_HEADER]: "x".repeat(600), [PROVIDER_HEADER]: "google" })),
    ).toThrow(/longer than/);
  });
});

describe("server selection and the per request override", () => {
  it("reports nothing configured when the environment has no key", () => {
    expect(serverSelection({})).toBeNull();
    expect(isAgentConfigured({})).toBe(false);
    // The label still has to say something truthful about what would run.
    expect(PROVIDER_IDS).toContain(readProvider({}));
  });

  it("picks up any registry provider from its own environment variable", () => {
    expect(serverSelection({ GOOGLE_GENERATIVE_AI_API_KEY: FAKE_KEY })).toMatchObject({
      provider: "google",
      envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    });
    expect(serverSelection({ GROQ_API_KEY: FAKE_KEY })).toMatchObject({ provider: "groq" });
    expect(serverSelection({ AI_GATEWAY_API_KEY: FAKE_KEY })).toMatchObject({ provider: "vercel-ai-gateway" });
    expect(serverSelection({ ANTHROPIC_API_KEY: FAKE_KEY })).toMatchObject({ provider: "anthropic" });
    expect(serverSelection({ AWS_BEARER_TOKEN_BEDROCK: FAKE_KEY })).toMatchObject({ provider: "bedrock" });
  });

  it("treats an AWS access key pair as a Bedrock configuration with no pasted key", () => {
    const selection = serverSelection({ AWS_ACCESS_KEY_ID: "AKIA0000000000000000", AWS_SECRET_ACCESS_KEY: "s" });
    expect(selection).toMatchObject({ provider: "bedrock", envKey: "AWS_ACCESS_KEY_ID" });
    // SigV4 is resolved by the SDK, so there is no single string to carry.
    expect(selection?.apiKey).toBeUndefined();
  });

  it("honours AGENT_PROVIDER, and refuses to silently use a different provider's key", () => {
    expect(serverSelection({ AGENT_PROVIDER: "groq", GROQ_API_KEY: FAKE_KEY })).toMatchObject({ provider: "groq" });
    // AGENT_PROVIDER names groq but only Anthropic has a key: that is a
    // misconfiguration, and falling through to Anthropic would hide it.
    expect(serverSelection({ AGENT_PROVIDER: "groq", ANTHROPIC_API_KEY: FAKE_KEY })).toBeNull();
  });

  it("honours AGENT_MODEL, and ignores one that belongs to another provider", () => {
    expect(serverSelection({ GROQ_API_KEY: FAKE_KEY, AGENT_MODEL: "openai/gpt-oss-20b" })?.modelId).toBe(
      "openai/gpt-oss-20b",
    );
    expect(serverSelection({ GROQ_API_KEY: FAKE_KEY, AGENT_MODEL: "claude-opus-5" })?.modelId).toBe(
      defaultModelFor("groq"),
    );
  });

  it("lets a visitor's key beat a configured server default", async () => {
    // The whole point of the feature: someone who brings a key gets their
    // model, not the one the deployment pays for.
    const env = { ANTHROPIC_API_KEY: "server-side-key-value-000000" };
    expect(serverSelection(env)).toMatchObject({ provider: "anthropic", modelId: "claude-opus-5" });

    const fromServer = await resolveModel(env);
    expect(fromServer.provider).toBe("anthropic");
    expect(fromServer.source).toBe("server");

    const fromUser = await resolveModel(env, {
      provider: "google",
      modelId: "gemini-3.7-flash",
      apiKey: FAKE_KEY,
    });
    expect(fromUser.provider).toBe("google");
    expect(fromUser.modelId).toBe("gemini-3.7-flash");
    expect(fromUser.source).toBe("user");
  });

  it("throws the typed not-configured error when there is neither", async () => {
    await expect(resolveModel({})).rejects.toBeInstanceOf(AgentNotConfiguredError);
  });

  it("re-checks the registry even when called directly", async () => {
    await expect(
      resolveModel({}, { provider: "google" as AgentProvider, modelId: "not-a-model", apiKey: FAKE_KEY }),
    ).rejects.toBeInstanceOf(AgentBadRequestError);
  });
});

describe("per address rate limiting", () => {
  it("allows up to the limit, then refuses with a retry hint", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    expect(limiter.check("1.2.3.4")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check("1.2.3.4")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("1.2.3.4")).toMatchObject({ allowed: true, remaining: 0 });

    const refused = limiter.check("1.2.3.4");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // A different address has its own budget.
    expect(limiter.check("5.6.7.8").allowed).toBe(true);

    // The window rolls over.
    now += 60_001;
    expect(limiter.check("1.2.3.4")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("reads the leftmost forwarded address, and buckets unknown callers together", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(new Headers({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    // Stripping the headers must not buy a private budget.
    expect(clientAddress(new Headers({}))).toBe("unknown");
  });
});

describe("the model dropdown is bounded to what the server will pay for", () => {
  const SERVER = { OPENAI_API_KEY: FAKE_KEY } as unknown as NodeJS.ProcessEnv;

  it("offers the configured provider's models and nothing else", () => {
    const ids = serverModelChoices(SERVER).map((choice) => choice.id);
    expect(ids).toContain("gpt-4.1-mini");
    // never another vendor's catalogue, whatever a header asks for
    expect(ids.some((id) => id.startsWith("claude") || id.startsWith("gemini"))).toBe(false);
  });

  it("AGENT_MODEL_CHOICES narrows the list further", () => {
    const ids = serverModelChoices({ ...SERVER, AGENT_MODEL_CHOICES: "gpt-4.1-mini" }).map((c) => c.id);
    expect(ids).toEqual(["gpt-4.1-mini"]);
    expect(isSelectableModel("gpt-5", { ...SERVER, AGENT_MODEL_CHOICES: "gpt-4.1-mini" })).toBe(false);
  });

  it("refuses a model the deployment does not offer, so a header cannot pick an arbitrary one", async () => {
    // the whole point of the bound: a public endpoint on a billed key
    await expect(resolveModel(SERVER, null, "gpt-5-pro-max-expensive")).rejects.toThrow(/not one this deployment offers/);
    expect(isSelectableModel("claude-opus-5", SERVER)).toBe(false);
  });

  it("offers nothing when the server has no key at all", () => {
    expect(serverModelChoices({})).toEqual([]);
  });
});
