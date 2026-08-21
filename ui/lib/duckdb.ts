"use client";

/**
 * The query engine. DuckDB-WASM runs inside the visitor's tab and range reads
 * the published parquet straight off the IPFS gateway, so there is no database
 * and no query server anywhere in this system.
 *
 * Load strategy, in order:
 *  1. HTTP protocol registration, which lets DuckDB issue byte range requests
 *     and read only the row groups a query touches.
 *  2. If that fails (a gateway without range support or without permissive
 *     CORS), download the whole object once and register it as a buffer.
 * Either way the bytes end up cached (OPFS, memory fallback) for next time.
 */

import * as duckdb from "@duckdb/duckdb-wasm";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { cacheGet, cachePut } from "./opfs";
import { VIEW_NAME } from "./sql";
import { toPlain } from "./format";

export const REGISTERED_FILE = "query-table.parquet";

export type LoadStage =
  | "idle"
  | "booting"
  | "attaching"
  | "downloading"
  | "ready"
  | "error";

export interface EngineState {
  stage: LoadStage;
  message: string;
  /** 0..1 while downloading, null when the size is unknown or not applicable. */
  progress: number | null;
  error: string | null;
  /** How the parquet ended up in the engine, shown on the Data page. */
  accessMode: "http-range" | "downloaded" | "cached" | null;
  columns: ColumnMeta[];
  rowCount: number | null;
  sourceUrl: string | null;
  bytes: number | null;
  loadedAt: string | null;
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  elapsedMs: number;
  sql: string;
}

const initialState: EngineState = {
  stage: "idle",
  message: "Not started",
  progress: null,
  error: null,
  accessMode: null,
  columns: [],
  rowCount: null,
  sourceUrl: null,
  bytes: null,
  loadedAt: null,
};

let state: EngineState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<EngineState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): EngineState {
  return state;
}

export function getServerState(): EngineState {
  return initialState;
}

/* ----------------------------------------------------------------- engine */

let dbPromise: Promise<AsyncDuckDB> | null = null;
let connection: AsyncDuckDBConnection | null = null;
let loadPromise: Promise<void> | null = null;
let loadedUrl: string | null = null;

/**
 * Worker and wasm URLs must be absolute.
 *
 * The wasm module is fetched from inside the DuckDB worker, and a worker has no
 * document base URL to resolve "/duckdb/duckdb-eh.wasm" against, so a relative
 * path throws "Failed to parse URL" the moment instantiate runs. The same
 * applies to the parquet we register for HTTP range reads.
 */
function absolute(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

const LOCAL_BUNDLE = {
  mainModule: "/duckdb/duckdb-eh.wasm",
  mainWorker: "/duckdb/duckdb-browser-eh.worker.js",
} as const;

async function bootDuckDb(): Promise<AsyncDuckDB> {
  setState({ stage: "booting", message: "Starting DuckDB-WASM in your browser" });
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);

  try {
    const worker = await duckdb.createWorker(absolute(LOCAL_BUNDLE.mainWorker));
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(absolute(LOCAL_BUNDLE.mainModule), null);
    return db;
  } catch (localError) {
    // Fall back to the published CDN bundles if the self hosted copy is missing
    // or the browser cannot use the exception handling build.
    console.warn("[duckdb] local bundle failed, falling back to jsDelivr", localError);
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const worker = await duckdb.createWorker(bundle.mainWorker!);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
  }
}

function getDb(): Promise<AsyncDuckDB> {
  if (!dbPromise) dbPromise = bootDuckDb();
  return dbPromise;
}

async function headMeta(url: string): Promise<{ size: number | null; version: string | null }> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return { size: null, version: null };
    const length = response.headers.get("content-length");
    const version =
      response.headers.get("x-ipfs-roots") ??
      response.headers.get("etag") ??
      response.headers.get("last-modified");
    return { size: length ? Number(length) : null, version };
  } catch {
    return { size: null, version: null };
  }
}

async function downloadWithProgress(url: string, expected: number | null): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status} ${response.statusText} for ${url}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  const total = expected ?? (Number.isFinite(declared) && declared > 0 ? declared : null);

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      setState({
        stage: "downloading",
        progress: total ? Math.min(received / total, 1) : null,
        message: total
          ? `Downloading query table, ${(received / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB`
          : `Downloading query table, ${(received / 1024 / 1024).toFixed(1)} MB`,
      });
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function createView(db: AsyncDuckDB): Promise<AsyncDuckDBConnection> {
  const conn = await db.connect();
  await conn.query(
    `CREATE OR REPLACE VIEW ${VIEW_NAME} AS SELECT * FROM read_parquet('${REGISTERED_FILE}')`,
  );
  return conn;
}

async function describeView(conn: AsyncDuckDBConnection): Promise<ColumnMeta[]> {
  const described = await conn.query(`DESCRIBE ${VIEW_NAME}`);
  return described.toArray().map((row) => {
    const record = row.toJSON() as Record<string, unknown>;
    return {
      name: String(record.column_name ?? ""),
      type: String(record.column_type ?? ""),
      nullable: String(record.null ?? "YES").toUpperCase() !== "NO",
    };
  });
}

async function countRows(conn: AsyncDuckDBConnection): Promise<number | null> {
  const counted = await conn.query(`SELECT COUNT(*) AS n FROM ${VIEW_NAME}`);
  const first = counted.toArray()[0];
  if (!first) return null;
  const value = toPlain((first.toJSON() as Record<string, unknown>).n);
  return typeof value === "number" ? value : Number(value);
}

async function loadParquet(rawUrl: string): Promise<void> {
  const url = absolute(rawUrl);
  const db = await getDb();
  setState({ stage: "attaching", message: "Attaching the published query table", sourceUrl: url });

  const meta = await headMeta(url);

  // 1. Try a cached copy first, it is both the fastest path and gateway free.
  const cached = await cacheGet(url, meta.version);
  if (cached) {
    await db.registerFileBuffer(REGISTERED_FILE, cached);
    const conn = await createView(db);
    connection = conn;
    setState({
      accessMode: "cached",
      bytes: cached.byteLength,
      columns: await describeView(conn),
      rowCount: await countRows(conn),
      stage: "ready",
      progress: null,
      message: "Ready, served from the browser cache",
      loadedAt: new Date().toISOString(),
    });
    return;
  }

  // 2. Range reads over HTTP. No full download, DuckDB fetches only what a query
  //    needs. This is the mode we want against an IPFS gateway.
  try {
    await db.registerFileURL(REGISTERED_FILE, url, duckdb.DuckDBDataProtocol.HTTP, false);
    const conn = await createView(db);
    const columns = await describeView(conn);
    const rows = await countRows(conn);
    connection = conn;
    setState({
      accessMode: "http-range",
      bytes: meta.size,
      columns,
      rowCount: rows,
      stage: "ready",
      progress: null,
      message: "Ready, range reading the parquet over HTTP",
      loadedAt: new Date().toISOString(),
    });
    return;
  } catch (rangeError) {
    console.warn("[duckdb] HTTP range read failed, downloading the whole object", rangeError);
  }

  // 3. Whole object download, then register as a buffer.
  setState({ stage: "downloading", message: "Downloading query table", progress: 0 });
  const bytes = await downloadWithProgress(url, meta.size);
  await cachePut(url, meta.version, bytes);
  await db.registerFileBuffer(REGISTERED_FILE, bytes);
  const conn = await createView(db);
  connection = conn;
  setState({
    accessMode: "downloaded",
    bytes: bytes.byteLength,
    columns: await describeView(conn),
    rowCount: await countRows(conn),
    stage: "ready",
    progress: null,
    message: "Ready, downloaded once and cached in your browser",
    loadedAt: new Date().toISOString(),
  });
}

/** Idempotent. Every page calls this, only the first call does work. */
export function ensureLoaded(url: string): Promise<void> {
  if (loadedUrl === url && loadPromise) return loadPromise;
  loadedUrl = url;
  loadPromise = loadParquet(url).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState({ stage: "error", error: message, message: "Could not load the query table" });
    throw error;
  });
  return loadPromise;
}

export async function getConnection(url: string): Promise<AsyncDuckDBConnection> {
  await ensureLoaded(url);
  if (!connection) throw new Error("DuckDB connection is not available");
  return connection;
}

export async function runQuery(url: string, sql: string): Promise<QueryResult> {
  const conn = await getConnection(url);
  const started = performance.now();
  const table = await conn.query(sql);
  const columns = table.schema.fields.map((field) => field.name);
  const rows = table.toArray().map((row) => {
    const record = row.toJSON() as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const column of columns) out[column] = toPlain(record[column]);
    return out;
  });
  return { columns, rows, elapsedMs: performance.now() - started, sql };
}

/** Reset so a reload picks up a freshly published artifact. */
export async function resetEngine(): Promise<void> {
  try {
    await connection?.close();
  } catch {
    // ignore
  }
  connection = null;
  loadPromise = null;
  loadedUrl = null;
  dbPromise = null;
  state = initialState;
  for (const listener of listeners) listener();
}
