"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEngineBoot, useSql } from "@/lib/hooks";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PRESETS,
  STARTER_SQL,
  VIEW_NAME,
  guardSql,
} from "@/lib/sql";
import { formatInt } from "@/lib/format";
import { PageHeader, Callout, ErrorBox, Spinner, CopyButton } from "@/components/ui";
import { DataTable } from "@/components/DataTable";
import { EngineStatus } from "@/components/EngineStatus";

export default function QueryPage() {
  const engine = useEngineBoot();
  const { result, error, running, run } = useSql();

  const [sql, setSql] = useState(STARTER_SQL);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [lastRan, setLastRan] = useState<string | null>(null);

  const execute = useCallback(
    (statement: string, withLimit: number) => {
      const guarded = guardSql(statement, withLimit);
      if (!guarded.ok || !guarded.sql) {
        setGuardError(guarded.reason ?? "Statement rejected.");
        return;
      }
      setGuardError(null);
      setLastRan(guarded.sql);
      void run(guarded.sql);
    },
    [run],
  );

  // Run the starter query once the engine is up, so the page is never empty.
  useEffect(() => {
    if (engine.stage === "ready" && lastRan === null) {
      execute(STARTER_SQL, DEFAULT_LIMIT);
    }
  }, [engine.stage, lastRan, execute]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      execute(sql, limit);
    }
  };

  const visibleColumns = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return engine.columns;
    return engine.columns.filter((column) => column.name.toLowerCase().includes(needle));
  }, [engine.columns, filter]);

  return (
    <div>
      <PageHeader
        title="DuckDB workbench"
        lead={
          <>
            SQL against the published parquet, executed by DuckDB-WASM inside this tab. The artifact
            is exposed as the view <span className="mono">{VIEW_NAME}</span>, the same view name the
            Elephant MCP server builds, so a statement that works here works through MCP too.
          </>
        }
      />

      <div className="mb-4">
        <EngineStatus compact />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Presets
            </span>
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const statement = preset.sql(limit);
                  setSql(statement);
                  execute(statement, limit);
                }}
                title={preset.question}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <textarea
            className="sql"
            value={sql}
            spellCheck={false}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="SQL statement"
          />

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              aria-label="run statement"
              disabled={running || engine.stage !== "ready"}
              onClick={() => execute(sql, limit)}
            >
              {running ? "running..." : "run"}
              <span className="opacity-60">ctrl+enter</span>
            </button>

            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              row limit
              <input
                className="field w-[86px]"
                type="number"
                min={1}
                max={MAX_LIMIT}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value) || DEFAULT_LIMIT)}
              />
            </label>

            <span className="text-[11.5px] text-faint">
              enforced by wrapping your statement, maximum {formatInt(MAX_LIMIT)}
            </span>

            {result ? (
              <span className="ml-auto text-[12px] text-muted">
                {formatInt(result.rows.length)} rows in {result.elapsedMs.toFixed(0)} ms
              </span>
            ) : null}
          </div>

          {guardError ? (
            <div className="mt-3">
              <Callout tone="warn" title="Statement rejected">
                {guardError}
              </Callout>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3">
              <ErrorBox title="DuckDB error" message={error} />
            </div>
          ) : null}

          <div className="mt-4">
            {running ? (
              <Spinner label="Executing" />
            ) : result ? (
              <DataTable
                columns={result.columns}
                rows={result.rows}
                csvName="duval-query"
                emptyMessage="The statement ran and returned no rows."
              />
            ) : engine.stage !== "ready" ? (
              <Spinner label={engine.message} />
            ) : null}
          </div>

          {lastRan ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-[12px] text-muted">
                Statement actually executed, after the read only guard
              </summary>
              <pre className="block mt-2">{lastRan}</pre>
            </details>
          ) : null}
        </div>

        <aside>
          <div className="card">
            <div className="border-b border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold">Schema</span>
                <span className="text-[11px] text-faint">
                  {formatInt(engine.columns.length)} columns
                </span>
              </div>
              <input
                className="field mt-2 w-full"
                aria-label="Filter schema columns"
                placeholder="filter columns"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <div className="max-h-[520px] overflow-auto px-1 py-1">
              {engine.columns.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-faint">
                  {engine.stage === "ready" ? "No columns reported." : engine.message}
                </div>
              ) : (
                <ul>
                  {visibleColumns.map((column) => (
                    <li key={column.name}>
                      <button
                        type="button"
                        className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-[3px] text-left hover:bg-sunken"
                        onClick={() => setSql((current) => `${current}${column.name}`)}
                        title={`Append ${column.name} to the editor`}
                      >
                        <span className="mono text-[12px]">{column.name}</span>
                        <span className="mono shrink-0 text-[10.5px] text-faint">
                          {column.type}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-border px-3 py-2">
              <button
                type="button"
                className="btn btn-sm w-full"
                onClick={() => {
                  const statement = `DESCRIBE ${VIEW_NAME}`;
                  setSql(statement);
                  execute(statement, limit);
                }}
              >
                DESCRIBE {VIEW_NAME}
              </button>
            </div>
          </div>

          <div className="card card-pad mt-3 text-[12px] text-muted">
            <div className="mb-1 font-semibold text-text">Read only, by construction</div>
            DuckDB-WASM runs an in memory database in your tab. It cannot write to the published
            artifact even if it wanted to. The guard on top rejects anything that is not a single
            SELECT, WITH, DESCRIBE, SUMMARIZE, SHOW, PRAGMA or EXPLAIN, and wraps every result set in
            a LIMIT. PRAGMA is accepted only in its introspection form; the assignment spelling
            (PRAGMA x = y) is refused, because it is how DuckDB writes SET. Statements that would
            read a file are refused too, including a bare quoted path or URL standing where a table
            name belongs, which DuckDB would otherwise resolve to a reader.
          </div>

          <div className="card card-pad mt-3 text-[12px]">
            <div className="mb-1 font-semibold">Same query through MCP</div>
            <p className="text-muted">
              Paste the statement into the <span className="mono">queryProperties</span> tool of a
              connected MCP client. It runs the same SQL over the same view.
            </p>
            <div className="mt-2">
              <CopyButton text={sql} label="copy statement" />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
