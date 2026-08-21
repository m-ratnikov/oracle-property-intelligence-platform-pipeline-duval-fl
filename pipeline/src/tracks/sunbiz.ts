/**
 * Sunbiz corporate data file: 1,440-character fixed-length records (+ newline). Offsets below are
 * 1-based inclusive, validated against live daily files (the published layout page was unreachable,
 * HTTP 522, when this was written):
 *   1-12 doc number | 13-204 name | 205 status | 206-220 filing type |
 *   221-262 principal addr1 | 263-304 addr2 | 305-332 city | 333-334 state | 335-344 zip | 345-346 country |
 *   347-388 mail addr1 | 389-430 addr2 | 431-458 city | 459-460 state | 461-470 zip | 471-472 country |
 *   473-480 file date MMDDYYYY | 481-494 FEI | 495 more-than-six-officers flag | 496-503 last trx date |
 *   504-505 state/country of incorporation | 506-544 three report year/flag/date blocks |
 *   545-586 RA name | 587 RA type (P/C) | 588-629 RA addr | 630-657 RA city | 658-659 RA state | 660-664 RA zip5 | 665-668 RA zip4 |
 *   669-1436 six officer blocks of 128: title 4 | type 1 | name 42 | addr 42 | city 28 | state 2 | zip5 5 | zip4 4 |
 *   1437-1440 filler.
 */
export const SUNBIZ_RECORD_LENGTH = 1440;

export interface SunbizOfficer {
  title: string;
  type: string;
  name: string;
}

export interface SunbizRecord {
  doc_number: string;
  name: string;
  status: string;
  filing_type: string;
  principal_addr1: string | null;
  principal_addr2: string | null;
  principal_city: string | null;
  principal_state: string | null;
  principal_zip: string | null;
  principal_country: string | null;
  mail_addr1: string | null;
  mail_addr2: string | null;
  mail_city: string | null;
  mail_state: string | null;
  mail_zip: string | null;
  mail_country: string | null;
  file_date: string | null;
  fei_number: string | null;
  last_trx_date: string | null;
  state_country: string | null;
  registered_agent: string | null;
  registered_agent_type: string | null;
  ra_addr1: string | null;
  ra_city: string | null;
  ra_state: string | null;
  ra_zip: string | null;
  officers: SunbizOfficer[];
}

function f(line: string, start: number, end: number): string | null {
  const v = line.slice(start - 1, end).replace(/\0/g, " ").trim();
  return v.length === 0 ? null : v;
}

/** MMDDYYYY -> YYYY-MM-DD (null when blank or invalid). */
export function sunbizDate(v: string | null): string | null {
  if (v === null || !/^\d{8}$/.test(v)) return null;
  const mm = v.slice(0, 2);
  const dd = v.slice(2, 4);
  const yyyy = v.slice(4, 8);
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31 || yyyy === "0000") return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** Normalize a Sunbiz name field "LAST FIRST MIDDLE" (padded columns) to single-spaced. */
function squash(v: string | null): string | null {
  return v === null ? null : v.replace(/\s+/g, " ").trim();
}

export function parseSunbizRecord(line: string): SunbizRecord | null {
  if (line.length < 1436) return null;
  const doc = f(line, 1, 12);
  if (doc === null) return null;
  const officers: SunbizOfficer[] = [];
  for (let i = 0; i < 6; i += 1) {
    const base = 669 + i * 128;
    const name = squash(f(line, base + 5, base + 46));
    if (name === null) continue;
    officers.push({ title: f(line, base, base + 3) ?? "", type: f(line, base + 4, base + 4) ?? "", name });
  }
  const zipTrim = (v: string | null) => (v === null ? null : v.replace(/\s+/g, ""));
  return {
    doc_number: doc,
    name: squash(f(line, 13, 204)) ?? "",
    status: f(line, 205, 205) ?? "",
    filing_type: f(line, 206, 220) ?? "",
    principal_addr1: f(line, 221, 262),
    principal_addr2: f(line, 263, 304),
    principal_city: f(line, 305, 332),
    principal_state: f(line, 333, 334),
    principal_zip: zipTrim(f(line, 335, 344)),
    principal_country: f(line, 345, 346),
    mail_addr1: f(line, 347, 388),
    mail_addr2: f(line, 389, 430),
    mail_city: f(line, 431, 458),
    mail_state: f(line, 459, 460),
    mail_zip: zipTrim(f(line, 461, 470)),
    mail_country: f(line, 471, 472),
    file_date: sunbizDate(f(line, 473, 480)),
    fei_number: f(line, 481, 494),
    last_trx_date: sunbizDate(f(line, 496, 503)),
    state_country: f(line, 504, 505),
    registered_agent: squash(f(line, 545, 586)),
    registered_agent_type: f(line, 587, 587),
    ra_addr1: f(line, 588, 629),
    ra_city: f(line, 630, 657),
    ra_state: f(line, 658, 659),
    ra_zip: zipTrim(((f(line, 660, 664) ?? "") + (f(line, 665, 668) ?? "")) || null),
    officers,
  };
}

/** Duval filter: principal or mailing ZIP5 in 322xx, or city starting with JACKSONVILLE (incl. JACKSONVILLE BEACH). */
export function isDuvalBusiness(r: SunbizRecord): boolean {
  const zip = (z: string | null) => z !== null && /^322\d\d/.test(z);
  const city = (c: string | null) => c !== null && /^JACKSONVILLE/i.test(c.trim());
  return zip(r.principal_zip) || zip(r.mail_zip) || city(r.principal_city) || city(r.mail_city);
}

/** Split a daily file into fixed records; tolerant of CRLF and of NUL padding. */
export function splitSunbizRecords(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length >= 1436);
}

/** Events file line: the doc number leads (12 chars); the rest of the layout is kept raw. */
export function parseSunbizEventLine(line: string): { doc_number: string; raw: string } | null {
  const doc = line.slice(0, 12).trim();
  if (doc.length < 6) return null;
  return { doc_number: doc, raw: line.replace(/\0/g, " ").trimEnd() };
}
