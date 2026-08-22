/**
 * The provider switch.
 *
 * Every provider goes through the Vercel AI SDK, so the agent loop, the five
 * tools and the response contract are identical whichever one answers. Adding
 * a provider is one entry in the registry (providers.ts) plus one branch in
 * `createProviderModel` below. Nothing else in the agent knows or cares.
 *
 * There are two ways a model gets chosen, and they are not equal:
 *
 *   1. A visitor's own credential, arriving per request in the `x-llm-api-key`
 *      header (see credentials.ts). It is used to build one client for one
 *      request and is then dropped. It is never stored, never logged, never
 *      returned. This is the primary path.
 *
 *   2. The server environment, when one is configured. Read from the registry's
 *      `envKeys`, so the server can be pointed at any listed provider:
 *
 *        AGENT_PROVIDER   one of the registry ids, optional. When unset, the
 *                         first provider with a key present in the environment
 *                         wins, in registry order.
 *        AGENT_MODEL      model id, optional. Must be listed for the provider.
 *        <provider key>   GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY,
 *                         OPENROUTER_API_KEY, CEREBRAS_API_KEY, HF_TOKEN,
 *                         AI_GATEWAY_API_KEY,
 *                         ANTHROPIC_API_KEY, AWS_BEARER_TOKEN_BEDROCK, ...
 *
 * A server key on a public, unauthenticated route is a bill waiting to happen,
 * so path 2 is only safe with a ceiling on it. That ceiling is not here: it is
 * in ratelimit.ts, which reads the selection this module returns, works out
 * from the registry whether the chosen model is billed, and bounds what every
 * keyless caller together can spend before the route will run one. This module
 * stays a pure switch, so nothing about which provider answers depends on a
 * spend rule and nothing about the spend rule depends on a provider branch.
 *
 * With nothing configured at all the route answers 501 and says so, and the
 * x-llm-api-key header is the way in. Setting one env var flips path 2 on
 * without another code change, which is exactly why the ceiling has to apply
 * itself rather than wait to be switched on too.
 */

import type { Env } from "./types";
import type { LanguageModel, SystemModelMessage } from "ai";
import { NOT_CONFIGURED_MESSAGE } from "./types";
import { AgentBadRequestError, AgentNotConfiguredError } from "./errors";
import type { UserCredential } from "./credentials";
import {
  PROVIDERS,
  findModel,
  findProvider,
  defaultModelFor,
  type AgentProvider,
  type ProviderDefinition,
} from "./providers";

export { AgentNotConfiguredError } from "./errors";
export type { AgentProvider } from "./providers";

export interface ResolvedModel {
  provider: AgentProvider;
  modelId: string;
  model: LanguageModel;
  /** Whose credential built this client. Drives error wording, not behaviour. */
  source: "user" | "server";
  /** Wrap the system prompt with the provider's cache marker. */
  instructions: (system: string) => SystemModelMessage;
}

/** Where the server would look, and what it would run, if it is configured. */
export interface ServerSelection {
  provider: AgentProvider;
  modelId: string;
  /** Which environment variable supplied the credential. Name only, never the value. */
  envKey: string;
  /** The credential itself. Absent for Bedrock SigV4, which the SDK resolves itself. */
  apiKey?: string;
}

/**
 * Reported by GET /api/agent when nothing at all is configured, so the label
 * has something truthful to say about what the server would run.
 */
export const FALLBACK_PROVIDER: AgentProvider = "openrouter";

/** Kept for callers that only want a provider id. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5";

function firstConfiguredEnvKey(provider: ProviderDefinition, env: Env): string | null {
  for (const key of provider.envKeys) {
    if (env[key]?.trim()) return key;
  }
  // Bedrock also authenticates through a long lived access key pair.
  if (provider.id === "bedrock" && env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return "AWS_ACCESS_KEY_ID";
  }
  return null;
}

/**
 * What the server environment configures, or null when it configures nothing.
 *
 * An explicit AGENT_PROVIDER is honoured only if that provider actually has a
 * credential present. Naming a provider without giving it a key is a
 * misconfiguration, and silently falling through to a different provider's key
 * would hide it, so that case returns null and the route reports 501.
 */
export function serverSelection(env: Env = process.env): ServerSelection | null {
  const named = env.AGENT_PROVIDER?.trim().toLowerCase();
  const candidates = named ? [findProvider(named)].filter((p): p is ProviderDefinition => p !== null) : [...PROVIDERS];

  for (const provider of candidates) {
    const envKey = firstConfiguredEnvKey(provider, env);
    if (!envKey) continue;

    const requested = env.AGENT_MODEL?.trim();
    // An AGENT_MODEL that belongs to a different provider is ignored rather
    // than fatal, so setting the pair in the wrong order still boots.
    const modelId = requested && findModel(provider.id, requested) ? requested : defaultModelFor(provider.id);

    return {
      provider: provider.id,
      modelId,
      envKey,
      apiKey: envKey === "AWS_ACCESS_KEY_ID" ? undefined : env[envKey]?.trim(),
    };
  }
  return null;
}

/** True when the server can answer without the caller supplying a key. */
export function isAgentConfigured(env: Env = process.env): boolean {
  return serverSelection(env) !== null;
}

/** The provider the server would use. Falls back to a label when unconfigured. */
export function readProvider(env: Env = process.env): AgentProvider {
  return serverSelection(env)?.provider ?? FALLBACK_PROVIDER;
}

/** Anthropic and Bedrock get prompt caching; the rest take the system prompt plain. */
function instructionsFor(provider: AgentProvider): (system: string) => SystemModelMessage {
  if (provider === "anthropic") {
    // The system prompt plus tool definitions are the stable prefix of every
    // turn in a session, so this is where cache reads pay off.
    return (system) => ({
      role: "system",
      content: system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  }
  return (system) => ({ role: "system", content: system });
}

/**
 * OpenRouter free models draw on a shared pool that returns 429 without
 * warning. Measured on 2026-08-21: of six free models, four answered and two
 * (GLM 5.2 and Gemma 4 31B) came back "temporarily rate-limited upstream"
 * within the same minute, and which two it is rotates.
 *
 * A single free model is therefore not a dependable default, and retrying it is
 * pointless because the pool, not the account, is exhausted. OpenRouter answers
 * this with a `models` array: list alternates in priority order and it moves on
 * by itself on rate limiting or downtime, billing whatever actually ran.
 *
 * The AI SDK has no first class field for a provider specific body parameter,
 * so it is merged into the outgoing JSON here. Only `:free` models get the
 * treatment: someone who brought a key and deliberately chose a paid model
 * should get that model or an error, not a silent substitution.
 */
function openRouterFallbackFetch(modelId: string): typeof globalThis.fetch | undefined {
  if (!modelId.endsWith(":free")) return undefined;

  const alternates = (findProvider("openrouter")?.models ?? [])
    .map((model) => model.id)
    .filter((id) => id.endsWith(":free") && id !== modelId);
  if (alternates.length === 0) return undefined;

  // OpenRouter rejects more than three entries outright:
  //   400 "'models' array must have 3 items or fewer."
  // So it is the chosen model plus the next two free models in registry order,
  // not the whole list. Registry order is therefore also the fallback order.
  const chain = [modelId, ...alternates].slice(0, 3);

  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body.models = chain;
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // Not JSON we understand. Send it untouched rather than break the call.
      }
    }
    return globalThis.fetch(input, init);
  };
}

/**
 * Build the provider client. One branch per registry entry.
 *
 * Every provider package here accepts a plain `apiKey` string, which is what
 * makes the bring your own key path uniform. The import is dynamic so a
 * deployment only loads the SDK for the provider it is actually asked for.
 */
async function createProviderModel(
  provider: AgentProvider,
  modelId: string,
  apiKey: string | undefined,
  env: Env,
): Promise<LanguageModel> {
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({ apiKey })(modelId);
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      return createCerebras({ apiKey })(modelId);
    }
    case "openrouter": {
      // OpenAI compatible, same reasoning as Hugging Face below: OpenRouter's
      // own API is the OpenAI chat completions shape, and the per model
      // `supported_parameters` list it publishes at
      // https://openrouter.ai/api/v1/models describes that surface. There is a
      // third party @openrouter/ai-sdk-provider, but it is not an @ai-sdk/*
      // package, and this needs nothing it adds.
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        // OpenRouter attributes traffic by these two headers and surfaces the
        // app name on its dashboards. Neither carries anything sensitive.
        headers: {
          "HTTP-Referer": "https://duval-oracle-ui.vercel.app",
          "X-Title": "Duval County property intelligence",
        },
        fetch: openRouterFallbackFetch(modelId),
      })(modelId);
    }
    case "huggingface": {
      // Deliberately the OpenAI compatible client against the router's chat
      // completions endpoint, not the official @ai-sdk/huggingface provider.
      // That provider is responses-API only, and the tool support this agent
      // depends on is what the router publishes per model on
      // https://router.huggingface.co/v1/models as `supports_tools`, which
      // describes chat completions. Every Hugging Face example of tool calling
      // posts to /v1/chat/completions too. Using the responses path would mean
      // shipping a tool loop against an API surface whose per provider tool
      // coverage on this router is not documented. Switching back is one line
      // once it is.
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        name: "huggingface",
        baseURL: "https://router.huggingface.co/v1",
        apiKey,
      })(modelId);
    }
    case "vercel-ai-gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      return createGateway({ apiKey })(modelId);
    }
    case "bedrock": {
      const [{ createAmazonBedrock }, { withBedrockPromptCaching }] = await Promise.all([
        import("@ai-sdk/amazon-bedrock"),
        import("./bedrock-prompt-cache"),
      ]);
      // Without an apiKey the provider falls back to SigV4 over the ambient
      // AWS credentials, which is the only path here that is not a bare string.
      const bedrock = createAmazonBedrock({ apiKey, region: env.AWS_REGION?.trim() || "us-east-1" });
      return withBedrockPromptCaching(bedrock(modelId));
    }
    default: {
      // Exhaustiveness: a new registry id with no branch fails loudly here
      // rather than silently answering with the wrong model.
      const unreachable: never = provider;
      throw new AgentBadRequestError(`Provider "${String(unreachable)}" is in the registry but has no client branch.`);
    }
  }
}

/**
 * Resolve the model for one request.
 *
 * A visitor credential always wins over the server environment. That is the
 * whole point: someone who brings a key gets their model, not mine.
 */
/**
 * The models a visitor may pick without supplying their own key.
 *
 * Bounded on purpose. The endpoint is public and the server key is billed, so an arbitrary model id
 * from a header must never reach the provider: a stranger could otherwise point a paid key at the
 * most expensive model in the catalogue. The choices are the registry's entries for whichever
 * provider the server is configured with, and AGENT_MODEL_CHOICES can narrow that further to a
 * comma separated subset when a deployment wants a tighter cost ceiling.
 */
export function serverModelChoices(env: Env = process.env): { id: string; label: string }[] {
  const selection = serverSelection(env);
  if (!selection) return [];
  const provider = findProvider(selection.provider);
  if (!provider) return [];

  const allowed = env.AGENT_MODEL_CHOICES?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return provider.models
    .filter((model) => (allowed && allowed.length > 0 ? allowed.includes(model.id) : true))
    .map((model) => ({ id: model.id, label: model.label }));
}

/** True when `modelId` is one the server will run on its own key. */
export function isSelectableModel(modelId: string, env: Env = process.env): boolean {
  return serverModelChoices(env).some((choice) => choice.id === modelId);
}

export async function resolveModel(
  env: Env = process.env,
  credential?: UserCredential | null,
  /** A model the caller picked from the dropdown; only honoured against the server's own choices. */
  modelOverride?: string | null,
): Promise<ResolvedModel> {
  if (credential) {
    // credentials.ts already checked the pair against the registry; re-check
    // here so a direct caller of resolveModel cannot skip the gate.
    if (!findModel(credential.provider, credential.modelId)) {
      throw new AgentBadRequestError(
        `Model "${credential.modelId}" is not supported for provider "${credential.provider}".`,
      );
    }
    return {
      provider: credential.provider,
      modelId: credential.modelId,
      source: "user",
      model: await createProviderModel(credential.provider, credential.modelId, credential.apiKey, env),
      instructions: instructionsFor(credential.provider),
    };
  }

  const selection = serverSelection(env);
  if (!selection) throw new AgentNotConfiguredError(NOT_CONFIGURED_MESSAGE);

  const picked = modelOverride?.trim();
  if (picked && !isSelectableModel(picked, env)) {
    throw new AgentBadRequestError(
      `Model "${picked}" is not one this deployment offers. See GET /api/agent for the selectable list.`,
    );
  }
  const modelId = picked || selection.modelId;

  return {
    provider: selection.provider,
    modelId,
    source: "server",
    model: await createProviderModel(selection.provider, modelId, selection.apiKey, env),
    instructions: instructionsFor(selection.provider),
  };
}
