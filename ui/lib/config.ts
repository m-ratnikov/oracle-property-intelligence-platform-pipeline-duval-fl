/**
 * Runtime configuration.
 *
 * Every artifact URL comes from a NEXT_PUBLIC_* environment variable that is
 * inlined at build time. When a variable is absent the app falls back to the
 * synthetic files in `public/sample` and flags itself as SAMPLE everywhere, so
 * a reader can never mistake generated rows for published county records.
 *
 * NOTE: process.env.NEXT_PUBLIC_* must be referenced with a literal key for the
 * Next compiler to inline it. Do not refactor these into a loop.
 */

export const SAMPLE_PATHS = {
  queryTable: "/sample/query-table.parquet",
  runHistory: "/sample/run-history.json",
  coverage: "/sample/dataset-coverage.json",
  catalog: "/sample/catalog.json",
  openDataIndex: "/sample/open-data/index.json",
  artifactsIndex: "/sample/artifacts-index.json",
} as const;

function pick(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

const queryTableEnv = process.env.NEXT_PUBLIC_QUERY_TABLE_URL;
const runHistoryEnv = process.env.NEXT_PUBLIC_RUN_HISTORY_URL;
const coverageEnv = process.env.NEXT_PUBLIC_COVERAGE_URL;
const catalogEnv = process.env.NEXT_PUBLIC_CATALOG_URL;
const openDataEnv = process.env.NEXT_PUBLIC_OPEN_DATA_INDEX_URL;
const artifactsIndexEnv = process.env.NEXT_PUBLIC_ARTIFACTS_INDEX_URL;
const mcpEnv = process.env.NEXT_PUBLIC_MCP_URL;

export interface AppConfig {
  countyKey: string;
  countyName: string;
  stateCode: string;
  queryTableUrl: string;
  runHistoryUrl: string;
  coverageUrl: string;
  catalogUrl: string;
  openDataIndexUrl: string | null;
  /**
   * The published artifacts index: every uploaded object with its gateway URL and, where the
   * artifact has one, its IPNS name. Artifact cards join run records to it so they can show a
   * real link instead of "not available" twice.
   */
  artifactsIndexUrl: string;
  mcpUrl: string | null;
  /** True when at least one artifact URL fell back to public/sample. */
  isSample: boolean;
  /** Which artifacts are synthetic, for per panel SAMPLE badges. */
  sampleArtifacts: string[];
}

const sampleArtifacts: string[] = [];
if (!queryTableEnv?.trim()) sampleArtifacts.push("query-table.parquet");
if (!runHistoryEnv?.trim()) sampleArtifacts.push("run-history.json");
if (!coverageEnv?.trim()) sampleArtifacts.push("dataset-coverage.json");
if (!catalogEnv?.trim()) sampleArtifacts.push("catalog.json");
/*
 * NEXT_PUBLIC_ARTIFACTS_INDEX_URL is deliberately NOT in the list above, and neither are the
 * open data index or the MCP base URL. This list is what flips the whole runtime to SAMPLE, and
 * it must hold exactly the artifacts the pages are about: the query table, the run history, the
 * coverage snapshot and the catalog. The artifacts index only decorates cards whose CIDs come
 * from the run history, so a deployment that has not set it is still serving published data and
 * must not be branded SAMPLE for it. Adding a fifth entry here would do exactly that.
 */

export const config: AppConfig = {
  countyKey: pick(process.env.NEXT_PUBLIC_COUNTY_KEY, "duval"),
  // The word "County" is added by the templates, so this is the bare name.
  countyName: pick(process.env.NEXT_PUBLIC_COUNTY_NAME, "Duval"),
  stateCode: pick(process.env.NEXT_PUBLIC_STATE_CODE, "FL"),
  queryTableUrl: pick(queryTableEnv, SAMPLE_PATHS.queryTable),
  runHistoryUrl: pick(runHistoryEnv, SAMPLE_PATHS.runHistory),
  coverageUrl: pick(coverageEnv, SAMPLE_PATHS.coverage),
  catalogUrl: pick(catalogEnv, SAMPLE_PATHS.catalog),
  openDataIndexUrl: pick(openDataEnv, SAMPLE_PATHS.openDataIndex),
  artifactsIndexUrl: pick(artifactsIndexEnv, SAMPLE_PATHS.artifactsIndex),
  mcpUrl: mcpEnv?.trim() ? mcpEnv.trim() : null,
  isSample: sampleArtifacts.length > 0,
  sampleArtifacts,
};

/**
 * Resolve a configured artifact URL to the exact object DuckDB should range read.
 *
 * A trailing slash means "this is a directory, append the object name"; anything else addresses
 * the object directly and is used unchanged.
 *
 * The trailing slash has to carry that meaning because nothing else can. This publisher points
 * each IPNS name at a single file's CID, so the query table lives at `/ipns/k51...` with nothing
 * after it - while the Elephant convention also permits a name pointing at a directory, which
 * looks identical as a string. An earlier version guessed from a file extension, decided a bare
 * `/ipns/k51...` had to be a directory, and requested `/ipns/k51.../query-table.parquet`. The
 * gateway returned 404, DuckDB fell back to downloading the whole object, got the same 404, and
 * the deployed page showed "DuckDB-WASM could not load the query table" against a perfectly good
 * artifact.
 */
export function resolveArtifactUrl(baseUrl: string, objectName: string): string {
  const [withoutHash] = baseUrl.split("#");
  const [path = "", query] = withoutHash.split("?");
  if (!path.endsWith("/")) return baseUrl;
  const joined = `${path.replace(/\/+$/, "")}/${objectName}`;
  return query ? `${joined}?${query}` : joined;
}

export const QUERY_TABLE_OBJECT = "query-table.parquet";

/** The fully resolved parquet URL DuckDB range reads. */
export function queryTableParquetUrl(cfg: AppConfig = config): string {
  return resolveArtifactUrl(cfg.queryTableUrl, QUERY_TABLE_OBJECT);
}

/**
 * Where the DuckDB-WASM build fetches its parquet reader from. Named here so the document can open
 * the connection before the engine asks for it.
 */
export const DUCKDB_EXTENSION_ORIGIN = "https://extensions.duckdb.org";

/**
 * Distinct origins this app talks to for published data.
 *
 * Every artifact is a cross origin request to an IPFS gateway, and the first one pays DNS, TLS and
 * the gateway's IPNS resolution before a single byte arrives. Opening those connections while the
 * document is still parsing takes that cost off the critical path of the stat tiles.
 */
export function artifactOrigins(cfg: AppConfig = config): string[] {
  const origins = new Set<string>();
  const candidates = [
    cfg.queryTableUrl,
    cfg.runHistoryUrl,
    cfg.coverageUrl,
    cfg.catalogUrl,
    cfg.openDataIndexUrl,
    cfg.artifactsIndexUrl,
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("/")) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // A malformed configured URL is reported by the page that uses it, not here.
    }
  }
  origins.add(DUCKDB_EXTENSION_ORIGIN);
  return [...origins];
}

export const ZERO_COST_LINE =
  "Nothing runs when nobody is looking: the data sits on IPFS, GitHub Actions only wakes on a schedule, and every query in this UI executes in your browser with DuckDB-WASM. No database, no server, no standing bill.";
