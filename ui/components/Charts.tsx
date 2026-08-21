"use client";

import { formatInt } from "@/lib/format";

/**
 * Hand rolled SVG charts. A charting library would be several hundred kilobytes
 * for two small pictures, and these need to be readable in both themes without
 * a runtime theme provider, so they use currentColor and CSS variables.
 */

export interface SourceTrend {
  name: string;
  /** Cumulative rows after each run, oldest first. */
  totals: number[];
}

/**
 * One sparkline per source rather than thirteen lines sharing an axis.
 *
 * The single chart this replaces put every source on one linear scale, where the
 * largest source is nine hundred times the smallest, so ten of the thirteen lines
 * were pinned to the baseline on top of each other. It also needed thirteen
 * categorical colours, which is past the point where any palette stays separable,
 * and the run identifiers along the bottom overlapped into an unreadable band.
 *
 * Faceting solves all three at once: every source gets its own vertical scale, so
 * its shape is visible whatever its magnitude; identity comes from the heading
 * rather than a hue, so the chart needs one colour instead of thirteen; and the
 * run axis disappears, since the run count is the same for every panel and is
 * better said once in words.
 */
export function SourceTrends({
  sources,
  runCount,
}: {
  sources: SourceTrend[];
  runCount: number;
}) {
  if (sources.length === 0) {
    return <div className="card card-pad text-[13px] text-muted">No runs to chart yet.</div>;
  }

  // Biggest contributor first, so the panels read in the order that matters.
  const ordered = [...sources].sort(
    (a, b) => (b.totals[b.totals.length - 1] ?? 0) - (a.totals[a.totals.length - 1] ?? 0),
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {ordered.map((source) => (
        <SourcePanel key={source.name} source={source} runCount={runCount} />
      ))}
    </div>
  );
}

function SourcePanel({ source, runCount }: { source: SourceTrend; runCount: number }) {
  const totals = source.totals;
  const current = totals[totals.length - 1] ?? 0;
  const previous = totals.length > 1 ? totals[totals.length - 2] : null;
  const delta = previous === null ? null : current - previous;
  const moved = totals.length > 1 && totals.some((value, index) => index > 0 && value !== totals[index - 1]);

  return (
    <div className="card card-pad">
      <div className="mono truncate text-[12px] font-semibold" title={source.name}>
        {source.name}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold leading-tight">{formatInt(current)}</div>
      {current === 0 ? (
        <div className="mt-1.5 h-[34px] text-[11.5px] text-faint">
          No rows recorded in any of these {runCount} runs. The source limitations
          below say why.
        </div>
      ) : (
        <Sparkline
          values={totals}
          label={`${source.name}: ${formatInt(current)} cumulative rows across ${runCount} runs, ${
            moved ? "changed during the window" : "unchanged during the window"
          }`}
        />
      )}
      <div className="mt-1 text-[11.5px]">
        {current === 0 ? (
          <span className="text-warn">constrained source</span>
        ) : delta === null ? (
          <span className="text-faint">first recorded run</span>
        ) : delta > 0 ? (
          <span className="text-good">+{formatInt(delta)} on the latest run</span>
        ) : (
          <span className="text-faint">no change on the latest run</span>
        )}
      </div>
    </div>
  );
}

/**
 * Its own vertical scale, and no axis. A sparkline answers "what shape" and the
 * number above it answers "how many"; drawing ticks here would repeat the number
 * in a less readable form.
 *
 * The drawing stretches to whatever width the panel has, which distorts shapes but
 * not stroked paths, so every mark here including the end marker is a stroke.
 */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const width = 150;
  const height = 34;
  const pad = 4;

  if (values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const x = (index: number) => pad + index * stepX;
  // A source that never moved draws down the middle rather than along an edge,
  // so flat reads as steady rather than as missing.
  const y = (value: number) =>
    span === 0 ? height / 2 : pad + (height - pad * 2) * (1 - (value - min) / span);

  const path = values.map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`).join(" ");
  const lastIndex = values.length - 1;

  return (
    <svg
      className="mt-1.5 block w-full"
      viewBox={`0 0 ${width} ${height}`}
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={path} fill="none" stroke="var(--color-border-strong)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {/* The latest run is the part a reader is looking for, so it carries the accent. */}
      {values.length > 1 ? (
        <path
          d={`M ${x(lastIndex - 1)} ${y(values[lastIndex - 1])} L ${x(lastIndex)} ${y(values[lastIndex])}`}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <line
        x1={x(lastIndex)}
        x2={x(lastIndex)}
        y1={y(values[lastIndex]) - 4}
        y2={y(values[lastIndex]) + 4}
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

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

/** Horizontal bars for coverage, ingested against expected. */
export function CoverageBar({
  ingested,
  expected,
  rowsFromOtherTracks,
  additionalRowsBySource,
}: {
  ingested: number | null;
  expected: number | null;
  /** Set only where the target table is written by more than one track. */
  rowsFromOtherTracks?: number | null;
  additionalRowsBySource?: Record<string, number> | null;
}) {
  if (ingested === null) {
    return <span className="na">not available</span>;
  }
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
              : undefined
          }
        >
          {(ratio * 100).toFixed(1)}%
        </span>
      </div>
      <div className="progress mt-1">
        <div style={{ width: `${barFraction * 100}%`, background: tone }} />
      </div>
      <OtherTrackRows rows={rowsFromOtherTracks} bySource={additionalRowsBySource} />
    </div>
  );
}

/** Compact non null coverage meter used on the Data page. */
export function NonNullBar({ nonNull, total }: { nonNull: number; total: number }) {
  const fraction = total === 0 ? 0 : nonNull / total;
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
      <span className="mono text-[11.5px]" style={{ color: tone }}>
        {(fraction * 100).toFixed(1)}%
      </span>
    </div>
  );
}
