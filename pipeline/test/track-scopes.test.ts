import { describe, expect, it } from "vitest";
import { ensureSchema, openDb, q, scalar } from "../src/db.js";
import { hashStaging, mergeStaging, type Provenance } from "../src/merge.js";
import { addressPointsScope } from "../src/tracks/coj_addresses.js";
import { permitNumber, permitNumbersScope } from "../src/tracks/permits.js";

const prov = (runId: string): Provenance => ({
  sourceSystem: "test",
  sourceUrl: "https://example.test",
  sourceArtifact: "test",
  sourceSha256: "sha",
  fetchedAt: "2026-08-21T00:00:00Z",
  runId,
});

describe("coj_addresses authoritative scope", () => {
  it("is unscoped only for a complete, unbounded, error-free full pull", () => {
    expect(addressPointsScope({ mode: "full", lastEdit: null, partial: false })).toBeUndefined();
    expect(addressPointsScope({ mode: "full", lastEdit: "2026-08-01T00:00:00", partial: false })).toBeUndefined();
  });

  it("narrows an incremental pull to the watermark it actually asked for", () => {
    expect(addressPointsScope({ mode: "incremental", lastEdit: "2026-08-01T00:00:00", partial: false })).toBe(
      "t.edit_date >= '2026-08-01T00:00:00'::TIMESTAMP",
    );
  });

  it("speaks for nothing when the pull was bounded or hit page errors", () => {
    expect(addressPointsScope({ mode: "full", lastEdit: null, partial: true })).toBe("FALSE");
    expect(addressPointsScope({ mode: "incremental", lastEdit: "2026-08-01T00:00:00", partial: true })).toBe("FALSE");
  });

  it("an incremental pull does not report the rows it never asked for as deleted", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    const seed = (id: string, editDate: string) =>
      db.conn.run(
        `INSERT INTO address_points (address_id, whole_address, edit_date, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
         VALUES (${q(id)}, ${q(`${id} MAIN ST`)}, ${q(editDate)}::TIMESTAMP, ${q(`h${id}`)}, 'coj', 'https://example.test', 'coj_addresses/full', 'sha', '2026-07-01T00:00:00'::TIMESTAMP, 'run-earlier')`,
      );
    await seed("a1", "2026-01-01T00:00:00");
    await seed("a2", "2026-01-02T00:00:00");
    await seed("a3", "2026-08-10T00:00:00");

    // a run whose EDIT_DATE >= 2026-08-01 window returned nothing at all
    await db.conn.run("CREATE OR REPLACE TABLE staging.address_points AS SELECT address_id, whole_address, edit_date FROM address_points WHERE false");
    const hashed = await hashStaging(db.conn, "staging.address_points", prov("run2"));
    const unscoped = await mergeStaging(db.conn, { target: "address_points", staging: hashed, keys: ["address_id"] });
    expect(unscoped.missingInSource).toBe(3);

    const scoped = await mergeStaging(db.conn, {
      target: "address_points",
      staging: hashed,
      keys: ["address_id"],
      authoritativeScope: addressPointsScope({ mode: "incremental", lastEdit: "2026-08-01T00:00:00", partial: false }),
    });
    // only a3 sits inside the window that was actually queried
    expect(scoped.missingInSource).toBe(1);
    expect(scoped.totalAfter).toBe(3);
    expect(await scalar(db.conn, "SELECT count(*) FROM address_points")).toBe("3");
    await db.close();
  });
});

describe("permits authoritative scope", () => {
  it("speaks for nothing when the enumeration answered nothing", () => {
    expect(permitNumbersScope([])).toBe("FALSE");
  });

  it("names exactly the permit numbers that came back with an answer", () => {
    const numbers = [permitNumber("B", 25, 1), permitNumber("B", 25, 2)];
    expect(permitNumbersScope(numbers)).toBe("t.permit_no IN ('B-25-000001.000', 'B-25-000002.000')");
  });

  it("a constrained run does not report every held permit as deleted", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    for (const no of ["B-25-000001.000", "B-25-000002.000", "B-24-000500.000"]) {
      await db.conn.run(
        `INSERT INTO permits (permit_no, description, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
         VALUES (${q(no)}, 'RE-ROOF', ${q(`h${no}`)}, 'jaxepics', 'https://example.test', 'permits/discovered-api.json', 'sha', '2026-07-01T00:00:00'::TIMESTAMP, 'run-earlier')`,
      );
    }
    // the WAF-blocked path: the track stages an empty permits table so the run is still recorded
    await db.conn.run("CREATE OR REPLACE TABLE staging.permits AS SELECT permit_no, description FROM permits WHERE false");
    const hashed = await hashStaging(db.conn, "staging.permits", prov("run2"));
    const unscoped = await mergeStaging(db.conn, { target: "permits", staging: hashed, keys: ["permit_no"] });
    expect(unscoped.missingInSource).toBe(3);

    const scoped = await mergeStaging(db.conn, {
      target: "permits",
      staging: hashed,
      keys: ["permit_no"],
      authoritativeScope: permitNumbersScope([]),
    });
    expect(scoped).toMatchObject({ staged: 0, missingInSource: 0, totalAfter: 3 });
    await db.close();
  });

  it("counts a permit that vanished from the slice this run enumerated", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    for (const no of ["B-25-000001.000", "B-25-000002.000", "B-24-000500.000"]) {
      await db.conn.run(
        `INSERT INTO permits (permit_no, description, row_hash, source_system, source_url, source_artifact, source_sha256, fetched_at, run_id)
         VALUES (${q(no)}, 'RE-ROOF', ${q(`h${no}`)}, 'jaxepics', 'https://example.test', 'permits/discovered-api.json', 'sha', '2026-07-01T00:00:00'::TIMESTAMP, 'run-earlier')`,
      );
    }
    // this run asked about both 2025 numbers; only the first still exists at source
    await db.conn.run("CREATE OR REPLACE TABLE staging.permits AS SELECT permit_no, description FROM permits WHERE permit_no = 'B-25-000001.000'");
    const hashed = await hashStaging(db.conn, "staging.permits", prov("run2"));
    const scoped = await mergeStaging(db.conn, {
      target: "permits",
      staging: hashed,
      keys: ["permit_no"],
      authoritativeScope: permitNumbersScope(["B-25-000001.000", "B-25-000002.000"]),
    });
    expect(scoped.missingInSource).toBe(1);
    expect(scoped.totalAfter).toBe(3);
    await db.close();
  });
});
