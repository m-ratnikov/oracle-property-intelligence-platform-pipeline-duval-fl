import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { all, ensureSchema, openDb } from "../src/db.js";
import { discoverApiPaths, parsePermitDoc, permitEndpointCandidates, permitNumber, permitWindow, pickDeep, ROOF_RE, stagePermits } from "../src/tracks/permits.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/jaxepics-permit.synthetic.json"), "utf8")) as { permit: unknown };

describe("JaxEPICS permit parsing (synthetic fixture; real shape discovered in Actions)", () => {
  it("maps keys case-insensitively at any depth, flags re-roof work, keeps the payload", () => {
    const row = parsePermitDoc("B-25-279425.000", fixture.permit);
    expect(row).toMatchObject({
      permit_no: "B-25-279425.000",
      permit_type: "Building",
      work_type: "Residential Re-Roof",
      description: "REROOF SHINGLE TO SHINGLE 28 SQ",
      status: "Issued",
      applied_date: "2025-06-02",
      issue_date: "2025-06-05",
      job_cost: 12500,
      address: "1303 W DEFENDER CT, JACKSONVILLE, FL 32218",
      re_raw: "168871-2134",
      contractor_name: "RIVERSIDE ROOFING LLC",
      contractor_license: "CCC1330001",
      is_roof_permit: true,
    });
    expect(JSON.parse(row.source_payload)).toEqual(fixture.permit);
    expect(pickDeep({ a: { b: { PermitStatus: "Final" } } }, "status", "permitStatus")).toBe("Final");
    expect(pickDeep({ x: 1 }, "nothing")).toBeUndefined();
  });

  it("roof regex, permit numbers, window and API discovery", () => {
    expect(ROOF_RE.test("ROOF REPLACEMENT")).toBe(true);
    expect(ROOF_RE.test("Re-roof")).toBe(true);
    expect(ROOF_RE.test("SHINGLE REPAIR")).toBe(true);
    expect(ROOF_RE.test("ROOFING")).toBe(true);
    expect(ROOF_RE.test("FIREPROOFING")).toBe(false);
    expect(ROOF_RE.test("NEW POOL")).toBe(false);
    expect(permitNumber("B", 26, 12)).toBe("B-26-000012.000");
    expect(permitWindow("300")).toBe(300);
    expect(permitWindow("50 permits")).toBe(50);
    expect(permitWindow(null, 300)).toBe(300);
    // Angular bundles concatenate an apiUrl with bare "api/..." literals; absolute hosts and {id} slots also appear
    const bundle = `apiUrl:"https://jaxepicsapi.coj.net/",e.get(this.base+"api/Permit/View/"+n),fetch("https://jaxepicsapi.coj.net/api/Permits/Search"),x="/api/Inspection/\${id}",y="api/Contractor/Lookup"`;
    const paths = discoverApiPaths(bundle);
    expect(paths).toContain("api/Permit/View/");
    expect(paths).toContain("/api/Inspection/${id}");
    expect(paths).toContain("https://jaxepicsapi.coj.net/api/Permits/Search");
    expect(paths).toContain("https://jaxepicsapi.coj.net/");
    expect(paths).toContain("api/Contractor/Lookup");
    const cands = permitEndpointCandidates(paths);
    expect(cands[0]).toBe("/api/Permit/View/{permitNumber}");
    expect(cands).toContain("https://jaxepicsapi.coj.net/api/Permits/Search/{permitNumber}");
    expect(cands).toContain("/api/Permit/{permitNumber}");
    expect(discoverApiPaths("nothing here")).toEqual([]);
  });

  it("stages permits and links them to parcels by normalized RE", async () => {
    const db = await openDb(":memory:");
    await ensureSchema(db.conn);
    await db.conn.run(`INSERT INTO parcels (parcel_id, row_hash, source_system, fetched_at, run_id) VALUES ('1688712134R','h','duval_appraiser',now(),'r')`);
    const row = parsePermitDoc("B-25-279425.000", fixture.permit);
    await stagePermits(db.conn, [row, { ...row, permit_no: "B-25-279426.000", re_raw: "999999-9999" }]);
    const staged = await all<{ permit_no: string; parcel_id: string | null; is_roof_permit: boolean }>(db.conn, "SELECT permit_no, parcel_id, is_roof_permit FROM staging.permits ORDER BY permit_no");
    expect(staged).toEqual([
      { permit_no: "B-25-279425.000", parcel_id: "1688712134R", is_roof_permit: true },
      { permit_no: "B-25-279426.000", parcel_id: null, is_roof_permit: true },
    ]);
    await db.close();
  });
});
