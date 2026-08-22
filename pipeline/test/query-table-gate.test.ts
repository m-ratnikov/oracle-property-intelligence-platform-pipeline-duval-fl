import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, openDb, type Db } from "../src/db.js";
import { buildFeatures } from "../src/features/build.js";
import { QUERY_TABLE_OBJECT } from "../src/features/export.js";
import { exportGatedQueryTable, QUERY_TABLE_STAGING_OBJECT, queryTablePath, stagedQueryTablePath } from "../src/run.js";

/**
 * Defect: the PR claimed "a failed gate keeps the last artifact that passed", and that was only
 * true of the consolidation pass. The ingestion run and `pnpm run features` exported straight onto
 * publishDir/query-table.parquet and validated afterwards, so a failing build had already destroyed
 * the last good artifact by the time anything looked at the report.
 *
 * The first block proves the behaviour on the shared helper every path now uses. The second block
 * is the part that keeps it true: it fails if a fourth export path appears that does not go through
 * that helper.
 */

const PROV = `'h', 'duval_appraiser', 'https://src', 'appraisal/x.zip', 'sha', TIMESTAMP '2026-08-21 00:00:00', 'run1'`;
const parcel = (id: string) =>
  `('${id}', '01', 250000, 50000, 200000, 8712, 1998, 2005, 1800, 'DOE JOHN', '1 MAIN ST', 'JACKSONVILLE', 'FL', '32207', '1 MAIN ST', 'JACKSONVILLE', '32207', ${PROV})`;

const PARCEL_COLUMNS = `parcel_id, dor_uc, jv, lnd_val, av_nsd, lnd_sqfoot, act_yr_blt, eff_yr_blt, tot_lvg_area,
  own_name, own_addr1, own_city, own_state, own_zipcd, phy_addr1, phy_city, phy_zipcd,
  row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id`;

let db: Db;
let publishDir: string;

beforeAll(async () => {
  publishDir = mkdtempSync(join(tmpdir(), "duval-qt-gate-"));
  db = await openDb(":memory:");
  await ensureSchema(db.conn);
  await db.conn.run(
    `INSERT INTO parcels (${PARCEL_COLUMNS}) VALUES ${[parcel("000001-0001R"), parcel("000001-0002R"), parcel("000001-0003R")].join(", ")}`,
  );
  await buildFeatures(db.conn, { asOf: "2026-08-21", runId: "gate-test" });
});

afterAll(async () => {
  await db.close();
  rmSync(publishDir, { recursive: true, force: true });
});

describe("exportGatedQueryTable", () => {
  it("promotes a build that passes and leaves no staging file behind", async () => {
    const gated = await exportGatedQueryTable(db.conn, publishDir);

    expect(gated.validation.ok, gated.validation.problems.join("; ")).toBe(true);
    expect(gated.gate.promoted).toBe(true);
    expect(gated.exported.path).toBe(queryTablePath(publishDir));
    expect(gated.validation.parquetPath).toBe(queryTablePath(publishDir));
    // the run record names the published object, not the path it happened to be built at
    expect(gated.artifact.path).toBe(QUERY_TABLE_OBJECT);
    expect(gated.artifact.validationOk).toBe(true);
    expect(existsSync(queryTablePath(publishDir))).toBe(true);
    expect(existsSync(stagedQueryTablePath(publishDir))).toBe(false);
  });

  it("keeps the last artifact that passed when the build fails the gate", async () => {
    // A sentinel rather than the real parquet, because "the bytes are identical anyway" would not
    // distinguish a preserved file from an overwritten one.
    const published = queryTablePath(publishDir);
    writeFileSync(published, "LAST-GOOD-ARTIFACT");

    // derived.properties_features now covers fewer parcels than `parcels` holds, which is the
    // real-world shape of this failure: a features build that did not keep up with the roll.
    await db.conn.run(`INSERT INTO parcels (${PARCEL_COLUMNS}) VALUES ${parcel("000001-0004R")}`);

    const gated = await exportGatedQueryTable(db.conn, publishDir);

    expect(gated.validation.ok).toBe(false);
    expect(gated.validation.problems.join(" ")).toMatch(/!= distinct parcel_id/);
    expect(gated.gate.promoted).toBe(false);
    expect(gated.gate.keptPrevious).toBe(true);
    // the claim under test
    expect(readFileSync(published, "utf8")).toBe("LAST-GOOD-ARTIFACT");
    // and the rejected build is still addressable, under a name the publish plan never uploads
    expect(gated.exported.path).toBe(stagedQueryTablePath(publishDir));
    expect(existsSync(stagedQueryTablePath(publishDir))).toBe(true);
    expect(statSync(stagedQueryTablePath(publishDir)).size).toBeGreaterThan(0);
    // the run record still describes what this pass built, and records that it was rejected
    expect(gated.artifact.path).toBe(QUERY_TABLE_OBJECT);
    expect(gated.artifact.validationOk).toBe(false);
  });

  it("promotes again once the build passes, replacing the artifact it refused to overwrite", async () => {
    await db.conn.run("DELETE FROM parcels WHERE parcel_id = '000001-0004R'");

    const gated = await exportGatedQueryTable(db.conn, publishDir);

    expect(gated.gate.promoted).toBe(true);
    expect(readFileSync(queryTablePath(publishDir), "utf8")).not.toBe("LAST-GOOD-ARTIFACT");
    expect(existsSync(stagedQueryTablePath(publishDir))).toBe(false);
  });

  it("never leaves the staging file where the publish plan would find it", () => {
    // planPublish uploads query-table.parquet, dataset-coverage.json, run-history.json and
    // tables/*.parquet by name. A staging file in the same directory is inert by construction, and
    // this is the assertion that notices if the staging name is ever changed to something the plan
    // does enumerate.
    expect(QUERY_TABLE_STAGING_OBJECT).not.toBe(QUERY_TABLE_OBJECT);
    expect(QUERY_TABLE_STAGING_OBJECT.endsWith(".parquet")).toBe(true);
    expect(readdirSync(publishDir)).not.toContain(QUERY_TABLE_STAGING_OBJECT);
  });
});

/**
 * The gate is only unavoidable while there is exactly one way to build the artifact. These
 * assertions read the source, because that is the only place the invariant lives: TypeScript cannot
 * stop a new caller importing the raw exporter, but a red test at review time can.
 */
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function relPath(file: string): string {
  return relative(SRC_DIR, file).split(sep).join("/");
}

/** Source text with line endings normalized, so these assertions behave the same on Windows. */
function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Files where `needle` appears as a call, ignoring the declaration itself. */
function callers(needle: string): string[] {
  return srcFiles(SRC_DIR)
    .filter((f) =>
      read(f)
        .split("\n")
        .some((line) => line.includes(`${needle}(`) && !line.includes(`function ${needle}(`)),
    )
    .map(relPath)
    .sort();
}

describe("the query-table gate has no way around it", () => {
  it("routes every query-table export through the one gated helper", () => {
    // features/export.ts declares exportQueryTable; run.ts is the only module allowed to call it,
    // and it does so inside exportGatedQueryTable. Anything else here is a path that can publish an
    // artifact no gate ever looked at.
    expect(callers("exportQueryTable")).toEqual(["run.ts"]);
  });

  it("keeps promotion in the same helper as the export", () => {
    expect(callers("promoteQueryTable")).toEqual(["run.ts"]);
  });

  it("exports exactly once, from inside exportGatedQueryTable", () => {
    const run = read(join(SRC_DIR, "run.ts"));
    const calls = run.match(/\bexportQueryTable\(/g) ?? [];
    expect(calls.length).toBe(1);
    const helper = run.slice(run.indexOf("export async function exportGatedQueryTable"));
    const body = helper.slice(0, helper.indexOf("\n}\n") + 3);
    expect(body).toContain("exportQueryTable(");
    expect(body).toContain("validateQueryTable(");
    expect(body).toContain("promoteQueryTable(");
  });

  it("spells the published and staged filenames in one place each", () => {
    const withLiteral = (literal: string) =>
      srcFiles(SRC_DIR)
        .filter((f) => read(f).includes(`"${literal}"`))
        .map(relPath)
        .sort();
    // publish/index.ts names the object it uploads; it reads the file, it never produces one.
    expect(withLiteral(QUERY_TABLE_OBJECT)).toEqual(["features/export.ts", "publish/index.ts"]);
    expect(withLiteral(QUERY_TABLE_STAGING_OBJECT)).toEqual(["run.ts"]);
    // the CLI must ask run.ts where the artifact lives rather than rebuilding the path
    expect(read(join(SRC_DIR, "cli.ts"))).not.toContain(`"${QUERY_TABLE_OBJECT}"`);
  });
});
