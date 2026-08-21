import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import SftpClient from "ssh2-sftp-client";
import { all, q, scalar } from "../db.js";
import { sha256File } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { isDuvalBusiness, parseSunbizEventLine, parseSunbizRecord, splitSunbizRecords } from "./sunbiz.js";
import type { TrackContext, TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const SUNBIZ_HOST = "sftp.floridados.gov";
/** Public credentials published by the Florida Division of Corporations (dos.fl.gov data downloads). */
export const SUNBIZ_DEFAULT_USER = "Public";
export const SUNBIZ_DEFAULT_PASSWORD = "PubAccess1845!";
export const SUNBIZ_DAILY_RE = /^(\d{8})c\.txt$/i;
export const SUNBIZ_EVENT_RE = /^(\d{8})ce\.txt$/i;

/** `--window 14d` | `14` | `7 files` -> number of daily files to consider (default 14). */
export function windowDays(window: string | null, fallback = 14): number {
  if (window === null) return fallback;
  const m = /^(\d+)\s*(d|days?|files?)?$/i.exec(window.trim());
  return m ? Math.max(1, Number(m[1])) : fallback;
}

interface RemoteFile {
  name: string;
  remote: string;
  size: number;
  kind: "daily" | "events";
}

async function listRemote(sftp: SftpClient): Promise<RemoteFile[]> {
  const cor = await sftp.list("doc/cor");
  const ev = await sftp.list("doc/cor/Events");
  const daily: RemoteFile[] = cor
    .filter((f) => f.type === "-" && SUNBIZ_DAILY_RE.test(f.name))
    .map((f) => ({ name: f.name, remote: `doc/cor/${f.name}`, size: f.size, kind: "daily" as const }));
  const events: RemoteFile[] = ev
    .filter((f) => f.type === "-" && SUNBIZ_EVENT_RE.test(f.name))
    .map((f) => ({ name: f.name, remote: `doc/cor/Events/${f.name}`, size: f.size, kind: "events" as const }));
  return [...daily, ...events].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse + filter one daily file into rows for staging (pure; used by tests). */
export function parseDailyFile(text: string, fileName: string): { parsed: number; kept: ReturnType<typeof parseSunbizRecord>[] } {
  const lines = splitSunbizRecords(text);
  const kept: ReturnType<typeof parseSunbizRecord>[] = [];
  let parsed = 0;
  for (const line of lines) {
    const r = parseSunbizRecord(line);
    if (r === null) continue;
    parsed += 1;
    if (isDuvalBusiness(r)) kept.push(r);
  }
  void fileName;
  return { parsed, kept };
}

/**
 * Sunbiz daily corporate files over SFTP -> businesses (Duval filter). Incremental: only files not
 * yet journaled in source_files are fetched and parsed; the window bounds how many recent files are
 * considered per run. A file already on disk with the listed size is not re-downloaded.
 */
export const runBusinesses: TrackRunner = async (ctx: TrackContext, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "businesses");
  mkdirSync(destDir, { recursive: true });
  const days = windowDays(ctx.window, Number(ctx.env.SUNBIZ_WINDOW_DAYS ?? 14));
  const maxFiles = Number(ctx.env.SUNBIZ_MAX_FILES_PER_RUN ?? 30);

  const sftp = new SftpClient();
  await sftp.connect({
    host: ctx.env.SUNBIZ_HOST ?? SUNBIZ_HOST,
    username: ctx.env.SUNBIZ_USER ?? SUNBIZ_DEFAULT_USER,
    password: ctx.env.SUNBIZ_PASSWORD ?? SUNBIZ_DEFAULT_PASSWORD,
    readyTimeout: 30_000,
    // the VShell server mis-frames AES-GCM with ssh2; CTR ciphers work
    algorithms: { cipher: ["aes256-ctr", "aes128-ctr"] },
  });
  try {
    const remote = await listRemote(sftp);
    const dailyAll = remote.filter((f) => f.kind === "daily");
    const eventsAll = remote.filter((f) => f.kind === "events");
    const recentDaily = dailyAll.slice(-days);
    const recentEvents = eventsAll.slice(-days);
    const done = new Set(
      (await all<{ file_name: string }>(ctx.conn, `SELECT file_name FROM source_files WHERE track = ${q(source.track)}`)).map((r) => r.file_name),
    );
    const todo = [...recentDaily, ...recentEvents].filter((f) => !done.has(f.name)).slice(0, maxFiles);
    result.notes.remoteDailyFiles = dailyAll.length;
    result.notes.windowDays = days;
    result.notes.filesInWindow = recentDaily.length + recentEvents.length;
    result.notes.alreadyProcessed = recentDaily.length + recentEvents.length - todo.length;
    result.notes.filesThisRun = todo.map((f) => f.name);
    log.info("sunbiz_plan", { windowDays: days, todo: todo.map((f) => `${f.name}:${f.size}`), alreadyProcessed: result.notes.alreadyProcessed });

    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.businesses (
      doc_number VARCHAR, name VARCHAR, status VARCHAR, filing_type VARCHAR,
      principal_addr1 VARCHAR, principal_addr2 VARCHAR, principal_city VARCHAR, principal_state VARCHAR, principal_zip VARCHAR, principal_country VARCHAR,
      mail_addr1 VARCHAR, mail_addr2 VARCHAR, mail_city VARCHAR, mail_state VARCHAR, mail_zip VARCHAR, mail_country VARCHAR,
      file_date DATE, fei_number VARCHAR, last_trx_date DATE, state_country VARCHAR,
      registered_agent VARCHAR, registered_agent_type VARCHAR, ra_addr1 VARCHAR, ra_city VARCHAR, ra_state VARCHAR, ra_zip VARCHAR,
      officers JSON, officer_count INTEGER, source_file VARCHAR, file_sha256 VARCHAR, file_priority INTEGER)`);
    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.business_events (event_key VARCHAR, doc_number VARCHAR, raw_line VARCHAR, source_file VARCHAR, file_sha256 VARCHAR)`);

    const journal: { file: RemoteFile; sha: string; parsed: number; kept: number }[] = [];
    let fileIdx = 0;
    for (const file of todo) {
      const local = join(destDir, file.name);
      if (!(existsSync(local) && statSync(local).size === file.size)) {
        const t0 = Date.now();
        // fastGet (parallel reads) is ~25x faster than get() against this VShell server
        await sftp.fastGet(file.remote, local, { concurrency: 16, chunkSize: 32768 });
        log.info("sunbiz_file_downloaded", { file: file.name, bytes: file.size, ms: Date.now() - t0, kbps: Math.round(file.size / Math.max(1, Date.now() - t0)) });
      }
      const sha = await sha256File(local);
      const text = readFileSync(local, "latin1");
      if (file.kind === "daily") {
        const { parsed, kept } = parseDailyFile(text, file.name);
        fileIdx += 1;
        if (kept.length > 0) {
          const values = kept
            .map((r) => {
              if (r === null) return null;
              const v = (s: string | null) => q(s);
              return `(${v(r.doc_number)}, ${v(r.name)}, ${v(r.status)}, ${v(r.filing_type)}, ${v(r.principal_addr1)}, ${v(r.principal_addr2)}, ${v(r.principal_city)}, ${v(r.principal_state)}, ${v(r.principal_zip)}, ${v(r.principal_country)}, ${v(r.mail_addr1)}, ${v(r.mail_addr2)}, ${v(r.mail_city)}, ${v(r.mail_state)}, ${v(r.mail_zip)}, ${v(r.mail_country)}, ${v(r.file_date)}::DATE, ${v(r.fei_number)}, ${v(r.last_trx_date)}::DATE, ${v(r.state_country)}, ${v(r.registered_agent)}, ${v(r.registered_agent_type)}, ${v(r.ra_addr1)}, ${v(r.ra_city)}, ${v(r.ra_state)}, ${v(r.ra_zip)}, ${q(JSON.stringify(r.officers))}::JSON, ${r.officers.length}, ${q(file.name)}, ${q(sha)}, ${fileIdx})`;
            })
            .filter((x): x is string => x !== null);
          for (let i = 0; i < values.length; i += 500) {
            await ctx.conn.run(`INSERT INTO staging.businesses VALUES ${values.slice(i, i + 500).join(",")}`);
          }
        }
        journal.push({ file, sha, parsed, kept: kept.length });
        log.info("sunbiz_file_parsed", { file: file.name, parsed, kept: kept.length });
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const rows = lines.map(parseSunbizEventLine).filter((x): x is { doc_number: string; raw: string } => x !== null);
        const values = rows.map((r, i) => `(${q(`${file.name}:${i}`)}, ${q(r.doc_number)}, ${q(r.raw)}, ${q(file.name)}, ${q(sha)})`);
        for (let i = 0; i < values.length; i += 500) {
          await ctx.conn.run(`INSERT INTO staging.business_events VALUES ${values.slice(i, i + 500).join(",")}`);
        }
        journal.push({ file, sha, parsed: rows.length, kept: rows.length });
        log.info("sunbiz_events_parsed", { file: file.name, rows: rows.length });
      }
    }

    // Same doc number in several daily files: keep the latest file's version.
    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.businesses_dedup AS
      SELECT * EXCLUDE (file_sha256, file_priority) FROM staging.businesses
      QUALIFY row_number() OVER (PARTITION BY doc_number ORDER BY file_priority DESC) = 1`);
    result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.businesses_dedup"));
    result.notes.filesProcessed = journal.map((j) => ({ file: j.file.name, bytes: j.file.size, sha256: j.sha, parsed: j.parsed, kept: j.kept }));
    result.notes.recordsParsed = journal.filter((j) => j.file.kind === "daily").reduce((a, j) => a + j.parsed, 0);
    result.notes.eventsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.business_events"));

    const prov = {
      sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: "businesses/<source_file>", sourceSha256: null,
      fetchedAt: new Date().toISOString(), runId: ctx.runId,
    };
    const hashed = await hashStaging(ctx.conn, "staging.businesses_dedup", prov);
    await ctx.conn.run(`UPDATE ${hashed} h SET source_artifact = 'businesses/' || h.source_file, source_url = ${q(source.url)} || h.source_file,
                          source_sha256 = (SELECT any_value(file_sha256) FROM staging.businesses b WHERE b.source_file = h.source_file)`);
    result.merge = await mergeStaging(ctx.conn, { target: "businesses", staging: hashed, keys: ["doc_number"] });
    if (result.notes.eventsStaged && Number(result.notes.eventsStaged) > 0) {
      const he = await hashStaging(ctx.conn, "staging.business_events", prov);
      await ctx.conn.run(`UPDATE ${he} h SET source_artifact = 'businesses/' || h.source_file, source_url = ${q(source.url)} || 'Events/' || h.source_file, source_sha256 = h.file_sha256`);
      await ctx.conn.run(`ALTER TABLE ${he} DROP COLUMN file_sha256`);
      result.notes.eventsMerge = await mergeStaging(ctx.conn, { target: "business_events", staging: he, keys: ["event_key"] });
    }
    for (const j of journal) {
      await ctx.conn.run(`INSERT INTO source_files VALUES (${q(source.track)}, ${q(j.file.name)}, ${q(j.file.remote)}, ${j.file.size}, ${q(j.sha)}, ${j.parsed}, ${j.kept}, ${q(new Date().toISOString())}::TIMESTAMP, ${q(ctx.runId)})`);
    }
    log.info("merged", { table: "businesses", ...result.merge });
    if (recentDaily.length + recentEvents.length - todo.length - (result.notes.alreadyProcessed as number) > 0) {
      result.limitations.push(`SUNBIZ_MAX_FILES_PER_RUN=${maxFiles} reached; remaining files in the window are picked up next run`);
    }
    result.status = "completed";
  } finally {
    await sftp.end().catch(() => undefined);
  }
  result.finishedAt = new Date().toISOString();
  return result;
};
