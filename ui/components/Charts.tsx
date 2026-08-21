"use client";

import { formatInt, formatRatioPercent } from "@/lib/format";
import { STATE_BADGE, STATE_LABEL, type SourceStatus } from "@/lib/coverageStatus";

/**
 * Hand rolled SVG meters for the coverage tables. A charting library would be several
 * hundred kilobytes for two small pictures, and these need to be readable in both themes
 * without a runtime theme provider, so they use currentColor and CSS variables.
 *
 * The run history charts live in RunCharts.tsx. The per source sparkline grid that used to
 * sit here was removed: it plotted a cumulative-inserts figure under the label "rows that
 * source has contributed in total", which disagreed with the table totals the Data page
 * shows for the same source, and its own caption conceded that most of its panels were flat.
 */

/**
 * Rows in the same target table that a different pipeline track wrote. The ingested count beside the
 * bar is scoped to the source that owns the row, so without this line those rows would be invisible
 * rather than merely uncounted.
 */
function OtherTrackRows({
  rows,
  bySource,
}: {
  rows: number | null | undefined;
  bySource: Record<string, number> | null | undefined;
}) {
  if (rows === null || rows === undefined || rows <= 0) return null;
  const names = Object.keys(bySource ?? {});
  const label = `+${formatInt(rows)} rows from other sources${names.length > 0 ? ` (${names.join(", ")})` : ""}`;
  return <div className="mt-1 text-[11.5px] text-muted">{label}</div>;
}

/**
 * A source that carries no rows, rendered as the thing it is.
 *
 * This is the case the whole component exists to get right. The permits track is behind a WAF that
 * answers every request with 403, so the pipeline honestly records `ingested_count: 0` alongside
 * `constrained: true` and the limitation strings describing what it tried. Feeding that pair into
 * the ratio arithmetic produced "0 / 0 = 100.0%" with a full green bar: the most carefully
 * evidenced row in the artifact read as the most complete one. No bar is drawn here, because there
 * is no measurement to draw, and the pipeline's own explanation is put on screen instead.
 */
function UnavailableSource({ status }: { status: SourceStatus }) {
  const explanation =
    status.state === "blocked"
      ? "The source blocks collection. No rows were ingested, so no coverage can be claimed."
      : status.state === "not-implemented"
        ? "Registered in the source catalog and not yet implemented. No rows were ingested."
        : "Implemented and attempted, and no rows landed. Not excused as coverage.";
  return (
    <div className="min-w-[190px] text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={STATE_BADGE[status.state]} data-testid={`coverage-state-${status.source}`}>
          {STATE_LABEL[status.state]}
        </span>
        <span className="mono text-faint">0 rows</span>
        {status.requiresUsEgress ? <span className="badge badge-neutral">US egress only</span> : null}
      </div>
      <div className="mt-1 text-muted" style={{ whiteSpace: "normal" }}>
        {explanation}
      </div>
    </div>
  );
}

/** Horizontal bars for coverage, ingested against expected. */
export function CoverageBar({
  ingested,
  expected,
  rowsFromOtherTracks,
  additionalRowsBySource,
  status,
}: {
  ingested: number | null;
  expected: number | null;
  /** Set only where the target table is written by more than one track. */
  rowsFromOtherTracks?: number | null;
  additionalRowsBySource?: Record<string, number> | null;
  /** What the coverage snapshot says about this source, where it says anything. */
  status?: SourceStatus;
}) {
  if (ingested === null) {
    return <span className="na">not available</span>;
  }
  if (ingested === 0 && status !== undefined) {
    return <UnavailableSource status={status} />;
  }
  // A zero or absent expected total is an absence of measurement, never a full bar.
  if (expected === null || expected === 0) {
    return (
      <div className="text-[12px] text-muted">
        <span>
          {formatInt(ingested)} ingested,{" "}
          <span className="na">no published expected total to compare against</span>
        </span>
        <OtherTrackRows rows={rowsFromOtherTracks} bySource={additionalRowsBySource} />
      </div>
    );
  }
  // Report the true ratio even when it exceeds 100 percent. More rows than the
  // source claims to hold is a real signal about the expected count, and
  // rounding it down to a tidy 100 percent would hide it.
  const ratio = ingested / expected;
  const barFraction = Math.min(ratio, 1);
  const tone =
    ratio > 1.02
      ? "var(--color-warn)"
      : ratio >= 0.95
        ? "var(--color-good)"
        : ratio >= 0.6
          ? "var(--color-warn)"
          : "var(--color-bad)";
  const shortfall = expected - ingested;
  return (
    <div className="min-w-[190px]">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="mono">
          {formatInt(ingested)} / {formatInt(expected)}
        </span>
        <span
          style={{ color: tone }}
          title={
            ratio > 1.02
              ? "More rows ingested than the source publishes as its expected total. Treat the expected total as stale."
              : shortfall > 0
                ? `${formatInt(shortfall)} rows short of the published expected total.`
                : undefined
          }
        >
          {formatRatioPercent(ingested, expected)}
        </span>
      </div>
      <div className="progress mt-1">
        <div style={{ width: `${barFraction * 100}%`, background: tone }} />
      </div>
      {shortfall > 0 ? (
        <div className="mt-1 text-[11.5px] text-warn">
          {formatInt(shortfall)} {shortfall === 1 ? "row" : "rows"} short
        </div>
      ) : null}
      <OtherTrackRows rows={rowsFromOtherTracks} bySource={additionalRowsBySource} />
    </div>
  );
}

/** Compact non null coverage meter used on the Data page. */
export function NonNullBar({ nonNull, total }: { nonNull: number; total: number }) {
  if (total === 0) {
    return <span className="na text-[11.5px]">no rows to measure</span>;
  }
  const fraction = nonNull / total;
  const tone =
    fraction >= 0.9
      ? "var(--color-good)"
      : fraction >= 0.4
        ? "var(--color-warn)"
        : "var(--color-bad)";
  return (
    <div className="flex items-center gap-2">
      <div className="progress h-1.5 w-[120px] shrink-0">
        <div style={{ width: `${fraction * 100}%`, background: tone }} />
      </div>
      {/*
        A column that is null on one row out of 404,023 must not print 100.0%: the meter is the
        only thing on the page that says whether a column is complete.
      */}
      <span className="mono text-[11.5px]" style={{ color: tone }}>
        {formatRatioPercent(nonNull, total)}
      </span>
    </div>
  );
}
