import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Paths } from "../src/config.js";
import { fetchWorkflowRunHistory, resolveWorkflowFile, toWorkflowRun, type ApiFetch, type CiWorkflowRun } from "../src/publish/ciHistory.js";
import { CI_RUNS_FILE, recordCiRun, recordCiWorkflowRuns, type CiRunEntry, type CiRunLedger } from "../src/publish/ledger.js";

/**
 * The tally in runs/ci-runs.json is the artifact the pull request points at to answer "is the
 * 6-hourly cron actually running". Appending as runs happen cannot answer it: the ledger did not
 * exist when the first scheduled run landed, and the file lives on a branch this project
 * force-pushes over, so a tally can be reset to zero by a git operation rather than by reality.
 * These tests pin the replacement: the history is derived from the GitHub Actions API, a failed
 * fetch never invents or destroys a row, and the file always says which source its tally came from.
 */

function makePaths(): Paths {
  const dir = mkdtempSync(join(tmpdir(), "duval-cihistory-"));
  return { dataDir: dir, dbPath: join(dir, "duval.duckdb"), artifactsDir: join(dir, "artifacts"), publishDir: join(dir, "publish"), runsDir: join(dir, "runs") } as Paths;
}

/** One row in the shape GET /repos/{repo}/actions/workflows/{file}/runs really returns. */
function apiRun(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 32513420281,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: "1007a3d9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    run_attempt: 1,
    run_started_at: "2026-08-21T18:27:12Z",
    html_url: "https://github.com/owner/repo/actions/runs/32513420281",
    ...over,
  };
}

function stubApi(pages: Record<string, unknown>[][]): { fetchImpl: ApiFetch; urls: string[] } {
  const urls: string[] = [];
  const total = pages.reduce((n, p) => n + p.length, 0);
  const fetchImpl: ApiFetch = (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const body = JSON.stringify({ total_count: total, workflow_runs: pages[page - 1] ?? [] });
    return Promise.resolve({ ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(body) });
  };
  return { fetchImpl, urls };
}

function ledgerOnDisk(paths: Paths): CiRunLedger {
  return JSON.parse(readFileSync(join(paths.runsDir, CI_RUNS_FILE), "utf8")) as CiRunLedger;
}

function pipelineEntry(over: Partial<CiRunEntry> & Pick<CiRunEntry, "run_id" | "started_at">): CiRunEntry {
  return {
    kind: "ingestion",
    trigger: "workflow_dispatch",
    ci_event: "workflow_dispatch",
    ci_workflow: "pipeline",
    ci_run_id: "32535179300",
    ci_run_attempt: "1",
    ci_run_url: null,
    ci_ref: "main",
    finished_at: null,
    status: "completed",
    ...over,
  };
}

describe("workflow file resolution", () => {
  it("takes the workflow the job is running from, so it cannot name a different file", () => {
    const file = resolveWorkflowFile({
      GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/pipeline.yml@refs/heads/main",
    } as NodeJS.ProcessEnv);
    expect(file).toBe("pipeline.yml");
  });

  it("falls back to the scheduled workflow off a runner, and honours an explicit override", () => {
    expect(resolveWorkflowFile({} as NodeJS.ProcessEnv)).toBe("pipeline.yml");
    expect(resolveWorkflowFile({ CI_LEDGER_WORKFLOW_FILE: "other.yml" } as NodeJS.ProcessEnv)).toBe("other.yml");
  });
});

describe("Actions API projection", () => {
  it("keeps the fields that answer the cron question and drops a row with no id", () => {
    expect(toWorkflowRun(apiRun({}))).toEqual({
      ci_run_id: "32513420281",
      event: "schedule",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: "1007a3d9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      run_attempt: 1,
      run_started_at: "2026-08-21T18:27:12Z",
      html_url: "https://github.com/owner/repo/actions/runs/32513420281",
    });
    expect(toWorkflowRun({ event: "schedule" })).toBeNull();
    expect(toWorkflowRun("not a row")).toBeNull();
  });

  it("records a run still in flight rather than waiting for it to finish", () => {
    const run = toWorkflowRun(apiRun({ id: 32540470084, status: "in_progress", conclusion: null }));
    expect(run).toMatchObject({ ci_run_id: "32540470084", status: "in_progress", conclusion: null });
  });

  it("reports the endpoint it read, so the rows can be checked against GitHub", async () => {
    const { fetchImpl, urls } = stubApi([[apiRun({})]]);
    const { runs, provenance } = await fetchWorkflowRunHistory({
      fetchImpl,
      repository: "owner/repo",
      workflowFile: "pipeline.yml",
      token: "t",
    });
    expect(runs).toHaveLength(1);
    expect(provenance.outcome).toBe("reconciled");
    expect(provenance.endpoint).toBe("https://api.github.com/repos/owner/repo/actions/workflows/pipeline.yml/runs?per_page=100");
    expect(provenance.api_total).toBe(1);
    expect(provenance.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(urls).toEqual(["https://api.github.com/repos/owner/repo/actions/workflows/pipeline.yml/runs?per_page=100&page=1"]);
  });

  it("stops asking for pages once a short page comes back", async () => {
    const { fetchImpl, urls } = stubApi([[apiRun({ id: 1 }), apiRun({ id: 2 })]]);
    await fetchWorkflowRunHistory({ fetchImpl, repository: "owner/repo", workflowFile: "pipeline.yml" });
    expect(urls).toHaveLength(1);
  });

  it("degrades to an outcome rather than throwing when the API refuses", async () => {
    const fetchImpl: ApiFetch = () => Promise.resolve({ ok: false, status: 403, statusText: "Forbidden", text: () => Promise.resolve("") });
    const { runs, provenance } = await fetchWorkflowRunHistory({ fetchImpl, repository: "owner/repo", workflowFile: "pipeline.yml" });
    expect(runs).toEqual([]);
    expect(provenance.outcome).toBe("api_unreachable");
    expect(provenance.detail).toContain("403");
  });

  it("degrades when the response is not the document the endpoint promises", async () => {
    const fetchImpl: ApiFetch = () => Promise.resolve({ ok: true, status: 200, statusText: "OK", text: () => Promise.resolve('{"message":"Not Found"}') });
    const { provenance } = await fetchWorkflowRunHistory({ fetchImpl, repository: "owner/repo", workflowFile: "pipeline.yml" });
    expect(provenance.outcome).toBe("api_malformed");
  });

  it("does not guess a repository when the environment has none", async () => {
    const fetchImpl: ApiFetch = () => Promise.reject(new Error("must not be called"));
    const { runs, provenance } = await fetchWorkflowRunHistory({ fetchImpl, repository: null, workflowFile: "pipeline.yml" });
    expect(runs).toEqual([]);
    expect(provenance.outcome).toBe("not_attempted");
  });
});

describe("CI ledger reconciled from the Actions API", () => {
  const reconciled = (runs: CiWorkflowRun[]) => ({
    runs,
    provenance: {
      outcome: "reconciled" as const,
      endpoint: "https://api.github.com/repos/owner/repo/actions/workflows/pipeline.yml/runs?per_page=100",
      repository: "owner/repo",
      workflow: "pipeline.yml",
      fetched_at: "2026-08-22T00:35:00.000Z",
      api_total: runs.length,
      pages: 1,
      detail: null,
    },
  });
  const wfRun = (over: Partial<CiWorkflowRun> & Pick<CiWorkflowRun, "ci_run_id">): CiWorkflowRun => ({
    event: "schedule",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: null,
    run_attempt: 1,
    run_started_at: "2026-08-21T18:27:12Z",
    html_url: null,
    ...over,
  });

  it("counts the cron from what GitHub reports, not from what this clone witnessed", () => {
    const paths = makePaths();
    // What the pipeline itself saw: two dispatched runs of one CI run. On its own this reads
    // "the cron has never fired", which is the disproof the pull request was pointing at.
    recordCiRun(paths, pipelineEntry({ run_id: "01M0K8WH2MSEKV36HXKDF9A910", started_at: "2026-08-21T23:00:52.949Z" }));
    recordCiRun(paths, pipelineEntry({ run_id: "01M0KBA53DPMHRGXV66NQ0GRY5", started_at: "2026-08-21T23:43:16.590Z", kind: "consolidation", trigger: "consolidation" }));
    expect(ledgerOnDisk(paths).by_event).toEqual({ workflow_dispatch: 2 });
    expect(ledgerOnDisk(paths).by_event_source).toBe("local_records");

    const { ledger } = recordCiWorkflowRuns(
      paths,
      reconciled([
        wfRun({ ci_run_id: "32540470084", status: "in_progress", conclusion: null, run_started_at: "2026-08-22T00:28:42Z" }),
        wfRun({ ci_run_id: "32535179300", event: "workflow_dispatch", run_started_at: "2026-08-21T22:59:16Z" }),
        wfRun({ ci_run_id: "32513420281", run_started_at: "2026-08-21T18:27:12Z" }),
        wfRun({ ci_run_id: "32481994197", conclusion: "cancelled", run_started_at: "2026-08-21T12:27:43Z" }),
      ]),
    );

    expect(ledger.by_event).toEqual({ schedule: 3, workflow_dispatch: 1 });
    expect(ledger.by_event_source).toBe("actions_api");
    // The breakdown keeps the tally honest: three ticks fired, only one of them succeeded so far.
    expect(ledger.by_event_conclusion.schedule).toEqual({ success: 1, cancelled: 1, in_progress: 1 });
    expect(ledger.ci_history.endpoint).toContain("/actions/workflows/pipeline.yml/runs");
    // and the pipeline's own records are untouched by the reconcile
    expect(ledger.runs.map((r) => r.run_id)).toEqual(["01M0KBA53DPMHRGXV66NQ0GRY5", "01M0K8WH2MSEKV36HXKDF9A910"]);
  });

  it("rebuilds the whole history after a force-push wipes the file", () => {
    const paths = makePaths();
    const rows = [wfRun({ ci_run_id: "32513420281" }), wfRun({ ci_run_id: "32481994197", conclusion: "cancelled", run_started_at: "2026-08-21T12:27:43Z" })];
    recordCiWorkflowRuns(paths, reconciled(rows));

    // A force-push of the feature branch over main leaves the checkout with no ledger at all.
    mkdirSync(paths.runsDir, { recursive: true });
    writeFileSync(join(paths.runsDir, CI_RUNS_FILE), "");

    const { ledger, added } = recordCiWorkflowRuns(paths, reconciled(rows));
    expect(added).toBe(2);
    expect(ledger.by_event).toEqual({ schedule: 2 });
    expect(ledger.by_event_source).toBe("actions_api");
  });

  it("keeps a tick that has rolled past the page cap instead of dropping it", () => {
    const paths = makePaths();
    recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32481994197", run_started_at: "2026-08-21T12:27:43Z" })]));
    const { ledger } = recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32540470084", run_started_at: "2026-08-22T00:28:42Z" })]));
    expect(ledger.workflow_runs.map((r) => r.ci_run_id)).toEqual(["32540470084", "32481994197"]);
    expect(ledger.by_event.schedule).toBe(2);
  });

  it("lets the API correct a row it already holds", () => {
    const paths = makePaths();
    recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32540470084", status: "in_progress", conclusion: null })]));
    const { ledger, added } = recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32540470084", status: "completed", conclusion: "success" })]));
    expect(added).toBe(0);
    expect(ledger.workflow_runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("a failed reconcile keeps every row and says so, rather than emptying the file", () => {
    const paths = makePaths();
    recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32513420281" })]));
    const { ledger } = recordCiWorkflowRuns(paths, {
      runs: [],
      provenance: {
        outcome: "api_unreachable",
        endpoint: "https://api.github.com/repos/owner/repo/actions/workflows/pipeline.yml/runs?per_page=100",
        repository: "owner/repo",
        workflow: "pipeline.yml",
        fetched_at: "2026-08-22T01:00:00.000Z",
        api_total: null,
        pages: 0,
        detail: "403 Forbidden on page 1",
      },
    });
    expect(ledger.workflow_runs).toHaveLength(1);
    expect(ledger.by_event).toEqual({ schedule: 1 });
    expect(ledger.ci_history.outcome).toBe("api_unreachable");
    expect(ledger.ci_history.detail).toContain("403");
  });

  it("a pipeline run recorded after a reconcile does not undo it", () => {
    const paths = makePaths();
    recordCiWorkflowRuns(paths, reconciled([wfRun({ ci_run_id: "32513420281" })]));
    const { ledger } = recordCiRun(paths, pipelineEntry({ run_id: "01M0K8WH2MSEKV36HXKDF9A910", started_at: "2026-08-21T23:00:52.949Z" }));
    expect(ledger.workflow_runs).toHaveLength(1);
    expect(ledger.by_event_source).toBe("actions_api");
    expect(ledger.ci_history.outcome).toBe("reconciled");
  });
});
