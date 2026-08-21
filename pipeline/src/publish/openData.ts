import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTY, type Paths } from "../config.js";
import type { Logger } from "../log.js";
import { computeCid, computeFileCid, sameCid } from "./cid.js";
import { createFilebaseClient, gatewayUrls, ipfsUrl, ipnsToken, missingFilebaseEnv, putObject, readFilebaseEnv, upsertIpnsName, type FilebaseEnv } from "./filebase.js";
import { mapLimit, sleep } from "../tracks/http.js";

/**
 * Open-data (consolidation) publish, county-open-data-publish convention:
 *   - per-property files uploaded under their CID name `<cid>.json` (concurrency 64, 429/5xx backoff),
 *   - then shards/shard-NNNN.json, index.json, manifest.json,
 *   - IPNS `oracle-open-data-<county>` re-pointed LAST at the index.json CID (what the MCP resolves),
 *   - a per-bucket checkpoint (cid -> key) so reruns skip content already uploaded, never by key alone,
 *   - after upload the published index CID is compared with the local one and propertyCount checked.
 * Dry-run (default) prints the plan with object counts and total bytes.
 */
export const OPEN_DATA_LABEL = `oracle-open-data-${COUNTY.key}`;
export const OPEN_DATA_PREFIX = `open-data/${COUNTY.key}`;

export interface OpenDataPlan {
  outDir: string;
  propertyFiles: number;
  propertyBytes: number;
  shardFiles: number;
  shardBytes: number;
  indexCid: string;
  indexBytes: number;
  manifestBytes: number;
  propertyCount: number;
  alreadyUploaded: number;
  toUpload: number;
  toUploadBytes: number;
}

interface Checkpoint {
  bucket: string;
  label: string;
  /** cid -> object key */
  uploaded: Record<string, string>;
  updatedAt: string;
}

function checkpointPath(outDir: string, bucket: string): string {
  return join(outDir, `.checkpoint-${bucket.replace(/[^a-z0-9-]/gi, "_")}.json`);
}

function loadCheckpoint(outDir: string, bucket: string): Checkpoint {
  const p = checkpointPath(outDir, bucket);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
    } catch {
      /* fall through */
    }
  }
  return { bucket, label: OPEN_DATA_LABEL, uploaded: {}, updatedAt: new Date().toISOString() };
}

function saveCheckpoint(outDir: string, cp: Checkpoint): void {
  cp.updatedAt = new Date().toISOString();
  writeFileSync(checkpointPath(outDir, cp.bucket), JSON.stringify(cp));
}

interface ManifestLite {
  propertyCount: number;
  entries: { propertyId: string; filePath: string; fileSizeBytes: number; cid: string }[];
}

function readManifest(outDir: string): ManifestLite {
  const p = join(outDir, "manifest.json");
  if (!existsSync(p)) throw new Error(`Missing ${p}; run export:consolidation first`);
  return JSON.parse(readFileSync(p, "utf8")) as ManifestLite;
}

export async function planOpenData(outDir: string, bucket: string | null): Promise<OpenDataPlan> {
  const manifest = readManifest(outDir);
  const shardsDir = join(outDir, "shards");
  const shardFiles = existsSync(shardsDir) ? readdirSync(shardsDir).filter((f) => f.endsWith(".json")) : [];
  const shardBytes = shardFiles.reduce((a, f) => a + statSync(join(shardsDir, f)).size, 0);
  const indexBuf = readFileSync(join(outDir, "index.json"));
  const indexCid = await computeCid(indexBuf);
  const cp = bucket ? loadCheckpoint(outDir, bucket) : null;
  let already = 0;
  let toUploadBytes = 0;
  for (const e of manifest.entries) {
    if (cp && cp.uploaded[e.cid]) already += 1;
    else toUploadBytes += e.fileSizeBytes;
  }
  const propertyBytes = manifest.entries.reduce((a, e) => a + e.fileSizeBytes, 0);
  return {
    outDir,
    propertyFiles: manifest.entries.length,
    propertyBytes,
    shardFiles: shardFiles.length,
    shardBytes,
    indexCid: indexCid.cid,
    indexBytes: indexBuf.length,
    manifestBytes: statSync(join(outDir, "manifest.json")).size,
    propertyCount: manifest.propertyCount,
    alreadyUploaded: already,
    toUpload: manifest.entries.length - already,
    toUploadBytes,
  };
}

export function formatOpenDataPlan(p: OpenDataPlan, bucket: string | null): string {
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  return [
    `=== OPEN DATA PLAN (bucket: ${bucket ?? "<FILEBASE_BUCKET_DUVAL unset>"}, label ${OPEN_DATA_LABEL}) ===`,
    `property files:   ${p.propertyFiles} (${mb(p.propertyBytes)}), already uploaded per checkpoint: ${p.alreadyUploaded}, to upload: ${p.toUpload} (${mb(p.toUploadBytes)})`,
    `shards:           ${p.shardFiles} (${mb(p.shardBytes)})`,
    `index.json:       ${p.indexBytes} B  cid=${p.indexCid}  (IPNS target)  propertyCount=${p.propertyCount}`,
    `manifest.json:    ${mb(p.manifestBytes)}`,
    `total objects:    ${p.propertyFiles + p.shardFiles + 2}  total bytes: ${mb(p.propertyBytes + p.shardBytes + p.indexBytes + p.manifestBytes)}`,
  ].join("\n");
}

export interface OpenDataPublishResult {
  mode: "dry-run" | "published";
  plan: OpenDataPlan;
  uploaded: number;
  skipped: number;
  failed: number;
  indexCid: string;
  publishedIndexCid: string | null;
  ipnsName: string | null;
  ipnsUrl: string | null;
  /** Set when the IPNS label could not be minted (e.g. free-plan name cap); the index stays CID-addressed. */
  ipnsError?: string | null;
  verified: boolean | null;
  ms: number;
}

async function putWithBackoff(client: ReturnType<typeof createFilebaseClient>, bucket: string, key: string, body: Buffer, contentType: string, log: Logger): Promise<string | undefined> {
  let delay = 1000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await putObject(client, { bucket, key, body, contentType });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
      if (attempt === 5 || (status !== 429 && status !== 503 && status < 500 && status !== 0)) throw err;
      log.warn("put_retry", { key, status, msg, delay });
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  return undefined;
}

export async function publishOpenData(opts: { paths: Paths; env: NodeJS.ProcessEnv; publish: boolean; logger: Logger; concurrency?: number }): Promise<OpenDataPublishResult> {
  const t0 = Date.now();
  const log = opts.logger.child({ stage: "open-data-publish" });
  const outDir = join(opts.paths.publishDir, "open-data");
  const fb: FilebaseEnv | null = readFilebaseEnv(opts.env);
  const plan = await planOpenData(outDir, fb?.bucket ?? null);
  const live = opts.publish && fb !== null;
  if (opts.publish && fb === null) log.warn("publish_requested_but_env_missing", { missing: missingFilebaseEnv(opts.env) });
  if (!live) {
    return { mode: "dry-run", plan, uploaded: 0, skipped: plan.alreadyUploaded, failed: 0, indexCid: plan.indexCid, publishedIndexCid: null, ipnsName: null, ipnsUrl: null, verified: null, ms: Date.now() - t0 };
  }
  const fbEnv = fb as FilebaseEnv;
  const client = createFilebaseClient(fbEnv);
  const cp = loadCheckpoint(outDir, fbEnv.bucket);
  const manifest = readManifest(outDir);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const todo = manifest.entries.filter((e) => !cp.uploaded[e.cid]);
  log.info("open_data_upload_start", { toUpload: todo.length, skipped: manifest.entries.length - todo.length });
  let sinceSave = 0;
  await mapLimit(todo, opts.concurrency ?? 64, 0, async (e) => {
    const body = readFileSync(join(outDir, e.filePath));
    const key = `${OPEN_DATA_PREFIX}/${e.cid}.json`;
    try {
      const remote = await putWithBackoff(client, fbEnv.bucket, key, body, "application/json", log);
      if (remote !== undefined && !sameCid(remote, e.cid)) throw new Error(`CID mismatch for ${e.propertyId}: remote ${remote} local ${e.cid}`);
      cp.uploaded[e.cid] = key;
      uploaded += 1;
      sinceSave += 1;
      if (sinceSave >= 1000) {
        saveCheckpoint(outDir, cp);
        sinceSave = 0;
        log.info("open_data_progress", { uploaded, of: todo.length, ms: Date.now() - t0 });
      }
    } catch (err) {
      failed += 1;
      log.error("open_data_upload_failed", { propertyId: e.propertyId, error: err instanceof Error ? err.message : String(err) });
    }
  });
  skipped = manifest.entries.length - todo.length;
  saveCheckpoint(outDir, cp);
  if (failed > 0) throw new Error(`${failed} property uploads failed; rerun to resume from the checkpoint`);

  // shards, manifest, index (index last before IPNS)
  const shardsDir = join(outDir, "shards");
  for (const f of readdirSync(shardsDir).filter((x) => x.endsWith(".json")).sort()) {
    const body = readFileSync(join(shardsDir, f));
    const cid = await computeCid(body);
    if (!cp.uploaded[cid.cid]) {
      await putWithBackoff(client, fbEnv.bucket, `${OPEN_DATA_PREFIX}/shards/${f}`, body, "application/json", log);
      cp.uploaded[cid.cid] = `${OPEN_DATA_PREFIX}/shards/${f}`;
    }
  }
  const manifestBody = readFileSync(join(outDir, "manifest.json"));
  await putWithBackoff(client, fbEnv.bucket, `${OPEN_DATA_PREFIX}/manifest.json`, manifestBody, "application/json", log);
  const indexBody = readFileSync(join(outDir, "index.json"));
  const indexRemote = await putWithBackoff(client, fbEnv.bucket, `${OPEN_DATA_PREFIX}/index.json`, indexBody, "application/json", log);
  const indexLocal = await computeCid(indexBody);
  if (indexRemote !== undefined && !sameCid(indexRemote, indexLocal.cid)) throw new Error(`index.json CID mismatch: remote ${indexRemote} local ${indexLocal.cid}`);
  saveCheckpoint(outDir, cp);

  // IPNS last, then verify through the gateway. The name is a convenience pointer, not the address of
  // record: every file here is already CID-addressed and the index CID is in the result. A capped account
  // (the Filebase free plan allows one name, which the query table takes) must not lose an upload of
  // hundreds of thousands of objects to a failed mint, so the failure is recorded and the run continues.
  let networkKey: string | null = null;
  let ipnsError: string | null = null;
  try {
    ({ networkKey } = await upsertIpnsName(fetch as never, ipnsToken(fbEnv), OPEN_DATA_LABEL, indexLocal.cid));
  } catch (err) {
    ipnsError = err instanceof Error ? err.message : String(err);
    log.warn("open_data_ipns_point_failed", { label: OPEN_DATA_LABEL, cid: indexLocal.cid, reason: ipnsError, fallback: "cid-addressed" });
  }
  const urls = networkKey === null ? null : gatewayUrls(fbEnv.gateway, networkKey);
  let verified: boolean | null = null;
  let publishedIndexCid: string | null = null;
  try {
    const res = await fetch(urls === null ? ipfsUrl(fbEnv.gateway, indexLocal.cid) : urls.filebase, { signal: AbortSignal.timeout(60_000) });
    const roots = res.headers.get("x-ipfs-roots");
    publishedIndexCid = roots ? (roots.split(",").pop() ?? null) : null;
    const body = (await res.json()) as { propertyCount?: number };
    verified = res.ok && body.propertyCount === manifest.propertyCount && (publishedIndexCid === null || sameCid(publishedIndexCid, indexLocal.cid));
  } catch (err) {
    log.warn("open_data_verify_failed", { error: err instanceof Error ? err.message : String(err) });
    verified = false;
  }
  const result: OpenDataPublishResult = {
    mode: "published", plan, uploaded, skipped, failed, indexCid: indexLocal.cid, publishedIndexCid, ipnsName: networkKey, ipnsUrl: urls?.filebase ?? null, ipnsError, verified, ms: Date.now() - t0,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "publish-result.json"), JSON.stringify(result, null, 2));
  log.info("open_data_published", { ...result, plan: undefined });
  return result;
}

export function formatOpenDataResult(r: OpenDataPublishResult, bucket: string | null, gateway: string): string {
  const lines = [formatOpenDataPlan(r.plan, bucket)];
  if (r.mode === "dry-run") {
    lines.push(`DRY RUN: would PUT ${r.plan.toUpload} property files as ${OPEN_DATA_PREFIX}/<cid>.json, ${r.plan.shardFiles} shards, manifest.json, index.json; then point IPNS ${OPEN_DATA_LABEL} at ${r.indexCid}`);
    lines.push(`index URL after publish: ${ipfsUrl(gateway, r.indexCid)} (content-addressed; IPNS name resolved on real publish)`);
    lines.push(`MCP env: ORACLE_OPEN_DATA_IPNS_MAP={"${COUNTY.key}":"<k51 of ${OPEN_DATA_LABEL}>"}  ORACLE_OPEN_DATA_DEFAULT_COUNTY=${COUNTY.key}`);
  } else {
    const ipnsPart = r.ipnsName === null ? `IPNS ${OPEN_DATA_LABEL} SKIPPED (${r.ipnsError ?? "unavailable"}); index stays CID-addressed at ${ipfsUrl(gateway, r.indexCid)}` : `IPNS ${OPEN_DATA_LABEL} -> ${r.ipnsName} (${r.ipnsUrl})`;
    lines.push(`uploaded ${r.uploaded}, skipped (checkpoint) ${r.skipped}, failed ${r.failed}; index cid ${r.indexCid}; ${ipnsPart}; verified ${r.verified}`);
    lines.push(
      r.ipnsName === null
        ? `MCP env: ORACLE_OPEN_DATA_URL_MAP={"${COUNTY.key}":"${ipfsUrl(gateway, r.indexCid)}"}  ORACLE_OPEN_DATA_DEFAULT_COUNTY=${COUNTY.key}`
        : `MCP env: ORACLE_OPEN_DATA_IPNS_MAP={"${COUNTY.key}":"${r.ipnsName}"}  ORACLE_OPEN_DATA_DEFAULT_COUNTY=${COUNTY.key}`,
    );
  }
  return lines.join("\n");
}

export { computeFileCid };
