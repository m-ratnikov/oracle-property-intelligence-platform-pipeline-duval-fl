import { describe, expect, it } from "vitest";
import { ensureSchema, openDb, q } from "../src/db.js";
import { loadRunHistory } from "../src/run.js";

/**
 * The run history is read by a browser, and a browser parses a zoneless stamp as LOCAL
 * time. Publishing "2026-08-21 16:34:49.119" therefore shifted every run record by the
 * reader's UTC offset. These tests pin the published shape to explicit UTC.
 */
async function historyWith(rows: { runId: string; started: string; finished: string | null }[]) {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  for (const row of rows) {
    await db.conn.run(`
      INSERT INTO run_log (run_id, started_at, finished_at, status, trigger, git_sha, tracks, "window")
      VALUES (${q(row.runId)}, ${q(row.started)}::TIMESTAMP,
              ${row.finished === null ? "NULL" : `${q(row.finished)}::TIMESTAMP`},
              'completed', 'schedule', NULL, 'appraisal', NULL)`);
  }
  const history = await loadRunHistory(db);
  await db.close();
  return history;
}

describe("published run history timestamps", () => {
  it("emits ISO-8601 with an explicit Z, not a zoneless DuckDB stamp", async () => {
    const [run] = await historyWith([
      { runId: "run-a", started: "2026-08-21 16:34:49.119", finished: "2026-08-21 16:35:13.42" },
    ]);
    expect(run!.started_at).toBe("2026-08-21T16:34:49.119Z");
    expect(run!.finished_at).toBe("2026-08-21T16:35:13.420Z");
  });

  it("round trips through the browser's Date parser without shifting the instant", async () => {
    const [run] = await historyWith([
      { runId: "run-a", started: "2026-08-21 16:34:49.119", finished: "2026-08-21 16:35:13.42" },
    ]);
    // Date.parse on the published string must give back the same wall clock in UTC,
    // whatever zone the process running this test happens to be in.
    expect(new Date(run!.started_at).toISOString()).toBe("2026-08-21T16:34:49.119Z");
  });

  it("keeps an unfinished run's finished_at null rather than inventing a stamp", async () => {
    const [run] = await historyWith([
      { runId: "run-a", started: "2026-08-21 16:34:49.119", finished: null },
    ]);
    expect(run!.finished_at).toBeNull();
  });

  it("still orders newest first", async () => {
    const history = await historyWith([
      { runId: "older", started: "2026-08-21 07:17:00", finished: "2026-08-21 07:18:48" },
      { runId: "newer", started: "2026-08-21 16:12:03.152", finished: "2026-08-21 16:34:46.424" },
    ]);
    expect(history.map((run) => run.run_id)).toEqual(["newer", "older"]);
    expect(history[0]!.started_at).toBe("2026-08-21T16:12:03.152Z");
    // A whole-second stamp still carries the millisecond field, so every published
    // stamp has one shape.
    expect(history[1]!.started_at).toBe("2026-08-21T07:17:00.000Z");
  });
});
