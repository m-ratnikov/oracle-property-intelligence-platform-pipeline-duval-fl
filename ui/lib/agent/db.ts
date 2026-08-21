/**
 * Server side DuckDB over the published query table.
 *
 * One DuckDB instance per warm process (cached on globalThis, so Next's dev
 * reloads and Vercel's warm invocations reuse it), one view `properties` over
 * the parquet, one short lived connection per statement. The view is the same
 * name the Elephant MCP server builds, so SQL that works here works there.
 *
 * A remote parquet is fetched ONCE per warm process into the temp directory and read from there.
 * Reading it in place over httpfs looked cheaper - only the row groups a query needs - but measured
 * on the deployed function a single preset question spent 158 s of a 172 s turn inside DuckDB,
 * because every query re-fetched row groups through an IPFS gateway that resolves an IPNS name
 * first. One sequential 49 MB download beats many small ranges over that path, and warm invocations
 * then query a local file. If the download fails the httpfs path is still used, so a temp directory
 * that is full or read only degrades instead of breaking.
 *
 * A local file in dev and tests is read in place as before. No extension is installed unless the
 * source is http(s).
 */

import type { Env } from "./types";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { VIEW_NAME } from "@/lib/sql";
import { QUERY_TABLE_OBJECT, resolveArtifactUrl } from "@/lib/config";
import { logAgent } from "./log";

export type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };
export type Row = Record<string, Plain>;

export interface QueryResult {
  columns: string[];
  rows: Row[];
  elapsed_ms: number;
}

export interface PropertyDb {
  /** Where the parquet is read from: a file path or a gateway URL. */
  source: string;
  /** True when the source is the synthetic sample file. */
  isSample: boolean;
  query(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

export const SAMPLE_PARQUET_PATH = resolve(process.cwd(), "public", "sample", "query-table.parquet");

/**
 * The server reads QUERY_TABLE_URL first, then the public variable the
 * browser uses, then the sample file. Relative `/sample/...` values are the
 * browser's fallback and mean "sample" on the server as well.
 */
export function resolveQueryTableSource(env: Env = process.env): {
  source: string;
  isSample: boolean;
} {
  const candidates = [env.QUERY_TABLE_URL, env.NEXT_PUBLIC_QUERY_TABLE_URL];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed)) {
      return { source: resolveArtifactUrl(trimmed, QUERY_TABLE_OBJECT), isSample: false };
    }
    if (!trimmed.startsWith("/sample/") && existsSync(trimmed)) {
      return { source: resolve(trimmed), isSample: false };
    }
  }
  return { source: SAMPLE_PARQUET_PATH, isSample: true };
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "/").replace(/'/g, "''")}'`;
}

/** DuckDB values to JSON safe values, keeping numbers numeric where they fit. */
export function toPlain(value: DuckDBValue | unknown): Plain {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // DuckDB wraps dates, timestamps, decimals, intervals and structs in small
    // value classes. Their toString() is the SQL text form, which is what a
    // reader and the model both want.
    const maybe = value as { toString?: () => string; items?: unknown; entries?: unknown };
    if (maybe.items && Array.isArray(maybe.items)) return maybe.items.map((item) => toPlain(item));
    if (typeof maybe.toString === "function" && maybe.toString !== Object.prototype.toString) {
      return maybe.toString();
    }
    const out: Record<string, Plain> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(item);
    }
    return out;
  }
  return String(value);
}

/** How long to wait for the one-off parquet download before falling back to httpfs range reads. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Fetch the parquet into the temp directory once, and return the local path. Returns null when the
 * download cannot be completed, so the caller falls back to reading the URL in place.
 *
 * Writes to a per-URL temp name and renames, so two invocations racing on a cold start cannot leave
 * a half written file for the other to read.
 */
async function localCopy(source: string): Promise<string | null> {
  try {
    const dir = resolve(tmpdir(), "duval-query-table");
    mkdirSync(dir, { recursive: true });
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const target = resolve(dir, `${digest}.parquet`);
    if (existsSync(target) && statSync(target).size > 0) return target;

    const started = Date.now();
    const response = await fetch(source, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      logAgent("warn", "query table download rejected", { status: response.status, ms: Date.now() - started });
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    // cold start is the only place this runs, and it dominates the first answer, so it is measured
    logAgent("info", "query table downloaded", { bytes: body.length, ms: Date.now() - started });
    // a truncated or error body is worse than no cache: refuse anything that is not a parquet
    if (body.length < 8 || body.subarray(0, 4).toString("latin1") !== "PAR1") return null;
    const partial = `${target}.${process.pid}.partial`;
    writeFileSync(partial, body);
    renameSync(partial, target);
    return target;
  } catch {
    return null;
  }
}

async function createInstance(source: string): Promise<DuckDBInstance> {
  const openedAt = Date.now();
  const isHttp = /^https?:\/\//i.test(source);
  const cached = isHttp ? await localCopy(source) : null;
  const readFrom = cached ?? source;
  const needsHttpfs = isHttp && cached === null;

  const instance = await DuckDBInstance.create(":memory:");
  const setup = await instance.connect();
  try {
    if (needsHttpfs) {
      // Serverless file systems are read only except the temp directory, and
      // httpfs has to be fetched once per cold start.
      const extensionDir = resolve(tmpdir(), "duckdb-extensions");
      await setup.run(`SET extension_directory = ${sqlString(extensionDir)}`);
      await setup.run("INSTALL httpfs");
      await setup.run("LOAD httpfs");
    }
    await setup.run(
      `CREATE OR REPLACE VIEW ${VIEW_NAME} AS SELECT * FROM read_parquet(${sqlString(readFrom)})`,
    );
  } finally {
    setup.closeSync();
  }
  logAgent("info", "query table opened", { ms: Date.now() - openedAt, cached: cached !== null, httpfs: needsHttpfs });
  return instance;
}

async function runQuery(connection: DuckDBConnection, sql: string): Promise<QueryResult> {
  const started = Date.now();
  const result = await connection.runAndReadAll(sql);
  const columns = result.columnNames();
  const rows = (await result.getRowObjects()).map((row) => {
    const out: Row = {};
    for (const column of columns) out[column] = toPlain(row[column]);
    return out;
  });
  return { columns, rows, elapsed_ms: Date.now() - started };
}

/** Open a fresh database over one parquet. Tests use this directly. */
export async function openPropertyDb(
  source: string,
  isSample = source === SAMPLE_PARQUET_PATH,
): Promise<PropertyDb> {
  const instance = await createInstance(source);
  let closed = false;
  return {
    source,
    isSample,
    async query(sql: string) {
      if (closed) throw new Error("database is closed");
      const connection = await instance.connect();
      try {
        return await runQuery(connection, sql);
      } finally {
        connection.closeSync();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      instance.closeSync();
    },
  };
}

type Cache = { source: string; db: Promise<PropertyDb> };
const globalCache = globalThis as unknown as { __duvalPropertyDb?: Cache };

/**
 * The shared database for the route. Cached per process and per source, so a
 * changed QUERY_TABLE_URL in dev picks up the new file without a restart.
 */
export function getPropertyDb(): Promise<PropertyDb> {
  const { source, isSample } = resolveQueryTableSource();
  const cached = globalCache.__duvalPropertyDb;
  if (cached && cached.source === source) return cached.db;
  const db = openPropertyDb(source, isSample).catch((error: unknown) => {
    // A failed open must not poison the cache.
    if (globalCache.__duvalPropertyDb?.db === db) delete globalCache.__duvalPropertyDb;
    throw error;
  });
  globalCache.__duvalPropertyDb = { source, db };
  return db;
}
