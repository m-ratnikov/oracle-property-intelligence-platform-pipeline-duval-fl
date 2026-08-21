/**
 * Bedrock prompt caching as AI SDK middleware, ported from the kit's
 * build-ai-agents rule (implementation-bedrock-prompt-caching.md): cache point
 * on the first system message and on the last non system message, cache
 * read/write tokens logged, nothing added to tool definitions.
 *
 * Only used when AGENT_PROVIDER=bedrock. The Anthropic provider path uses
 * `cacheControl` on the system message instead (see model.ts).
 */

import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { logAgent } from "./log";

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type CallParams = Parameters<TransformParams>[0]["params"];
type PromptMessage = CallParams["prompt"][number];

const BEDROCK_CACHE_POINT = { type: "default" as const };

export const BEDROCK_PROMPT_CACHE_METADATA = {
  bedrock_prompt_caching: true,
  bedrock_prompt_cache_strategy: "system_and_last_non_system",
  bedrock_prompt_cache_ttl: "default",
  bedrock_prompt_cache_tool_config: false,
} as const;

function withCachePoint(message: PromptMessage): PromptMessage {
  const providerOptions = message.providerOptions ?? {};
  const bedrockOptions =
    typeof providerOptions.bedrock === "object" && providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};
  return {
    ...message,
    providerOptions: {
      ...providerOptions,
      bedrock: { ...bedrockOptions, cachePoint: BEDROCK_CACHE_POINT },
    },
  } as PromptMessage;
}

export function applyBedrockPromptCaching<T extends { role: string; providerOptions?: unknown }>(
  prompt: T[],
): { prompt: T[]; cachePointsAdded: number } {
  const targets = new Set<number>();
  const firstSystem = prompt.findIndex((message) => message.role === "system");
  if (firstSystem >= 0) targets.add(firstSystem);
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role !== "system") {
      targets.add(index);
      break;
    }
  }
  if (targets.size === 0) return { prompt, cachePointsAdded: 0 };
  return {
    prompt: prompt.map((message, index) =>
      targets.has(index) ? (withCachePoint(message as unknown as PromptMessage) as unknown as T) : message,
    ),
    cachePointsAdded: targets.size,
  };
}

function logCacheUsage(usage: unknown): void {
  const input = (usage as { inputTokens?: { cacheRead?: number; cacheWrite?: number } } | undefined)
    ?.inputTokens;
  const cacheRead = input?.cacheRead ?? 0;
  const cacheWrite = input?.cacheWrite ?? 0;
  if (cacheRead <= 0 && cacheWrite <= 0) return;
  logAgent("info", "bedrock prompt cache usage", {
    bedrockPromptCacheReadInputTokens: cacheRead,
    bedrockPromptCacheWriteInputTokens: cacheWrite,
  });
}

export function withBedrockPromptCaching(model: LanguageModel): LanguageModel {
  if (typeof model === "string") return model;
  const middleware: LanguageModelMiddleware = {
    transformParams: async ({ params }) => ({
      ...params,
      prompt: applyBedrockPromptCaching(params.prompt).prompt,
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      logCacheUsage(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if ((chunk as { type?: string }).type === "finish") {
              logCacheUsage((chunk as { usage?: unknown }).usage);
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return { ...result, stream };
    },
  };
  return wrapLanguageModel({ model, middleware });
}
