"use client";

import { useId, useRef, useState } from "react";
import { formatElapsed, formatInt, formatTimestamp } from "@/lib/format";
import type { RunSummary } from "@/lib/types";

/**
 * Two charts about the run history, hand rolled in SVG.
 *
 * These replace a grid of fourteen per source sparklines whose own caption admitted
 * "most panels are flat, which is what an incremental pipeline looks like". A chart whose
 * success state is a flat line carries no information, and fourteen of them read as
 * "nothing is happening" - the opposite of what the page is trying to evidence.
 *
 * What the page has to prove, and which chart proves it:
 *
 *   1. ingestion is continuous and incremental, not one bulk load
 *      -> VerifiedAgainstWritten: the gap between "checked" and "had to write" opens up
 *         after the first load and never closes.
 *   2. each run re-verifies a large corpus cheaply
 *      -> VerifiedAgainstWritten for the corpus, RunCadence for the cost.
 *   3. the pipeline stays cheap as the cache warms
 *      -> RunCadence: consolidation passes fall from nine minutes to under half a minute.
 *
 * Colour comes from the validated `--chart-*` tokens in globals.css, not from the UI accent.
 * Verified and written are two steps of one hue because written rows are a subset of
 * verified rows; ingestion and consolidation are two identities, so they take categorical
 * slots. Both pairs were checked with the palette validator in light and dark.
 *
 * Neither chart is the only way to read a value: the run table underneath is the table view
 * twin and carries every number these plot.
 */

const PLOT = { width: 760, height: 250, left: 52, right: 16, top: 16, bottom: 34 };
const INNER_WIDTH = PLOT.width - PLOT.left - PLOT.right;
const INNER_HEIGHT = PLOT.height - PLOT.top - PLOT.bottom;

/** 1 / 10 / 1k / 1M, for a log axis where a thousands separator would not fit. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

function clockLabel(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toISOString().slice(11, 16) + "Z";
}

/* ------------------------------------------------------------------ tooltip */

interface Hover {
  index: number;
  /** Fraction of the chart width, so the tooltip can be positioned in CSS. */
  left: number;
}

/**
 * Pointer to nearest mark. The marks are thinner than a comfortable hit target and some of
 * them are only a few pixels apart on the cadence chart, so hit testing is nearest-x over
 * the whole plot rather than a rect per mark.
 */
function useNearest(positions: number[]) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (svg === null || positions.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * PLOT.width;
    let best = 0;
    for (let i = 1; i < positions.length; i += 1) {
      if (Math.abs(positions[i] - x) < Math.abs(positions[best] - x)) best = i;
    }
    setHover({ index: best, left: positions[best] / PLOT.width });
  };

  return { ref, hover, onMove, onLeave: () => setHover(null) };
}

function Tooltip({ left, children }: { left: number; children: React.ReactNode }) {
  // Flip the anchor near the edges so the panel never leaves the card.
  const side = left > 0.6 ? "right" : "left";
  const style =
    side === "left"
      ? { left: `${Math.max(left, 0.02) * 100}%` }
      : { right: `${Math.max(1 - left, 0.02) * 100}%` };
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 min-w-[190px] rounded border border-border bg-surface px-2.5 py-2 text-[11.5px] shadow-lg"
      style={style}
      role="status"
    >
      {children}
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="mono tabular-nums">{value}</span>
    </div>
  );
}

function Legend({ items }: { items: { color: string; label: string; kind?: "line" | "bar" }[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <svg width="16" height="10" aria-hidden="true">
            {item.kind === "bar" ? (
              <rect x="5" y="0" width="6" height="10" rx="1.5" fill={item.color} />
            ) : (
              <>
                <line x1="0" x2="16" y1="5" y2="5" stroke={item.color} strokeWidth="2" />
                <circle cx="8" cy="5" r="3" fill={item.color} />
              </>
            )}
          </svg>
          {item.label}
        </span>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="card card-pad text-[13px] text-muted">{label}</div>;
}

/* ------------------------------------------- rows verified against rows written */

/**
 * One mark pair per ingestion run, oldest on the left.
 *
 * The scale problem this has to survive: the first run wrote 468,555 rows and every run since
 * has written a few hundred, against a corpus of 2.29 million. On a linear axis that is one
 * spike and a flat floor, and the honest content - four orders of magnitude of difference
 * between what a run checks and what it writes - is exactly what a linear axis destroys.
 *
 * So: a log axis, with position encoding rather than length encoding (lines and markers, never
 * bars, because a bar on a log axis lies about its length). Runs that wrote nothing cannot sit
 * on a log axis at all, so they get an explicit zero band below the axis floor, drawn as open
 * markers and separated by a rule. Nothing is hidden and nothing is nudged up off zero.
 */
export function VerifiedAgainstWritten({ runs }: { runs: RunSummary[] }) {
  const ordered = [...runs].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0));
  const titleId = useId();
  const step = ordered.length > 1 ? INNER_WIDTH / (ordered.length - 1) : 0;
  const xs = ordered.map((_, index) =>
    ordered.length > 1 ? PLOT.left + index * step : PLOT.left + INNER_WIDTH / 2,
  );
  const { ref, hover, onMove, onLeave } = useNearest(xs);

  if (ordered.length === 0) return <Empty label="No ingestion runs to chart yet." />;

  const peak = Math.max(1, ...ordered.map((run) => Math.max(run.rowsVerified, run.rowsWritten)));
  // The axis tops out just above the real peak rather than at the next whole power of ten,
  // which would leave most of a decade of empty plot above the data.
  const top = Math.log10(peak) + 0.12;
  const gridDecades = Math.floor(Math.log10(peak));
  // A dedicated band under the log floor for exact zeros, and a gap so the two read apart.
  const zeroBand = 22;
  const logHeight = INNER_HEIGHT - zeroBand;
  const floorY = PLOT.top + logHeight;
  const zeroY = PLOT.top + INNER_HEIGHT;
  const y = (value: number) =>
    value <= 0 ? zeroY : floorY - (Math.log10(value) / top) * logHeight;

  const path = (pick: (run: RunSummary) => number) =>
    ordered
      .map((run, index) => `${index === 0 ? "M" : "L"} ${xs[index]} ${y(pick(run))}`)
      .join(" ");

  const last = ordered[ordered.length - 1];
  const active = hover === null ? null : ordered[hover.index];

  return (
    <div className="card card-pad">
      <div className="relative">
        <svg
          ref={ref}
          className="block w-full"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          role="img"
          aria-labelledby={titleId}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          <title id={titleId}>
            {`Rows checked against rows written for each of ${ordered.length} ingestion runs. The latest run checked ${formatInt(last.rowsVerified)} rows and wrote ${formatInt(last.rowsWritten)}.`}
          </title>

          {Array.from({ length: gridDecades + 1 }, (_, index) => {
            const value = 10 ** index;
            const ty = y(value);
            return (
              <g key={value}>
                <line
                  x1={PLOT.left}
                  x2={PLOT.width - PLOT.right}
                  y1={ty}
                  y2={ty}
                  stroke="var(--chart-grid)"
                  strokeWidth={1}
                />
                <text
                  x={PLOT.left - 8}
                  y={ty + 3.5}
                  textAnchor="end"
                  fontSize={10}
                  className="tabular-nums"
                  fill="var(--color-faint)"
                >
                  {compact(value)}
                </text>
              </g>
            );
          })}

          {/* The zero band is separated by a rule, so a zero is never mistaken for "one". */}
          <line
            x1={PLOT.left}
            x2={PLOT.width - PLOT.right}
            y1={floorY + zeroBand / 2}
            y2={floorY + zeroBand / 2}
            stroke="var(--color-border)"
            strokeWidth={1}
            strokeDasharray="none"
          />
          <text
            x={PLOT.left - 8}
            y={zeroY + 3.5}
            textAnchor="end"
            fontSize={10}
            fill="var(--color-faint)"
          >
            0
          </text>

          <path d={path((run) => run.rowsVerified)} fill="none" stroke="var(--chart-verified)" strokeWidth={2} />
          <path d={path((run) => run.rowsWritten)} fill="none" stroke="var(--chart-written)" strokeWidth={2} />

          {ordered.map((run, index) => (
            <g key={run.run_id}>
              <circle cx={xs[index]} cy={y(run.rowsVerified)} r={4} fill="var(--chart-verified)" />
              <circle
                cx={xs[index]}
                cy={y(run.rowsWritten)}
                r={4}
                fill={run.rowsWritten === 0 ? "var(--color-surface)" : "var(--chart-written)"}
                stroke="var(--chart-written)"
                strokeWidth={2}
              />
            </g>
          ))}

          {hover !== null ? (
            <line
              x1={xs[hover.index]}
              x2={xs[hover.index]}
              y1={PLOT.top}
              y2={zeroY}
              stroke="var(--color-border-strong)"
              strokeWidth={1}
            />
          ) : null}

          <text x={PLOT.left} y={PLOT.height - 8} fontSize={10} fill="var(--color-faint)">
            {clockLabel(ordered[0].startedMs)}
          </text>
          <text
            x={PLOT.width - PLOT.right}
            y={PLOT.height - 8}
            fontSize={10}
            textAnchor="end"
            fill="var(--color-faint)"
          >
            {clockLabel(last.startedMs)}
          </text>
          <text
            x={PLOT.left + INNER_WIDTH / 2}
            y={PLOT.height - 8}
            fontSize={10}
            textAnchor="middle"
            fill="var(--color-faint)"
          >
            {`${ordered.length} ingestion runs, oldest first`}
          </text>
        </svg>

        {hover !== null && active ? (
          <Tooltip left={hover.left}>
            <div className="mono mb-1 font-semibold">{active.run_id}</div>
            <TooltipRow label="started" value={formatTimestamp(active.run.started_at)} />
            <TooltipRow label="rows checked" value={formatInt(active.rowsVerified)} />
            <TooltipRow label="rows written" value={formatInt(active.rowsWritten)} />
            <TooltipRow label="sources ran" value={`${active.sourcesCompleted} of ${active.trackCount}`} />
            <TooltipRow label="took" value={formatElapsed(active.durationMs)} />
          </Tooltip>
        ) : null}
      </div>

      <Legend
        items={[
          { color: "var(--chart-verified)", label: "rows checked against what is stored" },
          { color: "var(--chart-written)", label: "rows the run had to write" },
        ]}
      />
      <p className="mt-1.5 text-[11.5px] text-faint">
        Log scale: each gridline is ten times the one below it, which is the only way four
        orders of magnitude fit on one axis. A run that wrote nothing sits in the zero band
        under the rule, not on the axis floor. Marks are one per run, so a run that ran fewer
        tracks checks fewer rows; the run table below gives the track count for each.
      </p>
    </div>
  );
}

/* --------------------------------------------------- cadence and cost per run */

/**
 * Every run on a real wall clock axis, column height = how long it took.
 *
 * Wall clock rather than run index, because the claim being evidenced is cadence: on an
 * evenly spaced axis a two and a half hour gap between runs looks identical to a two minute
 * one. The gaps are part of the evidence and are left visible.
 *
 * Consolidation passes are drawn in the same timeline in the second categorical slot. They
 * are maintenance rather than ingestion and are labelled as such, but they publish the
 * open-data index and manifest, so hiding them would delete real evidence.
 */
export function RunCadence({ runs }: { runs: RunSummary[] }) {
  const ordered = [...runs]
    .filter((run) => run.startedMs !== null && run.durationMs !== null)
    .sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0));
  const titleId = useId();

  const first = ordered[0]?.startedMs ?? 0;
  const lastStart = ordered[ordered.length - 1]?.startedMs ?? 0;
  const span = Math.max(lastStart - first, 1);
  const xs = ordered.map(
    (run) => PLOT.left + (((run.startedMs ?? first) - first) / span) * INNER_WIDTH,
  );
  const { ref, hover, onMove, onLeave } = useNearest(xs);

  if (ordered.length === 0) return <Empty label="No completed runs to chart yet." />;

  const longest = Math.max(...ordered.map((run) => run.durationMs ?? 0), 60_000) / 60_000;
  // Round tick steps, so the axis reads 0/5/10/15 rather than 0/8/15/23.
  const step = [1, 2, 5, 10, 15, 20, 30, 60].find((candidate) => longest / candidate <= 6) ?? 60;
  const topMinutes = Math.max(step, Math.ceil(longest / step) * step);
  const y = (ms: number) => PLOT.top + INNER_HEIGHT - (ms / (topMinutes * 60_000)) * INNER_HEIGHT;
  const barWidth = Math.max(3, Math.min(14, INNER_WIDTH / (ordered.length * 2)));
  const active = hover === null ? null : ordered[hover.index];

  const ticks = Array.from({ length: topMinutes / step + 1 }, (_, index) => index * step);
  const hourMarks: number[] = [];
  const firstHour = Math.ceil(first / 3_600_000) * 3_600_000;
  for (let t = firstHour; t <= lastStart; t += 3_600_000) hourMarks.push(t);

  return (
    <div className="card card-pad">
      <div className="relative">
        <svg
          ref={ref}
          className="block w-full"
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          role="img"
          aria-labelledby={titleId}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          <title id={titleId}>
            {`${ordered.length} runs on a wall clock axis from ${clockLabel(first)} to ${clockLabel(lastStart)}, column height is run duration in minutes.`}
          </title>

          {ticks.map((minutes) => {
            const ty = y(minutes * 60_000);
            return (
              <g key={minutes}>
                <line
                  x1={PLOT.left}
                  x2={PLOT.width - PLOT.right}
                  y1={ty}
                  y2={ty}
                  stroke="var(--chart-grid)"
                  strokeWidth={1}
                />
                <text
                  x={PLOT.left - 8}
                  y={ty + 3.5}
                  textAnchor="end"
                  fontSize={10}
                  className="tabular-nums"
                  fill="var(--color-faint)"
                >
                  {`${minutes}m`}
                </text>
              </g>
            );
          })}

          {ordered.map((run, index) => {
            const height = Math.max(2, PLOT.top + INNER_HEIGHT - y(run.durationMs ?? 0));
            const color =
              run.kind === "consolidation" ? "var(--chart-consolidation)" : "var(--chart-ingestion)";
            return (
              <rect
                key={run.run_id}
                x={xs[index] - barWidth / 2}
                y={PLOT.top + INNER_HEIGHT - height}
                width={barWidth}
                height={height}
                rx={1.5}
                fill={color}
                opacity={hover === null || hover.index === index ? 1 : 0.55}
              />
            );
          })}

          <line
            x1={PLOT.left}
            x2={PLOT.width - PLOT.right}
            y1={PLOT.top + INNER_HEIGHT}
            y2={PLOT.top + INNER_HEIGHT}
            stroke="var(--color-border)"
            strokeWidth={1}
          />

          {hourMarks.map((t) => {
            const tx = PLOT.left + ((t - first) / span) * INNER_WIDTH;
            return (
              <text
                key={t}
                x={tx}
                y={PLOT.height - 8}
                fontSize={10}
                textAnchor="middle"
                fill="var(--color-faint)"
              >
                {clockLabel(t)}
              </text>
            );
          })}
        </svg>

        {hover !== null && active ? (
          <Tooltip left={hover.left}>
            <div className="mono mb-1 font-semibold">{active.run_id}</div>
            <TooltipRow label="kind" value={active.kind} />
            <TooltipRow label="started" value={formatTimestamp(active.run.started_at)} />
            <TooltipRow label="took" value={formatElapsed(active.durationMs)} />
            <TooltipRow label="tracks" value={formatInt(active.trackCount)} />
            <TooltipRow label="rows checked" value={formatInt(active.rowsVerified)} />
            <TooltipRow label="rows written" value={formatInt(active.rowsWritten)} />
          </Tooltip>
        ) : null}
      </div>

      <Legend
        items={[
          { color: "var(--chart-ingestion)", label: "ingestion run", kind: "bar" },
          { color: "var(--chart-consolidation)", label: "consolidation pass", kind: "bar" },
        ]}
      />
      <p className="mt-1.5 text-[11.5px] text-faint">
        Positions are real times, so the gaps between runs are the gaps that happened. Height is
        wall clock duration, which depends on how many tracks a run was given as well as on how
        warm the cache is, so compare like with like: the full thirteen track runs, and the
        consolidation passes against each other.
      </p>
    </div>
  );
}
