import { describe, expect, it } from "vitest";
import { openDb, PROVENANCE_COLUMNS, scalar } from "../src/db.js";
import { assertHeader, hashStaging, mergeStaging, type Provenance } from "../src/merge.js";

const prov = (runId: string): Provenance => ({
  sourceSystem: "test",
  sourceUrl: "https://example.test/file.zip",
  sourceArtifact: "test/file.zip",
  sourceSha256: "abc",
  fetchedAt: "2026-08-21T00:00:00Z",
  runId,
});

async function setup() {
  const db = await openDb(":memory:");
  await db.conn.run("CREATE SCHEMA staging");
  await db.conn.run(`CREATE TABLE widgets (id VARCHAR NOT NULL, name VARCHAR, price DOUBLE, ${PROVENANCE_COLUMNS})`);
  return db;
}

describe("row hashing + merge deltas", () => {
  it("first load inserts everything; identical reload is all unchanged", async () => {
    const db = await setup();
    await db.conn.run("CREATE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0),('b','beta',2.0),('c','gamma',3.0)) t(id,name,price)");
    const h1 = await hashStaging(db.conn, "staging.widgets", prov("run1"));
    const s1 = await mergeStaging(db.conn, { target: "widgets", staging: h1, keys: ["id"] });
    expect(s1).toMatchObject({ staged: 3, inserted: 3, updated: 0, unchanged: 0, missingInSource: 0, totalBefore: 0, totalAfter: 3 });

    const h2 = await hashStaging(db.conn, "staging.widgets", prov("run2"));
    const s2 = await mergeStaging(db.conn, { target: "widgets", staging: h2, keys: ["id"] });
    expect(s2).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, missingInSource: 0, totalAfter: 3 });
    // unchanged rows keep their original provenance
    expect(await scalar(db.conn, "SELECT count(*) FROM widgets WHERE run_id = 'run1'")).toBe("3");
    await db.close();
  });

  it("detects changed, new and missing rows and keeps missing rows", async () => {
    const db = await setup();
    await db.conn.run("CREATE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0),('b','beta',2.0),('c','gamma',3.0)) t(id,name,price)");
    await mergeStaging(db.conn, { target: "widgets", staging: await hashStaging(db.conn, "staging.widgets", prov("run1")), keys: ["id"] });

    // b changes price, c is missing from the new snapshot, d is new
    await db.conn.run("CREATE OR REPLACE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0),('b','beta',2.5),('d','delta',4.0)) t(id,name,price)");
    const s = await mergeStaging(db.conn, { target: "widgets", staging: await hashStaging(db.conn, "staging.widgets", prov("run2")), keys: ["id"] });
    expect(s).toMatchObject({ staged: 3, inserted: 1, updated: 1, unchanged: 1, missingInSource: 1, totalBefore: 3, totalAfter: 4 });
    expect(await scalar(db.conn, "SELECT price FROM widgets WHERE id = 'b'")).toBe(2.5);
    expect(await scalar(db.conn, "SELECT run_id FROM widgets WHERE id = 'b'")).toBe("run2");
    expect(await scalar(db.conn, "SELECT run_id FROM widgets WHERE id = 'a'")).toBe("run1");
    expect(await scalar(db.conn, "SELECT count(*) FROM widgets WHERE id = 'c'")).toBe("1");
    await db.close();
  });

  it("row_hash is content-addressed: same content gives same hash across runs", async () => {
    const db = await setup();
    await db.conn.run("CREATE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0)) t(id,name,price)");
    const h1 = await hashStaging(db.conn, "staging.widgets", prov("run1"));
    const first = await scalar<string>(db.conn, `SELECT row_hash FROM ${h1}`);
    const h2 = await hashStaging(db.conn, "staging.widgets", prov("run2"));
    const second = await scalar<string>(db.conn, `SELECT row_hash FROM ${h2}`);
    expect(first).toBe(second);
    await db.conn.run("CREATE OR REPLACE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.01)) t(id,name,price)");
    const h3 = await hashStaging(db.conn, "staging.widgets", prov("run3"));
    expect(await scalar<string>(db.conn, `SELECT row_hash FROM ${h3}`)).not.toBe(first);
    await db.close();
  });

  it("refuses duplicate or null natural keys in staging", async () => {
    const db = await setup();
    await db.conn.run("CREATE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0),('a','alpha2',1.0)) t(id,name,price)");
    const h = await hashStaging(db.conn, "staging.widgets", prov("run1"));
    await expect(mergeStaging(db.conn, { target: "widgets", staging: h, keys: ["id"] })).rejects.toThrow(/duplicate natural keys/);
    await db.conn.run("CREATE OR REPLACE TABLE staging.widgets AS SELECT * FROM (VALUES (NULL,'x',1.0)) t(id,name,price)");
    const h2 = await hashStaging(db.conn, "staging.widgets", prov("run1"));
    await expect(mergeStaging(db.conn, { target: "widgets", staging: h2, keys: ["id"] })).rejects.toThrow(/NULL keys/);
    await db.close();
  });

  it("fails loudly on schema drift (staging column unknown to target)", async () => {
    const db = await setup();
    await db.conn.run("CREATE TABLE staging.widgets AS SELECT * FROM (VALUES ('a','alpha',1.0,'x')) t(id,name,price,colour)");
    const h = await hashStaging(db.conn, "staging.widgets", prov("run1"));
    await expect(mergeStaging(db.conn, { target: "widgets", staging: h, keys: ["id"] })).rejects.toThrow(/Schema drift/);
    await db.close();
  });
});

/**
 * `gadgets` stands in for a target table with the two shapes that break an unscoped missing count:
 * `writer` says which track wrote a row (as `sale_source` does on sales_history) and `parcel_id`
 * bounds what a windowed run re-read (as the pa_detail seed window does).
 */
async function setupShared() {
  const db = await openDb(":memory:");
  await db.conn.run("CREATE SCHEMA staging");
  await db.conn.run(
    `CREATE TABLE gadgets (id VARCHAR NOT NULL, writer VARCHAR, parcel_id VARCHAR, name VARCHAR, ${PROVENANCE_COLUMNS})`,
  );
  return db;
}

/** Replace staging.gadgets with the given rows and merge them, returning the stats. */
async function stageAndMerge(
  db: Awaited<ReturnType<typeof setupShared>>,
  rows: [string, string, string, string][],
  runId: string,
  authoritativeScope?: string,
) {
  const values = rows.map((r) => `('${r[0]}','${r[1]}','${r[2]}','${r[3]}')`).join(",");
  await db.conn.run(`CREATE OR REPLACE TABLE staging.gadgets AS SELECT * FROM (VALUES ${values}) t(id,writer,parcel_id,name)`);
  const h = await hashStaging(db.conn, "staging.gadgets", prov(runId));
  return mergeStaging(db.conn, { target: "gadgets", staging: h, keys: ["id"], authoritativeScope });
}

describe("missing-in-source scoping", () => {
  it("does not count another writer's rows as missing from this source", async () => {
    const db = await setupShared();
    await stageAndMerge(db, [["a1", "alpha", "p1", "one"], ["a2", "alpha", "p2", "two"]], "run1");
    // a second track writes into the same table; it can only speak for its own rows
    const beta = await stageAndMerge(db, [["b1", "beta", "p1", "extra"]], "run2", "t.writer = 'beta'");
    expect(beta).toMatchObject({ inserted: 1, missingInSource: 0, totalAfter: 3 });

    // alpha restages its complete snapshot. Unscoped it counts beta's row as a source deletion.
    const unscoped = await stageAndMerge(db, [["a1", "alpha", "p1", "one"], ["a2", "alpha", "p2", "two"]], "run3");
    expect(unscoped).toMatchObject({ unchanged: 2, missingInSource: 1 });
    const scoped = await stageAndMerge(
      db,
      [["a1", "alpha", "p1", "one"], ["a2", "alpha", "p2", "two"]],
      "run3",
      "t.writer = 'alpha'",
    );
    expect(scoped).toMatchObject({ unchanged: 2, missingInSource: 0 });
    await db.close();
  });

  it("does not count rows outside the staged window as missing", async () => {
    const db = await setupShared();
    await stageAndMerge(db, [["w1", "alpha", "p1", "one"], ["w2", "alpha", "p2", "two"]], "run1");
    // the next run reads a different window; p1 and p2 were simply not looked at
    const unscoped = await stageAndMerge(db, [["w3", "alpha", "p3", "three"]], "run2");
    expect(unscoped).toMatchObject({ inserted: 1, missingInSource: 2 });

    const scoped = await stageAndMerge(
      db,
      [["w3", "alpha", "p3", "three"]],
      "run3",
      "t.parcel_id IN ('p3')",
    );
    expect(scoped).toMatchObject({ unchanged: 1, missingInSource: 0, totalAfter: 3 });
    await db.close();
  });

  it("still counts a row that disappeared from inside the staged scope", async () => {
    const db = await setupShared();
    await stageAndMerge(
      db,
      [["w1", "alpha", "p1", "one"], ["w1b", "alpha", "p1", "one-b"], ["w2", "alpha", "p2", "two"]],
      "run1",
    );
    // p1 is re-read and the source now lists only w1: w1b is a real deletion, w2 is out of scope
    const stats = await stageAndMerge(db, [["w1", "alpha", "p1", "one"]], "run2", "t.parcel_id IN ('p1')");
    expect(stats).toMatchObject({ staged: 1, inserted: 0, updated: 0, unchanged: 1, missingInSource: 1 });
    // scoping changes what is reported, never what is stored: missing rows are still kept
    expect(await scalar(db.conn, "SELECT count(*) FROM gadgets")).toBe("3");
    await db.close();
  });

  it("leaves inserted, updated and unchanged unscoped, because the merge writes those keys anyway", async () => {
    const db = await setupShared();
    await stageAndMerge(db, [["a1", "alpha", "p1", "one"]], "run1");
    // the staged row is outside the declared scope, yet it is still merged and still counted
    const stats = await stageAndMerge(db, [["a1", "alpha", "p1", "changed"]], "run2", "t.parcel_id IN ('p9')");
    expect(stats).toMatchObject({ updated: 1, missingInSource: 0 });
    expect(await scalar(db.conn, "SELECT name FROM gadgets WHERE id = 'a1'")).toBe("changed");
    await db.close();
  });
});

describe("assertHeader", () => {
  it("passes on exact header, throws on missing, throws on new unless allowed", () => {
    expect(() => assertHeader({ expected: ["A", "B"], actual: ["a", "b"], source: "t" })).not.toThrow();
    expect(() => assertHeader({ expected: ["A", "B"], actual: ["A"], source: "t" })).toThrow(/missing expected columns B/);
    expect(() => assertHeader({ expected: ["A"], actual: ["A", "C"], source: "t" })).toThrow(/unexpected new columns C/);
    expect(assertHeader({ expected: ["A"], actual: ["A", "C"], source: "t", allowNewColumns: true })).toEqual({ newColumns: ["C"] });
  });
});
