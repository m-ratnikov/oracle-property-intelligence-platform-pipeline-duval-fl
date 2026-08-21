/**
 * Pure, testable business rules shared by the TS side and the SQL feature builder. Every rule here
 * has an SQL twin below; the test suite evaluates both on the same fixtures.
 */

export type OwnerRegionClass = "LOCAL" | "REGIONAL" | "NATIONAL" | "FOREIGN";

/** ZIP5 codes inside Duval County (Jacksonville, the Beaches, Baldwin). 32259 is St Johns County. */
export const DUVAL_ZIP5 = new Set<string>([
  "32099",
  ...Array.from({ length: 58 }, (_, i) => String(32201 + i)).filter((z) => z !== "32259"),
  "32260",
  "32266",
  "32277",
]);

export const DUVAL_CITIES = new Set<string>([
  "JACKSONVILLE",
  "JAX",
  "JACKSONVILLE BEACH",
  "JAX BEACH",
  "JAX BCH",
  "ATLANTIC BEACH",
  "NEPTUNE BEACH",
  "BALDWIN",
  "MAYPORT",
]);

/** Southeast region used for REGIONAL (Florida outside Duval plus the neighbouring states). */
export const REGIONAL_STATES = new Set<string>(["FL", "GA", "SC", "AL"]);

export const US_STATE_CODES = new Set<string>([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP",
]);

export function zip5(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.trim().replace(/[^0-9]/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

/**
 * Owner region rule (documented in pipeline/README.md):
 *  LOCAL    mailing address in Duval County (ZIP5 in the Duval set, or a Duval city name when no ZIP)
 *  REGIONAL mailing state in FL/GA/SC/AL but not Duval
 *  NATIONAL any other US state / territory / military code
 *  FOREIGN  a non-US state code (NAL stores province or country codes there for foreign owners)
 *  null     no usable mailing state
 */
export function classifyOwnerRegion(input: {
  ownState: string | null | undefined;
  ownCity: string | null | undefined;
  ownZip: string | null | undefined;
}): OwnerRegionClass | null {
  const state = input.ownState?.trim().toUpperCase() ?? "";
  const city = input.ownCity?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  const zip = zip5(input.ownZip);
  if (state === "") return null;
  if (state === "FL") {
    if (zip !== null) return DUVAL_ZIP5.has(zip) ? "LOCAL" : "REGIONAL";
    return DUVAL_CITIES.has(city) ? "LOCAL" : "REGIONAL";
  }
  if (REGIONAL_STATES.has(state)) return "REGIONAL";
  if (US_STATE_CODES.has(state)) return "NATIONAL";
  return "FOREIGN";
}

/** SQL twin of {@link classifyOwnerRegion}. `p` is the parcels alias. */
export function ownerRegionSql(p: string): string {
  const zips = [...DUVAL_ZIP5].map((z) => `'${z}'`).join(",");
  const cities = [...DUVAL_CITIES].map((c) => `'${c}'`).join(",");
  const regional = [...REGIONAL_STATES].map((s) => `'${s}'`).join(",");
  const us = [...US_STATE_CODES].map((s) => `'${s}'`).join(",");
  const st = `upper(trim(${p}.own_state))`;
  const city = `regexp_replace(upper(trim(${p}.own_city)), '\\s+', ' ', 'g')`;
  const z5 = `CASE WHEN length(regexp_replace(coalesce(${p}.own_zipcd, ''), '[^0-9]', '', 'g')) >= 5 THEN left(regexp_replace(${p}.own_zipcd, '[^0-9]', '', 'g'), 5) END`;
  return `CASE
    WHEN ${st} IS NULL OR ${st} = '' THEN NULL
    WHEN ${st} = 'FL' THEN CASE
      WHEN ${z5} IS NOT NULL THEN CASE WHEN ${z5} IN (${zips}) THEN 'LOCAL' ELSE 'REGIONAL' END
      WHEN ${city} IN (${cities}) THEN 'LOCAL'
      ELSE 'REGIONAL' END
    WHEN ${st} IN (${regional}) THEN 'REGIONAL'
    WHEN ${st} IN (${us}) THEN 'NATIONAL'
    ELSE 'FOREIGN' END`;
}

/**
 * The only multi-owner signal the FDOR NAL roll carries.
 *
 * NAL publishes a single 30-character `OWN_NAME` per parcel and no co-owner column (`FIDU_NAME` is
 * a fiduciary, not a second owner, and is empty for all 404,023 Duval parcels). Where more owners
 * exist than the one it names, the roll appends "ET AL" (and others) or "ET UX" (and wife) to the
 * name. That marker is the whole of what the source says about additional owners: it tells you
 * that there are more, never how many. `owner_count` is therefore published NULL rather than
 * guessed; this flag publishes the signal that does exist.
 *
 * Splitting the name on "&" / " AND " is deliberately NOT used: the 30-character truncation strips
 * the entity suffix, so names like "SOUTHERN BELL TELEPHONE AND TE" or "C AND C FLOWERS AND
 * LANDSCAPIN" are indistinguishable from two co-owners.
 */
const ADDITIONAL_OWNER_MARKER = /\bET\s*(AL|UX)\b/;

/** true when the roll records owners beyond the one it names; null when there is no owner name. */
export function hasAdditionalOwners(ownerName: string | null | undefined): boolean | null {
  if (ownerName === null || ownerName === undefined) return null;
  return ADDITIONAL_OWNER_MARKER.test(ownerName.toUpperCase());
}

/** SQL twin of {@link hasAdditionalOwners}. */
export function hasAdditionalOwnersSql(col: string): string {
  return `CASE WHEN ${col} IS NULL THEN NULL ELSE regexp_matches(upper(${col}), '\\bET\\s*(AL|UX)\\b') END`;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Whole years elapsed between the last sale date and `asOf` (floor). null when no sale date. */
export function yearsSinceLastSale(saleDate: string | Date | null | undefined, asOf: Date): number | null {
  if (saleDate === null || saleDate === undefined) return null;
  const d = typeof saleDate === "string" ? new Date(`${saleDate}T00:00:00Z`) : saleDate;
  if (Number.isNaN(d.getTime())) return null;
  const years = (asOf.getTime() - d.getTime()) / MS_PER_YEAR;
  if (years < 0) return 0;
  return Math.floor(years);
}

/** SQL twin of {@link yearsSinceLastSale}; `asOf` is an ISO date literal YYYY-MM-DD. */
export function yearsSinceSql(saleDateExpr: string, asOf: string): string {
  return `CASE WHEN ${saleDateExpr} IS NULL THEN NULL
    ELSE greatest(0, floor(date_diff('day', ${saleDateExpr}, DATE '${asOf}') / 365.25))::INTEGER END`;
}

/** FDOR DOR use-code groups (Florida Department of Revenue land use code families). */
export function dorUseGroup(dorUc: string | null | undefined): string | null {
  if (dorUc === null || dorUc === undefined) return null;
  const n = Number.parseInt(dorUc.trim(), 10);
  if (Number.isNaN(n)) return null;
  if (n <= 9) return "RESIDENTIAL";
  if (n <= 39) return "COMMERCIAL";
  if (n <= 49) return "INDUSTRIAL";
  if (n <= 69) return "AGRICULTURAL";
  if (n <= 79) return "INSTITUTIONAL";
  if (n <= 89) return "GOVERNMENTAL";
  return "MISCELLANEOUS";
}

export function dorUseGroupSql(col: string): string {
  const n = `TRY_CAST(${col} AS INTEGER)`;
  return `CASE WHEN ${n} IS NULL THEN NULL WHEN ${n} <= 9 THEN 'RESIDENTIAL' WHEN ${n} <= 39 THEN 'COMMERCIAL'
    WHEN ${n} <= 49 THEN 'INDUSTRIAL' WHEN ${n} <= 69 THEN 'AGRICULTURAL' WHEN ${n} <= 79 THEN 'INSTITUTIONAL'
    WHEN ${n} <= 89 THEN 'GOVERNMENTAL' ELSE 'MISCELLANEOUS' END`;
}

/** FDOR use code descriptions (Florida DOR property use codes). */
export const DOR_USE_CODES: Record<string, string> = {
  "00": "Vacant Residential", "01": "Single Family", "02": "Mobile Homes", "03": "Multi-family 10 units or more",
  "04": "Condominiums", "05": "Cooperatives", "06": "Retirement Homes", "07": "Miscellaneous Residential",
  "08": "Multi-family less than 10 units", "09": "Residential Common Elements/Areas",
  "10": "Vacant Commercial", "11": "Stores, one story", "12": "Mixed use (store and office or residential)",
  "13": "Department Stores", "14": "Supermarkets", "15": "Regional Shopping Centers", "16": "Community Shopping Centers",
  "17": "Office buildings, one story", "18": "Office buildings, multi-story", "19": "Professional service buildings",
  "20": "Airports, bus terminals, marine terminals, piers", "21": "Restaurants, cafeterias", "22": "Drive-in restaurants",
  "23": "Financial institutions", "24": "Insurance company offices", "25": "Repair service shops", "26": "Service stations",
  "27": "Auto sales, repair, storage", "28": "Parking lots, mobile home parks", "29": "Wholesale outlets, produce houses",
  "30": "Florists, greenhouses", "31": "Drive-in theaters, open stadiums", "32": "Enclosed theaters, auditoriums",
  "33": "Nightclubs, bars", "34": "Bowling alleys, skating rinks, pool halls", "35": "Tourist attractions",
  "36": "Camps", "37": "Race tracks", "38": "Golf courses, driving ranges", "39": "Hotels, motels",
  "40": "Vacant Industrial", "41": "Light manufacturing", "42": "Heavy industrial", "43": "Lumber yards, sawmills",
  "44": "Packing plants", "45": "Canneries, bottlers, breweries", "46": "Other food processing", "47": "Mineral processing",
  "48": "Warehousing, distribution terminals", "49": "Open storage",
  "50": "Improved agricultural", "51": "Cropland soil capability class I", "52": "Cropland soil capability class II",
  "53": "Cropland soil capability class III", "54": "Timberland site index 90 and above", "55": "Timberland site index 80 to 89",
  "56": "Timberland site index 70 to 79", "57": "Timberland site index 60 to 69", "58": "Timberland site index 50 to 59",
  "59": "Timberland not classified by site index", "60": "Grazing land soil capability class I",
  "61": "Grazing land soil capability class II", "62": "Grazing land soil capability class III",
  "63": "Grazing land soil capability class IV", "64": "Grazing land soil capability class V",
  "65": "Grazing land soil capability class VI", "66": "Orchard groves, citrus", "67": "Poultry, bees, tropical fish",
  "68": "Dairies, feed lots", "69": "Ornamentals, miscellaneous agricultural",
  "70": "Vacant Institutional", "71": "Churches", "72": "Private schools and colleges", "73": "Privately owned hospitals",
  "74": "Homes for the aged", "75": "Orphanages, other non-profit", "76": "Mortuaries, cemeteries",
  "77": "Clubs, lodges, union halls", "78": "Sanitariums, convalescent and rest homes", "79": "Cultural organizations",
  "80": "Undefined / vacant governmental", "81": "Military", "82": "Forest, parks, recreational areas",
  "83": "Public county schools", "84": "Colleges", "85": "Hospitals", "86": "Counties", "87": "State", "88": "Federal",
  "89": "Municipal", "90": "Leasehold interests (government owned)", "91": "Utility", "92": "Mining, petroleum, gas lands",
  "93": "Subsurface rights", "94": "Right-of-way", "95": "Rivers, lakes, submerged lands", "96": "Sewage disposal, waste lands",
  "97": "Outdoor recreational, parkland", "98": "Centrally assessed", "99": "Acreage not zoned agricultural",
};
