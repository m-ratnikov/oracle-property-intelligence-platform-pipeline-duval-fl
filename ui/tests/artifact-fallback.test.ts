import { describe, expect, it } from "vitest";
import { fallbackFor, objectNameFor, resolveCurrentArtifactUrl } from "@/lib/artifactFallback";
import type { AppConfig } from "@/lib/config";

/**
 * The 2026-08-25 outage: the deployment's URLs named one publish's CIDs, the storage side had
 * dropped them, every panel showed a 504, and the UI had no second address to try. These tests pin
 * the second address: the currently published object, read from the artifacts index.
 */

const CFG: AppConfig = {
  countyKey: "duval",
  countyName: "Duval",
  stateCode: "FL",
  queryTableUrl: "https://gw/ipfs/bafy-old-qt",
  runHistoryUrl: "https://gw/ipfs/bafy-old-rh",
  coverageUrl: "https://gw/ipfs/bafy-old-cov",
  catalogUrl: "https://gw/ipns/k51-catalog",
  openDataIndexUrl: null,
  artifactsIndexUrl: "https://gw/ipns/k51-index",
  mcpUrl: null,
  isSample: false,
  sampleArtifacts: [],
};

const INDEX = {
  county: "duval",
  generatedAt: "2026-08-24T12:52:47.144Z",
  artifacts: [
    { name: "query-table.parquet", url: "https://gw/ipfs/bafy-new-qt", ipnsUrl: "https://gw/ipns/k51-qt", cid: "Qm1", cidV1: "bafy-new-qt" },
    { name: "run-history.json", url: "https://gw/ipfs/bafy-new-rh", ipnsUrl: null, cid: "Qm2", cidV1: "bafy-new-rh" },
    { name: "published-counties.json", url: "https://gw/ipfs/bafy-cat", ipnsUrl: "https://gw/ipns/k51-catalog", cid: "Qm3", cidV1: "bafy-cat" },
  ],
};

function fetchIndex(status = 200) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return { ok: status < 400, json: async () => INDEX };
  };
  return { calls, fetchImpl };
}

describe("artifact fallback", () => {
  it("knows which published object each configured URL stands for", () => {
    expect(objectNameFor(CFG.queryTableUrl, CFG)).toBe("query-table.parquet");
    expect(objectNameFor(CFG.runHistoryUrl, CFG)).toBe("run-history.json");
    expect(objectNameFor(CFG.coverageUrl, CFG)).toBe("dataset-coverage.json");
    expect(objectNameFor(CFG.catalogUrl, CFG)).toBe("published-counties.json");
    expect(objectNameFor("https://gw/ipfs/something-else", CFG)).toBeNull();
  });

  it("prefers the IPNS URL the index lists, and falls back to the CID URL", async () => {
    const { calls, fetchImpl } = fetchIndex();
    expect(await resolveCurrentArtifactUrl("query-table.parquet", CFG.artifactsIndexUrl, fetchImpl)).toBe("https://gw/ipns/k51-qt");
    expect(await resolveCurrentArtifactUrl("run-history.json", CFG.artifactsIndexUrl, fetchImpl)).toBe("https://gw/ipfs/bafy-new-rh");
    expect(calls).toEqual([CFG.artifactsIndexUrl, CFG.artifactsIndexUrl]);
  });

  it("resolves a superseded configured URL to the current object", async () => {
    const { fetchImpl } = fetchIndex();
    expect(await fallbackFor(CFG.queryTableUrl, CFG, fetchImpl)).toBe("https://gw/ipns/k51-qt");
    expect(await fallbackFor(CFG.runHistoryUrl, CFG, fetchImpl)).toBe("https://gw/ipfs/bafy-new-rh");
  });

  it("never hands back the URL that just failed, and nothing for an object the index lacks", async () => {
    const { fetchImpl } = fetchIndex();
    // the catalog is configured at the same IPNS URL the index lists: no different address exists
    expect(await fallbackFor(CFG.catalogUrl, CFG, fetchImpl)).toBeNull();
    // coverage is not in this index
    expect(await fallbackFor(CFG.coverageUrl, CFG, fetchImpl)).toBeNull();
    // an unknown URL has no object name to look up
    expect(await fallbackFor("https://gw/ipfs/unrelated", CFG, fetchImpl)).toBeNull();
  });

  it("an index that cannot be read yields no fallback rather than an error", async () => {
    const { fetchImpl } = fetchIndex(504);
    expect(await fallbackFor(CFG.queryTableUrl, CFG, fetchImpl)).toBeNull();
    const throwing = async () => {
      throw new Error("network");
    };
    expect(await fallbackFor(CFG.queryTableUrl, CFG, throwing as never)).toBeNull();
  });
});
