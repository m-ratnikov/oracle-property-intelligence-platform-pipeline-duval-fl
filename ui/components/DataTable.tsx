"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  COLUMN_PROVENANCE_KEY,
  NOT_AVAILABLE,
  displayCellForColumn,
  fallbackRowSources,
  formatDateOnly,
  formatMetres,
  formatTimestamp,
  formatTimestampShort,
  formatUsd,
  isDateOnlyColumn,
  isTimestampColumn,
  parseColumnProvenance,
  rowSources,
  toCsv,
} from "@/lib/format";
import type { ColumnProvenanceMap, RowSource } from "@/lib/format";
import { CURRENCY_COLUMNS, METRE_COLUMNS, SOURCE_FAMILIES } from "@/lib/columns";
import { REGISTERED_FILE, runQuery } from "@/lib/duckdb";
import { queryTableParquetUrl } from "@/lib/config";

const PROVENANCE_SET = new Set<string>(["source_system", "source_url", "fetched_at"]);

/**
 * The provenance column is pinned to the right edge of the scrolling grid.
 *
 * It is the last column of a table that is routinely wider than the card holding it. On the
 * transit and Starbucks cards at 1440px the scrollport was 1316px against a 1512px table, so 94px
 * of a 290px column was on screen: DUVAL_APPRAISER (110px) and OVERTURE_PLACES (111px) were sliced
 * by the container edge and FDOR_PAR (66px), the shortest badge, was the only system that rendered
 * whole. A reader saw one system and had to discover a horizontal scroll to learn there were three.
 * Pinning costs no width anywhere else and is inert when the table already fits.
 *
 * The background has to be opaque or the columns scroll through it, and it is a class rather than
 * an inline style so `table.grid tbody tr:hover td` still wins and the pinned cell highlights with
 * the rest of its row. The header keeps the z-index globals.css gives every `thead th`, which is
 * above this, so it stays on top when the grid is scrolled in both directions at once.
 *
 * From `md` up only. A 290px column pinned inside a 322px phone scrollport would leave 32px for the
 * data it is meant to explain, and the partial-column illusion this fixes does not arise there: at
 * that width the column is not on screen at all until the reader scrolls to the end of the table,
 * and at the end of the table it is already whole.
 */
const STICKY_PROVENANCE = "md:sticky md:right-0 md:border-l md:border-border";
const FAMILY_KEYS = SOURCE_FAMILIES.map((family) => family.key);
const LINK_COLUMNS = new Set(["property_id"]);
const NUMERIC_HINTS = /(_m|_value|_price|_year|_count|_area|_sqft|_acre|latitude|longitude|rows|delta)$/;

export interface DataTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Columns highlighted as the evidence behind a question. */
  evidence?: string[];
  /**
   * Replace the source_system / source_url / fetched_at columns with one provenance cell that
   * names every system behind the values on that row, not just the appraisal roll spine.
   */
  collapseProvenance?: boolean;
  csvName?: string;
  emptyMessage?: string;
  maxHeight?: string;
}

function cellClass(column: string, value: unknown, isEvidence: boolean): string {
  const classes: string[] = [];
  if (isEvidence) classes.push("evidence");
  if (value === null || value === undefined) classes.push("na");
  else if (typeof value === "number" || NUMERIC_HINTS.test(column)) classes.push("num");
  return classes.join(" ");
}

/**
 * A header carries the same alignment as its column. The column name decides it
 * where the name is a known numeric shape, otherwise the first populated value
 * does, so an arbitrary workbench projection still lines up.
 */
function headerClass(
  column: string,
  rows: Record<string, unknown>[],
  isEvidence: boolean,
): string | undefined {
  const classes: string[] = [];
  if (isEvidence) classes.push("evidence");
  const isNumeric =
    NUMERIC_HINTS.test(column) ||
    CURRENCY_COLUMNS.has(column) ||
    METRE_COLUMNS.has(column) ||
    typeof rows.find((row) => row[column] !== null && row[column] !== undefined)?.[column] ===
      "number";
  if (isNumeric) classes.push("num");
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function renderValue(column: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined) return NOT_AVAILABLE;

  if (CURRENCY_COLUMNS.has(column) && typeof value === "number") return formatUsd(value);
  if (METRE_COLUMNS.has(column) && typeof value === "number") return formatMetres(value);
  // A TIMESTAMP column crosses the Arrow bridge as an epoch number, so it is formatted from the
  // raw value rather than from String(value), which would only produce a longer integer.
  if (isTimestampColumn(column)) return formatTimestamp(value);
  if (isDateOnlyColumn(column)) return formatDateOnly(value);

  if (LINK_COLUMNS.has(column)) {
    return (
      <Link
        className="mono"
        prefetch={false}
        href={`/property/${encodeURIComponent(String(value))}`}
      >
        {String(value)}
      </Link>
    );
  }

  if (column === "source_url" || (typeof value === "string" && /^https?:\/\//.test(value))) {
    const text = String(value);
    return (
      <a className="mono" href={text} target="_blank" rel="noreferrer" title={text}>
        {text.length > 48 ? `${text.slice(0, 45)}...` : text}
      </a>
    );
  }

  if (column.endsWith("_cid") || column === "parcel_identifier" || column === "request_identifier") {
    return <span className="mono">{String(value)}</span>;
  }

  return displayCellForColumn(column, value);
}

/**
 * The column to family map, read once from the published parquet footer.
 *
 * Module scoped rather than per component: every result grid on the page wants the same map, it
 * cannot change while an artifact is loaded, and reading it is a footer read against a file DuckDB
 * has already opened. A failure resolves to null instead of throwing, because a missing map must
 * degrade the provenance cell, never break the results table above it.
 */
let provenanceMap: ColumnProvenanceMap | null = null;
let provenanceLoad: Promise<ColumnProvenanceMap | null> | null = null;

function loadColumnProvenance(): Promise<ColumnProvenanceMap | null> {
  provenanceLoad ??= (async () => {
    try {
      const result = await runQuery(
        queryTableParquetUrl(),
        `SELECT decode(value) AS value FROM parquet_kv_metadata('${REGISTERED_FILE}')
         WHERE decode(key) = '${COLUMN_PROVENANCE_KEY}'`,
      );
      provenanceMap = parseColumnProvenance(result.rows[0]?.value);
    } catch {
      // An artifact published before the map existed, or a build without the parquet metadata
      // functions. The cell falls back to the source columns the row itself carries.
      provenanceMap = null;
    }
    return provenanceMap;
  })();
  return provenanceLoad;
}

export function useColumnProvenance(enabled: boolean): ColumnProvenanceMap | null {
  const [map, setMap] = useState<ColumnProvenanceMap | null>(provenanceMap);
  useEffect(() => {
    if (!enabled || map !== null) return;
    let cancelled = false;
    void loadColumnProvenance().then((loaded) => {
      if (!cancelled) setMap(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, map]);
  return map;
}

function sourceLabel(source: RowSource): string {
  if (source.kind === "system") return source.system;
  if (source.kind === "derived") return "derived by this pipeline";
  return "source not named on this row";
}

function sourceTitle(source: RowSource): string {
  const covers =
    source.columns.length > 0
      ? `Produced ${source.columns.join(", ")} on this row.`
      : "Named by the source columns this row carries.";
  if (source.kind === "derived") {
    return `${covers} Computed by the pipeline from other families rather than fetched, and each of these names its own evidence in a sibling basis column.`;
  }
  if (source.kind === "unattributed") {
    return `${covers} The family that publishes it names no system on this row, so the pipeline cannot say where the value came from.`;
  }
  const fetched =
    source.fetchedAt === null || source.fetchedAt === undefined
      ? "This row does not carry a fetch time for it."
      : `Fetched ${formatTimestamp(source.fetchedAt)}.`;
  return `${covers} ${fetched}`;
}

function SourceLine({
  source,
  spine,
  url,
}: {
  source: RowSource;
  spine: string | null;
  url: string | null;
}) {
  /*
   * `fetched_at` is a DuckDB TIMESTAMP, which duckdb-wasm hands over as an epoch number. It is
   * formatted from the raw value rather than stringified, and the title carries the full instant to
   * the second while the line shows minutes.
   */
  const fetched = source.fetchedAt ?? null;
  // source_url is the appraisal roll's dataset URL, so it belongs to the spine system alone.
  const isSpine = source.kind === "system" && source.system === spine;

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={source.kind === "system" ? "badge badge-neutral" : "badge badge-neutral na"}
        title={sourceTitle(source)}
      >
        {sourceLabel(source)}
      </span>
      {isSpine && url ? (
        <a className="mono text-[11px]" href={url} target="_blank" rel="noreferrer" title={url}>
          source
        </a>
      ) : null}
      {fetched !== null ? (
        <span
          className="mono text-[11px] text-faint"
          title={`fetched ${formatTimestamp(fetched)}`}
        >
          {formatTimestampShort(fetched)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Where the values shown on this row actually came from.
 *
 * This cell used to print `source_system` and nothing else, so a row whose evidence was an Overture
 * walking distance or a JTA GTFS transit distance still credited the county property appraiser.
 * `source_system` describes the appraisal roll spine the row is keyed on: in the published artifact
 * it is "duval_appraiser" on all 404,023 rows, while `source_systems` holds 18 distinct
 * combinations, so the one badge was flattening 18 real provenance profiles into a single name that
 * was wrong for most of the values beside it. Every contributing system is now named, resolved per
 * displayed column through the map the artifact publishes, and each carries its own fetch time
 * rather than borrowing the roll's.
 *
 * Exported because the Agent page renders the same cell over its evidence rows. Three surfaces
 * showing provenance must show the SAME provenance, and a second implementation is a second thing
 * to keep in step: the Agent page was the copy that never got the fix and went on crediting the
 * county property appraiser for Overture and JTA GTFS values.
 */
export function ProvenanceCell({
  row,
  columns,
  map,
}: {
  row: Record<string, unknown>;
  columns: string[];
  map: ColumnProvenanceMap | null;
}) {
  const spine = row.source_system ? String(row.source_system) : null;
  const url = row.source_url ? String(row.source_url) : null;

  const resolved = rowSources(map, columns, row);
  const sources = resolved.length > 0 ? resolved : fallbackRowSources(FAMILY_KEYS, columns, row);

  if (sources.length === 0) return <span className="na">{NOT_AVAILABLE}</span>;

  return (
    <span
      className="inline-flex flex-col items-start gap-0.5"
      data-testid="provenance"
      data-systems={sources
        .filter((source) => source.kind === "system")
        .map((source) => source.system)
        .join(",")}
    >
      {sources.map((source) => (
        <SourceLine
          key={`${source.kind}:${source.system}`}
          source={source}
          spine={spine}
          url={url}
        />
      ))}
    </span>
  );
}

export function DataTable({
  columns,
  rows,
  evidence = [],
  collapseProvenance = false,
  csvName,
  emptyMessage = "No rows matched.",
  maxHeight,
}: DataTableProps) {
  const evidenceSet = useMemo(() => new Set(evidence), [evidence]);

  const hasProvenance =
    collapseProvenance && columns.some((column) => PROVENANCE_SET.has(column));

  const displayColumns = useMemo(
    () => (hasProvenance ? columns.filter((column) => !PROVENANCE_SET.has(column)) : columns),
    [columns, hasProvenance],
  );

  const provenance = useColumnProvenance(hasProvenance);

  const download = () => {
    const csv = toCsv(columns, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${csvName ?? "results"}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  if (rows.length === 0) {
    return (
      <div className="card card-pad text-[13px] text-muted" data-testid="row-count" data-rows={0}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span data-testid="row-count" data-rows={rows.length}>
          <strong className="text-text">{rows.length.toLocaleString("en-US")}</strong> rows
          {evidence.length > 0 ? (
            <>
              {" "}
              <span className="ml-1 inline-block h-2 w-2 rounded-sm bg-accent-soft align-middle" />{" "}
              highlighted columns are the evidence for this rule
            </>
          ) : null}
        </span>
        <button type="button" className="btn btn-sm" onClick={download}>
          export CSV
        </button>
      </div>

      <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
        <table className="grid">
          <thead>
            <tr>
              {displayColumns.map((column) => (
                <th key={column} className={headerClass(column, rows, evidenceSet.has(column))}>
                  {column}
                </th>
              ))}
              {hasProvenance ? <th className={STICKY_PROVENANCE}>provenance</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${String(row.property_id ?? "")}-${index}`}>
                {displayColumns.map((column) => (
                  <td
                    key={column}
                    className={cellClass(column, row[column], evidenceSet.has(column))}
                  >
                    {renderValue(column, row[column])}
                  </td>
                ))}
                {hasProvenance ? (
                  <td className={`${STICKY_PROVENANCE} md:z-[1] md:bg-surface`}>
                    <ProvenanceCell row={row} columns={displayColumns} map={provenance} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasProvenance ? (
        <p className="mt-1.5 text-[11.5px] text-faint">
          The provenance column names every system behind the values on that row, not just{" "}
          <span className="mono">source_system</span>, which describes the appraisal roll spine the
          row is keyed on and is the same on every row. Each column is attributed through the column
          to family map published inside the parquet, so hover a badge to see which values it
          produced and when it was fetched. The CSV export keeps{" "}
          <span className="mono">source_system</span>, <span className="mono">source_url</span> and{" "}
          <span className="mono">fetched_at</span> as separate columns and writes the timestamp as an
          ISO 8601 UTC instant.
        </p>
      ) : null}
    </div>
  );
}
