/**
 * Presentation contracts: the rules that decide whether a reviewer reads the truth off the screen.
 *
 * Every case here is a defect two reviewers actually saw on the deployed app, written so it fails
 * against the code as it was:
 *
 *  - a provenance cell reading "DUVAL_APPRAISER source 1787320736294"
 *  - a coverage meter reading "0 / 0 = 100.0%" for a source behind a WAF that 403s every request
 *  - a percentage rounding 407,985 / 407,986 up to a tidy 100.0%
 *  - an MCP env block telling an operator to paste a mutable /ipns/ URL into the two settings the
 *    server hands to DuckDB, which is what hard-failed every data tool
 */

import { describe, expect, it } from "vitest";
import {
  NOT_AVAILABLE,
  csvCell,
  displayCellForColumn,
  epochToDate,
  formatDateOnly,
  formatRatioPercent,
  formatTimestamp,
  formatTimestampShort,
  isTimestampColumn,
  parseTimestamp,
  relativeTime,
  toCsv,
  unpopulatedReason,
} from "@/lib/format";
import {
  blockedReasons,
  hasComparableExpected,
  parseCoverageStatuses,
  unavailableSources,
} from "@/lib/coverageStatus";
import { formatMcpEnv, ipnsNameFromUrl, mcpBindings, parseArtifactsIndex } from "@/lib/artifacts";

/**
 * The exact value a reviewer photographed in a provenance cell, and the instant the published
 * dataset-coverage.json gives for the same fetch. The pair is what fixes the unit as milliseconds.
 */
const OBSERVED_EPOCH_MS = 1787320736294;
const OBSERVED_INSTANT = "2026-08-21 13:58:56Z";

describe("timestamps that crossed the Arrow bridge", () => {
  it("reads a DuckDB TIMESTAMP delivered as an epoch number", () => {
    expect(formatTimestamp(OBSERVED_EPOCH_MS)).toBe(OBSERVED_INSTANT);
    expect(formatTimestampShort(OBSERVED_EPOCH_MS)).toBe("2026-08-21 13:58Z");
    expect(formatDateOnly(OBSERVED_EPOCH_MS)).toBe("2026-08-21");
  });

  it("reads the same instant however Arrow hands it over", () => {
    const expected = epochToDate(OBSERVED_EPOCH_MS)?.toISOString();
    expect(expected).toBe("2026-08-21T13:58:56.294Z");
    for (const value of [
      OBSERVED_EPOCH_MS,
      BigInt(OBSERVED_EPOCH_MS),
      String(OBSERVED_EPOCH_MS),
      new Date(OBSERVED_EPOCH_MS),
      "2026-08-21T13:58:56.294Z",
      // DuckDB's own zoneless text form, which is UTC at the point it was recorded.
      "2026-08-21 13:58:56.294",
    ]) {
      expect(parseTimestamp(value)?.toISOString(), `input ${String(value)}`).toBe(expected);
    }
  });

  it("resolves the epoch unit by magnitude rather than assuming milliseconds", () => {
    const instant = "2026-08-21T13:58:56.000Z";
    const seconds = Math.floor(OBSERVED_EPOCH_MS / 1000);
    expect(epochToDate(seconds)?.toISOString()).toBe(instant);
    expect(epochToDate(seconds * 1_000_000)?.toISOString()).toBe(instant);
    expect(epochToDate(seconds * 1_000_000_000)?.toISOString()).toBe(instant);
  });

  it("never prints a bare epoch integer for a provenance column", () => {
    for (const column of ["fetched_at", "first_fetched_at", "last_fetched_at"]) {
      const rendered = displayCellForColumn(column, OBSERVED_EPOCH_MS);
      expect(rendered, column).toBe(OBSERVED_INSTANT);
      expect(rendered, column).not.toMatch(/1,787,320,736,294|1787320736294/);
    }
  });

  it("covers every per family provenance column the pipeline publishes", () => {
    const families = [
      "appraisal", "sales", "geometry", "structure", "permit", "business",
      "contractor", "transit", "places", "water", "parcel_layer", "address",
    ];
    for (const family of families) {
      expect(isTimestampColumn(`${family}_fetched_at`), family).toBe(true);
    }
    expect(isTimestampColumn("fetched_at")).toBe(true);
    expect(isTimestampColumn("features_as_of")).toBe(false);
    // A four digit year is a year, not an epoch: built_year must not become a 1970 date.
    expect(displayCellForColumn("built_year", 1954)).toBe("1954");
    expect(formatTimestamp("2026")).toBe("2026-01-01 00:00:00Z");
  });

  it("keeps a missing or unusable stamp honest", () => {
    expect(formatTimestamp(null)).toBe(NOT_AVAILABLE);
    expect(formatTimestamp("")).toBe(NOT_AVAILABLE);
    expect(formatTimestamp({ nested: true })).toBe(NOT_AVAILABLE);
    expect(formatTimestamp("not a date")).toBe("not a date");
    expect(relativeTime(OBSERVED_EPOCH_MS, OBSERVED_EPOCH_MS + 7_200_000)).toBe("2h ago");
  });

  it("writes an ISO instant into the CSV export, not the epoch integer", () => {
    expect(csvCell("fetched_at", OBSERVED_EPOCH_MS)).toBe("2026-08-21T13:58:56.294Z");
    expect(csvCell("address_street", "1002 N MAIN ST")).toBe("1002 N MAIN ST");
    const csv = toCsv(
      ["property_id", "fetched_at"],
      [{ property_id: "0707810100R", fetched_at: OBSERVED_EPOCH_MS }],
    );
    expect(csv).toBe("property_id,fetched_at\r\n0707810100R,2026-08-21T13:58:56.294Z");
  });
});

describe("percentages that must not round into a claim", () => {
  it("refuses to print 100.0% for a source that is one row short", () => {
    // The observed coj_parcels row: 407,985 ingested against a published total of 407,986.
    expect(formatRatioPercent(407_985, 407_986)).toBe("99.9%");
    expect(formatRatioPercent(407_986, 407_986)).toBe("100.0%");
  });

  it("refuses to print 100.0% for an overshoot", () => {
    expect(formatRatioPercent(400_001, 400_000)).toBe("100.1%");
    expect(formatRatioPercent(500_000, 400_000)).toBe("125.0%");
  });

  it("refuses to round a non zero count away to 0.0%", () => {
    expect(formatRatioPercent(1, 404_023)).toBe("0.1%");
    expect(formatRatioPercent(0, 404_023)).toBe("0.0%");
  });

  it("has no answer at all when there is no denominator", () => {
    expect(formatRatioPercent(0, 0)).toBe(NOT_AVAILABLE);
  });
});

/** The permits row exactly as the published dataset-coverage.json carries it. */
const PERMITS_ROW = {
  county: "duval",
  source: "permits",
  ingested_count: 0,
  expected_count: 0,
  first_loaded_at: null,
  last_loaded_at: null,
  implemented: true,
  constrained: true,
  reason:
    "JaxEPICS API behind Akamai WAF; search/reports require login; no open dataset; PRR is the documented path",
  last_skip_reason: "skipped: non-US egress (HTTP 0, fetch failed)",
  requires_us_egress: true,
  limitations: [
    "No open-data permit layer found; search/reports require login",
    "US egress only (COJ hosts block non-US and cloud IPs)",
    "Enumeration only (B-YY-nnnnnn.nnn); concurrency kept at 2",
  ],
};

const SNAPSHOT = {
  county: "duval",
  datasets: [
    { county: "duval", source: "appraisal", ingested_count: 404_023, expected_count: 404_023, implemented: true, limitations: ["FDOR posts only the current roll type"] },
    { county: "duval", source: "coj_parcels", ingested_count: 407_985, expected_count: 407_986, implemented: true, limitations: [] },
    PERMITS_ROW,
    { county: "duval", source: "sunbiz", ingested_count: 0, expected_count: null, implemented: false, limitations: ["No county filter"] },
  ],
};

describe("a source that could not be collected", () => {
  const statuses = parseCoverageStatuses(SNAPSHOT);

  it("is blocked, not complete", () => {
    expect(statuses.get("permits")?.state).toBe("blocked");
    expect(statuses.get("appraisal")?.state).toBe("ingested");
    expect(statuses.get("coj_parcels")?.state).toBe("ingested");
    expect(statuses.get("sunbiz")?.state).toBe("not-implemented");
  });

  it("has no denominator, so 0 / 0 is never a ratio", () => {
    expect(hasComparableExpected(statuses.get("permits"), 0)).toBe(false);
    expect(hasComparableExpected(statuses.get("sunbiz"), null)).toBe(false);
    expect(hasComparableExpected(statuses.get("appraisal"), 404_023)).toBe(true);
  });

  it("puts the pipeline's own explanation on screen, deduplicated and in order", () => {
    const reasons = blockedReasons(statuses.get("permits")!);
    expect(reasons[0]).toContain("Akamai WAF");
    expect(reasons).toContain("skipped: non-US egress (HTTP 0, fetch failed)");
    expect(reasons).toHaveLength(5);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("lists every source carrying no rows, and only those", () => {
    expect(unavailableSources(statuses).map((status) => status.source)).toEqual([
      "permits",
      "sunbiz",
    ]);
  });

  it("treats a row that says nothing about itself as attempted rather than excused", () => {
    const bare = parseCoverageStatuses({ datasets: [{ source: "mystery", ingested_count: 0 }] });
    expect(bare.get("mystery")?.state).toBe("empty");
    expect(bare.get("mystery")?.implemented).toBe(true);
  });

  it("survives a snapshot that is not the shape it expects", () => {
    expect(parseCoverageStatuses(null).size).toBe(0);
    expect(parseCoverageStatuses({ datasets: "no" }).size).toBe(0);
    expect(parseCoverageStatuses({ datasets: [null, { ingested_count: 3 }] }).size).toBe(0);
  });
});

describe("columns the source does not publish", () => {
  it("names owner_count as absent from the source, and points at what replaced it", () => {
    const why = unpopulatedReason("owner_count");
    expect(why).toContain("no co-owner column");
    expect(why).toContain("has_additional_owners");
  });

  it("says nothing about a column that is merely null on this row", () => {
    expect(unpopulatedReason("roof_year_est")).toBeNull();
    expect(unpopulatedReason("address_street")).toBeNull();
  });
});

/** The published artifacts index, trimmed to the objects the MCP configuration names. */
const INDEX = parseArtifactsIndex({
  county: "duval",
  mode: "published",
  artifacts: [
    {
      name: "query-table.parquet",
      cid: "QmYPgh7ELTo5gMimmY7qp4JhkM8GhmPzDMgRjhR4coVndL",
      cidV1: "bafybeievlpnipqvcfaherjrrmdbyowojip3kowi2ucq6hls2td2fagzun4",
      url: "https://ipfs.filebase.io/ipfs/bafybeievlpnipqvcfaherjrrmdbyowojip3kowi2ucq6hls2td2fagzun4",
      ipnsName: "k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r",
      ipnsUrl: "https://ipfs.filebase.io/ipns/k51qzi5uqu5djeq93ll0n7gsrzwfry2jmxb3xa66tcthufpjxv0c3odj1hpq4r",
    },
    {
      name: "dataset-coverage.json",
      cid: "QmWJJg4NcUJVaY6e7k5jhQa8AsQUEd8sv3fqiSaW2bVBSe",
      cidV1: "bafybeidwioxao5tdc3vrjj33ydtvdgva77qbbcgx7fo26jm2iezmsyu2c4",
      url: "https://ipfs.filebase.io/ipfs/bafybeidwioxao5tdc3vrjj33ydtvdgva77qbbcgx7fo26jm2iezmsyu2c4",
      ipnsUrl: "https://ipfs.filebase.io/ipns/k51qzi5uqu5dgefy44zrdzqpp6pqikkged7vea2lxu8354kfl1ah7ijrl2pwum",
    },
    {
      name: "published-counties.json",
      cid: "Qme7UXGLVmEDA3xPSbEYUisW9Q3caUGZdx4pbsrM5TGtrM",
      url: "https://ipfs.filebase.io/ipfs/bafybeiexample",
      ipnsUrl: "https://ipfs.filebase.io/ipns/k51qzi5uqu5dhbku9cn93fphs8tj703ydh5ypo2tk3k13d5t7tz08pr0qijy7d",
    },
  ],
});

describe("MCP configuration addressing", () => {
  const bindings = mcpBindings({
    countyKey: "duval",
    index: INDEX,
    openDataIndexUrl:
      "https://ipfs.filebase.io/ipns/k51qzi5uqu5dig8412edx2zx5x4bxcmilhho2gusgvm7z0wsikrv13nxfzihm2",
  });
  const byEnv = new Map(bindings.map((binding) => [binding.env, binding]));

  it("pins everything DuckDB reads to an immutable CID", () => {
    for (const env of ["PROPERTY_QUERY_TABLE_MAP", "DATASET_COVERAGE_MAP"]) {
      const binding = byEnv.get(env)!;
      expect(binding.addressing, env).toBe("cid");
      expect(binding.perPublish, env).toBe(true);
      expect(binding.value, env).toContain("/ipfs/");
      // This is the exact configuration that broke every data tool on a warm instance.
      expect(binding.value, env).not.toContain("/ipns/");
    }
  });

  it("leaves the plain JSON settings on a name, so they are set once", () => {
    expect(byEnv.get("PUBLISHED_COUNTY_CATALOG_URL")?.addressing).toBe("ipns");
    expect(byEnv.get("PUBLISHED_COUNTY_CATALOG_URL")?.perPublish).toBe(false);
    expect(byEnv.get("ORACLE_OPEN_DATA_IPNS_MAP")?.value).toBe(
      JSON.stringify({ duval: "k51qzi5uqu5dig8412edx2zx5x4bxcmilhho2gusgvm7z0wsikrv13nxfzihm2" }),
    );
  });

  it("names the artifact this publish produced, not a URL assembled from configuration", () => {
    expect(byEnv.get("PROPERTY_QUERY_TABLE_MAP")?.value).toContain(
      "bafybeievlpnipqvcfaherjrrmdbyowojip3kowi2ucq6hls2td2fagzun4",
    );
    expect(bindings.every((binding) => binding.resolved)).toBe(true);
  });

  it("shows a placeholder rather than a URL nothing serves", () => {
    const empty = mcpBindings({ countyKey: "duval", index: null, openDataIndexUrl: null });
    expect(empty.filter((binding) => binding.resolved).map((binding) => binding.env)).toEqual([
      "PROPERTY_QUERY_TABLE_DEFAULT_COUNTY",
      "ORACLE_OPEN_DATA_DEFAULT_COUNTY",
    ]);
    expect(empty.find((binding) => binding.env === "PROPERTY_QUERY_TABLE_MAP")?.value).toContain(
      "<not published yet>",
    );
  });

  it("groups the per publish lines first in the pasteable block", () => {
    const text = formatMcpEnv(bindings);
    expect(text).toContain("# --- per publish ---");
    expect(text.indexOf("PROPERTY_QUERY_TABLE_MAP=")).toBeLessThan(
      text.indexOf("# --- set once ---"),
    );
    expect(text.indexOf("PUBLISHED_COUNTY_CATALOG_URL=")).toBeGreaterThan(
      text.indexOf("# --- set once ---"),
    );
  });

  it("takes the IPNS name from a URL or from a bare name, and never from a CID", () => {
    const name = "k51qzi5uqu5dig8412edx2zx5x4bxcmilhho2gusgvm7z0wsikrv13nxfzihm2";
    expect(ipnsNameFromUrl(`https://ipfs.filebase.io/ipns/${name}`)).toBe(name);
    // Some deployments configure the bare name rather than a gateway URL.
    expect(ipnsNameFromUrl(name)).toBe(name);
    expect(ipnsNameFromUrl("https://ipfs.filebase.io/ipfs/bafybeiexample")).toBeNull();
    expect(ipnsNameFromUrl("https://ipfs.filebase.io/ipfs/QmRsQUc7zcMzA65w83")).toBeNull();
    expect(ipnsNameFromUrl(null)).toBeNull();
  });
});
