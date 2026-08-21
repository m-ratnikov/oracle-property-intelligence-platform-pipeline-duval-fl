import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COUNTY } from "../src/config.js";
import { all, ensureSchema, openDb, tableColumns, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { previousTotal, tableDelta } from "../src/run.js";
import { insertRunSource, rehydrateRunLog, type InsertableRunSource } from "../src/runLog.js";

/**
 * Rehydration handed the database a history that spans BOTH Actions cache lineages, and those two
 * databases hold different amounts of data. `previousTotal` read the most recent recorded total
 * without asking which database recorded it, so run 01M0JZHQY2SM (default branch, 20:17Z) published
 *
 *     sales      total_after  65,876   delta -7,528   (previous record: the branch lineage's 73,404)
 *     pa_detail  total_after     466   delta -1,153   (previous record: the branch lineage's 1,619)
 *     appraisal  total_after 404,023   delta      0   (both lineages agree, so it looked fine)
 *
 * A negative delta on a run that inserted nothing, on the page whose job is to prove incremental
 * ingestion. These tests pin the rule that fixes it: a rehydrated row is history for display,
 * provenance and coverage, and never a measurement of THIS database's tables.
 */

const silent = createLogger({}, "error", () => {});

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "duval-lineage-"));
  temps.push(root);
  return root;
}

async function coldDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

/** One completed source record, as a track writes it. */
function source(over: Partial<InsertableRunSource> = {}): InsertableRunSource {
  return {
    track: "sales",
    source_system: "fdor_sdf",
    target_table: "sales_history",
    source_url: "https://example.invalid/sdf.zip",
    artifact_path: "sales/sdf.zip",
    artifact_sha256: null,
    artifact_etag: null,
    artifact_last_modified: null,
    artifact_bytes: null,
    download_status: "cached",
    rows_staged: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    missing_in_source: 0,
    table_total_after: null,
    delta_vs_prev_total: null,
    started_at: "2026-08-21 19:00:00.000",
    finished_at: "2026-08-21 19:05:00.000",
    status: "completed",
    limitations: [],
    notes: {},
    error: null,
    ...over,
  };
}

/** A committed runs/<run_id>.json, as CI writes one, in a directory of its own. */
function runsDirWith(runId: string, sources: Record<string, unknown>[], startedAt: string): string {
  const dir = join(tempRoot(), "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${runId}.json`),
    JSON.stringify(
      {
        run_id: runId,
        county: COUNTY.key,
        started_at: startedAt,
        finished_at: startedAt,
        status: "completed",
        trigger: "workflow_dispatch",
        git_sha: null,
        tracks: [...new Set(sources.map((s) => String(s.track)))],
        window: null,
        sources,
        limitations: [],
        totals: {},
        artifacts: {},
        error: null,
      },
      null,
      2,
    ),
  );
  return dir;
}

describe("the previous total is this database's own, or nothing", () => {
  it("ignores a rehydrated row and reports unknown", async () => {
    const db = await coldDb();
    await insertRunSource(db, "foreign-run", source({ table_total_after: 73404 }), { rehydrated: true });

    expect(await previousTotal(db, "sales")).toBeNull();
    // Unknown, never a fallback to the foreign total: tableDelta renders it as unknown and the UI
    // as "no previous run recorded".
    expect(tableDelta(65876, await previousTotal(db, "sales"))).toBeNull();
    await db.close();
  });

  it("uses this database's own earlier run when it has one", async () => {
    const db = await coldDb();
    await insertRunSource(db, "local-run", source({ table_total_after: 65876 }));

    expect(await previousTotal(db, "sales")).toBe(65876);
    expect(tableDelta(66102, await previousTotal(db, "sales"))).toBe(226);
    await db.close();
  });

  it("prefers its own older run over a more recent rehydrated one", async () => {
    const db = await coldDb();
    await insertRunSource(db, "local-run", source({ table_total_after: 65876, started_at: "2026-08-21 19:00:00.000" }));
    await insertRunSource(db, "foreign-run", source({ table_total_after: 73404, started_at: "2026-08-21 20:00:00.000" }), {
      rehydrated: true,
    });

    // ORDER BY started_at DESC would otherwise pick the foreign row, which is the whole bug.
    expect(await previousTotal(db, "sales")).toBe(65876);
    await db.close();
  });

  it("keeps each track separate, so one lineage-crossing track does not hide another", async () => {
    const db = await coldDb();
    await insertRunSource(db, "foreign-run", source({ track: "pa_detail", table_total_after: 1619 }), { rehydrated: true });
    await insertRunSource(db, "local-run", source({ track: "appraisal", table_total_after: 404023 }));

    expect(await previousTotal(db, "pa_detail")).toBeNull();
    expect(await previousTotal(db, "appraisal")).toBe(404023);
    await db.close();
  });
});

describe("the run that published a negative delta on a run that inserted nothing", () => {
  it("reports unknown rather than -7,528 when the only history is the other lineage's", async () => {
    const db = await coldDb();
    // The branch lineage's record, committed to runs/ and checked out on the default branch runner.
    const dir = runsDirWith(
      "01M0JW0RRYFJ2Q3GYVRZ9SBTA6",
      [
        {
          ...source({ table_total_after: 73404, rows_staged: 73404 }),
          started_at: "2026-08-21T14:02:00.000Z",
          finished_at: "2026-08-21T14:09:00.000Z",
        },
        {
          ...source({ track: "pa_detail", target_table: "pa_detail_buildings", table_total_after: 1619, rows_staged: 1619 }),
          started_at: "2026-08-21T14:09:00.000Z",
          finished_at: "2026-08-21T14:12:00.000Z",
        },
      ],
      "2026-08-21T14:02:00.000Z",
    );
    const rehydrated = await rehydrateRunLog(db, { runsDir: dir, county: COUNTY.key, logger: silent });
    expect(rehydrated.runsInserted).toBe(1);
    expect(rehydrated.sourcesInserted).toBe(2);

    // Now this database's own run, which inserted nothing and holds 65,876 sales rows.
    const salesPrev = await previousTotal(db, "sales");
    const paPrev = await previousTotal(db, "pa_detail");
    // The published numbers, asserted first so a regression names them.
    expect(tableDelta(65876, salesPrev)).not.toBe(-7528);
    expect(tableDelta(466, paPrev)).not.toBe(-1153);
    expect(tableDelta(65876, salesPrev)).toBeNull();
    expect(tableDelta(466, paPrev)).toBeNull();
    expect(salesPrev).toBeNull();
    expect(paPrev).toBeNull();

    // And the row it writes carries that null, so the published record says "unknown", not a loss.
    await insertRunSource(
      db,
      "01M0JZHQY2SM4Q0GRXSXM1XW7T",
      source({
        table_total_after: 65876,
        delta_vs_prev_total: tableDelta(65876, salesPrev),
        started_at: "2026-08-21 20:17:00.000",
        finished_at: "2026-08-21 20:24:00.000",
      }),
    );
    const rows = await all<{ delta_vs_prev_total: string | number | null }>(
      db.conn,
      "SELECT delta_vs_prev_total FROM run_log_sources WHERE run_id = '01M0JZHQY2SM4Q0GRXSXM1XW7T'",
    );
    expect(rows[0]!.delta_vs_prev_total).toBeNull();

    // The run after it compares against its own row, which is the point of recording one.
    expect(await previousTotal(db, "sales")).toBe(65876);
    expect(tableDelta(65876, await previousTotal(db, "sales"))).toBe(0);
    await db.close();
  });
});

/** run_log_sources exactly as it was before the `rehydrated` column, which is what a warm cache holds. */
const PRE_COLUMN_DDL = `
CREATE TABLE run_log_sources (
  run_id               VARCHAR NOT NULL,
  track                VARCHAR NOT NULL,
  source_system        VARCHAR NOT NULL,
  target_table         VARCHAR NOT NULL,
  source_url           VARCHAR,
  artifact_path        VARCHAR,
  artifact_sha256      VARCHAR,
  artifact_etag        VARCHAR,
  artifact_last_modified VARCHAR,
  artifact_bytes       BIGINT,
  download_status      VARCHAR,
  rows_staged          BIGINT,
  inserted             BIGINT,
  updated              BIGINT,
  unchanged            BIGINT,
  missing_in_source    BIGINT,
  table_total_after    BIGINT,
  delta_vs_prev_total  BIGINT,
  started_at           TIMESTAMP NOT NULL,
  finished_at          TIMESTAMP,
  status               VARCHAR NOT NULL,
  limitations          JSON,
  error                VARCHAR
)`;

const PRE_COLUMN_ROW = `
INSERT INTO run_log_sources VALUES
  ('older-run', 'sales', 'fdor_sdf', 'sales_history', 'u', 'a', NULL, NULL, NULL, NULL, 'cached', 0, 0, 0, 0, 0,
   73404, 0, TIMESTAMP '2026-08-21 14:02:00', TIMESTAMP '2026-08-21 14:09:00', 'completed', '[]', NULL)`;

describe("a database that already existed before the column did", () => {
  it("gains the column, and its rows of unknown provenance are not trusted as totals", async () => {
    const path = join(tempRoot(), "warm.duckdb");
    const before = await openDb(path);
    await before.conn.run(PRE_COLUMN_DDL);
    await before.conn.run(PRE_COLUMN_ROW);
    expect(await tableColumns(before.conn, "main", "run_log_sources")).not.toContain("rehydrated");
    await before.close();

    // The next start of the pipeline against that same file.
    const db = await openDb(path);
    await ensureSchema(db.conn);
    expect(await tableColumns(db.conn, "main", "run_log_sources")).toContain("rehydrated");

    // A warm main-lineage cache holds BOTH its own rows and the foreign ones the first rehydrate
    // pass inserted, and nothing on disk tells them apart. Unknown provenance is not comparable:
    // that database reports unknown once and compares against its own row from then on.
    const marks = await all<{ rehydrated: boolean }>(db.conn, "SELECT rehydrated FROM run_log_sources");
    expect(marks.map((m) => m.rehydrated)).toEqual([true]);
    expect(await previousTotal(db, "sales")).toBeNull();

    await insertRunSource(db, "first-run-after-migration", source({ table_total_after: 65876, started_at: "2026-08-21 20:17:00.000" }));
    expect(await previousTotal(db, "sales")).toBe(65876);
    await db.close();
  });

  it("does not re-mark rows written since the migration on a later start", async () => {
    const path = join(tempRoot(), "warm-twice.duckdb");
    const first = await openDb(path);
    await first.conn.run(PRE_COLUMN_DDL);
    await first.conn.run(PRE_COLUMN_ROW);
    await ensureSchema(first.conn);
    await insertRunSource(first, "local-run", source({ table_total_after: 65876, started_at: "2026-08-21 20:17:00.000" }));
    await first.close();

    const db = await openDb(path);
    await ensureSchema(db.conn);
    const rows = await all<{ run_id: string; rehydrated: boolean }>(
      db.conn,
      "SELECT run_id, rehydrated FROM run_log_sources ORDER BY run_id",
    );
    expect(rows).toEqual([
      { run_id: "local-run", rehydrated: false },
      { run_id: "older-run", rehydrated: true },
    ]);
    expect(await previousTotal(db, "sales")).toBe(65876);
    await db.close();
  });
});
