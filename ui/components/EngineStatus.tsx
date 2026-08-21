"use client";

import { useEngineBoot } from "@/lib/hooks";
import { queryTableParquetUrl } from "@/lib/config";
import { formatInt, shortenId } from "@/lib/format";
import { SampleBadge } from "./SampleBanner";

const ACCESS_LABEL: Record<string, string> = {
  "http-range": "HTTP range reads, only the row groups a query needs are fetched",
  downloaded: "downloaded once, then cached in your browser",
  cached: "served from the browser cache, no gateway traffic",
};

/**
 * One line of truth about the query engine, shown on every page that queries.
 * It is deliberately explicit about where the bytes came from, because "there is
 * no server" is the claim the whole submission rests on.
 */
export function EngineStatus({ compact = false }: { compact?: boolean }) {
  const engine = useEngineBoot();
  const url = queryTableParquetUrl();

  if (engine.stage === "error" && compact) {
    return (
      <span className="flex items-center gap-2 whitespace-nowrap text-[12px] text-bad" data-testid="engine-error">
        <span className="badge badge-warn">engine failed</span>
        <span className="truncate" title={engine.error ?? undefined}>
          DuckDB-WASM could not load the query table
        </span>
      </span>
    );
  }

  if (engine.stage === "error") {
    return (
      <div className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
        <div className="font-semibold">DuckDB-WASM could not load the query table.</div>
        <div className="mono mt-1 break-all">{engine.error}</div>
        <div className="mt-1 opacity-80">
          Tried <span className="mono break-all">{url}</span>. A gateway that does not send
          permissive CORS headers is the usual cause.
        </div>
      </div>
    );
  }

  /*
   * Compact lives in a flex row beside the model picker, so it must be ONE inline line. The block
   * card below is a flex item there: it shrinks to whatever space is left, wraps "Starting
   * DuckDB-WASM in your browser" over four lines, and because its rows have fixed heights the text
   * spills out and lands on top of the model label.
   */
  if (engine.stage !== "ready" && compact) {
    return (
      <span
        className="flex items-center gap-2 whitespace-nowrap text-[12px] text-muted"
        data-testid="engine-loading"
      >
        <span className="pulsing inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
        {engine.message}
        {engine.progress !== null ? (
          <span className="mono text-faint">{Math.round(engine.progress * 100)}%</span>
        ) : null}
      </span>
    );
  }

  if (engine.stage !== "ready") {
    /*
     * Three rows, matching the ready state's badge, detail and url lines. The
     * engine takes seconds to attach over a public gateway, and without the
     * reserved height this card grows by about 46px on arrival and pushes every
     * section below it down the page.
     */
    return (
      <div className="card card-pad" data-testid="engine-loading">
        <div className="flex h-5 items-center gap-2 text-[13px] text-muted">
          <span className="pulsing inline-block h-2 w-2 rounded-full bg-accent" />
          {engine.message}
        </div>
        <div className="mt-1.5 flex h-[18px] items-center">
          {engine.progress !== null ? (
            <div className="progress w-full">
              <div style={{ width: `${Math.round(engine.progress * 100)}%` }} />
            </div>
          ) : (
            <span className="skeleton block h-2.5 w-64 max-w-full" />
          )}
        </div>
        <div className="mt-1 flex h-[18px] items-center">
          <span className="skeleton block h-2.5 w-[420px] max-w-full" />
        </div>
      </div>
    );
  }

  const detail = engine.accessMode ? ACCESS_LABEL[engine.accessMode] : "";

  if (compact) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-[12px] text-muted"
        data-testid="engine-ready"
      >
        <span className="badge badge-good">duckdb ready</span>
        <SampleBadge />
        <span>
          <strong className="text-text">{formatInt(engine.rowCount)}</strong> parcels,{" "}
          {engine.columns.length} columns
        </span>
        <span className="text-faint">{detail}</span>
      </div>
    );
  }

  return (
    <div className="card card-pad" data-testid="engine-ready">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-good">duckdb-wasm ready</span>
        <SampleBadge />
        <span className="text-[13px]">
          <strong>{formatInt(engine.rowCount)}</strong> parcels,{" "}
          <strong>{engine.columns.length}</strong> columns
        </span>
      </div>
      <div className="mt-1.5 text-[12px] text-muted">{detail}</div>
      <div className="mono mt-1 break-all text-[11.5px] text-faint" title={url}>
        {shortenId(url, 64, 24)}
      </div>
    </div>
  );
}
