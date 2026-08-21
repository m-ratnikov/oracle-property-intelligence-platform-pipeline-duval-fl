import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { Logger } from "./log.js";

export type DownloadStatus = "downloaded" | "unchanged" | "existing" | "failed";

export interface ArtifactMeta {
  url: string;
  etag: string | null;
  lastModified: string | null;
  bytes: number;
  sha256: string;
  fetchedAt: string;
}

export interface DownloadResult extends ArtifactMeta {
  /** Absolute path of the artifact on disk. */
  path: string;
  /** Path relative to the artifacts root (stored as provenance). */
  relPath: string;
  status: DownloadStatus;
}

/** Deterministic artifact file name derived from the URL's last segment. */
export function artifactFileName(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "artifact");
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function readMeta(metaPath: string): ArtifactMeta | null {
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as ArtifactMeta;
  } catch {
    return null;
  }
}

interface RemoteHead {
  etag: string | null;
  lastModified: string | null;
  bytes: number | null;
}

async function headRemote(url: string, fetchImpl: typeof fetch): Promise<RemoteHead | null> {
  try {
    const res = await fetchImpl(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return {
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      bytes: len !== null ? Number(len) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Download `url` into `destDir` idempotently.
 *  - HEAD first; when the sidecar `.meta.json` carries the same ETag (or Last-Modified + size)
 *    and the file is present, nothing is fetched (status "unchanged").
 *  - A pre-existing file without a sidecar whose size matches the remote is adopted
 *    (status "existing") so a manual download is not repeated.
 *  - Otherwise streams to `<file>.part`, hashing on the fly, then renames atomically.
 */
export async function downloadArtifact(opts: {
  url: string;
  destDir: string;
  artifactsRoot: string;
  fileName?: string;
  force?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  mkdirSync(opts.destDir, { recursive: true });
  const fileName = opts.fileName ?? artifactFileName(opts.url);
  const path = join(opts.destDir, fileName);
  const metaPath = `${path}.meta.json`;
  const relPath = relative(opts.artifactsRoot, path).replace(/\\/g, "/");
  const log = opts.logger.child({ artifact: relPath });

  const head = await headRemote(opts.url, fetchImpl);
  const meta = readMeta(metaPath);
  const fileExists = existsSync(path);

  if (!opts.force && meta !== null && fileExists && head !== null) {
    const sameEtag = head.etag !== null && meta.etag !== null && head.etag === meta.etag;
    // Last-Modified + size is only trusted when the server gives no ETag at all.
    const sameLm =
      head.etag === null &&
      head.lastModified !== null &&
      meta.lastModified !== null &&
      head.lastModified === meta.lastModified &&
      head.bytes === meta.bytes;
    if (sameEtag || sameLm) {
      log.info("artifact_unchanged", { etag: head.etag, lastModified: head.lastModified, bytes: meta.bytes });
      return { ...meta, path, relPath, status: "unchanged" };
    }
  }

  if (!opts.force && meta === null && fileExists && head !== null && head.bytes !== null && statSync(path).size === head.bytes) {
    const sha256 = await sha256File(path);
    const adopted: ArtifactMeta = {
      url: opts.url,
      etag: head.etag,
      lastModified: head.lastModified,
      bytes: head.bytes,
      sha256,
      fetchedAt: new Date(statSync(path).mtimeMs).toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(adopted, null, 2));
    log.info("artifact_adopted_existing", { bytes: head.bytes, sha256 });
    return { ...adopted, path, relPath, status: "existing" };
  }

  log.info("artifact_download_start", { url: opts.url, remoteBytes: head?.bytes ?? null });
  const started = Date.now();
  const res = await fetchImpl(opts.url, { method: "GET", redirect: "follow" });
  if (!res.ok || res.body === null) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} for ${opts.url}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const partPath = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), tap, createWriteStream(partPath));
  renameSync(partPath, path);
  const fetchedAt = new Date().toISOString();
  const result: ArtifactMeta = {
    url: opts.url,
    etag: res.headers.get("etag") ?? head?.etag ?? null,
    lastModified: res.headers.get("last-modified") ?? head?.lastModified ?? null,
    bytes,
    sha256: hash.digest("hex"),
    fetchedAt,
  };
  writeFileSync(metaPath, JSON.stringify(result, null, 2));
  log.info("artifact_download_done", { bytes, sha256: result.sha256, ms: Date.now() - started, file: basename(path) });
  return { ...result, path, relPath, status: "downloaded" };
}
