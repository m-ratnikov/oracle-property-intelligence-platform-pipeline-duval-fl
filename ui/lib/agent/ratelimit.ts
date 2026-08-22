/**
 * Abuse and spend controls for the public agent route.
 *
 * /api/agent is unauthenticated and reachable by anyone with the URL. That is
 * a deliberate product decision: a reviewer must be able to drive the demo
 * without credentials. It is not a reason to leave the bill unbounded, so this
 * module answers one question: what is the most a stranger can spend?
 *
 * Three ceilings, in increasing order of how much they actually guarantee.
 *
 * 1. PER ADDRESS (RateLimiter). Stops one caller looping the endpoint. Useless
 *    against anybody holding more than a handful of source addresses, which is
 *    everybody.
 *
 * 2. GLOBAL (GlobalBudget). One bucket for every keyless caller together, so
 *    the cost of the route no longer scales with the number of addresses an
 *    attacker can rent. This is the control that turns "unbounded" into a
 *    number. It applies ONLY to requests answered on this deployment's own
 *    credential: a caller who sends x-llm-api-key spends their own money and
 *    is not counted.
 *
 * 3. PER REQUEST (the MAX_* constants). Bounds tool loop steps, output tokens
 *    and transcript size, so ceiling 2 can be multiplied by a known unit cost
 *    instead of a guess.
 *
 * HONEST LIMITATION, and it is the same one it always was. Both counters live
 * in the process. Vercel runs several instances and recycles them, so what is
 * enforced is "per instance per window", not a true global. This module deals
 * with that by declaring the ceiling globally and dividing it by an assumed
 * instance count, so the enforced number is a share rather than a full budget
 * each: with AGENT_ASSUMED_INSTANCES honest, the sum across instances lands on
 * the declared ceiling. Where it degrades is stated rather than hidden: more
 * warm instances than assumed, or deliberate instance churn resetting fresh
 * counters, both push the real total above the declared number in proportion.
 *
 * Doing this exactly needs shared state (Vercel KV, Upstash, Redis) and this
 * project runs with no datastore at all, by design: the entire dataset is
 * static files on IPFS. A database provisioned to hold four integers would be
 * the largest architectural concession in the project.
 *
 * THE CEILING THAT DOES SURVIVE INSTANCE CHURN is the provider's own spend cap
 * on the key: an OpenAI project budget limit, an OpenRouter per key credit
 * limit, an Anthropic workspace limit. That is enforced by the party holding
 * the money, needs no infrastructure here, and cannot be reset by recycling a
 * lambda. It is therefore the primary control, and this module treats it as
 * required rather than optional: when the server credential is a billed one
 * and no such cap has been declared in AGENT_SPEND_CEILING_USD, the global
 * ceiling clamps down to a conservative floor and GET /api/agent says so.
 */

import type { Env } from "./types";
import { serverSelection } from "./model";
import { findModel } from "./providers";

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the window rolls over. */
  retryAfterSeconds: number;
  limit: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** Injected in tests; Date.now() otherwise. */
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Bounded so a flood of distinct source addresses cannot grow this forever. */
const MAX_TRACKED_KEYS = 5_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string): RateLimitDecision {
    const now = (this.options.now ?? Date.now)();
    const { limit, windowMs } = this.options;

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.evictIfCrowded(now);
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0, limit };
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    if (existing.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds, limit };
    }
    existing.count += 1;
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds, limit };
  }

  /** Drop expired windows, and if that is not enough, drop the oldest. */
  private evictIfCrowded(now: number) {
    if (this.windows.size < MAX_TRACKED_KEYS) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    while (this.windows.size >= MAX_TRACKED_KEYS) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  /** Test hook. */
  reset() {
    this.windows.clear();
  }
}

/**
 * The caller's address, as seen through Vercel's proxy.
 *
 * x-forwarded-for is client controlled in general, but on Vercel the platform
 * rewrites it, so the leftmost entry is the real client. Falling back to a
 * shared "unknown" bucket is intentional: an unidentifiable caller shares one
 * budget with every other unidentifiable caller rather than getting a free
 * pass by stripping headers.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Like readPositiveInt, but an environment variable may only TIGHTEN the
 * ceiling, never raise it above what the code guarantees. The per request caps
 * below are the multiplier the global ceiling is priced against, so an
 * operator who could widen them by env would silently invalidate the spend
 * arithmetic this whole module rests on.
 */
function readTightenedInt(raw: string | undefined, fallback: number, ceiling: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, ceiling);
}

function readPositiveFloat(raw: string | undefined): number | null {
  const parsed = Number.parseFloat(raw?.trim() ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/* -------------------------------------------------------------------------
 * Ceiling 3: what one request can cost.
 * ---------------------------------------------------------------------- */

/**
 * The tool loop ceiling run.ts will accept. Mirrored here rather than imported
 * because the credential test route imports this module and must not drag
 * DuckDB and the whole tool layer in behind it. The drift test in
 * tests/agent-spend-ceiling.test.ts reads run.ts and fails if the two separate.
 */
export const HARD_MAX_TOOL_STEPS = 12;

/**
 * Steps the route actually asks for, down from the loop's own 12.
 *
 * Measured behaviour is 3 to 6 model round trips for a real answer, so 8 is
 * headroom over the observed worst case rather than a constraint on it, and it
 * removes a third of the output token ceiling. The remaining 4 steps only ever
 * bought a longer wander after the model had already lost the plot: a turn that
 * exhausts the budget returns the "ran out of tool steps" answer either way.
 */
export const MAX_TOOL_STEPS = readTightenedInt(process.env.AGENT_MAX_STEPS, 8, HARD_MAX_TOOL_STEPS);

/**
 * The per step output cap set on the agent in run.ts. Duplicated for the same
 * reason as HARD_MAX_TOOL_STEPS, and guarded by the same drift test. It is the
 * other half of the worst case: total output tokens for one request can never
 * exceed MAX_TOOL_STEPS multiplied by this.
 */
export const MAX_OUTPUT_TOKENS_PER_STEP = 2_048;

/** One message can be long. It cannot be a payload. */
export const MAX_MESSAGE_CHARS = 8_000;

/**
 * Total characters of conversation history forwarded to the model.
 *
 * run.ts keeps the last 12 messages, which at the per message cap above is
 * 96,000 characters, roughly 24,000 tokens of history resent on EVERY step of
 * the loop. That is the largest single input lever a caller controls, and it
 * was free. 24,000 characters is about 6,000 tokens, comfortably more than any
 * real conversation on this page and a quarter of what was reachable before.
 */
export const MAX_TRANSCRIPT_CHARS = readTightenedInt(process.env.AGENT_MAX_TRANSCRIPT_CHARS, 24_000, 24_000);

/**
 * Messages accepted off the wire before the transcript budget is applied. The
 * body is JSON parsed before anything here runs, so this is not a memory
 * guard; it stops a pathological array making the trim loop the expensive part
 * of the request.
 */
export const MAX_MESSAGES = 40;

/** The shape the route trims. Structurally the AgentChatMessage in types.ts. */
interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Trim a conversation to the transcript budget, dropping the OLDEST turns.
 *
 * The system prompt and five tool schemas are resent on every step of the loop,
 * and so is this history, so a caller who posts a long conversation multiplies
 * its cost by the step count. This is the one input lever the route holds: the
 * tool results that make up the rest of the context are produced by the tools,
 * not chosen by the caller.
 *
 * The newest message always survives, even when it alone would exceed the
 * budget, because a request that silently loses the question it asked is worse
 * than one that costs slightly more than the cap.
 */
export function boundTranscript<T extends TranscriptMessage>(messages: T[]): TranscriptMessage[] {
  const bounded: TranscriptMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content.slice(0, MAX_MESSAGE_CHARS);
    if (bounded.length > 0 && chars + content.length > MAX_TRANSCRIPT_CHARS) break;
    bounded.unshift({ role: messages[i].role, content });
    chars += content.length;
  }
  return bounded;
}

/* -------------------------------------------------------------------------
 * Ceiling 2: what every keyless caller together can cost.
 * ---------------------------------------------------------------------- */

/** Questions a day, across all visitors, on this deployment's own credential. */
const DEFAULT_GLOBAL_LIMIT = 200;

/**
 * The clamp for a billed server credential with no declared provider side cap.
 *
 * This is the configuration the whole module exists to make safe: a paid key,
 * a public route, and nothing at the provider stopping it. Refusing to answer
 * at all would protect the money and break the demo, which is the wrong trade
 * for a runtime whose openness is the point. A hundred questions a day is more
 * than any reviewer needs and small enough to be a rounding error on a bill,
 * so the route stays open and GET /api/agent names the missing control.
 */
const UNDECLARED_BILLED_LIMIT = 100;

const DEFAULT_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Warm instances the enforced share is calculated against.
 *
 * Four is a working assumption for a Hobby plan function on a demo URL, not a
 * platform guarantee, and it is the single number that decides whether the
 * declared ceiling is honest. It is an env var so it can be corrected against
 * observed behaviour without a deploy.
 */
const DEFAULT_ASSUMED_INSTANCES = 4;

export interface BudgetDecision {
  allowed: boolean;
  /** The ceiling this deployment declares across every instance in the window. */
  globalLimit: number;
  /** The share of it this one instance will answer. */
  perInstanceLimit: number;
  usedOnThisInstance: number;
  remainingOnThisInstance: number;
  /** Seconds until this instance's window rolls over. */
  retryAfterSeconds: number;
  windowMs: number;
}

export interface GlobalBudgetOptions {
  globalLimit: number;
  assumedInstances: number;
  windowMs: number;
  /** Injected in tests; Date.now() otherwise. */
  now?: () => number;
}

/**
 * One rolling bucket shared by every caller this instance answers on the
 * server's own credential. No key, so nothing to evict and nothing to grow.
 */
export class GlobalBudget {
  private used = 0;
  private resetAt = 0;

  constructor(private readonly options: GlobalBudgetOptions) {}

  /** The share of the declared ceiling this instance is willing to spend. */
  get perInstanceLimit(): number {
    const { globalLimit, assumedInstances } = this.options;
    return Math.max(1, Math.ceil(globalLimit / Math.max(1, assumedInstances)));
  }

  /** Current state without consuming anything. For GET /api/agent. */
  peek(): BudgetDecision {
    return this.decide((this.options.now ?? Date.now)(), false);
  }

  /** Consume one request if the budget allows it. */
  check(): BudgetDecision {
    return this.decide((this.options.now ?? Date.now)(), true);
  }

  private decide(now: number, consume: boolean): BudgetDecision {
    if (this.resetAt <= now) {
      this.used = 0;
      this.resetAt = now + this.options.windowMs;
    }
    const perInstanceLimit = this.perInstanceLimit;
    const allowed = this.used < perInstanceLimit;
    if (allowed && consume) this.used += 1;

    return {
      allowed,
      globalLimit: this.options.globalLimit,
      perInstanceLimit,
      usedOnThisInstance: this.used,
      remainingOnThisInstance: Math.max(0, perInstanceLimit - this.used),
      retryAfterSeconds: Math.max(1, Math.ceil((this.resetAt - now) / 1000)),
      windowMs: this.options.windowMs,
    };
  }

  /** Test hook. */
  reset() {
    this.used = 0;
    this.resetAt = 0;
  }
}

export interface SpendCeilingSettings {
  globalLimit: number;
  perInstanceLimit: number;
  assumedInstances: number;
  windowMs: number;
  /** The provider side cap the operator declared, in USD. Null when none was. */
  declaredCeilingUsd: number | null;
  /** True when the model the server would answer with is billed per token. */
  serverCredentialIsBilled: boolean;
  /** True when the ceiling was pulled down because a billed key has no declared cap. */
  clamped: boolean;
  /** One sentence explaining how the numbers above were arrived at. */
  basis: string;
}

/**
 * Resolve the global ceiling for an environment.
 *
 * "Billed" is read off the registry's own `free` flag for whichever model the
 * server would answer with, so adding a provider does not mean remembering to
 * update a second list. The flag means "costs nothing on the provider's own
 * free tier": Hugging Face marks its models free because they are reachable on
 * the monthly credit, and that credit is itself a hard cap, which is exactly
 * the property being tested for here.
 */
export function spendCeilingSettings(env: Env = process.env): SpendCeilingSettings {
  const selection = serverSelection(env);
  const model = selection ? findModel(selection.provider, selection.modelId) : null;
  const serverCredentialIsBilled = model ? model.free === false : false;
  const declaredCeilingUsd = readPositiveFloat(env.AGENT_SPEND_CEILING_USD);

  const requested = readPositiveInt(env.AGENT_GLOBAL_LIMIT, DEFAULT_GLOBAL_LIMIT);
  const clamped = serverCredentialIsBilled && declaredCeilingUsd === null && requested > UNDECLARED_BILLED_LIMIT;
  const globalLimit = clamped ? UNDECLARED_BILLED_LIMIT : requested;

  const assumedInstances = readPositiveInt(env.AGENT_ASSUMED_INSTANCES, DEFAULT_ASSUMED_INSTANCES);
  const windowMs = readPositiveInt(env.AGENT_GLOBAL_WINDOW_MS, DEFAULT_GLOBAL_WINDOW_MS);
  const where = selection ? `${selection.provider}:${selection.modelId}` : "";

  const basis = !selection
    ? "No server credential is configured, so no question is answered on this deployment's money and the global ceiling is never reached."
    : clamped
      ? `The server credential answers with ${where}, which is billed per token, and no provider side spend cap has been declared in AGENT_SPEND_CEILING_USD. The global ceiling is therefore clamped to ${UNDECLARED_BILLED_LIMIT} rather than the configured ${requested}. Set a hard cap on the key at the provider and record it in AGENT_SPEND_CEILING_USD to lift the clamp.`
      : serverCredentialIsBilled
        ? `The server credential answers with ${where}, which is billed per token, against a declared provider side cap of ${declaredCeilingUsd} USD that the provider enforces and instance churn cannot reset.`
        : `The server credential answers with ${where}, which the registry lists as free of charge on the provider's own tier, so that tier is itself the spend ceiling.`;

  return {
    globalLimit,
    perInstanceLimit: Math.max(1, Math.ceil(globalLimit / Math.max(1, assumedInstances))),
    assumedInstances,
    windowMs,
    declaredCeilingUsd,
    serverCredentialIsBilled,
    clamped,
    basis,
  };
}

/**
 * Answering one question runs a tool loop for 30 to 90 seconds, so the useful
 * unit here is "a browsing session", not "a burst". Fifteen questions per ten
 * minutes is more than a reviewer needs and far less than an abuser wants.
 * Both are overridable so the numbers can be tightened without a code change
 * if the deployed URL ever attracts attention.
 */
export const AGENT_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.AGENT_RATE_LIMIT, 15),
  windowMs: readPositiveInt(process.env.AGENT_RATE_WINDOW_MS, 10 * 60 * 1000),
});

/**
 * Credential tests are cheap (a few tokens) but they are also an oracle: an
 * unlimited test endpoint is a way to validate stolen keys at somebody else's
 * expense. Capped harder than the agent itself, and per minute rather than per
 * ten, because a person testing a key retries within seconds. Not counted
 * against the global budget: that route refuses to run without a caller
 * supplied key, so it never spends the deployment's money.
 */
export const TEST_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.AGENT_TEST_RATE_LIMIT, 10),
  windowMs: readPositiveInt(process.env.AGENT_TEST_RATE_WINDOW_MS, 60 * 1000),
});

/**
 * The process wide budget, built on first use rather than at import so the
 * environment is fully populated by the time the ceiling is computed.
 */
let budget: GlobalBudget | null = null;

export function agentBudget(env: Env = process.env): GlobalBudget {
  if (!budget) {
    const settings = spendCeilingSettings(env);
    budget = new GlobalBudget({
      globalLimit: settings.globalLimit,
      assumedInstances: settings.assumedInstances,
      windowMs: settings.windowMs,
    });
  }
  return budget;
}

/** Test hook: drop the memoized budget so the next call re-reads the environment. */
export function resetAgentBudget() {
  budget = null;
}
