/**
 * The provider registry: one piece of data that both the server and the
 * settings UI read, so they can never disagree about what is supported.
 *
 * Everything downstream is derived from this array. `AgentProvider` is the
 * union of the ids below, GET /api/agent publishes the providers and their
 * models straight from it, and the server refuses any provider or model that
 * is not listed. Adding a provider means adding an entry here plus one branch
 * in `createProviderModel` in model.ts, not editing three places that drift.
 *
 * FREE TIER CLAIMS. Every `free: true` below was checked against the
 * provider's own published page on 2026-08-21 and the URL is recorded in
 * `freeTier.source`. These numbers move monthly. Re-read the sources before
 * trusting them: the labels here are a snapshot with a date on it, not a
 * promise, and the UI shows the date next to the claim for that reason.
 */

export type AgentProvider =
  | "openai"
  | "openrouter"
  | "google"
  | "groq"
  | "cerebras"
  | "huggingface"
  | "vercel-ai-gateway"
  | "anthropic"
  | "bedrock";

export interface ProviderModel {
  id: string;
  label: string;
  /** True when this model is usable at no cost on the provider's free tier. */
  free: boolean;
  /** The honest caveat: what the free tier actually gives, or why it costs. */
  notes: string;
}

export interface ProviderFreeTier {
  /** Free tier that needs no credit card at all. */
  available: boolean;
  /** One line describing the allowance, as published. */
  summary: string;
  /** The provider page the claim was read from. */
  source: string;
  /** ISO date the source was read. */
  readOn: string;
}

export interface ProviderDefinition {
  id: AgentProvider;
  label: string;
  /**
   * Server side environment variables that configure this provider without a
   * per request key. The first one present wins. These are read on the server
   * only and are never sent to the browser.
   */
  envKeys: string[];
  models: ProviderModel[];
  docsUrl: string;
  /** Where a visitor goes to mint a key for this provider. */
  keyUrl: string;
  /** False when the provider cannot be driven by a single pasted string. */
  acceptsUserKey: boolean;
  /** What the settings panel says above the key field. */
  keyHint: string;
  freeTier: ProviderFreeTier;
}

/** The date every free tier claim in this file was verified. */
export const FREE_TIER_VERIFIED_ON = "2026-08-21";

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    models: [
      {
        id: "gpt-5-mini",
        label: "GPT-5 mini",
        free: false,
        notes:
          "The default. Fast enough for a live demo and strong enough for multi step tool use, at a fraction of gpt-5. Listed first because defaultModelFor falls back to the first entry when a provider has no free model, and this is the one to land on.",
      },
      {
        id: "gpt-5",
        label: "GPT-5",
        free: false,
        notes: "Best answers on this list and the slowest of the three. Worth selecting for a hard question, not for a demo loop.",
      },
      {
        id: "gpt-4.1-mini",
        label: "GPT-4.1 mini",
        free: false,
        notes: "Previous generation, kept as a fallback if a GPT-5 id is ever rejected on an account.",
      },
    ],
    docsUrl: "https://platform.openai.com/docs/models",
    keyUrl: "https://platform.openai.com/api-keys",
    acceptsUserKey: true,
    keyHint: "An OpenAI key. Starts with sk- (project keys start with sk-proj-).",
    freeTier: {
      available: false,
      summary:
        "No free tier: usage is billed per token against prepaid credit, so a key here answers reliably rather than queueing behind a shared free pool. That is why it is the server default - the free providers below were measured returning 429 or timing out mid demo. Model ids were read from this account's own /v1/models on 2026-08-21 rather than assumed.",
      source: "https://platform.openai.com/docs/pricing",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKeys: ["OPENROUTER_API_KEY"],
    models: [
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        label: "Nemotron 3 Super 120B (free)",
        free: true,
        notes:
          "NVIDIA open weight, 262k context, $0.00 per token, tool calling confirmed against the live API on 2026-08-21. The default: the largest free model that answered on first try rather than a shared pool 429.",
      },
      {
        id: "nvidia/nemotron-3.5-lightning:free",
        label: "Nemotron 3.5 Lightning (free)",
        free: true,
        notes: "NVIDIA open weight, one million token context, $0.00 per token. Fastest of the set, confirmed answering live.",
      },
      {
        id: "openai/gpt-oss-20b:free",
        label: "GPT-OSS 20B (free)",
        free: true,
        notes:
          "Apache 2.0, the most genuinely open licensed model here, 131k context, $0.00 per token, tool calling confirmed live. Smallest of the set, so weakest at planning a multi step loop.",
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        label: "Nemotron 3 Ultra 550B (free)",
        free: true,
        notes: "NVIDIA open weight, one million token context, $0.00 per token. Biggest free model on the router and the slowest.",
      },
      {
        id: "z-ai/glm-5.2:free",
        label: "GLM 5.2 (free)",
        free: true,
        notes:
          "Open weight, 256k context, $0.00 per token, tool calling confirmed live. Was rate limited in the shared free pool when this list was built, which is why it is not the default.",
      },
      {
        id: "google/gemma-4-31b-it:free",
        label: "Gemma 4 31B (free)",
        free: true,
        notes:
          "Google open weight under the Gemma license, 262k context, $0.00 per token. Also rate limited in the shared free pool when this list was built.",
      },
    ],
    docsUrl: "https://openrouter.ai/docs/api-reference/limits",
    keyUrl: "https://openrouter.ai/settings/keys",
    acceptsUserKey: true,
    keyHint:
      "An OpenRouter key. Starts with sk-or-v1-. Free models also need prompt training enabled at openrouter.ai/settings/privacy, otherwise every call fails with \"No endpoints found matching your data policy\".",
    freeTier: {
      available: true,
      summary:
        "The :free model variants cost $0.00 per token, capped at 50 requests a day, or 1,000 a day once $10 of credits has ever been purchased. This agent spends 3 to 6 model calls per question, so that is roughly 12 questions a day free, or 250 after the one time $10. Two conditions: free models route only to providers that may train on the prompt, which has to be enabled in account settings, and they draw on a shared pool that returns 429 without warning, so a free model here is sent with the rest of this list as fallbacks.",
      source: "https://openrouter.ai/docs/api-reference/limits",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "google",
    label: "Google AI Studio (Gemini)",
    envKeys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      {
        id: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        free: true,
        notes:
          "MEASURED 2026-08-21 against the deployed agent: the only Gemini id here that completed a full question. Answers took 25 s to 116 s depending on free tier queueing, then returned 429 once the per minute quota was spent. Listed first because defaultModelFor picks the first free model.",
      },
      {
        id: "gemini-3.6-flash",
        label: "Gemini 3.6 Flash",
        free: true,
        notes:
          "The id Google's own 404 for gemini-2.5-flash tells you to move to. MEASURED 2026-08-21: returned \"This model is currently experiencing high demand\" on every attempt and failed the request after three retries. Worth retrying later; not dependable for a demo.",
      },
      {
        id: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash",
        free: true,
        notes:
          "MEASURED 2026-08-21: the provider call failed with an EMPTY error message and the SDK retried until the serverless function hit its 300 s ceiling. Kept listed because it may simply not be enabled on every account, but do not make it a default.",
      },
      {
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        free: true,
        notes:
          "Strongest free Gemini and the slowest. Google's free tier daily request cap is tightest here, so a demo can exhaust it.",
      },
    ],
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    keyUrl: "https://aistudio.google.com/apikey",
    acceptsUserKey: true,
    keyHint: "An AI Studio API key. Starts with AIza.",
    freeTier: {
      available: true,
      summary:
        "New accounts start on the free tier with no billing account and no card. Flash input and output tokens are listed as free of charge, subject to per model rate limits that are per minute as well as per day: this agent spends 3 to 6 model calls per question, so two questions in quick succession can trip the per minute quota and return 429. Model ids move quickly here - gemini-2.5-flash is already refused for new users - so treat any id as verifiable rather than permanent.",
      source: "https://ai.google.dev/gemini-api/docs/rate-limits",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "groq",
    label: "Groq",
    envKeys: ["GROQ_API_KEY"],
    models: [
      {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        free: true,
        notes:
          "Free tier published as 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day. MEASURED PROBLEM: by the third step of a typical answer this agent sends about 8,300 input tokens in a single request, which is already over the 8,000 per minute free tier ceiling, so a free Groq key cannot finish most questions. Usable on a paid Groq tier, not on the free one.",
      },
      {
        id: "openai/gpt-oss-20b",
        label: "GPT-OSS 20B",
        free: true,
        notes: "Same published free tier limits as the 120B, smaller and faster, weaker at multi step planning.",
      },
      {
        id: "qwen/qwen3.6-27b",
        label: "Qwen 3.6 27B",
        free: true,
        notes: "Same published free tier limits: 30 requests/min, 1,000 requests/day, 8,000 tokens/min.",
      },
    ],
    docsUrl: "https://console.groq.com/docs/rate-limits",
    keyUrl: "https://console.groq.com/keys",
    acceptsUserKey: true,
    keyHint: "A Groq console key. Starts with gsk_.",
    freeTier: {
      available: true,
      summary:
        "Free tier with published per model rate limits. The 8,000 tokens/min ceiling is below what one mid conversation request of this agent needs, so the free tier cannot complete most answers. See the model notes.",
      source: "https://console.groq.com/docs/rate-limits",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "cerebras",
    label: "Cerebras",
    envKeys: ["CEREBRAS_API_KEY"],
    models: [
      {
        id: "gpt-oss-120b",
        label: "GPT-OSS 120B",
        free: true,
        notes:
          "Cerebras gives $5 of signup credit rather than a recurring free allowance, so this runs free until that credit is spent.",
      },
      {
        id: "gemma-4-31b",
        label: "Gemma 4 31B",
        free: true,
        notes: "Second public endpoint model. Same $5 signup credit applies.",
      },
    ],
    docsUrl: "https://inference-docs.cerebras.ai/models/overview",
    keyUrl: "https://cloud.cerebras.ai",
    acceptsUserKey: true,
    keyHint: "A Cerebras Cloud key. Starts with csk-.",
    freeTier: {
      available: true,
      summary:
        "$5 in free credits after making an account. This is one time signup credit, not a monthly refresh, so it runs out.",
      source: "https://www.cerebras.ai/pricing",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    envKeys: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    models: [
      {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        free: true,
        notes:
          "Routed to deepinfra at $0.037 per million input and $0.17 per million output. A question here costs on the order of $0.0015, so the $0.10 monthly credit is roughly 60 questions. The best capability per credit of the four.",
      },
      {
        id: "deepseek-ai/DeepSeek-V4-Flash",
        label: "DeepSeek V4 Flash",
        free: true,
        notes:
          "$0.09 in / $0.18 out per million, and a one million token context. Roughly 30 questions on the monthly credit. Strongest reasoning of the four.",
      },
      {
        id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        label: "Qwen3 235B A22B Instruct",
        free: true,
        notes:
          "$0.09 in / $0.58 out per million. Roughly 25 questions on the monthly credit; the output price is what shortens it.",
      },
      {
        id: "Qwen/Qwen3-4B-Instruct-2507",
        label: "Qwen3 4B Instruct",
        free: true,
        notes:
          "$0.01 in / $0.03 out per million, so the monthly credit stretches to a few hundred questions. A 4B model is weak at planning a five tool loop, so expect it to answer without looking at the data. Test it before trusting it.",
      },
    ],
    docsUrl: "https://huggingface.co/docs/inference-providers/pricing",
    keyUrl: "https://huggingface.co/settings/tokens",
    acceptsUserKey: true,
    keyHint: "A Hugging Face user access token with inference permission. Starts with hf_.",
    freeTier: {
      available: true,
      summary:
        "$0.10 of routed inference credit a month for a free account, no card, refreshing monthly ($2.00 on PRO). One token reaches around 130 models across many inference providers. No model on the router is priced at zero, so the credit is the whole free tier.",
      source: "https://huggingface.co/docs/inference-providers/pricing",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    envKeys: ["AI_GATEWAY_API_KEY"],
    models: [
      {
        id: "poolside/laguna-s-2.1-free",
        label: "Poolside Laguna S 2.1 (free tier)",
        free: true,
        notes:
          "The only chat model in the Gateway free tier catalog tagged for tool use. The rest of that catalog is speech, transcription and Perplexity search, so it is the only free Gateway model this agent can drive at all.",
      },
      {
        id: "anthropic/claude-opus-5",
        label: "Claude Opus 5 (via Gateway)",
        free: false,
        notes: "Outside the free tier catalog. Needs purchased AI Gateway credits, billed at provider list price with no markup.",
      },
      {
        id: "google/gemini-3.7-flash",
        label: "Gemini 3.7 Flash (via Gateway)",
        free: false,
        notes: "Outside the free tier catalog. Cheaper per token than Opus, but still needs purchased credits.",
      },
    ],
    docsUrl: "https://vercel.com/docs/ai-gateway/pricing",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway",
    acceptsUserKey: true,
    keyHint: "An AI Gateway key from the Vercel dashboard. Starts with vck_.",
    freeTier: {
      available: true,
      summary:
        "$5 of monthly AI Gateway credit per team, but usable only on a subset of the catalog. That subset contains one tool calling chat model, which is why the Gateway is offered here as a choice rather than as the default.",
      source: "https://vercel.com/docs/ai-gateway/pricing",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        free: false,
        notes: "The quality option. Best multi step tool planning of anything here, and the most expensive per answer.",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        free: false,
        notes: "Trades some answer quality for latency, which matters when a turn already runs 30 to 90 seconds.",
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        free: false,
        notes: "Fastest and cheapest Claude. Weaker at planning a five tool loop unaided.",
      },
    ],
    docsUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
    keyUrl: "https://console.anthropic.com/settings/keys",
    acceptsUserKey: true,
    keyHint: "An Anthropic console key. Starts with sk-ant-.",
    freeTier: {
      available: false,
      summary: "No free tier. The console requires a prepaid balance before the first API call.",
      source: "https://docs.anthropic.com/en/api/rate-limits",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    envKeys: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID"],
    models: [
      {
        id: "anthropic.claude-opus-5",
        label: "Claude Opus 5 (Bedrock)",
        free: false,
        notes: "Bedrock ids carry an anthropic. prefix and no date suffix. Billed to the AWS account behind the token.",
      },
      {
        id: "anthropic.claude-sonnet-5",
        label: "Claude Sonnet 5 (Bedrock)",
        free: false,
        notes: "Same Bedrock billing, lower cost and latency than Opus.",
      },
    ],
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    acceptsUserKey: true,
    keyHint:
      "A Bedrock API key (bearer token). Long lived AWS access keys need SigV4 signing and cannot be pasted here; set them server side instead.",
    freeTier: {
      available: false,
      summary: "No free tier for these models. Usage bills to the AWS account that issued the token.",
      source: "https://aws.amazon.com/bedrock/pricing/",
      readOn: FREE_TIER_VERIFIED_ON,
    },
  },
] as const;

export const PROVIDER_IDS: readonly AgentProvider[] = PROVIDERS.map((provider) => provider.id);

export function findProvider(id: string | null | undefined): ProviderDefinition | null {
  if (!id) return null;
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function findModel(providerId: string | null | undefined, modelId: string | null | undefined) {
  const provider = findProvider(providerId);
  if (!provider || !modelId) return null;
  return provider.models.find((model) => model.id === modelId) ?? null;
}

/** True when the pair is one this build supports. The server gates on this. */
export function isSupported(providerId: string, modelId: string): boolean {
  return findModel(providerId, modelId) !== null;
}

/** The model a provider uses when the caller names the provider but not the model. */
export function defaultModelFor(providerId: AgentProvider): string {
  const provider = findProvider(providerId);
  if (!provider) throw new Error(`unknown provider: ${providerId}`);
  // Prefer the first free model so a caller who names only a provider does not
  // silently land on a billed one.
  return (provider.models.find((model) => model.free) ?? provider.models[0]).id;
}

/** `provider:model`, the string the AgentResponse reports and the UI shows. */
export function modelLabel(providerId: AgentProvider, modelId: string): string {
  return `${providerId}:${modelId}`;
}
