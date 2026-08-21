"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  NOT_AVAILABLE,
  displayCellForColumn,
  formatDateOnly,
  formatMetres,
  formatTimestamp,
  formatTimestampShort,
  formatUsd,
  isDateOnlyColumn,
  isTimestampColumn,
  toCsv,
} from "@/lib/format";
import { CURRENCY_COLUMNS, METRE_COLUMNS, PROVENANCE_COLUMNS } from "@/lib/columns";

const PROVENANCE_SET = new Set<string>(["source_system", "source_url", "fetched_at"]);
const LINK_COLUMNS = new Set(["property_id"]);
const NUMERIC_HINTS = /(_m|_value|_price|_year|_count|_area|_sqft|_acre|latitude|longitude|rows|delta)$/;

export interface DataTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Columns highlighted as the evidence behind a question. */
  evidence?: string[];
  /** Collapse source_system + source_url + fetched_at into one provenance cell. */
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

/** source_system + source_url + fetched_at rendered as one compact provenance cell. */
function ProvenanceCell({ row }: { row: Record<string, unknown> }) {
  const system = row.source_system ? String(row.source_system) : null;
  const url = row.source_url ? String(row.source_url) : null;
  /*
   * `fetched_at` is a DuckDB TIMESTAMP, which duckdb-wasm hands over as an epoch number. This cell
   * used to stringify it, so every provenance cell in the app read "DUVAL_APPRAISER source
   * 1787320736294". It is formatted from the raw value, and the title carries the full instant to
   * the second while the cell shows minutes.
   */
  const fetched = row.fetched_at ?? null;
  const fetchedText = fetched === null ? null : formatTimestampShort(fetched);
  const fetchedTitle = fetched === null ? undefined : `fetched_at ${formatTimestamp(fetched)}`;

  if (!system && !url && fetched === null) {
    return <span className="na">{NOT_AVAILABLE}</span>;
  }

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="badge badge-neutral">{system ?? "unknown source"}</span>
      {url ? (
        <a className="mono text-[11px]" href={url} target="_blank" rel="noreferrer" title={url}>
          source
        </a>
      ) : (
        <span className="na text-[11px]">no url</span>
      )}
      <span className="mono text-[11px] text-faint" title={fetchedTitle}>
        {fetchedText ?? NOT_AVAILABLE}
      </span>
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
              {hasProvenance ? <th>provenance</th> : null}
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
                  <td>
                    <ProvenanceCell row={row} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasProvenance ? (
        <p className="mt-1.5 text-[11.5px] text-faint">
          The provenance column collapses {PROVENANCE_COLUMNS.slice(0, 3).join(", ")}. The CSV export
          keeps them as separate columns and writes{" "}
          <span className="mono">fetched_at</span> as an ISO 8601 UTC instant.
        </p>
      ) : null}
    </div>
  );
}
