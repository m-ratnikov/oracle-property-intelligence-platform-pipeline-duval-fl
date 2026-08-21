import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COUNTY, REPO_DIR } from "../src/config.js";
import { all, ensureSchema, openDb, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { previousTotal, tableDelta } from "../src/run.js";
import { insertRunSource, rehydrateRunLog, type InsertableRunSource } from "../src/runLog.js";

/**
 * The published `water` row read "inserted 0, updated 0, unchanged 757" and "table delta +757" in
 * the same row. The merge was right and the delta was wrong: that database's `run_log` simply had
 * no earlier `water` run to subtract, and the code reported the whole table as the movement.
 *
 * "No previous run to compare against" is not +757 and is not 0. It is unknown, and the first run
 * of a genuinely new county hits it too, so it has to be right on its own merits.
 */

const silent = createLogger({}, "error", () => {});

async function coldDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

/** A completed `sales` row as a track running against THIS database writes one. */
function localSource(over: Partial<InsertableRunSource> = {}): InsertableRunSource {
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
    started_at: "2026-08-21 21:00:00.000",
    finished_at: "2026-08-21 21:01:00.000",
    status: "completed",
    limitations: [],
    notes: {},
    error: null,
    ...over,
  };
}

describe("the table delta against the previous recorded run", () => {
  it("subtracts the previous total when there is one", () => {
    expect(tableDelta(757, 757)).toBe(0);
    expect(tableDelta(73774, 71992)).toBe(1782);
    expect(tableDelta(400, 757)).toBe(-357);
  });

  it("reports unknown, not the whole table, when no previous run is recorded", () => {
    // This is the bug the published history showed. Reporting `after` here claims a first load
    // on a run that inserted nothing.
    expect(tableDelta(757, null)).toBeNull();
  });

  it("reports unknown when the run never observed a table total", () => {
    expect(tableDelta(null, 757)).toBeNull();
    expect(tableDelta(null, null)).toBeNull();
  });

  it("keeps a genuine zero distinct from unknown", () => {
    expect(tableDelta(0, 0)).toBe(0);
    expect(tableDelta(0, null)).toBeNull();
  });
});

/**
 * Rehydrating gave the database its history back, and then a run subtracted the OTHER lineage's
 * total from its own tables. The committed records come from both Actions cache lineages, whose
 * databases hold different amounts of data, so a rehydrated `table_total_after` counts a table this
 * database does not have. Run 01M0JZHQY2SM published "sales 65,876, delta -7,528" on a run that
 * inserted nothing, because the most recent recorded total was the branch lineage's 73,404.
 *
 * A rehydrated row stays history for display, provenance and coverage. It is not a measurement of
 * this database, and previousTotal reads only rows this database produced.
 */
describe("a cold database with the committed run records on disk", () => {
  it("still reports unknown, because the rehydrated totals describe another database", async () => {
    const db = await coldDb();
    const runsDir = join(REPO_DIR, "runs");

    expect(await previousTotal(db, "water")).toBeNull();

    const result = await rehydrateRunLog(db, { runsDir, county: COUNTY.key, logger: silent });
    expect(result.runsInserted).toBeGreaterThanOrEqual(31);
    expect(result.sourcesInserted).toBeGreaterThan(0);

    // The history is there to read...
    const rows = await all<{ n: string | number }>(
      db.conn,
      "SELECT count(*) AS n FROM run_log_sources WHERE track = 'water' AND table_total_after IS NOT NULL",
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    // ...and none of it is a total this database measured.
    expect(await previousTotal(db, "water")).toBeNull();
    expect(tableDelta(757, await previousTotal(db, "water"))).toBeNull();
    await db.close();
  });

  it("compares against this database's own earlier run once it has one", async () => {
    const db = await coldDb();
    await rehydrateRunLog(db, { runsDir: join(REPO_DIR, "runs"), county: COUNTY.key, logger: silent });
    expect(await previousTotal(db, "sales")).toBeNull();

    // The first run of this lineage: unknown delta, and a total of its own recorded.
    await insertRunSource(db, "local-run-1", localSource({ table_total_after: 65876 }));
    const prev = await previousTotal(db, "sales");
    expect(prev).toBe(65876);
    expect(tableDelta(65876, prev)).toBe(0);
    expect(tableDelta(66000, prev)).toBe(124);
    await db.close();
  });
});
