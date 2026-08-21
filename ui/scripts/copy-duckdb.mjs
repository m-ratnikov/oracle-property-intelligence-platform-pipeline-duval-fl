/**
 * Copy the DuckDB-WASM browser runtime out of node_modules into public/duckdb so
 * the app self hosts it instead of pulling it from jsDelivr at runtime.
 *
 * We only ship the eh bundle. The coi bundle needs cross origin isolation
 * (COOP/COEP) which we deliberately do not enable, see next.config.ts.
 */
import { mkdir, copyFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
// The package restricts its `exports` map, so resolve the main entry point
// (dist/duckdb-browser.cjs) and take its directory as the dist folder.
const dist = dirname(require.resolve("@duckdb/duckdb-wasm"));
const outDir = resolve(process.cwd(), "public", "duckdb");

// eh only. The mvp bundle is another 38 MB of static assets and every browser
// we care about supports wasm exception handling. lib/duckdb.ts falls back to
// the jsDelivr bundles if the local eh bundle cannot be instantiated.
const FILES = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];

await mkdir(outDir, { recursive: true });

let bytes = 0;
for (const file of FILES) {
  const from = join(dist, file);
  const to = join(outDir, file);
  await copyFile(from, to);
  bytes += (await stat(to)).size;
}

console.log(
  `[copy-duckdb] copied ${FILES.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) to public/duckdb`,
);
