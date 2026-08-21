import type { DuckDBConnection } from "@duckdb/node-api";
import type { Paths } from "../config.js";
import type { DownloadResult } from "../download.js";
import type { Logger } from "../log.js";
import type { MergeStats } from "../merge.js";
import type { SourceDef, TrackName } from "../sources.js";

export interface TrackContext {
  conn: DuckDBConnection;
  runId: string;
  paths: Paths;
  logger: Logger;
  /** Free-form window argument (e.g. "30d", "2026-08-01..2026-08-21", "500"); tracks interpret it. */
  window: string | null;
  force: boolean;
  env: NodeJS.ProcessEnv;
}

export interface TrackResult {
  track: TrackName;
  sourceSystem: string;
  targetTable: string;
  sourceUrl: string;
  status: "completed" | "skipped" | "failed";
  artifact: DownloadResult | null;
  rowsStaged: number;
  merge: MergeStats | null;
  limitations: string[];
  notes: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export type TrackRunner = (ctx: TrackContext, source: SourceDef) => Promise<TrackResult>;

export function startResult(source: SourceDef): TrackResult {
  return {
    track: source.track,
    sourceSystem: source.sourceSystem,
    targetTable: source.targetTable,
    sourceUrl: source.url,
    status: "failed",
    artifact: null,
    rowsStaged: 0,
    merge: null,
    limitations: [...source.limitations],
    notes: {},
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}
