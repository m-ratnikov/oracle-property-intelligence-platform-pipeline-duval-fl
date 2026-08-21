"use client";

/**
 * Resolving the per property JSON published alongside the query table.
 *
 * The open data artifact is an index plus shards plus one <cid>.json per
 * property. The query table already carries property_cid, so the fast path is a
 * direct fetch of <base>/<cid>.json. The shard walk is only a fallback for
 * publishers that do not fill property_cid.
 */

import { config } from "./config";
import { parseOpenDataIndex } from "./types";

/** Directory the open data objects live in, derived from the index URL. */
export function openDataBaseUrl(
  indexUrl: string | null = config.openDataIndexUrl,
): string | null {
  if (!indexUrl) return null;
  const [withoutHash] = indexUrl.split("#");
  const [path] = withoutHash.split("?");
  const parts = path.split("/");
  const last = parts[parts.length - 1] ?? "";
  if (/\.json$/i.test(last)) parts.pop();
  return parts.join("/");
}

/**
 * The gateway that serves content-addressed objects when no directory-style
 * publish is configured. Overridable, because a deployment may prefer its own.
 */
const IPFS_GATEWAY = (
  process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://ipfs.filebase.io"
).replace(/\/+$/, "");

/**
 * Where a property document lives, in the two shapes a publisher can produce.
 *
 * CID-ADDRESSED is what the pipeline actually publishes: the document is pinned
 * and served at `<gateway>/ipfs/<cid>`, with no suffix. Verified against the
 * live artifacts - `/ipfs/<cid>` answers 200 and `/ipfs/<cid>.json` answers 400,
 * because the extension makes it a different path rather than a content hint.
 *
 * DIRECTORY-ADDRESSED is what a bucket-style publish produces: objects keyed
 * `<cid>.json` under the same prefix as index.json.
 *
 * Both are returned, in that order, because the first is what this deployment
 * serves and the second is what a clone pointing at its own bucket would.
 * Trying the CID first costs nothing when it works, which is the normal case.
 */
export function propertyJsonUrls(
  cid: string,
  indexUrl?: string | null,
): string[] {
  const urls = [`${IPFS_GATEWAY}/ipfs/${cid}`];
  const base = openDataBaseUrl(indexUrl);
  // A gateway base would just repeat the URL above, with a suffix that breaks it.
  if (base && !/\/ip[fn]s(\/|$)/.test(base)) urls.push(`${base}/${cid}.json`);
  return urls;
}

/** The first candidate, kept for callers that want a single URL to show. */
export function propertyJsonUrl(
  cid: string,
  indexUrl?: string | null,
): string | null {
  return propertyJsonUrls(cid, indexUrl)[0] ?? null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

export interface OpenDataLookup {
  url: string;
  cid: string;
  document: Record<string, unknown>;
}

const MAX_SHARDS_TO_WALK = 16;

/**
 * Find the per property JSON for a parcel. Returns null when the property is
 * simply not in the published open data subset, which is a normal state while a
 * windowed pipeline works through the roll.
 */
export async function lookupPropertyJson(
  propertyId: string,
  propertyCid: string | null,
): Promise<OpenDataLookup | null> {
  const indexUrl = config.openDataIndexUrl;
  // The CID carried on the row is enough on its own: the fast path does not
  // need an index, and this deployment publishes no index. Only the shard walk
  // below does, so an absent index narrows the lookup rather than disabling it.

  if (propertyCid) {
    for (const url of propertyJsonUrls(propertyCid, indexUrl)) {
      try {
        const document = (await fetchJson(url)) as Record<string, unknown>;
        return { url, cid: propertyCid, document };
      } catch {
        // Try the next shape, then the shard walk.
      }
    }
  }

  if (!indexUrl) return null;
  const index = parseOpenDataIndex(await fetchJson(indexUrl));

  const inline = index.properties[propertyId];
  if (inline) {
    const url = propertyJsonUrl(inline, indexUrl);
    if (url) {
      const document = (await fetchJson(url)) as Record<string, unknown>;
      return { url, cid: inline, document };
    }
  }

  const base = openDataBaseUrl(indexUrl);
  if (!base) return null;

  for (const shard of index.shards.slice(0, MAX_SHARDS_TO_WALK)) {
    const shardUrl = shard.url ?? `${base}/shards/${shard.shard}`;
    try {
      const parsed = parseOpenDataIndex(await fetchJson(shardUrl));
      const cid = parsed.properties[propertyId];
      if (!cid) continue;
      const url = propertyJsonUrl(cid, indexUrl);
      if (!url) continue;
      const document = (await fetchJson(url)) as Record<string, unknown>;
      return { url, cid, document };
    } catch {
      // A missing or malformed shard should not break the page.
    }
  }

  return null;
}
