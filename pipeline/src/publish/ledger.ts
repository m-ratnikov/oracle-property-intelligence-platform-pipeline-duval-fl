import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTY, type Paths } from "../config.js";
import type { CiHistoryProvenance, CiWorkflowRun } from "./ciHistory.js";

/**
 * Two small committed files that make the pipeline's continuity provable without a database.
 *
 *   runs/ci-runs.json         which CI event produced each run (Task: prove the 6-hourly schedule)
 *   runs/table-highwater.json the largest each accumulating table has ever been (Task: cache loss)
 *
 * Both live in `runs/`, next to the per-run records, because that directory is the ONLY durable
 * copy of what this pipeline has done. The DuckDB working set lives in a GitHub Actions cache,
 * which is branch scoped and evicted after seven days without a hit; `run_log` therefore cannot be
 * trusted to remember anything. Both files are rebuilt by merging what is on disk with what this
 * run knows, keyed so a re-run repairs its own entry and never truncates the rest, which also makes
 * them safe under the concurrent commit-back the workflow does.
 *
 * `ci-runs.json` carries two layers, and they answer different questions:
 *
 *   workflow_runs  every run of the workflow, DERIVED from the GitHub Actions API (ciHistory.ts).
 *                  This is what "is the cron actually running" is answered from, because GitHub
 *                  keeps it whatever we do to branches and it covers ticks that happened before
 *                  this code existed. A force-push cannot reset it: the next run re-derives it.
 *   runs           the pipeline's own record of each run it executed, with the run KIND and the
 *                  ULID that ties the CI run to runs/<run_id>.json and to the published history.
 *
 * The two are merged independently and keyed independently, so the reconcile never disturbs a
 * pipeline record and a pipeline record never disturbs the reconciled history.
 */

// ---------------------------------------------------------------------------- CI run ledger

export interface CiRunEntry {
  run_id: string;
  /** `ingestion` is a pipeline run over the source tracks; `consolidation` is the open-data export pass. */
  kind: "ingestion" | "consolidation";
  /** The run's own trigger label, exactly as it is recorded in run_log. */
  trigger: string;
  /** The GitHub Actions event that started the job: `schedule`, `workflow_dispatch`, `push`, ... */
  ci_event: string | null;
  ci_workflow: string | null;
  ci_run_id: string | null;
  ci_run_attempt: string | null;
  ci_run_url: string | null;
  ci_ref: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
}

export interface CiRunLedger {
  county: string;
  updated_at: string;
  /**
   * How many times each CI event ran the workflow, so "is the cron actually running" is answerable
   * at a glance. Counts every run of the workflow, including ones that were cancelled or are still
   * going, because the question is whether the tick fired. `by_event_conclusion` splits it.
   */
  by_event: Record<string, number>;
  /** Per event, how those runs ended (`success`, `failure`, `cancelled`, or the live status). */
  by_event_conclusion: Record<string, Record<string, number>>;
  /**
   * `actions_api` means the tally counts workflow runs GitHub reported. `local_records` means the
   * API could not be read and the tally falls back to the runs this clone happened to witness,
   * which undercounts by construction. Never read `by_event` without reading this.
   */
  by_event_source: "actions_api" | "local_records";
  /** How the `workflow_runs` rows were obtained, and the endpoint that reproduces them. */
  ci_history: CiHistoryProvenance;
  /** Every run of the workflow, derived from the Actions API. Newest first. */
  workflow_runs: CiWorkflowRun[];
  runs: CiRunEntry[];
}

export const CI_RUNS_FILE = "ci-runs.json";

const NEVER_RECONCILED: CiHistoryProvenance = {
  outcome: "not_attempted",
  endpoint: null,
  repository: null,
  workflow: null,
  fetched_at: null,
  api_total: null,
  pages: 0,
  detail: "no reconcile has run against this file yet",
};

/**
 * CI provenance from the runner environment.
 *
 * `GITHUB_EVENT_NAME` is the authoritative answer to "was this the cron", and it is set on every
 * step of every job, so it does not depend on a workflow remembering to pass a flag. The
 * consolidation pass records `trigger: "consolidation"` (a run KIND that the UI groups on, not a CI
 * event), which is exactly why the event has to be captured separately rather than folded into the
 * trigger.
 */
export function readCiEnv(env: NodeJS.ProcessEnv): Pick<CiRunEntry, "ci_event" | "ci_workflow" | "ci_run_id" | "ci_run_attempt" | "ci_run_url" | "ci_ref"> {
  const nonEmpty = (v: string | undefined): string | null => {
    const t = v?.trim();
    return t !== undefined && t.length > 0 ? t : null;
  };
  const server = nonEmpty(env.GITHUB_SERVER_URL) ?? "https://github.com";
  const repo = nonEmpty(env.GITHUB_REPOSITORY);
  const runId = nonEmpty(env.GITHUB_RUN_ID);
  return {
    ci_event: nonEmpty(env.GITHUB_EVENT_NAME),
    ci_workflow: nonEmpty(env.GITHUB_WORKFLOW),
    ci_run_id: runId,
    ci_run_attempt: nonEmpty(env.GITHUB_RUN_ATTEMPT),
    ci_run_url: repo !== null && runId !== null ? `${server}/${repo}/actions/runs/${runId}` : null,
    ci_ref: nonEmpty(env.GITHUB_REF_NAME),
  };
}

function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function newestFirst<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

/**
 * Derive the headline tally.
 *
 * Prefer the reconciled workflow runs: they are what GitHub says happened, they include ticks that
 * predate this ledger, and they survive the branch rewrites this project does. Fall back to the
 * pipeline's own records only when there is nothing reconciled, and say so in `by_event_source` so
 * a reader is never invited to mistake "what this clone saw" for "what happened".
 */
function deriveTally(workflowRuns: CiWorkflowRun[], runs: CiRunEntry[]): Pick<CiRunLedger, "by_event" | "by_event_conclusion" | "by_event_source"> {
  const byEvent: Record<string, number> = {};
  const byEventConclusion: Record<string, Record<string, number>> = {};
  if (workflowRuns.length > 0) {
    for (const r of workflowRuns) {
      byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
      // A run still in flight has no conclusion, so its live status is the honest label for it.
      const outcome = r.conclusion ?? r.status;
      const bucket = (byEventConclusion[r.event] ??= {});
      bucket[outcome] = (bucket[outcome] ?? 0) + 1;
    }
    return { by_event: byEvent, by_event_conclusion: byEventConclusion, by_event_source: "actions_api" };
  }
  for (const r of runs) {
    const key = r.ci_event ?? "local";
    byEvent[key] = (byEvent[key] ?? 0) + 1;
    const bucket = (byEventConclusion[key] ??= {});
    bucket[r.status] = (bucket[r.status] ?? 0) + 1;
  }
  return { by_event: byEvent, by_event_conclusion: byEventConclusion, by_event_source: "local_records" };
}

/**
 * Write the ledger from both layers at once.
 *
 * Two processes touch this file in one CI job (the ingestion run, then the consolidation pass, then
 * the reconcile step), so every writer reads the whole file and preserves the layer it is not
 * responsible for. Nothing here truncates.
 */
function writeLedger(
  file: string,
  workflowRuns: CiWorkflowRun[],
  runs: CiRunEntry[],
  ciHistory: CiHistoryProvenance,
): CiRunLedger {
  const ledger: CiRunLedger = {
    county: COUNTY.key,
    updated_at: new Date().toISOString(),
    ...deriveTally(workflowRuns, runs),
    ci_history: ciHistory,
    workflow_runs: workflowRuns,
    runs,
  };
  writeFileSync(file, JSON.stringify(ledger, null, 2));
  return ledger;
}

function readLedger(file: string): { workflowRuns: CiWorkflowRun[]; runs: CiRunEntry[]; ciHistory: CiHistoryProvenance } {
  const existing = readJsonOr<Partial<CiRunLedger>>(file, {});
  return {
    workflowRuns: Array.isArray(existing.workflow_runs) ? existing.workflow_runs.filter((r) => typeof r?.ci_run_id === "string") : [],
    runs: Array.isArray(existing.runs) ? existing.runs.filter((r) => typeof r?.run_id === "string") : [],
    ciHistory: existing.ci_history ?? NEVER_RECONCILED,
  };
}

/** Merge one pipeline run into runs/ci-runs.json (newest first, one entry per run_id). */
export function recordCiRun(paths: Paths, entry: CiRunEntry): { file: string; ledger: CiRunLedger } {
  mkdirSync(paths.runsDir, { recursive: true });
  const file = join(paths.runsDir, CI_RUNS_FILE);
  const { workflowRuns, runs, ciHistory } = readLedger(file);
  const merged = newestFirst([entry, ...runs.filter((r) => r.run_id !== entry.run_id)], (r) => r.started_at);
  return { file, ledger: writeLedger(file, workflowRuns, merged, ciHistory) };
}

/**
 * Replace the reconciled CI history with what the Actions API just reported.
 *
 * The API rows win on a collision because they are the authority for a workflow run's event,
 * branch and conclusion. Rows already on disk that the API did not return are KEPT rather than
 * dropped: the fetch is capped at a few pages, so an old tick that has rolled out of that window
 * must not disappear from the file just because we stopped asking about it.
 *
 * A fetch that failed carries an empty `runs` list and a non-`reconciled` outcome. In that case the
 * existing rows stand untouched and only the provenance is updated, so the file records that the
 * reconcile was attempted and could not be completed instead of quietly looking authoritative.
 */
export function recordCiWorkflowRuns(
  paths: Paths,
  reconciled: { runs: CiWorkflowRun[]; provenance: CiHistoryProvenance },
): { file: string; ledger: CiRunLedger; added: number } {
  mkdirSync(paths.runsDir, { recursive: true });
  const file = join(paths.runsDir, CI_RUNS_FILE);
  const { workflowRuns, runs, ciHistory } = readLedger(file);
  const known = new Set(workflowRuns.map((r) => r.ci_run_id));
  const byId = new Map<string, CiWorkflowRun>();
  for (const r of workflowRuns) byId.set(r.ci_run_id, r);
  for (const r of reconciled.runs) byId.set(r.ci_run_id, r);
  const merged = newestFirst([...byId.values()], (r) => r.run_started_at ?? "");
  const provenance = reconciled.provenance.outcome === "reconciled" ? reconciled.provenance : { ...reconciled.provenance, detail: reconciled.provenance.detail ?? ciHistory.detail };
  const added = reconciled.runs.filter((r) => !known.has(r.ci_run_id)).length;
  return { file, ledger: writeLedger(file, merged, runs, provenance), added };
}

// ---------------------------------------------------------------------------- table high-water marks

export interface HighwaterTable {
  /** The largest this table has ever been on this lineage. */
  max: number;
  max_run_id: string;
  max_at: string;
  current: number;
  current_run_id: string;
  current_at: string;
}

export interface HighwaterEvent {
  at: string;
  run_id: string;
  trigger: string;
  table: string;
  previous_max: number;
  current: number;
  lost: number;
  previous_max_run_id: string;
  /** `regression` failed the run; `accepted` was explicitly waved through with --allow-regression. */
  kind: "regression" | "accepted";
  note: string | null;
}

export interface HighwaterDoc {
  county: string;
  updated_at: string;
  tables: Record<string, HighwaterTable>;
  /** Most recent first; every time a table total went backwards, whether or not it was accepted. */
  events: HighwaterEvent[];
}

export interface Regression {
  table: string;
  previous_max: number;
  current: number;
  lost: number;
  previous_max_run_id: string;
  previous_max_at: string;
}

export const HIGHWATER_FILE = "table-highwater.json";
const MAX_EVENTS = 50;

/**
 * Compare this run's table totals against the largest they have ever been, and record the answer.
 *
 * The accumulating tracks page their source and keep a cursor, so their totals only ever grow. When
 * a run started from a cold DuckDB (a lost or evicted Actions cache, or a run that moved to another
 * branch's cache lineage) the cursor restarted near the beginning and `pa_detail_buildings` went
 * from 1,619 rows back to 466. Nothing failed, nothing was logged, and the published artifact
 * quietly lost two thirds of a table.
 *
 * `runs/table-highwater.json` is committed, so it survives everything the cache does not. A total
 * below its high-water mark is returned as a regression, which the CLI turns into a failed run: the
 * only way past it is `--allow-regression`, which records the decision as an event instead. Either
 * way the shrink becomes an explicit, dated, attributable entry rather than silence.
 */
export function recordTableHighwater(
  paths: Paths,
  opts: { runId: string; trigger: string; totals: Record<string, number>; allowRegression?: boolean; note?: string | null; now?: string },
): { file: string; doc: HighwaterDoc; regressions: Regression[] } {
  mkdirSync(paths.runsDir, { recursive: true });
  const file = join(paths.runsDir, HIGHWATER_FILE);
  const at = opts.now ?? new Date().toISOString();
  const existing = readJsonOr<Partial<HighwaterDoc>>(file, {});
  const tables: Record<string, HighwaterTable> = { ...(existing.tables ?? {}) };
  const events: HighwaterEvent[] = Array.isArray(existing.events) ? [...existing.events] : [];
  const regressions: Regression[] = [];
  const newEvents: HighwaterEvent[] = [];

  for (const [table, rawTotal] of Object.entries(opts.totals)) {
    const current = Number(rawTotal);
    if (!Number.isFinite(current)) continue;
    const prev = tables[table];
    if (prev === undefined) {
      tables[table] = { max: current, max_run_id: opts.runId, max_at: at, current, current_run_id: opts.runId, current_at: at };
      continue;
    }
    if (current >= prev.max) {
      tables[table] = { max: current, max_run_id: opts.runId, max_at: at, current, current_run_id: opts.runId, current_at: at };
      continue;
    }
    const regression: Regression = {
      table,
      previous_max: prev.max,
      current,
      lost: prev.max - current,
      previous_max_run_id: prev.max_run_id,
      previous_max_at: prev.max_at,
    };
    regressions.push(regression);
    newEvents.push({
      at,
      run_id: opts.runId,
      trigger: opts.trigger,
      table,
      previous_max: prev.max,
      current,
      lost: regression.lost,
      previous_max_run_id: prev.max_run_id,
      kind: opts.allowRegression === true ? "accepted" : "regression",
      note: opts.note ?? null,
    });
    // An accepted regression re-bases the mark, so the operator is asked once and not every run
    // afterwards. A rejected one leaves the mark where it was, so the next run is asked again.
    tables[table] =
      opts.allowRegression === true
        ? { max: current, max_run_id: opts.runId, max_at: at, current, current_run_id: opts.runId, current_at: at }
        : { ...prev, current, current_run_id: opts.runId, current_at: at };
  }

  const doc: HighwaterDoc = {
    county: COUNTY.key,
    updated_at: at,
    tables,
    events: [...newEvents, ...events].slice(0, MAX_EVENTS),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, doc, regressions };
}

// ---------------------------------------------------------------------------- track cursors

export interface TrackStateRow {
  track: string;
  key: string;
  value: string;
  updated_at: string | null;
  run_id: string | null;
}

export const TRACK_STATE_FILE = "track-state.json";

/**
 * Commit the paging cursors after every run.
 *
 * `track_state` holds each accumulating track's position in its source (pa_detail's `seed_cursor`,
 * the permit enumerator's discovered API, and so on). It lives in the DuckDB working set, which
 * lives in an Actions cache, so a cache miss silently rewinds every cursor to zero. Snapshotting it
 * into `runs/` does not by itself repair a cold run, but it makes the rewind visible in the diff of
 * the very commit that caused it, instead of only in a row count nobody was watching.
 */
export function snapshotTrackState(paths: Paths, rows: TrackStateRow[], runId: string): { file: string } {
  mkdirSync(paths.runsDir, { recursive: true });
  const file = join(paths.runsDir, TRACK_STATE_FILE);
  const sorted = [...rows].sort((a, b) => `${a.track}/${a.key}`.localeCompare(`${b.track}/${b.key}`));
  writeFileSync(file, JSON.stringify({ county: COUNTY.key, run_id: runId, updated_at: new Date().toISOString(), state: sorted }, null, 2));
  return { file };
}

export function formatRegressions(regressions: Regression[]): string {
  return regressions
    .map(
      (r) =>
        `  ${r.table}: ${r.current} rows, down ${r.lost} from ${r.previous_max} last seen in run ${r.previous_max_run_id} (${r.previous_max_at})`,
    )
    .join("\n");
}
