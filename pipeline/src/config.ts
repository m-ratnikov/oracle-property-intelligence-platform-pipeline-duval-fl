import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** pipeline/ folder (this file lives in pipeline/src). */
export const PIPELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root (pipeline/..). */
export const REPO_DIR = resolve(PIPELINE_DIR, "..");

/** County identity. Elephant conventions: slug everywhere, DB-style key for source_system. */
export const COUNTY = {
  key: "duval",
  name: "Duval",
  stateCode: "FL",
  fips: "12031",
  fdorCountyNo: "26",
  sourceSystem: "duval_appraiser",
} as const;

/** Minimal .env loader (same quote-stripping rule as the reference publish scripts). */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const dq = value.startsWith('"') && value.endsWith('"');
    const sq = value.startsWith("'") && value.endsWith("'");
    if (value.length >= 2 && (dq || sq)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(PIPELINE_DIR, ".env"));
loadEnvFile(resolve(PIPELINE_DIR, ".env.local"));

export interface Paths {
  dataDir: string;
  dbPath: string;
  artifactsDir: string;
  publishDir: string;
  runsDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  // Default: ../data relative to the REPO root (i.e. outside the repository, next to the checkout).
  const dataDir = resolve(REPO_DIR, env.DATA_DIR ?? "../data");
  return {
    dataDir,
    dbPath: resolve(dataDir, `${COUNTY.key}.duckdb`),
    artifactsDir: resolve(dataDir, "artifacts"),
    publishDir: resolve(dataDir, "artifacts", "publish", COUNTY.key),
    runsDir: resolve(REPO_DIR, "runs"),
  };
}

export function envOrDefault(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]?.trim();
  return v !== undefined && v.length > 0 ? v : fallback;
}
