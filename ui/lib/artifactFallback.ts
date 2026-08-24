import { parseArtifactsIndex } from "./artifacts";
import { config, type AppConfig } from "./config";

/**
 * Recover from a configured artifact URL that the gateway no longer serves.
 *
 * On 2026-08-25 every panel of the hosted UI showed a 504. The deployment's NEXT_PUBLIC_* URLs
 * had been set to the immutable `/ipfs/<cid>` URLs of one publish, the pipeline had published
 * eleven times since, and the storage side had long since dropped that CID. Nothing in the UI was
 * wrong and nothing in the UI could do anything about it: the configured URL was the only address
 * it knew.
 *
 * It knows one more now. The artifacts index is published under a stable IPNS name on every
 * publish and lists the current gateway URL of every object. When the configured URL for an
 * object answers with an error status, the page resolves that object's current URL from the index
 * and retries once. The deployment's configuration is still expected to be the IPNS names (see
 * .env.example), so this path is a safety net, not the design; it is here so that a configuration
 * mistake, or a gateway that stops serving a CID, degrades to one extra request instead of an
 * outage with a red box in the demo.
 */

/** Which published object each configured artifact URL stands for, so a failure can be re-resolved. */
export function objectNameFor(url: string, cfg: AppConfig = config): string | null {
  if (url === cfg.queryTableUrl) return "query-table.parquet";
  if (url === cfg.runHistoryUrl) return "run-history.json";
  if (url === cfg.coverageUrl) return "dataset-coverage.json";
  if (url === cfg.catalogUrl) return "published-counties.json";
  return null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * The URL the published artifacts index currently lists for `objectName`, or null when the index
 * cannot be read or does not list it. The IPNS URL is preferred, because it keeps following later
 * publishes; the CID URL is what the index guarantees to exist at the moment it was written.
 */
export async function resolveCurrentArtifactUrl(
  objectName: string,
  indexUrl: string = config.artifactsIndexUrl,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(indexUrl, { cache: "no-store" });
    if (!response.ok) return null;
    const index = parseArtifactsIndex(await response.json());
    const entry = index.artifacts.find((a) => a.name === objectName);
    if (!entry) return null;
    return entry.ipnsUrl ?? entry.url ?? null;
  } catch {
    return null;
  }
}

/**
 * A different URL to retry `failedUrl` at, or null when there is none. Never returns the URL that
 * just failed, so a caller cannot loop on it.
 */
export async function fallbackFor(failedUrl: string, cfg: AppConfig = config, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const name = objectNameFor(failedUrl, cfg);
  if (name === null) return null;
  const current = await resolveCurrentArtifactUrl(name, cfg.artifactsIndexUrl, fetchImpl);
  if (current === null || current === failedUrl) return null;
  return current;
}
