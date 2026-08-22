import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { computeFileCid } from "../src/publish/cid.js";
import { executePublish, IPNS_LABELS } from "../src/publish/index.js";
import {
  assertRunHistoryDescribesQueryTable,
  findRunForQueryTable,
  mergePublishedRunHistory,
  mergeRunHistories,
  parsePublishedRunHistory,
  type RunHistoryDoc,
  type RunHistoryEntry,
} from "../src/publish/runHistory.js";

/**
 * The regression these pin: GitHub Actions caches are branch scoped, so the 6-hourly cron on the
 * default branch runs against a different `.data` cache lineage than the feature-branch dispatches.
 * Run 32513420281 therefore started from an empty DuckDB, re-ingested every source as a first load
 * and republished run-history.json with the 3 runs its own database knew about, over the 29 that
 * were live at the same IPNS name. The page whose whole claim is continuous incremental ingestion
 * was one cron tick from showing a single bulk load.
 *
 * run-history.json is the only cumulative artifact, so publishing it is now a union with whatever is
 * already published, keyed on run_id. These tests hold the union honest and hold every read failure
 * to the same floor: publish exactly what this database knows, never nothing, never fail the run.
 */

const COUNTY = "duval";
const GATEWAY = "https://ipfs.filebase.io";
const RUN_HISTORY_KEY = "runs/duval/run-history.json";
const NETWORK_KEY = "k51qzi5uqu5dl3zmapadjh90auy4k6gtr6w52zg6ozeu64kzbiwwgw8k9ef6ny";
const PUBLISHED_URL = `${GATEWAY}/ipns/${NETWORK_KEY}`;

const log = createLogger({ service: "test" }, "error");

function run(id: string, startedAt: string, extra: Record<string, unknown> = {}): RunHistoryEntry {
  return {
    run_id: id,
    county: COUNTY,
    started_at: startedAt,
    finished_at: startedAt,
    status: "ok",
    trigger: "schedule",
    tracks: [],
    sources: [],
    limitations: [],
    totals: {},
    artifacts: {},
    error: null,
    ...extra,
  };
}

function doc(runs: RunHistoryEntry[]): RunHistoryDoc {
  return { county: COUNTY, generatedAt: "2026-08-21T18:54:05.399Z", runCount: runs.length, runs };
}

/** Serialized like the pipeline writes it, so the parser is exercised on the real shape. */
function publishedBody(runs: RunHistoryEntry[], county: string = COUNTY): string {
  return JSON.stringify({ county, generatedAt: "2026-08-21T17:50:00.000Z", runCount: runs.length, runs }, null, 2);
}

/** 29 runs, oldest first in the source array so the sort has something to do. */
function branchLineage(): RunHistoryEntry[] {
  return Array.from({ length: 29 }, (_v, i) =>
    run(`01M0BRANCH${String(i).padStart(4, "0")}`, `2026-08-${String(10 + Math.floor(i / 6)).padStart(2, "0")}T0${i % 6}:00:00.000Z`),
  );
}

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "duval-run-history-"));
  const publishDir = join(dir, "artifacts", "publish", COUNTY);
  mkdirSync(publishDir, { recursive: true });
  return { dataDir: dir, dbPath: join(dir, "duval.duckdb"), artifactsDir: join(dir, "artifacts"), publishDir } as Paths;
}

function writeLocal(paths: Paths, runs: RunHistoryEntry[]): string {
  const file = join(paths.publishDir, "run-history.json");
  writeFileSync(file, JSON.stringify(doc(runs), null, 2));
  return file;
}

/**
 * Write the fixture parquet and hand back the artifact block a real run record carries for it.
 *
 * The publish refuses to ship a history in which no run records the parquet being uploaded, which
 * is the whole point of that gate: the document and the data have to describe the same run. So the
 * fixture states the identity the same way the pipeline does, by content hash rather than by
 * agreement between two literals.
 */
async function writeQueryTable(paths: Paths): Promise<Record<string, unknown>> {
  const file = join(paths.publishDir, "query-table.parquet");
  writeFileSync(file, Buffer.from("PAR1-fixture-query-table"));
  const cid = await computeFileCid(file);
  return { queryTable: { path: "query-table.parquet", rows: 404_023, cid: cid.cid, cidV1: cid.cidV1 } };
}

type StubResponse = { ok: boolean; status: number; statusText: string; text(): Promise<string>; json(): Promise<unknown> };

function respond(status: number, body: string): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

/**
 * Names API + gateway in one stub. `gateway` decides what the published copy read returns; the Names
 * API always reports the run-history label unless `names` is overridden, because that is the state
 * every publish after the first one is in.
 */
function stubFetch(opts: {
  gateway?: (url: string, init?: { signal?: AbortSignal }) => Promise<StubResponse>;
  names?: { label: string; network_key: string; cid: string }[];
  namesStatus?: number;
}) {
  const names = opts.names ?? [{ label: IPNS_LABELS.runHistory, network_key: NETWORK_KEY, cid: "QmPublished" }];
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/v1/names")) {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        if (opts.namesStatus !== undefined && opts.namesStatus !== 200) return respond(opts.namesStatus, "nope");
        return respond(200, JSON.stringify(names));
      }
      if (method === "POST") {
        const { label, cid } = JSON.parse(init?.body ?? "{}") as { label: string; cid: string };
        names.push({ label, network_key: `k51-${label}`, cid });
        return respond(200, "{}");
      }
      const label = decodeURIComponent(href.split("/").pop() ?? "");
      const { cid } = JSON.parse(init?.body ?? "{}") as { cid: string };
      const found = names.find((n) => n.label === label);
      if (found) found.cid = cid;
      return respond(200, "{}");
    }
    if (opts.gateway) return opts.gateway(href, init);
    return respond(404, "not found");
  };
  return { fetchImpl, calls, names };
}

describe("run history merge: the union itself", () => {
  it("unions disjoint run sets and orders them newest first", () => {
    const local = doc([run("B", "2026-08-21T12:00:00.000Z")]);
    const published = [run("A", "2026-08-20T12:00:00.000Z"), run("C", "2026-08-22T12:00:00.000Z")];
    const merged = mergeRunHistories(local, published);
    expect(merged.runs.map((r) => r.run_id)).toEqual(["C", "B", "A"]);
    expect(merged.runCount).toBe(3);
    expect(merged.county).toBe(COUNTY);
    expect(merged.generatedAt).toBe("2026-08-21T18:54:05.399Z");
  });

  it("prefers this database's record when a run_id is in both copies", () => {
    const local = doc([run("SHARED", "2026-08-21T12:00:00.000Z", { status: "ok", git_sha: "local" })]);
    const published = [run("SHARED", "2026-08-21T12:00:00.000Z", { status: "aborted", git_sha: "published" })];
    const merged = mergeRunHistories(local, published);
    expect(merged.runs).toHaveLength(1);
    expect(merged.runs[0]?.status).toBe("ok");
    expect(merged.runs[0]?.git_sha).toBe("local");
  });

  it("merges on run_id alone, never on how alike two runs look", () => {
    // Same timestamps, same trigger, same everything except the id: two runs, not one.
    const local = doc([run("ID-1", "2026-08-21T12:00:00.000Z")]);
    const published = [run("ID-2", "2026-08-21T12:00:00.000Z")];
    expect(mergeRunHistories(local, published).runs).toHaveLength(2);
  });

  it("keeps a run with no started_at instead of dropping it, sorted to the end", () => {
    const local = doc([run("NEW", "2026-08-21T12:00:00.000Z"), { run_id: "NO-STAMP" }]);
    const merged = mergeRunHistories(local, [run("OLD", "2026-08-01T12:00:00.000Z")]);
    expect(merged.runs.map((r) => r.run_id)).toEqual(["NEW", "OLD", "NO-STAMP"]);
  });

  it("is a superset of the published copy: 3 local runs never replace 29 published ones", () => {
    const published = branchLineage();
    const local = doc([
      run("01M0J9VD2ACF", "2026-08-21T13:58:30.000Z"),
      run("01M0JS84VW9D", "2026-08-21T18:27:36.000Z"),
      run("01M0JTM334XR", "2026-08-21T18:51:36.000Z"),
    ]);
    const merged = mergeRunHistories(local, published);
    expect(merged.runs.length).toBe(32);
    expect(merged.runs.length).toBeGreaterThanOrEqual(published.length);
    for (const p of published) expect(merged.runs.some((r) => r.run_id === p.run_id)).toBe(true);
  });
});

describe("run history merge: reading the published copy", () => {
  it("takes the runs out of a well-formed same-county document", () => {
    const parsed = parsePublishedRunHistory(publishedBody(branchLineage()), COUNTY);
    expect(parsed.outcome).toBe("merged");
    expect(parsed.runs).toHaveLength(29);
  });

  it("degrades on malformed JSON", () => {
    const parsed = parsePublishedRunHistory('{"county":"duval","runs":[', COUNTY);
    expect(parsed.outcome).toBe("published_malformed");
    expect(parsed.runs).toEqual([]);
  });

  it("degrades when the top level is not an object", () => {
    expect(parsePublishedRunHistory("[]", COUNTY).outcome).toBe("published_malformed");
  });

  it("degrades when runs is not an array", () => {
    expect(parsePublishedRunHistory('{"county":"duval","runs":{}}', COUNTY).outcome).toBe("published_malformed");
  });

  it("reports an empty runs array as empty, not as an error", () => {
    const parsed = parsePublishedRunHistory(publishedBody([]), COUNTY);
    expect(parsed.outcome).toBe("published_empty");
    expect(parsed.runs).toEqual([]);
  });

  it("refuses a document published for another county", () => {
    const parsed = parsePublishedRunHistory(publishedBody(branchLineage(), "alachua"), COUNTY);
    expect(parsed.outcome).toBe("published_other_county");
    expect(parsed.runs).toEqual([]);
  });

  it("drops published runs with no run_id but keeps the rest", () => {
    const body = publishedBody([run("KEEP", "2026-08-21T12:00:00.000Z"), { run_id: "" } as RunHistoryEntry]);
    const parsed = parsePublishedRunHistory(body, COUNTY);
    expect(parsed.outcome).toBe("merged");
    expect(parsed.runs.map((r) => r.run_id)).toEqual(["KEEP"]);
    expect(parsed.detail).toContain("1 published run(s) had no run_id");
  });
});

describe("run history merge: every degradation publishes what this database knows", () => {
  it("merges and rewrites the file when the published copy is readable", async () => {
    const paths = makePaths();
    const file = writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody(branchLineage())) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("merged");
    expect(result.localRuns).toBe(1);
    expect(result.publishedRuns).toBe(29);
    expect(result.mergedRuns).toBe(30);
    expect(result.url).toBe(PUBLISHED_URL);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as RunHistoryDoc;
    expect(onDisk.runs).toHaveLength(30);
    expect(onDisk.runCount).toBe(30);
    expect(onDisk.runs[0]?.run_id).toBe("LOCAL");
  });

  it("publishes the local copy unchanged when the IPNS name does not exist yet", async () => {
    const paths = makePaths();
    const file = writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ names: [] });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_absent");
    expect(result.mergedRuns).toBe(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as RunHistoryDoc).runs).toHaveLength(1);
  });

  it("publishes the local copy unchanged when the Names API cannot be read", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ namesStatus: 500 });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_absent");
    expect(result.mergedRuns).toBe(1);
  });

  it("publishes the local copy unchanged when the gateway is unreachable", async () => {
    const paths = makePaths();
    const file = writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({
      gateway: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_unreachable");
    expect(result.detail).toContain("ECONNREFUSED");
    expect(result.mergedRuns).toBe(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as RunHistoryDoc).runs).toHaveLength(1);
  });

  it("publishes the local copy unchanged when the gateway answers non-2xx", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ gateway: async () => respond(504, "gateway timeout") });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_unreachable");
    expect(result.detail).toContain("504");
    expect(result.mergedRuns).toBe(1);
  });

  it("publishes the local copy unchanged when the gateway is too slow, and does not hang the run", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({
      gateway: (_url, init) =>
        new Promise<StubResponse>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
        }),
    });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
      timeoutMs: 25,
    });
    expect(result.outcome).toBe("published_unreachable");
    expect(result.detail).toContain("aborted");
    expect(result.mergedRuns).toBe(1);
  });

  it("publishes the local copy unchanged when the published copy is malformed", async () => {
    const paths = makePaths();
    const file = writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, "<html>gateway error page</html>") });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_malformed");
    expect(result.mergedRuns).toBe(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as RunHistoryDoc).runs).toHaveLength(1);
  });

  it("publishes the local copy unchanged when the published copy has an empty runs array", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody([])) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_empty");
    expect(result.mergedRuns).toBe(1);
  });

  it("publishes the local copy unchanged when the published copy belongs to another county", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody(branchLineage(), "alachua")) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("published_other_county");
    expect(result.mergedRuns).toBe(1);
  });

  it("does not read the network at all in a dry run", async () => {
    const paths = makePaths();
    writeLocal(paths, [run("LOCAL", "2026-08-21T18:51:36.000Z")]);
    const { fetchImpl, calls } = stubFetch({ gateway: async () => respond(200, publishedBody(branchLineage())) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: null, fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("not_attempted");
    expect(result.mergedRuns).toBe(1);
    expect(calls).toEqual([]);
  });

  it("does nothing when this run produced no run-history.json", async () => {
    const paths = makePaths();
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody(branchLineage())) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("not_attempted");
    expect(result.mergedRuns).toBe(0);
  });

  it("publishes what it can when the LOCAL run-history.json is unreadable", async () => {
    const paths = makePaths();
    writeFileSync(join(paths.publishDir, "run-history.json"), "{ not json");
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody(branchLineage())) });
    const result = await mergePublishedRunHistory({
      paths, county: COUNTY, gateway: GATEWAY, ipnsLabel: IPNS_LABELS.runHistory, token: "t", fetchImpl, logger: log,
    });
    expect(result.outcome).toBe("not_attempted");
    expect(readFileSync(join(paths.publishDir, "run-history.json"), "utf8")).toBe("{ not json");
  });
});

describe("publish: the cold-cache run cannot shrink the published history", () => {
  it("uploads 29 published runs plus the 3 a cold database knows, not 3", async () => {
    const paths = makePaths();
    const artifacts = await writeQueryTable(paths);
    writeFileSync(join(paths.publishDir, "dataset-coverage.json"), JSON.stringify({ county: COUNTY, datasets: [] }));
    // Exactly the shape of Actions run 32513420281: a cold DuckDB that knows only its own three runs,
    // one of which (the consolidation pass) is already in the published copy.
    const published = branchLineage();
    const shared = published[published.length - 1];
    if (shared === undefined) throw new Error("fixture");
    const local = [
      run("01M0J9VD2ACF", "2026-08-21T13:58:30.000Z"),
      run("01M0JS84VW9D", "2026-08-21T18:27:36.000Z", { totals: { inserted: 1_412_096 }, artifacts }),
      { ...shared, status: "ok", git_sha: "repaired-by-the-cold-run" },
    ];
    writeLocal(paths, local);

    const uploaded = new Map<string, Buffer>();
    const client = {
      send: async (cmd: { input?: { Key?: string; Body?: Buffer } }) => {
        if (cmd.input?.Key !== undefined && cmd.input.Body !== undefined) uploaded.set(cmd.input.Key, cmd.input.Body);
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    };
    const { fetchImpl } = stubFetch({ gateway: async () => respond(200, publishedBody(published)) });

    const manifest = await executePublish({
      paths,
      env: {
        FILEBASE_ACCESS_KEY: "test-access",
        FILEBASE_SECRET_KEY: "test-secret",
        FILEBASE_BUCKET_DUVAL: "test-bucket",
      } as NodeJS.ProcessEnv,
      publish: true,
      logger: log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: () => client as never,
    });

    // Assert the BYTES that went to the bucket before anything about the manifest: this is the
    // regression, and before the merge existed this line read 3.
    const body = uploaded.get(RUN_HISTORY_KEY);
    expect(body).toBeDefined();
    const shipped = JSON.parse((body as Buffer).toString("utf8")) as RunHistoryDoc;
    expect(shipped.runs).toHaveLength(31);
    expect(shipped.runCount).toBe(31);

    expect(manifest.runHistory.outcome).toBe("merged");
    expect(manifest.runHistory.localRuns).toBe(3);
    expect(manifest.runHistory.publishedRuns).toBe(29);
    expect(manifest.runHistory.mergedRuns).toBe(31);
    // The shape the UI parses is untouched.
    expect(Object.keys(shipped).sort()).toEqual(["county", "generatedAt", "runCount", "runs"]);
    expect(shipped.county).toBe(COUNTY);
    // Every run the branch lineage had published is still there, and the overlapping one is the
    // cold database's copy.
    for (const p of published) expect(shipped.runs.some((r) => r.run_id === p.run_id)).toBe(true);
    expect(shipped.runs.find((r) => r.run_id === shared.run_id)?.git_sha).toBe("repaired-by-the-cold-run");
    // Newest first, so the runs page opens on the most recent run.
    expect(shipped.runs[0]?.run_id).toBe("01M0JS84VW9D");
  });

  it("still publishes the cold run's own history when the gateway is down", async () => {
    const paths = makePaths();
    const artifacts = await writeQueryTable(paths);
    writeLocal(paths, [run("01M0JS84VW9D", "2026-08-21T18:27:36.000Z", { artifacts })]);
    const uploaded = new Map<string, Buffer>();
    const client = {
      send: async (cmd: { input?: { Key?: string; Body?: Buffer } }) => {
        if (cmd.input?.Key !== undefined && cmd.input.Body !== undefined) uploaded.set(cmd.input.Key, cmd.input.Body);
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    };
    const { fetchImpl } = stubFetch({
      gateway: async () => {
        throw new Error("ENOTFOUND ipfs.filebase.io");
      },
    });
    const manifest = await executePublish({
      paths,
      env: {
        FILEBASE_ACCESS_KEY: "test-access",
        FILEBASE_SECRET_KEY: "test-secret",
        FILEBASE_BUCKET_DUVAL: "test-bucket",
      } as NodeJS.ProcessEnv,
      publish: true,
      logger: log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clientFactory: () => client as never,
    });
    expect(manifest.mode).toBe("published");
    const shipped = JSON.parse((uploaded.get(RUN_HISTORY_KEY) as Buffer).toString("utf8")) as RunHistoryDoc;
    expect(shipped.runs).toHaveLength(1);
    expect(manifest.runHistory.outcome).toBe("published_unreachable");
  });
});


/**
 * The second half of the same promise. The merge stops the published history from SHRINKING; this
 * stops it from being one run behind the data beside it.
 *
 * The runs page is the evidence that ingestion is continuous, and the reader arrives there from a
 * page rendered out of query-table.parquet. If the history published next to that parquet does not
 * contain the run that built it, the page shows a run list that stops just short of the data the
 * reader is looking at, every single time. The identity is checked by content hash, not by
 * ordering: the run record carries the CID of the query table it exported, and the publisher
 * computes the CID of the file it is about to upload.
 */
describe("publish: the history has to describe the data published with it", () => {
  const withQueryTable = (id: string, cid: string, cidV1: string): RunHistoryEntry =>
    run(id, "2026-08-21T23:43:16.590Z", { artifacts: { queryTable: { path: "query-table.parquet", cid, cidV1 } } });

  it("finds the run that exported this parquet, by v0 or by v1 CID", () => {
    const runs = [run("OTHER", "2026-08-21T12:00:00.000Z"), withQueryTable("MINE", "QmV7vi", "bafybeidex")];
    expect(findRunForQueryTable(runs, "QmV7vi", "bafyOTHER")?.run_id).toBe("MINE");
    expect(findRunForQueryTable(runs, "QmOTHER", "bafybeidex")?.run_id).toBe("MINE");
    expect(findRunForQueryTable(runs, "QmNOBODY", "bafyNOBODY")).toBeNull();
  });

  it("ignores a run whose artifacts block is missing or the wrong shape", () => {
    const runs = [run("NO-ARTIFACTS", "2026-08-21T12:00:00.000Z"), run("STRING", "2026-08-21T12:00:00.000Z", { artifacts: "queryTable" })];
    expect(findRunForQueryTable(runs, "QmV7vi", "bafybeidex")).toBeNull();
  });

  it("names the run that produced the parquet, so the manifest can be read as provenance", async () => {
    const paths = makePaths();
    const artifacts = await writeQueryTable(paths);
    const qt = (artifacts.queryTable as { cid: string; cidV1: string });
    writeLocal(paths, [run("01M0KBA53DPMHRGXV66NQ0GRY5", "2026-08-21T23:43:16.590Z", { artifacts })]);

    const provenance = assertRunHistoryDescribesQueryTable({ paths, cid: qt.cid, cidV1: qt.cidV1, logger: log });
    expect(provenance).toMatchObject({ runId: "01M0KBA53DPMHRGXV66NQ0GRY5", cid: qt.cid, historyRuns: 1 });
  });

  it("makes no claim when there is no history to publish at all", async () => {
    const paths = makePaths();
    const qt = (await writeQueryTable(paths)).queryTable as { cid: string; cidV1: string };
    expect(assertRunHistoryDescribesQueryTable({ paths, cid: qt.cid, cidV1: qt.cidV1, logger: log })).toBeNull();
  });

  it("refuses a history that describes a different parquet, and uploads nothing at all", async () => {
    const paths = makePaths();
    await writeQueryTable(paths);
    writeFileSync(join(paths.publishDir, "dataset-coverage.json"), JSON.stringify({ county: COUNTY, datasets: [] }));
    // The exact shape of the defect: the newest run record was written AFTER the publish read the
    // history, so the document carries only the previous run and its previous parquet.
    writeLocal(paths, [withQueryTable("01M0K3MMVXPFKM5JBHADMFRDNJ", "QmTheRunBefore", "bafybeiTheRunBefore")]);

    const uploaded: string[] = [];
    const client = {
      send: async (cmd: { input?: { Key?: string } }) => {
        if (cmd.input?.Key !== undefined) uploaded.push(cmd.input.Key);
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    };
    const { fetchImpl } = stubFetch({ gateway: async () => respond(404, "not found") });

    await expect(
      executePublish({
        paths,
        env: { FILEBASE_ACCESS_KEY: "test-access", FILEBASE_SECRET_KEY: "test-secret", FILEBASE_BUCKET_DUVAL: "test-bucket" } as NodeJS.ProcessEnv,
        publish: true,
        logger: log,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        clientFactory: () => client as never,
      }),
    ).rejects.toThrow(/none of them records query-table.parquet/);

    // The gate runs before the first PUT, so there is no state in which the bucket holds this
    // publish's parquet next to a history that does not mention it. The artifacts already live
    // stay live, and stay consistent with each other.
    expect(uploaded).toEqual([]);
  });

  it("refuses rather than guesses when the local history cannot be read", async () => {
    const paths = makePaths();
    const qt = (await writeQueryTable(paths)).queryTable as { cid: string; cidV1: string };
    writeFileSync(join(paths.publishDir, "run-history.json"), "{ not json");
    expect(() => assertRunHistoryDescribesQueryTable({ paths, cid: qt.cid, cidV1: qt.cidV1, logger: log })).toThrow(
      /could not be read/,
    );
  });
});
