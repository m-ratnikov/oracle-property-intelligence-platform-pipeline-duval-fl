import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COUNTY, REPO_DIR } from "../src/config.js";
import { ensureSchema, openDb, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { previousTotal, tableDelta } from "../src/run.js";
import { rehydrateRunLog } from "../src/runLog.js";

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

describe("a cold database with the committed run records on disk", () => {
  it("resolves the previous total instead of reporting a fake first load", async () => {
    const db = await coldDb();
    const runsDir = join(REPO_DIR, "runs");

    // Before rehydrating: exactly the runner the bug came from. The tables are populated, the
    // history is not, and the delta claims the whole table.
    expect(await previousTotal(db, "water")).toBeNull();
    expect(tableDelta(757, await previousTotal(db, "water"))).toBeNull();

    const result = await rehydrateRunLog(db, { runsDir, county: COUNTY.key, logger: silent });
    expect(result.runsInserted).toBeGreaterThanOrEqual(31);

    const prev = await previousTotal(db, "water");
    expect(prev).toBe(757);
    expect(tableDelta(757, prev)).toBe(0);
    await db.close();
  });

  it("resolves the previous total for a track whose table really did grow", async () => {
    const db = await coldDb();
    await rehydrateRunLog(db, { runsDir: join(REPO_DIR, "runs"), county: COUNTY.key, logger: silent });

    const prev = await previousTotal(db, "sales");
    expect(prev).not.toBeNull();
    expect(prev!).toBeGreaterThan(0);
    // A table that has not moved since the last recorded run reports 0, which is a fact, not a gap.
    expect(tableDelta(prev, prev)).toBe(0);
    await db.close();
  });
});
