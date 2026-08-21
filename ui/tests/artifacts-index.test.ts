import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "@/components/ArtifactCard";
import {
  parseArtifactsIndex,
  publicationLookup,
  UNKNOWN_PUBLICATION,
} from "@/lib/artifacts";
import { parseRunHistory, type RunArtifact } from "@/lib/types";

/**
 * The bug these pin: every artifact card read "IPNS name: not available" and "Gateway URL: not
 * available", because a run record carries a CID and nothing else. The values exist, in the
 * published artifacts index, and the join between the two is the published object name: the run
 * record's `path`, which is the index entry's `name`.
 *
 * The other half of the bug is the one that must not be introduced while fixing it. A card must
 * never show a URL the pipeline did not publish, so an unreachable index, a missing entry, or an
 * entry at a different CID all have to degrade to "not available" with a reason, and none of them
 * may produce a link built out of a gateway and a CID.
 */

/* Trimmed from the live index at
   https://ipfs.filebase.io/ipns/k51qzi5uqu5dibf140h91d3bh02wpu9apokitczidyp1hliaj5650wuphryfeu */
const publishedIndex = {
  county: "duval",
  generatedAt: "2026-08-21T16:35:15.501Z",
  mode: "published",
  gateway: "https://ipfs.filebase.io",
  artifacts: [
    {
      name: "query-table.parquet",
      key: "query-tables/duval/query-table.parquet",
      contentType: "application/vnd.apache.parquet",
      bytes: 49535718,
      sha256: "f041dfbe5362d79ae755c57cfbb7e7bde700d410063658efe435b2eb9981123a",
      cid: "QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW",
      cidV1: "bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
      url: "https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
      ipnsLabel: "oracle-query-table-duval",
      ipnsName: "k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r",
      ipnsUrl:
        "https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r",
    },
    {
      name: "dataset-coverage.json",
      key: "incremental-status/duval/dataset-coverage.json",
      contentType: "application/json",
      bytes: 14205,
      sha256: "5fa7175fbdd4e9f918242bd4002d30e01cc7cb4a7c5fe7555d04d6ce566ab9c0",
      cid: "QmTiRGXkPeMDS5mNqT5cFDorvfvyLVjbhqdeefRY1Mauc1",
      cidV1: "bafybeicp3yb4fl3i6ixgcddmlxktpo5wg346kqlaohompoyllqmxfbtrmy",
      url: "https://ipfs.filebase.io/ipfs/bafybeicp3yb4fl3i6ixgcddmlxktpo5wg346kqlaohompoyllqmxfbtrmy",
      ipnsLabel: "oracle-dataset-coverage-duval",
      ipnsName: "k51qzi5uqu5dgefy44zrdzqpp6pqikkged7vea2lxu8354kfl1ah7ijrl2pwum",
      ipnsUrl:
        "https://ipfs.filebase.io/ipns/k51qzi5uqu5dgefy44zrdzqpp6pqikkged7vea2lxu8354kfl1ah7ijrl2pwum",
    },
    {
      name: "run-history.json",
      key: "runs/duval/run-history.json",
      contentType: "application/json",
      bytes: 255381,
      sha256: "fde53e118f78a882fdf9bb46b6290ce784937b744439d7c672363faa2c4414b2",
      cid: "QmZ4wobcACVeMEaS45wPHNSuNykB2zjgigccmikjoEs4hE",
      cidV1: "bafybeie7nklz3jbwaqg44nbpg6djkti32yf4eaiuo27at2xy4w642sgx5e",
      url: "https://ipfs.filebase.io/ipfs/bafybeie7nklz3jbwaqg44nbpg6djkti32yf4eaiuo27at2xy4w642sgx5e",
      ipnsLabel: "oracle-run-history-duval",
      ipnsName: "k51qzi5uqu5dl3zmapadjh90auy4k6gtr6w52zg6ozeu64kzbiwwgw8k9ef6ny",
      ipnsUrl:
        "https://ipfs.filebase.io/ipns/k51qzi5uqu5dl3zmapadjh90auy4k6gtr6w52zg6ozeu64kzbiwwgw8k9ef6ny",
    },
    {
      name: "tables/parcels.parquet",
      key: "tables/duval/parcels.parquet",
      contentType: "application/vnd.apache.parquet",
      bytes: 38911589,
      sha256: "e8649656a2b133bb133a76c37d4c4d34b10ec4d6c4017d76ea200aa8ba76455e",
      cid: "QmVor33EJdpmF4DBbus6FUsb72rRMponxhkfDTdDKisRTa",
      cidV1: "bafybeido7fgbfeqc22p2ra6mbcvnypxzxbu3hsa5or3gpghrfnklkzfbau",
      url: "https://ipfs.filebase.io/ipfs/bafybeido7fgbfeqc22p2ra6mbcvnypxzxbu3hsa5or3gpghrfnklkzfbau",
      // Entity tables are CID addressed by design; the publisher mints no name for them.
      ipnsLabel: null,
      ipnsName: null,
      ipnsUrl: null,
    },
  ],
  ipns: {},
};

/**
 * A dry-run index is what `pnpm publish:artifacts` writes locally with no Filebase credentials:
 * every CID and gateway URL is real (the CID is computed from the bytes), and every IPNS field is
 * null because no IPNS write happened.
 */
const dryRunIndex = {
  county: "duval",
  generatedAt: "2026-08-21T09:00:00.000Z",
  mode: "dry-run",
  gateway: "https://ipfs.filebase.io",
  artifacts: [
    {
      name: "query-table.parquet",
      key: "query-tables/duval/query-table.parquet",
      contentType: "application/vnd.apache.parquet",
      bytes: 49535718,
      sha256: "f041dfbe5362d79ae755c57cfbb7e7bde700d410063658efe435b2eb9981123a",
      cid: "QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW",
      cidV1: "bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
      url: "https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
      ipnsLabel: "oracle-query-table-duval",
      ipnsName: null,
      ipnsUrl: null,
    },
  ],
  ipns: {},
};

/** The run-record artifacts shape the pipeline actually publishes: an object keyed by kind. */
const runHistory = parseRunHistory({
  county: "duval",
  runs: [
    {
      run_id: "01M0JHFY6FBNXW0523KPNP5D7Y",
      started_at: "2026-08-21 16:12:03.152",
      finished_at: "2026-08-21 16:34:46.424",
      status: "completed",
      trigger: "workflow_dispatch",
      tracks: ["appraisal"],
      sources: [],
      artifacts: {
        queryTable: {
          path: "query-table.parquet",
          rows: 404023,
          bytes: 49535783,
          // Not the CID the index lists: the consolidation pass republished the query table.
          cid: "QmVexSr6UfhavNWkRPWf3MXpBbRvWEs7bfgkUE8Wznav3z",
        },
        tables: {
          parcels: {
            path: "tables/parcels.parquet",
            rows: 404023,
            cid: "QmVor33EJdpmF4DBbus6FUsb72rRMponxhkfDTdDKisRTa",
          },
          water_bodies: {
            path: "tables/water_bodies.parquet",
            rows: 757,
            cid: "QmeE2e5LDnAyC9eckQXBatq9mA36dqpTvR17BfsRPxwF3Z",
          },
        },
        coverage: {
          path: "dataset-coverage.json",
          cid: "QmTiRGXkPeMDS5mNqT5cFDorvfvyLVjbhqdeefRY1Mauc1",
        },
        // Listed in the index at another CID, and no later run in this history republished it.
        runHistory: { path: "run-history.json", cid: "QmNeverPublishedRunHistoryFixture" },
      },
    },
    {
      run_id: "01M0JJSM4Y61416J03ZKD44KFG",
      started_at: "2026-08-21 16:34:49.119",
      trigger: "consolidation",
      sources: [{ source: "consolidation", status: "completed" }],
      artifacts: {
        openData: { indexCid: "QmS6NTWffWMTuLErpz9gFfkvKfz3Z7V8eRxDK6C69mycxf", shards: 41 },
        // Since the pipeline fix, the pass records the parquet it republished with property_cid
        // filled in. This is the copy the artifacts index serves.
        queryTable: {
          path: "query-table.parquet",
          rows: 404023,
          bytes: 49535718,
          cid: "QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW",
          propertyCidFilled: 404023,
        },
      },
    },
  ],
});

const ingestion = runHistory.runs.find((run) => run.kind === "ingestion");
const consolidation = runHistory.runs.find((run) => run.kind === "consolidation");
if (!ingestion || !consolidation) throw new Error("fixture is missing a run");

const artifactNamed = (name: string): RunArtifact => {
  const found = ingestion.artifacts.find((artifact) => artifact.name === name);
  if (!found) throw new Error(`fixture has no artifact ${name}`);
  return found;
};
const consolidationArtifactNamed = (name: string): RunArtifact => {
  const found = consolidation.artifacts.find((artifact) => artifact.name === name);
  if (!found) throw new Error(`fixture has no consolidation artifact ${name}`);
  return found;
};

/** The lookup as the pages build it: the index plus the loaded history. */
const lookupWithHistory = () =>
  publicationLookup(parseArtifactsIndex(publishedIndex), runHistory.runs);

describe("the join key between a run record and the published artifacts index", () => {
  it("is the published object name, which a run record carries as `path`", () => {
    // The run record files this artifact under `tables.parcels`; the index calls it
    // `tables/parcels.parquet`. Only `path` bridges the two.
    const artifact = artifactNamed("tables.parcels");
    expect(artifact.name).toBe("tables.parcels");
    expect(artifact.path).toBe("tables/parcels.parquet");

    const resolved = lookupWithHistory()(artifact, ingestion);
    expect(resolved.status).toBe("published");
    expect(resolved.url).toBe(
      "https://ipfs.filebase.io/ipfs/bafybeido7fgbfeqc22p2ra6mbcvnypxzxbu3hsa5or3gpghrfnklkzfbau",
    );
  });

  it("is not the index's `key`, which is a bucket path no run record carries", () => {
    const keys = parseArtifactsIndex(publishedIndex).artifacts.map((entry) => entry.key);
    const paths = ingestion.artifacts.map((artifact) => artifact.path);
    expect(keys).toContain("tables/duval/parcels.parquet");
    for (const key of keys) expect(paths).not.toContain(key);
  });
});

describe("an artifact the index lists at exactly this run's CID", () => {
  const lookup = lookupWithHistory();

  it("takes its gateway URL and IPNS name from the index", () => {
    const resolved = lookup(artifactNamed("coverage"), ingestion);
    expect(resolved).toMatchObject({
      status: "published",
      url: "https://ipfs.filebase.io/ipfs/bafybeicp3yb4fl3i6ixgcddmlxktpo5wg346kqlaohompoyllqmxfbtrmy",
      ipnsName: "k51qzi5uqu5dgefy44zrdzqpp6pqikkged7vea2lxu8354kfl1ah7ijrl2pwum",
      ipnsLabel: "oracle-dataset-coverage-duval",
    });
  });

  it("shows no IPNS name for an entity table, because the publisher mints none", () => {
    const resolved = lookup(artifactNamed("tables.parcels"), ingestion);
    expect(resolved.status).toBe("published");
    expect(resolved.url).not.toBeNull();
    expect(resolved.ipnsName).toBeNull();
  });

  it("renders that URL as a link that opens in a new tab", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        artifact: artifactNamed("coverage"),
        publication: lookup(artifactNamed("coverage"), ingestion),
      }),
    );
    expect(html).toContain(
      'href="https://ipfs.filebase.io/ipfs/bafybeicp3yb4fl3i6ixgcddmlxktpo5wg346kqlaohompoyllqmxfbtrmy"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("k51qzi5uqu5dgefy");
    expect(html).not.toContain("not available");
  });
});

/**
 * The consolidation pass republishes the query table seconds after every ingestion run, so the
 * ingestion run's copy is superseded on every run, forever. That has to read as the pipeline
 * working, not as a fault, or the most prominent card on the page is permanently alarming.
 */
describe("an artifact a later run in the history republished", () => {
  const lookup = lookupWithHistory();
  const artifact = artifactNamed("queryTable");

  it("is superseded, not replaced, and names the run that took over", () => {
    const resolved = lookup(artifact, ingestion);
    expect(resolved.status).toBe("superseded");
    expect(resolved.supersededBy).toMatchObject({
      runId: "01M0JJSM4Y61416J03ZKD44KFG",
      kind: "consolidation",
      servesIndexCid: true,
    });
    expect(resolved.indexCid).toBe("QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW");
  });

  it("still offers no gateway URL for this run's bytes, only for the copy the index serves", () => {
    const resolved = lookup(artifact, ingestion);
    expect(resolved.url).toBeNull();
    expect(resolved.currentUrl).toBe(
      "https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
    );
  });

  it("says so neutrally, and links to what the index serves", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { artifact, publication: lookup(artifact, ingestion) }),
    );
    expect(html).toContain("Superseded by the consolidation pass that followed it");
    expect(html).toContain("01M0JJSM4Y");
    expect(html).toContain(
      'href="https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4"',
    );
    expect(html).toContain('rel="noopener noreferrer"');
    // Neutral, not alarming, and never a claim that nothing was published.
    expect(html).not.toContain("text-warn");
    expect(html).not.toContain("never published");
    // The run's own CID is still never turned into a gateway URL.
    expect(html).not.toContain("ipfs/QmVexSr6UfhavNWkRPWf3MXpBbRvWEs7bfgkUE8Wznav3z");
  });

  it("resolves the successor's own card as published", () => {
    const resolved = lookup(consolidationArtifactNamed("queryTable"), consolidation);
    expect(resolved.status).toBe("published");
    expect(resolved.url).toBe(
      "https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
    );
    expect(resolved.ipnsName).toBe(
      "k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r",
    );
  });
});

describe("an artifact the index lists at a different CID that nothing explains", () => {
  const lookup = lookupWithHistory();
  const artifact = artifactNamed("runHistory");

  it("keeps the warn tone, because this is the real never-published signal", () => {
    const resolved = lookup(artifact, ingestion);
    expect(resolved.status).toBe("replaced");
    expect(resolved.url).toBeNull();
    expect(resolved.supersededBy).toBeNull();
    expect(resolved.indexCid).toBe("QmZ4wobcACVeMEaS45wPHNSuNykB2zjgigccmikjoEs4hE");
  });

  it("says plainly that this run's copy was never published", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { artifact, publication: lookup(artifact, ingestion) }),
    );
    expect(html).toContain("no later run in this history");
    expect(html).toContain("never published");
    expect(html).toContain("text-warn");
    expect(html).not.toContain("Superseded by");
  });

  it("is what every mismatch degrades to when no history was loaded", () => {
    // The lookup is honest about what it cannot know: with no runs to reason with, it does not
    // guess that a mismatch was routine.
    const noHistory = publicationLookup(parseArtifactsIndex(publishedIndex));
    expect(noHistory(artifactNamed("queryTable"), ingestion).status).toBe("replaced");
  });
});

describe("an artifact the index does not list at all", () => {
  const lookup = lookupWithHistory();
  const artifact = artifactNamed("tables.water_bodies");

  it("is reported as never published, not as a missing URL", () => {
    const resolved = lookup(artifact, ingestion);
    expect(resolved.status).toBe("unlisted");
    expect(resolved.url).toBeNull();
    expect(resolved.ipnsName).toBeNull();
  });

  it("says so on the card", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { artifact, publication: lookup(artifact, ingestion) }),
    );
    expect(html).toContain("is absent from the published artifacts index");
    expect(html).not.toContain("https://ipfs.filebase.io/ipfs/");
  });
});

describe("an index the browser never got", () => {
  it("leaves every card exactly as it was, claiming nothing", () => {
    const lookup = publicationLookup(null, runHistory.runs);
    expect(lookup(artifactNamed("coverage"), ingestion)).toEqual(UNKNOWN_PUBLICATION);

    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { artifact: artifactNamed("coverage") }),
    );
    expect(html).toContain("no gateway url published for this artifact");
    expect(html).not.toContain("https://ipfs.filebase.io/ipfs/");
    expect(html).not.toContain("is absent from the published artifacts index");
  });

  it("degrades the same way when the fetch returns something that is not an index", () => {
    const lookup = publicationLookup(
      parseArtifactsIndex({ error: "gateway timeout" }),
      runHistory.runs,
    );
    expect(lookup(artifactNamed("coverage"), ingestion).status).toBe("unknown");
  });
});

describe("an artifact with no published object name", () => {
  it("is never reported as unpublished, because there is nothing to look it up by", () => {
    const openData = consolidationArtifactNamed("openData");
    expect(openData.path).toBeNull();

    const lookup = lookupWithHistory();
    expect(lookup(openData, consolidation).status).toBe("unknown");

    const html = renderToStaticMarkup(
      createElement(ArtifactCard, {
        artifact: openData,
        publication: lookup(openData, consolidation),
      }),
    );
    expect(html).not.toContain("absent from the published artifacts index");
  });
});

describe("a dry-run index, whose IPNS fields are all null", () => {
  const lookup = publicationLookup(parseArtifactsIndex(dryRunIndex), runHistory.runs);

  it("still resolves the gateway URL, and simply has no IPNS name to show", () => {
    // The dry-run index lists the same CID the published one does, so this joins.
    const artifact: RunArtifact = {
      ...artifactNamed("queryTable"),
      cid: "QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW",
    };
    const resolved = lookup(artifact, ingestion);
    expect(resolved.status).toBe("published");
    expect(resolved.url).toBe(
      "https://ipfs.filebase.io/ipfs/bafybeidrf5y2w6rmle4m3lkisqdmwt2ejhb2ryyvzpxogk4xcaerkenuu4",
    );
    expect(resolved.ipnsName).toBeNull();
    expect(resolved.ipnsUrl).toBeNull();
    expect(resolved.ipnsLabel).toBe("oracle-query-table-duval");
  });

  it("never invents an IPNS URL from a label", () => {
    const artifact: RunArtifact = {
      ...artifactNamed("queryTable"),
      cid: "QmVxUjpeezfmdWxMYQEMBQccNmraLcWNMqZp1JfV6MjBnW",
    };
    const html = renderToStaticMarkup(
      createElement(ArtifactCard, { artifact, publication: lookup(artifact, ingestion) }),
    );
    expect(html).not.toContain("/ipns/");
    expect(html).toContain("CID addressed; no IPNS name minted");
  });
});

describe("parseArtifactsIndex", () => {
  it("keeps the header fields the cards and the tests reason about", () => {
    const index = parseArtifactsIndex(publishedIndex);
    expect(index.county).toBe("duval");
    expect(index.mode).toBe("published");
    expect(index.generatedAt).toBe("2026-08-21T16:35:15.501Z");
    expect(index.artifacts).toHaveLength(4);
  });

  it("drops entries with no name and survives junk", () => {
    expect(parseArtifactsIndex(null).artifacts).toEqual([]);
    expect(parseArtifactsIndex("<html>404</html>").artifacts).toEqual([]);
    expect(parseArtifactsIndex({ artifacts: [{ cid: "Qm1" }, 7, null] }).artifacts).toEqual([]);
  });
});

/**
 * The trap in adding this variable. `config.isSample` brands the entire runtime SAMPLE, and it is
 * computed from the four artifacts the pages are actually about. The artifacts index only
 * decorates cards, so a deployment that has not set it is still serving published data.
 */
describe("NEXT_PUBLIC_ARTIFACTS_INDEX_URL is optional in the sample-detection sense", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig() {
    vi.resetModules();
    return (await import("@/lib/config")).config;
  }

  it("does not flip a published runtime to SAMPLE when it is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_QUERY_TABLE_URL", "https://ipfs.filebase.io/ipns/k51q");
    vi.stubEnv("NEXT_PUBLIC_RUN_HISTORY_URL", "https://ipfs.filebase.io/ipns/k51r");
    vi.stubEnv("NEXT_PUBLIC_COVERAGE_URL", "https://ipfs.filebase.io/ipns/k51c");
    vi.stubEnv("NEXT_PUBLIC_CATALOG_URL", "https://ipfs.filebase.io/ipns/k51k");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACTS_INDEX_URL", "");

    const config = await loadConfig();
    expect(config.isSample).toBe(false);
    expect(config.sampleArtifacts).toEqual([]);
    // It still resolves, to the synthetic index, so the cards have something to join against.
    expect(config.artifactsIndexUrl).toBe("/sample/artifacts-index.json");
  });

  it("is not one of the four artifacts that do flip it", async () => {
    vi.stubEnv("NEXT_PUBLIC_QUERY_TABLE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_RUN_HISTORY_URL", "");
    vi.stubEnv("NEXT_PUBLIC_COVERAGE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_CATALOG_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ARTIFACTS_INDEX_URL", "");

    const config = await loadConfig();
    expect(config.isSample).toBe(true);
    expect(config.sampleArtifacts).toEqual([
      "query-table.parquet",
      "run-history.json",
      "dataset-coverage.json",
      "catalog.json",
    ]);
    expect(config.sampleArtifacts).not.toContain("artifacts-index.json");
  });

  it("is used as given when it is set", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_ARTIFACTS_INDEX_URL",
      "https://ipfs.filebase.io/ipns/k51qzi5uqu5dibf140h91d3bh02wpu9apokitczidyp1hliaj5650wuphryfeu",
    );
    const config = await loadConfig();
    expect(config.artifactsIndexUrl).toBe(
      "https://ipfs.filebase.io/ipns/k51qzi5uqu5dibf140h91d3bh02wpu9apokitczidyp1hliaj5650wuphryfeu",
    );
  });
});
