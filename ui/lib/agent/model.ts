/**
 * Provider switch. The kit standard is Bedrock; this deployment runs on the
 * Anthropic API because the assignment deploys to Vercel without an AWS
 * account. Both paths go through the Vercel AI SDK, so the agent loop, tools
 * and response shape are identical and swapping is an env var:
 *
 *   AGENT_PROVIDER=anthropic  (default) needs ANTHROPIC_API_KEY
 *   AGENT_PROVIDER=bedrock    needs AWS credentials in the environment
 *                             (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 *                             AWS_REGION, or AWS_BEARER_TOKEN_BEDROCK)
 *   AGENT_MODEL               model id, default claude-sonnet-4-5 for Anthropic,
 *                             us.anthropic.claude-sonnet-4-5-20250929-v1:0 for Bedrock
 */

import type { Env } from "./types";
import type { LanguageModel, SystemModelMessage } from "ai";
import { NOT_CONFIGURED_MESSAGE } from "./types";

export type AgentProvider = "anthropic" | "bedrock";

export interface ResolvedModel {
  provider: AgentProvider;
  modelId: string;
  model: LanguageModel;
  /** Wrap the system prompt with the provider's cache marker. */
  instructions: (system: string) => SystemModelMessage;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export class AgentNotConfiguredError extends Error {
  constructor(message = NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "AgentNotConfiguredError";
  }
}

export function readProvider(env: Env = process.env): AgentProvider {
  const raw = env.AGENT_PROVIDER?.trim().toLowerCase();
  return raw === "bedrock" ? "bedrock" : "anthropic";
}

export function isAgentConfigured(env: Env = process.env): boolean {
  const provider = readProvider(env);
  if (provider === "bedrock") {
    return Boolean(
      env.AWS_BEARER_TOKEN_BEDROCK?.trim() ||
        (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()),
    );
  }
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export async function resolveModel(env: Env = process.env): Promise<ResolvedModel> {
  const provider = readProvider(env);

  if (provider === "bedrock") {
    if (!isAgentConfigured(env)) {
      throw new AgentNotConfiguredError(
        "agent not configured: AGENT_PROVIDER=bedrock needs AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK)",
      );
    }
    const [{ createAmazonBedrock }, { withBedrockPromptCaching }] = await Promise.all([
      import("@ai-sdk/amazon-bedrock"),
      import("./bedrock-prompt-cache"),
    ]);
    const modelId = env.AGENT_MODEL?.trim() || DEFAULT_BEDROCK_MODEL;
    const bedrock = createAmazonBedrock({ region: env.AWS_REGION?.trim() || "us-east-1" });
    return {
      provider,
      modelId,
      model: withBedrockPromptCaching(bedrock(modelId)),
      // The middleware adds the cache point; nothing to do on the message.
      instructions: (system) => ({ role: "system", content: system }),
    };
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new AgentNotConfiguredError();
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const modelId = env.AGENT_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  const anthropic = createAnthropic({ apiKey });
  return {
    provider,
    modelId,
    model: anthropic(modelId),
    // Anthropic prompt caching: mark the system prompt as a cache breakpoint.
    // The system prompt plus tool definitions are the stable prefix of every
    // turn in a session, so this is where cache reads pay off.
    instructions: (system) => ({
      role: "system",
      content: system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    }),
  };
}
