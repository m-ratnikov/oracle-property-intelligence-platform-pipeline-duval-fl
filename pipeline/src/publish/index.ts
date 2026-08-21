import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTY, type Paths } from "../config.js";
import type { Logger } from "../log.js";
import { buildCatalog } from "./catalog.js";
import { computeFileCid, sameCid } from "./cid.js";
import {
  createFilebaseClient,
  gatewayUrls,
  ipfsUrl,
  ipnsToken,
  missingFilebaseEnv,
  putObject,
  readFilebaseEnv,
  upsertIpnsName,
  type FilebaseEnv,
} from "./filebase.js";
import { mergePublishedRunHistory, type MergeResult } from "./runHistory.js";

/**
 * IPNS labels per Elephant conventions (one label per dataset; never reuse).
 *
 * Every artifact a consumer follows ACROSS runs needs a name, not a CID. A CID is immutable, so a
 * consumer pinned to one keeps reading the run it was published in: the runs page froze at eight
 * runs and could only move by rebuilding the site, on the page whose entire job is to show that
 * ingestion is continuous. The catalog is named for the same reason - it is what an MCP deployment
 * is pointed at, and that pointer should not have to be reissued every publish.
 */
export const IPNS_LABELS = {
  queryTable: `oracle-query-table-${COUNTY.key}`,
  coverage: `oracle-dataset-coverage-${COUNTY.key}`,
  runHistory: `oracle-run-history-${COUNTY.key}`,
  catalog: "oracle-published-counties",
  artifacts: `${COUNTY.key}-oracle-artifacts`,
} as const;

export const OBJECT_KEYS = {
  queryTable: `query-tables/${COUNTY.key}/query-table.parquet`,
  coverage: `incremental-status/${COUNTY.key}/dataset-coverage.json`,
  runHistory: `runs/${COUNTY.key}/run-history.json`,
  tables: (name: string) => `tables/${COUNTY.key}/${name}`,
  catalog: "catalog/published-counties.json",
  artifactsIndex: `artifacts/${COUNTY.key}/index.json`,
} as const;

export interface PublishObject {
  name: string;
  localPath: string;
  key: string;
  contentType: string;
  bytes: number;
  sha256: string;
  cid: string;
  cidV1: string;
  ipnsLabel: string | null;
}

export interface PublishedObject extends PublishObject {
  uploaded: boolean;
  remoteCid: string | null;
  gatewayUrl: string;
  ipns: { label: string; networkKey: string; gatewayUrl: string; created: boolean } | null;
}

/** An IPNS label the account could not mint (plan cap, auth, transient); the artifact stays CID-addressed. */
export interface IpnsFailure {
  label: string;
  cid: string;
  reason: string;
}

export interface PublishManifest {
  county: string;
  mode: "dry-run" | "published";
  publishedAt: string;
  bucket: string | null;
  gateway: string;
  objects: PublishedObject[];
  ipns: Record<string, { label: string; networkKey: string | null; cid: string; gatewayUrl: string | null }>;
  /** What to set on an elephant-mcp deployment so it serves Duval. */
  mcpEnv: Record<string, string>;
  missingEnv: string[];
  /** IPNS labels that could not be minted (e.g. free-plan name cap); those artifacts stay CID-addressed. */
  ipnsFailures: IpnsFailure[];
  /** What happened to the already-published run history on this publish (see publish/runHistory.ts). */
  runHistory: MergeResult;
}

const PARQUET = "application/vnd.apache.parquet";
const JSON_CT = "application/json";

async function describe(name: string, localPath: string, key: string, contentType: string, ipnsLabel: string | null): Promise<PublishObject> {
  const c = await computeFileCid(localPath);
  return { name, localPath, key, contentType, bytes: c.bytes, sha256: c.sha256, cid: c.cid, cidV1: c.cidV1, ipnsLabel };
}

/** Everything under DATA_DIR/artifacts/publish/duval that is eligible for IPFS (no PII beyond the public roll). */
export async function planPublish(paths: Paths): Promise<PublishObject[]> {
  const dir = paths.publishDir;
  const objects: PublishObject[] = [];
  const qt = join(dir, "query-table.parquet");
  if (!existsSync(qt)) throw new Error(`Missing ${qt}; run the pipeline first`);
  objects.push(await describe("query-table.parquet", qt, OBJECT_KEYS.queryTable, PARQUET, IPNS_LABELS.queryTable));
  const cov = join(dir, "dataset-coverage.json");
  if (existsSync(cov)) objects.push(await describe("dataset-coverage.json", cov, OBJECT_KEYS.coverage, JSON_CT, IPNS_LABELS.coverage));
  const rh = join(dir, "run-history.json");
  if (existsSync(rh)) objects.push(await describe("run-history.json", rh, OBJECT_KEYS.runHistory, JSON_CT, IPNS_LABELS.runHistory));
  const tablesDir = join(dir, "tables");
  if (existsSync(tablesDir)) {
    for (const f of readdirSync(tablesDir).filter((f) => f.endsWith(".parquet")).sort()) {
      objects.push(await describe(`tables/${f}`, join(tablesDir, f), OBJECT_KEYS.tables(f), PARQUET, null));
    }
  }
  return objects;
}

export function formatPlan(objects: PublishObject[], bucket: string | null, gateway: string): string {
  const lines = [`=== PUBLISH PLAN (${objects.length} objects, bucket: ${bucket ?? "<FILEBASE_BUCKET_DUVAL unset>"}) ===`];
  const w = Math.max(...objects.map((o) => o.name.length));
  for (const o of objects) {
    lines.push(
      `${o.name.padEnd(w)}  ${String(o.bytes).padStart(11)} B  cid=${o.cid}  v1=${o.cidV1}` +
        (o.ipnsLabel ? `  ipns=${o.ipnsLabel}` : "") +
        `\n${" ".repeat(w)}  key=${o.key}  url=${ipfsUrl(gateway, o.cidV1)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Publish flow (dry-run by default):
 *   1. upload query table, coverage, run history, entity tables (CID pre-computed locally, verified
 *      against Filebase's x-amz-meta-cid when uploading);
 *   2. upsert IPNS labels for the query table and the coverage snapshot;
 *   3. build + upload the published-counties catalog (URLs = IPNS gateway URLs);
 *   4. build + upload the artifacts index (all CIDs, IPNS names) and point the artifacts IPNS at it;
 *   5. write publish-manifest.json next to the artifacts for the UI / run history.
 */
export async function executePublish(opts: {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  publish: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Test seam: supply the S3 client instead of opening a real Filebase connection. */
  clientFactory?: (fb: FilebaseEnv) => ReturnType<typeof createFilebaseClient>;
}): Promise<PublishManifest> {
  const log = opts.logger.child({ stage: "publish" });
  const fb: FilebaseEnv | null = readFilebaseEnv(opts.env);
  const missingEnv = missingFilebaseEnv(opts.env);
  const gateway = fb?.gateway ?? (opts.env.FILEBASE_GATEWAY?.trim() || "https://ipfs.filebase.io");
  const live = opts.publish && fb !== null;
  if (opts.publish && fb === null) {
    log.warn("publish_requested_but_env_missing", { missing: missingEnv });
  }
  const publishedAt = new Date().toISOString();

  const client = live && fb ? (opts.clientFactory ?? createFilebaseClient)(fb) : null;
  const token = live && fb ? ipnsToken(fb) : null;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Run history is the one cumulative artifact: fold the copy already at the IPNS name into the local
  // one BEFORE anything is CID-addressed, so this publish can only grow the history a reader sees.
  // Every failure mode degrades to publishing exactly what this database knows. See runHistory.ts.
  const runHistory = await mergePublishedRunHistory({
    paths: opts.paths,
    county: COUNTY.key,
    gateway,
    ipnsLabel: IPNS_LABELS.runHistory,
    token,
    fetchImpl,
    logger: log,
  });

  const planned = await planPublish(opts.paths);

  const results: PublishedObject[] = [];
  const upload = async (o: PublishObject): Promise<PublishedObject> => {
    let remoteCid: string | null = null;
    let uploaded = false;
    if (client && fb) {
      const body = readFileSync(o.localPath);
      const header = await putObject(client, { bucket: fb.bucket, key: o.key, body, contentType: o.contentType });
      remoteCid = header ?? null;
      uploaded = true;
      if (header !== undefined && !sameCid(header, o.cid)) {
        throw new Error(`Filebase CID for ${o.key} (${header}) disagrees with local CID (${o.cid} / ${o.cidV1})`);
      }
      log.info("object_uploaded", { key: o.key, bytes: o.bytes, cid: o.cid, remoteCid });
    } else {
      log.info("object_planned", { key: o.key, bytes: o.bytes, cid: o.cid, cidV1: o.cidV1 });
    }
    return { ...o, uploaded, remoteCid, gatewayUrl: ipfsUrl(gateway, o.cidV1), ipns: null };
  };
  // IPNS names are a metered resource: the Filebase free plan allows a single name per account, so a
  // second create returns an error. A mutable pointer is a convenience, not the address of record (every
  // artifact is CID-addressed and the manifest carries the CIDs), so a name we cannot mint is recorded as
  // a limitation and the artifact keeps its CID URL rather than failing the whole publish. Objects are
  // planned query-table first, so the one name a capped account does get goes to the artifact the MCP
  // deployment needs to follow across runs.
  const ipnsFailures: IpnsFailure[] = [];
  const pointIpns = async (o: PublishedObject): Promise<PublishedObject> => {
    if (o.ipnsLabel === null) return o;
    if (token === null) return o;
    try {
      const { networkKey, created } = await upsertIpnsName(fetchImpl as never, token, o.ipnsLabel, o.cid);
      log.info("ipns_pointed", { label: o.ipnsLabel, networkKey, cid: o.cid, created });
      return { ...o, ipns: { label: o.ipnsLabel, networkKey, gatewayUrl: gatewayUrls(gateway, networkKey).filebase, created } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ipnsFailures.push({ label: o.ipnsLabel, cid: o.cid, reason });
      log.warn("ipns_point_failed", { label: o.ipnsLabel, cid: o.cid, reason, fallback: "cid-addressed" });
      return o;
    }
  };

  for (const o of planned) results.push(await pointIpns(await upload(o)));

  const byName = (n: string) => results.find((r) => r.name === n);
  const qt = byName("query-table.parquet");
  const cov = byName("dataset-coverage.json");
  if (qt === undefined) throw new Error("query table missing from publish plan");
  const qtUrl = qt.ipns?.gatewayUrl ?? qt.gatewayUrl;
  const covUrl = cov?.ipns?.gatewayUrl ?? cov?.gatewayUrl ?? qt.gatewayUrl;

  // 3. catalog
  const catalog = buildCatalog({ generatedAt: publishedAt, queryTableUrl: qtUrl, datasetCoverageUrl: covUrl });
  const catalogPath = join(opts.paths.publishDir, "published-counties.json");
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  results.push(await pointIpns(await upload(await describe("published-counties.json", catalogPath, OBJECT_KEYS.catalog, JSON_CT, IPNS_LABELS.catalog))));

  // 4. artifacts index (points the artifacts IPNS at one JSON that lists every CID)
  const ipns: PublishManifest["ipns"] = {};
  for (const r of results) {
    if (r.ipnsLabel !== null) {
      ipns[r.ipnsLabel] = { label: r.ipnsLabel, networkKey: r.ipns?.networkKey ?? null, cid: r.cid, gatewayUrl: r.ipns?.gatewayUrl ?? null };
    }
  }
  const indexDoc = {
    county: COUNTY.key,
    generatedAt: publishedAt,
    mode: live ? "published" : "dry-run",
    gateway,
    artifacts: results.map((r) => ({
      name: r.name,
      key: r.key,
      contentType: r.contentType,
      bytes: r.bytes,
      sha256: r.sha256,
      cid: r.cid,
      cidV1: r.cidV1,
      url: r.gatewayUrl,
      ipnsLabel: r.ipnsLabel,
      ipnsName: r.ipns?.networkKey ?? null,
      ipnsUrl: r.ipns?.gatewayUrl ?? null,
    })),
    ipns,
  };
  const indexPath = join(opts.paths.publishDir, "artifacts-index.json");
  writeFileSync(indexPath, JSON.stringify(indexDoc, null, 2));
  const indexObj = await describe("artifacts-index.json", indexPath, OBJECT_KEYS.artifactsIndex, JSON_CT, IPNS_LABELS.artifacts);
  const indexPublished = await pointIpns(await upload(indexObj));
  results.push(indexPublished);
  ipns[IPNS_LABELS.artifacts] = {
    label: IPNS_LABELS.artifacts,
    networkKey: indexPublished.ipns?.networkKey ?? null,
    cid: indexPublished.cid,
    gatewayUrl: indexPublished.ipns?.gatewayUrl ?? null,
  };

  const openDataResultPath = join(opts.paths.publishDir, "open-data", "publish-result.json");
  let openDataIpns = `<k51 of oracle-open-data-${COUNTY.key}; run publish:open-data -- --publish>`;
  if (existsSync(openDataResultPath)) {
    try {
      const r = JSON.parse(readFileSync(openDataResultPath, "utf8")) as { ipnsName?: string | null };
      if (r.ipnsName) openDataIpns = r.ipnsName;
    } catch {
      /* keep placeholder */
    }
  }
  const mcpEnv: Record<string, string> = {
    PROPERTY_QUERY_TABLE_MAP: JSON.stringify({ [COUNTY.key]: qtUrl }),
    ORACLE_OPEN_DATA_IPNS_MAP: JSON.stringify({ [COUNTY.key]: openDataIpns }),
    ORACLE_OPEN_DATA_DEFAULT_COUNTY: COUNTY.key,
    PROPERTY_QUERY_TABLE_DEFAULT_COUNTY: COUNTY.key,
    DATASET_COVERAGE_MAP: JSON.stringify({ [COUNTY.key]: covUrl }),
    PUBLISHED_COUNTY_CATALOG_URL:
      byName("published-counties.json")?.ipns?.gatewayUrl ?? byName("published-counties.json")?.gatewayUrl ?? "",
  };

  const manifest: PublishManifest = {
    county: COUNTY.key,
    mode: live ? "published" : "dry-run",
    publishedAt,
    bucket: fb?.bucket ?? null,
    gateway,
    objects: results,
    ipns,
    mcpEnv,
    missingEnv,
    ipnsFailures,
    runHistory,
  };
  mkdirSync(opts.paths.publishDir, { recursive: true });
  writeFileSync(join(opts.paths.publishDir, "publish-manifest.json"), JSON.stringify(manifest, null, 2));
  log.info("publish_manifest_written", { mode: manifest.mode, objects: results.length, path: join(opts.paths.publishDir, "publish-manifest.json") });
  return manifest;
}

export function formatManifest(m: PublishManifest): string {
  const lines: string[] = [];
  lines.push(`=== PUBLISH ${m.mode === "dry-run" ? "DRY-RUN (no S3 PUT, no IPNS write)" : "COMPLETE"} ===`);
  lines.push(`county:   ${m.county}`);
  lines.push(`bucket:   ${m.bucket ?? "<unset>"}`);
  if (m.missingEnv.length > 0) lines.push(`missing:  ${m.missingEnv.join(", ")}`);
  const rh = m.runHistory;
  lines.push(
    `history:  ${rh.outcome} (local ${rh.localRuns} + published ${rh.publishedRuns} -> publishing ${rh.mergedRuns} runs)` +
      (rh.detail === null ? "" : ` [${rh.detail}]`),
  );
  for (const f of m.ipnsFailures) lines.push(`ipns SKIPPED label=${f.label} -> stays CID-addressed (${f.reason})`);
  const w = Math.max(...m.objects.map((o) => o.name.length));
  for (const o of m.objects) {
    lines.push(`${o.name.padEnd(w)}  ${String(o.bytes).padStart(11)} B  ${o.uploaded ? "uploaded" : "would PUT"}  s3://${m.bucket ?? "<bucket>"}/${o.key}`);
    lines.push(`${" ".repeat(w)}  cid=${o.cid}  (v1 ${o.cidV1})`);
    if (o.ipnsLabel) lines.push(`${" ".repeat(w)}  ipns label=${o.ipnsLabel}  name=${o.ipns?.networkKey ?? "<resolved on real publish>"}`);
  }
  lines.push("MCP env:");
  for (const [k, v] of Object.entries(m.mcpEnv)) lines.push(`  ${k}=${v}`);
  return lines.join("\n");
}

export function sizeOf(path: string): number {
  return statSync(path).size;
}
