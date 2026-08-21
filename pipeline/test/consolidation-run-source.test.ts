import { describe, expect, it } from "vitest";
import { CONSOLIDATION_TRACK, consolidationSourceRecord, type ConsolidationStats } from "../src/consolidation/export.js";
import { all, ensureSchema, openDb, type Db } from "../src/db.js";
import { previousTotal, type RunSourceRecord } from "../src/run.js";
import { insertRunSource } from "../src/runLog.js";

/**
 * The consolidation pass wrote its own `run_log_sources` row with positional literals, and put
 * `stats.exported` in `delta_vs_prev_total`. `exported` is how many property records the pass
 * re-hashed and republished; it is not movement against any previous total.
 *
 * The published record 01M0JWWX84PG2TJEWHSY5VP5C4 is what that looks like: 337 exported, 403,686
 * unchanged, 404,023 in state, and the run before it also held 404,023. The table moved by 0 and
 * the row claimed +337.
 */

const STATS: ConsolidationStats = {
  candidates: 404023,
  exported: 337,
  unchanged: 403686,
  totalInState: 404023,
  totalBytes: 1808843517,
  shards: 41,
  indexCid: "QmPWcAUMiH4t6PHCCwTARmaTA4YPwYymhNczRSDCzpSuD7",
  manifestCid: "QmXRMchgAtWmkUvNdBTZR6hvZBX9wKQ2GkYTPRZVYzHBzd",
  ms: 16427,
};

const STARTED = "2026-08-21T19:31:22.501Z";
const FINISHED = "2026-08-21T19:31:46.416Z";

function record(prevTotal: number | null, stats: ConsolidationStats = STATS): RunSourceRecord {
  return consolidationSourceRecord({
    stats,
    startedAt: STARTED,
    finishedAt: FINISHED,
    artifactPath: "open-data",
    prevTotal,
    since: "changed",
    limit: null,
  });
}

async function coldDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

/** One earlier consolidation pass, exactly as the live path records one. */
async function seedPreviousPass(db: Db, totalInState: number): Promise<void> {
  await insertRunSource(db, "01M0JJSM4Y61416J03ZKD44KFG", {
    ...record(null, { ...STATS, totalInState, exported: 320, unchanged: totalInState - 320 }),
    started_at: "2026-08-21 16:34:49.119",
    finished_at: "2026-08-21 16:35:13.420",
  });
}

describe("the consolidation pass's delta_vs_prev_total", () => {
  it("is the table's own movement, not the count of records it republished", () => {
    // 337 property files rewritten, and consolidation_state held 404,023 before and after.
    expect(record(404023).delta_vs_prev_total).toBe(0);
    expect(record(404023).delta_vs_prev_total).not.toBe(STATS.exported);
  });

  it("reports growth against the previous pass, not the republished count", () => {
    expect(record(403000).delta_vs_prev_total).toBe(1023);
  });

  it("reports a shrinking table as a negative movement", () => {
    expect(record(404500).delta_vs_prev_total).toBe(-477);
  });

  it("is unknown, not the republished count, when no previous pass is recorded", () => {
    // The first consolidation pass of a county. Reporting 337 here would claim a movement nobody
    // measured; reporting 0 would claim the table did not move.
    expect(record(null).delta_vs_prev_total).toBeNull();
  });

  it("keeps the republished count where it belongs", () => {
    const r = record(404023);
    expect(r.inserted).toBe(337);
    expect(r.unchanged).toBe(403686);
    expect(r.rows_staged).toBe(404023);
    expect(r.table_total_after).toBe(404023);
  });
});

describe("the consolidation row against a database with and without a previous pass", () => {
  it("has no previous total on a cold database, and records unknown", async () => {
    const db = await coldDb();
    const prev = await previousTotal(db, CONSOLIDATION_TRACK);
    expect(prev).toBeNull();

    const rec = record(prev);
    expect(rec.delta_vs_prev_total).toBeNull();
    await insertRunSource(db, "01M0JWWX84PG2TJEWHSY5VP5C4", rec);

    const [row] = await all<{ delta_vs_prev_total: number | null; table_total_after: number | bigint }>(
      db.conn,
      "SELECT delta_vs_prev_total, table_total_after FROM run_log_sources WHERE track = 'consolidation'",
    );
    expect(row?.delta_vs_prev_total).toBeNull();
    expect(Number(row?.table_total_after)).toBe(404023);
    await db.close();
  });

  it("subtracts the previous pass's total once one is recorded", async () => {
    const db = await coldDb();
    await seedPreviousPass(db, 404023);

    const prev = await previousTotal(db, CONSOLIDATION_TRACK);
    expect(prev).toBe(404023);

    const rec = record(prev);
    expect(rec.delta_vs_prev_total).toBe(0);
    await insertRunSource(db, "01M0JWWX84PG2TJEWHSY5VP5C4", rec);

    const [row] = await all<{ delta_vs_prev_total: number | bigint | null }>(
      db.conn,
      "SELECT delta_vs_prev_total FROM run_log_sources WHERE run_id = '01M0JWWX84PG2TJEWHSY5VP5C4'",
    );
    expect(Number(row?.delta_vs_prev_total)).toBe(0);
    await db.close();
  });

  it("reports real growth when the previous pass held fewer properties", async () => {
    const db = await coldDb();
    await seedPreviousPass(db, 403000);
    const rec = record(await previousTotal(db, CONSOLIDATION_TRACK));
    expect(rec.delta_vs_prev_total).toBe(1023);
    await db.close();
  });
});

/**
 * The row used to be a hand written `INSERT INTO run_log_sources VALUES (...)`. It now goes through
 * `insertRunSource`, the same statement the ingestion tracks and the rehydrate path use, so the
 * three cannot drift apart positionally. This is the check that they have not.
 */
describe("column parity with the live ingestion path", () => {
  it("lands every value in the column the schema names", async () => {
    const db = await coldDb();
    await insertRunSource(db, "01M0JWWX84PG2TJEWHSY5VP5C4", record(404023));

    const [row] = await all<Record<string, unknown>>(
      db.conn,
      "SELECT * FROM run_log_sources WHERE run_id = '01M0JWWX84PG2TJEWHSY5VP5C4'",
    );
    expect(row).toBeDefined();
    const n = (v: unknown) => (v === null ? null : Number(v));
    expect(row!.run_id).toBe("01M0JWWX84PG2TJEWHSY5VP5C4");
    expect(row!.track).toBe("consolidation");
    expect(row!.source_system).toBe("duval_consolidation");
    expect(row!.target_table).toBe("consolidation_state");
    expect(row!.source_url).toBe("derived");
    expect(row!.artifact_path).toBe("open-data");
    expect(row!.artifact_sha256).toBeNull();
    expect(row!.artifact_etag).toBeNull();
    expect(row!.artifact_last_modified).toBeNull();
    expect(n(row!.artifact_bytes)).toBeNull();
    expect(row!.download_status).toBe("derived");
    expect(n(row!.rows_staged)).toBe(404023);
    expect(n(row!.inserted)).toBe(337);
    expect(n(row!.updated)).toBe(0);
    expect(n(row!.unchanged)).toBe(403686);
    expect(n(row!.missing_in_source)).toBe(0);
    expect(n(row!.table_total_after)).toBe(404023);
    expect(n(row!.delta_vs_prev_total)).toBe(0);
    expect(row!.status).toBe("completed");
    expect(String(row!.limitations)).toBe("[]");
    expect(row!.error).toBeNull();
    await db.close();
  });

  it("puts the same numbers in the same columns as an ingestion track's row", async () => {
    const db = await coldDb();
    // An ingestion-shaped record built by hand: same counts, same columns, different track.
    const ingestion: RunSourceRecord = {
      ...record(404023),
      track: "sales",
      source_system: "fdor",
      target_table: "sales",
      source_url: "https://example.invalid/sales.zip",
      artifact_path: "sales/2026-08-21.zip",
      download_status: "downloaded",
    };
    await insertRunSource(db, "run-consolidation", record(404023));
    await insertRunSource(db, "run-ingestion", ingestion);

    const rows = await all<Record<string, unknown>>(
      db.conn,
      `SELECT rows_staged, inserted, updated, unchanged, missing_in_source, table_total_after, delta_vs_prev_total
       FROM run_log_sources ORDER BY run_id`,
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? Number(v) : v))).toBe(
      JSON.stringify(rows[1], (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
    );
    await db.close();
  });

  it("is readable back by previousTotal, so the next pass has a total to subtract", async () => {
    const db = await coldDb();
    await insertRunSource(db, "01M0JWWX84PG2TJEWHSY5VP5C4", record(null));
    expect(await previousTotal(db, CONSOLIDATION_TRACK)).toBe(404023);
    await db.close();
  });
});
