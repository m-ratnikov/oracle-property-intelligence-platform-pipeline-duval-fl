/**
 * Reconstruct which CI events actually ran this workflow, from the GitHub Actions API.
 *
 * `runs/ci-runs.json` used to be append-only: a run recorded itself and nothing else. That makes the
 * file a record of what THIS clone happened to witness rather than of what happened, and it failed
 * in both of the ways that matter here.
 *
 * 1. The ledger did not exist yet when the only successful scheduled run landed, so no amount of
 *    appending could ever put that tick in the file.
 * 2. The file is committed to a branch, and this project force-pushes the feature branch over the
 *    default branch. A tally a force-push can silently reset to zero is not evidence.
 *
 * The Actions API has neither problem: GitHub keeps the run metadata whatever we do to branches, it
 * covers runs that predate this code, and a reviewer can re-issue the same request and compare. So
 * the ledger is DERIVED from it on every run rather than accumulated. `endpoint` and `fetched_at`
 * are written into the file precisely so the derivation is checkable and obviously not hand-typed.
 *
 * Nothing here invents a run. When the API cannot be read the outcome says so, the rows already on
 * disk are kept, and the file states which source its tally came from.
 */

export interface CiWorkflowRun {
  /** GitHub's numeric workflow run id, as a string so it round-trips through JSON unchanged. */
  ci_run_id: string;
  /** `schedule`, `workflow_dispatch`, `push`, ... This is the answer to "is the cron running". */
  event: string;
  /** `completed`, `in_progress`, `queued`. */
  status: string;
  /** `success`, `failure`, `cancelled`, or null while the run is still going. */
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string | null;
  run_attempt: number | null;
  run_started_at: string | null;
  html_url: string | null;
}

export type CiHistoryOutcome = "reconciled" | "not_attempted" | "api_unreachable" | "api_malformed";

/** Where the rows came from, in enough detail to re-run the request and check them. */
export interface CiHistoryProvenance {
  outcome: CiHistoryOutcome;
  /** The exact request the rows are a projection of. Re-issue it to verify every field. */
  endpoint: string | null;
  repository: string | null;
  workflow: string | null;
  fetched_at: string | null;
  /** `total_count` as reported by the API, so a page cap that truncated the list is visible. */
  api_total: number | null;
  pages: number;
  detail: string | null;
}

/** Minimal shape of the API read; `typeof fetch` satisfies it, and so does a test stub. */
export type ApiFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

const DEFAULT_API_BASE = "https://api.github.com";
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_TIMEOUT_MS = 20_000;

function nonEmpty(value: string | undefined): string | null {
  const t = value?.trim();
  return t !== undefined && t.length > 0 ? t : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Which workflow file to ask about.
 *
 * On a runner `GITHUB_WORKFLOW_REF` is `owner/repo/.github/workflows/pipeline.yml@refs/heads/main`,
 * which names the file the job is actually running from and so cannot drift from it. Off a runner
 * there is nothing to read, so the caller can name the file and the default is this repository's
 * only scheduled workflow.
 */
export function resolveWorkflowFile(env: NodeJS.ProcessEnv, fallback = "pipeline.yml"): string {
  const override = nonEmpty(env.CI_LEDGER_WORKFLOW_FILE);
  if (override !== null) return override;
  const ref = nonEmpty(env.GITHUB_WORKFLOW_REF);
  if (ref !== null) {
    const path = ref.split("@")[0] ?? "";
    const file = path.split("/").pop();
    if (file !== undefined && file.length > 0) return file;
  }
  return fallback;
}

/** Project one API row onto the fields the ledger keeps. A row without an id is not usable. */
export function toWorkflowRun(value: unknown): CiWorkflowRun | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const ciRunId = typeof id === "number" ? String(id) : str(id);
  if (ciRunId === null) return null;
  const attempt = value.run_attempt;
  return {
    ci_run_id: ciRunId,
    event: str(value.event) ?? "unknown",
    status: str(value.status) ?? "unknown",
    conclusion: str(value.conclusion),
    head_branch: str(value.head_branch),
    head_sha: str(value.head_sha),
    run_attempt: typeof attempt === "number" ? attempt : null,
    run_started_at: str(value.run_started_at) ?? str(value.created_at),
    html_url: str(value.html_url),
  };
}

/**
 * Every run of one workflow, newest first.
 *
 * The repository is public, so this works with no token at all; on a runner the job token is passed
 * anyway because the unauthenticated rate limit is shared per IP across every runner GitHub owns.
 * The token is never logged and never written to the ledger.
 */
export async function fetchWorkflowRunHistory(opts: {
  fetchImpl: ApiFetch;
  repository: string | null;
  workflowFile: string;
  token?: string | null;
  apiBase?: string;
  maxPages?: number;
  timeoutMs?: number;
}): Promise<{ runs: CiWorkflowRun[]; provenance: CiHistoryProvenance }> {
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const repository = opts.repository;
  const base =
    repository === null
      ? null
      : `${apiBase}/repos/${repository}/actions/workflows/${encodeURIComponent(opts.workflowFile)}/runs`;
  const provenance = (
    outcome: CiHistoryOutcome,
    detail: string | null,
    pages = 0,
    apiTotal: number | null = null,
  ): CiHistoryProvenance => ({
    outcome,
    endpoint: base === null ? null : `${base}?per_page=${PER_PAGE}`,
    repository,
    workflow: opts.workflowFile,
    fetched_at: new Date().toISOString(),
    api_total: apiTotal,
    pages,
    detail,
  });

  if (base === null) {
    return { runs: [], provenance: provenance("not_attempted", "no repository in the environment (GITHUB_REPOSITORY unset)") };
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "duval-oracle-pipeline",
  };
  const token = nonEmpty(opts.token ?? undefined);
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const byId = new Map<string, CiWorkflowRun>();
  let apiTotal: number | null = null;
  let pages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${base}?per_page=${PER_PAGE}&page=${page}`;
    let body: string;
    try {
      const res = await opts.fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        return {
          runs: [...byId.values()],
          provenance: provenance("api_unreachable", `${res.status} ${res.statusText} on page ${page}`, pages, apiTotal),
        };
      }
      body = await res.text();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { runs: [...byId.values()], provenance: provenance("api_unreachable", `${detail} on page ${page}`, pages, apiTotal) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { runs: [...byId.values()], provenance: provenance("api_malformed", detail, pages, apiTotal) };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.workflow_runs)) {
      return { runs: [...byId.values()], provenance: provenance("api_malformed", "response has no workflow_runs array", pages, apiTotal) };
    }
    if (typeof parsed.total_count === "number") apiTotal = parsed.total_count;
    pages = page;
    for (const row of parsed.workflow_runs) {
      const run = toWorkflowRun(row);
      if (run !== null) byId.set(run.ci_run_id, run);
    }
    if (parsed.workflow_runs.length < PER_PAGE) break;
  }

  const truncated = apiTotal !== null && byId.size < apiTotal;
  return {
    runs: [...byId.values()],
    provenance: provenance(
      "reconciled",
      truncated ? `page cap reached: ${byId.size} of ${apiTotal} runs read (${maxPages} pages of ${PER_PAGE})` : null,
      pages,
      apiTotal,
    ),
  };
}
