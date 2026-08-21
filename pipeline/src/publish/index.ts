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

/** IPNS labels per Elephant conventions (one label per dataset; never reuse). */
export const IPNS_LABELS = {
  queryTable: `oracle-query-table-${COUNTY.key}`,
  coverage: `oracle-dataset-coverage-${COUNTY.key}`,
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
  if (existsSync(rh)) objects.push(await describe("run-history.json", rh, OBJECT_KEYS.runHistory, JSON_CT, null));
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
  const planned = await planPublish(opts.paths);

  const client = live && fb ? createFilebaseClient(fb) : null;
  const token = live && fb ? ipnsToken(fb) : null;
  const fetchImpl = opts.fetchImpl ?? fetch;

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
  const pointIpns = async (o: PublishedObject): Promise<PublishedObject> => {
    if (o.ipnsLabel === null) return o;
    if (token === null) return o;
    const { networkKey, created } = await upsertIpnsName(fetchImpl as never, token, o.ipnsLabel, o.cid);
    log.info("ipns_pointed", { label: o.ipnsLabel, networkKey, cid: o.cid, created });
    return { ...o, ipns: { label: o.ipnsLabel, networkKey, gatewayUrl: gatewayUrls(gateway, networkKey).filebase, created } };
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
  results.push(await upload(await describe("published-counties.json", catalogPath, OBJECT_KEYS.catalog, JSON_CT, null)));

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
    PUBLISHED_COUNTY_CATALOG_URL: byName("published-counties.json")?.gatewayUrl ?? "",
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
