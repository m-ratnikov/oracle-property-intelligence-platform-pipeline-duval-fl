import { envOrDefault } from "./config.js";

/** Track names the orchestrator understands. Tracks not implemented yet are still registered so
 *  run_log records them as skipped with their source limitations (honest coverage). */
export type TrackName =
  | "appraisal"
  | "sales"
  | "geometry"
  | "transit"
  | "water"
  | "places"
  | "businesses"
  | "links"
  | "coj_parcels"
  | "coj_addresses"
  | "contractors"
  | "permits"
  | "pa_detail";

export interface SourceDef {
  track: TrackName;
  /** Elephant coverage-row source name (appraisal, permits, sunbiz, bbb, ...). */
  coverageSource: string;
  sourceSystem: string;
  title: string;
  url: string;
  format: string;
  cadence: string;
  targetTable: string;
  implemented: boolean;
  /** Source only answers from a US IP (COJ / DBPR hosts). Locally the track is skipped with the probe result. */
  requiresUsEgress: boolean;
  /** Small GET used to decide egress availability before a US-only track runs. */
  probeUrl?: string;
  /** Known total in the source when published by the source itself (used as coverage expected_count fallback). */
  knownExpectedCount?: number;
  /**
   * SQL predicate selecting the rows this track owns. Set only where `targetTable` is written by
   * more than one track: coverage then scopes `ingested_count` and the load window to it, so the
   * numerator and the denominator (this track's `rows_staged`) describe the same track. Unset means
   * the track owns every row in the table, which is the case for every other source.
   */
  ownedRowsFilter?: string;
  /** Known constraints, copied into run_log.limitations as data. */
  limitations: string[];
}

/**
 * `sales_history` is written by two tracks: `sales` loads the FDOR SDF file and folds in the NAL
 * roll sale columns, and `pa_detail` folds in sales read off the Duval PA detail pages. The
 * `sale_source` column records which of them wrote a row, so coverage can scope each track to its
 * own rows instead of comparing a whole-table count against one track's staged rows.
 */
export const SALES_TRACK_SALE_SOURCES = ["SDF", "NAL_SALE1", "NAL_SALE2"] as const;
export const PA_DETAIL_SALE_SOURCE = "PA_DETAIL";

const FDOR = "https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal";
export const COJ_PARCELS_URL = "https://maps.coj.net/coj/rest/services/CityBiz/Parcels/MapServer/0/query";
export const COJ_ADDRESSES_URL = "https://maps.coj.net/coj/rest/services/ERAT/EratDashboard_3000/MapServer/41/query";
export const DUVAL_BBOX = { minLon: -82.05, maxLon: -81.3, minLat: 30.1, maxLat: 30.6 } as const;

export const SOURCES: Record<TrackName, SourceDef> = {
  appraisal: {
    track: "appraisal",
    coverageSource: "appraisal",
    sourceSystem: "duval_appraiser",
    title: "FDOR NAL 2026 Preliminary - Duval (county 26)",
    url: envOrDefault(
      "SOURCE_URL_NAL",
      `${FDOR}/Tax%20Roll%20Data%20Files/NAL/2026P/Duval%2026%20Preliminary%20NAL%202026.zip`,
    ),
    format: "zip(csv)",
    cadence: "annual roll (prelim Jul, final Oct); only the current roll is posted",
    targetTable: "parcels",
    implemented: true,
    requiresUsEgress: false,
    limitations: [
      "FDOR posts only the current roll type; prior years by email request",
      "No roof attributes in the bulk roll (ACT_YR_BLT/EFF_YR_BLT used as roof-age proxy)",
      "Sale fields cover only the roll's current and prior year (2025-2026)",
    ],
  },
  sales: {
    track: "sales",
    coverageSource: "sales",
    sourceSystem: "fdor_sdf",
    title: "FDOR SDF 2026 Preliminary - Duval (sales data file)",
    url: envOrDefault(
      "SOURCE_URL_SDF",
      `${FDOR}/Tax%20Roll%20Data%20Files/SDF/2026P/Duval%2026%20Preliminary%20SDF%202026.zip`,
    ),
    format: "zip(csv)",
    cadence: "annual (prior year + YTD); NAL SALE_*1/2 folded in",
    targetTable: "sales_history",
    implemented: true,
    requiresUsEgress: false,
    ownedRowsFilter: `sale_source IN (${SALES_TRACK_SALE_SOURCES.map((v) => `'${v}'`).join(", ")})`,
    limitations: [
      "Sale dates carry year+month only (day unknown; stored as first of month)",
      "Only 2025-2026 transfers; older tenure comes from the COJ parcels layer (SALESL*)",
    ],
  },
  geometry: {
    track: "geometry",
    coverageSource: "geometry",
    sourceSystem: "fdor_par",
    title: "FDOR parcel shapefile 2026 - Duval (PAR)",
    url: envOrDefault("SOURCE_URL_PAR", `${FDOR}/Map%20Data/2026F/2026F%20PAR/duval_2026Ppar.zip`),
    format: "zip(shapefile)",
    cadence: "annual (collected Apr, published Aug)",
    targetTable: "parcel_geometry",
    implemented: true,
    requiresUsEgress: false,
    limitations: [
      "192 MB archive; centroids computed from polygons (not rooftop points)",
      "Parcels present in NAL but missing from the shapefile get no coordinates",
    ],
  },
  transit: {
    track: "transit",
    coverageSource: "transit",
    sourceSystem: "jta_gtfs",
    title: "JTA GTFS static feed (stops, routes, stop_times)",
    url: envOrDefault("SOURCE_URL_GTFS", "https://ride.jtafla.com/gtfs-archive/gtfs.zip"),
    format: "gtfs zip",
    cadence: "irregular releases (redirect to a dated media file); ETag/Last-Modified polled",
    targetTable: "transit_stops",
    implemented: true,
    requiresUsEgress: false,
    knownExpectedCount: 2501,
    limitations: ["No GTFS-RT; no licence text published", "Walking distance is straight-line (haversine), not network distance"],
  },
  water: {
    track: "water",
    coverageSource: "hydrography",
    sourceSystem: "coj_nhd_hydrography",
    title: "COJ St Johns River + Jax_River polygons (AGO) and USGS NHD HU4 0307 (waterbody, area, flowline)",
    url: "https://services1.arcgis.com/NXfNVaFp7QMxnE3j/arcgis/rest/services/stjohnsriver/FeatureServer/0",
    format: "arcgis geojson + filegdb (zip)",
    cadence: "static (NHD retired 2023); AGO layers refreshed by COJ",
    targetTable: "water_bodies",
    implemented: true,
    requiresUsEgress: false,
    limitations: [
      "Water view is a proximity proxy (centroid within 150 m of a mapped shoreline vertex, or parcel bbox within 30 m), not a sightline analysis; distances beyond ~1 km are not computed",
      "NHD lake/pond polygons below 1 ha and unnamed flowlines are excluded",
      "Parcel polygons are not stored; the parcel bounding box stands in for the polygon",
    ],
  },
  places: {
    track: "places",
    coverageSource: "places",
    sourceSystem: "overture_places",
    title: "Overture Maps Places release 2026-08-19.0 (Duval bbox; coffee, grocery, pharmacy, school, hospital, restaurant)",
    url: envOrDefault("SOURCE_URL_OVERTURE", "s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*"),
    format: "geoparquet (DuckDB httpfs, anonymous)",
    cadence: "monthly releases; GERS ids stable across releases",
    targetTable: "places",
    implemented: true,
    requiresUsEgress: false,
    limitations: ["Brand matching by name (Starbucks); confidence varies; CDLA-Permissive 2.0", "Reading the release scans ~2.5 min of remote parquet"],
  },
  businesses: {
    track: "businesses",
    coverageSource: "sunbiz",
    sourceSystem: "sunbiz",
    title: "Florida Division of Corporations (Sunbiz) daily corporate files (SFTP, public credentials)",
    url: "sftp://sftp.floridados.gov/doc/cor/",
    format: "fixed-length 1440-char records (daily deltas) + Events",
    cadence: "daily; window of N days per run, processed files journaled",
    targetTable: "businesses",
    implemented: true,
    requiresUsEgress: false,
    limitations: [
      "No county filter: rows kept when principal/mailing ZIP starts with 322 or city starts with JACKSONVILLE",
      "Layout page (dos.sunbiz.org/data-definitions/cor.html) was unreachable (HTTP 522); offsets validated against live records instead",
      "Officers kept as names only; events file parsed for doc number + raw line",
    ],
  },
  links: {
    track: "links",
    coverageSource: "entity_links",
    sourceSystem: "duval_reconciliation",
    title: "Entity reconciliation: owners (name + mailing hash), business <-> parcel links",
    url: "derived",
    format: "derived",
    cadence: "every run after the source tracks",
    targetTable: "entity_links",
    implemented: true,
    requiresUsEgress: false,
    limitations: ["Address matching is exact on the normalized line 1 + ZIP5; unit-level mismatches are not linked"],
  },
  coj_parcels: {
    track: "coj_parcels",
    coverageSource: "coj_parcels",
    sourceSystem: "coj_parcels",
    title: "City of Jacksonville parcel layer (CityBiz/Parcels MapServer 0): last sale date, flood zone, zoning",
    url: COJ_PARCELS_URL,
    format: "arcgis rest json (2000/page)",
    cadence: "at least monthly; full paged pull, idempotent by RE hash",
    targetTable: "coj_parcels",
    implemented: true,
    requiresUsEgress: true,
    probeUrl: `${COJ_PARCELS_URL}?where=1%3D1&returnCountOnly=true&f=json`,
    knownExpectedCount: 407986,
    limitations: ["US egress only (COJ hosts block non-US and cloud IPs)", "Paged at 2000 rows, concurrency 2, 250 ms delay"],
  },
  coj_addresses: {
    track: "coj_addresses",
    coverageSource: "addresses",
    sourceSystem: "coj_address_points",
    title: "COJ address points (ERAT MapServer layer 41), incremental by EDIT_DATE",
    url: COJ_ADDRESSES_URL,
    format: "arcgis rest json (2000/page)",
    cadence: "continuous (EDIT_DATE >= last run)",
    targetTable: "address_points",
    implemented: true,
    requiresUsEgress: true,
    probeUrl: `${COJ_ADDRESSES_URL}?where=1%3D1&returnCountOnly=true&f=json`,
    knownExpectedCount: 671814,
    limitations: ["US egress only (COJ hosts block non-US and cloud IPs)", "First run is a full paged pull; later runs filter EDIT_DATE"],
  },
  contractors: {
    track: "contractors",
    coverageSource: "contractors",
    sourceSystem: "dbpr_cilb",
    title: "Florida DBPR CILB licensee extracts (certified + registered), filtered to Duval",
    url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_certified.csv",
    format: "csv (statewide, ~750 MB certified)",
    cadence: "weekly",
    targetTable: "contractors",
    implemented: true,
    requiresUsEgress: true,
    probeUrl: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_registered.csv",
    limitations: [
      "HTTP 403 from non-US IPs; from a US runner with a browser UA the files download",
      "BBB not used: terms forbid aggregation",
    ],
  },
  permits: {
    track: "permits",
    coverageSource: "permits",
    sourceSystem: "coj_jaxepics",
    title: "City of Jacksonville JaxEPICS permits (bounded enumeration of permit numbers)",
    url: "https://jaxepics.coj.net/Permit/View/",
    format: "html shell + json api (discovered at run time)",
    cadence: "continuous; --window permits per run; cursor journaled",
    targetTable: "permits",
    implemented: true,
    requiresUsEgress: true,
    probeUrl: "https://jaxepics.coj.net/Permit/View/B-25-279425.000",
    limitations: [
      "Constrained source: JaxEPICS API behind Akamai WAF (HTTP 403 Access Denied on every /api guess, browser UA included); search/reports require login; no open permit dataset; public-records request is the documented path",
      "US egress only; one cheap discovery + probe per run is kept as evidence (status codes recorded); enumeration runs only when a probe returns JSON",
      "Angular shell loads chunks dynamically, so static literal discovery finds no API paths",
    ],
  },
  pa_detail: {
    track: "pa_detail",
    coverageSource: "pa_detail",
    sourceSystem: "duval_pa_detail",
    title: "Duval Property Appraiser Detail.aspx pages (seed order, bounded window, lexicon transform)",
    url: "https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=",
    format: "html (ASP.NET); vendored Elephant transform -> lexicon JSON",
    cadence: "continuous; --window parcels per run from a persistent seed cursor",
    targetTable: "pa_detail_buildings",
    implemented: true,
    requiresUsEgress: true,
    probeUrl: "https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=0020608295R",
    knownExpectedCount: 398324,
    limitations: [
      "US egress only (paopropertysearch.coj.net blocks non-US and cloud IPs); concurrency 2, 400 ms delay",
      "Slow source by design: ~300 pages per run; full seed (398,324 parcels) needs many runs; throughput recorded per run",
      "Lexicon transform runs the vendored Elephant scripts per page; owners/*.json prerequisites come from the mapping scripts on the same page",
    ],
  },
};

export const ALL_TRACKS = Object.keys(SOURCES) as TrackName[];
/** Tracks every scheduled run executes (US-only ones self-skip outside the US). */
export const DEFAULT_TRACKS: TrackName[] = [
  "appraisal", "sales", "geometry", "transit", "water", "places", "businesses",
  "coj_parcels", "coj_addresses", "contractors", "permits", "pa_detail", "links",
];
/** Reachable from anywhere. */
export const LOCAL_TRACKS: TrackName[] = ["appraisal", "sales", "geometry", "transit", "water", "places", "businesses", "links"];

export function parseTracks(raw: string | undefined): TrackName[] {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "default") return DEFAULT_TRACKS;
  if (raw.trim() === "all") return ALL_TRACKS;
  if (raw.trim() === "local") return LOCAL_TRACKS;
  const out: TrackName[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const t = trimmed as TrackName;
    if (!(t in SOURCES)) throw new Error(`Unknown track "${t}". Known: ${ALL_TRACKS.join(", ")}`);
    out.push(t);
  }
  // links always last so it sees this run's loads
  if (out.includes("links")) return [...out.filter((t) => t !== "links"), "links"];
  return out;
}
