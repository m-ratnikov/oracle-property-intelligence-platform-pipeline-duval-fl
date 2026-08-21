import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DeserializeHandler, DeserializeHandlerArguments, DeserializeHandlerOutput, DeserializeMiddleware, HandlerExecutionContext } from "@smithy/types";
import type { ServiceInputTypes, ServiceOutputTypes } from "@aws-sdk/client-s3";
import { envOrDefault } from "../config.js";

/**
 * Filebase mechanics, copied from the Elephant reference uploaders:
 *  - objects go through the S3-compatible endpoint; Filebase returns the pinned CID in the
 *    `x-amz-meta-cid` response header (captured with a deserialize middleware);
 *  - mutable pointers live under the Names API `/v1/names` (POST {label,cid} to create,
 *    PUT /v1/names/{label} {cid} to re-point), auth `Bearer base64(access:secret)`;
 *  - the resolvable IPNS name is the record's `network_key` (k51...).
 */
export interface FilebaseEnv {
  accessKey: string;
  secretKey: string;
  bucket: string;
  endpoint: string;
  gateway: string;
}

export const FILEBASE_NAMES_API = "https://api.filebase.io/v1/names";

export function readFilebaseEnv(env: NodeJS.ProcessEnv = process.env): FilebaseEnv | null {
  const accessKey = env.FILEBASE_ACCESS_KEY?.trim();
  const secretKey = env.FILEBASE_SECRET_KEY?.trim();
  const bucket = env.FILEBASE_BUCKET_DUVAL?.trim();
  if (!accessKey || !secretKey || !bucket) return null;
  return {
    accessKey,
    secretKey,
    bucket,
    endpoint: envOrDefault("FILEBASE_S3_ENDPOINT", "https://s3.filebase.com", env),
    gateway: envOrDefault("FILEBASE_GATEWAY", "https://ipfs.filebase.io", env),
  };
}

/** Which Filebase settings are missing (for a precise dry-run message, never the values). */
export function missingFilebaseEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["FILEBASE_ACCESS_KEY", "FILEBASE_SECRET_KEY", "FILEBASE_BUCKET_DUVAL"].filter((k) => !env[k]?.trim());
}

export function createFilebaseClient(fb: FilebaseEnv): S3Client {
  return new S3Client({
    endpoint: fb.endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: fb.accessKey, secretAccessKey: fb.secretKey },
    forcePathStyle: true,
  });
}

export function ipnsToken(fb: FilebaseEnv): string {
  return Buffer.from(`${fb.accessKey}:${fb.secretKey}`).toString("base64");
}

interface RawHttpResponse {
  headers: Record<string, string>;
  statusCode: number;
}
function isRawHttpResponse(v: unknown): v is RawHttpResponse {
  return typeof v === "object" && v !== null && "headers" in v && typeof (v as RawHttpResponse).headers === "object";
}

/**
 * PUT one object; returns the CID Filebase reports in x-amz-meta-cid (if any).
 *
 * The response-capturing middleware goes on the COMMAND, not the client. Putting it on the client
 * mutates state shared by every in-flight call: with uploads running 64 at a time, the second
 * caller to add a middleware the first had not yet removed got "Duplicate middleware name
 * 'captureFilebaseCid'". That failed 17,640 of 77,000 uploads in Actions run 32475509467, and
 * because each failure then burned six backoff retries it also dragged the average PUT out to
 * about seven seconds. A command carries its own stack, so concurrent calls cannot collide and
 * nothing has to be removed afterwards.
 */
export async function putObject(
  client: Pick<S3Client, "send">,
  params: { bucket: string; key: string; body: Buffer; contentType: string },
): Promise<string | undefined> {
  let captured: Record<string, string> | undefined;
  const middleware: DeserializeMiddleware<ServiceInputTypes, ServiceOutputTypes> =
    (next: DeserializeHandler<ServiceInputTypes, ServiceOutputTypes>, _ctx: HandlerExecutionContext) =>
    async (args: DeserializeHandlerArguments<ServiceInputTypes>): Promise<DeserializeHandlerOutput<ServiceOutputTypes>> => {
      const result = await next(args);
      if (isRawHttpResponse(result.response)) captured = result.response.headers;
      return result;
    };
  const command = new PutObjectCommand({ Bucket: params.bucket, Key: params.key, Body: params.body, ContentType: params.contentType });
  command.middlewareStack.add(middleware as never, { step: "deserialize", name: "captureFilebaseCid", priority: "low" });
  await client.send(command);
  return captured?.["x-amz-meta-cid"];
}

export interface FilebaseIpnsName {
  enabled: boolean;
  label: string;
  network_key: string;
  cid: string;
  sequence: number;
  published_at: string;
  created_at: string;
  updated_at: string;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function listIpnsNames(fetchImpl: FetchLike, token: string): Promise<FilebaseIpnsName[]> {
  const res = await fetchImpl(FILEBASE_NAMES_API, { method: "GET", headers: headers(token) });
  if (!res.ok) throw new Error(`Filebase IPNS list failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as unknown;
  // GET /v1/names returns a bare JSON array (no items wrapper).
  return Array.isArray(body) ? (body as FilebaseIpnsName[]) : [];
}

/**
 * How hard to poll the Names API for the write we just made.
 *
 * The Names API is eventually consistent: the POST/PUT is accepted and returns, but the list
 * endpoint keeps serving the PREVIOUS record for a moment afterwards. Reading back exactly once
 * therefore reports "IPNS readback CID mismatch" for a name that is in fact correct a second later,
 * which is how three of five names on one publish were recorded as failures while the published
 * artifacts were fine. Poll with bounded backoff and only call it a failure once the budget is
 * spent, so a recorded failure means the name really did not move.
 */
export interface IpnsReadbackOptions {
  /** Readback attempts, including the first. */
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Test seam: replaces the real timer so the retry path costs nothing in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_READBACK: Required<IpnsReadbackOptions> = {
  attempts: 6,
  initialDelayMs: 400,
  maxDelayMs: 8_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface IpnsUpsertResult {
  networkKey: string;
  created: boolean;
  /** Readback attempts spent before the name reported the CID we wrote (1 = immediately consistent). */
  readbackAttempts: number;
}

/** Create the label if needed, point it at `cid`, then poll the list endpoint until it agrees. */
export async function upsertIpnsName(
  fetchImpl: FetchLike,
  token: string,
  label: string,
  cid: string,
  options: IpnsReadbackOptions = {},
): Promise<IpnsUpsertResult> {
  const { attempts, initialDelayMs, maxDelayMs, sleep } = { ...DEFAULT_READBACK, ...options };
  const existing = (await listIpnsNames(fetchImpl, token)).find((n) => n.label === label);
  let created = false;
  if (existing === undefined) {
    const res = await fetchImpl(FILEBASE_NAMES_API, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ label, cid, enabled: true }),
    });
    if (!res.ok) throw new Error(`Filebase IPNS create failed for ${label}: ${res.status} ${res.statusText} ${await res.text()}`);
    created = true;
  } else if (existing.cid !== cid) {
    const res = await fetchImpl(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ cid, enabled: true }),
    });
    if (!res.ok) throw new Error(`Filebase IPNS update failed for ${label}: ${res.status} ${res.statusText} ${await res.text()}`);
  }

  let lastProblem = `IPNS readback failed for ${label}`;
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    if (attempt > 1) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
    let verified: FilebaseIpnsName | undefined;
    try {
      verified = (await listIpnsNames(fetchImpl, token)).find((n) => n.label === label);
    } catch (err) {
      // A transient list failure is exactly the case retrying exists for.
      lastProblem = `IPNS readback list failed for ${label}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (verified === undefined || verified.network_key.trim().length === 0) {
      lastProblem = `IPNS readback found no usable record for ${label}`;
      continue;
    }
    if (verified.cid !== cid) {
      lastProblem = `IPNS readback CID mismatch for ${label}: ${verified.cid} != ${cid}`;
      continue;
    }
    return { networkKey: verified.network_key, created, readbackAttempts: attempt };
  }
  throw new Error(`${lastProblem} (after ${Math.max(1, attempts)} readback attempts)`);
}

export function gatewayUrls(gateway: string, networkKey: string): { filebase: string; dweb: string } {
  return { filebase: `${gateway}/ipns/${networkKey}`, dweb: `https://${networkKey}.ipns.dweb.link/` };
}

export function ipfsUrl(gateway: string, cid: string): string {
  return `${gateway}/ipfs/${cid}`;
}
