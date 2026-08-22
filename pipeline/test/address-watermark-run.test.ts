import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaths } from "../src/config.js";
import { ensureSchema, getTrackState, openDb, type Db } from "../src/db.js";
import { log } from "../src/log.js";
import { SOURCES } from "../src/sources.js";
import { runCojAddresses, STATE_KEY_HELD_RUNS, STATE_KEY_LAST_EDIT } from "../src/tracks/coj_addresses.js";
import type { TrackContext } from "../src/tracks/types.js";

/**
 * The watermark defect, at the level where it did the damage: whether the cursor is WRITTEN.
 *
 * A held decision that still calls setTrackState would fix nothing, so this drives the real runner
 * against a stubbed ArcGIS layer and reads track_state afterwards.
 */

const SOURCE = SOURCES.coj_addresses;
const EDIT_2026_08_10 = Date.UTC(2026, 7, 10, 12, 0, 0);
const EDIT_2026_08_20 = Date.UTC(2026, 7, 20, 12, 0, 0);

function feature(id: string, editDate: number) {
  return { attributes: { ADDRESS_ID: id, RE: "000001-0001R", WHOLE_ADDRESS: `${id} MAIN ST`, ZIPCODE: "32207", LATITUDE: 30.3, LONGITUDE: -81.6, EDIT_DATE: editDate } };
}

/** An ArcGIS layer that reports `count` rows and answers each page from `pages` (by offset). */
function stubLayer(count: number, pages: Record<number, unknown>) {
  const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response);
  vi.stubGlobal("fetch", (url: string) => {
    const u = new URL(url);
    if (u.searchParams.get("returnCountOnly") === "true") return json({ count });
    const offset = Number(u.searchParams.get("resultOffset") ?? "0");
    return json(pages[offset] ?? { features: [] });
  });
}

async function runTrack(db: Db, dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const ctx: TrackContext = {
    conn: db.conn,
    runId: "run-under-test",
    paths: getPaths({ DATA_DIR: dataDir }),
    logger: log,
    window: null,
    force: false,
    env,
  };
  return runCojAddresses(ctx, SOURCE);
}

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

afterEach(() => vi.unstubAllGlobals());

describe("the address watermark is only written over ground that was covered", () => {
  it("does not write a cursor when a page failed", async () => {
    const db = await freshDb();
    const dataDir = mkdtempSync(join(tmpdir(), "duval-wm-"));
    // Two pages are planned from the reported count; the second answers with an ArcGIS error, so
    // the rows it holds were never seen. Those rows may carry any EDIT_DATE at all: offsets are not
    // ordered by edit date, which is why no partial advance is safe.
    stubLayer(3000, {
      0: { features: [feature("a1", EDIT_2026_08_10), feature("a2", EDIT_2026_08_20)], exceededTransferLimit: true },
      2000: { error: { code: 500, message: "layer unavailable" } },
    });

    const res = await runTrack(db, dataDir);

    expect(res.status).toBe("completed");
    expect(res.merge?.inserted).toBe(2);
    // the rows it did fetch are kept; only the cursor is withheld
    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_LAST_EDIT)).toBeNull();
    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_HELD_RUNS)).toBe("1");
    expect(res.limitations.join(" ")).toContain("watermark held at the start of the layer");
    expect(res.notes.lastEditDate).toBeNull();
    expect(res.notes.maxEditSeen).toBe("2026-08-20T12:00:00");

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not write a cursor when COJ_MAX_PAGES truncated the pull", async () => {
    const db = await freshDb();
    const dataDir = mkdtempSync(join(tmpdir(), "duval-wm-"));
    stubLayer(3000, {
      0: { features: [feature("a1", EDIT_2026_08_10)], exceededTransferLimit: true },
      2000: { features: [feature("a2", EDIT_2026_08_20)] },
    });

    const res = await runTrack(db, dataDir, { COJ_MAX_PAGES: "1" });

    expect(res.notes.pages).toBe(1);
    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_LAST_EDIT)).toBeNull();
    // a bounded pull must not spend the error budget: nothing about it says an error is persisting
    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_HELD_RUNS)).toBe("0");
    expect(res.limitations.join(" ")).toContain("COJ_MAX_PAGES");

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes the cursor after a complete pull, and clears any debt", async () => {
    const db = await freshDb();
    const dataDir = mkdtempSync(join(tmpdir(), "duval-wm-"));
    stubLayer(2, { 0: { features: [feature("a1", EDIT_2026_08_10), feature("a2", EDIT_2026_08_20)] } });

    const res = await runTrack(db, dataDir);

    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_LAST_EDIT)).toBe("2026-08-20T12:00:00");
    expect(await getTrackState(db.conn, SOURCE.track, STATE_KEY_HELD_RUNS)).toBe("0");
    expect(res.limitations.join(" ")).not.toContain("watermark");
    expect(res.notes.lastEditDate).toBe("2026-08-20T12:00:00");

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
