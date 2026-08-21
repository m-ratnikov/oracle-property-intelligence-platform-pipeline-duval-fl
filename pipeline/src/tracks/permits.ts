import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, getTrackState, q, scalar, setTrackState } from "../db.js";
import { normalizeParcelIdSql } from "../features/normalize.js";
import { hashStaging, mergeStaging } from "../merge.js";
import { BROWSER_UA, getJson, mapLimit, sleep } from "./http.js";
import type { TrackRunner } from "./types.js";
import { startResult } from "./types.js";

export const JAXEPICS_VIEW = "https://jaxepics.coj.net/Permit/View/";
export const JAXEPICS_API_HOST = "https://jaxepicsapi.coj.net";
export const ROOF_RE = /\b(RE-?ROOF|ROOF(ING)?|SHINGLE)\b/i;
/**
 * Reported after every run so the run history keeps showing a position. Nothing reads it back to
 * decide what to fetch any more; see coveredSequences for why.
 */
export const STATE_CURSOR = "cursor_seq";
export const STATE_API = "discovered_api";
/** Appended once a run's merge commits: the permit numbers that run got a definitive answer for. */
export const ANSWERED_LOG = "answered-permits.txt";

export interface PermitRow {
  permit_no: string;
  re_raw: string | null;
  address: string | null;
  permit_type: string | null;
  work_type: string | null;
  description: string | null;
  status: string | null;
  applied_date: string | null;
  issue_date: string | null;
  final_date: string | null;
  job_cost: number | null;
  contractor_name: string | null;
  contractor_license: string | null;
  is_roof_permit: boolean;
  source_payload: string;
}

/** Permit number format B-YY-NNNNNN.NNN */
export function permitNumber(prefix: string, yy: number, seq: number, sub = 0): string {
  return `${prefix}-${String(yy).padStart(2, "0")}-${String(seq).padStart(6, "0")}.${String(sub).padStart(3, "0")}`;
}

/** Pull the prefix, two-digit year and sequence back out of a B-YY-NNNNNN.NNN permit number. */
export function parsePermitNumber(no: string): { prefix: string; yy: number; seq: number; sub: number } | null {
  const m = /^([A-Za-z]+)-(\d{2})-(\d+)(?:\.(\d+))?$/.exec(no.trim());
  if (m === null) return null;
  return { prefix: (m[1] as string).toUpperCase(), yy: Number(m[2]), seq: Number(m[3]), sub: Number(m[4] ?? "0") };
}

/**
 * Rebuild, from the data itself, the sequence numbers this track already has a definitive answer
 * for in one prefix/year.
 *
 * The resume position used to be `track_state.cursor_seq`, a counter kept inside the DuckDB. The
 * DuckDB is restored from a GitHub Actions cache, those caches are branch scoped and evicted after
 * 7 days without a hit, so a run that moved between branches found no counter and rewound to
 * PERMITS_START_SEQ while the table the counter was meant to describe did not. The sibling
 * pa_detail track lost rows in production exactly that way (pa_detail_buildings 1,619 -> 466, and
 * the regressed figure is what the published coverage artifact still serves). Deriving the position
 * every run removes the thing that can desynchronise: a cold database with a warm `permits` table
 * resumes past the highest sequence it already holds, and a genuinely empty table restarts at the
 * configured beginning.
 *
 * Two kinds of evidence, because a permit row is not the only definitive answer a number can have.
 * JaxEPICS answers 404 for a number the county never issued, and gaps in the numbering are normal
 * rather than an error, so "no row in permits" on its own would re-offer every gap on every run,
 * the backlog would grow, and a window that fell entirely inside a gap would leave the track
 * walking the same numbers forever. `answered-permits.txt` covers those: it lists the numbers a run
 * got a JSON body or a definitive 404/204 for. A number that only errored or timed out is unknown
 * rather than absent and is deliberately left out, so it is asked again rather than skipped past,
 * the same distinction permitNumbersScope keeps for the merge.
 *
 * The log is appended only once a run's merge has committed, so a run that died between fetching
 * and merging claims nothing and its numbers are read again instead of being lost permanently. It
 * sits in the same cached artifacts directory as the DuckDB, so the two are warm and cold together,
 * and losing it costs a re-walk of the gaps, never a row.
 */
export async function coveredSequences(
  conn: import("@duckdb/node-api").DuckDBConnection,
  opts: { prefix: string; yy: number; answeredLog: string },
): Promise<Set<number>> {
  const prefix = opts.prefix.toUpperCase();
  const covered = new Set<number>();
  const like = `${prefix}-${String(opts.yy).padStart(2, "0")}-%`;
  const add = (no: string) => {
    const p = parsePermitNumber(no);
    if (p !== null && p.prefix === prefix && p.yy === opts.yy) covered.add(p.seq);
  };
  const held = await all<{ permit_no: string }>(
    conn,
    `SELECT DISTINCT permit_no FROM permits WHERE upper(permit_no) LIKE ${q(like)}`,
  );
  for (const row of held) add(row.permit_no);
  if (existsSync(opts.answeredLog)) for (const line of readFileSync(opts.answeredLog, "utf8").split(/\r?\n/)) add(line);
  return covered;
}

/**
 * The next `window` sequence numbers with no definitive answer yet, counting up from `start`.
 *
 * Reported, never stored. Two consecutive completed runs cannot overlap, because the first run's
 * numbers are in the covered set by the time the second one asks; the numbers it only timed out on
 * are not in that set, so those come back round instead of being skipped. Selecting a set rather
 * than a contiguous block from a high-water mark is also what stops one permanently unreachable
 * number from consuming a whole window: it takes one slot and the rest of the window moves on.
 */
export function nextSequences(covered: ReadonlySet<number>, start: number, window: number): number[] {
  const size = Math.max(1, Math.trunc(window));
  const from = Math.max(1, Math.trunc(start));
  // every covered sequence can cost at most one skipped iteration, so this ceiling always terminates
  const ceiling = from + size + covered.size;
  const out: number[] = [];
  for (let seq = from; out.length < size && seq <= ceiling; seq += 1) {
    if (!covered.has(seq)) out.push(seq);
  }
  return out;
}

export interface PermitPosition {
  /** sequences in this prefix/year with a definitive answer */
  covered: number;
  /** the highest of them, 0 when there are none */
  highestCovered: number;
  /** the first sequence with no definitive answer, which is where the next window starts */
  nextSeq: number;
}

/** Where the track stands in one prefix/year, measured rather than remembered. */
export function permitPosition(covered: ReadonlySet<number>, start: number): PermitPosition {
  let highest = 0;
  for (const seq of covered) if (seq > highest) highest = seq;
  const from = Math.max(1, Math.trunc(start));
  return { covered: covered.size, highestCovered: highest, nextSeq: nextSequences(covered, from, 1)[0] ?? from };
}

/**
 * Find JaxEPICS API endpoint literals inside the Angular bundle text: absolute jaxepicsapi URLs,
 * `/api/...` and bare `api/...` path literals (Angular apps usually concatenate an apiUrl with these),
 * plus any `apiUrl`/`baseUrl` style config strings.
 */
export function discoverApiPaths(bundleText: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /https?:\/\/jaxepicsapi[^"'`\s)]+/g,
    /(?<![A-Za-z0-9_])\/?api\/[A-Za-z0-9_/${}.-]+/g,
    /(?:apiUrl|apiBase|baseUrl|apiBaseUrl|API_URL)["']?\s*[:=]\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(bundleText)) !== null) found.add((m[1] ?? m[0]).trim());
  }
  return [...found].filter((p) => p.length > 4).sort();
}

/** Rank discovered literals as permit-detail endpoint candidates (templates with a {permitNumber} slot). */
export function permitEndpointCandidates(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!/permit/i.test(p)) continue;
    const norm = p.startsWith("http") || p.startsWith("/") ? p : `/${p}`;
    const tpl = /\$?\{[^}]+\}/.test(norm) ? norm.replace(/\$?\{[^}]+\}/, "{permitNumber}") : `${norm.replace(/\/+$/, "")}/{permitNumber}`;
    out.add(tpl);
  }
  for (const fallback of ["/api/Permit/View/{permitNumber}", "/api/Permit/{permitNumber}", "/api/permits/{permitNumber}", "/api/Permit/GetPermit?permitNumber={permitNumber}", "/api/Permit/Details/{permitNumber}"]) out.add(fallback);
  return [...out];
}

/** Case-insensitive deep key lookup in an unknown JSON document. */
export function pickDeep(doc: unknown, ...keys: string[]): unknown {
  const want = keys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== "object" || depth > 6 || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = walk(x, depth + 1);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    const obj = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(obj)) {
      const primitive = typeof val === "string" || typeof val === "number" || typeof val === "boolean";
      if (want.includes(k.toLowerCase().replace(/[^a-z0-9]/g, "")) && primitive && val !== "") return val;
    }
    for (const val of Object.values(obj)) {
      const r = walk(val, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(doc, 0);
}

const toStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() === "" ? null : String(v).trim());
const toNum = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const toDate = (v: unknown): string | null => {
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  if (typeof v !== "string") return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  if (iso) return iso[1] as string;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim());
  if (us) return `${us[3]}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Map whatever JSON the API returns for one permit onto the permit row (unknowns stay in source_payload). */
export function parsePermitDoc(permitNo: string, doc: unknown): PermitRow {
  const desc = toStr(pickDeep(doc, "description", "workDescription", "jobDescription", "scopeOfWork", "permitDescription"));
  const workType = toStr(pickDeep(doc, "workType", "typeOfWork", "workClass", "subType", "permitSubType"));
  const permitType = toStr(pickDeep(doc, "permitType", "type", "permitTypeDescription", "category"));
  const text = [desc, workType, permitType].filter(Boolean).join(" ");
  return {
    permit_no: permitNo,
    re_raw: toStr(pickDeep(doc, "re", "reNumber", "parcelNumber", "parcelId", "realEstateNumber", "folio")),
    address: toStr(pickDeep(doc, "address", "siteAddress", "fullAddress", "propertyAddress", "jobAddress", "location")),
    permit_type: permitType,
    work_type: workType,
    description: desc,
    status: toStr(pickDeep(doc, "status", "permitStatus", "statusDescription")),
    applied_date: toDate(pickDeep(doc, "appliedDate", "applicationDate", "dateApplied", "createdDate")),
    issue_date: toDate(pickDeep(doc, "issueDate", "issuedDate", "dateIssued", "issued")),
    final_date: toDate(pickDeep(doc, "finalDate", "finaledDate", "completedDate", "closedDate", "coDate")),
    job_cost: toNum(pickDeep(doc, "jobCost", "jobValue", "valuation", "estimatedCost", "constructionCost", "cost")),
    contractor_name: toStr(pickDeep(doc, "contractorName", "contractor", "contractorCompany", "companyName", "licenseeName")),
    contractor_license: toStr(pickDeep(doc, "contractorLicense", "licenseNumber", "stateLicense", "licenseNo", "license")),
    is_roof_permit: ROOF_RE.test(text),
    source_payload: JSON.stringify(doc),
  };
}

export async function stagePermits(conn: import("@duckdb/node-api").DuckDBConnection, rows: PermitRow[]): Promise<void> {
  await conn.run(`CREATE OR REPLACE TABLE staging.permits_raw (
    permit_no VARCHAR, re_raw VARCHAR, address VARCHAR, permit_type VARCHAR, work_type VARCHAR, description VARCHAR, status VARCHAR,
    applied_date DATE, issue_date DATE, final_date DATE, job_cost DOUBLE, contractor_name VARCHAR, contractor_license VARCHAR,
    is_roof_permit BOOLEAN, source_payload JSON)`);
  const n = (v: number | null) => (v === null ? "NULL" : String(v));
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows
      .slice(i, i + 500)
      .map((r) => `(${q(r.permit_no)}, ${q(r.re_raw)}, ${q(r.address)}, ${q(r.permit_type)}, ${q(r.work_type)}, ${q(r.description)}, ${q(r.status)}, ${q(r.applied_date)}::DATE, ${q(r.issue_date)}::DATE, ${q(r.final_date)}::DATE, ${n(r.job_cost)}, ${q(r.contractor_name)}, ${q(r.contractor_license)}, ${r.is_roof_permit}, ${q(r.source_payload)}::JSON)`);
    await conn.run(`INSERT INTO staging.permits_raw VALUES ${values.join(",")}`);
  }
  await conn.run(`CREATE OR REPLACE TABLE staging.permits AS
    SELECT r.permit_no, p.parcel_id, r.* EXCLUDE (permit_no)
    FROM (SELECT * FROM staging.permits_raw QUALIFY row_number() OVER (PARTITION BY permit_no) = 1) r
    LEFT JOIN (SELECT parcel_id, ${normalizeParcelIdSql("parcel_id")} AS norm FROM parcels) p ON p.norm = ${normalizeParcelIdSql("r.re_raw")}`);
}

/**
 * The `authoritativeScope` for a permits merge: the permit numbers this run actually got an answer
 * for. Each run enumerates one bounded slice of the B-YY-NNNNNN.NNN number space, so every permit
 * outside that slice was never asked about and an unscoped merge would report the whole rest of the
 * table as deleted at source on every run. A number that only ever errored or timed out is unknown
 * rather than absent, so it is left out too.
 */
export function permitNumbersScope(answered: string[]): string {
  return answered.length === 0 ? "FALSE" : `t.permit_no IN (${answered.map((n) => q(n)).join(", ")})`;
}

/** `--window 300` | `300 permits` -> permits per run (default 300). */
export function permitWindow(window: string | null, fallback = 300): number {
  if (window === null) return fallback;
  const m = /^(\d+)\s*(permits?|p)?$/i.exec(window.trim());
  return m ? Math.max(1, Number(m[1])) : fallback;
}

/**
 * JaxEPICS permits (US egress, bounded). 1) discover the JSON API from the Angular bundle (kept in
 * track_state + artifacts/permits/discovered-api.json); 2) enumerate the next `--window` permit
 * numbers this track has no definitive answer for (B-YY-NNNNNN.000, derived from the data by
 * coveredSequences, never from a stored cursor), concurrency 2, 500 ms delay; 3) parse, stage, merge,
 * and only then claim the numbers that answered; record throughput and miss rate as limitations.
 */
export const runPermits: TrackRunner = async (ctx, source) => {
  const result = startResult(source);
  const log = ctx.logger.child({ track: source.track });
  const destDir = join(ctx.paths.artifactsDir, "permits");
  mkdirSync(destDir, { recursive: true });
  const headers = { "User-Agent": BROWSER_UA, Accept: "application/json,text/html,*/*", Referer: JAXEPICS_VIEW };

  // 1. discover API: fetch the shell, then EVERY script it references (the main-*.js bundle holds the literals)
  let apiPaths: string[] = JSON.parse((await getTrackState(ctx.conn, source.track, STATE_API)) ?? "[]") as string[];
  const knownPermit = ctx.env.PERMITS_KNOWN ?? "B-25-279425.000";
  const shell = await getJson<unknown>(`${JAXEPICS_VIEW}${knownPermit}`, { headers, retries: 1, timeoutMs: 30_000 });
  const bundleNotes: { url: string; status: number; bytes: number; literals: number }[] = [];
  if (shell.text) {
    const scripts = [...shell.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1] as string);
    const shellHits = discoverApiPaths(shell.text);
    apiPaths = [...new Set([...apiPaths, ...shellHits])];
    for (const s of scripts) {
      const url = s.startsWith("http") ? s : new URL(s, "https://jaxepics.coj.net/").toString();
      const js = await getJson<unknown>(url, { headers, retries: 2, timeoutMs: 120_000 });
      const hits = js.text ? discoverApiPaths(js.text) : [];
      bundleNotes.push({ url, status: js.status, bytes: js.text?.length ?? 0, literals: hits.length });
      if (hits.length > 0) {
        apiPaths = [...new Set([...apiPaths, ...hits])];
        writeFileSync(join(destDir, `bundle-${url.split("/").pop()}.literals.json`), JSON.stringify(hits, null, 2));
      }
    }
    writeFileSync(join(destDir, "discovered-api.json"), JSON.stringify({ discoveredAt: new Date().toISOString(), shellUrl: `${JAXEPICS_VIEW}${knownPermit}`, scripts, bundles: bundleNotes, apiPaths }, null, 2));
    await setTrackState(ctx.conn, source.track, STATE_API, JSON.stringify(apiPaths), ctx.runId);
  } else {
    result.limitations.push(`shell page ${JAXEPICS_VIEW}${knownPermit} not fetched (HTTP ${shell.status}${shell.error ? `, ${shell.error}` : ""})`);
  }
  result.notes.apiPathsDiscovered = apiPaths;
  result.notes.bundles = bundleNotes;
  const candidates = permitEndpointCandidates(apiPaths);
  result.notes.candidateEndpoints = candidates;

  // 1b. probe each candidate with the known permit BEFORE enumerating; record every attempt
  const attempts: { endpoint: string; url: string; status: number; bytes: number; json: boolean }[] = [];
  let probedEndpoint: string | null = null;
  const hosts = [...new Set([JAXEPICS_API_HOST, ...apiPaths.filter((p) => p.startsWith("http")).map((p) => new URL(p).origin)])];
  for (const tpl of candidates) {
    if (probedEndpoint !== null) break;
    const urls = tpl.startsWith("http") ? [tpl.replace("{permitNumber}", encodeURIComponent(knownPermit))] : hosts.map((h) => `${h}${tpl.replace("{permitNumber}", encodeURIComponent(knownPermit))}`);
    for (const url of urls) {
      const r = await getJson<unknown>(url, { headers, retries: 0, timeoutMs: 30_000 });
      const isJson = r.ok && r.body !== null && typeof r.body === "object";
      attempts.push({ endpoint: tpl, url, status: r.status, bytes: r.text?.length ?? 0, json: isJson });
      if (isJson) {
        probedEndpoint = url.replace(encodeURIComponent(knownPermit), "{permitNumber}");
        writeFileSync(join(destDir, "known-permit-sample.json"), JSON.stringify({ url, permit: knownPermit, body: r.body }, null, 2));
        break;
      }
      await sleep(300);
    }
  }
  result.notes.probeAttempts = attempts;
  result.limitations.push(`endpoint probe with ${knownPermit}: ${attempts.map((a) => `${a.url} -> ${a.status}${a.json ? " json" : ""} (${a.bytes} B)`).join("; ") || "no candidates"}`);
  if (probedEndpoint !== null) result.notes.probedEndpoint = probedEndpoint;
  // Constrained source (decision 2026-08-21): the Angular shell loads its chunks dynamically (static grep finds
  // no API literals) and every https://jaxepicsapi.coj.net/api/... guess answers Akamai "Access Denied" 403 even
  // with a browser UA; search/reports need a login; no open permit dataset exists; a public-records request is
  // the documented path. One cheap discovery + probe per run is kept as evidence; enumeration only runs when a
  // probe actually returns JSON (or PERMITS_BROWSER=1 is wired to a headless-browser fetch in a later story).
  if (probedEndpoint === null) {
    result.notes.constrained = true;
    result.notes.throughput = { hits: 0, misses: 0, errors: 0, minutes: 0, permitsPerMin: 0 };
    result.limitations.push(
      "constrained: JaxEPICS API behind Akamai WAF (403 Access Denied on every /api guess); search/reports require login; no open dataset; public-records request (PRR) is the documented path; enumeration skipped, no permit numbers claimed",
    );
    await stagePermits(ctx.conn, []);
    result.rowsStaged = 0;
    const hashedEmpty = await hashStaging(ctx.conn, "staging.permits", {
      sourceSystem: source.sourceSystem, sourceUrl: JAXEPICS_VIEW, sourceArtifact: "permits/discovered-api.json", sourceSha256: null, fetchedAt: new Date().toISOString(), runId: ctx.runId,
    });
    // Nothing was enumerated, so this staging table speaks for no permit at all. Without the scope
    // the empty staging would report every permit already held as deleted at source.
    result.merge = await mergeStaging(ctx.conn, { target: "permits", staging: hashedEmpty, keys: ["permit_no"], authoritativeScope: permitNumbersScope([]) });
    result.status = "completed";
    result.finishedAt = new Date().toISOString();
    log.warn("permits_constrained", { attempts: attempts.length, bundles: bundleNotes.length });
    return result;
  }

  // 2. enumerate window
  const window = permitWindow(ctx.window, Number(ctx.env.PERMITS_WINDOW ?? 300));
  const yy = Number(ctx.env.PERMITS_YEAR ?? new Date().getUTCFullYear() % 100);
  const prefix = ctx.env.PERMITS_PREFIX ?? "B";
  // Resume from the data, not from a stored counter: coveredSequences + nextSequences pick the next
  // numbers this track has no definitive answer for, whatever track_state happens to say.
  const answeredLog = join(destDir, ANSWERED_LOG);
  const configuredStart = Number(ctx.env.PERMITS_START_SEQ ?? 1);
  const coveredBefore = await coveredSequences(ctx.conn, { prefix, yy, answeredLog });
  const before = permitPosition(coveredBefore, configuredStart);
  const seqs = nextSequences(coveredBefore, configuredStart, window);
  const startSeq = seqs[0] ?? before.nextSeq;
  const numbers = seqs.map((s) => permitNumber(prefix, yy, s));
  log.info("permits_plan", { prefix, yy, startSeq, window, selected: seqs.length, covered: before.covered, highestCovered: before.highestCovered });
  const t0 = Date.now();
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let usedEndpoint: string | null = probedEndpoint;
  const rows: PermitRow[] = [];
  // Permit numbers the API gave a definitive answer for: a JSON body (the permit exists) or a
  // 404/204 (it does not). A number that only ever errored or timed out is unknown, not absent, so
  // it stays out of the scope this merge is allowed to report deletions over.
  const answered: string[] = [];
  await mapLimit(probedEndpoint === null && attempts.length > 0 ? numbers.slice(0, 20) : numbers, 2, 500, async (no) => {
    const tried = usedEndpoint !== null ? [usedEndpoint] : candidates;
    for (const tpl of tried) {
      const path = tpl.replace(/\$?\{[^}]+\}/, encodeURIComponent(no));
      const url = path.startsWith("http") ? path : `${JAXEPICS_API_HOST}${path}`;
      const r = await getJson<unknown>(url, { headers, retries: 1, timeoutMs: 30_000 });
      if (r.ok && r.body !== null && typeof r.body === "object") {
        usedEndpoint = tpl;
        rows.push(parsePermitDoc(no, r.body));
        answered.push(no);
        hits += 1;
        return;
      }
      if (r.status === 404 || r.status === 204) {
        if (usedEndpoint !== null) {
          answered.push(no);
          misses += 1;
          return;
        }
        continue;
      }
      if (r.status === 0 || r.status >= 500) {
        errors += 1;
        await sleep(1000);
      }
    }
    if (usedEndpoint === null) misses += 1;
  });
  const elapsedMin = (Date.now() - t0) / 60_000;
  result.notes.window = { prefix, yy, startSeq, endSeq: seqs[seqs.length - 1] ?? startSeq, requested: window, selected: seqs.length };
  result.notes.cursorStart = before.highestCovered;
  result.notes.coveredStart = before.covered;
  result.notes.throughput = { hits, misses, errors, minutes: Math.round(elapsedMin * 100) / 100, permitsPerMin: elapsedMin > 0 ? Math.round((hits / elapsedMin) * 10) / 10 : null };
  result.notes.usedEndpoint = usedEndpoint;
  result.limitations.push(`measured throughput: ${hits} permits in ${Math.round(elapsedMin * 10) / 10} min (${misses} misses, ${errors} errors) at concurrency 2 / 500 ms`);
  if (usedEndpoint === null) {
    result.limitations.push(`no JSON endpoint answered for ${prefix}-${yy}-${startSeq}..; candidates tried: ${candidates.join(", ")}; nothing claimed, these numbers are offered again`);
  }
  await stagePermits(ctx.conn, rows);
  result.rowsStaged = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.permits"));
  result.notes.roofPermits = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.permits WHERE is_roof_permit"));
  result.notes.linkedToParcel = Number(await scalar(ctx.conn, "SELECT count(*) FROM staging.permits WHERE parcel_id IS NOT NULL"));
  const hashed = await hashStaging(ctx.conn, "staging.permits", {
    sourceSystem: source.sourceSystem, sourceUrl: usedEndpoint ? `${JAXEPICS_API_HOST}${usedEndpoint}` : JAXEPICS_VIEW,
    sourceArtifact: "permits/discovered-api.json", sourceSha256: null, fetchedAt: new Date().toISOString(), runId: ctx.runId,
  });
  await ctx.conn.run(`UPDATE ${hashed} SET source_url = ${q(JAXEPICS_VIEW)} || permit_no`);
  result.notes.answeredPermitNumbers = answered.length;
  result.merge = await mergeStaging(ctx.conn, {
    target: "permits",
    staging: hashed,
    keys: ["permit_no"],
    authoritativeScope: permitNumbersScope(answered),
  });
  // Claim the answered numbers only now that the merge has committed. A run that died before this
  // line claims nothing, so the next one asks about its numbers again instead of skipping past them,
  // and a number the county never issued is claimed too, so its gap is not re-walked forever.
  if (answered.length > 0) appendFileSync(answeredLog, `${answered.join("\n")}\n`);

  // Report the position, do not keep one: read back from the same evidence the next run selects
  // against, after this run's rows and claims have landed.
  const after = permitPosition(await coveredSequences(ctx.conn, { prefix, yy, answeredLog }), configuredStart);
  await setTrackState(ctx.conn, source.track, STATE_CURSOR, String(after.highestCovered), ctx.runId);
  result.notes.cursorEnd = after.highestCovered;
  result.notes.coveredEnd = after.covered;
  result.notes.nextPermitNo = permitNumber(prefix, yy, after.nextSeq);
  result.limitations.push(
    `resume position ${before.highestCovered} -> ${after.highestCovered} of ${prefix}-${String(yy).padStart(2, "0")} (next ${permitNumber(prefix, yy, after.nextSeq)}); derived from permits rows + ${ANSWERED_LOG}, never from a stored cursor`,
  );
  log.info("merged", { table: "permits", ...result.merge, throughput: result.notes.throughput });
  result.status = "completed";
  result.finishedAt = new Date().toISOString();
  return result;
};
