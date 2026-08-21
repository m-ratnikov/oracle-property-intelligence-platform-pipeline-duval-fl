import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { all, q, type Db } from "./db.js";
import type { Logger } from "./log.js";
import type { RunSourceRecord } from "./run.js";

/**
 * `run_log` is not durable, and `runs/*.json` is.
 *
 * The DuckDB file the pipeline writes its history into lives in the GitHub Actions cache. That
 * cache is BRANCH SCOPED and it rolls, so a runner can start with a fully populated set of entity
 * tables and an empty `run_log`: the manual runs warmed the feature branch's cache, the 6-hourly
 * cron fires on the default branch, and the two lineages never see each other's database. Every
 * lookup that reads history then answers "nothing" on a pipeline that has run thirty times:
 *
 *   - dataset-coverage.json's `expected_count`, which reads the last completed run's `rows_staged`
 *   - the last recorded skip reason for a track, which is why a source is unavailable
 *   - the published run history, which is only as long as the database the runner happened to get
 *
 * The durable copy is already on disk and was being ignored. CI commits every completed run to
 * `runs/<run_id>.json`, those files are in the repository, and every runner checks the repository
 * out before the pipeline starts, in every branch lineage. So at pipeline start we load any run the
 * live `run_log` does not already have, and a cold or rolled database knows its own past again.
 *
 * The rules this file exists to hold:
 *
 *   - THE LIVE DATABASE WINS. A run_id already in `run_log` is never rewritten, and a run_id that
 *     already has `run_log_sources` rows never gets a second set. The files fill gaps, nothing else.
 *     That makes a second call a no-op, which is what "idempotent" has to mean here, because the
 *     consolidation command and a pipeline run can both call this against the same database.
 *   - ONE BAD FILE NEVER FAILS THE RUN. Unreadable, another county, or no `run_id` (which is how
 *     the `latest-*.json` publish manifests that share the directory are ignored) is a skip with a
 *     reason, not an exception. `runs/` absent or empty is normal: it is a fresh clone of a county
 *     nobody has ingested yet.
 *   - A FILE LOADS WHOLE OR NOT AT ALL. `run_log.sources` and `run_log_sources` are read by
 *     different consumers, so half a run in one of them and a whole run in the other would be a
 *     disagreement between two artifacts about the same run_id. A source record that cannot be
 *     written skips its whole file.
 *   - TIMESTAMPS LAND AS UTC. See toUtcTimestamp.
 *   - A LOADED ROW IS HISTORY, NOT A MEASUREMENT OF THIS DATABASE. The files come from BOTH cache
 *     lineages and those two databases hold different amounts of data, so a loaded row's
 *     `table_total_after` counts a table this database does not have. Every row this file writes is
 *     marked `rehydrated`, and `previousTotal` (run.ts) reads only rows this database produced.
 *     Ignoring that published run 01M0JZHQY2SM as "sales 65,876, delta -7,528" on a run that
 *     inserted nothing, because the most recent recorded total was the other lineage's 73,404.
 */

/** A file that was not loaded, and why. Reported, never thrown. */
export interface RehydrateSkip {
  file: string;
  reason: string;
}

export interface RehydrateResult {
  dir: string;
  /** `.json` files found in the directory. */
  filesSeen: number;
  /** `run_log` rows this call inserted. */
  runsInserted: number;
  /** Runs the live database already had, left exactly as they were. */
  runsAlreadyPresent: number;
  /** `run_log_sources` rows this call inserted. */
  sourcesInserted: number;
  /** Runs whose `run_log_sources` rows the live database already had. */
  sourcesAlreadyPresent: number;
  skipped: RehydrateSkip[];
}

/**
 * What `insertRunSource` needs, which is a shade wider than what a live track produces: a run
 * record read back from disk may carry a null where the live path always has a value.
 */
export type InsertableRunSource = Omit<RunSourceRecord, "source_url" | "finished_at"> & {
  source_url: string | null;
  finished_at: string | null;
};

/**
 * The one INSERT into `run_log_sources`. The live pipeline path and the rehydrate path both go
 * through it, because the previous-run total (run.ts) and coverage's `expected_count`
 * (publish/coverage.ts) read these columns positionally and a second INSERT that agreed only by
 * inspection would drift.
 *
 * `opts.rehydrated` is the ONE thing the two callers must disagree about, and it defaults to false
 * so that a caller writing a row for a track that just ran against this database says nothing: only
 * `rehydrateRunLog` opts in. See REHYDRATED_COLUMN in db.ts for what the flag protects.
 */
export async function insertRunSource(
  db: Db,
  runId: string,
  s: InsertableRunSource,
  opts: { rehydrated?: boolean } = {},
): Promise<void> {
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  const ts = (v: string | null) => (v === null ? "NULL" : `${q(v)}::TIMESTAMP`);
  await db.conn.run(`
    INSERT INTO run_log_sources VALUES (
      ${q(runId)}, ${q(s.track)}, ${q(s.source_system)}, ${q(s.target_table)}, ${q(s.source_url)},
      ${q(s.artifact_path)}, ${q(s.artifact_sha256)}, ${q(s.artifact_etag)}, ${q(s.artifact_last_modified)}, ${n(s.artifact_bytes)},
      ${q(s.download_status)}, ${s.rows_staged}, ${n(s.inserted)}, ${n(s.updated)}, ${n(s.unchanged)}, ${n(s.missing_in_source)},
      ${n(s.table_total_after)}, ${n(s.delta_vs_prev_total)}, ${ts(s.started_at)}, ${ts(s.finished_at)},
      ${q(s.status)}, ${q(JSON.stringify(s.limitations))}::JSON, ${q(s.error)}, ${opts.rehydrated === true ? "TRUE" : "FALSE"})`);
}

/** Anything ending in Z or an explicit +HH:MM / -HHMM offset already names its zone. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A stamp from a committed run record, as a zoneless UTC literal DuckDB can cast to TIMESTAMP.
 *
 * Two shapes are in the repository, both meaning UTC:
 *
 *   "2026-08-21T19:06:43.726Z"   the current shape (see the ISO_UTC note in run.ts)
 *   "2026-08-21 09:49:58.878"    older files, rendered by DuckDB's ::VARCHAR from a TIMESTAMP the
 *                                pipeline had written from toISOString
 *
 * The second is the trap: it looks local and V8 parses a space separated zoneless stamp AS local,
 * so reading it naively would shift every older run by the runner's offset and reorder the history
 * against the newer records. It is stated as UTC before parsing. Returns null rather than guessing
 * when the value is not a stamp at all, and the caller skips the file.
 */
export function toUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const spaceless = text.replace(" ", "T");
  const ms = Date.parse(ZONED.test(text) ? spaceless : `${spaceless}Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A JSON number, null where the record has none, and `undefined` for a value that is neither. */
function optNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The numeric columns that may legitimately be null (a skipped track observed none of them). */
const NULLABLE_COUNTS = [
  "artifact_bytes",
  "inserted",
  "updated",
  "unchanged",
  "missing_in_source",
  "table_total_after",
  "delta_vs_prev_total",
] as const;

/** One run as the file gives it, already reduced to what the two run-log tables need. */
interface FileRun {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string | null;
  gitSha: string | null;
  tracks: string | null;
  window: string | null;
  sourcesJson: string;
  limitationsJson: string;
  totalsJson: string;
  artifactsJson: string;
  error: string | null;
  sources: InsertableRunSource[];
}

/** An `InsertableRunSource`, or the reason this record cannot become one. */
function readSource(value: unknown, index: number): InsertableRunSource | string {
  if (!isRecord(value)) return `source ${index} is not an object`;
  const track = optString(value.track);
  if (track === null) return `source ${index} has no track`;
  const where = `source ${index} (${track})`;
  const sourceSystem = optString(value.source_system);
  if (sourceSystem === null) return `${where} has no source_system`;
  const targetTable = optString(value.target_table);
  if (targetTable === null) return `${where} has no target_table`;
  const status = optString(value.status);
  if (status === null) return `${where} has no status`;
  const startedAt = toUtcTimestamp(value.started_at);
  if (startedAt === null) return `${where} has no readable started_at`;
  const rowsStaged = optNumber(value.rows_staged);
  if (rowsStaged === undefined || rowsStaged === null) return `${where} has no rows_staged`;

  const counts: Record<string, number | null> = {};
  for (const key of NULLABLE_COUNTS) {
    const parsed = optNumber(value[key]);
    if (parsed === undefined) return `${where} has a non numeric ${key}`;
    counts[key] = parsed;
  }
  const finishedRaw = value.finished_at;
  const finishedAt = finishedRaw === null || finishedRaw === undefined ? null : toUtcTimestamp(finishedRaw);
  if (finishedAt === null && finishedRaw !== null && finishedRaw !== undefined) {
    return `${where} has an unreadable finished_at`;
  }

  return {
    track,
    source_system: sourceSystem,
    target_table: targetTable,
    source_url: optString(value.source_url),
    artifact_path: optString(value.artifact_path),
    artifact_sha256: optString(value.artifact_sha256),
    artifact_etag: optString(value.artifact_etag),
    artifact_last_modified: optString(value.artifact_last_modified),
    artifact_bytes: counts.artifact_bytes ?? null,
    download_status: optString(value.download_status),
    rows_staged: rowsStaged,
    inserted: counts.inserted ?? null,
    updated: counts.updated ?? null,
    unchanged: counts.unchanged ?? null,
    missing_in_source: counts.missing_in_source ?? null,
    table_total_after: counts.table_total_after ?? null,
    delta_vs_prev_total: counts.delta_vs_prev_total ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    limitations: Array.isArray(value.limitations)
      ? value.limitations.filter((l): l is string => typeof l === "string")
      : [],
    notes: isRecord(value.notes) ? value.notes : {},
    error: optString(value.error),
  };
}

/** A `FileRun`, or the reason this file cannot become one. */
export function readRunRecord(text: string, county: string): FileRun | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return `unreadable: ${message(err)}`;
  }
  if (!isRecord(parsed)) return "unreadable: top level is not an object";
  const runId = optString(parsed.run_id);
  // The publish manifests and the latest coverage snapshot share this directory and carry no
  // run_id. They are not runs and this is not an error.
  if (runId === null) return "no run_id";
  const fileCounty = optString(parsed.county);
  if (fileCounty !== null && fileCounty !== county) return `county ${fileCounty}, this pipeline is ${county}`;
  const startedAt = toUtcTimestamp(parsed.started_at);
  if (startedAt === null) return "no readable started_at";
  const status = optString(parsed.status);
  if (status === null) return "no status";
  const finishedRaw = parsed.finished_at;
  const finishedAt = finishedRaw === null || finishedRaw === undefined ? null : toUtcTimestamp(finishedRaw);
  if (finishedAt === null && finishedRaw !== null && finishedRaw !== undefined) {
    return "unreadable finished_at";
  }

  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  const sources: InsertableRunSource[] = [];
  for (let i = 0; i < rawSources.length; i += 1) {
    const source = readSource(rawSources[i], i);
    if (typeof source === "string") return source;
    sources.push(source);
  }

  return {
    runId,
    startedAt,
    finishedAt,
    status,
    trigger: optString(parsed.trigger),
    gitSha: optString(parsed.git_sha),
    // run_log stores the track list comma joined; loadRunHistory splits it back.
    tracks: Array.isArray(parsed.tracks)
      ? parsed.tracks.filter((t): t is string => typeof t === "string").join(",")
      : optString(parsed.tracks),
    window: optString(parsed.window),
    // Republished verbatim, so a rehydrated run reads exactly as it was first published.
    sourcesJson: JSON.stringify(rawSources),
    limitationsJson: JSON.stringify(Array.isArray(parsed.limitations) ? parsed.limitations : []),
    totalsJson: JSON.stringify(isRecord(parsed.totals) ? parsed.totals : {}),
    artifactsJson: JSON.stringify(isRecord(parsed.artifacts) ? parsed.artifacts : {}),
    error: optString(parsed.error),
    sources,
  };
}

async function insertRunLogRow(db: Db, run: FileRun): Promise<void> {
  const finished = run.finishedAt === null ? "NULL" : `${q(run.finishedAt)}::TIMESTAMP`;
  await db.conn.run(`
    INSERT INTO run_log (run_id, started_at, finished_at, status, trigger, git_sha, tracks, "window",
                         sources, limitations, totals, artifacts, error)
    VALUES (${q(run.runId)}, ${q(run.startedAt)}::TIMESTAMP, ${finished}, ${q(run.status)},
            ${q(run.trigger)}, ${q(run.gitSha)}, ${q(run.tracks)}, ${q(run.window)},
            ${q(run.sourcesJson)}::JSON, ${q(run.limitationsJson)}::JSON, ${q(run.totalsJson)}::JSON,
            ${q(run.artifactsJson)}::JSON, ${q(run.error)})`);
}

async function distinctRunIds(db: Db, table: string): Promise<Set<string>> {
  const rows = await all<{ run_id: string }>(db.conn, `SELECT DISTINCT run_id FROM ${table}`);
  return new Set(rows.map((r) => String(r.run_id)));
}

/**
 * Load every run in `runsDir` that the live `run_log` does not already have.
 *
 * Call it after `ensureSchema` and before anything reads history: in a pipeline run that means
 * before the first track computes its previous-run total, since that is the lookup the empty
 * `run_log` was answering wrongly.
 */
export async function rehydrateRunLog(
  db: Db,
  opts: { runsDir: string; county: string; logger: Logger },
): Promise<RehydrateResult> {
  const { runsDir, county, logger } = opts;
  const result: RehydrateResult = {
    dir: runsDir,
    filesSeen: 0,
    runsInserted: 0,
    runsAlreadyPresent: 0,
    sourcesInserted: 0,
    sourcesAlreadyPresent: 0,
    skipped: [],
  };

  if (!existsSync(runsDir)) {
    // A fresh clone of a county nobody has ingested yet. Normal, not an error.
    logger.info("run_log_rehydrate_skipped", { reason: "no runs directory", dir: runsDir });
    return result;
  }
  let names: string[];
  try {
    names = readdirSync(runsDir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort();
  } catch (err) {
    logger.warn("run_log_rehydrate_skipped", { reason: "runs directory unreadable", dir: runsDir, detail: message(err) });
    return result;
  }
  result.filesSeen = names.length;
  if (names.length === 0) {
    logger.info("run_log_rehydrate_skipped", { reason: "runs directory is empty", dir: runsDir });
    return result;
  }

  const haveRun = await distinctRunIds(db, "run_log");
  const haveSources = await distinctRunIds(db, "run_log_sources");

  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(runsDir, name), "utf8");
    } catch (err) {
      result.skipped.push({ file: name, reason: `unreadable: ${message(err)}` });
      continue;
    }
    const run = readRunRecord(text, county);
    if (typeof run === "string") {
      result.skipped.push({ file: name, reason: run });
      continue;
    }
    if (haveRun.has(run.runId)) {
      result.runsAlreadyPresent += 1;
    } else {
      await insertRunLogRow(db, run);
      haveRun.add(run.runId);
      result.runsInserted += 1;
    }
    if (haveSources.has(run.runId)) {
      result.sourcesAlreadyPresent += 1;
      continue;
    }
    for (const source of run.sources) {
      // Marked as this database's own history but NOT as its own measurement: the file may come
      // from the other cache lineage, whose tables are a different size. previousTotal skips these.
      await insertRunSource(db, run.runId, source, { rehydrated: true });
      result.sourcesInserted += 1;
    }
    if (run.sources.length > 0) haveSources.add(run.runId);
  }

  // The manifests that share the directory have no run_id and are skipped every time, so only the
  // other reasons are worth a warning; all of them stay visible in the summary either way.
  for (const skip of result.skipped) {
    if (skip.reason !== "no run_id") {
      logger.warn("run_log_rehydrate_file_skipped", { dir: runsDir, ...skip });
    }
  }
  logger.info("run_log_rehydrated", {
    dir: runsDir,
    files_seen: result.filesSeen,
    runs_inserted: result.runsInserted,
    runs_already_present: result.runsAlreadyPresent,
    sources_inserted: result.sourcesInserted,
    sources_already_present: result.sourcesAlreadyPresent,
    skipped: result.skipped,
  });
  return result;
}
