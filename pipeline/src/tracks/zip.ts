import AdmZip from "adm-zip";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** List entry names inside a zip archive. */
export function listZipEntries(zipPath: string): { name: string; size: number }[] {
  const zip = new AdmZip(zipPath);
  return zip.getEntries().map((e) => ({ name: e.entryName, size: e.header.size }));
}

/**
 * Extract one entry (by extension match) into `outDir`. Skips when the extracted file already
 * exists with the expected uncompressed size; returns the extracted path.
 */
export function extractEntry(opts: { zipPath: string; outDir: string; extension: string; force?: boolean }): {
  path: string;
  entryName: string;
  extracted: boolean;
} {
  const zip = new AdmZip(opts.zipPath);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(opts.extension.toLowerCase()));
  if (entry === undefined) throw new Error(`No *${opts.extension} entry in ${opts.zipPath}`);
  mkdirSync(opts.outDir, { recursive: true });
  const outPath = join(opts.outDir, entry.entryName.split("/").pop() ?? entry.entryName);
  if (!opts.force && existsSync(outPath) && statSync(outPath).size === entry.header.size) {
    return { path: outPath, entryName: entry.entryName, extracted: false };
  }
  zip.extractEntryTo(entry, opts.outDir, false, true);
  return { path: outPath, entryName: entry.entryName, extracted: true };
}
