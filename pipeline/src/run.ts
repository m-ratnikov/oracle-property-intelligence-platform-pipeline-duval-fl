import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ulid } from "ulid";
import { COUNTY, getPaths, type Paths } from "./config.js";
import { all, ensureSchema, one, openDb, q, type Db } from "./db.js";
import { buildFeatures } from "./features/build.js";
import {
  describeQueryTableArtifact,
  exportEntityTables,
  exportQueryTable,
  formatValidation,
  QUERY_TABLE_OBJECT,
  validateQueryTable,
  type ExportResult,
  type QueryTableArtifact,
  type ValidationReport,
} from "./features/export.js";
import { log as rootLog, type Logger } from "./log.js";
import { computeFileCid } from "./publish/cid.js";
import { buildCoverageSnapshot } from "./publish/coverage.js";
import { missingFilebaseEnv, readFilebaseEnv } from "./publish/filebase.js";
import { promoteQueryTable, type GateOutcome } from "./publish/gate.js";
import { insertRunSource, rehydrateRunLog } from "./runLog.js";
import { SOURCES, type TrackName } from "./sources.js";
import { probeUrl } from "./tracks/http.js";
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
  /** Null means "no previous run of this track is recorded", which is unknown, never zero. */
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

/**
 * How this track moved its target table since the previous recorded run of the track, or null
 * when that is not a knowable quantity.
 *
 * Returning `after` for a track with no previous run recorded reported the WHOLE TABLE as the
 * movement. The published `water` row is what that looks like: "inserted 0, updated 0,
 * unchanged 757" and "table delta +757" in the same row, because that database's `run_log` had
 * no earlier water run to subtract. The merge knew nothing had changed; the delta claimed a
 * first load.
 *
 * "No previous run to compare against" is not +757 and it is not 0, which would claim the table
 * did not move. It is unknown, and every consumer renders it as unknown. This is not only a cache
 * artifact either: it is exactly what the first run of a genuinely new county hits.
 */
export function tableDelta(after: number | null, prevTotal: number | null): number | null {
  return after !== null && prevTotal !== null ? after - prevTotal : null;
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
    delta_vs_prev_total: tableDelta(after, prevTotal),
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    status: r.status,
    limitations: r.limitations,
    notes: r.notes,
    error: r.error,
  };
}

/**
 * The most recent table total THIS database recorded for the track, or null when it has none.
 *
 * `rehydrated IS FALSE` is the whole point. The committed `runs/*.json` that rehydrateRunLog loads
 * come from both Actions cache lineages, and those two databases hold different amounts of data, so
 * a rehydrated row's `table_total_after` counts a table this database does not have. Reading the
 * most recent recorded total without asking who recorded it is what published run 01M0JZHQY2SM as
 * "sales 65,876, delta -7,528" on a run that inserted nothing: the previous record was the other
 * lineage's 73,404. `IS FALSE` rather than `NOT rehydrated` so that a NULL from a migrated warm
 * cache is excluded rather than trusted.
 *
 * Null is the answer, not a fallback to a rehydrated total. `tableDelta` renders an absent previous
 * total as unknown and the UI as "no previous run recorded", so a fresh lineage's first run reports
 * unknown deltas honestly and every run after it compares against its own row.
 */
export async function previousTotal(db: Db, track: string): Promise<number | null> {
  const rows = await all<{ t: string | number | null }>(
    db.conn,
    `SELECT table_total_after AS t FROM run_log_sources WHERE track = ${q(track)} AND status = 'completed' AND table_total_after IS NOT NULL
     AND rehydrated IS FALSE
     ORDER BY started_at DESC LIMIT 1`,
  );
  const v = rows[0]?.t;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * DuckDB TIMESTAMP columns hold no zone, and `::VARCHAR` renders them as
 * "2026-08-21 16:34:49.119". Every consumer of run-history.json then has to guess what
 * zone that is, and the guess a browser makes is the wrong one: V8 parses a
 * space separated zoneless stamp as LOCAL time, so a run that started at 16:34 UTC
 * rendered as 09:34 for a reader in +07 and as a run in the future for a reader in the
 * Americas, on a page whose whole claim is continuous refresh.
 *
 * The stamps are written as `new Date().toISOString()` and so are already UTC. Say so in
 * the output: emit ISO-8601 with an explicit Z, the same shape the coverage snapshot has
 * always used (see publish/coverage.ts). `%g` is DuckDB's millisecond specifier, and
 * strftime returns NULL for a NULL timestamp, which is what an unfinished run needs.
 */
const ISO_UTC = "'%Y-%m-%dT%H:%M:%S.%gZ'";

export async function loadRunHistory(db: Db): Promise<RunRecord[]> {
  const runs = await all<Record<string, unknown>>(
    db.conn,
    `SELECT run_id, strftime(started_at, ${ISO_UTC}) AS started_at, strftime(finished_at, ${ISO_UTC}) AS finished_at, status, trigger, git_sha, tracks, "window",
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
    "parcels", "parcel_geometry", "sales_history", "permits", "contractors", "businesses", "business_events", "places",
    "transit_stops", "transit_routes", "water_bodies", "address_points", "coj_parcels", "owners", "entity_links",
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

/** The staging name the gate builds into. Never published: planPublish enumerates objects by name. */
export const QUERY_TABLE_STAGING_OBJECT = "query-table.staging.parquet";

/** The published query table for a publish directory. The only place this path is spelled. */
export function queryTablePath(publishDir: string): string {
  return join(publishDir, QUERY_TABLE_OBJECT);
}

/** Where a query-table build lands before it has earned the published name. */
export function stagedQueryTablePath(publishDir: string): string {
  return join(publishDir, QUERY_TABLE_STAGING_OBJECT);
}

export interface GatedQueryTable {
  /** What this build produced, at the path it now lives at (published on a pass, staged on a fail). */
  exported: ExportResult;
  validation: ValidationReport;
  gate: GateOutcome;
  /** The published-object record for the run log, computed from the bytes that were actually built. */
  artifact: QueryTableArtifact;
}

/**
 * Build the query table, gate it, and promote it. The ONLY way to produce `query-table.parquet`.
 *
 * Three call sites used to spell "export to publishDir/query-table.parquet, then validate": the
 * ingestion run, `pnpm run features`, and the consolidation pass. Two of them exported straight onto
 * the published path and validated afterwards, so by the time the gate had an opinion the last
 * artifact that passed had already been overwritten - which is the opposite of what the gate is for.
 * Only the consolidation pass staged first.
 *
 * Gating inside the one function that knows how to export is what makes the guarantee structural
 * rather than a rule every caller has to remember. A caller cannot obtain a query table without the
 * gate having run, because there is no other exported way to get one: `exportQueryTable` is called
 * here and nowhere else in src (test/query-table-gate.test.ts fails the build if that stops being
 * true), and the two path helpers above are the only place either filename appears.
 *
 * A failed build is left at the staging path on purpose. It is evidence - an operator can open the
 * parquet the gate rejected - and it is unpublishable, because planPublish uploads a fixed list of
 * object names that does not include it. The next build overwrites it.
 */
export async function exportGatedQueryTable(conn: DuckDBConnection, publishDir: string): Promise<GatedQueryTable> {
  const publishPath = queryTablePath(publishDir);
  const stagedPath = stagedQueryTablePath(publishDir);
  const stagedExport = await exportQueryTable(conn, stagedPath);
  const stagedReport = await validateQueryTable(conn, stagedPath);
  const gate = promoteQueryTable({ stagedPath, publishPath, ok: stagedReport.ok });
  const exported: ExportResult = { ...stagedExport, path: gate.builtPath };
  const validation: ValidationReport = { ...stagedReport, parquetPath: gate.builtPath };
  return { exported, validation, gate, artifact: await describeQueryTableArtifact(exported, validation) };
}

/**
 * What a `--publish` flag actually means for this invocation.
 *
 * A publish that was ASKED to upload and cannot is a FAILED publish, not a dry run. The artifact
 * publish command learned that; `publish-open-data` did not, so a run with a missing or misspelled
 * Filebase secret printed a dry-run plan, uploaded nothing, and exited 0 from a step called
 * "Publish to Filebase / IPFS". The operator's evidence that 404k open-data files reached IPFS was
 * a green step that had never opened a socket.
 *
 * Both commands resolve their intent here so the two cannot drift again. `refused` is a hard stop
 * with a reason, never a quiet downgrade to a dry run.
 *
 * This lives in run.ts rather than cli.ts because cli.ts executes `main()` on import and so cannot
 * be imported by a test.
 */
export type PublishMode =
  | { mode: "publish" }
  | { mode: "dry-run" }
  | { mode: "refused"; reason: string; missing: string[] };

export function resolvePublishMode(flags: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv): PublishMode {
  const requested = flags.get("publish") === "true";
  const dryRunRequested = flags.get("dry-run") === "true";
  if (!requested) return { mode: "dry-run" };
  if (dryRunRequested) {
    return {
      mode: "refused",
      reason: "--publish and --dry-run were both given, so what this run was meant to do is not knowable; pass one of them",
      missing: [],
    };
  }
  if (readFilebaseEnv(env) === null) {
    const missing = missingFilebaseEnv(env);
    return { mode: "refused", reason: `publish requested but Filebase settings are missing: ${missing.join(", ")}`, missing };
  }
  return { mode: "publish" };
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

  // Before ANY lookup that reads history. The DuckDB file comes from a branch-scoped Actions
  // cache that rolls, so `run_log` can be empty on a runner whose tables are full; the committed
  // runs/*.json are the durable copy and every runner has them checked out. Gaps only: anything
  // already in run_log wins. The loaded rows are marked `rehydrated` and previousTotal skips them,
  // because they may describe the other lineage's tables (see previousTotal above).
  await rehydrateRunLog(db, { runsDir: paths.runsDir, county: COUNTY.key, logger });

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
  let egressCountry: string | null = null;
  if (opts.tracks.some((t) => SOURCES[t].requiresUsEgress)) {
    try {
      const res = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { country?: string };
      egressCountry = j.country ?? null;
    } catch {
      egressCountry = null;
    }
    logger.info("egress", { country: egressCountry });
  }

  for (const track of opts.tracks) {
    const source = SOURCES[track];
    const runner = TRACK_RUNNERS[track];
    const ctx: TrackContext = { conn: db.conn, runId, paths, logger, window: opts.window, force: opts.force, env: opts.env };
    let result: TrackResult;
    let egressBlock: string | null = null;
    if (runner !== undefined && source.implemented && source.requiresUsEgress && source.probeUrl) {
      const probe = await probeUrl(source.probeUrl);
      if (!probe.reachable) {
        egressBlock = `skipped: non-US egress (HTTP ${probe.status}${probe.error && probe.status === 0 ? `, ${probe.error}` : ""})`;
      }
    }
    if (runner === undefined || !source.implemented) {
      result = startResult(source);
      result.status = "skipped";
      result.limitations.push("track not implemented in this milestone; recorded for coverage honesty");
      result.finishedAt = new Date().toISOString();
      logger.warn("track_skipped", { track, reason: "not implemented", limitations: result.limitations });
    } else if (egressBlock !== null) {
      result = startResult(source);
      result.status = "skipped";
      result.limitations.push(egressBlock);
      result.notes.egress = { probeUrl: source.probeUrl, egressCountry: egressCountry ?? null };
      result.finishedAt = new Date().toISOString();
      logger.warn("track_skipped", { track, reason: egressBlock, probeUrl: source.probeUrl });
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
    await insertRunSource(db, runId, rec);
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
      const gated = await exportGatedQueryTable(db.conn, paths.publishDir);
      validation = gated.validation;
      process.stdout.write(formatValidation(validation) + "\n");
      artifacts.queryTable = gated.artifact;
      if (gated.gate.promoted) {
        logger.info("query_table_gate_passed", { path: gated.gate.publishPath, rows: gated.exported.rows });
      } else {
        logger.error("query_table_validation_failed", {
          problems: validation.problems,
          built: gated.gate.builtPath,
          published: gated.gate.publishPath,
          keptPrevious: gated.gate.keptPrevious,
        });
        runError = `query table validation failed: ${validation.problems.join("; ")} (${gated.gate.message})`;
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
  if (egressCountry !== null) artifacts.egressCountry = egressCountry;
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
