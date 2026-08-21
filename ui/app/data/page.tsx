"use client";

import { useEffect, useMemo, useState } from "react";
import { config } from "@/lib/config";
import { useEngineBoot, useJson } from "@/lib/hooks";
import { parseCoverage } from "@/lib/types";
import { runQuery } from "@/lib/duckdb";
import { queryTableParquetUrl } from "@/lib/config";
import {
  RUN_BREAKDOWN_SQL,
  SOURCE_SYSTEM_BREAKDOWN_SQL,
  TOTAL_ALIAS,
  columnCoverageSql,
  valueBreakdownSql,
} from "@/lib/sql";
import { ALL_EXPECTED_COLUMNS, CANONICAL_COLUMNS, EXTRA_COLUMNS } from "@/lib/columns";
import { formatInt, formatTimestamp, NOT_AVAILABLE } from "@/lib/format";
import {
  blockedReasons,
  parseCoverageStatuses,
  STATE_BADGE,
  STATE_LABEL,
  unavailableSources,
} from "@/lib/coverageStatus";
import {
  ArtifactPreload,
  PageHeader,
  Section,
  Callout,
  Spinner,
  ErrorBox,
  Stat,
} from "@/components/ui";
import { CoverageBar, NonNullBar } from "@/components/Charts";
import { EngineStatus } from "@/components/EngineStatus";
import { SampleBadge } from "@/components/SampleBanner";

interface ColumnCoverage {
  column: string;
  nonNull: number;
  total: number;
  status: "canonical" | "extra" | "unexpected";
}

const BREAKDOWN_COLUMNS = ["roof_age_basis", "water_basis", "owner_region_class", "property_type"];

export default function DataPage() {
  const engine = useEngineBoot();
  const coverage = useJson(config.coverageUrl, parseCoverage);

  const [columnCoverage, setColumnCoverage] = useState<ColumnCoverage[] | null>(null);
  const [sourceRows, setSourceRows] = useState<Record<string, unknown>[] | null>(null);
  const [runRows, setRunRows] = useState<Record<string, unknown>[] | null>(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, Record<string, unknown>[]>>({});
  const [computeError, setComputeError] = useState<string | null>(null);

  const availableColumns = useMemo(
    () => engine.columns.map((column) => column.name),
    [engine.columns],
  );

  useEffect(() => {
    if (engine.stage !== "ready" || availableColumns.length === 0) return;
    let cancelled = false;

    const url = queryTableParquetUrl();
    const expected = new Set<string>(ALL_EXPECTED_COLUMNS);
    const canonical = new Set<string>(CANONICAL_COLUMNS);

    (async () => {
      try {
        const coverageResult = await runQuery(url, columnCoverageSql(availableColumns));
        const row = coverageResult.rows[0] ?? {};
        const total = Number(row[TOTAL_ALIAS] ?? 0);
        const mapped: ColumnCoverage[] = availableColumns.map((column) => ({
          column,
          nonNull: Number(row[column] ?? 0),
          total,
          status: canonical.has(column)
            ? "canonical"
            : expected.has(column)
              ? "extra"
              : "unexpected",
        }));
        if (!cancelled) setColumnCoverage(mapped);

        const sources = await runQuery(url, SOURCE_SYSTEM_BREAKDOWN_SQL);
        if (!cancelled) setSourceRows(sources.rows);

        if (availableColumns.includes("run_id")) {
          const runs = await runQuery(url, RUN_BREAKDOWN_SQL);
          if (!cancelled) setRunRows(runs.rows);
        }

        const next: Record<string, Record<string, unknown>[]> = {};
        for (const column of BREAKDOWN_COLUMNS) {
          if (!availableColumns.includes(column)) continue;
          const result = await runQuery(url, valueBreakdownSql(column));
          next[column] = result.rows;
        }
        if (!cancelled) setBreakdowns(next);
      } catch (error: unknown) {
        if (!cancelled) {
          setComputeError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine.stage, availableColumns]);

  const missingCanonical = useMemo(
    () => CANONICAL_COLUMNS.filter((column) => !availableColumns.includes(column)),
    [availableColumns],
  );

  const emptyColumns = useMemo(
    () => (columnCoverage ?? []).filter((entry) => entry.nonNull === 0),
    [columnCoverage],
  );

  const sortedCoverage = useMemo(() => {
    if (!columnCoverage) return null;
    const order = { canonical: 0, extra: 1, unexpected: 2 } as const;
    return [...columnCoverage].sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return ALL_EXPECTED_COLUMNS.indexOf(a.column as never) -
        ALL_EXPECTED_COLUMNS.indexOf(b.column as never) || a.column.localeCompare(b.column);
    });
  }, [columnCoverage]);

  const coverageDatasets = coverage.data?.datasets ?? [];
  // ingested_count is scoped to the rows its source owns, so a table written by more than one track
  // reports the rest separately. Adding both counts every stored row exactly once.
  const totalIngested = coverageDatasets.reduce(
    (sum, dataset) => sum + (dataset.ingested_count ?? 0) + (dataset.rows_from_other_tracks ?? 0),
    0,
  );

  /*
   * The published snapshot carries more than counts. Each source also records whether it is
   * implemented, whether the source itself blocks collection, why the last run skipped it and the
   * limitations the pipeline documented. The shared coverage parser models only the counts, so the
   * flags are read from the same response's raw JSON. Without them a blocked source and a complete
   * one are the same arithmetic, which is how a WAF that 403s every request rendered as a full bar.
   */
  const statuses = useMemo(() => parseCoverageStatuses(coverage.raw), [coverage.raw]);
  const unavailable = useMemo(() => unavailableSources(statuses), [statuses]);
  const ingestedSources = coverageDatasets.length - unavailable.length;

  return (
    <div>
      <ArtifactPreload urls={[config.coverageUrl]} />
      <PageHeader
        title="Data and coverage"
        lead="What is actually loaded, how much of each source that represents, and which published columns are empty. The numbers on this page are computed live, not written down."
        right={<SampleBadge />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Parcels in query table"
          loading={engine.stage !== "ready"}
          value={formatInt(engine.rowCount)}
          hint={
            engine.stage === "ready"
              ? "one row per folio, the query table contract"
              : engine.message
          }
        />
        <Stat
          label="Rows across all sources"
          loading={coverage.loading}
          value={formatInt(totalIngested)}
          hint={
            coverage.loading
              ? "reading the published coverage snapshot"
              : `${ingestedSources} of ${coverageDatasets.length} registered sources carry rows`
          }
        />
        <Stat
          label="Published columns"
          loading={engine.stage !== "ready"}
          value={formatInt(engine.columns.length)}
          hint={`${CANONICAL_COLUMNS.length} canonical plus pipeline extras`}
        />
        <Stat
          label="Columns with no data"
          loading={columnCoverage === null}
          value={formatInt(emptyColumns.length)}
          tone={emptyColumns.length > 0 ? "warn" : "good"}
          hint={
            columnCoverage === null
              ? "counting non null values across every column"
              : "published but entirely null, listed below"
          }
        />
      </div>

      <div className="mt-5">
        <EngineStatus />
      </div>

      {computeError ? (
        <div className="mt-4">
          <ErrorBox title="Could not compute column coverage" message={computeError} />
        </div>
      ) : null}

      <div className="mt-7">
        <Section
          title="Coverage per source"
          description="From the published dataset-coverage snapshot. Expected counts come from the source itself where the source publishes one. Where it does not, this page says so instead of inventing a denominator, and a source that could not be collected at all is reported as blocked rather than as complete."
        >
          {coverage.loading ? <Spinner label="Loading coverage snapshot" /> : null}
          {coverage.error ? (
            <ErrorBox title="Coverage snapshot unavailable" message={coverage.error} />
          ) : null}

          {unavailable.length > 0 ? (
            <div className="mb-3" data-testid="unavailable-sources">
              <Callout
                tone="warn"
                title={`${unavailable.length} of ${coverageDatasets.length} registered sources carry no rows`}
              >
                <p>
                  {ingestedSources} sources were ingested. The rest are listed here with the reason
                  the pipeline recorded, taken verbatim from the published snapshot. None of them is
                  counted as coverage anywhere on this page.
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {unavailable.map((status) => (
                    <li key={status.source}>
                      <span className="mono font-semibold">{status.source}</span>{" "}
                      <span className={STATE_BADGE[status.state]}>{STATE_LABEL[status.state]}</span>
                      <ul className="mt-0.5 list-disc pl-5">
                        {blockedReasons(status).map((reason) => (
                          <li key={reason} className="text-[12px]" style={{ whiteSpace: "normal" }}>
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}

          {coverageDatasets.length > 0 ? (
            <div className="table-wrap" style={{ maxHeight: "none" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>source</th>
                    <th className="num">ingested</th>
                    <th className="num">expected</th>
                    <th style={{ minWidth: 240 }}>coverage</th>
                    <th>first loaded</th>
                    <th>last loaded</th>
                    <th>ipns label</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageDatasets.map((dataset) => {
                    const status = statuses.get(dataset.source);
                    /*
                     * A source that ingested nothing has no denominator, whatever integer the
                     * snapshot happens to carry. `expected_count` is what the last completed run
                     * staged, so a blocked source reports 0 there; printing that 0 beside a 0
                     * ingested count is what produced "0 / 0 = 100.0%".
                     */
                    const expectedIsMeasured =
                      dataset.expected_count !== null &&
                      dataset.expected_count !== 0 &&
                      (dataset.ingested_count ?? 0) > 0;
                    return (
                      <tr key={dataset.source} data-testid={`coverage-row-${dataset.source}`}>
                        <td className="mono font-semibold">{dataset.source}</td>
                        <td className="num">{formatInt(dataset.ingested_count)}</td>
                        <td className="num">
                          {expectedIsMeasured ? (
                            formatInt(dataset.expected_count)
                          ) : (
                            <span
                              className="na"
                              title="No completed run staged rows from this source, so there is no expected total to compare against."
                            >
                              {NOT_AVAILABLE}
                            </span>
                          )}
                        </td>
                        <td>
                          <CoverageBar
                            ingested={dataset.ingested_count}
                            expected={expectedIsMeasured ? dataset.expected_count : null}
                            rowsFromOtherTracks={dataset.rows_from_other_tracks}
                            additionalRowsBySource={dataset.additional_rows_by_source}
                            status={status}
                          />
                        </td>
                        <td className="mono text-[11.5px]">
                          {formatTimestamp(dataset.first_loaded_at)}
                        </td>
                        <td className="mono text-[11.5px]">
                          {formatTimestamp(dataset.last_loaded_at)}
                        </td>
                        <td className="mono text-[11.5px]">
                          {dataset.ipns_label ?? <span className="na">{NOT_AVAILABLE}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="mt-2 max-w-3xl text-[12.5px] text-muted">
            Where <span className="mono">expected</span> equals{" "}
            <span className="mono">ingested</span>, the expected total is what the last completed run
            staged from the source rather than a figure the source publishes separately, so the
            meter reads &quot;everything the source offered was stored&quot; and not &quot;this is
            all the data that exists&quot;.
          </p>
        </Section>

        <Section
          title="Provenance"
          description="Every row in the query table carries where it came from. These counts are computed in DuckDB against the published parquet right now."
        >
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-muted">By source system</div>
              {sourceRows ? (
                <div className="table-wrap" style={{ maxHeight: 260 }}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>source_system</th>
                        <th className="num">rows</th>
                        <th>first fetched</th>
                        <th>last fetched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceRows.map((row, index) => (
                        <tr key={index}>
                          <td className="mono">{String(row.source_system)}</td>
                          <td className="num">{formatInt(Number(row.rows))}</td>
                          <td className="mono text-[11.5px]">
                            {formatTimestamp(row.first_fetched_at)}
                          </td>
                          <td className="mono text-[11.5px]">
                            {formatTimestamp(row.last_fetched_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Spinner label="Counting rows by source system" />
              )}
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-muted">
                By pipeline run that last touched the parcel
              </div>
              {runRows ? (
                <div className="table-wrap" style={{ maxHeight: 260 }}>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>run_id</th>
                        <th className="num">parcels touched</th>
                        <th>last fetched</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runRows.map((row, index) => (
                        <tr key={index}>
                          <td className="mono">{String(row.run_id)}</td>
                          <td className="num">{formatInt(Number(row.parcels_touched))}</td>
                          <td className="mono text-[11.5px]">
                            {formatTimestamp(row.last_fetched_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : engine.stage === "ready" ? (
                <Callout tone="warn">
                  The published query table has no <span className="mono">run_id</span> column, so
                  rows cannot be attributed to a run from this artifact alone.
                </Callout>
              ) : (
                <Spinner label="Waiting for the query engine" />
              )}
            </div>
          </div>

          <p className="mt-3 max-w-3xl text-[12.5px] text-muted">
            Provenance is carried on the row, not in a side table:{" "}
            <span className="mono">source_system</span> names the system of record,{" "}
            <span className="mono">source_url</span> links the page or file the value came from,{" "}
            <span className="mono">fetched_at</span> is when the pipeline collected it and{" "}
            <span className="mono">run_id</span> ties it to an entry in the run history. Every result
            grid in this UI shows those fields, which is how an answer here can be checked against
            the county.
          </p>
        </Section>

        <Section
          title="Per column non null coverage"
          description="Computed with a single DuckDB pass over the published parquet. A column at zero percent is published but empty, and this page names it rather than letting a blank cell imply the data exists."
        >
          {missingCanonical.length > 0 ? (
            <div className="mb-3">
              <Callout tone="warn" title="Canonical columns missing from the published artifact">
                <span className="mono">{missingCanonical.join(", ")}</span>. Any question that needs
                one of these is disabled on the Questions page rather than silently returning
                nothing.
              </Callout>
            </div>
          ) : null}

          {emptyColumns.length > 0 ? (
            <div className="mb-3">
              <Callout tone="warn" title="Published but entirely null">
                <span className="mono">
                  {emptyColumns.map((entry) => entry.column).join(", ")}
                </span>
              </Callout>
            </div>
          ) : null}

          {sortedCoverage ? (
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>column</th>
                    <th>type</th>
                    <th>contract</th>
                    <th className="num">non null</th>
                    <th style={{ minWidth: 190 }}>coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCoverage.map((entry) => {
                    const meta = engine.columns.find((column) => column.name === entry.column);
                    return (
                      <tr key={entry.column}>
                        <td className="mono">{entry.column}</td>
                        <td className="mono text-[11.5px] text-muted">{meta?.type ?? "?"}</td>
                        <td>
                          {entry.status === "canonical" ? (
                            <span className="badge badge-neutral">canonical</span>
                          ) : entry.status === "extra" ? (
                            <span className="badge badge-accent">pipeline extra</span>
                          ) : (
                            <span className="badge badge-warn">unexpected</span>
                          )}
                        </td>
                        <td className="num">
                          {formatInt(entry.nonNull)} / {formatInt(entry.total)}
                        </td>
                        <td>
                          <NonNullBar nonNull={entry.nonNull} total={entry.total} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : engine.stage === "ready" ? (
            <Spinner label="Counting non null values across every column" />
          ) : (
            <Spinner label="Waiting for the query engine" />
          )}
        </Section>

        <Section
          title="What the derived signals are actually based on"
          description="The three questions that depend on a derived signal publish their basis alongside the value. These counts show how much of each list rests on strong evidence and how much rests on a proxy."
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {BREAKDOWN_COLUMNS.map((column) => {
              const rows = breakdowns[column];
              return (
                <div key={column} className="card card-pad">
                  <div className="mono mb-2 text-[12.5px] font-semibold">{column}</div>
                  {!availableColumns.includes(column) ? (
                    <div className="na text-[12px]">not published in this artifact</div>
                  ) : rows ? (
                    <table className="grid" style={{ fontSize: 12 }}>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={index}>
                            <td style={{ whiteSpace: "normal" }}>{String(row.value)}</td>
                            <td className="num">{formatInt(Number(row.rows))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-[12px] text-faint">computing...</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Column contract" description="What the UI expects to find in the artifact.">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="card card-pad">
              <div className="text-[12.5px] font-semibold">
                Canonical Elephant query table columns ({CANONICAL_COLUMNS.length})
              </div>
              <p className="mono mt-2 text-[11.5px] leading-relaxed text-muted">
                {CANONICAL_COLUMNS.join(", ")}
              </p>
            </div>
            <div className="card card-pad">
              <div className="text-[12.5px] font-semibold">
                Pipeline extras this UI uses ({EXTRA_COLUMNS.length})
              </div>
              <p className="mono mt-2 text-[11.5px] leading-relaxed text-muted">
                {EXTRA_COLUMNS.join(", ")}
              </p>
              <p className="mt-2 text-[12px] text-muted">
                The MCP server builds its view with DESCRIBE, so extra columns are allowed by the
                contract. They carry the derived signals the six questions need.
              </p>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
