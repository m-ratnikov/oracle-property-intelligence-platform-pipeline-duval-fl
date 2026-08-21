import { describe, expect, it } from "vitest";
import { guardSql, stripSqlComments, MAX_LIMIT, DEFAULT_LIMIT } from "@/lib/sql";
import { resolveArtifactUrl } from "@/lib/config";
import {
  cumulativeBySource,
  parseCatalog,
  parseCoverage,
  parseOpenDataIndex,
  parseRunHistory,
  sortRunsDesc,
} from "@/lib/types";
import { formatMetres, formatUsd, shortenId, signedDelta, toCsv, toPlain } from "@/lib/format";
import { haversineMetres, isPlausibleDuvalPoint, latLonToTile, tileUrl } from "@/lib/geo";

describe("workbench guard", () => {
  it("accepts a plain select and enforces a limit", () => {
    const result = guardSql("SELECT * FROM properties", 25);
    expect(result.ok).toBe(true);
    expect(result.sql).toContain("LIMIT 25");
  });

  it("accepts a CTE", () => {
    const result = guardSql("WITH x AS (SELECT 1 AS a) SELECT * FROM x");
    expect(result.ok).toBe(true);
    expect(result.sql).toContain(`LIMIT ${DEFAULT_LIMIT}`);
  });

  it("passes DESCRIBE through unwrapped", () => {
    const result = guardSql("DESCRIBE properties");
    expect(result.ok).toBe(true);
    expect(result.sql).toBe("DESCRIBE properties");
  });

  it("caps the limit", () => {
    const result = guardSql("SELECT 1", MAX_LIMIT * 10);
    expect(result.sql).toContain(`LIMIT ${MAX_LIMIT}`);
  });

  it("tolerates a trailing semicolon", () => {
    expect(guardSql("SELECT 1;").ok).toBe(true);
  });

  it.each([
    ["DROP TABLE properties", "drop"],
    ["SELECT 1; DELETE FROM properties", "second statement"],
    ["COPY properties TO 'out.csv'", "copy"],
    ["INSTALL httpfs", "install"],
    ["ATTACH 'other.db'", "attach"],
    ["CREATE TABLE t AS SELECT 1", "create"],
    ["", "empty"],
  ])("rejects %s", (statement) => {
    expect(guardSql(statement).ok).toBe(false);
  });

  it("does not let a comment hide a second statement", () => {
    const result = guardSql("SELECT 1 -- harmless\n; DROP TABLE properties");
    expect(result.ok).toBe(false);
  });

  it("strips both comment styles", () => {
    expect(stripSqlComments("SELECT 1 /* a */ -- b\nFROM t")).not.toContain("/*");
    expect(stripSqlComments("SELECT 1 -- b\nFROM t")).not.toContain("--");
  });
});

describe("artifact url resolution", () => {
  // The contract: a trailing slash means "directory, append the object name". Anything else
  // already addresses the object. Nothing else can carry that meaning - a name pointing at a
  // file and a name pointing at a directory are the same string.
  it("appends the object name to a directory root, which is marked by the trailing slash", () => {
    expect(resolveArtifactUrl("https://ipfs.filebase.io/ipns/k51abc/", "query-table.parquet")).toBe(
      "https://ipfs.filebase.io/ipns/k51abc/query-table.parquet",
    );
  });

  it("leaves a bare IPNS name alone, because this publisher points names at a single file", () => {
    // regression: appending here produced a 404 and a dead query engine on the deployed site
    const url = "https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r";
    expect(resolveArtifactUrl(url, "query-table.parquet")).toBe(url);
  });

  it("leaves a bare CID alone for the same reason", () => {
    const url = "https://ipfs.filebase.io/ipfs/bafybeichwef3od3yqpkumixe6mxqsyt4kasgdb7aauog5jg6u5fd3rrjs4";
    expect(resolveArtifactUrl(url, "query-table.parquet")).toBe(url);
  });

  it("leaves a url that already names a file alone", () => {
    const url = "https://ipfs.filebase.io/ipns/k51abc/query-table.parquet";
    expect(resolveArtifactUrl(url, "query-table.parquet")).toBe(url);
  });

  it("keeps a query string when appending", () => {
    expect(resolveArtifactUrl("https://gw.example/ipns/k51/?token=x", "a.parquet")).toBe(
      "https://gw.example/ipns/k51/a.parquet?token=x",
    );
  });

  it("handles the local sample path", () => {
    expect(resolveArtifactUrl("/sample/query-table.parquet", "query-table.parquet")).toBe(
      "/sample/query-table.parquet",
    );
  });
});

describe("lenient artifact parsers", () => {
  it("survives a run history with unknown fields and missing values", () => {
    const parsed = parseRunHistory({
      county: "duval",
      generatedAt: "2026-08-21T09:00:00Z",
      somethingNew: 42,
      runs: [
        {
          run_id: "r1",
          started_at: "2026-08-20T00:00:00Z",
          sources: [{ source: "appraisal", rows_fetched: "412000", limitations: "one note" }],
          artifacts: [{ name: "query-table.parquet" }],
          futureField: { nested: true },
        },
      ],
    });

    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].sources[0].rows_fetched).toBe(412000);
    expect(parsed.runs[0].sources[0].limitations).toEqual(["one note"]);
    expect(parsed.runs[0].sources[0].inserted).toBeNull();
    expect(parsed.runs[0].artifacts[0].cid).toBeNull();
    expect(parsed.runs[0].extra.futureField).toEqual({ nested: true });
  });

  it("degrades to empty collections instead of throwing", () => {
    expect(parseRunHistory(null).runs).toEqual([]);
    expect(parseRunHistory("nope").runs).toEqual([]);
    expect(parseCoverage(undefined).datasets).toEqual([]);
    expect(parseCatalog(42).counties).toEqual([]);
    expect(parseOpenDataIndex([]).shards).toEqual([]);
  });

  it("reads a coverage snapshot and keeps unknown dataset fields", () => {
    const parsed = parseCoverage({
      county: "duval",
      exportedAt: "2026-08-21T09:00:00Z",
      datasets: [
        { county: "duval", source: "permits", ingested_count: 21000, expected_count: null, throughput: "1.4/s" },
      ],
    });
    expect(parsed.datasets[0].expected_count).toBeNull();
    expect(parsed.datasets[0].extra.throughput).toBe("1.4/s");
  });

  it("accepts shards as strings or objects", () => {
    const parsed = parseOpenDataIndex({
      shards: ["shard-0000.json", { shard: "shard-0001.json", count: 20 }, { nope: true }],
      properties: { "1234": "bafyabc" },
    });
    expect(parsed.shards.map((shard) => shard.shard)).toEqual([
      "shard-0000.json",
      "shard-0001.json",
    ]);
    expect(parsed.properties["1234"]).toBe("bafyabc");
  });

  it("orders runs newest first and accumulates per source", () => {
    const history = parseRunHistory({
      runs: [
        { run_id: "b", started_at: "2026-08-02T00:00:00Z", sources: [{ source: "s", inserted: 5 }] },
        { run_id: "a", started_at: "2026-08-01T00:00:00Z", sources: [{ source: "s", inserted: 10 }] },
      ],
    });
    expect(sortRunsDesc(history.runs).map((run) => run.run_id)).toEqual(["b", "a"]);

    const [series] = cumulativeBySource(history.runs);
    expect(series.source).toBe("s");
    expect(series.points.map((point) => point.total)).toEqual([10, 15]);
  });
});

describe("formatting", () => {
  it("says not available rather than showing an empty cell", () => {
    expect(formatUsd(null)).toBe("not available");
    expect(formatMetres(undefined)).toBe("not available");
    expect(shortenId(null)).toBe("not available");
  });

  it("formats distances by magnitude", () => {
    expect(formatMetres(742.4)).toBe("742 m");
    expect(formatMetres(1500)).toBe("1.50 km");
  });

  it("signs deltas", () => {
    expect(signedDelta(120)).toBe("+120");
    expect(signedDelta(0)).toBe("0");
    expect(signedDelta(null)).toBe("not available");
  });

  it("shortens long identifiers but keeps short ones whole", () => {
    expect(shortenId("bafybeigd" + "x".repeat(50), 10, 6)).toBe("bafybeigdx...xxxxxx");
    expect(shortenId("short")).toBe("short");
  });

  it("flattens arrow values", () => {
    expect(toPlain(10n)).toBe(10);
    expect(toPlain(new Date("2026-08-21T00:00:00Z"))).toBe("2026-08-21T00:00:00.000Z");
    expect(toPlain(null)).toBeNull();
    expect(toPlain(2 ** 70)).toBe(2 ** 70);
  });

  it("escapes CSV correctly", () => {
    const csv = toCsv(["a", "b"], [{ a: 'say "hi"', b: "x,y" }, { a: null, b: 1 }]);
    expect(csv.split("\r\n")).toEqual(["a,b", '"say ""hi""","x,y"', ",1"]);
  });
});

describe("geo", () => {
  it("computes a known distance", () => {
    // Jacksonville city hall to the Landing, roughly 500 m apart.
    const metres = haversineMetres(30.3322, -81.6557, 30.3272, -81.6557);
    expect(metres).toBeGreaterThan(500);
    expect(metres).toBeLessThan(600);
  });

  it("returns zero for the same point", () => {
    expect(haversineMetres(30.33, -81.65, 30.33, -81.65)).toBeCloseTo(0, 6);
  });

  it("maps a Duval coordinate onto a sane tile", () => {
    const tile = latLonToTile(30.3322, -81.6557, 16);
    expect(tile.z).toBe(16);
    expect(tile.x).toBeGreaterThan(0);
    expect(tile.y).toBeGreaterThan(0);
    expect(tile.offsetX).toBeGreaterThanOrEqual(0);
    expect(tile.offsetX).toBeLessThan(256);
    expect(tileUrl(tile.x, tile.y, tile.z)).toMatch(
      /^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/,
    );
  });

  it("flags coordinates outside Duval County", () => {
    expect(isPlausibleDuvalPoint(30.33, -81.65)).toBe(true);
    expect(isPlausibleDuvalPoint(40.71, -74.0)).toBe(false);
    expect(isPlausibleDuvalPoint(null, null)).toBe(false);
  });
});
