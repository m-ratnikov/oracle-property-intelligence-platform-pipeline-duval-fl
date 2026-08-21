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

describe("assertHeader", () => {
  it("passes on exact header, throws on missing, throws on new unless allowed", () => {
    expect(() => assertHeader({ expected: ["A", "B"], actual: ["a", "b"], source: "t" })).not.toThrow();
    expect(() => assertHeader({ expected: ["A", "B"], actual: ["A"], source: "t" })).toThrow(/missing expected columns B/);
    expect(() => assertHeader({ expected: ["A"], actual: ["A", "C"], source: "t" })).toThrow(/unexpected new columns C/);
    expect(assertHeader({ expected: ["A"], actual: ["A", "C"], source: "t", allowNewColumns: true })).toEqual({ newColumns: ["C"] });
  });
});
