import type { TrackName } from "../sources.js";
import { runAppraisal } from "./appraisal.js";
import { runGeometry } from "./geometry.js";
import { runSales } from "./sales.js";
import type { TrackRunner } from "./types.js";

/** Implemented track runners. Tracks absent here are recorded as skipped with their limitations. */
export const TRACK_RUNNERS: Partial<Record<TrackName, TrackRunner>> = {
  appraisal: runAppraisal,
  sales: runSales,
  geometry: runGeometry,
};
