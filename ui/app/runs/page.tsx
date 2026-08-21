"use client";

import { useMemo, useState } from "react";
import { config } from "@/lib/config";
import { tableDeltaNoteLookup } from "@/lib/writers";
import { publicationLookup, parseArtifactsIndex, type ArtifactPublication } from "@/lib/artifacts";
import { useJson } from "@/lib/hooks";
import {
  distinctLimitations,
  ingestionSourceNames,
  parseCoverage,
  parseRunHistory,
  summariseRuns,
} from "@/lib/types";
import type { PipelineRun, RunSummary } from "@/lib/types";
import {
  formatElapsed,
  formatInt,
  formatTimestamp,
  relativeTime,
  shortenId,
  signedDelta,
} from "@/lib/format";
import { PageHeader, Section, Callout, Spinner, ErrorBox, Stat, IdWithCopy } from "@/components/ui";
import { RunCadence, VerifiedAgainstWritten } from "@/components/RunCharts";
import { SampleBadge } from "@/components/SampleBanner";
import { ArtifactCard } from "@/components/ArtifactCard";
import { TableDelta } from "@/components/TableDelta";

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge badge-neutral">unknown</span>;
  const tone =
    status === "completed"
      ? "badge-good"
      : status === "failed" || status === "aborted"
        ? "badge-bad"
        : status === "running"
          ? "badge-accent"
          : "badge-warn";
  return <span className={`badge ${tone}`}>{status}</span>;
}

function KindBadge({ kind }: { kind: RunSummary["kind"] }) {
  return kind === "consolidation" ? (
    <span className="badge badge-warn" title="Maintenance pass: re-hashes and republishes the property records the ingestion runs loaded. Not a data source.">
      maintenance
    </span>
  ) : (
    <span className="badge badge-accent">ingestion</span>
  );
}

/** The per source detail that used to be an always open card, now folded into its row. */
function RunDetail({
  run,
  publicationOf,
  deltaNoteFor,
}: {
  run: PipelineRun;
  publicationOf: (artifact: PipelineRun["artifacts"][number], run: PipelineRun) => ArtifactPublication;
  deltaNoteFor: (source: PipelineRun["sources"][number]) => string | null;
}) {
  const limitations = run.sources.flatMap((source) =>
    source.limitations.map((limitation) => ({ source: source.source, limitation })),
  );

  return (
    <div className="border-t border-border bg-sunken px-3 py-3">
      <div className="table-wrap" style={{ maxHeight: "none" }}>
        <table className="grid">
          <thead>
            <tr>
              <th>source</th>
              <th>status</th>
              <th className="num">rows checked</th>
              <th className="num">inserted</th>
              <th className="num">updated</th>
              <th className="num">unchanged</th>
              <th className="num">table rows after</th>
              <th className="num">table delta</th>
              <th>artifact sha256</th>
            </tr>
          </thead>
          <tbody>
            {run.sources.map((source) => (
              <tr key={source.source}>
                <td>
                  <span className="mono font-semibold">{source.source}</span>
                </td>
                <td>
                  <StatusBadge status={source.status} />
                </td>
                <td className="num">{formatInt(source.rows_fetched)}</td>
                <td className={`num ${(source.inserted ?? 0) > 0 ? "evidence" : ""}`}>
                  {formatInt(source.inserted)}
                </td>
                <td className={`num ${(source.updated ?? 0) > 0 ? "evidence" : ""}`}>
                  {formatInt(source.updated)}
                </td>
                <td className="num">{formatInt(source.unchanged)}</td>
                <td className="num">{formatInt(source.table_total_after)}</td>
                <td className="num">
                  <TableDelta source={source} note={deltaNoteFor(source)} />
                </td>
                <td>
                  <IdWithCopy value={source.artifact_sha256} head={10} tail={6} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11.5px] text-faint">
        Table rows after is the whole target table once this run&apos;s merge finished, so a table
        two tracks write into (sales_history, written by both sales and pa_detail) shows more rows
        than this source staged. Table delta is that total against the previous recorded run of the
        same track.
      </p>

      <div className="mt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Documented source limitations
        </div>
        {limitations.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-faint">No limitations recorded for this run.</p>
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
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {run.artifacts.length} artifacts published by this run
          </div>
          <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {run.artifacts.map((artifact) => (
              <ArtifactCard
                key={`${run.run_id}-${artifact.name}`}
                artifact={artifact}
                publication={publicationOf(artifact, run)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {Object.keys(run.extra).length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12.5px] text-muted">
            Additional fields published with this run
          </summary>
          <pre className="block mt-2">{JSON.stringify(run.extra, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function RunRow({
  summary,
  open,
  onToggle,
  publicationOf,
  deltaNoteFor,
}: {
  summary: RunSummary;
  open: boolean;
  onToggle: () => void;
  publicationOf: (artifact: PipelineRun["artifacts"][number], run: PipelineRun) => ArtifactPublication;
  deltaNoteFor: (source: PipelineRun["sources"][number]) => string | null;
}) {
  const run = summary.run;
  const sourceCounts = [
    `${summary.sourcesCompleted} ran`,
    summary.sourcesSkipped > 0 ? `${summary.sourcesSkipped} skipped` : null,
    summary.sourcesFailed > 0 ? `${summary.sourcesFailed} failed` : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <tr
        className="cursor-pointer"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? "Collapse per source detail" : "Expand per source detail"}
      >
        <td>
          <button
            type="button"
            className="btn btn-sm"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-label={`${open ? "Collapse" : "Expand"} run ${run.run_id}`}
          >
            {open ? "hide" : "detail"}
          </button>
        </td>
        <td>
          <div className="mono text-[12px] font-semibold">{shortenId(run.run_id, 8, 5)}</div>
          <div className="mono text-[11px] text-faint">{formatTimestamp(run.started_at)}</div>
        </td>
        <td className="text-[11.5px] text-muted">{relativeTime(run.started_at)}</td>
        <td>
          <div className="flex flex-wrap gap-1">
            <KindBadge kind={summary.kind} />
            <StatusBadge status={run.status} />
          </div>
          <div className="mt-0.5 text-[11px] text-faint">{run.trigger ?? "unknown trigger"}</div>
        </td>
        <td className="num">{formatElapsed(summary.durationMs)}</td>
        <td className="text-[11.5px] text-muted">
          {sourceCounts.join(", ")}
          <span className="text-faint"> of {summary.trackCount}</span>
        </td>
        <td className="num">{formatInt(summary.rowsVerified)}</td>
        <td className={`num ${summary.rowsInserted > 0 ? "evidence" : ""}`}>
          {formatInt(summary.rowsInserted)}
        </td>
        <td className={`num ${summary.rowsUpdated > 0 ? "evidence" : ""}`}>
          {formatInt(summary.rowsUpdated)}
        </td>
        <td className="num">
          <span className={(summary.tableDelta ?? 0) > 0 ? "text-good" : "text-muted"}>
            {signedDelta(summary.tableDelta)}
          </span>
        </td>
        <td className="mono text-[11px]">
          {run.git_sha ? (
            <span title={run.git_sha}>{shortenId(run.git_sha, 7, 0)}</span>
          ) : (
            <span className="na">none</span>
          )}
        </td>
        <td className="num">{formatInt(summary.artifactCount)}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={12} style={{ padding: 0 }}>
            <RunDetail run={run} publicationOf={publicationOf} deltaNoteFor={deltaNoteFor} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function RunsPage() {
  const history = useJson(config.runHistoryUrl, parseRunHistory);
  /*
   * One fetch for the page, shared by every artifact card in every expanded run. Run records
   * carry CIDs only; the gateway URL and the IPNS name come from this published index.
   */
  const artifactsIndex = useJson(config.artifactsIndexUrl, parseArtifactsIndex);
  /*
   * One coverage fetch for the page, shared by every source row in every expanded run. It is what
   * turns "table delta +1,782 with nothing inserted" into a row that says who moved the table.
   */
  const coverage = useJson(config.coverageUrl, parseCoverage);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const runs = useMemo(() => history.data?.runs ?? [], [history.data]);
  // The history is part of the join: see the comment on publicationLookup.
  const publicationOf = useMemo(
    () => publicationLookup(artifactsIndex.data, runs),
    [artifactsIndex.data, runs],
  );
  const deltaNoteFor = useMemo(() => tableDeltaNoteLookup(coverage.data), [coverage.data]);
  const summaries = useMemo(() => summariseRuns(runs), [runs]);
  const ingestion = useMemo(() => summaries.filter((s) => s.kind === "ingestion"), [summaries]);
  const consolidation = useMemo(
    () => summaries.filter((s) => s.kind === "consolidation"),
    [summaries],
  );
  const sourceNames = useMemo(() => ingestionSourceNames(runs), [runs]);
  const limitations = useMemo(() => distinctLimitations(runs), [runs]);

  const firstRun = summaries[summaries.length - 1] ?? null;
  const latestIngestion = ingestion[0] ?? null;
  const rewriteShare =
    latestIngestion && latestIngestion.rowsVerified > 0
      ? (latestIngestion.rowsWritten / latestIngestion.rowsVerified) * 100
      : null;

  return (
    <div>
      <PageHeader
        title="Pipeline run history"
        lead="Every recorded run, newest first, with what it checked, what it had to write and what it published. This is the evidence that ingestion is continuous rather than a single bulk load."
        right={<SampleBadge />}
      />

      {history.loading ? <Spinner label="Loading run history" /> : null}
      {history.error ? <ErrorBox title="Run history unavailable" message={history.error} /> : null}

      {summaries.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Runs recorded"
              value={formatInt(summaries.length)}
              hint={`${formatInt(ingestion.length)} ingestion, ${formatInt(consolidation.length)} consolidation, first ${relativeTime(firstRun?.run.started_at)}`}
            />
            <Stat
              label="Sources tracked"
              value={formatInt(sourceNames.length)}
              hint="Distinct ingestion sources. The consolidation pass is maintenance, not a source, so it is not one of these."
            />
            <Stat
              label="Rows checked, latest ingestion run"
              value={formatInt(latestIngestion?.rowsVerified ?? null)}
              hint={
                latestIngestion
                  ? `re-verified in ${formatElapsed(latestIngestion.durationMs)}`
                  : undefined
              }
            />
            <Stat
              label="Rows written, latest ingestion run"
              value={formatInt(latestIngestion?.rowsWritten ?? null)}
              tone={(latestIngestion?.rowsWritten ?? 0) > 0 ? "good" : "neutral"}
              hint={
                rewriteShare === null
                  ? undefined
                  : `${rewriteShare < 0.01 ? "<0.01" : rewriteShare.toFixed(2)}% of what it checked, which is what incremental means`
              }
            />
          </div>

          <div className="mt-7 grid gap-4 xl:grid-cols-2">
            <Section
              title="What each run checked, against what it had to write"
              description="Every ingestion run reads its sources in full and compares them against what is stored. The gap between the two lines is the work the pipeline avoided by being incremental: after the first load it re-verifies millions of rows and writes a few hundred."
            >
              <VerifiedAgainstWritten runs={ingestion} />
            </Section>

            <Section
              title="When runs happened, and how long they took"
              description="Cadence and cost on one wall clock axis. The consolidation passes shrink from nine minutes to under half a minute as the content-hash state warms, which is the cache paying for itself."
            >
              <RunCadence runs={summaries} />
            </Section>
          </div>

          <Section
            title="Run by run"
            description="Every recorded run, newest first. Open a row for its per source counts, documented limitations and published artifacts. This table is also the accessible twin of the two charts above: every number they plot is a column here."
            right={
              <span className="text-[11.5px] text-muted">
                {formatInt(summaries.length)} runs, none hidden
              </span>
            }
          >
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th />
                    <th>run</th>
                    <th>when</th>
                    <th>kind / status</th>
                    <th className="num">took</th>
                    <th>sources</th>
                    <th className="num">rows checked</th>
                    <th className="num">inserted</th>
                    <th className="num">updated</th>
                    <th className="num">table delta</th>
                    <th>git sha</th>
                    <th className="num">artifacts</th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((summary) => (
                    <RunRow
                      key={summary.run_id}
                      summary={summary}
                      open={openRun === summary.run_id}
                      onToggle={() =>
                        setOpenRun(openRun === summary.run_id ? null : summary.run_id)
                      }
                      publicationOf={publicationOf}
                      deltaNoteFor={deltaNoteFor}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Documented source limitations"
            description="Counted once each, not once per run. A constraint is a property of a source: the same two sales caveats hold on every run, and reporting them once per run turned one constraint into fourteen problems."
          >
            {limitations.length === 0 ? (
              <Callout tone="good">No limitations recorded on any run.</Callout>
            ) : (
              <ul className="space-y-1 text-[12.5px]">
                {limitations.map((entry) => (
                  <li key={`${entry.source}-${entry.limitation}`} className="flex gap-2">
                    <span className="badge badge-warn shrink-0">{entry.source}</span>
                    <span className="text-muted">{entry.limitation}</span>
                  </li>
                ))}
              </ul>
            )}
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
          <span className="mono break-all">{config.runHistoryUrl}</span>. All timestamps are UTC.
        </p>
      ) : null}
    </div>
  );
}
