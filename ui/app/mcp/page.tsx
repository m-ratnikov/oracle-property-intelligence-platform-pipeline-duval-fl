"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { config, queryTableParquetUrl } from "@/lib/config";
import { useJson } from "@/lib/hooks";
import { parseCatalog } from "@/lib/types";
import { formatMcpEnv, mcpBindings, parseArtifactsIndex } from "@/lib/artifacts";
import { formatInt, formatTimestamp } from "@/lib/format";
import {
  ArtifactPreload,
  PageHeader,
  Section,
  Callout,
  Spinner,
  CopyButton,
  IdWithCopy,
} from "@/components/ui";

/* ------------------------------------------------------------ live check */

interface ResolveCheck {
  status: "checking" | "ok" | "partial" | "failed";
  httpStatus: number | null;
  ipfsRoots: string | null;
  contentLength: number | null;
  contentType: string | null;
  acceptsRanges: string | null;
  magic: string | null;
  magicOk: boolean | null;
  elapsedMs: number | null;
  error: string | null;
  exposedHeaders: string[];
}

const INITIAL: ResolveCheck = {
  status: "checking",
  httpStatus: null,
  ipfsRoots: null,
  contentLength: null,
  contentType: null,
  acceptsRanges: null,
  magic: null,
  magicOk: null,
  elapsedMs: null,
  error: null,
  exposedHeaders: [],
};

function IpnsResolveCheck({ url }: { url: string }) {
  const [check, setCheck] = useState<ResolveCheck>(INITIAL);

  const run = useCallback(async () => {
    setCheck(INITIAL);
    const started = performance.now();
    const next: ResolveCheck = { ...INITIAL };

    try {
      const head = await fetch(url, { method: "HEAD", cache: "no-store" });
      next.httpStatus = head.status;
      next.ipfsRoots = head.headers.get("x-ipfs-roots");
      const length = head.headers.get("content-length");
      next.contentLength = length ? Number(length) : null;
      next.contentType = head.headers.get("content-type");
      next.acceptsRanges = head.headers.get("accept-ranges");
      head.headers.forEach((_, key) => next.exposedHeaders.push(key));
    } catch (error: unknown) {
      next.error = error instanceof Error ? error.message : String(error);
    }

    // Four byte range read. A parquet file starts with the magic bytes PAR1, so
    // this proves both that range requests work and that the object really is a
    // parquet, without downloading it.
    try {
      const ranged = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-3" },
        cache: "no-store",
      });
      if (next.httpStatus === null) next.httpStatus = ranged.status;
      if (!next.ipfsRoots) next.ipfsRoots = ranged.headers.get("x-ipfs-roots");
      const buffer = await ranged.arrayBuffer();
      const magic = new TextDecoder().decode(buffer.slice(0, 4));
      next.magic = magic;
      next.magicOk = magic === "PAR1";
    } catch (error: unknown) {
      if (!next.error) next.error = error instanceof Error ? error.message : String(error);
    }

    next.elapsedMs = performance.now() - started;
    next.status = next.magicOk
      ? "ok"
      : next.httpStatus && next.httpStatus < 400
        ? "partial"
        : "failed";
    setCheck(next);
  }, [url]);

  useEffect(() => {
    void run();
  }, [run]);

  const badge =
    check.status === "checking" ? (
      <span className="badge badge-neutral">checking</span>
    ) : check.status === "ok" ? (
      <span className="badge badge-good">resolved</span>
    ) : check.status === "partial" ? (
      <span className="badge badge-warn">reachable, unverified</span>
    ) : (
      <span className="badge badge-bad">failed</span>
    );

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold">Live resolution check</span>
          {badge}
          {check.elapsedMs !== null ? (
            <span className="text-[11.5px] text-faint">{check.elapsedMs.toFixed(0)} ms</span>
          ) : null}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void run()}>
          re-check
        </button>
      </div>

      <div className="px-4 py-3">
        <div className="mono mb-3 break-all text-[11.5px] text-muted">{url}</div>

        {check.status === "checking" ? (
          <Spinner label="Resolving the pointer and reading the first four bytes" />
        ) : (
          <dl className="kv text-[12.5px]">
            <dt>HTTP status</dt>
            <dd className="mono">{check.httpStatus ?? "no response"}</dd>

            <dt>x-ipfs-roots</dt>
            <dd>
              {check.ipfsRoots ? (
                <IdWithCopy value={check.ipfsRoots} head={18} tail={8} />
              ) : (
                <span className="na">
                  not exposed by this gateway (CORS hides it unless the gateway sets
                  access-control-expose-headers)
                </span>
              )}
            </dd>

            <dt>content-length</dt>
            <dd className="mono">
              {check.contentLength === null ? (
                <span className="na">not exposed</span>
              ) : (
                `${formatInt(check.contentLength)} bytes (${(check.contentLength / 1024 / 1024).toFixed(2)} MB)`
              )}
            </dd>

            <dt>content-type</dt>
            <dd className="mono">{check.contentType ?? <span className="na">not exposed</span>}</dd>

            <dt>accept-ranges</dt>
            <dd className="mono">
              {check.acceptsRanges ?? <span className="na">not exposed</span>}
            </dd>

            <dt>first four bytes</dt>
            <dd>
              {check.magic === null ? (
                <span className="na">could not read</span>
              ) : check.magicOk ? (
                <span className="text-good">
                  <span className="mono">{check.magic}</span>, a valid parquet header, read with a
                  4 byte range request
                </span>
              ) : (
                <span className="text-bad mono">{check.magic}</span>
              )}
            </dd>

            {check.exposedHeaders.length > 0 ? (
              <>
                <dt>headers visible to this page</dt>
                <dd className="mono text-[11.5px]">{check.exposedHeaders.join(", ")}</dd>
              </>
            ) : null}

            {check.error ? (
              <>
                <dt>error</dt>
                <dd className="mono text-bad break-all">{check.error}</dd>
              </>
            ) : null}
          </dl>
        )}

        {check.status === "ok" ? (
          <p className="mt-3 text-[12px] text-good">
            The pointer resolves and serves byte ranges, which is exactly what DuckDB needs to query
            the artifact without downloading it, and what an MCP client needs to answer questions
            without any hosted database.
          </p>
        ) : check.status === "partial" ? (
          <p className="mt-3 text-[12px] text-warn">
            The object is reachable but the parquet header could not be verified from this page.
            That is usually the gateway declining a ranged cross origin request, not a broken
            artifact.
          </p>
        ) : check.status === "failed" ? (
          <p className="mt-3 text-[12px] text-bad">
            The artifact did not resolve from this browser. Check the URL, and check that the
            gateway sends permissive CORS headers.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function McpPage() {
  const catalog = useJson(config.catalogUrl, parseCatalog);
  const artifactsIndex = useJson(config.artifactsIndexUrl, parseArtifactsIndex);
  const parquetUrl = queryTableParquetUrl();
  const mcpUrl = config.mcpUrl;
  const endpoint = mcpUrl ? `${mcpUrl.replace(/\/+$/, "")}/mcp` : null;

  const county = catalog.data?.counties.find((entry) => entry.countyKey === config.countyKey);

  /*
   * The env block is READ from the publish output, not assembled here.
   *
   * It used to be built from this deployment's own NEXT_PUBLIC_* URLs and the catalog entry, which
   * meant the two settings the hosted MCP hands to DuckDB were advertised as mutable /ipns/ URLs.
   * That is the exact configuration that hard-failed every data tool: DuckDB pins the ETag it saw
   * when it created its view, on IPFS the ETag is the CID, and this pipeline re-points every name
   * on every publish. The published artifacts index carries the immutable /ipfs/<cid> URL for each
   * object alongside its IPNS name, so the addressing decision is made once, in the pipeline, and
   * rendered here from what the publish actually produced. See lib/artifacts.ts.
   */
  const bindings = useMemo(
    () =>
      mcpBindings({
        countyKey: config.countyKey,
        index: artifactsIndex.data,
        openDataIndexUrl: config.openDataIndexUrl,
      }),
    [artifactsIndex.data],
  );
  const envText = formatMcpEnv(bindings);
  const perPublish = bindings.filter((binding) => binding.perPublish);
  const setOnce = bindings.filter((binding) => !binding.perPublish);
  const unresolved = bindings.filter((binding) => !binding.resolved);

  const stdioConfig = JSON.stringify(
    {
      mcpServers: {
        [`elephant-${config.countyKey}`]: endpoint
          ? { command: "npx", args: ["-y", "mcp-remote", endpoint] }
          : {
              command: "npx",
              args: ["-y", "mcp-remote", "https://YOUR-MCP-DEPLOYMENT/mcp"],
            },
      },
    },
    null,
    2,
  );

  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        [`elephant-${config.countyKey}`]: {
          type: "streamable-http",
          url: endpoint ?? "https://YOUR-MCP-DEPLOYMENT/mcp",
        },
      },
    },
    null,
    2,
  );

  return (
    <div>
      <ArtifactPreload urls={[config.artifactsIndexUrl, config.catalogUrl]} />
      <PageHeader
        title="MCP access"
        lead="The dataset is content addressed and public, so any MCP client can read it directly. Nothing in this section depends on infrastructure we keep running."
      />

      <Section
        title="Is the artifact actually resolvable right now"
        description="This check runs in your browser against the same URL DuckDB and an MCP server would use. It resolves the pointer, reports the gateway headers and reads the parquet magic bytes with a 4 byte range request."
      >
        <IpnsResolveCheck url={parquetUrl} />
      </Section>

      <Section
        title="Connect a client"
        description="Two ways in, depending on what the client supports. Both point at the same stateless server."
      >
        {!endpoint ? (
          <div className="mb-3">
            <Callout tone="warn" title="No MCP endpoint configured for this deployment">
              Set <span className="mono">NEXT_PUBLIC_MCP_URL</span> to the deployed MCP base URL and
              this page fills in the real values. The snippets below show the shape with a
              placeholder.
            </Callout>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card card-pad">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold">Streamable HTTP</span>
              <CopyButton text={endpoint ?? "https://YOUR-MCP-DEPLOYMENT/mcp"} label="copy url" />
            </div>
            <p className="mt-1 text-[12px] text-muted">
              For clients that speak MCP over HTTP directly. POST JSON-RPC to the endpoint.
            </p>
            <pre className="block mt-2">{endpoint ?? "https://YOUR-MCP-DEPLOYMENT/mcp"}</pre>
            <div className="mt-3 text-[12px] font-semibold">Client config</div>
            <pre className="block mt-1">{httpConfig}</pre>
            <div className="mt-2">
              <CopyButton text={httpConfig} label="copy config" />
            </div>
          </div>

          <div className="card card-pad">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold">stdio, for Cursor and Claude</span>
              <CopyButton text={stdioConfig} label="copy config" />
            </div>
            <p className="mt-1 text-[12px] text-muted">
              Drop this into <span className="mono">.cursor/mcp.json</span> or the Claude desktop
              config. <span className="mono">mcp-remote</span> bridges stdio to the HTTP endpoint.
            </p>
            <pre className="block mt-2">{stdioConfig}</pre>
          </div>
        </div>
      </Section>

      <Section
        title="Environment map we deploy with"
        description="The variables the MCP server reads to find this county's artifacts, taken from the published artifacts index the last publish wrote. They are all public URLs, which is the point: there is no credential to hand out and nothing to keep online."
      >
        <div className="mb-3">
          <Callout tone="warn" title="Two of these must be re-applied after every publish">
            The hosted server hands the query table straight to DuckDB, and DuckDB pins the ETag it
            saw when it created its view. On an IPFS gateway the ETag <em>is</em> the content
            identifier, so pointing that setting at a mutable{" "}
            <span className="mono">/ipns/</span> name breaks every data tool on every warm instance
            the moment the pipeline republishes. The two settings DuckDB reads are therefore pinned
            to immutable <span className="mono">/ipfs/&lt;cid&gt;</span> URLs and re-applied per
            publish. Everything fetched as plain JSON behind a short TTL keeps its IPNS name and is
            set once.
          </Callout>
        </div>

        <div className="table-wrap" style={{ maxHeight: "none" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>setting</th>
                <th>addressing</th>
                <th>re-apply</th>
                <th style={{ minWidth: 320 }}>why</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => (
                <tr key={binding.env} data-testid={`mcp-binding-${binding.env}`}>
                  <td className="mono font-semibold">{binding.env}</td>
                  <td>
                    <span
                      className={
                        binding.addressing === "cid"
                          ? "badge badge-good"
                          : binding.addressing === "ipns"
                            ? "badge badge-accent"
                            : "badge badge-neutral"
                      }
                    >
                      {binding.addressing === "cid"
                        ? "immutable CID"
                        : binding.addressing === "ipns"
                          ? "IPNS name"
                          : "literal"}
                    </span>
                  </td>
                  <td>
                    {binding.perPublish ? (
                      <span className="badge badge-warn">every publish</span>
                    ) : (
                      <span className="text-[12px] text-faint">set once</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "normal" }} className="text-[12px] text-muted">
                    {binding.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card card-pad mt-3">
          <div className="text-[12px] font-semibold text-warn">
            Per publish, re-apply then redeploy
          </div>
          <pre className="block mt-1">
            {perPublish.map((binding) => `${binding.env}=${binding.value}`).join("\n")}
          </pre>
          <div className="mt-3 text-[12px] font-semibold">Set once, stable across publishes</div>
          <pre className="block mt-1">
            {setOnce.map((binding) => `${binding.env}=${binding.value}`).join("\n")}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CopyButton text={envText} label="copy env" />
            <span className="text-[11.5px] text-faint">
              The MCP server binds environment variables at deploy time, so redeploy after changing
              any of these.
            </span>
          </div>
        </div>

        {artifactsIndex.loading ? (
          <div className="mt-3">
            <Spinner label="Reading the published artifacts index" />
          </div>
        ) : unresolved.length > 0 ? (
          <div className="mt-3">
            <Callout tone="warn" title="Some values are placeholders">
              No published artifact backs{" "}
              <span className="mono">{unresolved.map((binding) => binding.env).join(", ")}</span>{" "}
              yet, so the block above shows a placeholder for{" "}
              {unresolved.length === 1 ? "it" : "them"} rather than a URL nothing serves.
            </Callout>
          </div>
        ) : null}

        {county ? (
          <p className="mt-3 text-[12px] text-muted">
            The published counties catalog carries the same artifact URLs, last updated{" "}
            {formatTimestamp(county.updatedAt)}, and the publish step fails if the catalog and this
            block ever name different objects. A client that reads the catalog discovers this county
            without being configured for it at all.
          </p>
        ) : catalog.loading ? (
          <div className="mt-3">
            <Spinner label="Reading the published counties catalog" />
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-warn">
            No catalog entry for <span className="mono">{config.countyKey}</span> was found in the
            published catalog.
          </p>
        )}
      </Section>

      <Section
        title="What a client can ask for"
        description="The tools the Elephant MCP server exposes over these artifacts."
      >
        <div className="table-wrap" style={{ maxHeight: "none" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>tool</th>
                <th>reads</th>
                <th>what it answers</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["getPropertyQuerySchema", "query-table.parquet", "The column list, so a client can write valid SQL."],
                ["queryProperties", "query-table.parquet", "A single read only SELECT over the view properties, limit 1000."],
                ["getOracleDatasetInfo", "dataset-coverage.json", "Ingested and expected counts per source."],
                ["listOracleProperties", "open data index", "Paged list of the consolidated per property records."],
                ["getOracleProperty", "open data <cid>.json", "One property's full consolidated record."],
                ["listPublishedCounties", "catalog.json", "Which counties are published and where their artifacts live."],
              ].map(([tool, reads, answers]) => (
                <tr key={tool}>
                  <td className="mono font-semibold">{tool}</td>
                  <td className="mono text-[11.5px]">{reads}</td>
                  <td style={{ whiteSpace: "normal" }}>{answers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Why this is MCP ready without a server of ours">
        <Callout tone="good">
          The MCP server is stateless. It holds no data, only the URLs above, and it answers by range
          reading a public content addressed artifact with DuckDB, exactly as this UI does in your
          browser. If it were switched off tomorrow the data would still resolve from any IPFS
          gateway, and any client could point DuckDB at it directly.
        </Callout>
      </Section>
    </div>
  );
}
