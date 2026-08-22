import { join, relative } from "node:path";
import { ulid } from "ulid";
import { COUNTY, getPaths } from "./config.js";
import { CONSOLIDATION_TRACK, consolidationArtifacts, consolidationSourceRecord, consolidationStateStats, exportConsolidation } from "./consolidation/export.js";
import { formatOpenDataResult, publishOpenData } from "./publish/openData.js";
import { all, ensureSchema, openDb, q } from "./db.js";
import { buildFeatures } from "./features/build.js";
import { exportEntityTables, formatValidation, validateQueryTable } from "./features/export.js";
import { log } from "./log.js";
import { executePublish, formatManifest, formatPlan, planPublish } from "./publish/index.js";
import { readFilebaseEnv } from "./publish/filebase.js";
import {
  formatRegressions,
  readCiEnv,
  recordCiRun,
  recordTableHighwater,
  snapshotTrackState,
  type TrackStateRow,
} from "./publish/ledger.js";
import {
  exportGatedQueryTable,
  loadRunHistory,
  previousTotal,
  queryTablePath,
  resolvePublishMode,
  runPipeline,
  tableTotals,
  writeRunHistoryFiles,
} from "./run.js";
import { insertRunSource, rehydrateRunLog } from "./runLog.js";
import { parseTracks } from "./sources.js";

interface Args {
  command: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(tok.slice(2), next);
        i += 1;
      } else flags.set(tok.slice(2), "true");
    } else positional.push(tok);
  }
  return { command, flags, positional };
}

const HELP = `duval oracle pipeline

  pnpm run pipeline -- [--tracks appraisal,sales,geometry|all|default] [--window <w>] [--trigger <t>] [--force] [--no-features]
                                         [--allow-regression] accept (and record) a table total that went backwards
  pnpm run features                      rebuild derived.properties_features + query-table.parquet + validate
  pnpm run validate                      re-run the query-table validation gate against the DB
  pnpm run publish:ipfs -- [--publish]   dry-run by default; --publish uploads to Filebase + re-points IPNS
                                         --publish without readable Filebase settings FAILS; it never becomes a dry run
  pnpm run export:consolidation -- [--since all|changed|<run_id>] [--shard-size 10000] [--limit N] [--out-dir DIR]
  pnpm run publish:open-data -- [--publish]   per-property open-data files + shards + index; IPNS oracle-open-data-duval
  pnpm run status                        table counts + run history summary
  pnpm run query -- "<sql>"              ad-hoc read-only SQL against the DuckDB file (JSON out)
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const paths = getPaths(env);

  switch (args.command) {
    case "run": {
      const tracks = parseTracks(args.flags.get("tracks"));
      const trigger = args.flags.get("trigger") ?? env.GITHUB_EVENT_NAME ?? "manual";
      const { run, validation } = await runPipeline({
        tracks,
        window: args.flags.get("window") ?? null,
        trigger,
        force: args.flags.get("force") === "true",
        skipFeatures: args.flags.get("no-features") === "true",
        env,
      });
      process.stdout.write(`\n=== RUN ${run.run_id} ${run.status} ===\n`);
      for (const s of run.sources) {
        process.stdout.write(
          `${s.track.padEnd(11)} ${s.status.padEnd(9)} staged=${s.rows_staged} inserted=${s.inserted ?? "-"} updated=${s.updated ?? "-"} unchanged=${s.unchanged ?? "-"} missing=${s.missing_in_source ?? "-"} total=${s.table_total_after ?? "-"} delta=${s.delta_vs_prev_total ?? "-"} download=${s.download_status ?? "-"}\n`,
        );
      }
      process.stdout.write(`totals: ${JSON.stringify(run.totals)}\n`);

      // Which CI event produced this run, recorded where a reviewer can read it without a database
      // and without trusting an Actions cache. See publish/ledger.ts.
      const ci = recordCiRun(paths, {
        run_id: run.run_id,
        kind: "ingestion",
        trigger: run.trigger,
        ...readCiEnv(env),
        started_at: run.started_at,
        finished_at: run.finished_at,
        status: run.status,
      });
      log.info("ci_run_recorded", { file: ci.file, by_event: ci.ledger.by_event });

      // Cursors, committed. A rewind then shows up in the diff of the commit that caused it. This
      // is evidence, not control flow: a run that ingested and validated cleanly is not failed over
      // a snapshot that could not be written.
      try {
        const stateDb = await openDb(paths.dbPath, { readOnly: true });
        try {
          const rows = await all<TrackStateRow>(
            stateDb.conn,
            "SELECT track, key, value, strftime(updated_at, '%Y-%m-%dT%H:%M:%SZ') AS updated_at, run_id FROM track_state ORDER BY track, key",
          );
          const snap = snapshotTrackState(paths, rows, run.run_id);
          log.info("track_state_snapshot", { file: snap.file, entries: rows.length });
        } finally {
          await stateDb.close();
        }
      } catch (err) {
        log.warn("track_state_snapshot_failed", { error: err instanceof Error ? err.message : String(err) });
      }

      // Accumulating tables must not shrink unnoticed when the working set is rebuilt from scratch.
      const allowRegression = args.flags.get("allow-regression") === "true";
      const hw = recordTableHighwater(paths, {
        runId: run.run_id,
        trigger: run.trigger,
        totals: run.totals,
        allowRegression,
        note: args.flags.get("regression-note") ?? null,
      });
      if (hw.regressions.length > 0) {
        const verb = allowRegression ? "ACCEPTED" : "BLOCKED";
        process.stdout.write(`\n=== TABLE TOTAL REGRESSION ${verb} ===\n${formatRegressions(hw.regressions)}\n`);
        process.stdout.write(`recorded in ${hw.file}\n`);
        log.error("table_totals_regressed", { accepted: allowRegression, regressions: hw.regressions, file: hw.file });
        if (!allowRegression) {
          process.stdout.write(
            "This run has fewer rows than a previous run on this lineage, which normally means it started from a cold\n" +
              "working set and an accumulating cursor restarted early. Re-run with the cache restored, or re-run with\n" +
              "--allow-regression --regression-note \"<why>\" to re-base the high-water mark on purpose.\n",
          );
          process.exitCode = 1;
        }
      }
      if (validation && !validation.ok) process.exitCode = 1;
      return;
    }
    case "features": {
      const db = await openDb(paths.dbPath);
      await ensureSchema(db.conn);
      const asOf = new Date().toISOString().slice(0, 10);
      const stats = await buildFeatures(db.conn, { asOf, runId: "features-cli" });
      log.info("features_built", { ...stats });
      // Same gate, same staging, same promotion as every other pass that writes the parquet.
      const gated = await exportGatedQueryTable(db.conn, paths.publishDir);
      log.info("query_table_exported", { ...gated.exported, promoted: gated.gate.promoted });
      process.stdout.write(formatValidation(gated.validation) + "\n");
      const tables = await exportEntityTables(db.conn, join(paths.publishDir, "tables"));
      log.info("entity_tables_exported", { tables });
      await db.close();
      if (!gated.gate.promoted) {
        process.stdout.write(`\nGATE FAILED: ${gated.gate.message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "validate": {
      const db = await openDb(paths.dbPath, { readOnly: true });
      const report = await validateQueryTable(db.conn, queryTablePath(paths.publishDir));
      process.stdout.write(formatValidation(report) + "\n");
      await db.close();
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "publish": {
      const intent = resolvePublishMode(args.flags, env);
      if (intent.mode === "refused") {
        process.stdout.write(`PUBLISH REFUSED: ${intent.reason}\nNothing was uploaded.\n`);
        log.error("publish_refused", { command: "publish", reason: intent.reason, missing: intent.missing });
        process.exitCode = 1;
        return;
      }
      const publish = intent.mode === "publish";
      if (!publish) {
        const fb = readFilebaseEnv(env);
        const plan = await planPublish(paths);
        process.stdout.write(formatPlan(plan, fb?.bucket ?? null, fb?.gateway ?? "https://ipfs.filebase.io") + "\n\n");
      }
      const manifest = await executePublish({ paths, env, publish, logger: log });
      process.stdout.write(formatManifest(manifest) + "\n");
      // Uploads throw on failure, so reaching here means every object is in the bucket. What can
      // still be wrong is a mutable name that did not move; anything other than the storage account
      // refusing to mint another name is a real failure and has to make CI red.
      if (!manifest.ok) {
        const failed = manifest.ipnsFailures.filter((f) => f.kind === "failed");
        log.error("publish_incomplete", { failed });
        process.exitCode = 1;
      }
      return;
    }
    case "consolidation": {
      const db = await openDb(paths.dbPath);
      await ensureSchema(db.conn);
      // This pass republishes run-history.json from run_log (writeRunHistoryFiles below), so a
      // cold database would publish a history of one. Fill the gaps from the committed records
      // first; anything already in run_log wins.
      await rehydrateRunLog(db, { runsDir: paths.runsDir, county: COUNTY.key, logger: log });
      const runId = ulid();
      const startedAt = new Date().toISOString();
      const since = args.flags.get("since") ?? "changed";
      const shardSize = Number(args.flags.get("shard-size") ?? "10000");
      const limit = args.flags.get("limit") ? Number(args.flags.get("limit")) : null;
      const outDir = args.flags.get("out-dir") ?? join(paths.publishDir, "open-data");
      const lexiconDir = join(paths.artifactsDir, "pa_detail", "lexicon");
      await db.conn.run(`INSERT INTO run_log (run_id, started_at, status, trigger, tracks, "window") VALUES (${q(runId)}, ${q(startedAt)}::TIMESTAMP, 'running', 'consolidation', 'consolidation', ${q(since)})`);
      try {
        const stats = await exportConsolidation(db.conn, { outDir, shardSize, since, limit, runId, logger: log, lexiconDir });
        // refresh the query table so property_cid is filled from consolidation_state
        const asOf = new Date().toISOString().slice(0, 10);
        await buildFeatures(db.conn, { asOf, runId });
        // The SAME gate the ingestion run applies, because it is the same function. This pass runs
        // after the ingestion run and rewrites query-table.parquet, so it is a code path that
        // produces the artifact we publish, and every such path stages, validates, then promotes.
        const { exported, validation: report, gate } = await exportGatedQueryTable(db.conn, paths.publishDir);
        if (gate.promoted) log.info("consolidation_gate_passed", { path: gate.publishPath, rows: report.rows });
        else log.error("consolidation_gate_failed", { problems: report.problems, rows: report.rows, kept: gate.publishPath });
        // Record the parquet this pass just republished as a published object, under the same name
        // and CID shape the ingestion run uses, so it joins the published artifacts index.
        const artifacts = await consolidationArtifacts({ outDir, stats, exported, validation: report });
        const finishedAt = new Date().toISOString();
        // The pass describes itself as one run source, and the SAME record becomes both the
        // published `sources` JSON and the `run_log_sources` row, through the one INSERT the
        // ingestion tracks and the rehydrate path already share. It used to be two hand written
        // expressions: the row put `stats.exported` (records republished) in
        // `delta_vs_prev_total`, and the JSON carried no delta key at all.
        // `updated` is 0 and `missing_in_source` is 0 because this pass never measures either:
        // it deletes and rewrites every candidate whose content hash moved, so a re-hashed
        // property is counted under `inserted`, and it never looks for state rows the candidate
        // set no longer contains.
        const prevTotal = await previousTotal(db, CONSOLIDATION_TRACK);
        const source = consolidationSourceRecord({
          stats,
          startedAt,
          finishedAt,
          // Relative to the publish directory, so a runner local absolute path stays out of the
          // published run history now that the row and the JSON are the same object.
          artifactPath: relative(paths.publishDir, outDir) || ".",
          prevTotal,
          since,
          limit,
        });
        const sources = [source];
        await insertRunSource(db, runId, source);
        const status = report.ok ? "completed" : "completed_with_errors";
        const gateError = report.ok ? null : `query table validation gate failed: ${report.problems.join("; ")}`;
        await db.conn.run(`UPDATE run_log SET finished_at = ${q(finishedAt)}::TIMESTAMP, status = ${q(status)}, sources = ${q(JSON.stringify(sources))}::JSON,
          limitations = ${q(JSON.stringify(report.ok ? [] : report.problems))}::JSON,
          error = ${gateError === null ? "NULL" : q(gateError)},
          totals = ${q(JSON.stringify({ consolidation_state: stats.totalInState, totalBytes: stats.totalBytes, shards: stats.shards }))}::JSON,
          artifacts = ${q(JSON.stringify(artifacts))}::JSON WHERE run_id = ${q(runId)}`);
        await writeRunHistoryFiles(db, paths, runId);
        // The consolidation pass keeps `trigger: "consolidation"` because that is the run KIND the
        // UI groups on. Which CI event started it is recorded here instead, so a scheduled
        // consolidation is as self-evident as a scheduled ingestion run.
        recordCiRun(paths, {
          run_id: runId,
          kind: "consolidation",
          trigger: "consolidation",
          ...readCiEnv(env),
          started_at: startedAt,
          finished_at: finishedAt,
          status,
        });
        process.stdout.write(formatValidation(report) + "\n");
        process.stdout.write(`\n=== CONSOLIDATION ${runId} ===\ncandidates ${stats.candidates}, exported ${stats.exported}, unchanged ${stats.unchanged}, in state ${stats.totalInState}, shards ${stats.shards}, bytes ${stats.totalBytes}, index cid ${stats.indexCid}, ${Math.round(stats.ms / 1000)} s\n`);
        if (!gate.promoted) {
          process.stdout.write(`\nGATE FAILED: ${gate.message}\n`);
          process.exitCode = 1;
        }
      } catch (err) {
        await db.conn.run(`UPDATE run_log SET finished_at = now(), status = 'failed', error = ${q(err instanceof Error ? err.message : String(err))} WHERE run_id = ${q(runId)}`);
        throw err;
      } finally {
        await db.close();
      }
      return;
    }
    case "publish-open-data": {
      // Refuse BEFORE planning: a dry-run plan printed under a `--publish` invocation is the exact
      // output that made an unpublished run look published. See resolvePublishMode in run.ts.
      const intent = resolvePublishMode(args.flags, env);
      if (intent.mode === "refused") {
        process.stdout.write(`OPEN DATA PUBLISH REFUSED: ${intent.reason}\nNothing was uploaded.\n`);
        log.error("publish_refused", { command: "publish-open-data", reason: intent.reason, missing: intent.missing });
        process.exitCode = 1;
        return;
      }
      const publish = intent.mode === "publish";
      const fb = readFilebaseEnv(env);
      const result = await publishOpenData({ paths, env, publish, logger: log });
      process.stdout.write(formatOpenDataResult(result, fb?.bucket ?? null, fb?.gateway ?? "https://ipfs.filebase.io") + "\n");
      // Belt and braces for the same class of defect one layer down: whatever else went wrong,
      // an invocation that asked to publish and came back describing a dry run published nothing.
      if (publish && result.mode !== "published") {
        process.stdout.write(`OPEN DATA PUBLISH DEGRADED: --publish was given but the run reported mode "${result.mode}"; nothing was uploaded.\n`);
        log.error("publish_degraded_to_dry_run", { command: "publish-open-data", mode: result.mode });
        process.exitCode = 1;
      }
      return;
    }
    case "status": {
      const db = await openDb(paths.dbPath, { readOnly: true });
      const totals = await tableTotals(db);
      const history = await loadRunHistory(db);
      process.stdout.write(`db: ${paths.dbPath}\n`);
      process.stdout.write(`tables: ${JSON.stringify(totals, null, 2)}\n`);
      process.stdout.write(`consolidation: ${JSON.stringify(await consolidationStateStats(db.conn))}\n`);
      process.stdout.write(`runs (${history.length}):\n`);
      for (const r of history) {
        process.stdout.write(
          `  ${r.run_id} ${r.started_at} ${r.status.padEnd(22)} tracks=${r.tracks.join(",")} ` +
            r.sources.map((s) => `${s.track}:+${s.inserted ?? 0}/~${s.updated ?? 0}/=${s.unchanged ?? 0}`).join(" ") +
            "\n",
        );
      }
      await db.close();
      return;
    }
    case "query": {
      const sql = args.positional.join(" ");
      if (sql.trim() === "") throw new Error("query requires an SQL string");
      const db = await openDb(paths.dbPath, { readOnly: true });
      const rows = await all(db.conn, sql);
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      await db.close();
      return;
    }
    default:
      process.stdout.write(HELP);
  }
}

main().catch((err: unknown) => {
  log.error("cli_failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
