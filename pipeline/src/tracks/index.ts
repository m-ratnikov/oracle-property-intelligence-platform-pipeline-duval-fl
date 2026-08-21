import type { TrackName } from "../sources.js";
import { runAppraisal } from "./appraisal.js";
import { runBusinesses } from "./businesses.js";
import { runCojAddresses } from "./coj_addresses.js";
import { runCojParcels } from "./coj_parcels.js";
import { runContractors } from "./contractors.js";
import { runGeometry } from "./geometry.js";
import { runLinks } from "./links.js";
import { runPaDetail } from "./pa_detail.js";
import { runPermits } from "./permits.js";
import { runPlaces } from "./places.js";
import { runSales } from "./sales.js";
import { runTransit } from "./transit.js";
import type { TrackRunner } from "./types.js";
import { runWater } from "./water.js";

/** Implemented track runners. Tracks absent here are recorded as skipped with their limitations. */
export const TRACK_RUNNERS: Partial<Record<TrackName, TrackRunner>> = {
  appraisal: runAppraisal,
  sales: runSales,
  geometry: runGeometry,
  transit: runTransit,
  water: runWater,
  places: runPlaces,
  businesses: runBusinesses,
  links: runLinks,
  coj_parcels: runCojParcels,
  coj_addresses: runCojAddresses,
  contractors: runContractors,
  permits: runPermits,
  pa_detail: runPaDetail,
};
