import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../config.js";
import type { Logger } from "../log.js";
import { gatewayUrls, listIpnsNames } from "./filebase.js";

/**
 * run-history.json is the ONLY cumulative published artifact, and the only one that must not be
 * overwritten wholesale.
 *
 * GitHub Actions caches are branch scoped. Every manual run so far was dispatched on the feature
 * branch, so the warm `.data` cache holding the DuckDB with the full `run_log` belongs to that
 * branch. The 6-hourly cron fires on the default branch, which has its own cache lineage, so run
 * 32513420281 started from an EMPTY DuckDB, re-ingested all 13 sources as a first load
 * (1,412,096 rows inserted) and then republished run-history.json containing the three runs its own
 * database knew about, replacing the 29 that were live at the same IPNS name. Nothing was lost (the
 * branch database still had them) but the two lineages overwrite each other every six hours, and a
 * page whose whole claim is "ingestion is continuous and incremental" cannot be one cron tick away
 * from showing a single bulk load.
 *
 * So the published history is made monotonic: read what is currently published, union it with what
 * this database knows keyed on `run_id`, prefer this database's copy where a run_id appears in both
 * (a re-run or a repaired record should win), and write the union newest first. Every way the read
 * can fail (absent, unreachable, slow, malformed, another county, empty) degrades to publishing
 * exactly what this database knows, which is what the code did before this existed. The merge never
 * fails the run and never publishes nothing.
 *
 * The other published artifacts are deliberately NOT merged:
 *   - dataset-coverage.json is a point-in-time snapshot of the CURRENT table state (row counts,
 *     min/max fetched_at over the rows now present). Unioning two snapshots would produce counts
 *     that describe no database that ever existed.
 *   - query-table.parquet and tables/*.parquet are re-derived from the sources on every run.
 *   - published-counties.json and artifacts-index.json describe this publish, by construction.
 */

/** One run as it appears in the published document. `run_id` is the merge key and nothing else is. */
export type RunHistoryEntry = Record<string, unknown> & { run_id: string };

export interface RunHistoryDoc {
  county: string;
  generatedAt: string;
  runCount: number;
  runs: RunHistoryEntry[];
}

/**
 * What happened to the published copy on this publish. Every value except `merged` means the local
 * document is published unchanged; they are distinguished so a run-log reader can tell a first
 * publish from a gateway outage from a corrupt document.
 */
export type MergeOutcome =
  | "merged"
  | "not_attempted"
  | "published_absent"
  | "published_unreachable"
  | "published_malformed"
  | "published_other_county"
  | "published_empty";

export interface MergeResult {
  outcome: MergeOutcome;
  /** Runs this database knows about. */
  localRuns: number;
  /** Runs the currently published copy carried (0 unless the read succeeded). */
  publishedRuns: number;
  /** Runs in the document that will actually be published. Never fewer than `publishedRuns`. */
  mergedRuns: number;
  url: string | null;
  detail: string | null;
}

/** Minimal shape of the gateway read; `typeof fetch` satisfies it, and so does a test stub. */
export type GatewayFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export const RUN_HISTORY_FILE = "run-history.json";
const DEFAULT_TIMEOUT_MS = 20_000;

/** The run record, inside the history about to be published, that claims the parquet being published. */
export interface QueryTableProvenance {
  cid: string;
  cidV1: string;
  runId: string;
  runStartedAt: string | null;
  runTrigger: string | null;
  /** How many runs the document being published carries. */
  historyRuns: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A run is usable only if it carries the merge key. Nothing else about it is inspected. */
function asEntry(value: unknown): RunHistoryEntry | null {
  if (!isRecord(value)) return null;
  const id = value.run_id;
  if (typeof id !== "string" || id.trim().length === 0) return null;
  return { ...value, run_id: id };
}

function startedAt(run: RunHistoryEntry): string {
  return typeof run.started_at === "string" ? run.started_at : "";
}

/**
 * Newest first by `started_at` (ISO-8601 UTC, so string order is chronological order), ties broken
 * by `run_id` descending, since the ids are ULIDs and sort by time as well. A run with no usable
 * `started_at` sorts to the end rather than to the top of the page.
 */
function newestFirst(a: RunHistoryEntry, b: RunHistoryEntry): number {
  const sa = startedAt(a);
  const sb = startedAt(b);
  if (sa !== sb) return sa < sb ? 1 : -1;
  if (a.run_id === b.run_id) return 0;
  return a.run_id < b.run_id ? 1 : -1;
}

/**
 * Union of `local.runs` and `published`, keyed on `run_id`, local winning a collision, sorted newest
 * first. The result is a superset of `published`, so the published history can only ever grow.
 */
export function mergeRunHistories(local: RunHistoryDoc, published: RunHistoryEntry[]): RunHistoryDoc {
  const byId = new Map<string, RunHistoryEntry>();
  for (const run of published) byId.set(run.run_id, run);
  for (const run of local.runs) byId.set(run.run_id, run);
  const runs = [...byId.values()].sort(newestFirst);
  return { ...local, runCount: runs.length, runs };
}

/** When the copy the gateway served was generated, for the lag line in the merge log. Never throws. */
function publishedGeneratedAt(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
  } catch {
    return null;
  }
}

/** Parse the bytes fetched from the gateway. Anything that is not a usable same-county document degrades. */
export function parsePublishedRunHistory(
  text: string,
  county: string,
): { runs: RunHistoryEntry[]; outcome: MergeOutcome; detail: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return { runs: [], outcome: "published_malformed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(parsed)) return { runs: [], outcome: "published_malformed", detail: "top level is not an object" };
  const publishedCounty = parsed.county;
  if (typeof publishedCounty === "string" && publishedCounty !== county) {
    return {
      runs: [],
      outcome: "published_other_county",
      detail: `published county is ${publishedCounty}, this pipeline is ${county}`,
    };
  }
  if (!Array.isArray(parsed.runs)) return { runs: [], outcome: "published_malformed", detail: "runs is not an array" };
  if (parsed.runs.length === 0) return { runs: [], outcome: "published_empty", detail: null };
  const runs = parsed.runs.map(asEntry).filter((r): r is RunHistoryEntry => r !== null);
  if (runs.length === 0) {
    return { runs: [], outcome: "published_malformed", detail: "no run in the published copy carries a run_id" };
  }
  const dropped = parsed.runs.length - runs.length;
  return { runs, outcome: "merged", detail: dropped > 0 ? `${dropped} published run(s) had no run_id and were dropped` : null };
}

/**
 * Find the run whose recorded query-table artifact IS the parquet about to be uploaded.
 *
 * Every run record carries the CID of the query table that run produced, and the publisher computes
 * the CID of the file on disk. Matching them is an exact identity check, not a heuristic: it is the
 * same content hash on both sides. It is stated in terms of the ARTIFACT rather than of "the newest
 * run id", because two branch lineages write into the same `runs/` directory here and the newest
 * committed run id is not necessarily the run that built this working set.
 */
export function findRunForQueryTable(runs: RunHistoryEntry[], cid: string, cidV1: string): RunHistoryEntry | null {
  for (const run of runs) {
    const artifacts = run.artifacts;
    if (!isRecord(artifacts)) continue;
    const qt = artifacts.queryTable;
    if (!isRecord(qt)) continue;
    if (qt.cid === cid || qt.cidV1 === cidV1) return run;
  }
  return null;
}

/**
 * The invariant that makes /runs honest: the history this publish uploads must contain the run that
 * produced the artifact this publish uploads.
 *
 * Without it the property is incidental. It holds today only because the run record happens to be
 * written before the publish command starts, and any future reordering (or a publish driven from a
 * cache older than the checked-out `runs/`) would silently ship a history that does not describe
 * the data beside it, which is precisely the "always one run stale" failure this guards.
 *
 * Called BEFORE the first upload, so a violation publishes nothing at all and the artifacts already
 * live stay live and stay mutually consistent. That is the same shape as the query-table validation
 * gate: a failed gate keeps the last set that passed. It does not introduce a window in which the
 * history and the artifacts can describe different runs, because there is no window: either every
 * object of this publish goes up, or none does.
 *
 * Returns null when there is no local run history to publish at all. A publish that ships no history
 * makes no claim about which run produced the data, so there is nothing here to contradict; the
 * plan already treats run-history.json as optional for exactly that first-publish case.
 */
export function assertRunHistoryDescribesQueryTable(opts: {
  paths: Paths;
  cid: string;
  cidV1: string;
  logger: Logger;
}): QueryTableProvenance | null {
  const file = join(opts.paths.publishDir, RUN_HISTORY_FILE);
  if (!existsSync(file)) {
    opts.logger.info("run_history_absent_from_publish", { file, cid: opts.cid });
    return null;
  }
  let runs: RunHistoryEntry[] = [];
  let parseError: string | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.runs)) throw new Error("run-history.json has no runs array");
    runs = parsed.runs.map(asEntry).filter((r): r is RunHistoryEntry => r !== null);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  const found = parseError === null ? findRunForQueryTable(runs, opts.cid, opts.cidV1) : null;
  if (found === null) {
    opts.logger.error("run_history_does_not_describe_query_table", {
      file,
      cid: opts.cid,
      cidV1: opts.cidV1,
      history_runs: runs.length,
      parse_error: parseError,
    });
    throw new Error(
      `publish aborted: ${file} carries ${runs.length} run(s) and none of them records query-table.parquet ${opts.cid}. ` +
        (parseError === null
          ? "The run history would be published without the run that produced the data beside it. Re-run the pipeline so the run record is written before the publish."
          : `The local run history could not be read: ${parseError}`),
    );
  }
  const provenance: QueryTableProvenance = {
    cid: opts.cid,
    cidV1: opts.cidV1,
    runId: found.run_id,
    runStartedAt: startedAt(found) === "" ? null : startedAt(found),
    runTrigger: typeof found.trigger === "string" ? found.trigger : null,
    historyRuns: runs.length,
  };
  opts.logger.info("run_history_describes_query_table", { ...provenance });
  return provenance;
}

/**
 * The gateway URL for the run-history IPNS name, read back from the Names API rather than
 * hardcoded: the label is the one the publisher is about to re-point, and the network key is
 * whatever the account minted for it. Returns null when the name does not exist yet (first publish)
 * or the Names API cannot be read.
 */
export async function resolveRunHistoryUrl(
  fetchImpl: GatewayFetch,
  token: string,
  gateway: string,
  label: string,
): Promise<{ url: string | null; detail: string | null }> {
  try {
    const names = await listIpnsNames(fetchImpl as never, token);
    const found = names.find((n) => n.label === label);
    if (found === undefined || found.network_key.trim().length === 0) {
      return { url: null, detail: `no IPNS name for label ${label} yet` };
    }
    return { url: gatewayUrls(gateway, found.network_key).filebase, detail: null };
  } catch (err) {
    return { url: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** GET the published document. A non-2xx, a slow gateway and a transport error all look the same to the caller. */
export async function fetchPublishedRunHistory(
  fetchImpl: GatewayFetch,
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ text: string } | { error: string }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `${res.status} ${res.statusText}` };
    return { text: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rewrite `<publishDir>/run-history.json` in place with the union of itself and the currently
 * published copy, so the object the publisher is about to upload can only be a superset of the one
 * already at the IPNS name. Call this BEFORE planning the publish: the plan computes the CID of
 * whatever is on disk.
 */
export async function mergePublishedRunHistory(opts: {
  paths: Paths;
  county: string;
  gateway: string;
  ipnsLabel: string;
  /** null in a dry run or with no Filebase credentials: there is nothing published to merge with. */
  token: string | null;
  fetchImpl: GatewayFetch;
  logger: Logger;
  timeoutMs?: number;
}): Promise<MergeResult> {
  const log = opts.logger;
  const file = join(opts.paths.publishDir, RUN_HISTORY_FILE);
  const keepLocal = (
    outcome: MergeOutcome,
    localRuns: number,
    detail: string | null,
    url: string | null = null,
  ): MergeResult => ({ outcome, localRuns, publishedRuns: 0, mergedRuns: localRuns, url, detail });

  if (!existsSync(file)) {
    log.info("run_history_merge_skipped", { reason: "no local run-history.json in the publish dir", file });
    return keepLocal("not_attempted", 0, "local run-history.json absent");
  }
  let local: RunHistoryDoc;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.runs)) throw new Error("local run-history.json has no runs array");
    local = {
      ...(parsed as unknown as RunHistoryDoc),
      runs: parsed.runs.map(asEntry).filter((r): r is RunHistoryEntry => r !== null),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn("run_history_merge_skipped", { reason: "local run-history.json is unreadable", file, detail });
    return keepLocal("not_attempted", 0, detail);
  }
  const localRuns = local.runs.length;

  if (opts.token === null) {
    log.info("run_history_merge_skipped", {
      reason: "no Filebase credentials, nothing is published to merge with",
      local_runs: localRuns,
    });
    return keepLocal("not_attempted", localRuns, "no IPNS credentials (dry run)");
  }

  const resolved = await resolveRunHistoryUrl(opts.fetchImpl, opts.token, opts.gateway, opts.ipnsLabel);
  if (resolved.url === null) {
    log.warn("run_history_published_copy_unavailable", {
      outcome: "published_absent",
      reason: resolved.detail,
      label: opts.ipnsLabel,
      publishing_run_count: localRuns,
    });
    return keepLocal("published_absent", localRuns, resolved.detail);
  }

  const got = await fetchPublishedRunHistory(opts.fetchImpl, resolved.url, opts.timeoutMs);
  if ("error" in got) {
    log.warn("run_history_published_copy_unavailable", {
      outcome: "published_unreachable",
      reason: got.error,
      url: resolved.url,
      publishing_run_count: localRuns,
    });
    return keepLocal("published_unreachable", localRuns, got.error, resolved.url);
  }

  const parsed = parsePublishedRunHistory(got.text, opts.county);
  if (parsed.outcome !== "merged") {
    log.warn("run_history_published_copy_unusable", {
      outcome: parsed.outcome,
      reason: parsed.detail,
      url: resolved.url,
      publishing_run_count: localRuns,
    });
    return keepLocal(parsed.outcome, localRuns, parsed.detail, resolved.url);
  }

  const merged = mergeRunHistories(local, parsed.runs);
  const known = new Set(local.runs.map((r) => r.run_id));
  const recovered = parsed.runs.filter((r) => !known.has(r.run_id)).length;
  writeFileSync(file, JSON.stringify(merged, null, 2));
  log.info("run_history_merged", {
    url: resolved.url,
    local_runs: localRuns,
    published_runs: parsed.runs.length,
    merged_runs: merged.runs.length,
    recovered_from_published: recovered,
    // The gateway resolves the IPNS name from its own cached record, which lags the Names API by
    // roughly a publish cycle. Logging what the name actually served, next to what we are about to
    // publish, turns "the site looks a run behind" into a dated fact instead of a suspicion.
    published_generated_at: publishedGeneratedAt(got.text),
    local_generated_at: local.generatedAt,
    note: parsed.detail,
  });
  return {
    outcome: "merged",
    localRuns,
    publishedRuns: parsed.runs.length,
    mergedRuns: merged.runs.length,
    url: resolved.url,
    detail: parsed.detail,
  };
}
