"use client";

import { useMemo, useState } from "react";
import { useEngineBoot, useSql } from "@/lib/hooks";
import { COMBINED_QUESTIONS, SIX_QUESTIONS, DEFAULT_LIMIT, missingColumns } from "@/lib/sql";
import type { QuestionPreset } from "@/lib/sql";
import type { ColumnMeta } from "@/lib/duckdb";
import { formatInt } from "@/lib/format";
import { PageHeader, Section, Callout, Spinner, ErrorBox, CopyButton } from "@/components/ui";
import { DataTable } from "@/components/DataTable";
import { EngineStatus } from "@/components/EngineStatus";

function QuestionCard({
  preset,
  columns,
  ready,
  index,
}: {
  preset: QuestionPreset;
  columns: ColumnMeta[];
  ready: boolean;
  index: number;
}) {
  const { result, error, running, run } = useSql();
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [showSql, setShowSql] = useState(false);

  const missing = useMemo(
    () => missingColumns(preset, columns.map((column) => column.name)),
    [preset, columns],
  );

  const statement = preset.sql(limit);
  const runnable = ready && missing.length === 0;

  return (
    <article className="card" id={preset.id} data-testid={`question-${preset.id}`}>
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2">
              <span className="badge badge-neutral">{index}</span>
              <h3 className="text-[14.5px] font-semibold">{preset.question}</h3>
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
              onClick={() => void run(statement)}
            >
              {running ? "running..." : "run"}
            </button>
          </div>
        </div>
      </div>

      {missing.length > 0 ? (
        <div className="px-4 py-3">
          <Callout tone="warn" title="Cannot answer from this artifact">
            The published query table does not contain{" "}
            <span className="mono">{missing.join(", ")}</span>. This question stays disabled rather
            than returning an answer the data cannot support.
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
          <p className="mt-1.5 text-[11.5px] text-faint">
            {formatInt(result.rows.length)} rows in {result.elapsedMs.toFixed(0)} ms, limit{" "}
            {formatInt(limit)}. Every row carries the source system, the source URL and the
            collection timestamp behind it.
          </p>
        </div>
      ) : (
        <div className="px-4 pb-4 text-[12.5px] text-faint">
          {ready ? "Not run yet." : "Waiting for the query engine."}
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
  const ready = engine.stage === "ready";

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
        Highlighted cells are the evidence for the rule on that row. The provenance column collapses
        source_system, source_url and fetched_at, so any row can be checked against the county
        record it came from. Where a rule rests on a proxy rather than a direct measurement, the
        basis column says so and the assumptions list explains it.
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
              columns={engine.columns}
              ready={ready}
              index={index + 1}
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
              columns={engine.columns}
              ready={ready}
              index={SIX_QUESTIONS.length + index + 1}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
