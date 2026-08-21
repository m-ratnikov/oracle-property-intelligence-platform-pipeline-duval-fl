import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { all, ensureSchema, openDb, q, type Db } from "../src/db.js";
import { DONE_PARCELS, MERGED_LOG, refreshDoneParcels, seedPosition, seedWindowSql, STATE_CURSOR } from "../src/tracks/pa_detail.js";

/**
 * The pa_detail resume window.
 *
 * The track used to start its window at `track_state.seed_cursor`, a counter kept inside the DuckDB.
 * The DuckDB is restored from a GitHub Actions cache; those caches are branch scoped and evicted
 * after 7 days, so when a run moved from the feature branch to main the counter rewound to 0 while
 * the table did not. The track re-walked parcels it already held and `pa_detail_buildings` went
 * from 1,619 rows to 466, which is the number the published coverage artifact then served.
 *
 * These tests pin the property that fixes it: the window is selected from the data (rows held, page
 * read and merged), so it cannot disagree with the tables, and the reported cursor is derived from
 * that same evidence rather than accumulated.
 */

const tmp = mkdtempSync(join(tmpdir(), "duval-pa-resume-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Seed parcels in the shape the real Duval.csv uses: `0000010005R`, in order, with an address. */
const parcel = (i: number) => `${String(i).padStart(10, "0")}R`;

let seq = 0;
/** A seed CSV of `n` parcels, with the columns the window query reads. */
function seedCsv(n: number): string {
  const file = join(tmp, `seed-${(seq += 1)}.csv`);
  const rows = ["parcel_id,address,method,county"];
  for (let i = 1; i <= n; i += 1) rows.push(`${parcel(i)},"${i} MAIN ST, JACKSONVILLE, FL 32202",GET,duval`);
  writeFileSync(file, `${rows.join("\n")}\n`);
  return file;
}

/** The artifacts dir this track keeps its pages and its merged-parcel log in. */
function artifactsDir(): string {
  const dir = join(tmp, `pa_detail-${(seq += 1)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, MERGED_LOG);
}

/** What the track appends once a run's merges have committed. */
function claim(mergedLog: string, parcels: string[]): void {
  if (parcels.length > 0) appendFileSync(mergedLog, `${parcels.join("\n")}\n`);
}

const PROV = `'duval_pa_detail', 'https://example.test', 'pa_detail/html/x.html', 'sha', '2026-08-01T00:00:00'::TIMESTAMP, 'run-earlier'`;

async function addBuilding(db: Db, parcelId: string): Promise<void> {
  await db.conn.run(
    `INSERT INTO pa_detail_buildings (building_key, parcel_id, building_no, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
     VALUES (${q(`${parcelId}#1`)}, ${q(parcelId)}, 1, ${q(`hb-${parcelId}`)}, ${PROV})`,
  );
}

async function addSale(db: Db, parcelId: string): Promise<void> {
  await db.conn.run(
    `INSERT INTO pa_detail_sales (pa_sale_key, parcel_id, sale_date, sale_price, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
     VALUES (${q(`ps-${parcelId}`)}, ${q(parcelId)}, '2023-05-16'::DATE, 312500, ${q(`hs-${parcelId}`)}, ${PROV})`,
  );
}

/** The parcel ids one run would work through, in the order the window returns them. */
async function windowParcels(db: Db, csv: string, mergedLog: string, size: number): Promise<string[]> {
  await refreshDoneParcels(db.conn, mergedLog);
  const rows = await all<{ parcel_id: string }>(db.conn, seedWindowSql(csv, size));
  return rows.map((r) => r.parcel_id);
}

/** A whole successful run: read the window, merge rows for it, then claim it. */
async function runWindow(db: Db, csv: string, mergedLog: string, size: number): Promise<string[]> {
  const window = await windowParcels(db, csv, mergedLog, size);
  for (const p of window) await addBuilding(db, p);
  claim(mergedLog, window);
  return window;
}

async function fresh(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

describe("pa_detail seed window", () => {
  it("starts at the beginning of the seed when the table is genuinely empty", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    expect(await windowParcels(db, csv, log, 5)).toEqual([1, 2, 3, 4, 5].map(parcel));
    expect(await seedPosition(db.conn, csv)).toEqual({ seedTotal: 25, remaining: 25, done: 0 });
    await db.close();
  });

  it("resumes past the rows already present when the cursor is cold and the table is warm", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    for (let i = 1; i <= 10; i += 1) await addBuilding(db, parcel(i));
    // the regression exactly: the restored cache lost track_state, so the counter says zero
    await db.conn.run(
      `INSERT INTO track_state VALUES ('pa_detail', ${q(STATE_CURSOR)}, '0', '2026-08-01T00:00:00'::TIMESTAMP, 'run-cold')`,
    );

    expect(await windowParcels(db, csv, log, 5)).toEqual([11, 12, 13, 14, 15].map(parcel));
    expect(await seedPosition(db.conn, csv)).toEqual({ seedTotal: 25, remaining: 15, done: 10 });
    await db.close();
  });

  it("resumes from the table alone when the merged-parcel log is gone", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    for (let i = 1; i <= 7; i += 1) await addBuilding(db, parcel(i));
    // no log file at all: a cache that carried the DuckDB but not the artifacts
    expect(await windowParcels(db, csv, log, 3)).toEqual([8, 9, 10].map(parcel));
    await db.close();
  });

  it("treats a parcel held only in pa_detail_sales as done, so the sales table cannot rewind either", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    for (let i = 1; i <= 5; i += 1) await addBuilding(db, parcel(i));
    // vacant land: the page parses to zero buildings but does carry sales
    for (let i = 6; i <= 8; i += 1) await addSale(db, parcel(i));

    expect(await windowParcels(db, csv, log, 4)).toEqual([9, 10, 11, 12].map(parcel));
    expect((await seedPosition(db.conn, csv)).done).toBe(8);
    await db.close();
  });

  it("treats a claimed parcel that produced no rows as done, so a run of them cannot stall the window", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    for (let i = 1; i <= 5; i += 1) await addBuilding(db, parcel(i));
    // read and merged, but the page holds neither a building nor a sale
    claim(log, [6, 7, 8, 9].map(parcel));

    expect(await windowParcels(db, csv, log, 3)).toEqual([10, 11, 12].map(parcel));
    expect((await seedPosition(db.conn, csv)).done).toBe(9);

    // and the next run does not pick them up again either
    await runWindow(db, csv, log, 3);
    expect(await windowParcels(db, csv, log, 3)).toEqual([13, 14, 15].map(parcel));
    await db.close();
  });

  it("re-offers a window whose run died before its merges committed", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    const first = await windowParcels(db, csv, log, 4);
    // pages fetched, nothing merged, nothing claimed: the run threw on the way to the merge
    expect(await windowParcels(db, csv, log, 4)).toEqual(first);
    expect((await seedPosition(db.conn, csv)).done).toBe(0);
    await db.close();
  });

  it("hands two consecutive completed runs disjoint, contiguous windows", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();

    const first = await runWindow(db, csv, log, 6);
    const second = await runWindow(db, csv, log, 6);

    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    expect(first.filter((p) => second.includes(p))).toEqual([]);
    expect([...first, ...second]).toEqual(Array.from({ length: 12 }, (_, i) => parcel(i + 1)));
    await db.close();
  });

  it("never returns more than the window, and stops when the seed is exhausted", async () => {
    const db = await fresh();
    const csv = seedCsv(8);
    const log = artifactsDir();
    expect(await windowParcels(db, csv, log, 5)).toHaveLength(5);
    for (let i = 1; i <= 8; i += 1) await addBuilding(db, parcel(i));
    expect(await windowParcels(db, csv, log, 5)).toEqual([]);
    expect(await seedPosition(db.conn, csv)).toEqual({ seedTotal: 8, remaining: 0, done: 8 });
    await db.close();
  });

  it("reports a cursor equal to the work actually done, and re-offers the parcels that produced nothing", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();

    // run one: five parcels asked for, five landed
    const first = await runWindow(db, csv, log, 5);
    expect(first).toEqual([1, 2, 3, 4, 5].map(parcel));
    await refreshDoneParcels(db.conn, log);
    expect((await seedPosition(db.conn, csv)).done).toBe(5);

    // run two: five asked for, only three answered; the other two were HTTP misses, so the run has
    // no page for them and does not claim them
    const second = await windowParcels(db, csv, log, 5);
    expect(second).toEqual([6, 7, 8, 9, 10].map(parcel));
    const answered = second.slice(0, 3);
    for (const p of answered) await addBuilding(db, p);
    claim(log, answered);

    await refreshDoneParcels(db.conn, log);
    // the reported figure counts the eight parcels that were actually read, not the ten attempted
    expect(await seedPosition(db.conn, csv)).toEqual({ seedTotal: 25, remaining: 17, done: 8 });
    // and the two misses are offered again rather than skipped past
    expect(await windowParcels(db, csv, log, 4)).toEqual([9, 10, 11, 12].map(parcel));
    await db.close();
  });

  it("does not let a row outside the seed inflate the reported figure", async () => {
    const db = await fresh();
    const csv = seedCsv(25);
    const log = artifactsDir();
    for (let i = 1; i <= 3; i += 1) await addBuilding(db, parcel(i));
    // parcels the seed does not list at all (an older seed, a manual backfill)
    await addBuilding(db, "9999999999R");
    claim(log, ["8888888888R"]);

    await refreshDoneParcels(db.conn, log);
    expect(await seedPosition(db.conn, csv)).toEqual({ seedTotal: 25, remaining: 22, done: 3 });
    expect(await windowParcels(db, csv, log, 2)).toEqual([4, 5].map(parcel));
    await db.close();
  });

  it("counts each done parcel once, however many rows and claims it carries", async () => {
    const db = await fresh();
    const csv = seedCsv(10);
    const log = artifactsDir();
    await db.conn.run(
      `INSERT INTO pa_detail_buildings (building_key, parcel_id, building_no, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
       VALUES (${q(`${parcel(1)}#2`)}, ${q(parcel(1))}, 2, 'hb2', ${PROV})`,
    );
    await addBuilding(db, parcel(1));
    await addSale(db, parcel(1));
    // claimed twice: a run that re-read the parcel after an earlier run failed to merge it
    claim(log, [parcel(1)]);
    claim(log, [parcel(1)]);

    await refreshDoneParcels(db.conn, log);
    expect(await all(db.conn, `SELECT count(*) AS n FROM ${DONE_PARCELS}`)).toEqual([{ n: "1" }]);
    expect((await seedPosition(db.conn, csv)).done).toBe(1);
    await db.close();
  });
});
