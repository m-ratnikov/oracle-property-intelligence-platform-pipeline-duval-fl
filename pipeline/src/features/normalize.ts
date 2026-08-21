/**
 * Normalization rules shared by reconciliation (TS) and SQL (twins), both tested.
 */

/** NAL/PA parcel id "0000010005R" and COJ RE "000001-0005" / "000001 0005" / "0000010005R" -> "0000010005". */
export function normalizeParcelId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const noSuffix = s.replace(/R$/, "");
  return noSuffix.length === 0 ? null : noSuffix;
}
export function normalizeParcelIdSql(col: string): string {
  return `NULLIF(regexp_replace(regexp_replace(upper(coalesce(${col}, '')), '[^0-9A-Z]', '', 'g'), 'R$', ''), '')`;
}

const STREET_SUFFIX: Record<string, string> = {
  STREET: "ST", AVENUE: "AVE", AV: "AVE", BOULEVARD: "BLVD", DRIVE: "DR", ROAD: "RD", LANE: "LN", COURT: "CT", CIRCLE: "CIR",
  PLACE: "PL", TERRACE: "TER", TERR: "TER", PARKWAY: "PKWY", HIGHWAY: "HWY", TRAIL: "TRL", WAY: "WAY", NORTH: "N", SOUTH: "S",
  EAST: "E", WEST: "W", SUITE: "STE", APARTMENT: "APT", UNIT: "UNIT", BUILDING: "BLDG",
};

/** Address line normalization: upper, punctuation stripped, USPS-style suffix abbreviations, single spaces. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const tokens = raw
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^0-9A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_SUFFIX[t] ?? t);
  const s = tokens.join(" ");
  return s.length === 0 ? null : s;
}

/** SQL twin (same suffix map applied with nested replaces on word boundaries). */
export function normalizeAddressSql(col: string): string {
  let expr = `regexp_replace(regexp_replace(upper(coalesce(${col}, '')), '[.,#]', ' ', 'g'), '[^0-9A-Z ]', ' ', 'g')`;
  expr = `' ' || regexp_replace(trim(${expr}), '\\s+', ' ', 'g') || ' '`;
  for (const [long, short] of Object.entries(STREET_SUFFIX)) {
    expr = `replace(${expr}, ' ${long} ', ' ${short} ')`;
  }
  return `NULLIF(trim(${expr}), '')`;
}

const NAME_STOP = new Set(["LLC", "L L C", "INC", "CORP", "CORPORATION", "CO", "LTD", "LP", "L P", "LLP", "PLLC", "PA", "P A", "THE", "TRUSTEE", "TRUSTEES", "TR", "TRUST", "ET", "AL", "ETAL", "ET AL", "ETUX", "ET UX", "JR", "SR", "II", "III"]);

/** Owner / business name normalization: upper, punctuation stripped, entity suffixes and trust/etal tokens dropped. */
const NAME_STOP_PHRASES = ["L L C", "L P", "P A", "ET AL", "ET UX"];

export function normalizeName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let text = ` ${raw.toUpperCase().replace(/&/g, " AND ").replace(/[^0-9A-Z ]/g, " ").replace(/\s+/g, " ").trim()} `;
  for (const phrase of NAME_STOP_PHRASES) text = text.split(` ${phrase} `).join(" ");
  const tokens = text
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NAME_STOP.has(t));
  const s = tokens.join(" ");
  return s.length === 0 ? null : s;
}
export function normalizeNameSql(col: string): string {
  let expr = `regexp_replace(replace(upper(coalesce(${col}, '')), '&', ' AND '), '[^0-9A-Z ]', ' ', 'g')`;
  expr = `' ' || regexp_replace(trim(${expr}), '\\s+', ' ', 'g') || ' '`;
  for (const phrase of NAME_STOP_PHRASES) {
    expr = `replace(${expr}, ' ${phrase} ', ' ')`;
  }
  for (const stop of [...NAME_STOP].filter((s) => !s.includes(" "))) {
    expr = `replace(${expr}, ' ${stop} ', ' ')`;
  }
  // a second pass catches adjacent stop words (e.g. "TRUSTEE ET AL")
  for (const stop of [...NAME_STOP].filter((s) => !s.includes(" "))) {
    expr = `replace(${expr}, ' ${stop} ', ' ')`;
  }
  return `NULLIF(regexp_replace(trim(${expr}), '\\s+', ' ', 'g'), '')`;
}

export function zip5(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const d = raw.replace(/[^0-9]/g, "");
  return d.length >= 5 ? d.slice(0, 5) : null;
}
export function zip5Sql(col: string): string {
  return `CASE WHEN length(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g')) >= 5 THEN left(regexp_replace(${col}, '[^0-9]', '', 'g'), 5) END`;
}

/** Heuristic owner kind from the raw owner name. */
export function ownerKind(name: string | null | undefined): "COMPANY" | "TRUST" | "GOVERNMENT" | "PERSON" | null {
  if (name === null || name === undefined) return null;
  const u = name.toUpperCase();
  if (/\b(CITY OF|COUNTY|STATE OF|UNITED STATES|USA|SCHOOL BOARD|AUTHORITY|DISTRICT|DEPT|DEPARTMENT)\b/.test(u)) return "GOVERNMENT";
  if (/\b(TRUST|TRUSTEE|TRUSTEES|TR|LIVING TRUST|REV TRUST|REVOCABLE)\b/.test(u)) return "TRUST";
  if (/\b(LLC|L L C|INC|CORP|CORPORATION|CO|LTD|LP|L P|LLP|PLLC|PARTNERSHIP|PARTNERS|HOLDINGS|PROPERTIES|ASSOCIATION|ASSN|CHURCH|BANK|COMPANY|GROUP|ENTERPRISES|INVESTMENTS|REALTY|DEVELOPMENT|HOMES|CONDOMINIUM)\b/.test(u)) return "COMPANY";
  return "PERSON";
}
export function ownerKindSql(col: string): string {
  const u = `upper(coalesce(${col}, ''))`;
  return `CASE WHEN ${col} IS NULL THEN NULL
    WHEN regexp_matches(${u}, '\\b(CITY OF|COUNTY|STATE OF|UNITED STATES|USA|SCHOOL BOARD|AUTHORITY|DISTRICT|DEPT|DEPARTMENT)\\b') THEN 'GOVERNMENT'
    WHEN regexp_matches(${u}, '\\b(TRUST|TRUSTEE|TRUSTEES|TR|LIVING TRUST|REV TRUST|REVOCABLE)\\b') THEN 'TRUST'
    WHEN regexp_matches(${u}, '\\b(LLC|L L C|INC|CORP|CORPORATION|CO|LTD|LP|L P|LLP|PLLC|PARTNERSHIP|PARTNERS|HOLDINGS|PROPERTIES|ASSOCIATION|ASSN|CHURCH|BANK|COMPANY|GROUP|ENTERPRISES|INVESTMENTS|REALTY|DEVELOPMENT|HOMES|CONDOMINIUM)\\b') THEN 'COMPANY'
    ELSE 'PERSON' END`;
}
