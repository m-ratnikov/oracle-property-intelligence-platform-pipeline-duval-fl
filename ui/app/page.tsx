"use client";

import Link from "next/link";
import { useMemo } from "react";
import { config, ZERO_COST_LINE } from "@/lib/config";
import { publicationLookup, parseArtifactsIndex } from "@/lib/artifacts";
import { tableDeltaNoteLookup } from "@/lib/writers";
import { useEngine, useJson, useSlowLoad } from "@/lib/hooks";
import {
  latestConsolidationRun,
  latestIngestionRun,
  parseCatalog,
  parseCoverage,
  parseRunHistory,
  sortRunsDesc,
  summariseRun,
} from "@/lib/types";
import {
  formatElapsed,
  formatInt,
  formatTimestamp,
  relativeTime,
} from "@/lib/format";
import {
  ArtifactPreload,
  PageHeader,
  Section,
  Stat,
  Callout,
  Spinner,
  ErrorBox,
} from "@/components/ui";
import { EngineStatus } from "@/components/EngineStatus";
import { ArtifactCard } from "@/components/ArtifactCard";
import { TableDelta } from "@/components/TableDelta";
import { SampleBadge } from "@/components/SampleBanner";

export default function OverviewPage() {
  const engine = useEngine();
  const history = useJson(config.runHistoryUrl, parseRunHistory);
  const coverage = useJson(config.coverageUrl, parseCoverage);
  const catalog = useJson(config.catalogUrl, parseCatalog);
  /*
   * One fetch for the whole page. Every artifact card on it, in both sections, resolves its
   * gateway URL and IPNS name out of this single index rather than fetching anything itself.
   */
  const artifactsIndex = useJson(config.artifactsIndexUrl, parseArtifactsIndex);

  const runs = useMemo(() => sortRunsDesc(history.data?.runs ?? []), [history.data]);
  /*
   * The history is part of the join, not just the index: a run's CID differing from the index's
   * is only a failure if no later run republished the same object.
   */
  const publicationOf = useMemo(
    () => publicationLookup(artifactsIndex.data, runs),
    [artifactsIndex.data, runs],
  );
  /*
   * Built once from the coverage snapshot this page already fetches, not once per row. It answers
   * "who moved the table" for a source whose own inserts and updates do not account for the
   * delta beside them.
   */
  const deltaNoteFor = useMemo(() => tableDeltaNoteLookup(coverage.data), [coverage.data]);

  /*
   * "The latest run" on this page means the latest run that actually ingested sources.
   *
   * A consolidation pass runs immediately after each ingestion run, so runs[0] was almost
   * always that pass: one synthetic source, and this page duly reported "across 1 sources"
   * with a totals table holding a single `consolidation` row. The consolidation evidence is
   * real and is shown below in its own section; it just never stands in for an ingestion run.
   */
  const latest = useMemo(() => latestIngestionRun(runs), [runs]);
  const previous = useMemo(
    () => runs.filter((run) => run.kind === "ingestion")[1] ?? null,
    [runs],
  );
  const consolidation = useMemo(() => latestConsolidationRun(runs), [runs]);
  const consolidationSummary = useMemo(
    () => (consolidation === null ? null : summariseRun(consolidation)),
    [consolidation],
  );

  const latestSummary = useMemo(() => (latest === null ? null : summariseRun(latest)), [latest]);
  const totalRowsLatest = latestSummary?.rowsVerified ?? null;
  const totalInsertedLatest = latestSummary?.rowsInserted ?? null;
  const totalUpdatedLatest = latestSummary?.rowsUpdated ?? null;

  const county = catalog.data?.counties.find((entry) => entry.countyKey === config.countyKey) ?? null;

  /*
   * The first screen of the demo is four stat tiles, and three of them cannot be answered until the
   * run history arrives from an IPFS gateway. A gateway that has not got the IPNS name warm takes
   * many seconds to answer, and the tiles used to sit there as blank boxes with no caption: the
   * page looked broken rather than busy. Nothing is invented to fill them, but every one of them
   * says what it is waiting for, and says more once the wait stops being ordinary.
   */
  const historySlow = useSlowLoad(history.loading);
  const engineSlow = useSlowLoad(engine.stage !== "ready" && engine.stage !== "error");
  const historyHint = history.error
    ? "run history unavailable, see below"
    : historySlow
      ? "still resolving the run history on the IPFS gateway"
      : "reading the published run history";

  return (
    <div>
      <ArtifactPreload
        urls={[
          config.runHistoryUrl,
          config.coverageUrl,
          config.catalogUrl,
          config.artifactsIndexUrl,
        ]}
      />
      <PageHeader
        title={`${config.countyName} County, ${config.stateCode}`}
        lead={
          <>
            A continuously refreshed property intelligence dataset, published to Elephant IPFS and
            queried entirely in your browser. This page is the run summary the demo opens with.
          </>
        }
        right={
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-muted">Last ingestion run</div>
            {latest ? (
              <>
                <div className="text-[13px] font-semibold">{relativeTime(latest.started_at)}</div>
                <div className="mono text-[11px] text-faint">
                  {formatTimestamp(latest.started_at)}
                </div>
              </>
            ) : (
              <>
                <span className="skeleton mt-1 block h-[16px] w-24" role="status" aria-label="Last ingestion run, loading" />
                <div className="mt-1 text-[11px] text-faint">{historyHint}</div>
              </>
            )}
          </div>
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
              : engineSlow
                ? `${engine.message} (DuckDB-WASM is a 33 MB module, downloaded once)`
                : engine.message
          }
        />
        <Stat
          label="Rows checked, latest ingestion run"
          loading={totalRowsLatest === null}
          value={formatInt(totalRowsLatest)}
          hint={latest ? `across ${latest.sources.length} sources` : historyHint}
        />
        <Stat
          label="New rows, latest ingestion run"
          loading={totalInsertedLatest === null}
          value={formatInt(totalInsertedLatest)}
          hint={
            totalUpdatedLatest === null
              ? historyHint
              : `${formatInt(totalUpdatedLatest)} existing rows changed`
          }
          tone={totalInsertedLatest && totalInsertedLatest > 0 ? "good" : "neutral"}
        />
        <Stat
          label="Runs on record"
          loading={history.loading}
          value={formatInt(runs.length)}
          hint={
            history.loading
              ? historyHint
              : previous
                ? `previous ingestion run ${relativeTime(previous.started_at)}`
                : "incremental history published with the data"
          }
        />
      </div>

      <div className="mt-5">
        <EngineStatus />
      </div>

      <div className="mt-7">
        <Section
          title="Totals by source, latest ingestion run"
          description="Straight from the published run history, for the newest run that actually ingested sources. Table delta is how the target table's own total moved against the previous recorded run of that track, which is what makes this an incremental pipeline rather than a one shot load."
          right={<SampleBadge />}
        >
          {history.loading ? (
            <Spinner label="Reading the published run history from the IPFS gateway" />
          ) : null}
          {history.error ? <ErrorBox title="Run history unavailable" message={history.error} /> : null}
          {latest ? (
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>source</th>
                    <th className="num">rows fetched</th>
                    <th className="num">inserted</th>
                    <th className="num">updated</th>
                    <th className="num">unchanged</th>
                    <th className="num">table delta</th>
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
                        <TableDelta source={source} note={deltaNoteFor(source)} />
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
          description="Every artifact the latest ingestion run published, with its content identifier, its stable IPNS pointer and the gateway URL an MCP client or DuckDB opens directly. The URLs and IPNS names are read from the published artifacts index, not assembled here."
          right={<SampleBadge />}
        >
          {latest && latest.artifacts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {latest.artifacts.map((artifact) => (
                <ArtifactCard
                  key={`${artifact.name}-${artifact.cid}`}
                  artifact={artifact}
                  publication={publicationOf(artifact, latest)}
                />
              ))}
            </div>
          ) : history.loading ? (
            <Spinner label="Loading artifacts" />
          ) : (
            <Callout tone="warn">
              The latest ingestion run published no artifact list. Nothing is invented here: if the
              pipeline did not record CIDs, this page shows none.
            </Callout>
          )}
        </Section>

        {consolidation && consolidationSummary ? (
          <Section
            title="Consolidation pass that followed it"
            description="A separate maintenance pass runs after each ingestion run. It re-hashes every property record, republishes only the ones whose content changed, and publishes the open-data index and manifest an Elephant client resolves. It is not a data source and never stands in for an ingestion run, but its evidence is real, so it is shown here as itself."
            right={<SampleBadge />}
          >
            <div className="card card-pad">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[13px] font-semibold">{consolidation.run_id}</span>
                  <span className="badge badge-warn">maintenance</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
                  <span title={formatTimestamp(consolidation.started_at)}>
                    ran {relativeTime(consolidation.started_at)}
                  </span>
                  <span>took {formatElapsed(consolidationSummary.durationMs)}</span>
                </div>
              </div>
              <dl className="kv mt-2 text-[12.5px]">
                <dt>property records re-hashed</dt>
                <dd className="mono">{formatInt(consolidationSummary.rowsVerified)}</dd>
                <dt>records republished</dt>
                <dd className="mono">{formatInt(consolidationSummary.rowsWritten)}</dd>
              </dl>
            </div>
            {consolidation.artifacts.length > 0 ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {consolidation.artifacts.map((artifact) => (
                  <ArtifactCard
                    key={`${consolidation.run_id}-${artifact.name}`}
                    artifact={artifact}
                    publication={publicationOf(artifact, consolidation)}
                  />
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[12px] text-muted">
              Both passes appear in one timeline on the <Link href="/runs">Runs</Link> page.
            </p>
          </Section>
        ) : null}

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
