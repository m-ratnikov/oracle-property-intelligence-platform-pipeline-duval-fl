import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { paWindow, runLexiconTransform } from "../src/tracks/pa_detail.js";
import { normalizeRoofCover, parsePaDetail } from "../src/tracks/pa_detail_parse.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Page structure from the Elephant transform's embedded sample (RE 002060-8295); owner + sales sections synthetic. */
const html = readFileSync(join(here, "fixtures/pa-detail-0020608295R.html"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "duval-lexicon-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("PA Detail.aspx parser", () => {
  it("extracts RE, address, owner, buildings (year built, roof, exterior wall, areas) and sales", () => {
    const d = parsePaDetail(html);
    expect(d.ok).toBe(true);
    expect(d.re).toBe("002060-8295");
    expect(d.site_address).toBe("11558 CABINET CT");
    expect(d.owner_name).toBe("DOE JANE Q");
    expect(d.mailing_lines).toEqual(["11558 CABINET CT", "JACKSONVILLE, FL 32256"]);
    expect(d.number_of_buildings).toBe(1);
    expect(d.property_use).toBe("0105 Townhouse");
    expect(d.buildings).toHaveLength(1);
    const b = d.buildings[0]!;
    expect(b).toMatchObject({
      building_no: 1,
      building_type: "0105 - TOWNHOUSE",
      actual_year_built: 2023,
      roof_structure: "3 Gable or Hip",
      roofing_cover: "3 Asph/Comp Shng",
      exterior_wall: "8 Horizontal Lap; 6 Vertical Sheet",
      gross_area_sqft: 1631,
      heated_area_sqft: 1294,
      effective_area_sqft: 1417,
    });
    expect(b.elements["Air Cond"]).toEqual(["3 Central"]);
    expect(normalizeRoofCover(b.roofing_cover)).toBe("Asph/Comp Shng");
    expect(d.sales).toHaveLength(2);
    expect(d.sales[0]).toMatchObject({ book_page: "21000-01234", or_book: "21000", or_page: "01234", sale_date: "2023-05-16", sale_price: 312500, deed_instrument: "WD - Warranty Deed", qualified: "Qualified", vacant_improved: "Improved" });
    expect(d.sales[0]?.document_url).toContain("oncore.duvalclerk.com");
    expect(d.sales[1]).toMatchObject({ sale_date: "2021-02-03", sale_price: 100, qualified: "Unqualified", vacant_improved: "Vacant" });
    expect(parsePaDetail("<html><body>nothing</body></html>").ok).toBe(false);
    expect(paWindow("300")).toBe(300);
    expect(paWindow("50 parcels")).toBe(50);
    expect(paWindow(null, 300)).toBe(300);
  });

  it("runs the vendored Elephant transform on the page and produces lexicon JSON", () => {
    const out = runLexiconTransform("0020608295R", html, "11558 CABINET CT, JACKSONVILLE, FL 32256", tmp, { warn: () => undefined });
    expect(out.ok, out.error ?? "").toBe(true);
    const dataDir = join(tmp, "0020608295R", "data");
    expect(existsSync(dataDir)).toBe(true);
    const files = readdirSync(dataDir);
    expect(files.length).toBeGreaterThan(0);
    expect(out.files.some((f) => /property|structure|sales|address/i.test(f))).toBe(true);
    const prop = files.find((f) => /^property/i.test(f));
    if (prop) {
      const doc = JSON.parse(readFileSync(join(dataDir, prop), "utf8")) as Record<string, unknown>;
      expect(typeof doc).toBe("object");
    }
  }, 120_000);
});
