import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Paths } from "../src/config.js";
import { all, ensureSchema, getTrackState, openDb, q, scalar, type Db } from "../src/db.js";
import { createLogger } from "../src/log.js";
import { SOURCES } from "../src/sources.js";
import {
  ANSWERED_LOG,
  coveredSequences,
  nextSequences,
  parsePermitNumber,
  permitNumber,
  permitPosition,
  runPermits,
  STATE_CURSOR,
} from "../src/tracks/permits.js";
import type { TrackContext } from "../src/tracks/types.js";

/**
 * The permits resume window.
 *
 * The track used to start its window at `track_state.cursor_seq`, a counter kept inside the DuckDB.
 * The DuckDB is restored from a GitHub Actions cache; those caches are branch scoped and evicted
 * after 7 days without a hit, so a run that moved between branches found no counter and rewound to
 * PERMITS_START_SEQ while the table it was meant to describe did not. The sibling pa_detail track
 * lost rows in production that exact way (pa_detail_buildings 1,619 -> 466, which is the figure the
 * published coverage artifact still serves).
 *
 * These tests pin the property that fixes it: the window is selected from the data (permit rows
 * held, plus the numbers a committed run got a definitive answer for), so it cannot disagree with
 * the table, and the reported cursor is derived from the same evidence rather than accumulated.
 *
 * JaxEPICS answers 404 for a number the county never issued, which is a normal outcome and not an
 * error, so "no row in permits" alone is not enough evidence: without the answered log every gap in
 * the county's numbering would be re-offered forever. A number that only timed out is unknown
 * rather than absent and stays out of that log, which is the same distinction permitNumbersScope
 * keeps for the merge.
 */

const tmp = mkdtempSync(join(tmpdir(), "duval-permits-resume-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const PREFIX = "B";
const YY = 25;
const START = 1;
const no = (seq: number) => permitNumber(PREFIX, YY, seq);

const PROV = `'coj_jaxepics', 'https://jaxepics.coj.net/Permit/View/', 'permits/discovered-api.json', 'sha', '2026-08-01T00:00:00'::TIMESTAMP, 'run-earlier'`;

let seq = 0;
/** A fresh artifacts dir, and the answered-permit log path inside it. */
function answeredLog(): string {
  const dir = join(tmp, `permits-${(seq += 1)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, ANSWERED_LOG);
}

async function fresh(): Promise<Db> {
  const db = await openDb(":memory:");
  await ensureSchema(db.conn);
  return db;
}

/** A permit row this track already holds, as a run that hit JSON for that number would leave it. */
async function heldPermit(db: Db, permitNo: string): Promise<void> {
  await db.conn.run(
    `INSERT INTO permits (permit_no, description, is_roof_permit, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
     VALUES (${q(permitNo)}, 'REROOF SHINGLE TO SHINGLE', true, ${q(`h-${permitNo}`)}, ${PROV})`,
  );
}

/** What the track appends once a run's merge has committed. */
function claim(log: string, numbers: string[]): void {
  if (numbers.length > 0) appendFileSync(log, `${numbers.join("\n")}\n`);
}

/** The permit numbers the answered log holds, sorted. */
function claimed(log: string): string[] {
  return readFileSync(log, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

/** The permit numbers one run would enumerate, in the order the window returns them. */
async function windowNumbers(db: Db, log: string, size: number, start = START): Promise<string[]> {
  const covered = await coveredSequences(db.conn, { prefix: PREFIX, yy: YY, answeredLog: log });
  return nextSequences(covered, start, size).map((s) => permitNumber(PREFIX, YY, s));
}

type Outcome = "hit" | "notFound" | "timeout";

/**
 * A whole run: enumerate the window, resolve each number, merge the hits, then claim only the
 * numbers that got a definitive answer. Timeouts are left unclaimed on purpose.
 */
async function runWindow(
  db: Db,
  log: string,
  size: number,
  outcome: (permitNo: string, index: number) => Outcome = () => "hit",
): Promise<string[]> {
  const window = await windowNumbers(db, log, size);
  const answered: string[] = [];
  for (const [i, permitNo] of window.entries()) {
    const what = outcome(permitNo, i);
    if (what === "hit") await heldPermit(db, permitNo);
    if (what !== "timeout") answered.push(permitNo);
  }
  claim(log, answered);
  return window;
}

describe("permit number parsing", () => {
  it("round-trips a B-YY-NNNNNN.NNN number and rejects anything else", () => {
    expect(parsePermitNumber("B-25-000012.000")).toEqual({ prefix: "B", yy: 25, seq: 12, sub: 0 });
    expect(parsePermitNumber(" b-25-279425.001 ")).toEqual({ prefix: "B", yy: 25, seq: 279425, sub: 1 });
    expect(parsePermitNumber("B-25-000012")).toEqual({ prefix: "B", yy: 25, seq: 12, sub: 0 });
    expect(parsePermitNumber("")).toBeNull();
    expect(parsePermitNumber("not-a-permit")).toBeNull();
    expect(parsePermitNumber("B-2025-000012.000")).toBeNull();
  });
});

describe("permits resume window", () => {
  it("starts at the configured start when the permits table is genuinely empty", async () => {
    const db = await fresh();
    const log = answeredLog();
    expect(await windowNumbers(db, log, 5)).toEqual([1, 2, 3, 4, 5].map(no));
    expect(permitPosition(await coveredSequences(db.conn, { prefix: PREFIX, yy: YY, answeredLog: log }), START)).toEqual({
      covered: 0,
      highestCovered: 0,
      nextSeq: 1,
    });
    // and it honours a PERMITS_START_SEQ that is not 1
    expect(await windowNumbers(db, log, 3, 500)).toEqual([500, 501, 502].map(no));
    await db.close();
  });

  it("resumes past the highest sequence already held when the cursor is cold and the table is warm", async () => {
    const db = await fresh();
    const log = answeredLog();
    for (let i = 1; i <= 10; i += 1) await heldPermit(db, no(i));
    // the regression exactly: the restored cache lost track_state, so the counter is back at zero
    await db.conn.run(
      `INSERT INTO track_state VALUES ('permits', ${q(STATE_CURSOR)}, '0', '2026-08-01T00:00:00'::TIMESTAMP, 'run-cold')`,
    );

    expect(await windowNumbers(db, log, 5)).toEqual([11, 12, 13, 14, 15].map(no));
    const pos = permitPosition(await coveredSequences(db.conn, { prefix: PREFIX, yy: YY, answeredLog: log }), START);
    expect(pos).toEqual({ covered: 10, highestCovered: 10, nextSeq: 11 });
    // the stale counter is still sitting there, and it changed nothing
    expect(await getTrackState(db.conn, "permits", STATE_CURSOR)).toBe("0");
    await db.close();
  });

  it("resumes from the permits table alone when the answered log is gone", async () => {
    const db = await fresh();
    const log = answeredLog();
    for (let i = 1; i <= 7; i += 1) await heldPermit(db, no(i));
    // no log file at all: a cache that carried the DuckDB but not the artifacts directory
    expect(existsSync(log)).toBe(false);
    expect(await windowNumbers(db, log, 3)).toEqual([8, 9, 10].map(no));
    await db.close();
  });

  it("does not re-walk a definitive 404, however many runs go by", async () => {
    const db = await fresh();
    const log = answeredLog();
    // seq 1..4 exist, 5..12 are a gap in the county's numbering and answer 404
    const first = await runWindow(db, log, 12, (_n, i) => (i < 4 ? "hit" : "notFound"));
    expect(first).toEqual(Array.from({ length: 12 }, (_x, i) => no(i + 1)));
    expect(await scalar(db.conn, "SELECT count(*) FROM permits")).toBe("4");

    // the gap is covered ground: the next window starts past it rather than asking again
    expect(await windowNumbers(db, log, 4)).toEqual([13, 14, 15, 16].map(no));

    // and a window that falls entirely inside a gap still moves the track forward
    const second = await runWindow(db, log, 4, () => "notFound");
    expect(second).toEqual([13, 14, 15, 16].map(no));
    expect(await windowNumbers(db, log, 4)).toEqual([17, 18, 19, 20].map(no));
    expect(await scalar(db.conn, "SELECT count(*) FROM permits")).toBe("4");
    await db.close();
  });

  it("asks again about a number that only timed out, and still moves the rest of the window on", async () => {
    const db = await fresh();
    const log = answeredLog();
    // seq 3 never answered: not a 404, so it is unknown rather than absent
    await runWindow(db, log, 6, (_n, i) => (i === 2 ? "timeout" : "hit"));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([1, 2, 4, 5, 6].map(no));

    // it comes back round at the head of the next window, which then carries on past covered ground
    expect(await windowNumbers(db, log, 4)).toEqual([3, 7, 8, 9].map(no));
    // one permanently unreachable number costs one slot per run, never the whole window
    await runWindow(db, log, 4, (n) => (n === no(3) ? "timeout" : "hit"));
    expect(await windowNumbers(db, log, 4)).toEqual([3, 10, 11, 12].map(no));
    await db.close();
  });

  it("re-offers a window whose run died before its merge committed", async () => {
    const db = await fresh();
    const log = answeredLog();
    const first = await windowNumbers(db, log, 4);
    // numbers fetched, nothing merged, nothing claimed: the run threw on the way to the merge
    expect(await windowNumbers(db, log, 4)).toEqual(first);
    expect(existsSync(log)).toBe(false);
    await db.close();
  });

  it("hands two consecutive completed runs disjoint, contiguous windows", async () => {
    const db = await fresh();
    const log = answeredLog();

    const first = await runWindow(db, log, 6, (_n, i) => (i % 2 === 0 ? "hit" : "notFound"));
    const second = await runWindow(db, log, 6, (_n, i) => (i % 2 === 0 ? "hit" : "notFound"));

    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    expect(first.filter((n) => second.includes(n))).toEqual([]);
    expect([...first, ...second]).toEqual(Array.from({ length: 12 }, (_x, i) => no(i + 1)));
    const pos = permitPosition(await coveredSequences(db.conn, { prefix: PREFIX, yy: YY, answeredLog: log }), START);
    expect(pos).toEqual({ covered: 12, highestCovered: 12, nextSeq: 13 });
    await db.close();
  });

  it("keeps each prefix and year on its own position", async () => {
    const db = await fresh();
    const log = answeredLog();
    for (let i = 1; i <= 9; i += 1) await heldPermit(db, permitNumber("B", 24, i));
    await heldPermit(db, permitNumber("R", 25, 40));
    for (let i = 1; i <= 3; i += 1) await heldPermit(db, no(i));
    claim(log, [permitNumber("B", 24, 500), permitNumber("R", 25, 41)]);

    // B-25 has three numbers of its own; the B-24 and R-25 evidence is not its ground
    expect(await windowNumbers(db, log, 3)).toEqual([4, 5, 6].map(no));
    const b24 = await coveredSequences(db.conn, { prefix: "B", yy: 24, answeredLog: log });
    expect(permitPosition(b24, START)).toEqual({ covered: 10, highestCovered: 500, nextSeq: 10 });
    await db.close();
  });

  it("counts a permit number once however many rows and claims it carries", async () => {
    const db = await fresh();
    const log = answeredLog();
    await heldPermit(db, no(1));
    // claimed twice: a run that re-read the number after an earlier run failed to merge it
    claim(log, [no(1)]);
    claim(log, [no(1)]);
    claim(log, ["", "   ", "not-a-permit"]);

    const covered = await coveredSequences(db.conn, { prefix: PREFIX, yy: YY, answeredLog: log });
    expect(covered).toEqual(new Set([1]));
    expect(await windowNumbers(db, log, 2)).toEqual([2, 3].map(no));
    await db.close();
  });

  it("never returns more than the window asked for", () => {
    expect(nextSequences(new Set(), 1, 3)).toEqual([1, 2, 3]);
    expect(nextSequences(new Set([1, 2, 3]), 1, 3)).toEqual([4, 5, 6]);
    expect(nextSequences(new Set([2]), 1, 3)).toEqual([1, 3, 4]);
    // a start below 1 is clamped rather than producing sequence 0 or a negative permit number
    expect(nextSequences(new Set(), 0, 2)).toEqual([1, 2]);
    expect(nextSequences(new Set(), 1, 0)).toEqual([1]);
  });
});

/** A run context pointed at throwaway directories and an in-memory database. */
function context(db: Db, dir: string): TrackContext {
  const paths: Paths = {
    dataDir: dir,
    dbPath: join(dir, "duval.duckdb"),
    artifactsDir: join(dir, "artifacts"),
    publishDir: join(dir, "artifacts", "publish", "duval"),
    runsDir: join(dir, "runs"),
  };
  return {
    conn: db.conn,
    runId: "run-constrained",
    paths,
    logger: createLogger({}, "error", () => undefined),
    window: "5",
    force: false,
    env: { PERMITS_START_SEQ: "1", PERMITS_YEAR: String(YY), PERMITS_PREFIX: PREFIX },
  };
}

describe("permits constrained (WAF-blocked) path", () => {
  it("stages zero permits, reports the block, keeps the permits it holds and claims nothing", async () => {
    const db = await fresh();
    const dir = join(tmp, `constrained-${(seq += 1)}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 3; i += 1) await heldPermit(db, no(i));

    // Akamai in front of JaxEPICS: every request, shell and API alike, answers 403 Access Denied
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("<html><body>Access Denied</body></html>", { status: 403, headers: { "content-type": "text/html" } });
    });

    const result = await runPermits(context(db, dir), SOURCES.permits);

    expect(result.status).toBe("completed");
    expect(result.rowsStaged).toBe(0);
    expect(result.notes.constrained).toBe(true);
    expect(result.notes.throughput).toEqual({ hits: 0, misses: 0, errors: 0, minutes: 0, permitsPerMin: 0 });
    expect(result.limitations.some((l) => l.includes("Akamai WAF") && l.includes("enumeration skipped"))).toBe(true);
    // the 403s are kept as evidence rather than swallowed
    expect(result.limitations.some((l) => l.includes("endpoint probe with") && l.includes("403"))).toBe(true);
    expect(seen.every((u) => u.includes("jaxepics"))).toBe(true);

    // an empty staging table speaks for no permit, so nothing already held is reported deleted
    expect(result.merge).toMatchObject({ staged: 0, inserted: 0, updated: 0, missingInSource: 0, totalAfter: 3 });
    expect(await scalar(db.conn, "SELECT count(*) FROM permits")).toBe("3");

    // nothing was enumerated, so nothing is claimed and no position is invented
    expect(existsSync(join(dir, "artifacts", "permits", ANSWERED_LOG))).toBe(false);
    expect(await getTrackState(db.conn, "permits", STATE_CURSOR)).toBeNull();
    expect(await all(db.conn, `SELECT count(*) AS n FROM track_state WHERE key = ${q(STATE_CURSOR)}`)).toEqual([{ n: "0" }]);

    // and the next run still starts where the table says, not where a counter says
    expect(await windowNumbers(db, join(dir, "artifacts", "permits", ANSWERED_LOG), 2)).toEqual([4, 5].map(no));
    await db.close();
  });
});

/**
 * The day the source becomes reachable. A stubbed JaxEPICS that answers the Angular shell, one
 * bundle carrying an api literal, and then per-number JSON / 404 / network error, so the whole
 * discover -> probe -> enumerate -> merge -> claim path runs against known outcomes.
 */
function stubJaxEpics(outcomes: Map<number, Outcome>, seen: string[]): void {
  const bundle = 'apiUrl:"https://jaxepicsapi.coj.net/",e.get(this.base+"api/Permit/View/"+n)';
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://jaxepics.coj.net/Permit/View/")) {
      return new Response('<html><body><script src="/main.js"></script></body></html>', { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url === "https://jaxepics.coj.net/main.js") {
      return new Response(bundle, { status: 200, headers: { "content-type": "application/javascript" } });
    }
    const parsed = parsePermitNumber(decodeURIComponent(url.split("/").pop() ?? ""));
    if (parsed === null) return new Response("not found", { status: 404 });
    const what = outcomes.get(parsed.seq) ?? "notFound";
    if (what === "timeout") throw new Error("The operation was aborted due to timeout");
    if (what === "notFound") return new Response("", { status: 404 });
    return new Response(
      JSON.stringify({ permitNumber: permitNumber(PREFIX, parsed.yy, parsed.seq), permitType: "Building", workType: "Residential Re-Roof", status: "Issued", re: "168871-2134", jobCost: 12500 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

/** The distinct permit numbers a run asked the API about, in first-asked order (retries collapse). */
function enumerated(seen: string[], known: string): string[] {
  const asked = seen
    .filter((u) => u.startsWith("https://jaxepicsapi.coj.net/"))
    .map((u) => decodeURIComponent(u.split("/").pop() ?? ""))
    .filter((n) => n !== known);
  return [...new Set(asked)];
}

describe("permits enumeration against a reachable source", () => {
  it("derives its window from the data, claims only definitive answers, and never rewinds on a cold cursor", async () => {
    const db = await fresh();
    const dir = join(tmp, `reachable-${(seq += 1)}`);
    mkdirSync(dir, { recursive: true });
    const known = no(900);
    const log = join(dir, "artifacts", "permits", ANSWERED_LOG);
    const ctx = context(db, dir);
    ctx.env.PERMITS_KNOWN = known;

    // run one: 1 and 2 exist, 3 times out, 4 and 5 are numbers the county never issued
    const firstSeen: string[] = [];
    stubJaxEpics(new Map<number, Outcome>([[900, "hit"], [1, "hit"], [2, "hit"], [3, "timeout"], [4, "notFound"], [5, "notFound"]]), firstSeen);
    const first = await runPermits(ctx, SOURCES.permits);

    expect(first.status).toBe("completed");
    expect(first.notes.constrained).toBeUndefined();
    expect(first.notes.window).toMatchObject({ prefix: PREFIX, yy: YY, startSeq: 1, endSeq: 5, requested: 5, selected: 5 });
    expect(enumerated(firstSeen, known)).toEqual([1, 2, 3, 4, 5].map(no));
    expect(first.merge).toMatchObject({ staged: 2, inserted: 2, missingInSource: 0 });
    expect(await all(db.conn, "SELECT permit_no FROM permits ORDER BY permit_no")).toEqual([{ permit_no: no(1) }, { permit_no: no(2) }]);
    // the two 404s are claimed, the timeout is not
    expect(claimed(log)).toEqual([1, 2, 4, 5].map(no));
    expect(first.notes.cursorEnd).toBe(5);
    expect(first.notes.nextPermitNo).toBe(no(3));

    // the cache is lost between runs and the counter rewinds; the table and the claim log do not
    await db.conn.run(`UPDATE track_state SET value = '0' WHERE key = ${q(STATE_CURSOR)}`);

    // run two: the timed-out number comes back round, the answered ones do not
    const secondSeen: string[] = [];
    stubJaxEpics(new Map<number, Outcome>([[900, "hit"], [3, "hit"], [7, "hit"]]), secondSeen);
    const second = await runPermits(ctx, SOURCES.permits);

    expect(second.notes.window).toMatchObject({ startSeq: 3, endSeq: 9, selected: 5 });
    expect(enumerated(secondSeen, known)).toEqual([3, 6, 7, 8, 9].map(no));
    // nothing already held is re-walked, and nothing already held is reported deleted at source
    expect(second.merge).toMatchObject({ staged: 2, inserted: 2, missingInSource: 0, totalAfter: 4 });
    expect(await scalar(db.conn, "SELECT count(*) FROM permits")).toBe("4");
    expect(claimed(log)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(no).sort());
    expect(second.notes.cursorEnd).toBe(9);
    expect(second.notes.nextPermitNo).toBe(no(10));
    await db.close();
  });
});
