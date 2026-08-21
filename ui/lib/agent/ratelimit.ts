/**
 * Per IP rate limiting for the public agent route.
 *
 * /api/agent is unauthenticated and reachable by anyone with the URL. Whoever
 * pays for the tokens, that is a hole: a stranger can burn a server side key,
 * and even on a bring your own key deployment they can burn compute on a
 * function with a 300 second ceiling. So every caller is capped, including one
 * carrying their own key, because the cost being protected is not only tokens.
 *
 * HONEST LIMITATION. This counter lives in the process. Vercel runs several
 * instances and recycles them, so the real world cap is "N per instance per
 * window", not a global N. It raises the effort of draining the route by a lot
 * and it does not make it impossible. Doing this properly needs shared state
 * (Vercel KV, Upstash, Redis), and this app deliberately runs with no
 * datastore at all: the whole dataset is static files on IPFS. Adding a
 * database to hold rate counters would be the single biggest architectural
 * concession in the project, so the tradeoff is stated here rather than hidden
 * behind a claim of protection the code does not deliver.
 */

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
 * Answering one question runs a 12 step tool loop for 30 to 90 seconds, so the
 * useful unit here is "a browsing session", not "a burst". Fifteen questions
 * per ten minutes is more than a reviewer needs and far less than an abuser
 * wants. Both are overridable so the numbers can be tightened without a code
 * change if the deployed URL ever attracts attention.
 */
export const AGENT_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.AGENT_RATE_LIMIT, 15),
  windowMs: readPositiveInt(process.env.AGENT_RATE_WINDOW_MS, 10 * 60 * 1000),
});

/**
 * Credential tests are cheap (a few tokens) but they are also an oracle: an
 * unlimited test endpoint is a way to validate stolen keys at somebody else's
 * expense. Capped harder than the agent itself, and per minute rather than per
 * ten, because a person testing a key retries within seconds.
 */
export const TEST_RATE_LIMIT = new RateLimiter({
  limit: readPositiveInt(process.env.AGENT_TEST_RATE_LIMIT, 10),
  windowMs: readPositiveInt(process.env.AGENT_TEST_RATE_WINDOW_MS, 60 * 1000),
});
