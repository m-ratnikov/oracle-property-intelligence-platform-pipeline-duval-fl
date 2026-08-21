/**
 * Serve the pipeline's publish directory over HTTP so the UI can run locally against the real
 * artifacts instead of the 480 row sample.
 *
 * DuckDB-WASM reads the parquet with range requests, so this has to answer `Range` properly and
 * expose the range headers to a cross origin caller - a static server that ignores `Range` and
 * returns the whole 47 MB body looks like it works and then reads the wrong bytes. Serving the real
 * artifacts locally is a rehearsal for the hosted runtime, not a substitute: a reviewer cannot reach
 * localhost, and the assignment scores a runtime they cannot open as zero.
 *
 *   node scripts/serve-artifacts.mjs [--dir <publish dir>] [--port 8787]
 */

import { createReadStream, statSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const DIR = resolve(flag("dir", process.env.PUBLISH_DIR ?? "../../data/artifacts/publish/duval"));
const PORT = Number(flag("port", process.env.ARTIFACT_PORT ?? "8787"));

const TYPES = {
  ".parquet": "application/vnd.apache.parquet",
  ".json": "application/json",
  ".csv": "text/csv",
};

if (!existsSync(DIR)) {
  console.error(`publish directory not found: ${DIR}`);
  console.error("run the pipeline first, or pass --dir <path>");
  process.exit(1);
}

/** Resolve a URL path inside DIR, refusing anything that escapes it. */
function resolveInside(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const target = resolve(join(DIR, normalize(decoded)));
  if (target !== DIR && !target.startsWith(DIR + sep)) return null;
  return target;
}

const server = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "range, content-type",
    // without this the browser can read the body but not the range metadata around it
    "access-control-expose-headers": "content-range, content-length, accept-ranges, etag",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, cors);
    res.end();
    return;
  }

  const target = resolveInside(req.url ?? "/");
  if (target === null) {
    res.writeHead(403, cors);
    res.end("outside the served directory");
    return;
  }

  let stat;
  try {
    stat = statSync(target);
    if (stat.isDirectory()) throw new Error("directory");
  } catch {
    res.writeHead(404, cors);
    res.end("not found");
    return;
  }

  const headers = {
    ...cors,
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  };

  const range = req.headers.range;
  if (typeof range === "string" && range.startsWith("bytes=")) {
    const [rawStart, rawEnd] = range.slice(6).split("-");
    let start = rawStart === "" ? undefined : Number(rawStart);
    let end = rawEnd === "" ? undefined : Number(rawEnd);
    // suffix form "bytes=-N" means the last N bytes, which is how a parquet footer is read
    if (start === undefined && end !== undefined) {
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    }
    if (start === undefined) start = 0;
    if (end === undefined) end = stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": String(end - start + 1),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, "content-length": String(stat.size) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
});

server.listen(PORT, () => {
  console.log(`serving ${DIR}`);
  console.log(`  http://localhost:${PORT}/query-table.parquet`);
  console.log(`  http://localhost:${PORT}/run-history.json`);
  console.log("");
  console.log("point ui/.env.local at these, then `pnpm build && pnpm start`");
});
