import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discardStagedQueryTable, promoteQueryTable } from "../src/publish/gate.js";

/**
 * The consolidation pass runs AFTER the gated ingestion run and rewrites query-table.parquet, so it
 * produces the artifact that is actually published. It used to compute the validation report and
 * never check `ok`, which made the architecture's "a failed gate aborts before anything is
 * published" false for the only pass that mattered. Building into a staging file and promoting only
 * on a pass is what makes that sentence true.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "duval-gate-"));
}

describe("query table publish gate", () => {
  it("promotes a build that passes, replacing the published parquet", () => {
    const dir = tempDir();
    const publishPath = join(dir, "query-table.parquet");
    const stagedPath = join(dir, "query-table.staging.parquet");
    writeFileSync(publishPath, "OLD-GOOD");
    writeFileSync(stagedPath, "NEW-GOOD");

    const outcome = promoteQueryTable({ stagedPath, publishPath, ok: true });

    expect(outcome.promoted).toBe(true);
    expect(outcome.builtPath).toBe(publishPath);
    expect(readFileSync(publishPath, "utf8")).toBe("NEW-GOOD");
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("leaves the last artifact that passed in place when the gate fails", () => {
    const dir = tempDir();
    const publishPath = join(dir, "query-table.parquet");
    const stagedPath = join(dir, "query-table.staging.parquet");
    writeFileSync(publishPath, "OLD-GOOD");
    writeFileSync(stagedPath, "NEW-BAD");

    const outcome = promoteQueryTable({ stagedPath, publishPath, ok: false });

    expect(outcome.promoted).toBe(false);
    expect(outcome.keptPrevious).toBe(true);
    // this is the whole point: a build that failed the gate cannot be the thing we upload
    expect(readFileSync(publishPath, "utf8")).toBe("OLD-GOOD");
    expect(outcome.message).toContain("still holds the last artifact that passed");
  });

  it("keeps the failed build addressable until the caller discards it", () => {
    const dir = tempDir();
    const publishPath = join(dir, "query-table.parquet");
    const stagedPath = join(dir, "query-table.staging.parquet");
    writeFileSync(publishPath, "OLD-GOOD");
    writeFileSync(stagedPath, "NEW-BAD");

    const outcome = promoteQueryTable({ stagedPath, publishPath, ok: false });
    // still there, so the run record can describe what this pass produced and why it was rejected
    expect(existsSync(outcome.builtPath)).toBe(true);

    discardStagedQueryTable(stagedPath);
    expect(existsSync(stagedPath)).toBe(false);
    expect(readFileSync(publishPath, "utf8")).toBe("OLD-GOOD");
  });

  it("says so plainly when a failed gate leaves nothing publishable at all", () => {
    const dir = tempDir();
    const publishPath = join(dir, "query-table.parquet");
    const stagedPath = join(dir, "query-table.staging.parquet");
    writeFileSync(stagedPath, "NEW-BAD");

    const outcome = promoteQueryTable({ stagedPath, publishPath, ok: false });

    expect(outcome.keptPrevious).toBe(false);
    expect(outcome.message).toContain("no previously validated");
    expect(existsSync(publishPath)).toBe(false);
  });

  it("discarding a staged file that is already gone is not an error", () => {
    const dir = tempDir();
    expect(() => discardStagedQueryTable(join(dir, "nothing-here.parquet"))).not.toThrow();
  });
});
