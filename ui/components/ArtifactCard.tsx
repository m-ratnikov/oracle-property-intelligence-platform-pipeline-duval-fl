"use client";

import type { RunArtifact } from "@/lib/types";
import { CopyButton, IdWithCopy, NotAvailable } from "./ui";

/**
 * One published artifact: its CID, its IPNS label and name, and the gateway URL
 * an MCP client or DuckDB would actually open. The demo transcript asks for all
 * three, with copy buttons, so they can be pasted into a client on the spot.
 */
export function ArtifactCard({ artifact }: { artifact: RunArtifact }) {
  const gateway =
    artifact.gateway_url ??
    (artifact.ipns_name ? `https://ipfs.filebase.io/ipns/${artifact.ipns_name}` : null);

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[13px] font-semibold">{artifact.name}</span>
        {artifact.ipns_label ? (
          <span className="badge badge-accent">{artifact.ipns_label}</span>
        ) : null}
      </div>

      <dl className="kv mt-2 text-[12.5px]">
        <dt>CID</dt>
        <dd>
          <IdWithCopy
            value={artifact.cid}
            head={14}
            tail={8}
            href={artifact.cid ? `https://ipfs.filebase.io/ipfs/${artifact.cid}` : null}
          />
        </dd>

        <dt>IPNS name</dt>
        <dd>
          <IdWithCopy
            value={artifact.ipns_name}
            head={14}
            tail={8}
            href={artifact.ipns_name ? `https://ipfs.filebase.io/ipns/${artifact.ipns_name}` : null}
          />
        </dd>

        <dt>Gateway URL</dt>
        <dd>
          {gateway ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <a className="mono break-all" href={gateway} target="_blank" rel="noreferrer">
                {gateway}
              </a>
              <CopyButton text={gateway} />
            </span>
          ) : (
            <NotAvailable why="no gateway url published for this artifact" />
          )}
        </dd>
      </dl>
    </div>
  );
}
