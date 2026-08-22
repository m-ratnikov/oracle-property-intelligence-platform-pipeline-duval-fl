import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePublishMode } from "../src/run.js";

/**
 * Defect: `publish-open-data` degraded to a dry run in silence.
 *
 * `publishOpenData` treats "publish requested but no Filebase credentials" as `live = false`: it
 * logs a warning, returns `mode: "dry-run"`, and the CLI printed that plan and exited 0. In CI the
 * step is called "Publish to Filebase / IPFS", so an operator whose secret had expired, or who had
 * renamed FILEBASE_BUCKET_DUVAL, got a green publish step for a run that never opened a socket -
 * with 404k open-data files still unpublished and the run history claiming otherwise.
 *
 * The artifact publish command had already been fixed for exactly this. Both commands now resolve
 * intent through one function so they cannot drift apart again.
 */

const flags = (o: Record<string, string>) => new Map(Object.entries(o));
const FULL_ENV: NodeJS.ProcessEnv = {
  FILEBASE_ACCESS_KEY: "ak",
  FILEBASE_SECRET_KEY: "sk",
  FILEBASE_BUCKET_DUVAL: "bucket",
};

describe("resolvePublishMode", () => {
  it("is a dry run when no publish was asked for", () => {
    expect(resolvePublishMode(flags({}), {})).toEqual({ mode: "dry-run" });
    expect(resolvePublishMode(flags({ "dry-run": "true" }), FULL_ENV)).toEqual({ mode: "dry-run" });
  });

  it("publishes when asked and the settings are readable", () => {
    expect(resolvePublishMode(flags({ publish: "true" }), FULL_ENV)).toEqual({ mode: "publish" });
  });

  it("REFUSES rather than degrading when the Filebase settings are missing", () => {
    const out = resolvePublishMode(flags({ publish: "true" }), { FILEBASE_ACCESS_KEY: "ak" });

    expect(out.mode).toBe("refused");
    if (out.mode !== "refused") throw new Error("unreachable");
    // names the settings, never the values
    expect(out.missing).toEqual(["FILEBASE_SECRET_KEY", "FILEBASE_BUCKET_DUVAL"]);
    expect(out.reason).toContain("FILEBASE_SECRET_KEY");
    expect(out.reason).not.toContain("ak");
  });

  it("treats a blank secret as missing, not as present", () => {
    // A GitHub Actions secret that is not set expands to an empty string, which is how this fails
    // in practice: the variable exists and carries nothing.
    const out = resolvePublishMode(flags({ publish: "true" }), { ...FULL_ENV, FILEBASE_SECRET_KEY: "   " });
    expect(out.mode).toBe("refused");
  });

  it("refuses a contradictory invocation instead of quietly picking one", () => {
    const out = resolvePublishMode(flags({ publish: "true", "dry-run": "true" }), FULL_ENV);
    expect(out.mode).toBe("refused");
    if (out.mode !== "refused") throw new Error("unreachable");
    expect(out.reason).toContain("--publish and --dry-run");
  });
});

/**
 * The unit test above proves the decision; this proves the CLI acts on it, because the defect was
 * an exit code and not a return value. A publish that publishes nothing has to be red.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CWD = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "duval-publish-intent-"));

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function runCli(command: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir };
  delete env.FILEBASE_ACCESS_KEY;
  delete env.FILEBASE_SECRET_KEY;
  delete env.FILEBASE_BUCKET_DUVAL;
  return spawnSync(process.execPath, ["--import", "tsx", CLI, command, ...args], {
    cwd: CWD,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("the CLI exits non-zero when it was asked to publish and could not", () => {
  it("refuses publish-open-data without uploading or planning", () => {
    const res = runCli("publish-open-data", "--publish");

    expect(res.status, res.stderr).toBe(1);
    expect(res.stdout).toContain("OPEN DATA PUBLISH REFUSED");
    expect(res.stdout).toContain("Nothing was uploaded.");
    // the plan is what made an unpublished run look published, so it must not be printed here
    expect(res.stdout).not.toContain("OPEN DATA PLAN");
    expect(res.stdout).not.toContain("DRY RUN");
  });

  it("refuses publish for the same reason and in the same shape", () => {
    const res = runCli("publish", "--publish");

    expect(res.status, res.stderr).toBe(1);
    expect(res.stdout).toContain("PUBLISH REFUSED");
    expect(res.stdout).toContain("Nothing was uploaded.");
    expect(res.stdout).not.toContain("PUBLISH PLAN");
  });
});
