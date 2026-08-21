import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterAll, describe, expect, it } from "vitest";
import { ensureSchema, openDb, q, scalar } from "../src/db.js";
import { hashStaging, mergeStaging, type Provenance } from "../src/merge.js";
import {
  baseSnapshotEnabled,
  forEachLineBatch,
  loadedFilesScope,
  readZipEntries,
  SUNBIZ_QUARTERLY_ENTRY_RE,
  sunbizFileDateKey,
  zipEntryStream,
} from "../src/tracks/businesses.js";
import { isDuvalBusiness, parseSunbizRecord, SUNBIZ_RECORD_LENGTH } from "../src/tracks/sunbiz.js";

const workDir = mkdtempSync(join(tmpdir(), "sunbiz-quarterly-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** Build a 1,440-char record from 1-based field positions (synthetic values, real layout). */
function record(fields: Record<string, [number, string]>): string {
  const buf = Array.from({ length: SUNBIZ_RECORD_LENGTH }, () => " ");
  for (const [start, value] of Object.values(fields)) {
    for (let i = 0; i < value.length; i += 1) buf[start - 1 + i] = value[i] as string;
  }
  return buf.join("");
}

function jacksonville(doc: string, name: string): string {
  return record({
    doc: [1, doc],
    name: [13, name],
    status: [205, "A"],
    type: [206, "FLAL"],
    p_addr1: [221, "1 RIVERSIDE AVE"],
    p_city: [305, "JACKSONVILLE"],
    p_state: [333, "FL"],
    p_zip: [335, "32202"],
    file_date: [473, "01152020"],
  });
}

function elsewhere(doc: string, name: string): string {
  return record({
    doc: [1, doc],
    name: [13, name],
    status: [205, "A"],
    type: [206, "DOMP"],
    p_addr1: [221, "1000 BRICKELL AVE"],
    p_city: [305, "MIAMI"],
    p_state: [333, "FL"],
    p_zip: [335, "33131"],
    file_date: [473, "07152026"],
  });
}

/**
 * A stand-in for `cordata.zip`: several members, each a run of fixed-length records, deflated. The
 * real archive has ten members of 1.85 GB each, which is exactly why the track reads them as streams
 * rather than through adm-zip's whole-member Buffer API.
 */
function buildQuarterlyFixture(memberRecordCounts: number[]): { path: string; duvalPerMember: number[] } {
  const zip = new AdmZip();
  const duvalPerMember: number[] = [];
  memberRecordCounts.forEach((count, m) => {
    const lines: string[] = [];
    let duval = 0;
    for (let i = 0; i < count; i += 1) {
      const doc = `L${String(m).padStart(2, "0")}${String(i).padStart(9, "0")}`;
      if (i % 3 === 0) {
        lines.push(jacksonville(doc, `DUVAL ENTITY ${m}-${i}`));
        duval += 1;
      } else {
        lines.push(elsewhere(doc, `OTHER ENTITY ${m}-${i}`));
      }
    }
    // real members are CRLF terminated and end with a trailing newline
    zip.addFile(`cordata${m}.txt`, Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1"));
    duvalPerMember.push(duval);
  });
  zip.addFile("readme.txt", Buffer.from("not a data member\n", "latin1"));
  const path = join(workDir, "cordata.zip");
  writeFileSync(path, zip.toBuffer());
  return { path, duvalPerMember };
}

describe("quarterly zip reader", () => {
  it("lists the data members from the central directory without decompressing them", () => {
    const { path } = buildQuarterlyFixture([40, 25, 10]);
    const entries = readZipEntries(path);
    expect(entries.map((e) => e.name).sort()).toEqual(["cordata0.txt", "cordata1.txt", "cordata2.txt", "readme.txt"]);
    const members = entries.filter((e) => SUNBIZ_QUARTERLY_ENTRY_RE.test(e.name));
    expect(members).toHaveLength(3);
    for (const m of members) {
      expect(m.method).toBe(8);
      expect(m.compressedSize).toBeGreaterThan(0);
      expect(m.uncompressedSize).toBeGreaterThan(0);
      expect(m.localHeaderOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("streams one member at a time and applies the Duval filter to the records", async () => {
    const { path, duvalPerMember } = buildQuarterlyFixture([40, 25, 10]);
    const entries = readZipEntries(path)
      .filter((e) => SUNBIZ_QUARTERLY_ENTRY_RE.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const [i, entry] of entries.entries()) {
      let parsed = 0;
      let kept = 0;
      let batches = 0;
      await forEachLineBatch(zipEntryStream(path, entry), async (lines) => {
        batches += 1;
        for (const line of lines) {
          if (line.length < 1436) continue;
          const r = parseSunbizRecord(line);
          if (r === null) continue;
          parsed += 1;
          if (isDuvalBusiness(r)) kept += 1;
        }
      });
      expect(batches).toBeGreaterThan(0);
      expect(parsed).toBe([40, 25, 10][i]);
      expect(kept).toBe(duvalPerMember[i]);
    }
  });

  it("rejects a file that is not a zip", () => {
    const bogus = join(workDir, "not-a-zip.bin");
    writeFileSync(bogus, Buffer.alloc(4096, 7));
    expect(() => readZipEntries(bogus)).toThrow(/end-of-central-directory/);
  });
});

describe("line batching", () => {
  it("reassembles records split across chunk boundaries and drops the CR", async () => {
    const { Readable } = await import("node:stream");
    const line = "A".repeat(100);
    const payload = Buffer.from(`${line}\r\n${line}\r\n${line}`, "latin1");
    const chunks = [payload.subarray(0, 37), payload.subarray(37, 150), payload.subarray(150)];
    const seen: string[] = [];
    await forEachLineBatch(Readable.from(chunks), async (lines) => {
      seen.push(...lines);
    });
    expect(seen).toEqual([line, line, line]);
  });
});

describe("sunbiz file freshness keys", () => {
  it("reads the date out of a daily file name and falls back for the quarterly members", () => {
    expect(sunbizFileDateKey("20260801c.txt")).toBe(20260801);
    expect(sunbizFileDateKey("20260801ce.txt")).toBe(20260801);
    expect(sunbizFileDateKey("cordata3.txt")).toBe(0);
    expect(sunbizFileDateKey("cordata3.txt", 20260715)).toBe(20260715);
  });
});

describe("base snapshot gate", () => {
  it("is off locally, on in CI, and explicitly overridable either way", () => {
    expect(baseSnapshotEnabled({})).toBe(false);
    expect(baseSnapshotEnabled({ CI: "true" })).toBe(true);
    expect(baseSnapshotEnabled({ CI: "true", SUNBIZ_BASE_SNAPSHOT: "0" })).toBe(false);
    expect(baseSnapshotEnabled({ SUNBIZ_BASE_SNAPSHOT: "1" })).toBe(true);
    expect(baseSnapshotEnabled({ SUNBIZ_BASE_SNAPSHOT: "true" })).toBe(true);
  });
});

const prov: Provenance = {
  sourceSystem: "sunbiz",
  sourceUrl: "sftp://sftp.floridados.gov/doc/cor/",
  sourceArtifact: "businesses/<source_file>",
  // the track leaves this null in hashStaging and fills it per file from staging.business_files;
  // the fixture stands in for that already-resolved state
  sourceSha256: "sha256-of-the-source-file",
  fetchedAt: "2026-08-21T00:00:00Z",
  runId: "run-test",
};

/** Seed `businesses` with rows that were loaded by earlier daily windows. */
async function seedBusinesses(conn: Awaited<ReturnType<typeof openDb>>["conn"], n: number): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) =>
    `(${q(`L${String(i).padStart(11, "0")}`)}, ${q(`ENTITY ${i}`)}, ${q("20260801c.txt")}, ${q(`h${i}`)}, 'sunbiz', ${q("sftp://x")}, ${q("businesses/20260801c.txt")}, ${q("sha")}, '2026-08-01T00:00:00'::TIMESTAMP, 'run-earlier')`,
  );
  for (let i = 0; i < rows.length; i += 500) {
    await conn.run(
      `INSERT INTO businesses (doc_number, name, source_file, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
       VALUES ${rows.slice(i, i + 500).join(",")}`,
    );
  }
}

describe("businesses missing_in_source scoping", () => {
  it("a window that stages no file reports 0 missing instead of the whole table", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await seedBusinesses(db.conn, 1024);
    // the exact shape of a run whose 14-day window held nothing new: staging is empty
    await db.conn.run("CREATE OR REPLACE TABLE staging.businesses_dedup AS SELECT doc_number, name, source_file FROM businesses WHERE false");
    const hashed = await hashStaging(db.conn, "staging.businesses_dedup", prov);

    const unscoped = await mergeStaging(db.conn, { target: "businesses", staging: hashed, keys: ["doc_number"] });
    expect(unscoped.missingInSource).toBe(1024);

    const scoped = await mergeStaging(db.conn, {
      target: "businesses",
      staging: hashed,
      keys: ["doc_number"],
      authoritativeScope: loadedFilesScope([]),
    });
    expect(scoped).toMatchObject({ staged: 0, inserted: 0, updated: 0, unchanged: 0, missingInSource: 0, totalAfter: 1024 });
    await db.close();
  });

  it("counts only rows last seen in a file this run re-read", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await seedBusinesses(db.conn, 10);
    // three of the ten were last seen in the file this run re-reads; one of those is gone from it
    await db.conn.run(
      `UPDATE businesses SET source_file = '20260805c.txt' WHERE doc_number IN ('L00000000000','L00000000001','L00000000002')`,
    );
    await db.conn.run(`CREATE OR REPLACE TABLE staging.businesses_dedup AS
      SELECT doc_number, name, '20260805c.txt' AS source_file FROM businesses
      WHERE doc_number IN ('L00000000000','L00000000001')`);
    const hashed = await hashStaging(db.conn, "staging.businesses_dedup", prov);
    const stats = await mergeStaging(db.conn, {
      target: "businesses",
      staging: hashed,
      keys: ["doc_number"],
      authoritativeScope: loadedFilesScope(["20260805c.txt"]),
    });
    // L00000000002 is the only honest deletion; the seven rows from 20260801c.txt were not looked at
    expect(stats.missingInSource).toBe(1);
    expect(stats.totalAfter).toBe(10);
    await db.close();
  });

  it("keeps the columns a partial-column Sunbiz staging does not carry", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await seedBusinesses(db.conn, 1);
    await db.conn.run("UPDATE businesses SET principal_city = 'JACKSONVILLE', officer_count = 3");
    await db.conn.run(
      "CREATE OR REPLACE TABLE staging.businesses_dedup AS SELECT doc_number, 'RENAMED LLC' AS name, '20260805c.txt' AS source_file FROM businesses",
    );
    const hashed = await hashStaging(db.conn, "staging.businesses_dedup", prov);
    const stats = await mergeStaging(db.conn, { target: "businesses", staging: hashed, keys: ["doc_number"], authoritativeScope: loadedFilesScope(["20260805c.txt"]) });
    expect(stats.updated).toBe(1);
    expect(await scalar(db.conn, "SELECT name FROM businesses")).toBe("RENAMED LLC");
    expect(await scalar(db.conn, "SELECT principal_city FROM businesses")).toBe("JACKSONVILLE");
    expect(await scalar(db.conn, "SELECT officer_count FROM businesses")).toBe(3);
    // provenance stays populated on every row the merge touched
    expect(await scalar(db.conn, "SELECT count(*) FROM businesses WHERE source_url IS NULL OR source_sha256 IS NULL OR run_id IS NULL")).toBe("0");
    await db.close();
  });

  it("builds a scope predicate that names every file loaded this run", () => {
    expect(loadedFilesScope([])).toBe("FALSE");
    expect(loadedFilesScope(["20260805c.txt", "cordata0.txt"])).toBe("t.source_file IN ('20260805c.txt', 'cordata0.txt')");
  });
});
