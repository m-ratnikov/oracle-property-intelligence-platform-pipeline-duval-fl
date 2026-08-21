/** Polite HTTP helpers for portal-style sources: browser UA, retries, delay, bounded concurrency. */

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FetchJsonResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  text: string | null;
  error: string | null;
}

/** GET with a browser UA and bounded retries (429/5xx/network). Returns status + parsed JSON. */
export async function getJson<T = unknown>(
  url: string,
  opts: { fetchImpl?: typeof fetch; retries?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<FetchJsonResult<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  let last: FetchJsonResult<T> = { ok: false, status: 0, body: null, text: null, error: "not attempted" };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json,text/plain,*/*", ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        redirect: "follow",
      });
      const text = await res.text();
      let body: T | null = null;
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = null;
      }
      last = { ok: res.ok, status: res.status, body, text, error: res.ok ? null : `HTTP ${res.status}` };
      if (res.ok || (res.status < 500 && res.status !== 429)) return last;
    } catch (err) {
      last = { ok: false, status: 0, body: null, text: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  return last;
}

/** Probe a URL once (no retries beyond 1) to decide whether the source answers from this egress. */
export async function probeUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<{ reachable: boolean; status: number; error: string | null }> {
  const r = await getJson(url, { fetchImpl, retries: 1, timeoutMs: 20_000 });
  return { reachable: r.ok, status: r.status, error: r.error };
}

/** Run `items` through `worker` with at most `concurrency` in flight and `delayMs` between starts. */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  delayMs: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await worker(item, i);
      if (delayMs > 0) await sleep(delayMs);
    }
  });
  await Promise.all(lanes);
  return results;
}
