import { describe, expect, it } from "vitest";
import { parseDailyFile, windowDays } from "../src/tracks/businesses.js";
import { isDuvalBusiness, parseSunbizEventLine, parseSunbizRecord, splitSunbizRecords, sunbizDate, SUNBIZ_RECORD_LENGTH } from "../src/tracks/sunbiz.js";

/** Build a 1,440-char record from 1-based field positions (synthetic values, real layout). */
function record(fields: Record<string, [number, string]>): string {
  const buf = Array.from({ length: SUNBIZ_RECORD_LENGTH }, () => " ");
  for (const [start, value] of Object.values(fields)) {
    for (let i = 0; i < value.length; i += 1) buf[start - 1 + i] = value[i] as string;
  }
  return buf.join("");
}

const JAX = record({
  doc: [1, "L26000999901"],
  name: [13, "RIVERSIDE ROOFING LLC"],
  status: [205, "A"],
  type: [206, "FLAL"],
  p_addr1: [221, "1303 W DEFENDER CT"],
  p_city: [305, "JACKSONVILLE"],
  p_state: [333, "FL"],
  p_zip: [335, "32218"],
  m_addr1: [347, "PO BOX 1"],
  m_city: [431, "JACKSONVILLE"],
  m_state: [459, "FL"],
  m_zip: [461, "322010001"],
  m_country: [471, "US"],
  file_date: [473, "08032026"],
  fei: [481, "APPLIED"],
  flag: [495, "N"],
  state_country: [504, "FL"],
  ra_name: [545, "DOE                 JANE"],
  ra_type: [587, "P"],
  ra_addr: [588, "1303 W DEFENDER CT"],
  ra_city: [630, "JACKSONVILLE"],
  ra_state: [658, "FL"],
  ra_zip5: [660, "32218"],
  o1_title: [669, "AMBR"],
  o1_type: [673, "P"],
  o1_name: [674, "DOE                 JANE"],
  o2_title: [797, "MGR "],
  o2_type: [801, "C"],
  o2_name: [802, "HOLDCO MANAGEMENT, LLC"],
});
const MIAMI = record({
  doc: [1, "P26000000002"],
  name: [13, "SOUTH BEACH CAFE INC"],
  status: [205, "A"],
  type: [206, "DOMP"],
  p_addr1: [221, "1000 BRICKELL AVE"],
  p_city: [305, "MIAMI"],
  p_state: [333, "FL"],
  p_zip: [335, "33131"],
  m_city: [431, "MIAMI"],
  m_zip: [461, "33131"],
  file_date: [473, "07152026"],
});

describe("Sunbiz fixed-width parser", () => {
  it("parses every mapped field at the verified offsets", () => {
    const r = parseSunbizRecord(JAX);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      doc_number: "L26000999901",
      name: "RIVERSIDE ROOFING LLC",
      status: "A",
      filing_type: "FLAL",
      principal_addr1: "1303 W DEFENDER CT",
      principal_city: "JACKSONVILLE",
      principal_state: "FL",
      principal_zip: "32218",
      mail_addr1: "PO BOX 1",
      mail_zip: "322010001",
      mail_country: "US",
      file_date: "2026-08-03",
      fei_number: "APPLIED",
      state_country: "FL",
      registered_agent: "DOE JANE",
      registered_agent_type: "P",
      ra_addr1: "1303 W DEFENDER CT",
      ra_city: "JACKSONVILLE",
      ra_state: "FL",
      ra_zip: "32218",
    });
    expect(r?.officers).toEqual([
      { title: "AMBR", type: "P", name: "DOE JANE" },
      { title: "MGR", type: "C", name: "HOLDCO MANAGEMENT, LLC" },
    ]);
  });

  it("applies the Duval filter on ZIP 322xx or JACKSONVILLE city", () => {
    expect(isDuvalBusiness(parseSunbizRecord(JAX)!)).toBe(true);
    expect(isDuvalBusiness(parseSunbizRecord(MIAMI)!)).toBe(false);
    const beach = record({ doc: [1, "L1"], name: [13, "X"], p_city: [305, "JACKSONVILLE BEACH"], p_zip: [335, "32250"] });
    expect(isDuvalBusiness(parseSunbizRecord(beach)!)).toBe(true);
    const mailOnly = record({ doc: [1, "L2"], name: [13, "Y"], p_city: [305, "ORLANDO"], p_zip: [335, "32801"], m_zip: [461, "32207"] });
    expect(isDuvalBusiness(parseSunbizRecord(mailOnly)!)).toBe(true);
  });

  it("splits a daily file (LF or CRLF, NUL padding) and counts parsed vs kept", () => {
    const text = `${JAX}\n${MIAMI}\r\n${JAX.replace("L26000999901", "L26000999902")}\n`;
    const out = parseDailyFile(text, "20260821c.txt");
    expect(out.parsed).toBe(3);
    expect(out.kept.map((r) => r?.doc_number)).toEqual(["L26000999901", "L26000999902"]);
    expect(splitSunbizRecords("short line\n").length).toBe(0);
  });

  it("handles dates, events and the window argument", () => {
    expect(sunbizDate("08032026")).toBe("2026-08-03");
    expect(sunbizDate("00000000")).toBeNull();
    expect(sunbizDate(null)).toBeNull();
    expect(parseSunbizEventLine("L26000999901 AMEND 20260803")).toEqual({ doc_number: "L26000999901", raw: "L26000999901 AMEND 20260803" });
    expect(parseSunbizEventLine("x")).toBeNull();
    expect(windowDays("14d")).toBe(14);
    expect(windowDays("3")).toBe(3);
    expect(windowDays(null, 14)).toBe(14);
    expect(windowDays("2026-08-01..2026-08-21", 14)).toBe(14);
  });
});
