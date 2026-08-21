import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { artifactFileName, downloadArtifact } from "../src/download.js";
import { createLogger } from "../src/log.js";
import { computeCid, sameCid } from "../src/publish/cid.js";

const dir = mkdtempSync(join(tmpdir(), "duval-download-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeFetch(body: string, etag: string, calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(method);
    const headers = new Headers({ etag, "last-modified": "Mon, 27 Jul 2026 11:06:08 GMT", "content-length": String(Buffer.byteLength(body)) });
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
}

describe("idempotent artifact download", () => {
  it("downloads once, then skips while ETag is unchanged, then re-downloads on a new ETag", async () => {
    const calls: string[] = [];
    const logger = createLogger({}, "error", () => undefined);
    const url = "https://example.test/Tax%20Roll/Duval%2026%20Preliminary%20NAL%202026.zip";
    const common = { url, destDir: join(dir, "appraisal"), artifactsRoot: dir, logger };

    const first = await downloadArtifact({ ...common, fetchImpl: fakeFetch("v1-bytes", '"etag-1"', calls) });
    expect(first.status).toBe("downloaded");
    expect(first.relPath).toBe("appraisal/duval-26-preliminary-nal-2026.zip");
    expect(first.sha256).toHaveLength(64);
    expect(readFileSync(first.path, "utf8")).toBe("v1-bytes");
    expect(JSON.parse(readFileSync(`${first.path}.meta.json`, "utf8")).etag).toBe('"etag-1"');

    const second = await downloadArtifact({ ...common, fetchImpl: fakeFetch("v1-bytes", '"etag-1"', calls) });
    expect(second.status).toBe("unchanged");
    expect(second.sha256).toBe(first.sha256);
    expect(calls.filter((c) => c === "GET")).toHaveLength(1);

    const third = await downloadArtifact({ ...common, fetchImpl: fakeFetch("v2-bytes", '"etag-2"', calls) });
    expect(third.status).toBe("downloaded");
    expect(third.sha256).not.toBe(first.sha256);
    expect(calls.filter((c) => c === "GET")).toHaveLength(2);
  });

  it("derives deterministic artifact names from URLs", () => {
    expect(artifactFileName("https://x/y/duval_2026Ppar.zip")).toBe("duval_2026ppar.zip");
    expect(artifactFileName("https://x/Duval%2026%20Preliminary%20SDF%202026.zip")).toBe("duval-26-preliminary-sdf-2026.zip");
  });
});

describe("local CID computation", () => {
  it("matches the known CID of a small payload and renders CIDv1", async () => {
    const r = await computeCid(Buffer.from("hello world\n"));
    expect(r.cid).toBe("QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
    expect(r.cidV1.startsWith("bafybei")).toBe(true);
    expect(sameCid(r.cid, r.cidV1)).toBe(true);
    expect(sameCid(r.cid, "QmcjLXFotoYfX2Pf4qJs9q7KYewkZbfDFrVPKrnfSs68BP")).toBe(false);
    expect(r.bytes).toBe(12);
  });
});
