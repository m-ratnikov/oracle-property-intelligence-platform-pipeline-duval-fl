/**
 * Where a per-property document is fetched from.
 *
 * This had one wrong answer for a while and it was invisible: the page built
 * `<base>/<cid>.json` from an unset open-data index, which resolved to
 * `/sample/open-data/<cid>.json` on the deployed runtime and 404'd for every
 * parcel. The open-data panel was empty on a site serving 404,023 real parcels,
 * and nothing failed loudly enough to notice.
 *
 * The published documents are content-addressed. `/ipfs/<cid>` answers 200 and
 * `/ipfs/<cid>.json` answers 400, because the extension makes it a different
 * path rather than a hint about the content type.
 */

import { describe, expect, it } from "vitest";

import {
  openDataBaseUrl,
  propertyJsonUrl,
  propertyJsonUrls,
} from "@/lib/openData";
import { parseOpenDataIndex } from "@/lib/types";

const CID = "QmYLf9jRCnPwEE23EYJi2B9YjXN97LyLMPzYuP9m2EgCSS";

describe("propertyJsonUrls", () => {
  it("addresses the document by CID first, with no extension", () => {
    const [first] = propertyJsonUrls(CID, null);
    expect(first).toBe(`https://ipfs.filebase.io/ipfs/${CID}`);
    expect(first).not.toMatch(/\.json$/);
  });

  it("needs no index at all, because the row carries the CID", () => {
    expect(propertyJsonUrls(CID, null)).toHaveLength(1);
    expect(propertyJsonUrl(CID, null)).toContain(CID);
  });

  it("also offers the directory shape when a bucket-style index is configured", () => {
    const urls = propertyJsonUrls(
      CID,
      "https://example.test/open-data/index.json",
    );
    expect(urls).toEqual([
      `https://ipfs.filebase.io/ipfs/${CID}`,
      `https://example.test/open-data/${CID}.json`,
    ]);
  });

  it("does not repeat a gateway index as a directory, which would append .json to it", () => {
    // The bug in one line: a gateway base plus "/<cid>.json" is a 400, and
    // offering it as a candidate would spend a request proving that.
    const urls = propertyJsonUrls(
      CID,
      "https://ipfs.filebase.io/ipfs/QmIndexCid",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/\.json$/);
  });

  it("keeps the bundled sample reachable for local development", () => {
    // Relative bases are how a clone browses public/sample before it has
    // published anything. The CID is still tried first, so this costs a
    // request only when the gateway has no copy.
    const urls = propertyJsonUrls(CID, "/sample/open-data/index.json");
    expect(urls[1]).toBe(`/sample/open-data/${CID}.json`);
  });
});

describe("openDataBaseUrl", () => {
  it("drops the index filename and keeps the directory", () => {
    expect(openDataBaseUrl("https://example.test/open-data/index.json")).toBe(
      "https://example.test/open-data",
    );
  });

  it("leaves a bare CID path alone, since it names an object rather than a file", () => {
    expect(openDataBaseUrl("https://ipfs.filebase.io/ipfs/QmIndexCid")).toBe(
      "https://ipfs.filebase.io/ipfs/QmIndexCid",
    );
  });

  it("ignores a query string and a fragment", () => {
    expect(
      openDataBaseUrl("https://example.test/open-data/index.json?v=2#top"),
    ).toBe("https://example.test/open-data");
  });

  it("is null when nothing is configured", () => {
    expect(openDataBaseUrl(null)).toBeNull();
  });
});

describe("parseOpenDataIndex", () => {
  it("resolves a shard identified by CID to a gateway URL", () => {
    // The shape the pipeline actually publishes. Before this, the walk built
    // `<base>/shards/undefined` because it only looked for a filename.
    const index = parseOpenDataIndex({
      county: "duval",
      propertyCount: 404023,
      shards: [
        {
          shardIndex: 0,
          fromParcel: "0000010005R",
          toParcel: "0024012310R",
          count: 10000,
          shardCid: "QmeQ2ZJqsa2M7F8br6pb6yGL1CEkeLef6xVbymcPB7JcJS",
        },
      ],
    });

    expect(index.shards).toHaveLength(1);
    expect(index.shards[0]?.url).toBe(
      "https://ipfs.filebase.io/ipfs/QmeQ2ZJqsa2M7F8br6pb6yGL1CEkeLef6xVbymcPB7JcJS",
    );
  });

  it("still accepts a shard identified by filename", () => {
    const index = parseOpenDataIndex({
      shards: [{ shard: "shard-0000.json", count: 10 }],
    });
    expect(index.shards[0]?.shard).toBe("shard-0000.json");
    expect(index.shards[0]?.url).toBeUndefined();
  });

  it("drops a shard that identifies itself neither way", () => {
    expect(parseOpenDataIndex({ shards: [{ count: 10 }] }).shards).toHaveLength(
      0,
    );
  });
});
