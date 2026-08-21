"use client";

import { useId } from "react";
import { formatInt } from "@/lib/format";

/**
 * Hand rolled SVG charts. A charting library would be several hundred kilobytes
 * for two small pictures, and these need to be readable in both themes without
 * a runtime theme provider, so they use currentColor and CSS variables.
 */

const PALETTE = [
  "#1a5c9a",
  "#1f6b3d",
  "#8a5a00",
  "#97231f",
  "#5a3d8a",
  "#0f6f75",
  "#8a4a1f",
  "#3f5a1f",
  "#7a2a5a",
];

export interface Series {
  name: string;
  points: { label: string; value: number }[];
}

export function LineChart({
  series,
  height = 220,
  yLabel,
}: {
  series: Series[];
  height?: number;
  yLabel?: string;
}) {
  const id = useId();
  const width = 720;
  const padding = { top: 12, right: 12, bottom: 34, left: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const labels = series[0]?.points.map((point) => point.label) ?? [];
  const maxValue = Math.max(1, ...series.flatMap((line) => line.points.map((point) => point.value)));
  const stepX = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;

  const x = (index: number) => padding.left + index * stepX;
  const y = (value: number) => padding.top + plotHeight - (value / maxValue) * plotHeight;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * maxValue);

  if (labels.length === 0) {
    return <div className="card card-pad text-[13px] text-muted">No runs to chart yet.</div>;
  }

  return (
    <div className="card card-pad overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Cumulative rows per source across ${labels.length} runs`}
      >
        {ticks.map((tick, index) => (
          <g key={`${id}-tick-${index}`}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={padding.left - 8}
              y={y(tick) + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--color-faint)"
            >
              {formatInt(tick)}
            </text>
          </g>
        ))}

        {labels.map((label, index) => (
          <text
            key={`${id}-label-${label}-${index}`}
            x={x(index)}
            y={height - 12}
            textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}
            fontSize="10"
            fill="var(--color-faint)"
          >
            {label.length > 14 ? `${label.slice(0, 13)}...` : label}
          </text>
        ))}

        {series.map((line, lineIndex) => {
          const color = PALETTE[lineIndex % PALETTE.length];
          const path = line.points
            .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.value)}`)
            .join(" ");
          return (
            <g key={`${id}-series-${line.name}`}>
              <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
              {line.points.map((point, index) => (
                <circle
                  key={`${id}-${line.name}-${index}`}
                  cx={x(index)}
                  cy={y(point.value)}
                  r={2.6}
                  fill={color}
                >
                  <title>{`${line.name} after ${point.label}: ${formatInt(point.value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {yLabel ? (
          <text x={4} y={12} fontSize="10" fill="var(--color-faint)">
            {yLabel}
          </text>
        ) : null}
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
        {series.map((line, index) => (
          <span key={line.name} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: PALETTE[index % PALETTE.length] }}
            />
            {line.name}
          </span>
        ))}
      </div>
    </div>
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
