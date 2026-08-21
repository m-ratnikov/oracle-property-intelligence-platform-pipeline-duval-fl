import { existsSync, renameSync, rmSync } from "node:fs";

/**
 * The publish gate, as an operation on files rather than a value nobody reads.
 *
 * `docs/ARCHITECTURE.md` has always said "a failed gate aborts before anything is published". That
 * was true of the ingestion run and false of the consolidation pass, which runs AFTER it, rewrites
 * `query-table.parquet`, computed a validation report and never looked at `ok`. The artifact we
 * actually publish was therefore produced by the one code path with no gate.
 *
 * Building into a staging file and promoting only on a pass makes the claim structural instead of
 * procedural: a build that fails the gate cannot replace the good parquet even if a later caller
 * forgets to check an exit code, because the good parquet was never overwritten in the first place.
 */
export interface GateOutcome {
  promoted: boolean;
  /** Where the parquet this build produced now lives. */
  builtPath: string;
  /** The parquet a publish would upload right now. */
  publishPath: string;
  /** True when a previously validated parquet was left in place instead of being overwritten. */
  keptPrevious: boolean;
  message: string;
}

/**
 * Promote a staged query table over the published one, or refuse to.
 *
 * On a pass the staged file is renamed into place. On a failure it is left where it is - so the
 * caller can still describe what it built, and an operator can still inspect it - and the published
 * path keeps whatever last passed.
 */
export function promoteQueryTable(opts: { stagedPath: string; publishPath: string; ok: boolean }): GateOutcome {
  const hadPrevious = existsSync(opts.publishPath);
  if (opts.ok) {
    renameSync(opts.stagedPath, opts.publishPath);
    return {
      promoted: true,
      builtPath: opts.publishPath,
      publishPath: opts.publishPath,
      keptPrevious: false,
      message: `query table passed the gate and was promoted to ${opts.publishPath}`,
    };
  }
  return {
    promoted: false,
    builtPath: opts.stagedPath,
    publishPath: opts.publishPath,
    keptPrevious: hadPrevious,
    message: hadPrevious
      ? `query table FAILED the gate; ${opts.publishPath} still holds the last artifact that passed and nothing is published from this pass`
      : `query table FAILED the gate and there is no previously validated ${opts.publishPath}; nothing is published from this pass`,
  };
}

/** Remove a staged parquet that did not make it. Safe to call when it is already gone. */
export function discardStagedQueryTable(stagedPath: string): void {
  rmSync(stagedPath, { force: true });
}
