"use client";

import { useMemo, useState } from "react";
import { config } from "@/lib/config";
import { useJson } from "@/lib/hooks";
import { cumulativeBySource, parseRunHistory, sortRunsDesc } from "@/lib/types";
import type { PipelineRun } from "@/lib/types";
import {
  formatDurationMs,
  formatInt,
  formatTimestamp,
  relativeTime,
  shortenId,
  signedDelta,
} from "@/lib/format";
import { PageHeader, Section, Callout, Spinner, ErrorBox, Stat, IdWithCopy } from "@/components/ui";
import { SourceTrends } from "@/components/Charts";
import { SampleBadge } from "@/components/SampleBanner";
import { ArtifactCard } from "@/components/ArtifactCard";

function TriggerBadge({ trigger }: { trigger: string | null }) {
  if (!trigger) return <span className="badge badge-neutral">unknown</span>;
  const tone = trigger === "schedule" ? "badge-accent" : "badge-neutral";
  return <span className={`badge ${tone}`}>{trigger}</span>;
}

function RunDetail({ run, isLatest }: { run: PipelineRun; isLatest: boolean }) {
  const limitations = run.sources.flatMap((source) =>
    source.limitations.map((limitation) => ({ source: source.source, limitation })),
  );

  return (
    <div className={`card ${isLatest ? "border-accent" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-[13px] font-semibold">{run.run_id}</span>
          <TriggerBadge trigger={run.trigger} />
          {isLatest ? <span className="badge badge-good">latest</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
          <span title={formatTimestamp(run.started_at) ?? undefined}>
            started {relativeTime(run.started_at)}
          </span>
          <span>took {formatDurationMs(run.started_at, run.finished_at)}</span>
          {run.git_sha ? (
            <span className="mono" title={run.git_sha}>
              sha {shortenId(run.git_sha, 8, 0)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="table-wrap" style={{ maxHeight: "none", border: "none", borderRadius: 0 }}>
        <table className="grid">
          <thead>
            <tr>
              <th>source</th>
              <th className="num">rows fetched</th>
              <th className="num">inserted</th>
              <th className="num">updated</th>
              <th className="num">unchanged</th>
              <th className="num">delta vs previous</th>
              <th>artifact sha256</th>
            </tr>
          </thead>
          <tbody>
            {run.sources.map((source) => (
              <tr key={source.source}>
                <td>
                  <span className="mono font-semibold">{source.source}</span>
                </td>
                <td className="num">{formatInt(source.rows_fetched)}</td>
                <td className={`num ${isLatest && (source.inserted ?? 0) > 0 ? "evidence" : ""}`}>
                  {formatInt(source.inserted)}
                </td>
                <td className={`num ${isLatest && (source.updated ?? 0) > 0 ? "evidence" : ""}`}>
                  {formatInt(source.updated)}
                </td>
                <td className="num">{formatInt(source.unchanged)}</td>
                <td className={`num ${isLatest ? "evidence" : ""}`}>
                  <span className={(source.delta_vs_previous ?? 0) > 0 ? "text-good" : "text-muted"}>
                    {signedDelta(source.delta_vs_previous)}
                  </span>
                </td>
                <td>
                  <IdWithCopy value={source.artifact_sha256} head={10} tail={6} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Documented source limitations
        </div>
        {limitations.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-faint">
            No limitations recorded for this run.
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-[12.5px]">
            {limitations.map((entry, index) => (
              <li key={`${entry.source}-${index}`} className="flex gap-2">
                <span className="badge badge-warn shrink-0">{entry.source}</span>
                <span className="text-muted">{entry.limitation}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {run.artifacts.length > 0 ? (
        <details className="border-t border-border px-4 py-3">
          <summary className="cursor-pointer text-[12.5px] text-muted">
            {run.artifacts.length} artifacts published by this run
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {run.artifacts.map((artifact) => (
              <ArtifactCard key={`${run.run_id}-${artifact.name}`} artifact={artifact} />
            ))}
          </div>
        </details>
      ) : null}

      {Object.keys(run.extra).length > 0 ? (
        <details className="border-t border-border px-4 py-3">
          <summary className="cursor-pointer text-[12.5px] text-muted">
            Additional fields published with this run
          </summary>
          <pre className="block mt-2">{JSON.stringify(run.extra, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export default function RunsPage() {
  const history = useJson(config.runHistoryUrl, parseRunHistory);
  const [showAll, setShowAll] = useState(false);

  const runsDesc = useMemo(() => sortRunsDesc(history.data?.runs ?? []), [history.data]);
  const sourceTrends = useMemo(() => {
    const cumulative = cumulativeBySource(history.data?.runs ?? []);
    return cumulative.map((entry) => ({
      name: entry.source,
      totals: entry.points.map((point) => point.total),
    }));
  }, [history.data]);

  const visible = showAll ? runsDesc : runsDesc.slice(0, 3);

  const firstRun = runsDesc[runsDesc.length - 1] ?? null;
  const latest = runsDesc[0] ?? null;
  const totalSources = new Set(runsDesc.flatMap((run) => run.sources.map((s) => s.source))).size;
  const totalLimitations = runsDesc.reduce(
    (sum, run) => sum + run.sources.reduce((inner, source) => inner + source.limitations.length, 0),
    0,
  );

  return (
    <div>
      <PageHeader
        title="Pipeline run history"
        lead="Every recorded run, in reverse order, with per source record counts and the change against the previous run. This is the evidence that ingestion is continuous rather than a single bulk load."
        right={<SampleBadge />}
      />

      {history.loading ? <Spinner label="Loading run history" /> : null}
      {history.error ? <ErrorBox title="Run history unavailable" message={history.error} /> : null}

      {runsDesc.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Runs recorded" value={formatInt(runsDesc.length)} />
            <Stat
              label="Sources tracked"
              value={formatInt(totalSources)}
              hint="property, permit, ownership, contractor, business and location data"
            />
            <Stat
              label="First run"
              value={relativeTime(firstRun?.started_at)}
              hint={formatTimestamp(firstRun?.started_at)}
            />
            <Stat
              label="Limitations logged"
              value={formatInt(totalLimitations)}
              hint="constrained or slow sources named openly"
              tone={totalLimitations > 0 ? "warn" : "neutral"}
            />
          </div>

          <Section
            title="Rows per source, run by run"
            description={`One panel per source, each on its own scale. The number is the rows that source has contributed in total; the line is how it got there across ${runsDesc.length} runs. Most panels are flat, which is what an incremental pipeline looks like once a source has caught up: it is checked every run and publishes nothing new. The per run figures behind these panels are in the table below.`}
          >
            <SourceTrends sources={sourceTrends} runCount={runsDesc.length} />
          </Section>

          <Section
            title="Runs"
            description="The latest run's deltas are highlighted."
            right={
              runsDesc.length > 3 ? (
                <button type="button" className="btn btn-sm" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "show latest 3" : `show all ${runsDesc.length}`}
                </button>
              ) : null
            }
          >
            <div className="space-y-4">
              {visible.map((run) => (
                <RunDetail key={run.run_id} run={run} isLatest={run.run_id === latest?.run_id} />
              ))}
            </div>
          </Section>
        </>
      ) : !history.loading && !history.error ? (
        <Callout tone="warn" title="No runs published yet">
          The run history artifact parsed cleanly but contains no runs. Once the pipeline completes a
          run this page fills in.
        </Callout>
      ) : null}

      {history.data?.generatedAt ? (
        <p className="mt-4 text-[11.5px] text-faint">
          Run history generated {formatTimestamp(history.data.generatedAt)} for county{" "}
          <span className="mono">{history.data.county ?? config.countyKey}</span>. Read from{" "}
          <span className="mono break-all">{config.runHistoryUrl}</span>.
        </p>
      ) : null}
    </div>
  );
}
