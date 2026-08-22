/**
 * Every environment variable this repository reads is documented.
 *
 * .env.example is the only description of how to configure a deployment, and
 * it had drifted: NEXT_PUBLIC_IPFS_GATEWAY, OPEN_DATA_INDEX_URL,
 * AGENT_MODEL_CHOICES and OPENAI_API_KEY were all read by code and absent from
 * the file, and OPENAI_API_KEY is the one that mattered, because an undocumented
 * way to point this public route at a billed provider is how a paid key ends up
 * deployed with nobody having decided that it should be.
 *
 * Documentation drift is not usually worth a test. This is, because the file is
 * the ONLY place a secret's existence is recorded (the values live on Vercel and
 * must never be in the repository), so a variable missing here is a variable
 * that gets set by whoever remembers it and reviewed by nobody.
 *
 * The scan is deliberately dumb: any `env.SOMETHING` in a non test source file
 * has to appear by name in .env.example. A false positive is cheap to fix by
 * documenting the thing; a false negative is the bug this exists to prevent.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "@/lib/agent/providers";

const ROOT = process.cwd();
const ENV_EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");

/** Where the deployed app and its scripts live. Tests are excluded on purpose:
 *  they stub and restore variables (TZ, and the agent ceilings) as fixtures,
 *  which is not configuration anybody deploying this needs to know about. */
const SCAN_DIRS = ["app", "lib", "scripts"];
const SCAN_FILES = ["playwright.config.ts", "next.config.ts", "vitest.config.mts"];
const SCAN_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js"];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (SCAN_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * Variable names read from an env-like object.
 *
 * Trailing underscore names are dropped: `process.env.NEXT_PUBLIC_*` appears in
 * a prose comment in lib/config.ts explaining why those reads cannot be
 * refactored into a loop, and a wildcard is not a variable.
 */
function readsIn(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\benv(?:\.|\[["'])([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1];
    if (!name.endsWith("_")) names.add(name);
  }
  return [...names];
}

function documented(name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(ENV_EXAMPLE);
}

describe(".env.example describes every variable the code reads", () => {
  const sources = [
    ...SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
    ...SCAN_FILES.map((file) => join(ROOT, file)),
  ];

  it("finds source files to scan", () => {
    // A broken walk would make every assertion below vacuously pass, which is
    // the failure mode of this kind of test.
    expect(sources.length).toBeGreaterThan(10);
  });

  it("documents every variable read outside the test suite", () => {
    const undocumented: string[] = [];
    for (const file of sources) {
      for (const name of readsIn(readFileSync(file, "utf8"))) {
        if (!documented(name)) undocumented.push(`${name} (${relative(ROOT, file).replace(/\\/g, "/")})`);
      }
    }
    expect(undocumented).toEqual([]);
  });

  it("documents every provider credential the registry will accept", () => {
    // The registry is what serverSelection scans, so an env key listed there is
    // a live way to configure this deployment's own billed credential whether
    // or not anybody wrote it down.
    const undocumented = PROVIDERS.flatMap((provider) => provider.envKeys).filter((key) => !documented(key));
    expect(undocumented).toEqual([]);
  });

  it("carries no values, only names", () => {
    // A key pasted into this file is a leaked key, and this file is the one
    // people paste into. The shapes below are the prefixes the registry's own
    // keyHint text tells visitors to look for.
    const secretShapes = [
      /\bsk-ant-api\d/,
      /\bsk-or-v1-[A-Za-z0-9]{8}/,
      /\bsk-proj-[A-Za-z0-9]{8}/,
      /\bgsk_[A-Za-z0-9]{8}/,
      /\bcsk-[A-Za-z0-9]{8}/,
      /\bhf_[A-Za-z0-9]{8}/,
      /\bvck_[A-Za-z0-9]{8}/,
      /\bAIza[A-Za-z0-9_-]{8}/,
    ];
    const leaked = secretShapes.filter((shape) => shape.test(ENV_EXAMPLE)).map(String);
    expect(leaked).toEqual([]);
  });
});
