/**
 * Server side readers for the JSON artifacts next to the query table: the
 * run history and the per property open data JSON. Absolute URLs are fetched
 * (IPFS gateway in production); the browser's `/sample/...` fallbacks are read
 * from `public/` on disk so the same code runs in dev, tests and Vercel.
 */

import type { Env } from "./types";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRunHistory, sortRunsDesc, type PipelineRun, type RunHistory } from "@/lib/types";
import { SAMPLE_PATHS } from "@/lib/config";
import type { AgentDataFreshness } from "./types";

const PUBLIC_DIR = resolve(process.cwd(), "public");

export interface ArtifactLocation {
  /** URL or file path actually read. */
  source: string;
  isSample: boolean;
}

function pickUrl(serverValue: string | undefined, publicValue: string | undefined, sample: string) {
  const server = serverValue?.trim();
  if (server) return { source: server, isSample: false };
  const pub = publicValue?.trim();
  if (pub) return { source: pub, isSample: false };
  return { source: sample, isSample: true };
}

export function resolveRunHistoryLocation(env: Env = process.env): ArtifactLocation {
  return pickUrl(env.RUN_HISTORY_URL, env.NEXT_PUBLIC_RUN_HISTORY_URL, SAMPLE_PATHS.runHistory);
}

export function resolveOpenDataIndexLocation(env: Env = process.env): ArtifactLocation {
  return pickUrl(
    env.OPEN_DATA_INDEX_URL,
    env.NEXT_PUBLIC_OPEN_DATA_INDEX_URL,
    SAMPLE_PATHS.openDataIndex,
  );
}

/** Read JSON from an http(s) URL or from a `/sample/...` path under public/. */
export async function readArtifactJson(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${source}`);
    return response.json();
  }
  const relative = source.replace(/^\/+/, "");
  const path = resolve(PUBLIC_DIR, relative);
  if (!path.startsWith(PUBLIC_DIR)) throw new Error(`refusing to read outside public/: ${source}`);
  return JSON.parse(await readFile(path, "utf8"));
}

/** Directory the per property objects live in, derived from the index URL. */
export function openDataBase(indexSource: string): string {
  const [withoutHash] = indexSource.split("#");
  const [path] = withoutHash.split("?");
  const parts = path.split("/");
  if (/\.json$/i.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join("/");
}

export async function loadPropertyJson(
  cid: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; document: unknown } | null> {
  if (!cid) return null;
  const index = resolveOpenDataIndexLocation(env);
  const url = `${openDataBase(index.source)}/${cid}.json`;
  try {
    return { url, document: await readArtifactJson(url, fetchImpl) };
  } catch {
    return null;
  }
}

type HistoryCache = { key: string; at: number; value: Promise<LoadedRunHistory> };
const cache = globalThis as unknown as { __duvalRunHistory?: HistoryCache };
const TTL_MS = 60_000;

export interface LoadedRunHistory {
  location: ArtifactLocation;
  history: RunHistory;
  latest: PipelineRun | null;
  freshness: AgentDataFreshness;
}

export async function loadRunHistory(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedRunHistory> {
  const location = resolveRunHistoryLocation(env);
  const cached = cache.__duvalRunHistory;
  if (cached && cached.key === location.source && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }
  const value = (async () => {
    const history = parseRunHistory(await readArtifactJson(location.source, fetchImpl));
    const latest = sortRunsDesc(history.runs)[0] ?? null;
    return {
      location,
      history,
      latest,
      freshness: {
        run_id: latest?.run_id ?? null,
        finished_at: latest?.finished_at ?? latest?.started_at ?? history.generatedAt,
        source_url: /^https?:\/\//i.test(location.source) ? location.source : null,
        is_sample: location.isSample,
      },
    };
  })();
  cache.__duvalRunHistory = { key: location.source, at: Date.now(), value };
  value.catch(() => {
    if (cache.__duvalRunHistory?.value === value) delete cache.__duvalRunHistory;
  });
  return value;
}
