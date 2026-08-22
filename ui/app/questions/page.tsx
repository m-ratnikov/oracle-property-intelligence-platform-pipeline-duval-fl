"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngineBoot, useSql } from "@/lib/hooks";
import {
  COMBINED_QUESTIONS,
  SIX_QUESTIONS,
  DEFAULT_LIMIT,
  SCHEMA_LOADING,
  coverageAlias,
  loadedSchema,
  measureAlias,
  presetAvailability,
  statsSql,
} from "@/lib/sql";
import type { QuestionPreset, SchemaState } from "@/lib/sql";
import { formatInt, formatRatioPercent } from "@/lib/format";
import { PageHeader, Section, Callout, Spinner, ErrorBox, CopyButton } from "@/components/ui";
import { DataTable } from "@/components/DataTable";
import { EngineStatus } from "@/components/EngineStatus";

function QuestionCard({
  preset,
  schema,
  index,
  autoRun = false,
}: {
  preset: QuestionPreset;
  /*
   * The engine's schema as a state, never as a bare column list.
   *
   * A card must not be able to say "this artifact does not publish roof_year_est" while the only
   * thing it knows is that the engine has not described the artifact yet. Taking a SchemaState
   * instead of `ColumnMeta[] + ready` is what makes that unsayable: there is no value here that
   * reads as an empty schema, and `presetAvailability` answers "unknown" for the loading one.
   */
  schema: SchemaState;
  index: number;
  /** Run this card once, unprompted, as soon as the engine can answer it. */
  autoRun?: boolean;
}) {
  const { result, error, running, run } = useSql();
  // A second, independent query for the totals. The grid is capped by `limit` so its row count says
  // nothing about how many parcels the rule actually matches, which is the number the question asks for.
  const { result: stats, run: runStats } = useSql();
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [showSql, setShowSql] = useState(false);
  const [ranAutomatically, setRanAutomatically] = useState(false);

  const availability = useMemo(() => presetAvailability(preset, schema), [preset, schema]);

  const statement = preset.sql(limit);
  const runnable = availability.status === "runnable";

  const execute = useCallback(() => {
    void run(preset.sql(limit));
    void runStats(statsSql(preset));
  }, [run, runStats, preset, limit]);

  /*
   * The first card answers itself.
   *
   * A reviewer landing here used to meet six cards all reading "Not run yet", with nothing on
   * screen to show that any of them work; the page needed to be told what to click before it
   * demonstrated anything. Exactly one card runs on arrival, so the page proves itself without
   * silently firing six full table scans, and the rest stay on the button.
   */
  const executeRef = useRef(execute);
  executeRef.current = execute;
  useEffect(() => {
    if (!autoRun || !runnable || ranAutomatically) return;
    setRanAutomatically(true);
    executeRef.current();
  }, [autoRun, runnable, ranAutomatically]);

  // DuckDB hands counts back as BigInt over the WASM bridge, so normalise before doing arithmetic.
  const summary = useMemo(() => {
    const row = stats?.rows[0];
    if (row === undefined) return null;
    const toCount = (value: unknown): number => (typeof value === "bigint" ? Number(value) : Number(value ?? 0));
    const total = toCount(row.total_parcels);
    /*
     * One entry per column the rule depends on, whatever those columns happen to be. `requires` is
     * owned by lib/sql.ts and changes as the rules are sharpened, so nothing here is keyed on a
     * column name: a key the stats query did not return is reported as unmeasured rather than
     * silently counted as zero, which would accuse a populated column of being empty.
     */
    const coverage = preset.requires.map((column) => {
      const key = coverageAlias(column);
      const measured = key in row;
      return { column, measured, nonNull: measured ? toCount(row[key]) : null };
    });
    /*
     * The shares the preset asked for on top of plain non-null coverage. roof_age_basis reads a
     * comfortable 88.9 percent covered while none of those rows is permit derived, so the card
     * shows the permit share beside it and lets the artifact, not the copy, say it is zero.
     */
    const measures = (preset.measures ?? []).map((measure) => {
      const key = measureAlias(measure);
      const measured = key in row;
      return { ...measure, measured, count: measured ? toCount(row[key]) : null };
    });
    return {
      total,
      matching: toCount(row.matching_parcels),
      coverage,
      measures,
      // required columns that carry no value at all in this artifact
      empty: coverage.filter((entry) => entry.measured && entry.nonNull === 0).map((entry) => entry.column),
    };
  }, [stats, preset]);

  return (
    <article className="card" id={preset.id} data-testid={`question-${preset.id}`}>
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge badge-neutral">{index}</span>
              <h3 className="text-[14.5px] font-semibold">{preset.question}</h3>
              {ranAutomatically ? (
                <span
                  className="badge badge-accent"
                  data-testid={`autorun-${preset.id}`}
                  title="This card runs itself on arrival so the page demonstrates the engine without being clicked. Every other card runs on demand."
                >
                  ran on load
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">{preset.rule}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-1 text-[11.5px] text-faint">
              limit
              <input
                className="field w-[72px]"
                type="number"
                min={1}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value) || DEFAULT_LIMIT)}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!runnable || running}
              title={
                runnable
                  ? "Runs this rule against the published parquet in your browser"
                  : "Waiting for the query engine"
              }
              onClick={execute}
            >
              {running ? "running..." : "run"}
            </button>
          </div>
        </div>
      </div>

      {/*
        Reachable only through the "unanswerable" arm, which `presetAvailability` cannot return
        while the schema is still loading. That is the whole point of the union: this callout used
        to be gated on an empty column array, so for the seconds DuckDB-WASM took to boot it
        appeared on every card and told an arriving reviewer that the published table has no
        roof_year_est - the opposite of what the artifact contains.
      */}
      {availability.status === "unanswerable" ? (
        <div className="px-4 py-3">
          <Callout tone="warn" title="Cannot answer from this artifact">
            The published query table does not contain{" "}
            <span className="mono">{availability.missing.join(", ")}</span>. This question stays
            disabled rather than returning an answer the data cannot support.
          </Callout>
        </div>
      ) : null}

      <div className="px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Assumptions and missing data
        </div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-muted">
          {preset.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </div>

      {error ? (
        <div className="px-4 pb-3">
          <ErrorBox title="Query failed" message={error} />
        </div>
      ) : null}

      {running ? (
        <div className="px-4 pb-4">
          <Spinner label="Running against the published parquet" />
        </div>
      ) : result ? (
        <div className="px-4 pb-4">
          <DataTable
            columns={result.columns}
            rows={result.rows}
            evidence={preset.evidence}
            collapseProvenance
            csvName={`duval-${preset.id}`}
            emptyMessage="No parcels in the published artifact match this rule."
            maxHeight="440px"
          />
          {summary === null ? (
            <p className="mt-1.5 text-[11.5px] text-faint">
              {formatInt(result.rows.length)} rows in {result.elapsedMs.toFixed(0)} ms, limit{" "}
              {formatInt(limit)}. Every row carries the source system, the source URL and the
              collection timestamp behind it.
            </p>
          ) : (
            <p className="mt-1.5 text-[11.5px] text-faint">
              <span className="text-text">
                {formatInt(summary.matching)} of {formatInt(summary.total)} published parcels match
                this rule
              </span>
              , showing the first {formatInt(result.rows.length)} in{" "}
              {result.elapsedMs.toFixed(0)} ms (limit {formatInt(limit)}). Every row carries the
              source system, the source URL and the collection timestamp behind it.
            </p>
          )}

          {/*
            How much of the artifact each evidence column actually covers. Without it a reviewer
            cannot tell a rule that matched few parcels from a rule whose evidence column is thin,
            and it is where the tenure coverage figure lands on screen: last_sale_date_any is
            populated on 99.5% of parcels while the roll's own last_sale_date is on 12.9%.
          */}
          {summary !== null && summary.coverage.length + summary.measures.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <span className="text-faint">evidence coverage</span>
              {summary.coverage.map((entry) => (
                <span
                  key={entry.column}
                  data-testid={`coverage-${preset.id}-${entry.column}`}
                  className={
                    !entry.measured
                      ? "badge badge-neutral"
                      : entry.nonNull === 0
                        ? "badge badge-warn"
                        : "badge badge-accent"
                  }
                  title={
                    !entry.measured
                      ? `${entry.column}: not measured by the stats query for this rule`
                      : `${entry.column}: ${formatInt(entry.nonNull)} of ${formatInt(summary.total)} published parcels carry a value`
                  }
                >
                  <span className="mono">{entry.column}</span>{" "}
                  {!entry.measured
                    ? "not measured"
                    : formatRatioPercent(entry.nonNull ?? 0, summary.total)}
                </span>
              ))}
              {summary.measures.map((measure) => (
                <span
                  key={measure.key}
                  data-testid={`measure-${preset.id}-${measure.key}`}
                  className={
                    !measure.measured || measure.count === 0 ? "badge badge-warn" : "badge badge-accent"
                  }
                  title={
                    measure.measured
                      ? `${measure.note}: ${formatInt(measure.count)} of ${formatInt(summary.total)} published parcels`
                      : `${measure.label}: not measured by the stats query for this rule`
                  }
                >
                  <span className="mono">{measure.label}</span>{" "}
                  {measure.measured
                    ? formatRatioPercent(measure.count ?? 0, summary.total)
                    : "not measured"}
                </span>
              ))}
            </div>
          ) : null}

          {summary !== null && summary.matching === 0 ? (
            <div className="mt-2">
              <Callout tone="warn" title="Nothing matches, and here is why">
                {summary.empty.length > 0 ? (
                  <>
                    The rule reads{" "}
                    <span className="mono">{summary.empty.join(", ")}</span>, and{" "}
                    {summary.empty.length === 1 ? "that column is" : "those columns are"} empty for
                    all {formatInt(summary.total)} parcels in this artifact. The source that fills{" "}
                    {summary.empty.length === 1 ? "it" : "them"} has not landed in the published
                    run, so this is a coverage gap and not a finding of zero.
                  </>
                ) : (
                  <>
                    Every column the rule needs is populated, so no parcel in this artifact genuinely
                    satisfies the threshold. The Data page shows the distribution behind each column.
                  </>
                )}
              </Callout>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="px-4 pb-4 text-[12.5px]" data-testid={`idle-${preset.id}`}>
          {availability.status === "unknown" ? (
            /*
             * Not knowing the schema is a loading state, never a finding. This is the branch the
             * "Cannot answer from this artifact" callout used to steal on a cold load.
             */
            <Spinner label="Attaching the published parquet. The run button turns on when the engine has described it." />
          ) : availability.status === "unanswerable" ? (
            <span className="text-faint">
              Disabled: this artifact does not publish the columns the rule needs.
            </span>
          ) : (
            <span className="text-muted">
              Ready to run. Press <span className="badge badge-accent">run</span> to execute this
              rule against the published parquet in your browser, or change the row limit first.
            </span>
          )}
        </div>
      )}

      <div className="border-t border-border px-4 py-2">
        <button
          type="button"
          className="text-[12px] text-muted hover:text-text"
          onClick={() => setShowSql(!showSql)}
        >
          {showSql ? "hide" : "show"} the SQL behind this rule
        </button>
        {showSql ? (
          <div className="mt-2">
            <pre className="block">{statement}</pre>
            <div className="mt-1.5">
              <CopyButton text={statement} label="copy SQL" />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function QuestionsPage() {
  const engine = useEngineBoot();

  /*
   * The one place the engine's column list is turned into a schema state, so no card has to
   * remember to check `stage` before believing `columns`. lib/duckdb.ts only ever publishes
   * columns together with the "ready" stage; this narrows that pair into a single value, and every
   * card below takes the value rather than the pair.
   */
  const schema = useMemo<SchemaState>(
    () =>
      engine.stage === "ready"
        ? loadedSchema(engine.columns.map((column) => column.name))
        : SCHEMA_LOADING,
    [engine.stage, engine.columns],
  );

  return (
    <div>
      <PageHeader
        title="The six questions"
        lead="Each card states the rule in plain English, runs it against the published parquet in your browser, shows the evidence columns highlighted and the provenance for every row, and names what the rule cannot see."
      />

      <div className="mb-5">
        <EngineStatus compact />
      </div>

      <Callout tone="neutral" title="How to read these results">
        The first question runs by itself as soon as the query engine is attached, so this page
        answers something before you touch it; every other card runs when you press{" "}
        <span className="badge badge-accent">run</span>, because each one is a full scan of the
        published parquet in your browser. Highlighted cells are the evidence for the rule on that
        row. The provenance column names every system that contributed a value to the row, so any
        row can be checked against the record it came from. Where a rule rests on a proxy rather
        than a direct measurement, the basis column says so and the assumptions list explains it.
      </Callout>

      <Section
        title="Acceptance questions"
        description="The six property intelligence questions the assignment names, in transcript order."
      >
        <div className="space-y-5">
          {SIX_QUESTIONS.map((preset, index) => (
            <QuestionCard
              key={preset.id}
              preset={preset}
              schema={schema}
              index={index + 1}
              autoRun={index === 0}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Combined presets"
        description="The multi signal prompts from the demo transcript, answered with the same rules composed together."
      >
        <div className="space-y-5">
          {COMBINED_QUESTIONS.map((preset, index) => (
            <QuestionCard
              key={preset.id}
              preset={preset}
              schema={schema}
              index={SIX_QUESTIONS.length + index + 1}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
