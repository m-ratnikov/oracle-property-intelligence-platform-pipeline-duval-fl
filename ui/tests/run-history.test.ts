import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatTimestamp,
  parseTimestamp,
  relativeTime,
} from "@/lib/format";
import {
  distinctLimitations,
  ingestionSourceNames,
  latestConsolidationRun,
  latestIngestionRun,
  parseRunHistory,
  sortRunsDesc,
  summariseRun,
  summariseRuns,
} from "@/lib/types";

/**
 * These tests run in a deliberately non-UTC zone.
 *
 * The bug they pin only appears away from UTC: `new Date("2026-08-21 16:34:49.119")` is
 * LOCAL time by specification, so the published run records rendered seven hours early in
 * Bangkok and four hours in the future in New York. A suite pinned to UTC would have gone
 * green against the broken code, which is how this reached the deployed page.
 */
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("published timestamps are UTC even when they do not say so", () => {
  it("treats a zoneless DuckDB stamp as UTC, not as the reader's local time", () => {
    expect(parseTimestamp("2026-08-21 16:34:49.119")?.toISOString()).toBe(
      "2026-08-21T16:34:49.119Z",
    );
    expect(formatTimestamp("2026-08-21 16:34:49.119")).toBe("2026-08-21 16:34:49Z");
  });

  it("treats the T separated zoneless form the same way", () => {
    expect(formatTimestamp("2026-08-21T16:12:03.152")).toBe("2026-08-21 16:12:03Z");
  });

  it("leaves a Z suffixed stamp exactly as it was", () => {
    expect(parseTimestamp("2026-08-21T16:34:49.119Z")?.toISOString()).toBe(
      "2026-08-21T16:34:49.119Z",
    );
    expect(formatTimestamp("2026-08-21T16:34:49.119Z")).toBe("2026-08-21 16:34:49Z");
  });

  it("respects an explicit offset rather than overriding it", () => {
    expect(parseTimestamp("2026-08-21T18:34:49+02:00")?.toISOString()).toBe(
      "2026-08-21T16:34:49.000Z",
    );
    expect(parseTimestamp("2026-08-21T11:34:49-05:00")?.toISOString()).toBe(
      "2026-08-21T16:34:49.000Z",
    );
  });

  it("keeps a bare calendar date at midnight UTC", () => {
    expect(parseTimestamp("2026-08-21")?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("returns null for something that is not a timestamp", () => {
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });

  it("does not put a zoneless run in the future or in the deep past", () => {
    // Ten minutes before "now", written the way DuckDB writes it.
    const now = Date.UTC(2026, 7, 21, 16, 45, 0);
    const stamp = new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", "");
    expect(relativeTime(stamp, now)).toBe("10m ago");
  });

  it("measures a duration across two zoneless stamps", () => {
    expect(formatDurationMs("2026-08-21 16:12:03.152", "2026-08-21 16:34:46.424")).toBe("22m 43s");
    // Mixed shapes still line up, because both are UTC.
    expect(formatDurationMs("2026-08-21 16:12:03.152", "2026-08-21T16:34:46.424Z")).toBe("22m 43s");
  });
});

/* ------------------------------------------------------------------ run selection */

const consolidationRun = {
  run_id: "01M0JJSM4Y61416J03ZKD44KFG",
  started_at: "2026-08-21 16:34:49.119",
  finished_at: "2026-08-21 16:35:13.42",
  status: "completed",
  trigger: "consolidation",
  git_sha: null,
  tracks: ["consolidation"],
  sources: [
    {
      track: "consolidation",
      target_table: "consolidation_state",
      rows_staged: 404023,
      inserted: 320,
      updated: 0,
      unchanged: 403703,
      table_total_after: 404023,
      status: "completed",
      limitations: [],
    },
  ],
  artifacts: {
    openData: {
      indexCid: "QmS6NTWffWMTuLErpz9gFfkvKfz3Z7V8eRxDK6C69mycxf",
      manifestCid: "QmPPWSPYySe6tvpvb71oW6pbhs6xEurj53Gaocq1ZgrUH3",
      propertyCount: 404023,
      totalBytes: 1800268331,
      shards: 41,
    },
    queryTable: { rows: 404023, propertyCidFilled: 404023 },
  },
};

const ingestionRun = {
  run_id: "01M0JHFY6FBNXW0523KPNP5D7Y",
  started_at: "2026-08-21 16:12:03.152",
  finished_at: "2026-08-21 16:34:46.424",
  status: "completed",
  trigger: "workflow_dispatch",
  git_sha: "5be287e52c628428eaaa72e10a3d71d22f6d3ec1",
  tracks: ["appraisal", "sales", "permits", "pa_detail"],
  sources: [
    {
      track: "appraisal",
      rows_staged: 404023,
      inserted: 0,
      updated: 0,
      unchanged: 404023,
      table_total_after: 404023,
      delta_vs_prev_total: 0,
      status: "completed",
      limitations: ["FDOR posts only the current roll type", "No roof attributes in the bulk roll"],
    },
    {
      track: "sales",
      rows_staged: 64532,
      inserted: 0,
      updated: 0,
      unchanged: 64532,
      table_total_after: 71992,
      delta_vs_prev_total: 1782,
      status: "completed",
      limitations: ["Sale dates carry year+month only"],
    },
    {
      track: "permits",
      rows_staged: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      table_total_after: 0,
      delta_vs_prev_total: 0,
      status: "skipped",
      limitations: ["skipped: non-US egress"],
    },
    {
      track: "pa_detail",
      rows_staged: 295,
      inserted: 206,
      updated: 0,
      unchanged: 89,
      table_total_after: 1332,
      delta_vs_prev_total: 206,
      status: "failed",
      limitations: [],
    },
  ],
  artifacts: {
    queryTable: { path: "query-table.parquet", rows: 404023, bytes: 29089967, cid: "Qmquery" },
    tables: {
      parcels: { path: "tables/parcels.parquet", rows: 404023, cid: "Qmparcels" },
      sales_history: { path: "tables/sales_history.parquet", rows: 71992, cid: "Qmsales" },
    },
    egressCountry: "US",
    coverage: { path: "dataset-coverage.json", bytes: 4096, cid: "Qmcoverage" },
  },
};

// The consolidation pass is published newest, exactly as it is on the live artifact.
const history = parseRunHistory({ county: "duval", runs: [consolidationRun, ingestionRun] });

describe("a consolidation pass never stands in for the latest ingestion run", () => {
  it("classifies each run by kind", () => {
    expect(history.runs.map((run) => run.kind)).toEqual(["consolidation", "ingestion"]);
  });

  it("picks the ingestion run even though the consolidation pass is newer", () => {
    // What the page used to do, kept here so the regression is visible rather than implied.
    expect(sortRunsDesc(history.runs)[0].kind).toBe("consolidation");

    const latest = latestIngestionRun(history.runs);
    expect(latest?.run_id).toBe("01M0JHFY6FBNXW0523KPNP5D7Y");
    // The symptom this replaces: "across 1 sources" with a single `consolidation` row.
    expect(latest?.sources).toHaveLength(4);
  });

  it("still surfaces the consolidation pass as itself", () => {
    const pass = latestConsolidationRun(history.runs);
    expect(pass?.run_id).toBe("01M0JJSM4Y61416J03ZKD44KFG");
    expect(pass?.artifacts.map((a) => a.cid)).toContain(
      "QmS6NTWffWMTuLErpz9gFfkvKfz3Z7V8eRxDK6C69mycxf",
    );
  });

  it("returns null rather than guessing when there is no ingestion run at all", () => {
    const only = parseRunHistory({ runs: [consolidationRun] });
    expect(latestIngestionRun(only.runs)).toBeNull();
  });
});

describe("the artifact list published as an object is read, not dropped", () => {
  it("reads the query table, coverage and every entity table CID", () => {
    const latest = latestIngestionRun(history.runs);
    const names = latest?.artifacts.map((artifact) => artifact.name) ?? [];
    // Published order is kept, with the `tables` map flattened in place.
    expect(names).toEqual([
      "queryTable",
      "tables.parcels",
      "tables.sales_history",
      "coverage",
    ]);
    expect(latest?.artifacts[0]).toMatchObject({ cid: "Qmquery", rows: 404023, bytes: 29089967 });
  });

  it("ignores a scalar that is not an artifact", () => {
    const names = latestIngestionRun(history.runs)?.artifacts.map((a) => a.name) ?? [];
    expect(names).not.toContain("egressCountry");
  });

  it("still reads the list form, so an older or different publisher keeps rendering", () => {
    const listShape = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [],
          artifacts: [{ name: "query-table.parquet", cid: "Qmx", ipns_name: "k51" }],
        },
      ],
    });
    expect(listShape.runs[0].artifacts).toHaveLength(1);
    expect(listShape.runs[0].artifacts[0].ipns_name).toBe("k51");
  });
});

describe("counts on the runs page say what they count", () => {
  it("excludes the consolidation maintenance track from the sources tracked", () => {
    expect(ingestionSourceNames(history.runs)).toEqual([
      "appraisal",
      "pa_detail",
      "permits",
      "sales",
    ]);
    expect(ingestionSourceNames(history.runs)).not.toContain("consolidation");
  });

  it("counts a standing limitation once, not once per run", () => {
    // The same run repeated fourteen times is still the same four constraints.
    const repeated = parseRunHistory({
      runs: Array.from({ length: 14 }, (_, index) => ({
        ...ingestionRun,
        run_id: `run-${index}`,
        started_at: `2026-08-21 0${index % 10}:00:00`,
      })),
    });
    const naiveSum = repeated.runs.reduce(
      (sum, run) => sum + run.sources.reduce((inner, s) => inner + s.limitations.length, 0),
      0,
    );
    expect(naiveSum).toBe(56);
    expect(distinctLimitations(repeated.runs)).toHaveLength(4);
  });

  it("keeps the same limitation text apart when two sources both raise it", () => {
    const shared = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [
            { track: "a", limitations: ["source is slow"] },
            { track: "b", limitations: ["source is slow"] },
          ],
        },
      ],
    });
    expect(distinctLimitations(shared.runs)).toEqual([
      { source: "a", limitation: "source is slow" },
      { source: "b", limitation: "source is slow" },
    ]);
  });
});

describe("per run shaping behind the table and the charts", () => {
  const summary = summariseRun(latestIngestionRun(history.runs)!);

  it("sums what the run checked and what it had to write", () => {
    expect(summary.rowsVerified).toBe(404023 + 64532 + 0 + 295);
    expect(summary.rowsInserted).toBe(206);
    expect(summary.rowsUpdated).toBe(0);
    expect(summary.rowsWritten).toBe(206);
  });

  it("separates sources that ran, were skipped and failed", () => {
    expect(summary.sourcesCompleted).toBe(2);
    expect(summary.sourcesSkipped).toBe(1);
    expect(summary.sourcesFailed).toBe(1);
    expect(summary.trackCount).toBe(4);
  });

  it("reads the published table delta rather than re-deriving inserted plus updated", () => {
    // sales inserted nothing this run, yet sales_history grew by 1782 because pa_detail
    // writes into the same table. Deriving the delta from inserted + updated hid that.
    const sales = summary.run.sources.find((source) => source.source === "sales");
    expect(sales?.inserted).toBe(0);
    expect(sales?.delta_vs_previous).toBe(1782);
    expect(summary.tableDelta).toBe(0 + 1782 + 0 + 206);
  });

  it("times the run from its zoneless stamps", () => {
    expect(summary.durationMs).toBe(22 * 60_000 + 43_272);
  });

  it("counts the artifacts it published", () => {
    expect(summary.artifactCount).toBe(4);
  });

  it("orders summaries newest first and keeps the consolidation pass in the timeline", () => {
    const all = summariseRuns(history.runs);
    expect(all.map((entry) => entry.kind)).toEqual(["consolidation", "ingestion"]);
    expect(all[0].rowsVerified).toBe(404023);
    expect(all[0].rowsWritten).toBe(320);
  });
});
