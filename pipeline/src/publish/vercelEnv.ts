import type { Logger } from "../log.js";
import type { McpBinding, PublishManifest } from "./index.js";

/**
 * Apply a publish's per-publish MCP settings to the Vercel project that hosts `@elephant-xyz/mcp`,
 * then redeploy it so the new values are live, then prove it by running a query through it.
 *
 * Why this exists: the query table has to be bound to an immutable CID (see McpBinding), a new CID
 * is minted on every publish, and for three days the "re-apply these two lines after every publish"
 * instruction in mcp-env.txt was carried out by nobody. The cron kept publishing, the deployment
 * kept reading the CID of 2026-08-22, and once retention on the storage side had dropped that
 * object every data tool returned 504. An obligation the pipeline creates on every tick is one the
 * pipeline has to discharge on every tick.
 *
 * The Vercel REST API is called directly, no SDK: three endpoints, one token, and a dependency the
 * pipeline would otherwise not have.
 */
export interface VercelTarget {
  token: string;
  projectId: string;
  teamId: string | null;
  /** Base URL of the deployed MCP, used to verify the redeploy serves the new CID. */
  mcpUrl: string | null;
}

export function readVercelTarget(env: NodeJS.ProcessEnv): VercelTarget | null {
  const token = env.VERCEL_TOKEN?.trim();
  const projectId = env.MCP_VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) return null;
  return {
    token,
    projectId,
    teamId: env.VERCEL_TEAM_ID?.trim() || null,
    mcpUrl: env.MCP_URL?.trim() || null,
  };
}

export function missingVercelTarget(env: NodeJS.ProcessEnv): string[] {
  return ["VERCEL_TOKEN", "MCP_VERCEL_PROJECT_ID"].filter((k) => !env[k]?.trim());
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const API = "https://api.vercel.com";

export interface ApplyResult {
  /** Settings written, in the order applied. */
  applied: { env: string; value: string }[];
  /** Vercel deployment id of the redeploy, when one was created. */
  deploymentId: string | null;
  deploymentUrl: string | null;
  /** Final state Vercel reported for that deployment. */
  readyState: string | null;
  /** The live verification: the row count the redeployed server answered, or the failure. */
  verification: { ok: true; properties: number } | { ok: false; reason: string };
}

export interface ApplyOptions {
  target: VercelTarget;
  bindings: McpBinding[];
  logger: Logger;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the redeploy to reach READY. */
  deployTimeoutMs?: number;
  /** Which CID the verification must observe the server reading; null skips that check. */
  expectedQueryTableCid?: string | null;
}

function teamQuery(target: VercelTarget, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (target.teamId) params.set("teamId", target.teamId);
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function api(fetchImpl: FetchLike, target: VercelTarget, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel ${method} ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * The per-publish bindings only. The set-once settings are exactly that; rewriting them on every
 * tick would turn a one-time setup into something the pipeline can silently break.
 */
export function perPublishBindings(bindings: McpBinding[]): McpBinding[] {
  return bindings.filter((b) => b.perPublish);
}

export async function applyMcpEnv(opts: ApplyOptions): Promise<ApplyResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.logger.child({ stage: "apply-mcp-env" });
  const { target } = opts;
  const applied: ApplyResult["applied"] = [];

  // 1. env vars, upserted on the production target. `upsert=true` makes POST replace an existing
  //    key for the same targets instead of failing on the duplicate.
  for (const b of perPublishBindings(opts.bindings)) {
    await api(fetchImpl, target, "POST", `/v10/projects/${target.projectId}/env${teamQuery(target, { upsert: "true" })}`, {
      key: b.env,
      value: b.value,
      type: "encrypted",
      target: ["production"],
    });
    applied.push({ env: b.env, value: b.value });
    log.info("vercel_env_applied", { env: b.env, value: b.value });
  }

  // 2. redeploy the current production deployment. Env is bound at deployment time on Vercel, so a
  //    value change is not live until something is deployed with it.
  const listed = (await api(
    fetchImpl,
    target,
    "GET",
    `/v6/deployments${teamQuery(target, { projectId: target.projectId, target: "production", state: "READY", limit: "1" })}`,
  )) as { deployments?: { uid: string; name: string }[] };
  const previous = listed.deployments?.[0];
  if (previous === undefined) throw new Error("no READY production deployment to redeploy");
  const created = (await api(fetchImpl, target, "POST", `/v13/deployments${teamQuery(target, { forceNew: "1" })}`, {
    name: previous.name,
    deploymentId: previous.uid,
    target: "production",
    meta: { action: "redeploy", reason: "publish: new query table CID" },
  })) as { id: string; url?: string; readyState?: string };
  log.info("vercel_redeploy_created", { deploymentId: created.id, from: previous.uid });

  // 3. wait for READY. A redeploy of an already-built deployment is usually under a minute.
  const deadline = Date.now() + (opts.deployTimeoutMs ?? 8 * 60_000);
  let readyState = created.readyState ?? "QUEUED";
  let url = created.url ?? null;
  while (readyState !== "READY" && readyState !== "ERROR" && readyState !== "CANCELED") {
    if (Date.now() > deadline) break;
    await sleep(5_000);
    const d = (await api(fetchImpl, target, "GET", `/v13/deployments/${created.id}${teamQuery(target)}`)) as {
      readyState?: string;
      url?: string;
    };
    readyState = d.readyState ?? readyState;
    url = d.url ?? url;
  }
  log.info("vercel_redeploy_state", { deploymentId: created.id, readyState });
  if (readyState !== "READY") {
    return {
      applied,
      deploymentId: created.id,
      deploymentUrl: url,
      readyState,
      verification: { ok: false, reason: `redeploy ended in state ${readyState}` },
    };
  }

  // 4. verify through the public endpoint, the way a client would. A deployment that is READY but
  //    answers 504 from DuckDB is exactly the failure this whole file exists to end.
  const verification = await verifyMcp(fetchImpl, target.mcpUrl, opts.expectedQueryTableCid ?? null);
  if (verification.ok) log.info("mcp_verified", { properties: verification.properties });
  else log.error("mcp_verification_failed", { reason: verification.reason });
  return { applied, deploymentId: created.id, deploymentUrl: url, readyState, verification };
}

/**
 * One JSON-RPC call against the live server: count the properties view. The server reports the
 * gateway URL it failed on inside the error text, so a stale CID is diagnosable from this alone.
 */
export async function verifyMcp(fetchImpl: FetchLike, mcpUrl: string | null, expectedCid: string | null): Promise<ApplyResult["verification"]> {
  if (mcpUrl === null) return { ok: false, reason: "MCP_URL not set; nothing verified" };
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "queryProperties", arguments: { county: "duval", sql: "SELECT count(*) AS properties FROM properties" } },
      }),
    });
  } catch (err) {
    return { ok: false, reason: `MCP unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `MCP answered ${res.status}: ${text.slice(0, 200)}` };
  // Streamable HTTP wraps the JSON-RPC message in an SSE frame; plain JSON is also accepted.
  const dataLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice("data:".length).trim() : text.trim();
  let rpc: { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: unknown };
  try {
    rpc = JSON.parse(payload) as typeof rpc;
  } catch {
    return { ok: false, reason: `MCP answered non JSON: ${text.slice(0, 200)}` };
  }
  const inner = rpc.result?.content?.find((c) => c.type === "text")?.text ?? "";
  let tool: unknown;
  try {
    tool = JSON.parse(inner);
  } catch {
    return { ok: false, reason: `tool answered non JSON: ${inner.slice(0, 200)}` };
  }
  if (typeof tool === "object" && tool !== null && "error" in tool) {
    const details = (tool as { details?: string; error?: string }).details ?? (tool as { error?: string }).error ?? "";
    if (expectedCid !== null && !details.includes(expectedCid)) {
      return { ok: false, reason: `server failed on a URL that is not the new CID (${expectedCid}): ${details.slice(0, 200)}` };
    }
    return { ok: false, reason: `queryProperties failed: ${details.slice(0, 200)}` };
  }
  const rows = extractRows(tool);
  const n = rows[0]?.properties;
  const properties = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(properties) || properties <= 0) return { ok: false, reason: `unexpected answer: ${inner.slice(0, 200)}` };
  return { ok: true, properties };
}

function extractRows(tool: unknown): Record<string, unknown>[] {
  if (Array.isArray(tool)) return tool as Record<string, unknown>[];
  if (typeof tool === "object" && tool !== null) {
    const o = tool as Record<string, unknown>;
    for (const k of ["rows", "results", "data"]) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
  }
  return [];
}

export function formatApplyResult(m: PublishManifest, r: ApplyResult): string {
  const lines = [`=== MCP ENV APPLIED (publish ${m.publishedAt}) ===`];
  for (const a of r.applied) lines.push(`${a.env}=${a.value}`);
  lines.push(`redeploy: ${r.deploymentId ?? "<none>"} ${r.readyState ?? ""} ${r.deploymentUrl ? `https://${r.deploymentUrl}` : ""}`.trimEnd());
  lines.push(r.verification.ok ? `verified: queryProperties count(*) = ${r.verification.properties}` : `VERIFICATION FAILED: ${r.verification.reason}`);
  return lines.join("\n");
}
