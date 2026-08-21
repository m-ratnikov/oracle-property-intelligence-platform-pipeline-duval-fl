import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageBar } from "@/components/Charts";
import { guardSql, stripSqlComments, MAX_LIMIT, DEFAULT_LIMIT } from "@/lib/sql";
import { resolveArtifactUrl } from "@/lib/config";
import {
  distinctLimitations,
  ingestionSourceNames,
  latestConsolidationRun,
  latestIngestionRun,
  parseCatalog,
  parseCoverage,
  parseOpenDataIndex,
  parseRunHistory,
  sortRunsDesc,
  summariseRun,
  summariseRuns,
} from "@/lib/types";
import {
  displayCell,
  displayCellForColumn,
  formatDurationMs,
  formatMetres,
  formatTimestamp,
  formatUsd,
  isPlainIntegerColumn,
  parseTimestamp,
  relativeTime,
  shortenId,
  signedDelta,
  toCsv,
  toPlain,
} from "@/lib/format";
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

  it("reads the shared table fields on a dataset written by more than one track", () => {
    const parsed = parseCoverage({
      datasets: [
        {
          source: "sales",
          ingested_count: 64532,
          expected_count: 64532,
          table_rows_total: 71992,
          rows_from_other_tracks: 7460,
          additional_rows_by_source: { PA_DETAIL: 7460, BOGUS: "not a number" },
        },
      ],
    });
    expect(parsed.datasets[0]).toMatchObject({
      ingested_count: 64532,
      table_rows_total: 71992,
      rows_from_other_tracks: 7460,
      additional_rows_by_source: { PA_DETAIL: 7460 },
    });
    // they are dedicated fields now, not leftovers in extra
    expect(parsed.datasets[0].extra).toEqual({});
  });

  it("leaves the shared table fields null when an older snapshot omits them", () => {
    const parsed = parseCoverage({
      datasets: [{ source: "appraisal", ingested_count: 404023, expected_count: 404023 }],
    });
    expect(parsed.datasets[0]).toMatchObject({
      table_rows_total: null,
      rows_from_other_tracks: null,
      additional_rows_by_source: null,
    });
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

  it("orders runs newest first", () => {
    const history = parseRunHistory({
      runs: [
        { run_id: "b", started_at: "2026-08-02T00:00:00Z", sources: [{ source: "s", inserted: 5 }] },
        { run_id: "a", started_at: "2026-08-01T00:00:00Z", sources: [{ source: "s", inserted: 10 }] },
      ],
    });
    expect(sortRunsDesc(history.runs).map((run) => run.run_id)).toEqual(["b", "a"]);
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

  it("keeps only the head when no tail is asked for", () => {
    // `slice(-0)` is `slice(0)`, so the naive form printed the whole sha after the ellipsis
    // and the runs page showed "5be287e...5be287e52c628428eaaa72e10a3d71d22f6d3ec1".
    const sha = "5be287e52c628428eaaa72e10a3d71d22f6d3ec1";
    expect(shortenId(sha, 7, 0)).toBe("5be287e...");
    expect(shortenId(sha, 7, 0)).not.toContain(sha);
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

describe("run history field names match what the pipeline emits", () => {
  // The pipeline writes `track` and `rows_staged`. Reading `source`/`rows_fetched` only made every
  // row on the runs page read "unknown" with 0 fetched, which is the opposite of the evidence that
  // page exists to show.
  const realShape = {
    county: "duval",
    runs: [
      {
        run_id: "01M0HVMB6XDGHJ5R0BY64HWH8Z",
        started_at: "2026-08-21T10:18:37Z",
        trigger: "workflow_dispatch",
        sources: [
          {
            track: "appraisal",
            source_system: "duval_appraiser",
            source_url: "https://example.test/nal.zip",
            rows_staged: 404023,
            inserted: 0,
            updated: 0,
            unchanged: 404023,
            table_total_after: 404023,
            limitations: ["FDOR posts only the current roll type"],
          },
          { track: "pa_detail", rows_staged: 252, inserted: 252, updated: 0, unchanged: 0, limitations: [] },
        ],
      },
    ],
  };

  it("reads track and rows_staged", () => {
    const parsed = parseRunHistory(realShape);
    const names = parsed.runs[0]!.sources.map((s) => s.source);
    expect(names).toEqual(["appraisal", "pa_detail"]);
    expect(parsed.runs[0]!.sources[0]!.rows_fetched).toBe(404023);
    // distinct source count is what the Sources tracked stat shows
    expect(new Set(names).size).toBe(2);
  });

  it("derives a per-source delta from inserted plus updated when none is published", () => {
    const parsed = parseRunHistory(realShape);
    expect(parsed.runs[0]!.sources[0]!.delta_vs_previous).toBe(0);
    expect(parsed.runs[0]!.sources[1]!.delta_vs_previous).toBe(252);
  });

  it("still reads the older field names", () => {
    const parsed = parseRunHistory({
      runs: [{ run_id: "r", sources: [{ source: "legacy", rows_fetched: 7, limitations: [] }] }],
    });
    expect(parsed.runs[0]!.sources[0]).toMatchObject({ source: "legacy", rows_fetched: 7 });
  });
});

describe("column aware cell formatting", () => {
  it("renders calendar years and identifiers without a thousands separator", () => {
    expect(displayCellForColumn("built_year", 1954)).toBe("1954");
    expect(displayCellForColumn("roof_year_est", 2012)).toBe("2012");
    expect(displayCellForColumn("address_zip", 32259)).toBe("32259");
    expect(displayCellForColumn("county_fips", 12031)).toBe("12031");
  });

  it("still groups genuine quantities", () => {
    expect(displayCellForColumn("market_value", 538342999)).toBe("538,342,999");
    expect(displayCellForColumn("permit_count", 1200)).toBe("1,200");
    expect(displayCellForColumn("total_area", 12500)).toBe("12,500");
  });

  it("recognises aliases a reviewer may type in the workbench", () => {
    expect(isPlainIntegerColumn("sale_year")).toBe(true);
    expect(isPlainIntegerColumn("zip")).toBe(true);
    expect(isPlainIntegerColumn("years_since_last_sale")).toBe(false);
    expect(displayCellForColumn("sale_year", 1998)).toBe("1998");
  });

  it("falls through to displayCell for every other shape", () => {
    expect(displayCellForColumn("owner_name", "ACME LLC")).toBe("ACME LLC");
    expect(displayCellForColumn("built_year", null)).toBe(displayCell(null));
    expect(displayCellForColumn("hoa_flag", true)).toBe("yes");
    expect(displayCellForColumn("lot_size_acre", 0.2534)).toBe("0.2534");
  });
});

describe("coverage bar", () => {
  // renderToStaticMarkup can split adjacent JSX children with comment markers; strip them so the
  // assertions can name the text a reader actually sees.
  const render = (props: Parameters<typeof CoverageBar>[0]) =>
    renderToStaticMarkup(createElement(CoverageBar, props)).replace(/<!--.*?-->/g, "");

  it("names the rows another track contributed to the same table", () => {
    const html = render({
      ingested: 64532,
      expected: 64532,
      rowsFromOtherTracks: 7460,
      additionalRowsBySource: { PA_DETAIL: 7460 },
    });
    expect(html).toContain("64,532 / 64,532");
    expect(html).toContain("100.0%");
    expect(html).toContain("+7,460 rows from other sources (PA_DETAIL)");
  });

  it("says nothing extra when one track owns the whole table", () => {
    const html = render({ ingested: 404023, expected: 404023 });
    expect(html).not.toContain("rows from other sources");
  });

  it("still shows the extra rows when the source publishes no expected total", () => {
    const html = render({
      ingested: 1200,
      expected: null,
      rowsFromOtherTracks: 40,
      additionalRowsBySource: { PA_DETAIL: 40 },
    });
    expect(html).toContain("no published expected total to compare against");
    expect(html).toContain("+40 rows from other sources (PA_DETAIL)");
  });

  it("still reports a ratio above 100 percent instead of clamping it away", () => {
    // the honest handling of a real over-count is kept; the fix removes the bogus ratio at source
    const html = render({ ingested: 71992, expected: 64532 });
    expect(html).toContain("111.6%");
    expect(html).toContain("width:100%");
  });
});
