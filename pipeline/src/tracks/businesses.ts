import { closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import SftpClient from "ssh2-sftp-client";
import { all, q, scalar } from "../db.js";
import { sha256File } from "../download.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { isDuvalBusiness, parseSunbizEventLine, parseSunbizRecord, splitSunbizRecords, type SunbizRecord } from "./sunbiz.js";
import type { TrackContext, TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const SUNBIZ_HOST = "sftp.floridados.gov";
/** Public credentials published by the Florida Division of Corporations (dos.fl.gov data downloads). */
export const SUNBIZ_DEFAULT_USER = "Public";
export const SUNBIZ_DEFAULT_PASSWORD = "PubAccess1845!";
export const SUNBIZ_DAILY_RE = /^(\d{8})c\.txt$/i;
export const SUNBIZ_EVENT_RE = /^(\d{8})ce\.txt$/i;

/**
 * The quarterly full corporate-data extract, published on the same public SFTP as the daily deltas.
 * One zip holding ten independently deflated members `cordata0.txt` .. `cordata9.txt`, together about
 * 1.8 GB compressed and 18.5 GB of 1,440-character records. Members are read one at a time straight
 * out of the zip, so the uncompressed bytes never touch the disk.
 */
export const SUNBIZ_QUARTERLY_ZIP = "doc/Quarterly/Cor/cordata.zip";
export const SUNBIZ_QUARTERLY_ENTRY_RE = /^cordata\d+\.txt$/i;
export const SUNBIZ_BASE_URL = `sftp://${SUNBIZ_HOST}/${SUNBIZ_QUARTERLY_ZIP}`;

/** `--window 14d` | `14` | `7 files` -> number of daily files to consider (default 14). */
export function windowDays(window: string | null, fallback = 14): number {
  if (window === null) return fallback;
  const m = /^(\d+)\s*(d|days?|files?)?$/i.exec(window.trim());
  return m ? Math.max(1, Number(m[1])) : fallback;
}

/**
 * Freshness key for a Sunbiz source file, as YYYYMMDD. The dailies carry their date in the name; the
 * quarterly members are dated from the zip's modification time. The dedup below keeps the highest
 * key per doc number, so a daily always wins over the base snapshot it post-dates.
 */
export function sunbizFileDateKey(fileName: string, fallback = 0): number {
  const m = /^(\d{8})/.exec(fileName);
  return m ? Number(m[1]) : fallback;
}

/**
 * The `authoritativeScope` for a Sunbiz merge: the target rows this run's staging is allowed to
 * report as deleted at source. Sunbiz publishes a delta feed, so a doc number absent from the files
 * this run read has not been deleted, it simply did not change; only a row last seen in a file this
 * run re-read can honestly be called missing. A run that loaded nothing speaks for nothing.
 */
export function loadedFilesScope(files: string[]): string {
  return files.length === 0 ? "FALSE" : `t.source_file IN (${files.map((f) => q(f)).join(", ")})`;
}

/** Is the quarterly base snapshot enabled? Off locally unless asked for, on by default in CI. */
export function baseSnapshotEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.SUNBIZ_BASE_SNAPSHOT?.trim();
  if (raw === undefined || raw === "") return env.CI === "true";
  return /^(1|true|yes|on)$/i.test(raw);
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

// ---------------------------------------------------------------------------------------------
// Streaming zip reader
//
// adm-zip (already a dependency) reads a whole member into a Buffer, and one cordata member is
// 1.85 GB uncompressed, past V8's maximum string length and well past anything worth holding in
// memory. The zip format lets each member be read on its own: the central directory at the end of
// the file gives the member's compressed byte range, and inflating that range is a plain stream.
// ---------------------------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** Read the central directory of a zip file (zip64 aware) without decompressing anything. */
export function readZipEntries(zipPath: string): ZipEntry[] {
  const fd = openSync(zipPath, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 66_000);
    const tail = readAt(fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error(`${zipPath}: no zip end-of-central-directory record found`);
    let entries = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || centralSize === U32_MAX || centralOffset === U32_MAX) {
      let locator = -1;
      for (let i = eocd - 20; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIG) {
          locator = i;
          break;
        }
      }
      if (locator === -1) throw new Error(`${zipPath}: zip64 end-of-central-directory locator not found`);
      const record = readAt(fd, Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (record.length < 56 || record.readUInt32LE(0) !== EOCD64_SIG) throw new Error(`${zipPath}: bad zip64 end-of-central-directory record`);
      entries = Number(record.readBigUInt64LE(32));
      centralSize = Number(record.readBigUInt64LE(40));
      centralOffset = Number(record.readBigUInt64LE(48));
    }
    const central = readAt(fd, centralOffset, centralSize);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entries; i += 1) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== CENTRAL_DIR_SIG) break;
      const method = central.readUInt16LE(p + 10);
      let compressedSize = central.readUInt32LE(p + 20);
      let uncompressedSize = central.readUInt32LE(p + 24);
      const nameLength = central.readUInt16LE(p + 28);
      const extraLength = central.readUInt16LE(p + 30);
      const commentLength = central.readUInt16LE(p + 32);
      let localHeaderOffset = central.readUInt32LE(p + 42);
      const name = central.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      const extra = central.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
        // zip64 extended information field: only the members that overflowed 32 bits are present,
        // in this fixed order
        for (let e = 0; e + 4 <= extra.length; e += 4 + extra.readUInt16LE(e + 2)) {
          if (extra.readUInt16LE(e) !== 0x0001) continue;
          let f = e + 4;
          if (uncompressedSize === U32_MAX) {
            uncompressedSize = Number(extra.readBigUInt64LE(f));
            f += 8;
          }
          if (compressedSize === U32_MAX) {
            compressedSize = Number(extra.readBigUInt64LE(f));
            f += 8;
          }
          if (localHeaderOffset === U32_MAX) localHeaderOffset = Number(extra.readBigUInt64LE(f));
          break;
        }
      }
      out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** A readable stream of one zip member's uncompressed bytes. */
export function zipEntryStream(zipPath: string, entry: ZipEntry): Readable {
  const fd = openSync(zipPath, "r");
  let dataStart: number;
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
      throw new Error(`${zipPath}: bad local file header for ${entry.name}`);
    }
    dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    closeSync(fd);
  }
  const raw = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1, highWaterMark: 1 << 20 });
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`${zipPath}: ${entry.name} uses unsupported compression method ${entry.method}`);
  const inflate = createInflateRaw({ chunkSize: 1 << 20 });
  raw.on("error", (err) => inflate.destroy(err));
  return raw.pipe(inflate);
}

/**
 * Split a stream of latin-1 text into lines and hand them over a batch at a time, so a multi-gigabyte
 * member is walked with at most one line plus one chunk in memory.
 */
export async function forEachLineBatch(stream: Readable, onBatch: (lines: string[]) => Promise<void>): Promise<void> {
  let carry = "";
  for await (const chunk of stream) {
    const text = carry + (chunk as Buffer).toString("latin1");
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      lines.push(text.slice(start, end));
      start = nl + 1;
    }
    carry = text.slice(start);
    if (lines.length > 0) await onBatch(lines);
  }
  if (carry.length > 0) await onBatch([carry.replace(/\r$/, "")]);
}

// ---------------------------------------------------------------------------------------------

/** One staging row for a parsed Sunbiz record. */
function businessValues(r: SunbizRecord, fileName: string, sha: string, priority: number): string {
  const v = (s: string | null) => q(s);
  return `(${v(r.doc_number)}, ${v(r.name)}, ${v(r.status)}, ${v(r.filing_type)}, ${v(r.principal_addr1)}, ${v(r.principal_addr2)}, ${v(r.principal_city)}, ${v(r.principal_state)}, ${v(r.principal_zip)}, ${v(r.principal_country)}, ${v(r.mail_addr1)}, ${v(r.mail_addr2)}, ${v(r.mail_city)}, ${v(r.mail_state)}, ${v(r.mail_zip)}, ${v(r.mail_country)}, ${v(r.file_date)}::DATE, ${v(r.fei_number)}, ${v(r.last_trx_date)}::DATE, ${v(r.state_country)}, ${v(r.registered_agent)}, ${v(r.registered_agent_type)}, ${v(r.ra_addr1)}, ${v(r.ra_city)}, ${v(r.ra_state)}, ${v(r.ra_zip)}, ${q(JSON.stringify(r.officers))}::JSON, ${r.officers.length}, ${q(fileName)}, ${q(sha)}, ${priority})`;
}

/** Rows per INSERT statement when loading a quarterly member. */
const BASE_INSERT_BATCH = 2000;

async function insertBusinessValues(conn: TrackContext["conn"], values: string[], batch = 500): Promise<void> {
  for (let i = 0; i < values.length; i += batch) {
    await conn.run(`INSERT INTO staging.businesses VALUES ${values.slice(i, i + batch).join(",")}`);
  }
}

interface JournalEntry {
  fileName: string;
  remotePath: string;
  remoteUrl: string;
  bytes: number;
  sha: string;
  kind: "daily" | "events" | "base";
  parsed: number;
  kept: number;
}

/**
 * Sunbiz corporate data over SFTP -> businesses (Duval filter).
 *
 * Two feeds, one target. The quarterly `cordata.zip` is the base snapshot of every Florida
 * corporation; the daily `YYYYMMDDc.txt` deltas carry that day's filings on top of it. Both are
 * incremental against the `source_files` journal: a file (or a zip member) already processed is
 * never fetched or parsed again, and re-running a file is idempotent because the merge is keyed on
 * doc_number and a row whose content did not change stays unchanged.
 *
 * The base snapshot is a 1.8 GB download, so it is off unless asked for locally and on by default in
 * CI (`SUNBIZ_BASE_SNAPSHOT=0` opts CI out). `SUNBIZ_BASE_MAX_ENTRIES` bounds how many of the ten zip
 * members a single run takes, so the load can be spread over runs and a run that dies part way still
 * keeps everything it managed to load.
 */
export const runBusinesses: TrackRunner = async (ctx: TrackContext, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "businesses");
  mkdirSync(destDir, { recursive: true });
  const days = windowDays(ctx.window, Number(ctx.env.SUNBIZ_WINDOW_DAYS ?? 14));
  const maxFiles = Number(ctx.env.SUNBIZ_MAX_FILES_PER_RUN ?? 30);
  const wantBase = baseSnapshotEnabled(ctx.env);
  const maxBaseEntries = Number(ctx.env.SUNBIZ_BASE_MAX_ENTRIES ?? 10);

  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.businesses (
    doc_number VARCHAR, name VARCHAR, status VARCHAR, filing_type VARCHAR,
    principal_addr1 VARCHAR, principal_addr2 VARCHAR, principal_city VARCHAR, principal_state VARCHAR, principal_zip VARCHAR, principal_country VARCHAR,
    mail_addr1 VARCHAR, mail_addr2 VARCHAR, mail_city VARCHAR, mail_state VARCHAR, mail_zip VARCHAR, mail_country VARCHAR,
    file_date DATE, fei_number VARCHAR, last_trx_date DATE, state_country VARCHAR,
    registered_agent VARCHAR, registered_agent_type VARCHAR, ra_addr1 VARCHAR, ra_city VARCHAR, ra_state VARCHAR, ra_zip VARCHAR,
    officers JSON, officer_count INTEGER, source_file VARCHAR, file_sha256 VARCHAR, file_priority INTEGER)`);
  await ctx.conn.run(`CREATE OR REPLACE TABLE staging.business_events (event_key VARCHAR, doc_number VARCHAR, raw_line VARCHAR, source_file VARCHAR, file_sha256 VARCHAR)`);

  const journal: JournalEntry[] = [];
  const done = new Set(
    (await all<{ file_name: string }>(ctx.conn, `SELECT file_name FROM source_files WHERE track = ${q(source.track)}`)).map((r) => r.file_name),
  );

  const sftp = new SftpClient();
  await sftp.connect({
    host: ctx.env.SUNBIZ_HOST ?? SUNBIZ_HOST,
    username: ctx.env.SUNBIZ_USER ?? SUNBIZ_DEFAULT_USER,
    password: ctx.env.SUNBIZ_PASSWORD ?? SUNBIZ_DEFAULT_PASSWORD,
    readyTimeout: 30_000,
    // the VShell server mis-frames AES-GCM with ssh2; CTR ciphers work
    algorithms: { cipher: ["aes256-ctr", "aes128-ctr"] },
  });
  let sftpOpen = true;
  const endSftp = async () => {
    if (!sftpOpen) return;
    sftpOpen = false;
    await sftp.end().catch(() => undefined);
  };
  try {
    // ---- phase 1: the quarterly base snapshot ------------------------------------------------
    let zipPath: string | null = null;
    let zipSha = "";
    let zipDateKey = 0;
    let baseTodo: ZipEntry[] = [];
    let baseEntriesTotal = 0;
    let baseMarker: string | null = null;
    const stat = wantBase ? await sftp.stat(SUNBIZ_QUARTERLY_ZIP).catch((err: Error) => err) : null;
    if (stat instanceof Error) {
      result.limitations.push(`quarterly base snapshot unavailable: sftp stat ${SUNBIZ_QUARTERLY_ZIP} failed (${stat.message})`);
    } else if (stat !== null && done.has(`cordata.zip#${stat.size}`)) {
      // every member of this exact archive is already journaled; the 1.8 GB is not fetched again.
      // A new quarterly publication changes the size, which changes the marker and reloads the base.
      result.notes.baseSnapshot = { remote: SUNBIZ_QUARTERLY_ZIP, bytes: stat.size, status: "already loaded" };
    } else if (stat !== null) {
      baseMarker = `cordata.zip#${stat.size}`;
      zipDateKey = Number(new Date(stat.modifyTime).toISOString().slice(0, 10).replace(/-/g, ""));
      zipPath = join(destDir, "cordata.zip");
      result.notes.baseSnapshot = { remote: SUNBIZ_QUARTERLY_ZIP, bytes: stat.size, publishedDateKey: zipDateKey };
      if (!(existsSync(zipPath) && statSync(zipPath).size === stat.size)) {
        const t0 = Date.now();
        log.info("sunbiz_base_download_start", { remote: SUNBIZ_QUARTERLY_ZIP, bytes: stat.size });
        await sftp.fastGet(SUNBIZ_QUARTERLY_ZIP, zipPath, { concurrency: 16, chunkSize: 32768 });
        log.info("sunbiz_base_downloaded", { bytes: stat.size, ms: Date.now() - t0 });
      }
      zipSha = await sha256File(zipPath);
      const entries = readZipEntries(zipPath)
        .filter((e) => SUNBIZ_QUARTERLY_ENTRY_RE.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      baseEntriesTotal = entries.length;
      baseTodo = entries.filter((e) => !done.has(e.name)).slice(0, Math.max(0, maxBaseEntries));
      result.notes.baseSnapshot = {
        remote: SUNBIZ_QUARTERLY_ZIP, bytes: stat.size, sha256: zipSha, publishedDateKey: zipDateKey,
        members: baseEntriesTotal, membersAlreadyLoaded: baseEntriesTotal - entries.filter((e) => !done.has(e.name)).length,
        membersThisRun: baseTodo.map((e) => e.name),
      };
    }

    // ---- phase 2: daily + events downloads ---------------------------------------------------
    const remote = await listRemote(sftp);
    const dailyAll = remote.filter((f) => f.kind === "daily");
    const eventsAll = remote.filter((f) => f.kind === "events");
    const recentDaily = dailyAll.slice(-days);
    const recentEvents = eventsAll.slice(-days);
    const todo = [...recentDaily, ...recentEvents].filter((f) => !done.has(f.name)).slice(0, maxFiles);
    result.notes.remoteDailyFiles = dailyAll.length;
    result.notes.windowDays = days;
    result.notes.filesInWindow = recentDaily.length + recentEvents.length;
    result.notes.alreadyProcessed = recentDaily.length + recentEvents.length - todo.length;
    result.notes.filesThisRun = todo.map((f) => f.name);
    log.info("sunbiz_plan", {
      windowDays: days, todo: todo.map((f) => `${f.name}:${f.size}`), alreadyProcessed: result.notes.alreadyProcessed,
      baseMembers: baseTodo.map((e) => e.name),
    });
    for (const file of todo) {
      const local = join(destDir, file.name);
      if (!(existsSync(local) && statSync(local).size === file.size)) {
        const t0 = Date.now();
        // fastGet (parallel reads) is ~25x faster than get() against this VShell server
        await sftp.fastGet(file.remote, local, { concurrency: 16, chunkSize: 32768 });
        log.info("sunbiz_file_downloaded", { file: file.name, bytes: file.size, ms: Date.now() - t0, kbps: Math.round(file.size / Math.max(1, Date.now() - t0)) });
      }
    }
    // everything else reads from disk; do not hold the SFTP session open through a long parse
    await endSftp();

    // ---- phase 3: parse the dailies ----------------------------------------------------------
    for (const file of todo) {
      const local = join(destDir, file.name);
      const sha = await sha256File(local);
      const text = readFileSync(local, "latin1");
      const priority = sunbizFileDateKey(file.name);
      const remoteUrl = `sftp://${SUNBIZ_HOST}/${file.remote}`;
      if (file.kind === "daily") {
        const { parsed, kept } = parseDailyFile(text, file.name);
        const values = kept.filter((r): r is SunbizRecord => r !== null).map((r) => businessValues(r, file.name, sha, priority));
        await insertBusinessValues(ctx.conn, values);
        journal.push({ fileName: file.name, remotePath: file.remote, remoteUrl, bytes: file.size, sha, kind: "daily", parsed, kept: kept.length });
        log.info("sunbiz_file_parsed", { file: file.name, parsed, kept: kept.length });
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const rows = lines.map(parseSunbizEventLine).filter((x): x is { doc_number: string; raw: string } => x !== null);
        const values = rows.map((r, i) => `(${q(`${file.name}:${i}`)}, ${q(r.doc_number)}, ${q(r.raw)}, ${q(file.name)}, ${q(sha)})`);
        for (let i = 0; i < values.length; i += 500) {
          await ctx.conn.run(`INSERT INTO staging.business_events VALUES ${values.slice(i, i + 500).join(",")}`);
        }
        journal.push({ fileName: file.name, remotePath: file.remote, remoteUrl, bytes: file.size, sha, kind: "events", parsed: rows.length, kept: rows.length });
        log.info("sunbiz_events_parsed", { file: file.name, rows: rows.length });
      }
    }

    // ---- phase 4: parse the quarterly members (streamed straight out of the zip) --------------
    if (zipPath !== null) {
      for (const entry of baseTodo) {
        const t0 = Date.now();
        let parsed = 0;
        let kept = 0;
        let pending: string[] = [];
        await forEachLineBatch(zipEntryStream(zipPath, entry), async (lines) => {
          for (const line of lines) {
            if (line.length < 1436) continue;
            const r = parseSunbizRecord(line);
            if (r === null) continue;
            parsed += 1;
            if (!isDuvalBusiness(r)) continue;
            kept += 1;
            pending.push(businessValues(r, entry.name, zipSha, zipDateKey));
          }
          // 2,000-row statements: measured at ~2x the 500-row batching over a 440k-row member
          if (pending.length >= BASE_INSERT_BATCH) {
            await insertBusinessValues(ctx.conn, pending, BASE_INSERT_BATCH);
            pending = [];
          }
        });
        await insertBusinessValues(ctx.conn, pending, BASE_INSERT_BATCH);
        journal.push({
          fileName: entry.name, remotePath: `${SUNBIZ_QUARTERLY_ZIP}#${entry.name}`, remoteUrl: `${SUNBIZ_BASE_URL}#${entry.name}`,
          bytes: entry.compressedSize, sha: zipSha, kind: "base", parsed, kept,
        });
        log.info("sunbiz_base_member_parsed", { member: entry.name, parsed, kept, ms: Date.now() - t0 });
      }
      const loaded = new Set([...done, ...journal.filter((j) => j.kind === "base").map((j) => j.fileName)]);
      const remaining = readZipEntries(zipPath).filter((e) => SUNBIZ_QUARTERLY_ENTRY_RE.test(e.name) && !loaded.has(e.name)).length;
      result.notes.baseMembersRemaining = remaining;
      if (remaining > 0) {
        result.limitations.push(
          `quarterly base snapshot partially loaded: ${remaining} of ${baseEntriesTotal} cordata members still to come (SUNBIZ_BASE_MAX_ENTRIES=${maxBaseEntries}); the next run picks them up`,
        );
      } else {
        // every member of this archive is journaled: record the marker so a later run knows the base
        // is complete without fetching 1.8 GB to find out, then drop the archive from disk
        if (baseMarker !== null) {
          await ctx.conn.run(
            `INSERT INTO source_files VALUES (${q(source.track)}, ${q(baseMarker)}, ${q(SUNBIZ_QUARTERLY_ZIP)}, ${statSync(zipPath).size}, ${q(zipSha)}, 0, 0, ${q(new Date().toISOString())}::TIMESTAMP, ${q(ctx.runId)})`,
          );
        }
        if (ctx.env.SUNBIZ_KEEP_QUARTERLY_ZIP !== "1") rmSync(zipPath, { force: true });
      }
    } else if (!wantBase) {
      result.limitations.push(
        "quarterly base snapshot not loaded (SUNBIZ_BASE_SNAPSHOT off): businesses holds only the daily-delta window, not the full Duval corporate register",
      );
    }

    // ---- phase 5: dedup, merge, journal ------------------------------------------------------
    // Same doc number in several files: the newest file wins (file_priority is the file's date).
    // The NOT EXISTS keeps this run from replacing a row that a strictly newer file already wrote,
    // which is what stops a freshly loaded base snapshot from undoing a daily delta on top of it.
    await ctx.conn.run(`CREATE OR REPLACE TABLE staging.businesses_dedup AS
      WITH ranked AS (
        SELECT * FROM staging.businesses
        QUALIFY row_number() OVER (PARTITION BY doc_number ORDER BY file_priority DESC) = 1
      )
      SELECT * EXCLUDE (file_sha256, file_priority) FROM ranked r
      WHERE NOT EXISTS (
        SELECT 1 FROM businesses b
        WHERE b.doc_number = r.doc_number
          AND TRY_CAST(regexp_extract(b.source_file, '^([0-9]{8})c\\.txt$', 1) AS INTEGER) > r.file_priority)`);
    result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.businesses_dedup"));
    result.notes.filesProcessed = journal.map((j) => ({ file: j.fileName, kind: j.kind, bytes: j.bytes, sha256: j.sha, parsed: j.parsed, kept: j.kept }));
    result.notes.recordsParsed = journal.filter((j) => j.kind !== "events").reduce((a, j) => a + j.parsed, 0);
    result.notes.baseRecordsParsed = journal.filter((j) => j.kind === "base").reduce((a, j) => a + j.parsed, 0);
    result.notes.baseRecordsKept = journal.filter((j) => j.kind === "base").reduce((a, j) => a + j.kept, 0);
    result.notes.eventsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.business_events"));

    // Per-file provenance: every staged row points at the exact file it was read from.
    await ctx.conn.run("CREATE OR REPLACE TABLE staging.business_files (source_file VARCHAR, remote_url VARCHAR, file_sha256 VARCHAR)");
    if (journal.length > 0) {
      await ctx.conn.run(
        `INSERT INTO staging.business_files VALUES ${journal.map((j) => `(${q(j.fileName)}, ${q(j.remoteUrl)}, ${q(j.sha)})`).join(",")}`,
      );
    }

    const prov = {
      sourceSystem: source.sourceSystem, sourceUrl: source.url, sourceArtifact: "businesses/<source_file>", sourceSha256: null,
      fetchedAt: new Date().toISOString(), runId: ctx.runId,
    };
    const hashed = await hashStaging(ctx.conn, "staging.businesses_dedup", prov);
    await ctx.conn.run(`UPDATE ${hashed} h SET source_artifact = 'businesses/' || h.source_file,
                          source_url = coalesce(f.remote_url, ${q(source.url)} || h.source_file), source_sha256 = f.file_sha256
                        FROM staging.business_files f WHERE f.source_file = h.source_file`);
    // What this run's staging can speak for: the files it actually read. Scoping this way
    // under-reports deletions (a business dropped from the quarterly whose row currently comes from
    // an older daily is not counted), which is the safe direction for a number the run record
    // publishes as "the source dropped a row we hold".
    const businessFiles = journal.filter((j) => j.kind !== "events").map((j) => j.fileName);
    const eventFiles = journal.filter((j) => j.kind === "events").map((j) => j.fileName);
    result.notes.authoritativeFiles = businessFiles;
    result.merge = await mergeStaging(ctx.conn, {
      target: "businesses",
      staging: hashed,
      keys: ["doc_number"],
      authoritativeScope: loadedFilesScope(businessFiles),
    });
    if (Number(result.notes.eventsStaged) > 0) {
      const he = await hashStaging(ctx.conn, "staging.business_events", prov);
      await ctx.conn.run(`UPDATE ${he} h SET source_artifact = 'businesses/' || h.source_file, source_url = ${q(source.url)} || 'Events/' || h.source_file, source_sha256 = h.file_sha256`);
      await ctx.conn.run(`ALTER TABLE ${he} DROP COLUMN file_sha256`);
      // event_key is '<file>:<line>', so this staging can only ever speak for the event files it read
      result.notes.eventsMerge = await mergeStaging(ctx.conn, {
        target: "business_events",
        staging: he,
        keys: ["event_key"],
        authoritativeScope: loadedFilesScope(eventFiles),
      });
    }
    for (const j of journal) {
      await ctx.conn.run(`INSERT INTO source_files VALUES (${q(source.track)}, ${q(j.fileName)}, ${q(j.remotePath)}, ${j.bytes}, ${q(j.sha)}, ${j.parsed}, ${j.kept}, ${q(new Date().toISOString())}::TIMESTAMP, ${q(ctx.runId)})`);
    }
    log.info("merged", { table: "businesses", ...result.merge });
    if (recentDaily.length + recentEvents.length - todo.length - (result.notes.alreadyProcessed as number) > 0) {
      result.limitations.push(`SUNBIZ_MAX_FILES_PER_RUN=${maxFiles} reached; remaining files in the window are picked up next run`);
    }
    result.status = "completed";
  } finally {
    await endSftp();
  }
  result.finishedAt = new Date().toISOString();
  return result;
};
