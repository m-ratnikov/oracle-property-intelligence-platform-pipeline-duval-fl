import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { executePublish, IPNS_LABELS } from "../src/publish/index.js";

/**
 * IPNS names are metered by the storage provider (the Filebase free plan allows exactly one per
 * account). Publishing hundreds of megabytes and then losing the run to a refused name would be a
 * bad trade: every artifact is content-addressed, so a missing mutable pointer costs convenience,
 * not reachability. These tests pin that behaviour.
 */

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "duval-publish-"));
  const publishDir = join(dir, "artifacts", "publish", "duval");
  mkdirSync(publishDir, { recursive: true });
  // Real parquet bytes are irrelevant here; the CID is computed over whatever is on disk.
  writeFileSync(join(publishDir, "query-table.parquet"), Buffer.from("PAR1-fixture-query-table"));
  writeFileSync(join(publishDir, "dataset-coverage.json"), JSON.stringify({ county: "duval", datasets: [] }));
  return {
    dataDir: dir,
    dbPath: join(dir, "duval.duckdb"),
    artifactsDir: join(dir, "artifacts"),
    publishDir,
  } as Paths;
}

const ENV = {
  FILEBASE_ACCESS_KEY: "test-access",
  FILEBASE_SECRET_KEY: "test-secret",
  FILEBASE_BUCKET_DUVAL: "test-bucket",
} as NodeJS.ProcessEnv;

/** An S3 client that accepts every PUT and reports no CID header (Filebase sets it; the stub need not). */
function stubClient() {
  const puts: string[] = [];
  return {
    puts,
    client: {
      send: async (cmd: { input?: { Key?: string } }) => {
        puts.push(cmd.input?.Key ?? "<no key>");
        return {};
      },
      middlewareStack: { add: () => undefined, remove: () => undefined },
    },
  };
}

const log = createLogger({ service: "test" });

describe("publish: IPNS pointing is best-effort", () => {
  it("keeps publishing when the account cannot mint a second IPNS name, and records the failure", async () => {
    const paths = makePaths();
    const { client, puts } = stubClient();
    // A faithful stand-in for the Names API on a plan that allows exactly one name: the first create
    // succeeds, every later create is refused. Re-pointing an existing name stays allowed.
    const names: { label: string; network_key: string; cid: string }[] = [];
    const NAME_CAP = 1;
    const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string }) => {
      const href = String(url);
      if (!href.includes("/v1/names")) return new Response("{}", { status: 200 });
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify(names), { status: 200 });
      if (method === "POST") {
        if (names.length >= NAME_CAP) {
          return new Response("plan limit reached: 1 IPNS name", { status: 402, statusText: "Payment Required" });
        }
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
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const manifest = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => client as never,
    });

    expect(manifest.mode).toBe("published");
    // the publish completed: query table, coverage, catalog and artifacts index all reached the bucket
    expect(puts.length).toBeGreaterThanOrEqual(4);
    // the one name the account allows went to the query table, the artifact the MCP follows across runs
    expect(names.map((n) => n.label)).toEqual([IPNS_LABELS.queryTable]);
    expect(manifest.ipns[IPNS_LABELS.queryTable]?.networkKey).toBe(`k51-${IPNS_LABELS.queryTable}`);
    // every OTHER label was refused and is reported rather than swallowed. Asserted as a property
    // rather than a fixed list, so adding a name later does not need this test rewritten.
    const labelled = manifest.objects.filter((o) => o.ipnsLabel !== null).map((o) => o.ipnsLabel);
    expect(labelled.length).toBeGreaterThan(1);
    expect(manifest.ipnsFailures.map((f) => f.label).sort()).toEqual(
      labelled.filter((l) => l !== IPNS_LABELS.queryTable).sort(),
    );
    expect(manifest.ipnsFailures[0]?.reason).toContain("402");
    // refused labels still resolve, by CID
    for (const f of manifest.ipnsFailures) {
      const obj = manifest.objects.find((o) => o.ipnsLabel === f.label);
      expect(obj?.ipns).toBeNull();
      expect(obj?.gatewayUrl).toContain(obj?.cidV1 ?? "<none>");
    }
    // the MCP still gets a working query-table address
    expect(manifest.mcpEnv.PROPERTY_QUERY_TABLE_MAP).toContain("http");
  });

  it("dry-run touches no network and still emits every CID", async () => {
    const paths = makePaths();
    const fetchImpl = (async () => {
      throw new Error("dry-run must not reach the network");
    }) as unknown as typeof fetch;

    const manifest = await executePublish({ paths, env: {} as NodeJS.ProcessEnv, publish: false, logger: log, fetchImpl });

    expect(manifest.mode).toBe("dry-run");
    expect(manifest.ipnsFailures).toEqual([]);
    expect(manifest.missingEnv).toContain("FILEBASE_ACCESS_KEY");
    expect(manifest.objects.every((o) => o.cid.length > 0 && !o.uploaded)).toBe(true);
  });
});
