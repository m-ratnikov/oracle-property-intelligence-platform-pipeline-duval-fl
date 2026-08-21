import { getJson, mapLimit } from "./http.js";

/** ArcGIS REST `query` paging with resultOffset / resultRecordCount (MapServer and FeatureServer). */
export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: unknown;
}

export interface ArcgisPage {
  features: ArcgisFeature[];
  exceededTransferLimit: boolean;
  status: number;
  error: string | null;
}

export interface ArcgisQueryOptions {
  baseUrl: string;
  where: string;
  outFields: string;
  pageSize?: number;
  returnGeometry?: boolean;
  outSR?: number;
  orderByFields?: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  delayMs?: number;
  /** Hard cap on pages per run (bounded windows). */
  maxPages?: number;
  onPage?: (info: { page: number; rows: number; status: number }) => void;
}

export function buildQueryUrl(o: ArcgisQueryOptions, offset: number): string {
  const params = new URLSearchParams({
    where: o.where,
    outFields: o.outFields,
    returnGeometry: String(o.returnGeometry ?? false),
    f: "json",
    resultOffset: String(offset),
    resultRecordCount: String(o.pageSize ?? 2000),
  });
  if (o.outSR !== undefined) params.set("outSR", String(o.outSR));
  if (o.orderByFields) params.set("orderByFields", o.orderByFields);
  return `${o.baseUrl}?${params.toString()}`;
}

export async function fetchArcgisPage(o: ArcgisQueryOptions, offset: number): Promise<ArcgisPage> {
  const r = await getJson<{ features?: ArcgisFeature[]; exceededTransferLimit?: boolean; error?: { code: number; message: string } }>(
    buildQueryUrl(o, offset),
    { fetchImpl: o.fetchImpl, retries: 3, timeoutMs: 120_000 },
  );
  if (!r.ok || r.body === null) {
    return { features: [], exceededTransferLimit: false, status: r.status, error: r.error ?? "no body" };
  }
  if (r.body.error) {
    return { features: [], exceededTransferLimit: false, status: r.status, error: `${r.body.error.code} ${r.body.error.message}` };
  }
  return { features: r.body.features ?? [], exceededTransferLimit: Boolean(r.body.exceededTransferLimit), status: r.status, error: null };
}

export async function fetchArcgisCount(baseUrl: string, where: string, fetchImpl?: typeof fetch): Promise<number | null> {
  const params = new URLSearchParams({ where, returnCountOnly: "true", f: "json" });
  const r = await getJson<{ count?: number }>(`${baseUrl}?${params.toString()}`, { fetchImpl, retries: 2 });
  return r.ok && r.body && typeof r.body.count === "number" ? r.body.count : null;
}

/**
 * Page through a layer. Offsets are computed from the total count (when available) so pages can be
 * fetched with bounded concurrency; otherwise pages are fetched sequentially until
 * exceededTransferLimit is false / an empty page is returned.
 */
export async function fetchArcgisAll(o: ArcgisQueryOptions): Promise<{ features: ArcgisFeature[]; pages: number; errors: string[]; total: number | null }> {
  const pageSize = o.pageSize ?? 2000;
  const errors: string[] = [];
  const total = await fetchArcgisCount(o.baseUrl, o.where, o.fetchImpl);
  const maxPages = o.maxPages ?? Number.POSITIVE_INFINITY;
  if (total !== null) {
    const pageCount = Math.min(Math.ceil(total / pageSize), maxPages);
    const offsets = Array.from({ length: pageCount }, (_, i) => i * pageSize);
    const pages = await mapLimit(offsets, o.concurrency ?? 2, o.delayMs ?? 250, async (offset, i) => {
      const p = await fetchArcgisPage(o, offset);
      o.onPage?.({ page: i, rows: p.features.length, status: p.status });
      if (p.error) errors.push(`offset ${offset}: ${p.error}`);
      return p.features;
    });
    return { features: pages.flat(), pages: pageCount, errors, total };
  }
  const features: ArcgisFeature[] = [];
  let offset = 0;
  let page = 0;
  for (;;) {
    if (page >= maxPages) break;
    const p = await fetchArcgisPage(o, offset);
    o.onPage?.({ page, rows: p.features.length, status: p.status });
    if (p.error) {
      errors.push(`offset ${offset}: ${p.error}`);
      break;
    }
    features.push(...p.features);
    page += 1;
    if (!p.exceededTransferLimit || p.features.length === 0) break;
    offset += p.features.length;
  }
  return { features, pages: page, errors, total: null };
}

/** Epoch millis (ArcGIS date fields) -> ISO date string, or null. */
export function epochToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return new Date(v).toISOString();
}

/** Build an ArcGIS SQL date literal for `field >= ts`. */
export function arcgisDateWhere(field: string, iso: string): string {
  const ts = iso.replace("T", " ").slice(0, 19);
  return `${field} >= timestamp '${ts}'`;
}
