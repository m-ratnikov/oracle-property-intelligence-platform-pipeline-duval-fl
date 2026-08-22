/**
 * Rebuild `runs/ci-runs.json` from the GitHub Actions API.
 *
 * Run as its own workflow step rather than from inside the pipeline command, for two reasons. It
 * has to run with `if: always()`, because a cron tick that FAILED is exactly the tick a reader most
 * needs to see and the pipeline command never gets far enough to record it. And it has to run last,
 * so the workflow run it is standing in reports its own row (as `in_progress`) and the file the
 * commit step pushes is the reconciled one.
 *
 * This never fails the job. A reconcile that could not reach the API leaves the rows already on
 * disk alone and records the failure in `ci_history.outcome`, which is a visible, honest state; a
 * non-zero exit here would turn an evidence-collection hiccup into a red pipeline.
 */
import { getPaths } from "../config.js";
import { log } from "../log.js";
import { fetchWorkflowRunHistory, resolveWorkflowFile } from "./ciHistory.js";
import { recordCiWorkflowRuns } from "./ledger.js";

async function main(): Promise<void> {
  const env = process.env;
  const paths = getPaths(env);
  const logger = log.child({ stage: "ci_reconcile" });
  const workflowFile = resolveWorkflowFile(env);
  const repository = env.GITHUB_REPOSITORY?.trim() ?? null;

  const reconciled = await fetchWorkflowRunHistory({
    fetchImpl: fetch,
    repository: repository !== null && repository.length > 0 ? repository : null,
    workflowFile,
    // GITHUB_TOKEN on a runner, GH_TOKEN for a local `gh auth token` shell. Absent is fine: the
    // repository is public and the endpoint answers unauthenticated.
    token: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? null,
    apiBase: env.GITHUB_API_URL,
  });

  const { file, ledger, added } = recordCiWorkflowRuns(paths, reconciled);
  const fields = {
    file,
    outcome: ledger.ci_history.outcome,
    endpoint: ledger.ci_history.endpoint,
    workflow_runs: ledger.workflow_runs.length,
    added,
    by_event: ledger.by_event,
    by_event_source: ledger.by_event_source,
    detail: ledger.ci_history.detail,
  };
  if (ledger.ci_history.outcome === "reconciled") logger.info("ci_history_reconciled", fields);
  else logger.warn("ci_history_not_reconciled", fields);

  process.stdout.write(
    `\n=== CI RUN LEDGER (${ledger.ci_history.outcome}, source ${ledger.by_event_source}) ===\n` +
      `${ledger.workflow_runs.length} workflow runs, ${added} new to this file\n` +
      Object.entries(ledger.by_event)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([event, n]) => {
          const how = Object.entries(ledger.by_event_conclusion[event] ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k} ${v}`)
            .join(", ");
          return `  ${event.padEnd(20)} ${String(n).padStart(4)}  (${how})`;
        })
        .join("\n") +
      "\n",
  );
}

main().catch((err: unknown) => {
  // Deliberately exit 0: see the file docblock.
  log.error("ci_reconcile_failed", { error: err instanceof Error ? err.message : String(err) });
});
