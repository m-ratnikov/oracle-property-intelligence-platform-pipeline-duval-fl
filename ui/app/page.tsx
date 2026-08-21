"use client";

import Link from "next/link";
import { useMemo } from "react";
import { config, ZERO_COST_LINE } from "@/lib/config";
import { useEngine, useJson } from "@/lib/hooks";
import { parseCatalog, parseCoverage, parseRunHistory, sortRunsDesc } from "@/lib/types";
import { formatInt, formatTimestamp, relativeTime, signedDelta } from "@/lib/format";
import { PageHeader, Section, Stat, Callout, Spinner, ErrorBox } from "@/components/ui";
import { EngineStatus } from "@/components/EngineStatus";
import { ArtifactCard } from "@/components/ArtifactCard";
import { SampleBadge } from "@/components/SampleBanner";

export default function OverviewPage() {
  const engine = useEngine();
  const history = useJson(config.runHistoryUrl, parseRunHistory);
  const coverage = useJson(config.coverageUrl, parseCoverage);
  const catalog = useJson(config.catalogUrl, parseCatalog);

  const runs = useMemo(() => sortRunsDesc(history.data?.runs ?? []), [history.data]);
  const latest = runs[0] ?? null;
  const previous = runs[1] ?? null;

  const totalRowsLatest = latest
    ? latest.sources.reduce((sum, source) => sum + (source.rows_fetched ?? 0), 0)
    : null;
  const totalInsertedLatest = latest
    ? latest.sources.reduce((sum, source) => sum + (source.inserted ?? 0), 0)
    : null;
  const totalUpdatedLatest = latest
    ? latest.sources.reduce((sum, source) => sum + (source.updated ?? 0), 0)
    : null;

  const county = catalog.data?.counties.find((entry) => entry.countyKey === config.countyKey) ?? null;

  return (
    <div>
      <PageHeader
        title={`${config.countyName} County, ${config.stateCode}`}
        lead={
          <>
            A continuously refreshed property intelligence dataset, published to Elephant IPFS and
            queried entirely in your browser. This page is the run summary the demo opens with.
          </>
        }
        right={
          latest ? (
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-muted">Last run</div>
              <div className="text-[13px] font-semibold">{relativeTime(latest.started_at)}</div>
              <div className="mono text-[11px] text-faint">
                {formatTimestamp(latest.started_at)}
              </div>
            </div>
          ) : null
        }
      />

      <Callout tone="good" title="How this costs nothing to keep running">
        {ZERO_COST_LINE}
      </Callout>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Parcels in query table"
          loading={engine.stage !== "ready"}
          value={formatInt(engine.rowCount)}
          hint={
            engine.stage === "ready"
              ? `${engine.columns.length} published columns`
              : engine.message
          }
        />
        <Stat
          label="Rows ingested, latest run"
          loading={totalRowsLatest === null}
          value={formatInt(totalRowsLatest)}
          hint={latest ? `across ${latest.sources.length} sources` : undefined}
        />
        <Stat
          label="New rows, latest run"
          loading={totalInsertedLatest === null}
          value={formatInt(totalInsertedLatest)}
          hint={
            totalUpdatedLatest === null
              ? undefined
              : `${formatInt(totalUpdatedLatest)} existing rows changed`
          }
          tone={totalInsertedLatest && totalInsertedLatest > 0 ? "good" : "neutral"}
        />
        <Stat
          label="Runs on record"
          loading={history.loading}
          value={formatInt(runs.length)}
          hint={
            previous
              ? `previous run ${relativeTime(previous.started_at)}`
              : "incremental history published with the data"
          }
        />
      </div>

      <div className="mt-5">
        <EngineStatus />
      </div>

      <div className="mt-7">
        <Section
          title="Totals by source, latest run"
          description="Straight from the published run history. Delta is the change against the previous run, which is what makes this an incremental pipeline rather than a one shot load."
          right={<SampleBadge />}
        >
          {history.loading ? <Spinner label="Loading run history" /> : null}
          {history.error ? <ErrorBox title="Run history unavailable" message={history.error} /> : null}
          {latest ? (
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>source</th>
                    <th>rows fetched</th>
                    <th>inserted</th>
                    <th>updated</th>
                    <th>unchanged</th>
                    <th>delta vs previous</th>
                    <th>limitations</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.sources.map((source) => (
                    <tr key={source.source}>
                      <td>
                        <span className="mono font-semibold">{source.source}</span>
                        {source.source_url ? (
                          <>
                            {" "}
                            <a
                              className="text-[11px]"
                              href={source.source_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              source
                            </a>
                          </>
                        ) : null}
                      </td>
                      <td className="num">{formatInt(source.rows_fetched)}</td>
                      <td className="num">{formatInt(source.inserted)}</td>
                      <td className="num">{formatInt(source.updated)}</td>
                      <td className="num">{formatInt(source.unchanged)}</td>
                      <td className="num">
                        <span
                          className={
                            (source.delta_vs_previous ?? 0) > 0 ? "text-good" : "text-muted"
                          }
                        >
                          {signedDelta(source.delta_vs_previous)}
                        </span>
                      </td>
                      <td style={{ whiteSpace: "normal", maxWidth: 420 }}>
                        {source.limitations.length === 0 ? (
                          <span className="text-[12px] text-faint">none recorded</span>
                        ) : (
                          <ul className="list-disc pl-4 text-[12px] text-warn">
                            {source.limitations.map((limitation) => (
                              <li key={limitation}>{limitation}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="mt-2 text-[12px] text-muted">
            Full history with per run deltas and a cumulative chart is on the{" "}
            <Link href="/runs">Runs</Link> page. Per source coverage against expected totals is on{" "}
            <Link href="/data">Data</Link>.
          </p>
        </Section>

        <Section
          title="Published Elephant IPFS artifacts"
          description="Every artifact the latest run published, with its content identifier, its stable IPNS pointer and the gateway URL an MCP client or DuckDB opens directly."
          right={<SampleBadge />}
        >
          {latest && latest.artifacts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {latest.artifacts.map((artifact) => (
                <ArtifactCard key={`${artifact.name}-${artifact.cid}`} artifact={artifact} />
              ))}
            </div>
          ) : history.loading ? (
            <Spinner label="Loading artifacts" />
          ) : (
            <Callout tone="warn">
              The latest run published no artifact list. Nothing is invented here: if the pipeline
              did not record CIDs, this page shows none.
            </Callout>
          )}
        </Section>

        <Section
          title="Catalog entry"
          description="The published-counties catalog is what an MCP client reads to discover this dataset."
          right={<SampleBadge />}
        >
          {catalog.error ? <ErrorBox title="Catalog unavailable" message={catalog.error} /> : null}
          {county ? (
            <div className="card card-pad">
              <dl className="kv text-[12.5px]">
                <dt>countyKey</dt>
                <dd className="mono">{county.countyKey}</dd>
                <dt>countyName / state / FIPS</dt>
                <dd className="mono">
                  {county.countyName ?? "?"} / {county.stateCode ?? "?"} /{" "}
                  {county.countyFips ?? "?"}
                </dd>
                <dt>status</dt>
                <dd>
                  <span
                    className={
                      county.status === "published" ? "badge badge-good" : "badge badge-warn"
                    }
                  >
                    {county.status ?? "unknown"}
                  </span>
                </dd>
                <dt>queryTableUrl</dt>
                <dd className="mono break-all">
                  {county.queryTableUrl ? (
                    <a href={county.queryTableUrl} target="_blank" rel="noreferrer">
                      {county.queryTableUrl}
                    </a>
                  ) : (
                    <span className="na">not available</span>
                  )}
                </dd>
                <dt>datasetCoverageUrl</dt>
                <dd className="mono break-all">
                  {county.datasetCoverageUrl ? (
                    <a href={county.datasetCoverageUrl} target="_blank" rel="noreferrer">
                      {county.datasetCoverageUrl}
                    </a>
                  ) : (
                    <span className="na">not available</span>
                  )}
                </dd>
                <dt>updatedAt</dt>
                <dd className="mono">{formatTimestamp(county.updatedAt)}</dd>
              </dl>
            </div>
          ) : catalog.loading ? (
            <Spinner label="Loading catalog" />
          ) : (
            <Callout tone="warn">
              No catalog entry found for county key{" "}
              <span className="mono">{config.countyKey}</span>.
            </Callout>
          )}
        </Section>

        <Section
          title="Where to go next"
          description="The pages below follow the demo transcript in order."
        >
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { href: "/runs", title: "Run history", body: "Every run, per source deltas, documented source limitations, cumulative rows chart." },
              { href: "/data", title: "Data and coverage", body: "Record counts per table, ingested against expected, per column non null coverage computed live." },
              { href: "/query", title: "DuckDB workbench", body: "Write SQL against the published parquet. Read only, limit enforced, CSV export." },
              { href: "/questions", title: "The six questions", body: "Roof age, water view, ownership hold, regional owners, transit and Starbucks walking distance." },
              { href: "/agent", title: "Agent", body: "Chat over the same data with a tool call transcript and an evidence panel." },
              { href: "/mcp", title: "MCP", body: "How to connect a client, the env map we deploy with, and a live IPNS resolution check." },
            ].map((card) => (
              <Link
                key={card.href}
                href={card.href}
                className="card card-pad !text-text hover:!no-underline hover:border-accent"
              >
                <div className="text-[13.5px] font-semibold">{card.title}</div>
                <div className="mt-1 text-[12.5px] text-muted">{card.body}</div>
              </Link>
            ))}
          </div>
        </Section>
      </div>

      {coverage.error ? (
        <Callout tone="warn" title="Coverage snapshot unavailable">
          <span className="mono">{coverage.error}</span>
        </Callout>
      ) : null}
    </div>
  );
}
