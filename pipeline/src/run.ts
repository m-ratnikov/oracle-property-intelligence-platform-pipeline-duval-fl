import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { COUNTY, getPaths, type Paths } from "./config.js";
import { all, ensureSchema, one, openDb, q, type Db } from "./db.js";
import { buildFeatures } from "./features/build.js";
import { exportEntityTables, exportQueryTable, formatValidation, validateQueryTable, type ValidationReport } from "./features/export.js";
import { log as rootLog, type Logger } from "./log.js";
import { computeFileCid } from "./publish/cid.js";
import { buildCoverageSnapshot } from "./publish/coverage.js";
import { SOURCES, type TrackName } from "./sources.js";
import { TRACK_RUNNERS } from "./tracks/index.js";
import type { TrackContext, TrackResult } from "./tracks/types.js";
import { startResult } from "./tracks/types.js";

export interface RunOptions {
  tracks: TrackName[];
  window: string | null;
  trigger: string;
  force: boolean;
  skipFeatures: boolean;
  env: NodeJS.ProcessEnv;
  logger?: Logger;
  paths?: Paths;
}

export interface RunSourceRecord {
  track: string;
  source_system: string;
  target_table: string;
  source_url: string;
  artifact_path: string | null;
  artifact_sha256: string | null;
  artifact_etag: string | null;
  artifact_last_modified: string | null;
  artifact_bytes: number | null;
  download_status: string | null;
  rows_staged: number;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  missing_in_source: number | null;
  table_total_after: number | null;
  delta_vs_prev_total: number | null;
  started_at: string;
  finished_at: string;
  status: string;
  limitations: string[];
  notes: Record<string, unknown>;
  error: string | null;
}

export interface RunRecord {
  run_id: string;
  county: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  git_sha: string | null;
  tracks: string[];
  window: string | null;
  sources: RunSourceRecord[];
  limitations: string[];
  totals: Record<string, number>;
  artifacts: Record<string, unknown>;
  error: string | null;
}

function gitSha(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function toSourceRecord(r: TrackResult, prevTotal: number | null): RunSourceRecord {
  const after = r.merge?.totalAfter ?? null;
  return {
    track: r.track,
    source_system: r.sourceSystem,
    target_table: r.targetTable,
    source_url: r.sourceUrl,
    artifact_path: r.artifact?.relPath ?? null,
    artifact_sha256: r.artifact?.sha256 ?? null,
    artifact_etag: r.artifact?.etag ?? null,
    artifact_last_modified: r.artifact?.lastModified ?? null,
    artifact_bytes: r.artifact?.bytes ?? null,
    download_status: r.artifact?.status ?? null,
    rows_staged: r.rowsStaged,
    inserted: r.merge?.inserted ?? null,
    updated: r.merge?.updated ?? null,
    unchanged: r.merge?.unchanged ?? null,
    missing_in_source: r.merge?.missingInSource ?? null,
    table_total_after: after,
    delta_vs_prev_total: after !== null && prevTotal !== null ? after - prevTotal : after,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    status: r.status,
    limitations: r.limitations,
    notes: r.notes,
    error: r.error,
  };
}

async function previousTotal(db: Db, track: string): Promise<number | null> {
  const rows = await all<{ t: string | number | null }>(
    db.conn,
    `SELECT table_total_after AS t FROM run_log_sources WHERE track = ${q(track)} AND status = 'completed' AND table_total_after IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`,
  );
  const v = rows[0]?.t;
  return v === null || v === undefined ? null : Number(v);
}

async function insertSourceRecord(db: Db, runId: string, s: RunSourceRecord): Promise<void> {
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  await db.conn.run(`
    INSERT INTO run_log_sources VALUES (
      ${q(runId)}, ${q(s.track)}, ${q(s.source_system)}, ${q(s.target_table)}, ${q(s.source_url)},
      ${q(s.artifact_path)}, ${q(s.artifact_sha256)}, ${q(s.artifact_etag)}, ${q(s.artifact_last_modified)}, ${n(s.artifact_bytes)},
      ${q(s.download_status)}, ${s.rows_staged}, ${n(s.inserted)}, ${n(s.updated)}, ${n(s.unchanged)}, ${n(s.missing_in_source)},
      ${n(s.table_total_after)}, ${n(s.delta_vs_prev_total)}, ${q(s.started_at)}::TIMESTAMP, ${q(s.finished_at)}::TIMESTAMP,
      ${q(s.status)}, ${q(JSON.stringify(s.limitations))}::JSON, ${q(s.error)})`);
}

export async function loadRunHistory(db: Db): Promise<RunRecord[]> {
  const runs = await all<Record<string, unknown>>(
    db.conn,
    `SELECT run_id, started_at::VARCHAR AS started_at, finished_at::VARCHAR AS finished_at, status, trigger, git_sha, tracks, "window",
            sources::VARCHAR AS sources, limitations::VARCHAR AS limitations, totals::VARCHAR AS totals, artifacts::VARCHAR AS artifacts, error
     FROM run_log ORDER BY started_at DESC`,
  );
  const parse = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== "string") return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  return runs.map((r) => ({
    run_id: String(r.run_id),
    county: COUNTY.key,
    started_at: String(r.started_at),
    finished_at: r.finished_at === null ? null : String(r.finished_at),
    status: String(r.status),
    trigger: String(r.trigger ?? ""),
    git_sha: r.git_sha === null ? null : String(r.git_sha),
    tracks: String(r.tracks ?? "").split(",").filter(Boolean),
    window: r.window === null ? null : String(r.window),
    sources: parse<RunSourceRecord[]>(r.sources, []),
    limitations: parse<string[]>(r.limitations, []),
    totals: parse<Record<string, number>>(r.totals, {}),
    artifacts: parse<Record<string, unknown>>(r.artifacts, {}),
    error: r.error === null ? null : String(r.error),
  }));
}

export async function tableTotals(db: Db): Promise<Record<string, number>> {
  const tables = [
    "parcels", "parcel_geometry", "sales_history", "permits", "contractors", "businesses", "places",
    "transit_stops", "water_bodies", "address_points", "entity_links",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await one<{ n: string | number }>(db.conn, `SELECT count(*) AS n FROM ${t}`);
    out[t] = Number(r.n);
  }
  const f = await all<{ n: string | number }>(
    db.conn,
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'derived' AND table_name = 'properties_features'",
  );
  if (Number(f[0]?.n ?? 0) > 0) {
    out["derived.properties_features"] = Number((await one<{ n: string | number }>(db.conn, "SELECT count(*) AS n FROM derived.properties_features")).n);
  }
  return out;
}

export async function writeRunHistoryFiles(db: Db, paths: Paths, runId: string): Promise<{ runFile: string; historyFile: string }> {
  const history = await loadRunHistory(db);
  mkdirSync(paths.publishDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  const historyFile = join(paths.publishDir, "run-history.json");
  writeFileSync(
    historyFile,
    JSON.stringify({ county: COUNTY.key, generatedAt: new Date().toISOString(), runCount: history.length, runs: history }, null, 2),
  );
  const runFile = join(paths.runsDir, `${runId}.json`);
  const thisRun = history.find((r) => r.run_id === runId);
  if (thisRun) writeFileSync(runFile, JSON.stringify(thisRun, null, 2));
  return { runFile, historyFile };
}

/**
 * One pipeline run: run_id -> run_log(start) -> each track (download, stage, merge, deltas) ->
 * features -> query-table parquet + validation gate -> entity parquet -> coverage snapshot ->
 * run-history.json + runs/<run_id>.json -> run_log(finish).
 */
export async function runPipeline(opts: RunOptions): Promise<{ run: RunRecord; validation: ValidationReport | null }> {
  const paths = opts.paths ?? getPaths(opts.env);
  const runId = ulid();
  const logger = (opts.logger ?? rootLog).child({ run_id: runId });
  const startedAt = new Date().toISOString();
  const sha = gitSha(opts.env);
  mkdirSync(paths.dataDir, { recursive: true });
  const db = await openDb(paths.dbPath);
  await ensureSchema(db.conn);
  logger.info("run_start", { tracks: opts.tracks, window: opts.window, trigger: opts.trigger, git_sha: sha, db: paths.dbPath });

  // A previous process that died mid-run leaves status 'running'; close it out honestly.
  await db.conn.run(
    `UPDATE run_log SET status = 'aborted', finished_at = ${q(startedAt)}::TIMESTAMP,
       error = 'process exited before the run finished' WHERE status = 'running'`,
  );
  await db.conn.run(`
    INSERT INTO run_log (run_id, started_at, status, trigger, git_sha, tracks, "window")
    VALUES (${q(runId)}, ${q(startedAt)}::TIMESTAMP, 'running', ${q(opts.trigger)}, ${q(sha)}, ${q(opts.tracks.join(","))}, ${q(opts.window)})`);

  const sources: RunSourceRecord[] = [];
  const limitations = new Set<string>();
  let failed = 0;

  for (const track of opts.tracks) {
    const source = SOURCES[track];
    const runner = TRACK_RUNNERS[track];
    const ctx: TrackContext = { conn: db.conn, runId, paths, logger, window: opts.window, force: opts.force, env: opts.env };
    let result: TrackResult;
    if (runner === undefined || !source.implemented) {
      result = startResult(source);
      result.status = "skipped";
      result.limitations.push("track not implemented in this milestone; recorded for coverage honesty");
      result.finishedAt = new Date().toISOString();
      logger.warn("track_skipped", { track, reason: "not implemented", limitations: result.limitations });
    } else {
      logger.info("track_start", { track, source: source.title, url: source.url });
      try {
        result = await runner(ctx, source);
        logger.info("track_done", { track, status: result.status, rowsStaged: result.rowsStaged, merge: result.merge });
      } catch (err) {
        failed += 1;
        result = startResult(source);
        result.status = "failed";
        result.error = err instanceof Error ? err.message : String(err);
        result.finishedAt = new Date().toISOString();
        logger.error("track_failed", { track, error: result.error });
      }
    }
    const prev = await previousTotal(db, track);
    const rec = toSourceRecord(result, prev);
    for (const l of rec.limitations) limitations.add(`${track}: ${l}`);
    await insertSourceRecord(db, runId, rec);
    sources.push(rec);
  }

  let validation: ValidationReport | null = null;
  const artifacts: Record<string, unknown> = {};
  let runError: string | null = null;
  if (!opts.skipFeatures) {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const fs = await buildFeatures(db.conn, { asOf, runId });
      logger.info("features_built", { ...fs });
      const qtPath = join(paths.publishDir, "query-table.parquet");
      const exp = await exportQueryTable(db.conn, qtPath);
      validation = await validateQueryTable(db.conn, qtPath);
      process.stdout.write(formatValidation(validation) + "\n");
      const qtCid = await computeFileCid(qtPath);
      artifacts.queryTable = { path: "query-table.parquet", rows: exp.rows, bytes: exp.bytes, sha256: qtCid.sha256, cid: qtCid.cid, cidV1: qtCid.cidV1, validationOk: validation.ok, problems: validation.problems };
      if (!validation.ok) {
        logger.error("query_table_validation_failed", { problems: validation.problems });
        runError = `query table validation failed: ${validation.problems.join("; ")}`;
      }
      const tables = await exportEntityTables(db.conn, join(paths.publishDir, "tables"));
      const tableArtifacts: Record<string, unknown> = {};
      for (const t of tables) {
        const c = await computeFileCid(t.path);
        tableArtifacts[t.table] = { path: `tables/${t.table}.parquet`, rows: t.rows, bytes: t.bytes, sha256: c.sha256, cid: c.cid, cidV1: c.cidV1 };
      }
      artifacts.tables = tableArtifacts;
      logger.info("entity_tables_exported", { tables: tables.map((t) => ({ table: t.table, rows: t.rows, bytes: t.bytes })) });
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      logger.error("features_failed", { error: runError });
    }
  }

  const totals = await tableTotals(db);
  const status = runError !== null ? "failed" : failed > 0 ? "completed_with_errors" : "completed";
  const finishedAt = new Date().toISOString();
  await db.conn.run(`
    UPDATE run_log SET finished_at = ${q(finishedAt)}::TIMESTAMP, status = ${q(status)},
      sources = ${q(JSON.stringify(sources))}::JSON, limitations = ${q(JSON.stringify([...limitations]))}::JSON,
      totals = ${q(JSON.stringify(totals))}::JSON, artifacts = ${q(JSON.stringify(artifacts))}::JSON, error = ${q(runError)}
    WHERE run_id = ${q(runId)}`);

  // Coverage snapshot reflects the state after this run (cids of entity tables are local CIDs).
  const artifactRefs: Partial<Record<TrackName, { cid: string | null; ipnsLabel: string | null }>> = {};
  const tableArtifacts = (artifacts.tables ?? {}) as Record<string, { cid: string }>;
  for (const s of Object.values(SOURCES)) {
    const ta = tableArtifacts[s.targetTable];
    if (ta) artifactRefs[s.track] = { cid: ta.cid, ipnsLabel: `${COUNTY.key}-oracle-artifacts` };
  }
  const coverage = await buildCoverageSnapshot(db.conn, { exportedAt: finishedAt, artifactRefs });
  mkdirSync(paths.publishDir, { recursive: true });
  writeFileSync(join(paths.publishDir, "dataset-coverage.json"), JSON.stringify(coverage, null, 2));
  const covCid = await computeFileCid(join(paths.publishDir, "dataset-coverage.json"));
  artifacts.coverage = { path: "dataset-coverage.json", bytes: covCid.bytes, sha256: covCid.sha256, cid: covCid.cid, cidV1: covCid.cidV1 };
  await db.conn.run(`UPDATE run_log SET artifacts = ${q(JSON.stringify(artifacts))}::JSON WHERE run_id = ${q(runId)}`);

  const files = await writeRunHistoryFiles(db, paths, runId);
  const history = await loadRunHistory(db);
  const run = history.find((r) => r.run_id === runId);
  if (run === undefined) throw new Error("run record missing after write");
  logger.info("run_done", { status, totals, runFile: files.runFile, historyFile: files.historyFile, failedTracks: failed });
  await db.close();
  if (status === "failed") throw new Error(runError ?? "run failed");
  return { run, validation };
}
