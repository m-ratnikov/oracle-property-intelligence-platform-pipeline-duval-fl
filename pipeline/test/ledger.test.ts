import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import {
  CI_RUNS_FILE,
  HIGHWATER_FILE,
  TRACK_STATE_FILE,
  readCiEnv,
  recordCiRun,
  recordTableHighwater,
  snapshotTrackState,
  type CiRunEntry,
  type CiRunLedger,
  type HighwaterDoc,
} from "../src/publish/ledger.js";

/**
 * runs/ is the only durable record this pipeline has: the DuckDB working set lives in a
 * branch-scoped Actions cache that GitHub evicts, and the commit-back can lose a race with a push
 * to the same branch. Two things have to be answerable from those files alone - "is the 6-hourly
 * cron actually running" and "did an accumulating table just shrink" - so both are merged rather
 * than overwritten, and a shrink is a recorded event rather than silence.
 */

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "duval-ledger-"));
  return { dataDir: dir, dbPath: join(dir, "duval.duckdb"), artifactsDir: join(dir, "artifacts"), publishDir: join(dir, "publish"), runsDir: join(dir, "runs") } as Paths;
}

function entry(over: Partial<CiRunEntry> & Pick<CiRunEntry, "run_id" | "started_at">): CiRunEntry {
  return {
    kind: "ingestion",
    trigger: "schedule",
    ci_event: "schedule",
    ci_workflow: "pipeline",
    ci_run_id: "1",
    ci_run_attempt: "1",
    ci_run_url: null,
    ci_ref: "main",
    finished_at: null,
    status: "completed",
    ...over,
  };
}

describe("CI run ledger", () => {
  it("reads the CI event and a clickable run URL from the runner environment", () => {
    const ci = readCiEnv({
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_WORKFLOW: "pipeline",
      GITHUB_RUN_ID: "32513420281",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REF_NAME: "main",
    } as NodeJS.ProcessEnv);
    expect(ci.ci_event).toBe("schedule");
    expect(ci.ci_run_url).toBe("https://github.com/owner/repo/actions/runs/32513420281");
  });

  it("treats a local run as local rather than inventing CI provenance", () => {
    const ci = readCiEnv({} as NodeJS.ProcessEnv);
    expect(ci).toEqual({ ci_event: null, ci_workflow: null, ci_run_id: null, ci_run_attempt: null, ci_run_url: null, ci_ref: null });
  });

  it("accumulates runs newest first and counts them per CI event", () => {
    const paths = makePaths();
    recordCiRun(paths, entry({ run_id: "A", started_at: "2026-08-21T06:17:00Z", ci_event: "schedule" }));
    recordCiRun(paths, entry({ run_id: "B", started_at: "2026-08-21T09:00:00Z", ci_event: "workflow_dispatch", trigger: "workflow_dispatch" }));
    const { ledger } = recordCiRun(paths, entry({ run_id: "C", started_at: "2026-08-21T12:17:00Z", ci_event: "schedule" }));

    expect(ledger.runs.map((r) => r.run_id)).toEqual(["C", "B", "A"]);
    expect(ledger.by_event).toEqual({ schedule: 2, workflow_dispatch: 1 });
    const onDisk = JSON.parse(readFileSync(join(paths.runsDir, CI_RUNS_FILE), "utf8")) as CiRunLedger;
    expect(onDisk.runs).toHaveLength(3);
  });

  it("repairs its own entry on a re-run without truncating the rest", () => {
    const paths = makePaths();
    recordCiRun(paths, entry({ run_id: "A", started_at: "2026-08-21T06:17:00Z" }));
    recordCiRun(paths, entry({ run_id: "B", started_at: "2026-08-21T12:17:00Z", status: "running" }));
    const { ledger } = recordCiRun(paths, entry({ run_id: "B", started_at: "2026-08-21T12:17:00Z", status: "completed", ci_run_attempt: "2" }));

    expect(ledger.runs).toHaveLength(2);
    expect(ledger.runs[0]?.status).toBe("completed");
    expect(ledger.runs[0]?.ci_run_attempt).toBe("2");
  });

  it("records the CI event separately from the run kind, so a scheduled consolidation is visible", () => {
    const paths = makePaths();
    const { ledger } = recordCiRun(
      paths,
      entry({ run_id: "K", started_at: "2026-08-21T12:40:00Z", kind: "consolidation", trigger: "consolidation", ci_event: "schedule" }),
    );
    // the UI groups on trigger, which stays "consolidation"; the cron is still provable
    expect(ledger.runs[0]?.trigger).toBe("consolidation");
    expect(ledger.runs[0]?.ci_event).toBe("schedule");
    expect(ledger.by_event.schedule).toBe(1);
  });
});

describe("table high-water marks", () => {
  it("records the first sight of a table without calling it a regression", () => {
    const paths = makePaths();
    const { regressions, doc } = recordTableHighwater(paths, { runId: "R1", trigger: "schedule", totals: { pa_detail_buildings: 1619 } });
    expect(regressions).toEqual([]);
    expect(doc.tables.pa_detail_buildings?.max).toBe(1619);
  });

  it("moves the mark up as the table grows", () => {
    const paths = makePaths();
    recordTableHighwater(paths, { runId: "R1", trigger: "schedule", totals: { parcels: 404023 } });
    const { doc, regressions } = recordTableHighwater(paths, { runId: "R2", trigger: "schedule", totals: { parcels: 404100 } });
    expect(regressions).toEqual([]);
    expect(doc.tables.parcels).toMatchObject({ max: 404100, max_run_id: "R2", current: 404100 });
  });

  it("catches the cold-cache shrink that used to pass silently", () => {
    const paths = makePaths();
    recordTableHighwater(paths, { runId: "R1", trigger: "workflow_dispatch", totals: { pa_detail_buildings: 1619 } });
    const { regressions, doc } = recordTableHighwater(paths, { runId: "R2", trigger: "schedule", totals: { pa_detail_buildings: 466 } });

    expect(regressions).toEqual([
      { table: "pa_detail_buildings", previous_max: 1619, current: 466, lost: 1153, previous_max_run_id: "R1", previous_max_at: expect.any(String) },
    ]);
    // the mark is NOT re-based, so the next cold run is caught too
    expect(doc.tables.pa_detail_buildings?.max).toBe(1619);
    expect(doc.tables.pa_detail_buildings?.current).toBe(466);
    expect(doc.events[0]).toMatchObject({ kind: "regression", table: "pa_detail_buildings", lost: 1153, run_id: "R2", trigger: "schedule" });
  });

  it("re-bases the mark only when the shrink is explicitly accepted, and records who accepted it", () => {
    const paths = makePaths();
    recordTableHighwater(paths, { runId: "R1", trigger: "schedule", totals: { permits: 5000 } });
    const { regressions, doc } = recordTableHighwater(paths, {
      runId: "R2",
      trigger: "workflow_dispatch",
      totals: { permits: 300 },
      allowRegression: true,
      note: "permits table rebuilt after the JaxEPICS API changed shape",
    });

    expect(regressions).toHaveLength(1);
    expect(doc.tables.permits?.max).toBe(300);
    expect(doc.events[0]).toMatchObject({ kind: "accepted", note: "permits table rebuilt after the JaxEPICS API changed shape" });

    // and having been accepted, the next run at the same size is clean
    const after = recordTableHighwater(paths, { runId: "R3", trigger: "schedule", totals: { permits: 320 } });
    expect(after.regressions).toEqual([]);
  });

  it("keeps the event history across runs and survives a missing or corrupt file", () => {
    const paths = makePaths();
    recordTableHighwater(paths, { runId: "R1", trigger: "schedule", totals: { owners: 100 } });
    recordTableHighwater(paths, { runId: "R2", trigger: "schedule", totals: { owners: 10 } });
    const { doc } = recordTableHighwater(paths, { runId: "R3", trigger: "schedule", totals: { owners: 20 } });
    expect(doc.events).toHaveLength(2);
    const onDisk = JSON.parse(readFileSync(join(paths.runsDir, HIGHWATER_FILE), "utf8")) as HighwaterDoc;
    expect(onDisk.events).toHaveLength(2);
  });

  it("ignores non-numeric totals rather than failing the run over them", () => {
    const paths = makePaths();
    const { doc, regressions } = recordTableHighwater(paths, {
      runId: "R1",
      trigger: "schedule",
      totals: { parcels: 10, weird: Number.NaN },
    });
    expect(regressions).toEqual([]);
    expect(Object.keys(doc.tables)).toEqual(["parcels"]);
  });
});

describe("track cursors", () => {
  it("commits the cursor of every accumulating track, sorted so the diff is readable", () => {
    const paths = makePaths();
    snapshotTrackState(
      paths,
      [
        { track: "permits", key: "api", value: "https://example", updated_at: "2026-08-21T12:00:00Z", run_id: "R1" },
        { track: "pa_detail", key: "seed_cursor", value: "1800", updated_at: "2026-08-21T12:00:00Z", run_id: "R1" },
      ],
      "R1",
    );
    const doc = JSON.parse(readFileSync(join(paths.runsDir, TRACK_STATE_FILE), "utf8")) as { state: { track: string; value: string }[] };
    expect(doc.state.map((s) => s.track)).toEqual(["pa_detail", "permits"]);
    expect(doc.state[0]?.value).toBe("1800");
  });
});
