import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import type { McpBinding } from "../src/publish/index.js";
import { applyMcpEnv, perPublishBindings, readVercelTarget, verifyMcp } from "../src/publish/vercelEnv.js";

/**
 * The publish creates an obligation ("re-apply these two lines to the MCP deployment") on every
 * tick. For three days nobody did, and the deployment answered 504 once storage retention dropped
 * the CID it was still reading. This is the step that discharges the obligation; the tests pin what
 * it writes, that it writes only the per-publish settings, and that it does not call itself done
 * until the redeployed server has answered a real query.
 */

const CID = "bafybeicux4ee3xzkcccavufgzs23nyxvymudjjhr3wgkk24ilgvixkalyi";
const BINDINGS: McpBinding[] = [
  { env: "PROPERTY_QUERY_TABLE_MAP", value: JSON.stringify({ duval: `https://ipfs.filebase.io/ipfs/${CID}` }), addressing: "cid", perPublish: true, reason: "" },
  { env: "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY", value: "duval", addressing: "literal", perPublish: false, reason: "" },
  { env: "DATASET_COVERAGE_MAP", value: JSON.stringify({ duval: "https://ipfs.filebase.io/ipfs/bafy-cov" }), addressing: "cid", perPublish: true, reason: "" },
  { env: "PUBLISHED_COUNTY_CATALOG_URL", value: "https://ipfs.filebase.io/ipns/k51-catalog", addressing: "ipns", perPublish: false, reason: "" },
];

const TARGET = { token: "tok", projectId: "prj_1", teamId: "team_1", mcpUrl: "https://mcp.example/mcp" };
const log = createLogger({ service: "test" });
const noSleep = async () => undefined;

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function toolText(tool: unknown) {
  return { result: { content: [{ type: "text", text: JSON.stringify(tool) }] }, jsonrpc: "2.0", id: 1 };
}

/** A Vercel API + MCP endpoint stand-in that records every call. */
function fakeVercel(opts: { mcpAnswer: unknown; readyAfterPolls?: number; finalState?: string }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let polls = 0;
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    const respond = (status: number, payload: unknown, raw?: string) => ({
      ok: status < 400,
      status,
      statusText: status < 400 ? "OK" : "Bad",
      json: async () => payload,
      text: async () => raw ?? JSON.stringify(payload),
    });
    if (url.startsWith("https://mcp.example/")) return respond(200, null, sse(toolText(opts.mcpAnswer)));
    if (url.includes("/env")) return respond(200, { created: {} });
    if (url.includes("/v6/deployments")) return respond(200, { deployments: [{ uid: "dpl_prev", name: "duval-oracle-mcp" }] });
    if (url.includes("/v13/deployments/dpl_new")) {
      polls += 1;
      const ready = polls >= (opts.readyAfterPolls ?? 1);
      return respond(200, { readyState: ready ? (opts.finalState ?? "READY") : "BUILDING", url: "duval-oracle-mcp.vercel.app" });
    }
    if (url.includes("/v13/deployments")) return respond(200, { id: "dpl_new", readyState: "QUEUED", url: "duval-oracle-mcp.vercel.app" });
    return respond(404, { error: "unexpected" });
  };
  return { calls, fetchImpl };
}

describe("apply-mcp-env", () => {
  it("only the per-publish settings are written, never the set-once ones", () => {
    expect(perPublishBindings(BINDINGS).map((b) => b.env)).toEqual(["PROPERTY_QUERY_TABLE_MAP", "DATASET_COVERAGE_MAP"]);
  });

  it("upserts the two CID URLs on production, redeploys, waits for READY and verifies a live query", async () => {
    const { calls, fetchImpl } = fakeVercel({ mcpAnswer: { rows: [{ properties: 404023 }] }, readyAfterPolls: 2 });
    const r = await applyMcpEnv({ target: TARGET, bindings: BINDINGS, logger: log, fetchImpl, sleep: noSleep, expectedQueryTableCid: CID });

    const envWrites = calls.filter((c) => c.url.includes("/env"));
    expect(envWrites).toHaveLength(2);
    for (const w of envWrites) {
      expect(w.method).toBe("POST");
      expect(w.url).toContain("upsert=true");
      expect(w.url).toContain("teamId=team_1");
      expect((w.body as { target: string[] }).target).toEqual(["production"]);
    }
    expect((envWrites[0]?.body as { key: string; value: string }).key).toBe("PROPERTY_QUERY_TABLE_MAP");
    expect((envWrites[0]?.body as { value: string }).value).toContain(CID);

    const redeploy = calls.find((c) => c.method === "POST" && /\/v13\/deployments(\?|$)/.test(c.url));
    expect((redeploy?.body as { deploymentId: string; target: string }).deploymentId).toBe("dpl_prev");
    expect((redeploy?.body as { target: string }).target).toBe("production");

    expect(r.readyState).toBe("READY");
    expect(r.deploymentId).toBe("dpl_new");
    expect(r.verification).toEqual({ ok: true, properties: 404023 });
    // the verification went to the public endpoint, after the deployment was READY
    const mcpIdx = calls.findIndex((c) => c.url.startsWith("https://mcp.example/"));
    const readyIdx = calls.findIndex((c) => c.url.includes("/v13/deployments/dpl_new"));
    expect(mcpIdx).toBeGreaterThan(readyIdx);
  });

  it("reports a redeploy that did not reach READY as unverified, without calling the server", async () => {
    const { calls, fetchImpl } = fakeVercel({ mcpAnswer: { rows: [] }, finalState: "ERROR" });
    const r = await applyMcpEnv({ target: TARGET, bindings: BINDINGS, logger: log, fetchImpl, sleep: noSleep });
    expect(r.readyState).toBe("ERROR");
    expect(r.verification.ok).toBe(false);
    expect(calls.some((c) => c.url.startsWith("https://mcp.example/"))).toBe(false);
  });

  it("a server that still fails on a gateway URL is unverified, and the reason names the URL", async () => {
    const { fetchImpl } = fakeVercel({
      mcpAnswer: {
        error: "Failed to run property query",
        details: "HTTP Error: Request returned HTTP 504 for HTTP HEAD to 'https://ipfs.filebase.io/ipfs/bafybeidmxru-old'",
      },
    });
    const r = await applyMcpEnv({ target: TARGET, bindings: BINDINGS, logger: log, fetchImpl, sleep: noSleep, expectedQueryTableCid: CID });
    expect(r.verification.ok).toBe(false);
    if (!r.verification.ok) {
      expect(r.verification.reason).toContain("bafybeidmxru-old");
      expect(r.verification.reason).toContain("not the new CID");
    }
  });

  it("verifyMcp reads a plain JSON body as well as an SSE frame", async () => {
    const plain = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => null, text: async () => JSON.stringify(toolText({ rows: [{ properties: "12" }] })) });
    expect(await verifyMcp(plain as never, "https://x/mcp", null)).toEqual({ ok: true, properties: 12 });
    expect(await verifyMcp(plain as never, null, null)).toEqual({ ok: false, reason: "MCP_URL not set; nothing verified" });
  });

  it("readVercelTarget needs the token and the project, and treats the rest as optional", () => {
    expect(readVercelTarget({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readVercelTarget({ VERCEL_TOKEN: "t" } as NodeJS.ProcessEnv)).toBeNull();
    expect(readVercelTarget({ VERCEL_TOKEN: "t", MCP_VERCEL_PROJECT_ID: "p" } as NodeJS.ProcessEnv)).toEqual({
      token: "t",
      projectId: "p",
      teamId: null,
      mcpUrl: null,
    });
  });
});
