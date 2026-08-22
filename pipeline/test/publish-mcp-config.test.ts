import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { computeFileCid } from "../src/publish/cid.js";
import { executePublish, IPNS_LABELS } from "../src/publish/index.js";
import { PublishedCountyCatalogSchema } from "../src/publish/catalog.js";

/**
 * The publish output is the ONE place MCP configuration comes from, and it has to be internally
 * consistent: after a publish, the env block the manifest prints and the catalog it uploaded must
 * name the same artifact, and that artifact must be the one this publish just produced.
 *
 * The query table specifically must be CID-addressed. @elephant-xyz/mcp hands the URL to DuckDB
 * (`CREATE VIEW properties AS SELECT * FROM read_parquet('<url>')`) and caches that connection per
 * URL for the life of a warm instance; DuckDB's httpfs pins the ETag it first saw, so a mutable
 * /ipns/ URL fails every data tool the moment the name is re-pointed - which this pipeline does
 * every six hours by design.
 */

async function makePaths(): Promise<Paths> {
  const dir = mkdtempSync(join(tmpdir(), "duval-mcp-config-"));
  const publishDir = join(dir, "artifacts", "publish", "duval");
  mkdirSync(publishDir, { recursive: true });
  const queryTable = join(publishDir, "query-table.parquet");
  writeFileSync(queryTable, Buffer.from("PAR1-fixture-query-table"));
  writeFileSync(join(publishDir, "dataset-coverage.json"), JSON.stringify({ county: "duval", datasets: [] }));
  // The publish refuses to ship a run history that does not record the parquet beside it, so the
  // fixture asserts the same identity a real run record does: this run produced this exact file.
  const qt = await computeFileCid(queryTable);
  writeFileSync(
    join(publishDir, "run-history.json"),
    JSON.stringify({
      county: "duval",
      generatedAt: "2026-08-21T23:46:43.558Z",
      runCount: 1,
      runs: [
        {
          run_id: "01M0KBA53DPMHRGXV66NQ0GRY5",
          started_at: "2026-08-21T23:43:16.590Z",
          trigger: "consolidation",
          artifacts: { queryTable: { path: "query-table.parquet", cid: qt.cid, cidV1: qt.cidV1 } },
        },
      ],
    }),
  );
  return {
    dataDir: dir,
    dbPath: join(dir, "duval.duckdb"),
    artifactsDir: join(dir, "artifacts"),
    publishDir,
    runsDir: join(dir, "runs"),
  } as Paths;
}

const ENV = {
  FILEBASE_ACCESS_KEY: "test-access",
  FILEBASE_SECRET_KEY: "test-secret",
  FILEBASE_BUCKET_DUVAL: "test-bucket",
} as NodeJS.ProcessEnv;

const log = createLogger({ service: "test" });

function stubClient() {
  return {
    send: async () => ({}),
    middlewareStack: { add: () => undefined, remove: () => undefined },
  };
}

/** A Names API with no quota, so every label mints and re-points cleanly. */
function namesApi(opts: { fail?: (label: string) => string | null } = {}) {
  const names: { label: string; network_key: string; cid: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { method?: string; body?: string }) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify(names), { status: 200 });
    if (method === "POST") {
      const { label, cid } = JSON.parse(init?.body ?? "{}") as { label: string; cid: string };
      const failure = opts.fail?.(label) ?? null;
      if (failure !== null) return new Response(failure, { status: failure.includes("402") ? 402 : 503, statusText: failure });
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
  return { fetchImpl, names };
}

const NO_SLEEP = { sleep: async (): Promise<void> => undefined };

describe("publish output is the source of truth for MCP configuration", () => {
  it("addresses the query table and the coverage snapshot by the CID this publish produced", async () => {
    const paths = await makePaths();
    const { fetchImpl } = namesApi();

    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });

    const qt = m.objects.find((o) => o.name === "query-table.parquet");
    const cov = m.objects.find((o) => o.name === "dataset-coverage.json");
    expect(qt?.ipns?.networkKey).toBe(`k51-${IPNS_LABELS.queryTable}`); // the name IS still minted

    const mapped = JSON.parse(m.mcpEnv.PROPERTY_QUERY_TABLE_MAP ?? "{}") as Record<string, string>;
    expect(mapped.duval).toBe(`https://ipfs.filebase.io/ipfs/${qt?.cidV1 ?? "<none>"}`);
    expect(mapped.duval).not.toContain("/ipns/");

    const coverage = JSON.parse(m.mcpEnv.DATASET_COVERAGE_MAP ?? "{}") as Record<string, string>;
    expect(coverage.duval).toBe(`https://ipfs.filebase.io/ipfs/${cov?.cidV1 ?? "<none>"}`);
    expect(coverage.duval).not.toContain("/ipns/");
  });

  it("keeps the catalog URL mutable, because it is fetched as JSON and never handed to DuckDB", async () => {
    const paths = await makePaths();
    const { fetchImpl } = namesApi();
    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });
    expect(m.mcpEnv.PUBLISHED_COUNTY_CATALOG_URL).toBe(`https://ipfs.filebase.io/ipns/k51-${IPNS_LABELS.catalog}`);
    const perPublish = m.mcpBindings.filter((b) => b.perPublish).map((b) => b.env).sort();
    expect(perPublish).toEqual(["DATASET_COVERAGE_MAP", "PROPERTY_QUERY_TABLE_MAP"]);
  });

  it("publishes a catalog that names exactly the artifacts the env block names", async () => {
    const paths = await makePaths();
    const { fetchImpl } = namesApi();
    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });

    const catalog = PublishedCountyCatalogSchema.parse(
      JSON.parse(readFileSync(join(paths.publishDir, "published-counties.json"), "utf8")),
    );
    const county = catalog.counties[0];
    expect(county?.queryTableUrl).toBe((JSON.parse(m.mcpEnv.PROPERTY_QUERY_TABLE_MAP ?? "{}") as Record<string, string>).duval);
    expect(county?.datasetCoverageUrl).toBe((JSON.parse(m.mcpEnv.DATASET_COVERAGE_MAP ?? "{}") as Record<string, string>).duval);
  });

  it("writes a pasteable env file that separates the per-publish lines from the set-once lines", async () => {
    const paths = await makePaths();
    const { fetchImpl } = namesApi();
    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });

    const text = readFileSync(join(paths.publishDir, "mcp-env.txt"), "utf8");
    expect(text).toContain("# --- per publish: re-apply these two, then redeploy ---");
    expect(text).toContain("# --- set once: stable across publishes ---");
    for (const [k, v] of Object.entries(m.mcpEnv)) expect(text).toContain(`${k}=${v}`);
    // the per-publish half must be above the set-once half, because that is the operator's job list
    expect(text.indexOf("PROPERTY_QUERY_TABLE_MAP=")).toBeLessThan(text.indexOf("PUBLISHED_COUNTY_CATALOG_URL="));
  });

  it("reports a partial publish instead of passing silently", async () => {
    const paths = await makePaths();
    // The run-history name refuses for a reason that is not a plan quota: a real failure.
    const { fetchImpl } = namesApi({ fail: (label) => (label === IPNS_LABELS.runHistory ? "503 upstream unavailable" : null) });
    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });

    expect(m.ok).toBe(false);
    expect(m.ipnsFailures.map((f) => f.kind)).toEqual(["failed"]);
  });

  it("treats the storage account's name quota as a limitation, not a failed publish", async () => {
    const paths = await makePaths();
    const { fetchImpl } = namesApi({ fail: (label) => (label === IPNS_LABELS.queryTable ? null : "402 plan limit reached") });
    const m = await executePublish({
      paths,
      env: ENV,
      publish: true,
      logger: log,
      fetchImpl,
      clientFactory: () => stubClient() as never,
      ipnsReadback: NO_SLEEP,
    });

    expect(m.ipnsFailures.length).toBeGreaterThan(0);
    expect(m.ipnsFailures.every((f) => f.kind === "quota")).toBe(true);
    expect(m.ok).toBe(true);
    // and the MCP is unaffected, because it never depended on those names
    expect((JSON.parse(m.mcpEnv.PROPERTY_QUERY_TABLE_MAP ?? "{}") as Record<string, string>).duval).toContain("/ipfs/");
  });
});
