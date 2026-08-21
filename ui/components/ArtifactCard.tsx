"use client";

import { formatInt, shortenId } from "@/lib/format";
import { UNKNOWN_PUBLICATION, type ArtifactPublication } from "@/lib/artifacts";
import type { RunArtifact } from "@/lib/types";
import { CopyButton, IdWithCopy, NotAvailable } from "./ui";

/** "404,023 records, 1.8 GB" where the publisher recorded either. */
function scale(artifact: RunArtifact): string | null {
  const parts: string[] = [];
  if (artifact.rows !== null) parts.push(`${formatInt(artifact.rows)} records`);
  if (artifact.bytes !== null) {
    const mb = artifact.bytes / 1_000_000;
    parts.push(mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb.toFixed(1)} MB`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

/** Why there is no gateway URL for THIS run's copy, in the card's own words. */
function gatewayReason(publication: ArtifactPublication): string {
  switch (publication.status) {
    case "superseded":
      return "a later run republished this object; the index serves that copy";
    case "replaced":
      return "the artifacts index publishes a different CID under this name";
    case "unlisted":
      return "this object is not in the published artifacts index";
    default:
      return "no gateway url published for this artifact";
  }
}

/**
 * The neutral note under a superseded card.
 *
 * The consolidation pass republishes `query-table.parquet` seconds after every ingestion run, so
 * the ingestion run's copy is superseded on every single run, forever. That is the pipeline
 * working, not failing, and the card reads that way: it names the successor and points at the
 * copy the index serves. The warn tone below is reserved for a difference nothing explains.
 */
function SupersededNote({
  publication,
  path,
}: {
  publication: ArtifactPublication;
  path: string | null;
}) {
  const successor = publication.supersededBy;
  if (successor === null) return null;
  const what =
    successor.kind === "consolidation"
      ? "the consolidation pass that followed it"
      : "a later ingestion run";
  return (
    <p className="mt-2 text-[11.5px] text-muted">
      Superseded by {what}, <span className="mono">{shortenId(successor.runId, 10, 5)}</span>, which
      republished <span className="mono">{path}</span>.
      {publication.currentUrl ? (
        <>
          {" "}
          The index serves that copy at{" "}
          <a
            className="mono break-all"
            href={publication.currentUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {publication.currentUrl}
          </a>
          .
        </>
      ) : null}
    </p>
  );
}

/**
 * One published artifact: its CID, its IPNS label and name, and the gateway URL an MCP client or
 * DuckDB would actually open. The demo transcript asks for all three, with copy buttons, so they
 * can be pasted into a client on the spot.
 *
 * A run record only ever carries the CID, so the URL and the IPNS name come from `publication`,
 * which is this artifact's entry in the published artifacts index (see lib/artifacts.ts). Every
 * URL rendered here was published by the pipeline; none is assembled from a gateway and a CID.
 * When the index has nothing to say the card falls back to what the run record itself recorded,
 * and then to "not available" with the reason.
 */
export function ArtifactCard({
  artifact,
  publication = UNKNOWN_PUBLICATION,
}: {
  artifact: RunArtifact;
  publication?: ArtifactPublication;
}) {
  const gateway = artifact.gateway_url ?? publication.url;
  const ipnsName = publication.ipnsName ?? artifact.ipns_name;
  // Only the index publishes a resolvable IPNS URL. A name the run record carried on its own
  // gets shown and copied, but not linked, because no published URL backs it.
  const ipnsHref = publication.ipnsName !== null ? publication.ipnsUrl : null;
  const label = publication.ipnsLabel ?? artifact.ipns_label;

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[13px] font-semibold">{artifact.name}</span>
        {label ? <span className="badge badge-accent">{label}</span> : null}
      </div>
      {scale(artifact) ? (
        <div className="mt-0.5 text-[11.5px] text-faint">{scale(artifact)}</div>
      ) : null}

      <dl className="kv mt-2 text-[12.5px]">
        <dt>CID</dt>
        <dd>
          <IdWithCopy
            value={artifact.cid}
            head={14}
            tail={8}
            href={publication.url}
          />
        </dd>

        <dt>IPNS name</dt>
        <dd>
          {ipnsName ? (
            <IdWithCopy value={ipnsName} head={14} tail={8} href={ipnsHref} />
          ) : (
            // Kept short on purpose: it repeats on every entity table card, and where the index
            // said nothing at all the row degrades to exactly what it said before.
            <NotAvailable
              why={
                publication.status === "published"
                  ? "CID addressed; no IPNS name minted"
                  : undefined
              }
            />
          )}
        </dd>

        <dt>Gateway URL</dt>
        <dd>
          {gateway ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <a
                className="mono break-all"
                href={gateway}
                target="_blank"
                rel="noopener noreferrer"
              >
                {gateway}
              </a>
              <CopyButton text={gateway} />
            </span>
          ) : (
            <NotAvailable why={gatewayReason(publication)} />
          )}
        </dd>
      </dl>

      {publication.status === "superseded" ? (
        <SupersededNote publication={publication} path={artifact.path} />
      ) : null}

      {publication.status === "replaced" && publication.indexCid ? (
        <p className="mt-2 text-[11.5px] text-warn">
          The artifacts index lists a different CID,{" "}
          <span className="mono">{shortenId(publication.indexCid, 10, 6)}</span>, under{" "}
          <span className="mono">{artifact.path}</span>, and no later run in this history
          republished it. This run&apos;s copy was never published.
        </p>
      ) : null}

      {publication.status === "unlisted" ? (
        <p className="mt-2 text-[11.5px] text-warn">
          <span className="mono">{artifact.path}</span> is absent from the published artifacts
          index, so this run&apos;s copy of it was never published.
        </p>
      ) : null}
    </div>
  );
}
