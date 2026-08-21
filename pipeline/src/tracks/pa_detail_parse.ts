import * as cheerio from "cheerio";

/**
 * Duval Property Appraiser Detail.aspx parser (paopropertysearch.coj.net/Basic/Detail.aspx?RE=...).
 * Selectors follow the existing Elephant transform (vendor/duval-transform): property header
 * (#ctl00_cphBody_lblRealEstateNumber, lblPrimarySiteAddressLine*), owner block (#ownerName h2 span,
 * #ownerName .data li span), building repeater (repeaterBuilding_ctlNN_lblBuildingType / lblYearBuilt,
 * gridBuildingArea "Total" row, gridBuildingElements rows Exterior Wall / Roof Struct / Roofing Cover),
 * and the sales grid (#ctl00_cphBody_gridSalesHistory: book/page, date, price, deed instrument, qualified, vacant/improved).
 */
export interface PaBuilding {
  building_no: number;
  building_type: string | null;
  actual_year_built: number | null;
  roof_structure: string | null;
  roofing_cover: string | null;
  exterior_wall: string | null;
  heated_area_sqft: number | null;
  gross_area_sqft: number | null;
  effective_area_sqft: number | null;
  elements: Record<string, string[]>;
}

export interface PaSale {
  book_page: string | null;
  or_book: string | null;
  or_page: string | null;
  document_url: string | null;
  sale_date: string | null;
  sale_price: number | null;
  deed_instrument: string | null;
  qualified: string | null;
  vacant_improved: string | null;
}

export interface PaDetail {
  re: string | null;
  site_address: string | null;
  site_address_line2: string | null;
  owner_name: string | null;
  mailing_lines: string[];
  property_use: string | null;
  subdivision: string | null;
  total_area: string | null;
  number_of_buildings: number | null;
  buildings: PaBuilding[];
  sales: PaSale[];
  /** true when the page looks like a real detail page (RE number found) */
  ok: boolean;
}

const clean = (s: string | undefined | null): string | null => {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length === 0 ? null : t;
};
const num = (s: string | null): number | null => {
  if (s === null) return null;
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && s.replace(/[^0-9]/g, "").length > 0 ? n : null;
};
const usDate = (s: string | null): string | null => {
  if (s === null) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}` : null;
};

export function parsePaDetail(html: string): PaDetail {
  const $ = cheerio.load(html);
  const re = clean($("#ctl00_cphBody_lblRealEstateNumber").text());
  const site = clean($("#ctl00_cphBody_lblPrimarySiteAddressLine1").text()) ?? clean($("#ctl00_cphBody_lblHeaderPropertyAddress").text());
  const site2 = clean($("#ctl00_cphBody_lblPrimarySiteAddressLine2").text());
  const owner = clean($("#ownerName h2 span").first().text()) ?? clean($("#ctl00_cphBody_repeaterOwnerInformation_ctl00_lblOwnerName").text());
  const mailing: string[] = [];
  $("#ownerName .data li span").each((_, el) => {
    const t = clean($(el).text());
    if (t) mailing.push(t);
  });

  const buildings: PaBuilding[] = [];
  $("[id^='ctl00_cphBody_repeaterBuilding_ctl'][id$='_lblBuildingNumber']").each((_, el) => {
    const id = String($(el).attr("id"));
    const prefix = id.replace(/_lblBuildingNumber$/, "");
    const label = clean($(el).text());
    const noMatch = label ? /(\d+)/.exec(label) : null;
    const building_no = noMatch ? Number(noMatch[1]) : buildings.length + 1;
    const elements: Record<string, string[]> = {};
    $(`#${prefix}_gridBuildingElements tr`).each((i, tr) => {
      if (i === 0) return;
      const tds = $(tr).find("td");
      const name = clean($(tds[0]).text());
      const detail = clean($(tds[2]).text()) ?? clean($(tds[1]).text());
      if (name && detail) (elements[name] ??= []).push(detail);
    });
    let heated: number | null = null;
    let gross: number | null = null;
    let effective: number | null = null;
    $(`#${prefix}_gridBuildingArea tr`).each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length >= 4 && /^total$/i.test(clean($(tds[0]).text()) ?? "")) {
        gross = num(clean($(tds[1]).text()));
        heated = num(clean($(tds[2]).text()));
        effective = num(clean($(tds[3]).text()));
      }
    });
    const first = (k: string) => elements[k]?.[0] ?? null;
    buildings.push({
      building_no,
      building_type: clean($(`#${prefix}_lblBuildingType`).text()),
      actual_year_built: num(clean($(`#${prefix}_lblYearBuilt`).text())),
      roof_structure: first("Roof Struct"),
      roofing_cover: first("Roofing Cover"),
      exterior_wall: elements["Exterior Wall"] ? elements["Exterior Wall"].join("; ") : null,
      heated_area_sqft: heated,
      gross_area_sqft: gross,
      effective_area_sqft: effective,
      elements,
    });
  });

  const sales: PaSale[] = [];
  $("#ctl00_cphBody_gridSalesHistory tr").each((i, tr) => {
    if (i === 0) return;
    const tds = $(tr).find("td");
    if (tds.length < 4) return;
    const bookPage = clean($(tds[0]).text());
    const href = $(tds[0]).find("a").attr("href") ?? null;
    const bp = bookPage ? /(\d+)\s*[-/]\s*(\d+)/.exec(bookPage) : null;
    sales.push({
      book_page: bookPage,
      or_book: bp ? (bp[1] as string) : null,
      or_page: bp ? (bp[2] as string) : null,
      document_url: href,
      sale_date: usDate(clean($(tds[1]).text())),
      sale_price: num(clean($(tds[2]).text())),
      deed_instrument: clean($(tds[3]).text()),
      qualified: tds.length > 4 ? clean($(tds[4]).text()) : null,
      vacant_improved: tds.length > 5 ? clean($(tds[5]).text()) : null,
    });
  });

  return {
    re,
    site_address: site,
    site_address_line2: site2,
    owner_name: owner,
    mailing_lines: mailing,
    property_use: clean($("#ctl00_cphBody_lblPropertyUse").text()),
    subdivision: clean($("#ctl00_cphBody_lblSubdivision").text()),
    total_area: clean($("#ctl00_cphBody_lblTotalArea").text()),
    number_of_buildings: num(clean($("#ctl00_cphBody_lblNumberOfBuildings").text())),
    buildings,
    sales,
    ok: re !== null,
  };
}

/** Roof covering material text -> lexicon-ish value used for the canonical roof_covering_material column. */
export function normalizeRoofCover(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.replace(/^\d+\s*/, "").trim();
  return t.length === 0 ? null : t;
}
