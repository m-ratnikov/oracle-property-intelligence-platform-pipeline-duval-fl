import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTY, REPO_DIR } from "../src/config.js";
import { all, ensureSchema, openDb, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { loadRunHistory } from "../src/run.js";
import { insertRunSource, rehydrateRunLog, toUtcTimestamp } from "../src/runLog.js";

/**
 * The pipeline's own history lives in a DuckDB file held in the GitHub Actions cache, and that
 * cache is branch scoped and rolls. A runner can therefore start with an EMPTY `run_log` while the
 * entity tables are fully populated, which is how `water` came to publish "inserted 0, updated 0,
 * unchanged 757" and "table delta +757" in the same row.
 *
 * The durable copy of that history is not in the cache at all: every completed run is committed to
 * `runs/<run_id>.json` and every runner checks the repository out before the pipeline starts. These
 * tests pin the rule that the files fill gaps in `run_log` and never overwrite it.
 */

const silent = createLogger({}, "error", () => {});

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A runs/ directory holding the given files. A value that is already a string is written verbatim. */
function runsDirWith(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "duval-runlog-"));
  temps.push(root);
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

async function coldDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

function rehydrate(db: Db, runsDir: string) {
  return rehydrateRunLog(db, { runsDir, county: COUNTY.key, logger: silent });
}

/** One source record, shaped exactly as the pipeline writes it into runs/<run_id>.json. */
function source(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    track: "water",
    source_system: "usgs_nhd",
    target_table: "water_bodies",
    source_url: "https://example.test/nhd.zip",
    artifact_path: "water/nhd.zip",
    artifact_sha256: "4ae67aa7550d9d9051c44f01a52ab335897af4959e9625e9ae1e007d77521691",
    artifact_etag: null,
    artifact_last_modified: "Mon, 27 Jul 2026 11:06:08 GMT",
    artifact_bytes: 1024,
    download_status: "cached",
    rows_staged: 757,
    inserted: 0,
    updated: 0,
    unchanged: 757,
    missing_in_source: 0,
    table_total_after: 757,
    delta_vs_prev_total: 0,
    started_at: "2026-08-21T09:50:01.000Z",
    finished_at: "2026-08-21T09:50:44.000Z",
    status: "completed",
    limitations: ["NHD is a national extract"],
    notes: { shapes: 757 },
    error: null,
    ...over,
  };
}

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "01M0HVMB6XDGHJ5R0BY64HWH8Z",
    county: "duval",
    started_at: "2026-08-21 09:49:58.878",
    finished_at: "2026-08-21 10:12:05.894",
    status: "completed",
    trigger: "workflow_dispatch",
    git_sha: "5be287e52c628428eaaa72e10a3d71d22f6d3ec1",
    tracks: ["water"],
    window: null,
    sources: [source()],
    limitations: [],
    totals: { water_bodies: 757 },
    artifacts: { coverage: { path: "dataset-coverage.json" } },
    error: null,
    ...over,
  };
}

async function runIds(db: Db): Promise<string[]> {
  const rows = await all<{ run_id: string }>(db.conn, "SELECT run_id FROM run_log ORDER BY run_id");
  return rows.map((r) => String(r.run_id));
}

async function sourceRows(db: Db): Promise<Record<string, unknown>[]> {
  return all(db.conn, "SELECT * FROM run_log_sources ORDER BY run_id, track");
}

describe("timestamps in the committed run records", () => {
  it("reads the recently fixed ISO-8601 shape as the instant it names", () => {
    expect(toUtcTimestamp("2026-08-21T19:06:43.726Z")).toBe("2026-08-21 19:06:43.726");
  });

  it("reads an older zoneless stamp as UTC, not as the runner's local time", () => {
    // These were rendered by DuckDB's ::VARCHAR from a TIMESTAMP the pipeline had written from
    // toISOString, so the digits are already UTC and must not be shifted by the reader's offset.
    expect(toUtcTimestamp("2026-08-21 09:49:58.878")).toBe("2026-08-21 09:49:58.878");
    expect(toUtcTimestamp("2026-08-21 08:07:15.99")).toBe("2026-08-21 08:07:15.990");
  });

  it("honours an explicit offset rather than dropping it", () => {
    expect(toUtcTimestamp("2026-08-21T12:00:00.000+02:00")).toBe("2026-08-21 10:00:00.000");
  });

  it("rejects what it cannot read instead of guessing", () => {
    expect(toUtcTimestamp("not a timestamp")).toBeNull();
    expect(toUtcTimestamp("")).toBeNull();
    expect(toUtcTimestamp(null)).toBeNull();
    expect(toUtcTimestamp(17)).toBeNull();
  });
});

describe("rehydrating a cold run_log from runs/*.json", () => {
  it("fills the gaps a rolled cache left", async () => {
    const dir = runsDirWith({
      "a.json": run({ run_id: "run-a", started_at: "2026-08-21 08:13:00.538" }),
      "b.json": run({ run_id: "run-b", started_at: "2026-08-21 09:49:58.878" }),
    });
    const db = await coldDb();
    const result = await rehydrate(db, dir);

    expect(result.runsInserted).toBe(2);
    expect(result.sourcesInserted).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(await runIds(db)).toEqual(["run-a", "run-b"]);

    const history = await loadRunHistory(db);
    expect(history.map((r) => r.run_id)).toEqual(["run-b", "run-a"]);
    expect(history[0]!.tracks).toEqual(["water"]);
    expect(history[0]!.totals).toEqual({ water_bodies: 757 });
    expect(history[0]!.sources[0]!.table_total_after).toBe(757);
    await db.close();
  });

  it("lands both timestamp shapes as the same published instant", async () => {
    const dir = runsDirWith({
      "old.json": run({
        run_id: "zoneless",
        started_at: "2026-08-21 09:49:58.878",
        finished_at: "2026-08-21 10:12:05.894",
      }),
      "new.json": run({
        run_id: "isoutc",
        started_at: "2026-08-21T09:49:58.878Z",
        finished_at: "2026-08-21T10:12:05.894Z",
      }),
    });
    const db = await coldDb();
    await rehydrate(db, dir);
    const history = await loadRunHistory(db);
    expect(new Set(history.map((r) => r.started_at))).toEqual(new Set(["2026-08-21T09:49:58.878Z"]));
    expect(new Set(history.map((r) => r.finished_at))).toEqual(new Set(["2026-08-21T10:12:05.894Z"]));

    const stamps = await all<{ started_at: string }>(
      db.conn,
      "SELECT strftime(started_at, '%Y-%m-%dT%H:%M:%S.%gZ') AS started_at FROM run_log_sources",
    );
    expect(stamps.map((s) => s.started_at)).toEqual(["2026-08-21T09:50:01.000Z", "2026-08-21T09:50:01.000Z"]);
    await db.close();
  });

  it("writes run_log_sources with exactly the columns the live path writes", async () => {
    // Verified against the INSERT in run.ts rather than inferred from the JSON: the previous-run
    // and coverage lookups read these columns, and a shape that only agrees by accident would
    // silently stop resolving.
    const db = await coldDb();
    await insertRunSource(db, "live", {
      track: "water",
      source_system: "usgs_nhd",
      target_table: "water_bodies",
      source_url: "https://example.test/nhd.zip",
      artifact_path: "water/nhd.zip",
      artifact_sha256: "4ae67aa7550d9d9051c44f01a52ab335897af4959e9625e9ae1e007d77521691",
      artifact_etag: null,
      artifact_last_modified: "Mon, 27 Jul 2026 11:06:08 GMT",
      artifact_bytes: 1024,
      download_status: "cached",
      rows_staged: 757,
      inserted: 0,
      updated: 0,
      unchanged: 757,
      missing_in_source: 0,
      table_total_after: 757,
      delta_vs_prev_total: 0,
      started_at: "2026-08-21 09:50:01.000",
      finished_at: "2026-08-21 09:50:44.000",
      status: "completed",
      limitations: ["NHD is a national extract"],
      notes: { shapes: 757 },
      error: null,
    });
    await rehydrate(db, runsDirWith({ "a.json": run({ run_id: "rehydrated" }) }));

    const rows = await sourceRows(db);
    expect(rows).toHaveLength(2);
    const live = rows.find((r) => r.run_id === "live")!;
    const rehydrated = rows.find((r) => r.run_id === "rehydrated")!;
    expect(Object.keys(rehydrated)).toEqual(Object.keys(live));
    for (const key of Object.keys(live)) {
      // `rehydrated` is the ONE column the two paths must disagree about, and is asserted below.
      if (key === "run_id" || key === "rehydrated") continue;
      expect({ [key]: rehydrated[key] }).toEqual({ [key]: live[key] });
    }
    expect(live.rehydrated).toBe(false);
    expect(rehydrated.rehydrated).toBe(true);
    await db.close();
  });

  it("marks every row it loads, so previousTotal can tell them from this database's own", async () => {
    const db = await coldDb();
    await rehydrate(db, runsDirWith({ "a.json": run({ run_id: "run-a" }), "b.json": run({ run_id: "run-b" }) }));
    const rows = await sourceRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rehydrated === true)).toBe(true);
    await db.close();
  });
});

describe("the live database always wins", () => {
  it("never overwrites a run_log row it already has", async () => {
    const db = await coldDb();
    await db.conn.run(
      "INSERT INTO run_log (run_id, started_at, status, trigger, git_sha, tracks, \"window\") " +
        "VALUES ('run-a', '2026-08-21 09:49:58.878'::TIMESTAMP, 'aborted', 'schedule', NULL, 'water', NULL)",
    );
    const result = await rehydrate(
      db,
      runsDirWith({ "a.json": run({ run_id: "run-a", status: "completed", trigger: "workflow_dispatch" }) }),
    );

    expect(result.runsInserted).toBe(0);
    expect(result.runsAlreadyPresent).toBe(1);
    const rows = await all<{ status: string; trigger: string }>(db.conn, "SELECT status, trigger FROM run_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("aborted");
    expect(rows[0]!.trigger).toBe("schedule");
    await db.close();
  });

  it("never overwrites run_log_sources rows it already has for that run_id", async () => {
    const db = await coldDb();
    await insertRunSource(db, "run-a", {
      track: "water",
      source_system: "usgs_nhd",
      target_table: "water_bodies",
      source_url: "https://example.test/nhd.zip",
      artifact_path: null,
      artifact_sha256: null,
      artifact_etag: null,
      artifact_last_modified: null,
      artifact_bytes: null,
      download_status: null,
      rows_staged: 999,
      inserted: 999,
      updated: 0,
      unchanged: 0,
      missing_in_source: 0,
      table_total_after: 999,
      delta_vs_prev_total: 999,
      started_at: "2026-08-21 09:50:01.000",
      finished_at: "2026-08-21 09:50:44.000",
      status: "completed",
      limitations: [],
      notes: {},
      error: null,
    });
    const result = await rehydrate(db, runsDirWith({ "a.json": run({ run_id: "run-a" }) }));

    expect(result.sourcesInserted).toBe(0);
    expect(result.sourcesAlreadyPresent).toBe(1);
    const rows = await all<{ table_total_after: string | number }>(
      db.conn,
      "SELECT table_total_after FROM run_log_sources",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.table_total_after)).toBe(999);
    await db.close();
  });

  it("is idempotent on a second call", async () => {
    const dir = runsDirWith({ "a.json": run({ run_id: "run-a" }), "b.json": run({ run_id: "run-b" }) });
    const db = await coldDb();
    const first = await rehydrate(db, dir);
    const second = await rehydrate(db, dir);

    expect(first.runsInserted).toBe(2);
    expect(second.runsInserted).toBe(0);
    expect(second.sourcesInserted).toBe(0);
    expect(second.runsAlreadyPresent).toBe(2);
    expect(await runIds(db)).toEqual(["run-a", "run-b"]);
    expect(await sourceRows(db)).toHaveLength(2);
    await db.close();
  });
});

describe("one bad file never fails the run", () => {
  it("skips a file that is not JSON and still loads the rest", async () => {
    const dir = runsDirWith({ "broken.json": "{ not json", "good.json": run({ run_id: "run-a" }) });
    const db = await coldDb();
    const result = await rehydrate(db, dir);

    expect(await runIds(db)).toEqual(["run-a"]);
    expect(result.skipped.map((s) => s.file)).toEqual(["broken.json"]);
    expect(result.skipped[0]!.reason).toContain("unreadable");
    await db.close();
  });

  it("skips a file for another county", async () => {
    const dir = runsDirWith({
      "other.json": run({ run_id: "alachua-run", county: "alachua" }),
      "good.json": run({ run_id: "run-a" }),
    });
    const db = await coldDb();
    const result = await rehydrate(db, dir);

    expect(await runIds(db)).toEqual(["run-a"]);
    expect(result.skipped).toEqual([{ file: "other.json", reason: "county alachua, this pipeline is duval" }]);
    await db.close();
  });

  it("skips a file that carries no run_id, which is how the latest-*.json manifests are ignored", async () => {
    const dir = runsDirWith({
      "latest-publish-manifest.json": { county: "duval", mode: "published", objects: [] },
      "latest-dataset-coverage.json": { county: "duval", datasets: [] },
      "good.json": run({ run_id: "run-a" }),
    });
    const db = await coldDb();
    const result = await rehydrate(db, dir);

    expect(await runIds(db)).toEqual(["run-a"]);
    expect(result.skipped.map((s) => s.file).sort()).toEqual([
      "latest-dataset-coverage.json",
      "latest-publish-manifest.json",
    ]);
    expect(new Set(result.skipped.map((s) => s.reason))).toEqual(new Set(["no run_id"]));
    await db.close();
  });

  it("skips a run whose source record is missing a column run_log_sources requires", async () => {
    const dir = runsDirWith({
      "half.json": run({ run_id: "half", sources: [source({ started_at: null })] }),
      "good.json": run({ run_id: "run-a" }),
    });
    const db = await coldDb();
    const result = await rehydrate(db, dir);

    // The whole file is skipped rather than half loaded: run_log.sources and run_log_sources are
    // read by different consumers and must not disagree about the same run.
    expect(await runIds(db)).toEqual(["run-a"]);
    expect(result.skipped.map((s) => s.file)).toEqual(["half.json"]);
    await db.close();
  });

  it("treats a missing runs directory as normal, which is a fresh clone of a new county", async () => {
    const db = await coldDb();
    const result = await rehydrate(db, join(tmpdir(), "duval-runlog-does-not-exist-9d1f"));
    expect(result.filesSeen).toBe(0);
    expect(result.runsInserted).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(await runIds(db)).toEqual([]);
    await db.close();
  });

  it("treats an empty runs directory as normal", async () => {
    const db = await coldDb();
    const result = await rehydrate(db, runsDirWith({}));
    expect(result.filesSeen).toBe(0);
    expect(result.runsInserted).toBe(0);
    await db.close();
  });
});

describe("the run records committed to this repository", () => {
  it("all load, and only the bookkeeping files beside them are skipped", async () => {
    const db = await coldDb();
    const result = await rehydrate(db, join(REPO_DIR, "runs"));

    expect(result.runsInserted).toBeGreaterThanOrEqual(31);
    expect(result.runsInserted + result.skipped.length).toBe(result.filesSeen);
    // runs/ holds three kinds of file. The per-run records, named for their ULID, are the only ones
    // that rehydrate. The `latest-*` copies are the newest publish's outputs kept for a reader. The
    // three ledgers are ABOUT the runs rather than records OF one: ci-runs.json in particular
    // carries a `runs` array and track-state.json carries a `run_id`, so naming them here is what
    // stops either being mistaken for a run and inserted into run_log as a phantom.
    const bookkeeping = /^(latest-.+|ci-runs|table-highwater|track-state)\.json$/;
    expect(result.skipped.filter((s) => !bookkeeping.test(s.file))).toEqual([]);
    expect(result.skipped.map((s) => s.file)).toEqual(expect.arrayContaining(["ci-runs.json", "table-highwater.json", "track-state.json"]));
    expect(result.sourcesInserted).toBeGreaterThanOrEqual(result.runsInserted);

    const history = await loadRunHistory(db);
    expect(history).toHaveLength(result.runsInserted);
    // Every published stamp is explicit UTC whichever shape the file used.
    expect(history.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.started_at))).toBe(true);
    await db.close();
  });
});
