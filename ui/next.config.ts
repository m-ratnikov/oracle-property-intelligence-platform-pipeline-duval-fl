import type { NextConfig } from "next";

/**
 * DuckDB-WASM notes (see ui/README.md "Constraints hit"):
 * - We ship the `eh` (exception handling, single threaded) bundle, NOT the `coi`
 *   bundle, so the app does NOT need COOP/COEP cross origin isolation headers.
 *   Cross origin isolation would break the OpenStreetMap tile thumbnails and the
 *   IPFS gateway range reads unless every remote host sent CORP headers.
 * - The wasm + worker files are copied out of node_modules into `public/duckdb`
 *   by `scripts/copy-duckdb.mjs` (runs on predev / prebuild) so the runtime is
 *   self hosted and does not depend on a CDN.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @duckdb/duckdb-wasm is browser only. Nothing should try to bundle it on the
  // server, but keeping it external stops the Next server compiler from tracing
  // the .wasm assets into the serverless output.
  // @duckdb/node-api is a native addon used by /api/agent on the server; it
  // must stay external so the bindings binary is traced, not bundled.
  serverExternalPackages: ["@duckdb/duckdb-wasm", "@duckdb/node-api"],
  // The agent route reads the sample parquet and sample JSON from disk when no
  // artifact URL is configured, so those files have to travel with the function.
  // @duckdb/node-bindings resolves a per-platform package and requires its `duckdb.node`.
  // That binary then dynamically links a shared library sitting next to it (libduckdb.so on
  // Linux, duckdb.dll on Windows). Next traces the .node it can see in the require() call but
  // not the .so the loader pulls in later, so on Vercel the route died at module load with
  // "libduckdb.so: cannot open shared object file". Trace the whole Linux platform package.
  // Both spellings are listed because pnpm installs it as a symlink into .pnpm.
  outputFileTracingIncludes: {
    "/api/agent": [
      "./public/sample/**/*",
      "./node_modules/@duckdb/node-bindings-linux-x64/**/*",
      "./node_modules/.pnpm/@duckdb+node-bindings-linux-x64@*/node_modules/@duckdb/node-bindings-linux-x64/**/*",
    ],
  },
  async headers() {
    return [
      {
        // The worker + wasm are immutable per release; let the browser keep them.
        source: "/duckdb/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
