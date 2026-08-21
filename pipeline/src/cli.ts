import { join } from "node:path";
import { ulid } from "ulid";
import { getPaths } from "./config.js";
import { consolidationArtifacts, consolidationStateStats, exportConsolidation } from "./consolidation/export.js";
import { formatOpenDataResult, publishOpenData } from "./publish/openData.js";
import { all, ensureSchema, openDb, q } from "./db.js";
import { buildFeatures } from "./features/build.js";
import { exportEntityTables, exportQueryTable, formatValidation, validateQueryTable } from "./features/export.js";
import { log } from "./log.js";
import { executePublish, formatManifest, formatPlan, planPublish } from "./publish/index.js";
import { readFilebaseEnv } from "./publish/filebase.js";
import { loadRunHistory, runPipeline, tableTotals, writeRunHistoryFiles } from "./run.js";
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
  pnpm run features                      rebuild derived.properties_features + query-table.parquet + validate
  pnpm run validate                      re-run the query-table validation gate against the DB
  pnpm run publish:ipfs -- [--publish]   dry-run by default; --publish uploads to Filebase + re-points IPNS
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
      if (validation && !validation.ok) process.exitCode = 1;
      return;
    }
    case "features": {
      const db = await openDb(paths.dbPath);
      await ensureSchema(db.conn);
      const asOf = new Date().toISOString().slice(0, 10);
      const stats = await buildFeatures(db.conn, { asOf, runId: "features-cli" });
      log.info("features_built", { ...stats });
      const qt = join(paths.publishDir, "query-table.parquet");
      const exp = await exportQueryTable(db.conn, qt);
      log.info("query_table_exported", { ...exp });
      const report = await validateQueryTable(db.conn, qt);
      process.stdout.write(formatValidation(report) + "\n");
      const tables = await exportEntityTables(db.conn, join(paths.publishDir, "tables"));
      log.info("entity_tables_exported", { tables });
      await db.close();
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "validate": {
      const db = await openDb(paths.dbPath, { readOnly: true });
      const report = await validateQueryTable(db.conn, join(paths.publishDir, "query-table.parquet"));
      process.stdout.write(formatValidation(report) + "\n");
      await db.close();
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "publish": {
      const publish = args.flags.get("publish") === "true" && args.flags.get("dry-run") !== "true";
      if (!publish) {
        const fb = readFilebaseEnv(env);
        const plan = await planPublish(paths);
        process.stdout.write(formatPlan(plan, fb?.bucket ?? null, fb?.gateway ?? "https://ipfs.filebase.io") + "\n\n");
      }
      const manifest = await executePublish({ paths, env, publish, logger: log });
      process.stdout.write(formatManifest(manifest) + "\n");
      return;
    }
    case "consolidation": {
      const db = await openDb(paths.dbPath);
      await ensureSchema(db.conn);
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
        const qt = join(paths.publishDir, "query-table.parquet");
        const exported = await exportQueryTable(db.conn, qt);
        const report = await validateQueryTable(db.conn, qt);
        // Record the parquet this pass just republished as a published object, under the same name
        // and CID shape the ingestion run uses, so it joins the published artifacts index.
        const artifacts = await consolidationArtifacts({ outDir, stats, exported, validation: report });
        const finishedAt = new Date().toISOString();
        const sources = [{ track: "consolidation", source_system: "duval_consolidation", target_table: "consolidation_state", source_url: "derived", rows_staged: stats.candidates, inserted: stats.exported, updated: 0, unchanged: stats.unchanged, missing_in_source: 0, table_total_after: stats.totalInState, status: "completed", started_at: startedAt, finished_at: finishedAt, limitations: [], notes: { shards: stats.shards, totalBytes: stats.totalBytes, indexCid: stats.indexCid, manifestCid: stats.manifestCid, ms: stats.ms, limit, since } }];
        await db.conn.run(`INSERT INTO run_log_sources VALUES (${q(runId)}, 'consolidation', 'duval_consolidation', 'consolidation_state', 'derived', ${q(outDir)}, NULL, NULL, NULL, NULL, 'derived', ${stats.candidates}, ${stats.exported}, 0, ${stats.unchanged}, 0, ${stats.totalInState}, ${stats.exported}, ${q(startedAt)}::TIMESTAMP, ${q(finishedAt)}::TIMESTAMP, 'completed', '[]'::JSON, NULL)`);
        await db.conn.run(`UPDATE run_log SET finished_at = ${q(finishedAt)}::TIMESTAMP, status = 'completed', sources = ${q(JSON.stringify(sources))}::JSON, limitations = '[]'::JSON,
          totals = ${q(JSON.stringify({ consolidation_state: stats.totalInState, totalBytes: stats.totalBytes, shards: stats.shards }))}::JSON,
          artifacts = ${q(JSON.stringify(artifacts))}::JSON WHERE run_id = ${q(runId)}`);
        await writeRunHistoryFiles(db, paths, runId);
        process.stdout.write(formatValidation(report) + "\n");
        process.stdout.write(`\n=== CONSOLIDATION ${runId} ===\ncandidates ${stats.candidates}, exported ${stats.exported}, unchanged ${stats.unchanged}, in state ${stats.totalInState}, shards ${stats.shards}, bytes ${stats.totalBytes}, index cid ${stats.indexCid}, ${Math.round(stats.ms / 1000)} s\n`);
      } catch (err) {
        await db.conn.run(`UPDATE run_log SET finished_at = now(), status = 'failed', error = ${q(err instanceof Error ? err.message : String(err))} WHERE run_id = ${q(runId)}`);
        throw err;
      } finally {
        await db.close();
      }
      return;
    }
    case "publish-open-data": {
      const publish = args.flags.get("publish") === "true" && args.flags.get("dry-run") !== "true";
      const fb = readFilebaseEnv(env);
      const result = await publishOpenData({ paths, env, publish, logger: log });
      process.stdout.write(formatOpenDataResult(result, fb?.bucket ?? null, fb?.gateway ?? "https://ipfs.filebase.io") + "\n");
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
