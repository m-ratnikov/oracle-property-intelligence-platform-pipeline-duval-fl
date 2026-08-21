/**
 * Whether a coverage row describes an ingested source, or a source the pipeline could not reach.
 *
 * The published `dataset-coverage.json` is honest about the sources that did not land. The permits
 * track records `ingested_count: 0` with `implemented: true`, `constrained: true`, a `reason`
 * naming the Akamai WAF in front of JaxEPICS, and three limitation strings describing exactly what
 * was tried. The Data page then rendered that row through the same arithmetic as every other one
 * and printed a coverage meter, so the most honest row in the artifact read as the tidiest.
 *
 * The flags are already in the data. This module lifts them out of the raw snapshot, because the
 * shared `parseCoverage` type carries only the counts, and turns them into the one thing the table
 * needs to know: can this row's ingested / expected pair be read as coverage at all, and if not,
 * what does the pipeline say happened instead.
 */

import { isRecord, num, str } from "./types";

export type CoverageState =
  /** Rows landed. ingested / expected is a real ratio. */
  | "ingested"
  /** Implemented and attempted, but the source itself blocks collection. Nothing landed. */
  | "blocked"
  /** Registered in the source catalog, deliberately not implemented yet. Nothing landed. */
  | "not-implemented"
  /** Implemented, not blocked, and still empty. Neither excused nor explained away. */
  | "empty";

export interface SourceStatus {
  source: string;
  state: CoverageState;
  implemented: boolean;
  constrained: boolean;
  /** The pipeline's own one line explanation for a constrained source. */
  reason: string | null;
  /** Why the most recent run skipped the track, where one did. */
  lastSkipReason: string | null;
  requiresUsEgress: boolean;
  limitations: string[];
  ingested: number;
  expected: number | null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry)).filter((entry): entry is string => entry !== null);
}

function stateOf(ingested: number, implemented: boolean, constrained: boolean): CoverageState {
  if (ingested > 0) return "ingested";
  if (constrained) return "blocked";
  if (!implemented) return "not-implemented";
  return "empty";
}

/**
 * `expected_count` is only a denominator when the source published a total to compare against.
 *
 * A blocked source reports `expected_count: 0`, because the last completed run staged zero rows
 * from it. Dividing 0 by 0 is not 100 percent coverage; it is an absence of any measurement, and
 * the table has to say so rather than print a number.
 */
export function hasComparableExpected(status: SourceStatus | undefined, expected: number | null): boolean {
  if (expected === null || expected === 0) return false;
  return status === undefined || status.state === "ingested";
}

/** Every constraint the coverage snapshot records, keyed by the `source` the table renders. */
export function parseCoverageStatuses(input: unknown): Map<string, SourceStatus> {
  const statuses = new Map<string, SourceStatus>();
  if (!isRecord(input)) return statuses;
  const datasets = input.datasets;
  if (!Array.isArray(datasets)) return statuses;

  for (const entry of datasets) {
    if (!isRecord(entry)) continue;
    const source = str(entry.source);
    if (source === null) continue;
    const ingested = num(entry.ingested_count) ?? 0;
    // `implemented` defaults to true: a row that does not say otherwise was attempted, and
    // assuming the opposite would excuse an empty table the pipeline never explained.
    const implemented = entry.implemented === undefined ? true : entry.implemented === true;
    const constrained = entry.constrained === true;
    statuses.set(source, {
      source,
      state: stateOf(ingested, implemented, constrained),
      implemented,
      constrained,
      reason: str(entry.reason),
      lastSkipReason: str(entry.last_skip_reason),
      requiresUsEgress: entry.requires_us_egress === true,
      limitations: strList(entry.limitations),
      ingested,
      expected: num(entry.expected_count),
    });
  }
  return statuses;
}

/** Everything the pipeline recorded about why a source carries no rows, deduplicated and ordered. */
export function blockedReasons(status: SourceStatus): string[] {
  const lines: string[] = [];
  const push = (line: string | null) => {
    const trimmed = line?.trim();
    if (trimmed && !lines.includes(trimmed)) lines.push(trimmed);
  };
  push(status.reason);
  push(status.lastSkipReason);
  for (const limitation of status.limitations) push(limitation);
  return lines;
}

export const STATE_LABEL: Record<CoverageState, string> = {
  ingested: "ingested",
  blocked: "source blocked",
  "not-implemented": "not implemented",
  empty: "no rows",
};

export const STATE_BADGE: Record<CoverageState, string> = {
  ingested: "badge badge-good",
  blocked: "badge badge-bad",
  "not-implemented": "badge badge-neutral",
  empty: "badge badge-warn",
};

/** The sources a reviewer should be told about up front: everything that carries no rows. */
export function unavailableSources(statuses: Map<string, SourceStatus>): SourceStatus[] {
  return [...statuses.values()].filter((status) => status.state !== "ingested");
}
