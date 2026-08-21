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
export function openDataBaseUrl(indexUrl: string | null = config.openDataIndexUrl): string | null {
  if (!indexUrl) return null;
  const [withoutHash] = indexUrl.split("#");
  const [path] = withoutHash.split("?");
  const parts = path.split("/");
  const last = parts[parts.length - 1] ?? "";
  if (/\.json$/i.test(last)) parts.pop();
  return parts.join("/");
}

export function propertyJsonUrl(cid: string, indexUrl?: string | null): string | null {
  const base = openDataBaseUrl(indexUrl);
  if (!base) return null;
  return `${base}/${cid}.json`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
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
  if (!indexUrl) return null;

  if (propertyCid) {
    const url = propertyJsonUrl(propertyCid, indexUrl);
    if (url) {
      try {
        const document = (await fetchJson(url)) as Record<string, unknown>;
        return { url, cid: propertyCid, document };
      } catch {
        // Fall through to the shard walk.
      }
    }
  }

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
