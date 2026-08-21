import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureUtf8, readCsvHeader } from "../src/tracks/contractors.js";

/**
 * The real cilb_certified.csv is ~754 MB. Reading one into a JS string throws
 * "Cannot create a string longer than 0x1fffffe8 characters" - V8 caps a string near 512 MB - which
 * is exactly how the contractors track died in Actions run 32466876779. These tests use a file large
 * enough to force several chunks through both readers, without writing 754 MB to a test runner's disk.
 */

const dir = mkdtempSync(join(tmpdir(), "duval-dbpr-large-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HEADER = "Board Number,Occupation Code,Licensee Name,DBA Name,Class,Address,City,State,Zip,County Code,License Number,Status";
/** Comfortably more than one 4 MB chunk, so the chunk-boundary paths are exercised. */
const PAYLOAD_BYTES = 12 * 1024 * 1024;

function writeBulkCsv(name: string, tail = ""): string {
  const path = join(dir, name);
  const row = "06,CCC,BULK ROOFING CO,,CERT,1 MAIN ST,JACKSONVILLE,FL,32205,16,CCC1000001,Current\n";
  writeFileSync(path, `${HEADER}\n`);
  const block = row.repeat(4096);
  for (let written = 0; written < PAYLOAD_BYTES; written += block.length) appendFileSync(path, block);
  if (tail.length > 0) appendFileSync(path, tail);
  return path;
}

describe("DBPR extracts larger than one read buffer", () => {
  it("reads the header without materialising the file", () => {
    const path = writeBulkCsv("bulk-header.csv");
    expect(statSync(path).size).toBeGreaterThan(PAYLOAD_BYTES);

    const cols = readCsvHeader(path);

    expect(cols).toHaveLength(12);
    expect(cols[0]).toBe("Board Number");
    expect(cols[10]).toBe("License Number");
  });

  it("validates UTF-8 across chunk boundaries without reporting a false positive", () => {
    // A multi-byte character placed past the first chunk would be split by a naive chunked decode
    // and misreported as invalid; the decoder must carry the partial character across the boundary.
    const path = writeBulkCsv("bulk-utf8.csv", "06,CCC,CAFÉ ROOFING,,CERT,4 OAK ST,JACKSONVILLE,FL,32205,16,CCC1330005,Current\n");
    const before = readFileSync(path);

    expect(ensureUtf8(path)).toBe(false);
    // a file already valid UTF-8 must be left byte for byte alone
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("transcodes a large latin-1 file in place and is idempotent", () => {
    const path = writeBulkCsv("bulk-latin1.csv");
    appendFileSync(path, Buffer.from("06,CCC,CAF\xc9 ROOFING,,CERT,4 OAK ST,JACKSONVILLE,FL,32205,16,CCC1330005,Current\n", "latin1"));

    expect(ensureUtf8(path)).toBe(true);
    // second pass sees valid UTF-8 and leaves it alone
    expect(ensureUtf8(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("CAFÉ ROOFING");
    // the transcode must not have truncated the bulk rows ahead of the latin-1 tail
    expect(statSync(path).size).toBeGreaterThan(PAYLOAD_BYTES);
    expect(readCsvHeader(path)[0]).toBe("Board Number");
  });
});
