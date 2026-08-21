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
  mcpUrl: mcpEnv?.trim() ? mcpEnv.trim() : null,
  isSample: sampleArtifacts.length > 0,
  sampleArtifacts,
};

/**
 * IPNS pointers published by the pipeline are directory roots, for example
 * `https://ipfs.filebase.io/ipns/k51.../`. A directory root cannot be range
 * read by DuckDB, so append the object name when the configured URL does not
 * already name a file.
 */
export function resolveArtifactUrl(baseUrl: string, objectName: string): string {
  const [withoutHash] = baseUrl.split("#");
  const [path, query] = withoutHash.split("?");
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const namesAFile = /\.[a-z0-9]{2,8}$/i.test(last);
  if (namesAFile) return baseUrl;
  const joined = `${path.replace(/\/+$/, "")}/${objectName}`;
  return query ? `${joined}?${query}` : joined;
}

export const QUERY_TABLE_OBJECT = "query-table.parquet";

/** The fully resolved parquet URL DuckDB range reads. */
export function queryTableParquetUrl(cfg: AppConfig = config): string {
  return resolveArtifactUrl(cfg.queryTableUrl, QUERY_TABLE_OBJECT);
}

export const ZERO_COST_LINE =
  "Nothing runs when nobody is looking: the data sits on IPFS, GitHub Actions only wakes on a schedule, and every query in this UI executes in your browser with DuckDB-WASM. No database, no server, no standing bill.";
