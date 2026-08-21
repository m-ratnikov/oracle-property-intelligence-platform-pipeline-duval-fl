import { envOrDefault } from "./config.js";

/** Track names the orchestrator understands. Tracks not implemented yet are still registered so
 *  run_log records them as skipped with their source limitations (honest coverage). */
export type TrackName =
  | "appraisal"
  | "sales"
  | "geometry"
  | "permits"
  | "contractors"
  | "businesses"
  | "places"
  | "transit"
  | "water"
  | "addresses";

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
  /** Known constraints, copied into run_log.limitations as data. */
  limitations: string[];
}

const FDOR = "https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal";

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
    limitations: [
      "FDOR posts only the current roll type; prior years by email request",
      "No roof attributes in the bulk roll (ACT_YR_BLT/EFF_YR_BLT used as roof-age proxy)",
      "Sale history limited to the two most recent sales per parcel (SALE_*1/2)",
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
    limitations: [
      "Sale dates carry year+month only (day unknown; stored as first of month)",
      "Monthly PA sales files (jacksonville.gov data offerings) rotate GUID URLs and are US-egress only; not yet wired",
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
    limitations: [
      "192 MB archive; centroids computed from polygons (not rooftop points)",
      "Parcels present in NAL but missing from the shapefile get no coordinates",
    ],
  },
  permits: {
    track: "permits",
    coverageSource: "permits",
    sourceSystem: "coj_jaxepics",
    title: "City of Jacksonville JaxEPICS permit pages",
    url: "https://jaxepics.coj.net/Permit/View/",
    format: "html/json (undocumented SPA API)",
    cadence: "continuous; enumerated by permit number in bounded windows",
    targetTable: "permits",
    implemented: false,
    limitations: [
      "No open-data permit layer found; search/reports require login",
      "US egress only (COJ hosts block non-US and cloud IPs)",
      "Enumeration only (B-YY-nnnnnn.nnn); concurrency kept at 2; throughput to be measured",
    ],
  },
  contractors: {
    track: "contractors",
    coverageSource: "contractors",
    sourceSystem: "dbpr_cilb",
    title: "Florida DBPR CILB licensee extracts (statewide, filtered to Duval)",
    url: "https://www2.myfloridalicense.com/sto/file_download/extracts/cilb_certified.csv",
    format: "csv",
    cadence: "weekly",
    targetTable: "contractors",
    implemented: false,
    limitations: [
      "Cloudflare JS challenge; needs a headless browser fetch step",
      "BBB not used: terms forbid aggregation",
    ],
  },
  businesses: {
    track: "businesses",
    coverageSource: "sunbiz",
    sourceSystem: "sunbiz",
    title: "Florida Division of Corporations (Sunbiz) daily corporate files",
    url: "sftp://sftp.floridados.gov/doc/cor/",
    format: "fixed-length 1440-char records",
    cadence: "daily deltas; quarterly full (1.8 GB)",
    targetTable: "businesses",
    implemented: false,
    limitations: ["No county filter; filtered on Jacksonville/Duval ZIPs", "SFTP host key must be trusted"],
  },
  places: {
    track: "places",
    coverageSource: "places",
    sourceSystem: "overture_places",
    title: "Overture Maps Places (Duval bbox)",
    url: "s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/",
    format: "geoparquet",
    cadence: "monthly releases",
    targetTable: "places",
    implemented: false,
    limitations: ["Brand matching by name (Starbucks); confidence varies"],
  },
  transit: {
    track: "transit",
    coverageSource: "transit",
    sourceSystem: "jta_gtfs",
    title: "JTA GTFS static feed",
    url: "https://ride.jtafla.com/gtfs-archive/gtfs.zip",
    format: "gtfs zip",
    cadence: "irregular releases; poll ETag/Last-Modified",
    targetTable: "transit_stops",
    implemented: false,
    limitations: ["No GTFS-RT; no licence text published"],
  },
  water: {
    track: "water",
    coverageSource: "hydrography",
    sourceSystem: "coj_hydrography",
    title: "COJ St Johns River / Jax_River polygons + USGS NHD",
    url: "https://services1.arcgis.com/NXfNVaFp7QMxnE3j/arcgis/rest/services/stjohnsriver/FeatureServer/0",
    format: "arcgis feature service",
    cadence: "static",
    targetTable: "water_bodies",
    implemented: false,
    limitations: ["Water view is a proximity proxy (distance to water polygon), not a sightline analysis"],
  },
  addresses: {
    track: "addresses",
    coverageSource: "addresses",
    sourceSystem: "coj_address_points",
    title: "COJ address points (ERAT MapServer layer 41)",
    url: "https://maps.coj.net/coj/rest/services/ERAT/EratDashboard_3000/MapServer/41/query",
    format: "arcgis mapserver",
    cadence: "continuous (EDIT_DATE)",
    targetTable: "address_points",
    implemented: false,
    limitations: ["US egress only (COJ hosts block non-US and cloud IPs)"],
  },
};

export const ALL_TRACKS = Object.keys(SOURCES) as TrackName[];
export const DEFAULT_TRACKS: TrackName[] = ["appraisal", "sales", "geometry"];

export function parseTracks(raw: string | undefined): TrackName[] {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "default") return DEFAULT_TRACKS;
  if (raw.trim() === "all") return ALL_TRACKS;
  const out: TrackName[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const t = trimmed as TrackName;
    if (!(t in SOURCES)) throw new Error(`Unknown track "${t}". Known: ${ALL_TRACKS.join(", ")}`);
    out.push(t);
  }
  return out;
}
