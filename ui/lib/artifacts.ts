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

import { isRecord, num, str, type PipelineRun, type RunArtifact, type RunKind } from "./types";

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
 * - `published`   the index lists this object name at exactly this run's CID.
 * - `superseded`  the index lists a different CID under this name AND a later run in the loaded
 *                 history recorded the same object. Ordinary pipeline behaviour, not a fault: the
 *                 consolidation pass republishes the query table seconds after every ingestion
 *                 run. The card names the successor and links to the copy the index serves.
 * - `replaced`    the index lists a different CID under this name and NOTHING in the loaded
 *                 history explains it. This is the real "never published" signal and keeps the
 *                 warn tone.
 * - `unlisted`    the index loaded and has no entry for this object name at all.
 * - `unknown`     no index reached the browser, or the artifact carries no object name to join
 *                 on. Says nothing either way, and the card degrades to what it said before.
 */
export type PublicationStatus =
  | "published"
  | "superseded"
  | "replaced"
  | "unlisted"
  | "unknown";

/** The later run that republished an object, for a `superseded` card. */
export interface Successor {
  runId: string;
  kind: RunKind;
  startedAt: string | null;
  /** True when that run recorded exactly the CID the index publishes. */
  servesIndexCid: boolean;
}

export interface ArtifactPublication {
  status: PublicationStatus;
  /**
   * The gateway URL for THIS run's bytes, and only for those. Null unless the index lists this
   * object name at this run's exact CID. Never constructed.
   */
  url: string | null;
  /**
   * The gateway URL of whatever the index currently serves under this object name, when that is
   * not this run's copy. Rendered only as "what the index serves now", never as this run's URL.
   */
  currentUrl: string | null;
  ipnsName: string | null;
  ipnsUrl: string | null;
  ipnsLabel: string | null;
  /** The CID the index lists under this object name, when it is not this run's. */
  indexCid: string | null;
  indexGeneratedAt: string | null;
  supersededBy: Successor | null;
}

export const UNKNOWN_PUBLICATION: ArtifactPublication = {
  status: "unknown",
  url: null,
  currentUrl: null,
  ipnsName: null,
  ipnsUrl: null,
  ipnsLabel: null,
  indexCid: null,
  indexGeneratedAt: null,
  supersededBy: null,
};

/** A run CID and an index entry describe the same bytes if either CID form agrees. */
function sameBytes(cid: string, entry: PublishedArtifact): boolean {
  return cid === entry.cid || cid === entry.cidV1;
}

/** Chronological order of runs. Run ids are ULIDs, so they order correctly when a stamp is absent. */
function isLaterThan(candidate: PipelineRun, run: PipelineRun): boolean {
  const a = candidate.started_at ?? "";
  const b = run.started_at ?? "";
  if (a !== b) return a > b;
  return candidate.run_id > run.run_id;
}

/**
 * Build the lookup once per page, not once per card: the index is a single fetch shared by
 * every card on the page, and this turns it into a map so a page with a hundred artifacts still
 * scans it once.
 *
 * `runs` is the loaded history. It is what separates ordinary supersession from a genuine
 * publish failure: if a later run recorded the same object name, the difference between this
 * run's CID and the index's is explained, and the card says so plainly instead of raising an
 * alarm. Pass an empty list and every mismatch stays `replaced`, which is the honest default
 * when there is no history to reason with.
 */
export function publicationLookup(
  index: ArtifactsIndex | null,
  runs: PipelineRun[] = [],
): (artifact: RunArtifact, run: PipelineRun) => ArtifactPublication {
  if (index === null || index.artifacts.length === 0) return () => UNKNOWN_PUBLICATION;

  const byName = new Map<string, PublishedArtifact>();
  for (const entry of index.artifacts) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  /** object name -> every run that recorded producing it, with the CID it recorded. */
  const producers = new Map<string, { run: PipelineRun; cid: string | null }[]>();
  for (const run of runs) {
    for (const artifact of run.artifacts) {
      if (artifact.path === null) continue;
      const list = producers.get(artifact.path) ?? [];
      list.push({ run, cid: artifact.cid });
      producers.set(artifact.path, list);
    }
  }

  function successorOf(
    path: string,
    run: PipelineRun,
    entry: PublishedArtifact,
  ): Successor | null {
    const later = (producers.get(path) ?? []).filter((p) => isLaterThan(p.run, run));
    if (later.length === 0) return null;
    // Prefer the run that produced exactly what the index publishes: that is the copy a reader
    // following the link will actually get.
    const exact = later.find((p) => p.cid !== null && sameBytes(p.cid, entry));
    const chosen =
      exact ??
      later.reduce((newest, p) => (isLaterThan(p.run, newest.run) ? p : newest), later[0]!);
    return {
      runId: chosen.run.run_id,
      kind: chosen.run.kind,
      startedAt: chosen.run.started_at,
      servesIndexCid: exact !== undefined,
    };
  }

  return (artifact: RunArtifact, run: PipelineRun): ArtifactPublication => {
    // No object name means no join key. Absence of evidence, not evidence of absence.
    if (artifact.path === null || artifact.cid === null) return UNKNOWN_PUBLICATION;

    const entry = byName.get(artifact.path);
    if (entry === undefined) {
      return { ...UNKNOWN_PUBLICATION, status: "unlisted", indexGeneratedAt: index.generatedAt };
    }

    if (!sameBytes(artifact.cid, entry)) {
      // The index publishes other bytes under this name. Whether that is routine or a failure
      // depends entirely on whether the history explains it. The gateway URL for THIS run's
      // bytes is not offered either way; only `currentUrl` is, labelled as the current copy.
      const successor = successorOf(artifact.path, run, entry);
      return {
        status: successor === null ? "replaced" : "superseded",
        url: null,
        currentUrl: entry.url,
        ipnsName: entry.ipnsName,
        ipnsUrl: entry.ipnsUrl,
        ipnsLabel: entry.ipnsLabel,
        indexCid: entry.cid ?? entry.cidV1,
        indexGeneratedAt: index.generatedAt,
        supersededBy: successor,
      };
    }

    return {
      status: "published",
      url: entry.url,
      currentUrl: null,
      ipnsName: entry.ipnsName,
      ipnsUrl: entry.ipnsUrl,
      ipnsLabel: entry.ipnsLabel,
      indexCid: null,
      indexGeneratedAt: index.generatedAt,
      supersededBy: null,
    };
  };
}
