/**
 * Joining a run's artifact records to the published artifacts index.
 *
 * A run record says what bytes the run produced: a path and a CID per object. It cannot say
 * where those bytes ended up, because the publish step runs after the run record is written.
 * The publish step records that separately, in `artifacts/<county>/index.json`: every object it
 * uploaded, the gateway URL it uploaded it to, and the IPNS name it pointed at it where the
 * artifact has one. That index is itself published under the IPNS label
 * `<county>-oracle-artifacts`, so this UI reads it exactly like every other artifact.
 *
 * THE JOIN KEY IS THE PUBLISHED OBJECT NAME.
 *
 *   run record      artifacts.queryTable.path        = "query-table.parquet"
 *                   artifacts.tables.parcels.path    = "tables/parcels.parquet"
 *   index entry     artifacts[].name                 = "query-table.parquet"
 *                                                      "tables/parcels.parquet"
 *
 * Not `RunArtifact.name`: that is the key the run record files the artifact under
 * (`queryTable`, `coverage`, `tables.parcels`) and appears nowhere in the index. Not the index's
 * `key` either: that is the S3 object key (`query-tables/duval/query-table.parquet`), which is a
 * bucket layout detail no run record carries.
 *
 * NOTHING HERE BUILDS A URL. A gateway URL is rendered only when the index published one for
 * exactly the CID the run recorded. Concatenating a gateway and a CID would produce a link that
 * looks like proof of publication while proving nothing, and inventing evidence is the one thing
 * this deliverable must not do. When the index is unreachable, has no entry for an artifact, or
 * lists a different CID under its name, the card says so and shows no URL.
 */

import { isRecord, num, str, type RunArtifact } from "./types";

export interface PublishedArtifact {
  /** The published object name. The join key; see the module comment. */
  name: string;
  /** Object key inside the publishing bucket. Informational; never joined on. */
  key: string | null;
  contentType: string | null;
  bytes: number | null;
  sha256: string | null;
  cid: string | null;
  cidV1: string | null;
  /** Gateway URL for the immutable CID, as published. */
  url: string | null;
  ipnsLabel: string | null;
  ipnsName: string | null;
  ipnsUrl: string | null;
}

export interface ArtifactsIndex {
  county: string | null;
  generatedAt: string | null;
  /**
   * "published" for a CI publish, "dry-run" for a local plan. A dry-run index carries every CID
   * and gateway URL but leaves `ipnsName` and `ipnsUrl` null on every entry, because no IPNS
   * write happened. Both shapes are handled: a dry-run entry still resolves the gateway URL and
   * simply has no IPNS name to show.
   */
  mode: string | null;
  gateway: string | null;
  artifacts: PublishedArtifact[];
}

const EMPTY_INDEX: ArtifactsIndex = {
  county: null,
  generatedAt: null,
  mode: null,
  gateway: null,
  artifacts: [],
};

/** Lenient parser, in the same spirit as the other published artifacts. */
export function parseArtifactsIndex(input: unknown): ArtifactsIndex {
  if (!isRecord(input)) return EMPTY_INDEX;
  const list = Array.isArray(input.artifacts) ? input.artifacts : [];
  const artifacts: PublishedArtifact[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const name = str(item.name);
    if (name === null) continue;
    artifacts.push({
      name,
      key: str(item.key),
      contentType: str(item.contentType),
      bytes: num(item.bytes),
      sha256: str(item.sha256),
      cid: str(item.cid),
      cidV1: str(item.cidV1),
      url: str(item.url),
      ipnsLabel: str(item.ipnsLabel),
      ipnsName: str(item.ipnsName),
      ipnsUrl: str(item.ipnsUrl),
    });
  }
  return {
    county: str(input.county),
    generatedAt: str(input.generatedAt),
    mode: str(input.mode),
    gateway: str(input.gateway),
    artifacts,
  };
}

/**
 * - `published`  the index lists this object name at exactly this run's CID.
 * - `replaced`   the index lists this object name at a different CID, so the bytes this run
 *                produced are not the ones the gateway currently serves under that name.
 * - `unlisted`   the index loaded and has no entry for this object name at all, so nothing was
 *                published for it.
 * - `unknown`    no index reached the browser, or the artifact carries no object name to join
 *                on. Says nothing either way, and the card degrades to what it said before.
 */
export type PublicationStatus = "published" | "replaced" | "unlisted" | "unknown";

export interface ArtifactPublication {
  status: PublicationStatus;
  /** Only ever a URL the index published. Never constructed. */
  url: string | null;
  ipnsName: string | null;
  ipnsUrl: string | null;
  ipnsLabel: string | null;
  /** The CID the index lists under this object name, when it is not this run's. */
  indexCid: string | null;
  indexGeneratedAt: string | null;
}

export const UNKNOWN_PUBLICATION: ArtifactPublication = {
  status: "unknown",
  url: null,
  ipnsName: null,
  ipnsUrl: null,
  ipnsLabel: null,
  indexCid: null,
  indexGeneratedAt: null,
};

/** A run CID and an index entry describe the same bytes if either CID form agrees. */
function sameBytes(cid: string, entry: PublishedArtifact): boolean {
  return cid === entry.cid || cid === entry.cidV1;
}

/**
 * Build the lookup once per page, not once per card: the index is a single fetch shared by
 * every card on the page, and this turns it into a map so a page with a hundred artifacts still
 * scans it once.
 */
export function publicationLookup(
  index: ArtifactsIndex | null,
): (artifact: RunArtifact) => ArtifactPublication {
  if (index === null || index.artifacts.length === 0) return () => UNKNOWN_PUBLICATION;

  const byName = new Map<string, PublishedArtifact>();
  for (const entry of index.artifacts) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  return (artifact: RunArtifact): ArtifactPublication => {
    // No object name means no join key. Absence of evidence, not evidence of absence.
    if (artifact.path === null || artifact.cid === null) return UNKNOWN_PUBLICATION;

    const entry = byName.get(artifact.path);
    if (entry === undefined) {
      return { ...UNKNOWN_PUBLICATION, status: "unlisted", indexGeneratedAt: index.generatedAt };
    }

    if (!sameBytes(artifact.cid, entry)) {
      // A real signal, not a glitch: this run's copy of the object was never published, or a
      // later publish replaced it. The IPNS pointer for the name is still shown, because it is
      // published and real, but the gateway URL for these bytes is not offered.
      return {
        status: "replaced",
        url: null,
        ipnsName: entry.ipnsName,
        ipnsUrl: entry.ipnsUrl,
        ipnsLabel: entry.ipnsLabel,
        indexCid: entry.cid ?? entry.cidV1,
        indexGeneratedAt: index.generatedAt,
      };
    }

    return {
      status: "published",
      url: entry.url,
      ipnsName: entry.ipnsName,
      ipnsUrl: entry.ipnsUrl,
      ipnsLabel: entry.ipnsLabel,
      indexCid: null,
      indexGeneratedAt: index.generatedAt,
    };
  };
}
