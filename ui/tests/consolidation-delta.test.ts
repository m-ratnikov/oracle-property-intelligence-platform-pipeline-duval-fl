import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableDelta } from "@/components/TableDelta";
import {
  latestConsolidationRun,
  latestIngestionRun,
  parseRunHistory,
  summariseRun,
  type RunSource,
} from "@/lib/types";

/**
 * The consolidation pass used to publish `stats.exported` - the number of property records it
 * re-hashed and republished - as its table delta. The pipeline now publishes
 * `delta_vs_prev_total`: movement in `consolidation_state`'s own total against the previous
 * recorded consolidation pass, and null when there is no previous pass.
 *
 * This pins what the page does with each of the three shapes it can now receive, because the
 * question that mattered before shipping the pipeline fix was whether an explicit null would turn
 * every consolidation row into "unknown". It does not: only the first pass of a county has no
 * previous total, and the runs page has a sentence for exactly that case.
 */

function consolidationRun(delta: number | null | undefined) {
  const source: Record<string, unknown> = {
    track: "consolidation",
    source_system: "duval_consolidation",
    target_table: "consolidation_state",
    source_url: "derived",
    rows_staged: 404023,
    inserted: 337,
    updated: 0,
    unchanged: 403686,
    missing_in_source: 0,
    table_total_after: 404023,
    status: "completed",
    started_at: "2026-08-21T19:31:22.501Z",
    finished_at: "2026-08-21T19:31:46.416Z",
    limitations: [],
  };
  // `undefined` stands for the published records already in the repository, which carry no delta
  // key at all. A key present with a null value is the new shape's "unknown".
  if (delta !== undefined) source.delta_vs_prev_total = delta;
  return {
    county: "duval",
    runs: [
      {
        run_id: "01M0JWWX84PG2TJEWHSY5VP5C4",
        started_at: "2026-08-21T19:31:22.501Z",
        finished_at: "2026-08-21T19:31:46.416Z",
        status: "completed",
        trigger: "consolidation",
        tracks: ["consolidation"],
        sources: [source],
      },
    ],
  };
}

function firstSource(delta: number | null | undefined): RunSource {
  const [run] = parseRunHistory(consolidationRun(delta)).runs;
  return run!.sources[0]!;
}

function html(source: RunSource): string {
  return renderToStaticMarkup(createElement(TableDelta, { source }));
}

describe("a consolidation row's published delta", () => {
  it("renders the table's own movement, not the count of records republished", () => {
    const source = firstSource(0);
    expect(source.delta_vs_previous).toBe(0);
    expect(source.inserted).toBe(337);
    expect(html(source)).toContain(">0<");
    expect(html(source)).not.toContain("337");
  });

  it("renders real growth in consolidation_state", () => {
    expect(html(firstSource(1023))).toContain("+1,023");
  });

  it("says so when the pass had no previous pass to subtract", () => {
    const source = firstSource(null);
    expect(source.delta_vs_previous).toBeNull();
    expect(source.table_total_after).toBe(404023);
    // The third state of the cell: a total was recorded and there is nothing to compare it to.
    expect(html(source)).toContain("no previous run recorded");
  });
});

describe("what a null consolidation delta does to the rest of the page", () => {
  it("makes only the first pass's run total unknown, not every consolidation row", () => {
    // Every pass after the first has a previous total, so its run total is a number.
    const [known] = parseRunHistory(consolidationRun(0)).runs;
    expect(summariseRun(known!).tableDelta).toBe(0);

    const [unknown] = parseRunHistory(consolidationRun(null)).runs;
    expect(summariseRun(unknown!).tableDelta).toBeNull();
  });

  it("leaves the rest of the consolidation row's numbers intact when the delta is unknown", () => {
    const [run] = parseRunHistory(consolidationRun(null)).runs;
    const summary = summariseRun(run!);
    expect(summary.kind).toBe("consolidation");
    expect(summary.rowsVerified).toBe(404023);
    expect(summary.rowsWritten).toBe(337);
    expect(summary.tableDelta).toBeNull();
  });

  it("never reaches the overview's ingestion totals", () => {
    // The overview reads the latest INGESTION run for its per source delta table, and its
    // consolidation card reads rows verified and rows written, never the delta. A consolidation
    // pass with an unknown delta therefore cannot make the overview say unknown.
    const runs = parseRunHistory(consolidationRun(null)).runs;
    expect(latestIngestionRun(runs)).toBeNull();
    expect(latestConsolidationRun(runs)).not.toBeNull();
  });
});

describe("consolidation records already published, which carry no delta key", () => {
  it("still falls back to inserted plus updated, which is the republished count", () => {
    // Documented, not endorsed. The run history is merged with the published copy on publish, so
    // these records persist and the fix only reaches new runs. For a consolidation record the
    // fallback is the number the pipeline fix removed: 337 property files rewritten, published
    // under a header that says table delta.
    const source = firstSource(undefined);
    expect(source.delta_vs_previous).toBe(337);
    expect(html(source)).toContain("+337");
  });
});
