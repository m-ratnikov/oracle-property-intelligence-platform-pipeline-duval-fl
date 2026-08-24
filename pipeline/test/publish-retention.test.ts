import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { DEFAULT_RETENTION_DAYS, executePublish, OBJECT_KEYS, selectExpiredVersions, VERSIONED_PREFIX } from "../src/publish/index.js";

/**
 * Why a publish must never overwrite the object a client is reading.
 *
 * On 2026-08-25 the hosted UI and the MCP both answered 504 for every query. Both were bound, by
 * design, to the immutable /ipfs/<cid> URL of the query table published on 2026-08-22; the cron
 * had published eleven more times since, each one PUT to the same bucket key, and on Filebase
 * replacing an object unpins the CID it had. The artifact those two deployments were reading had
 * been garbage collected days earlier. These tests pin the two halves of the fix on the storage
 * side: a CID-pinned artifact is stored under a key that includes its CID, and retention removes
 * only what is both older than the window and not referenced by the publish that runs it.
 */

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "duval-retention-"));
  const publishDir = join(dir, "artifacts", "publish", "duval");
  mkdirSync(join(publishDir, "tables"), { recursive: true });
  writeFileSync(join(publishDir, "query-table.parquet"), Buffer.from("PAR1-fixture-query-table"));
  writeFileSync(join(publishDir, "dataset-coverage.json"), JSON.stringify({ county: "duval", datasets: [] }));
  writeFileSync(join(publishDir, "tables", "parcels.parquet"), Buffer.from("PAR1-fixture-parcels"));
  return { dataDir: dir, dbPath: join(dir, "duval.duckdb"), artifactsDir: join(dir, "artifacts"), publishDir } as Paths;
}

const ENV = {
  FILEBASE_ACCESS_KEY: "test-access",
  FILEBASE_SECRET_KEY: "test-secret",
  FILEBASE_BUCKET_DUVAL: "test-bucket",
} as NodeJS.ProcessEnv;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00Z");

/** An S3 stub that records PUTs and DELETEs and answers ListObjectsV2 from a fixture. */
function stubClient(stored: { key: string; lastModified: Date }[]) {
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    client: {
      send: async (cmd: { constructor: { name: string }; input?: { Key?: string; Prefix?: string } }) => {
        const kind = cmd.constructor.name;
        if (kind === "PutObjectCommand") {
          puts.push(cmd.input?.Key ?? "<no key>");
          return {};
        }
        if (kind === "ListObjectsV2Command") {
          return {
            Contents: stored.filter((o) => o.key.startsWith(cmd.input?.Prefix ?? "")).map((o) => ({ Key: o.key, LastModified: o.lastModified })),
            IsTruncated: false,
          };
        }
        if (kind === "DeleteObjectCommand") {
          deletes.push(cmd.input?.Key ?? "<no key>");
          return {};
        }
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    },
  };
}

/** A Names API that mints every name and reads back consistently. */
function namesApi() {
  const names: { label: string; network_key: string; cid: string }[] = [];
  return (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const href = String(url);
    if (!href.includes("/v1/names")) return new Response("{}", { status: 200 });
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(names), { status: 200 });
    if (method === "POST") {
      const { label, cid } = JSON.parse(init?.body ?? "{}") as { label: string; cid: string };
      names.push({ label, network_key: `k51-${label}`, cid });
      return new Response("{}", { status: 200 });
    }
    if (method === "PUT") {
      const label = decodeURIComponent(href.split("/").pop() ?? "");
      const { cid } = JSON.parse(init?.body ?? "{}") as { cid: string };
      const found = names.find((n) => n.label === label);
      if (found) found.cid = cid;
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

const log = createLogger({ service: "test" });

describe("selectExpiredVersions", () => {
  it("removes only versioned objects that are both older than the window and not current", () => {
    const keep = new Set([`${VERSIONED_PREFIX}bafy-new/query-tables/duval/query-table.parquet`]);
    const objects = [
      // current publish, ancient timestamp: protected regardless of age
      { key: `${VERSIONED_PREFIX}bafy-new/query-tables/duval/query-table.parquet`, lastModified: new Date(NOW.getTime() - 30 * DAY) },
      // superseded, still inside the window: kept so a client holding its CID keeps resolving
      { key: `${VERSIONED_PREFIX}bafy-yesterday/query-tables/duval/query-table.parquet`, lastModified: new Date(NOW.getTime() - 1 * DAY) },
      // superseded and past the window: pruned
      { key: `${VERSIONED_PREFIX}bafy-old/query-tables/duval/query-table.parquet`, lastModified: new Date(NOW.getTime() - 4 * DAY) },
      // never versioned: not this function's business even when old
      { key: "tables/duval/parcels.parquet", lastModified: new Date(NOW.getTime() - 40 * DAY) },
      // no timestamp: cannot prove it is old, so it stays
      { key: `${VERSIONED_PREFIX}bafy-undated/query-tables/duval/query-table.parquet`, lastModified: null },
    ];
    expect(selectExpiredVersions(objects, keep, NOW, DEFAULT_RETENTION_DAYS)).toEqual([
      `${VERSIONED_PREFIX}bafy-old/query-tables/duval/query-table.parquet`,
    ]);
  });

  it("with a zero day window prunes everything superseded and nothing current", () => {
    const keep = new Set(["versions/a/x"]);
    const objects = [
      { key: "versions/a/x", lastModified: new Date(NOW.getTime() - DAY) },
      { key: "versions/b/x", lastModified: new Date(NOW.getTime() - 1) },
    ];
    expect(selectExpiredVersions(objects, keep, NOW, 0)).toEqual(["versions/b/x"]);
  });
});

describe("publish: CID-pinned artifacts never overwrite a previous publish", () => {
  it("stores the query table, coverage and run history under keys that carry their own CID", async () => {
    const paths = makePaths();
    const { client, puts } = stubClient([]);
    const m = await executePublish({ paths, env: ENV, publish: true, logger: log, fetchImpl: namesApi(), clientFactory: () => client as never, now: NOW });

    const qt = m.objects.find((o) => o.name === "query-table.parquet");
    const cov = m.objects.find((o) => o.name === "dataset-coverage.json");
    const table = m.objects.find((o) => o.name === "tables/parcels.parquet");
    expect(qt?.key).toBe(OBJECT_KEYS.versioned(OBJECT_KEYS.queryTable, qt?.cidV1 ?? ""));
    expect(cov?.key).toBe(OBJECT_KEYS.versioned(OBJECT_KEYS.coverage, cov?.cidV1 ?? ""));
    // nothing pins an entity table by CID across publishes, so it keeps its stable key
    expect(table?.key).toBe(OBJECT_KEYS.tables("parcels.parquet"));
    expect(puts).toContain(qt?.key);
    // and a second publish of different content cannot land on the same key
    expect(qt?.key).toContain(qt?.cidV1);
    expect(qt?.key.startsWith(VERSIONED_PREFIX)).toBe(true);
  });

  it("prunes superseded versions past the window, protects the current ones, and reports it", async () => {
    const paths = makePaths();
    const stale = `${VERSIONED_PREFIX}bafy-stale/query-tables/duval/query-table.parquet`;
    const recent = `${VERSIONED_PREFIX}bafy-recent/query-tables/duval/query-table.parquet`;
    const { client, deletes } = stubClient([
      { key: stale, lastModified: new Date(NOW.getTime() - 10 * DAY) },
      { key: recent, lastModified: new Date(NOW.getTime() - DAY) },
    ]);
    const m = await executePublish({ paths, env: ENV, publish: true, logger: log, fetchImpl: namesApi(), clientFactory: () => client as never, now: NOW });

    expect(deletes).toEqual([stale]);
    expect(m.retention.pruned).toEqual([stale]);
    expect(m.retention.skipped).toBeNull();
    expect(m.retention.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    const qt = m.objects.find((o) => o.name === "query-table.parquet");
    expect(m.retention.current).toContain(qt?.key);
    expect(m.mode).toBe("published");
  });

  it("honours PUBLISH_RETENTION_DAYS and never fails the publish when the prune cannot run", async () => {
    const paths = makePaths();
    const failing = {
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") throw new Error("listing forbidden");
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    };
    const m = await executePublish({
      paths,
      env: { ...ENV, PUBLISH_RETENTION_DAYS: "7" } as NodeJS.ProcessEnv,
      publish: true,
      logger: log,
      fetchImpl: namesApi(),
      clientFactory: () => failing as never,
      now: NOW,
    });
    expect(m.mode).toBe("published");
    expect(m.ok).toBe(true);
    expect(m.retention.retentionDays).toBe(7);
    expect(m.retention.skipped).toContain("listing failed");
    expect(m.retention.pruned).toEqual([]);
  });

  it("does not list or delete anything on a dry run", async () => {
    const paths = makePaths();
    const m = await executePublish({ paths, env: {} as NodeJS.ProcessEnv, publish: false, logger: log, now: NOW });
    expect(m.mode).toBe("dry-run");
    expect(m.retention.skipped).toBe("dry run");
    // the plan still shows the versioned key, so a dry run previews exactly what a publish writes
    const qt = m.objects.find((o) => o.name === "query-table.parquet");
    expect(qt?.key.startsWith(VERSIONED_PREFIX)).toBe(true);
  });
});
