"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";
import { useEngineBoot } from "@/lib/hooks";
import { runQuery } from "@/lib/duckdb";
import { queryTableParquetUrl } from "@/lib/config";
import { propertyByIdSql } from "@/lib/sql";
import { COLUMN_GROUPS, CURRENCY_COLUMNS, METRE_COLUMNS, ungroupedColumns } from "@/lib/columns";
import {
  NOT_AVAILABLE,
  displayCellForColumn,
  formatDateOnly,
  formatInt,
  formatMetres,
  formatTimestamp,
  formatUsd,
  isDateOnlyColumn,
  isTimestampColumn,
  unpopulatedReason,
} from "@/lib/format";
import { lookupPropertyJson } from "@/lib/openData";
import type { OpenDataLookup } from "@/lib/openData";
import { PageHeader, Section, Callout, Spinner, ErrorBox, IdWithCopy } from "@/components/ui";
import { MapThumb } from "@/components/MapThumb";
import { EngineStatus } from "@/components/EngineStatus";

function Value({ column, value }: { column: string; value: unknown }) {
  if (value === null || value === undefined) {
    /*
     * Some columns are NULL because the source does not publish them at all, and saying only "not
     * available" makes a documented absence look like a collection failure. owner_count is the
     * one that matters most: the roll has no co-owner column, so the honest value is NULL and
     * has_additional_owners is what a reader should look at instead.
     */
    const why = unpopulatedReason(column);
    if (why !== null) {
      return (
        <span className="na" title={why} data-testid={`unpopulated-${column}`}>
          not published by the source
        </span>
      );
    }
    return <span className="na">{NOT_AVAILABLE}</span>;
  }
  if (CURRENCY_COLUMNS.has(column) && typeof value === "number") {
    return <span className="mono">{formatUsd(value)}</span>;
  }
  if (METRE_COLUMNS.has(column) && typeof value === "number") {
    return <span className="mono">{formatMetres(value)}</span>;
  }
  // fetched_at is a DuckDB TIMESTAMP and arrives as an epoch number over the Arrow bridge, so the
  // raw value is handed to the formatter rather than a stringified integer.
  if (isTimestampColumn(column)) {
    return <span className="mono">{formatTimestamp(value)}</span>;
  }
  if (isDateOnlyColumn(column)) {
    return <span className="mono">{formatDateOnly(value)}</span>;
  }
  if (column === "source_url" || (typeof value === "string" && /^https?:\/\//.test(value))) {
    return (
      <a className="mono break-all" href={String(value)} target="_blank" rel="noreferrer">
        {String(value)}
      </a>
    );
  }
  if (column.endsWith("_cid")) {
    return <IdWithCopy value={String(value)} head={16} tail={8} />;
  }
  if (typeof value === "boolean") {
    return <span className={value ? "badge badge-good" : "badge badge-neutral"}>{value ? "yes" : "no"}</span>;
  }
  return <span>{displayCellForColumn(column, value)}</span>;
}

/**
 * Where each group of values on this row actually came from.
 *
 * The published query table carries a `<family>_source` / `<family>_fetched_at` pair per column
 * family, NULL on any row the family contributed nothing to, plus a `source_systems` list for the
 * whole row. The canonical `source_system` column above describes only the appraisal roll spine, so
 * without this a reviewer reading a transit distance or a water flag has no way to tell which
 * system produced it, or that a blank one means the family never reached this parcel.
 *
 * Driven entirely by the pairs present in the row: the pipeline adds families without this page
 * needing to know their names.
 */
function FamilyProvenance({ row }: { row: Record<string, unknown> }) {
  const families = Object.keys(row)
    .filter((column) => column.endsWith("_source") && `${column.slice(0, -7)}_fetched_at` in row)
    .map((column) => column.slice(0, -"_source".length))
    .sort();

  if (families.length === 0) return null;

  const contributing = families.filter((family) => row[`${family}_source`] !== null && row[`${family}_source`] !== undefined);
  const systems = row.source_systems ? String(row.source_systems) : null;

  return (
    <div className="card card-pad mt-4">
      <div className="text-[12.5px] font-semibold">Provenance per column family</div>
      <p className="mt-1 text-[11.5px] text-muted">
        {contributing.length} of {families.length} families contributed a value to this parcel. A
        family with no source did not reach this row.
      </p>
      <dl className="kv mt-2 text-[12px]">
        {families.map((family) => {
          const source = row[`${family}_source`];
          const fetched = row[`${family}_fetched_at`];
          return (
            <React.Fragment key={family}>
              <dt className="mono">{family}</dt>
              <dd>
                {source === null || source === undefined ? (
                  <span className="na" title="This family contributed no value to this parcel.">
                    no value on this row
                  </span>
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span className="badge badge-neutral">{String(source)}</span>
                    <span className="mono text-[11px] text-faint">{formatTimestamp(fetched)}</span>
                  </span>
                )}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>
      {systems ? (
        <p className="mt-2 text-[11.5px] text-faint">
          <span className="mono">source_systems</span>: {systems}
        </p>
      ) : null}
    </div>
  );
}

function readArray(document: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  if (!document) return [];
  const value = document[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

export default function PropertyPage() {
  const params = useParams<{ id: string }>();
  const propertyId = decodeURIComponent(String(params?.id ?? ""));
  const engine = useEngineBoot();

  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openData, setOpenData] = useState<OpenDataLookup | null>(null);
  const [openDataChecked, setOpenDataChecked] = useState(false);

  useEffect(() => {
    if (engine.stage !== "ready" || !propertyId) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await runQuery(queryTableParquetUrl(), propertyByIdSql(propertyId));
        if (cancelled) return;
        if (result.rows.length === 0) {
          setNotFound(true);
          return;
        }
        setColumns(result.columns);
        setRow(result.rows[0]);
      } catch (caught: unknown) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine.stage, propertyId]);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;

    (async () => {
      try {
        const cid = row.property_cid ? String(row.property_cid) : null;
        const found = await lookupPropertyJson(propertyId, cid);
        if (!cancelled) setOpenData(found);
      } catch {
        if (!cancelled) setOpenData(null);
      } finally {
        if (!cancelled) setOpenDataChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [row, propertyId]);

  const latitude = typeof row?.latitude === "number" ? row.latitude : null;
  const longitude = typeof row?.longitude === "number" ? row.longitude : null;

  const extraColumns = useMemo(() => ungroupedColumns(columns), [columns]);

  /*
   * The fallback sale must come from last_sale_date_any, not last_sale_date.
   *
   * last_sale_date is the FDOR roll's own column and the roll carries only the two most recent
   * transfers, so it is NULL on 351,742 of 404,023 parcels: falling back to it left the sales
   * section empty on most properties even though the pipeline holds a recorded transfer for
   * 401,832 of them. last_sale_date_any is the later of the roll sale and the City recorded sale,
   * and tenure_basis names which one it was, so the row can say where the date came from instead
   * of claiming a column that did not supply it.
   *
   * Both counts are measured against the published artifact
   * (bafybeidex5m2tzcbicfzjn4phgiudr2lpt7lgqf23ajz3gythipqdqhlri), not carried over from an
   * earlier run. They are stated as counts rather than as a percentage because 401,832 / 404,023
   * is 99.46%, and the "99.5%" this comment used to claim is the rounding up of a shortfall that
   * formatRatioPercent exists to refuse.
   */
  const sales = useMemo(() => {
    const fromJson = readArray(openData?.document ?? null, "sales");
    if (fromJson.length > 0) return fromJson;
    const date = row?.last_sale_date_any ?? row?.last_sale_date ?? null;
    if (date === null || date === undefined) return [];
    const basis = row?.tenure_basis ? String(row.tenure_basis) : null;
    const system = row?.tenure_source ? String(row.tenure_source) : null;
    const label =
      basis === null
        ? "query table last_sale_date_any"
        : system === null
          ? `query table last_sale_date_any (${basis})`
          : `query table last_sale_date_any (${basis} via ${system})`;
    return [
      {
        ownership_transfer_date: date,
        // The price is the roll's, so it only belongs on the row when the roll supplied the date.
        purchase_price_amount: basis === "COJ_SALESL" ? null : (row?.last_sale_price ?? null),
        source: label,
      },
    ];
  }, [openData, row]);

  const permits = useMemo(() => readArray(openData?.document ?? null, "permits"), [openData]);

  const title = row?.address_street
    ? `${String(row.address_street)}, ${String(row.address_city ?? "")}`
    : `Parcel ${propertyId}`;

  return (
    <div>
      <PageHeader
        title={title}
        lead={
          <>
            Folio <span className="mono">{propertyId}</span>. Every field below is exactly as
            published in the query table, grouped for reading. Nothing is computed on this page.
          </>
        }
        right={
          <Link href="/questions" className="btn btn-sm">
            back to questions
          </Link>
        }
      />

      {engine.stage !== "ready" ? <EngineStatus /> : null}
      {error ? <ErrorBox title="Lookup failed" message={error} /> : null}

      {notFound ? (
        <Callout tone="warn" title="Not in the published query table">
          No row matched <span className="mono">{propertyId}</span> on property_id,
          parcel_identifier or request_identifier. If the pipeline is still working through the
          roll, this parcel may not be published yet.
        </Callout>
      ) : null}

      {row ? (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              {COLUMN_GROUPS.map((group) => {
                const present = group.columns.filter((column) => columns.includes(column));
                if (present.length === 0) return null;
                return (
                  <section key={group.title} className="mb-5">
                    <div className="mb-1.5">
                      <h2 className="text-[13.5px] font-semibold">{group.title}</h2>
                      <p className="text-[12px] text-muted">{group.description}</p>
                    </div>
                    <div className="card card-pad">
                      <dl className="kv text-[12.5px]">
                        {present.map((column) => (
                          <div key={column} style={{ display: "contents" }}>
                            <dt className="mono">{column}</dt>
                            <dd>
                              <Value column={column} value={row[column]} />
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </section>
                );
              })}

              {extraColumns.length > 0 ? (
                <section className="mb-5">
                  <div className="mb-1.5">
                    <h2 className="text-[13.5px] font-semibold">Other published columns</h2>
                    <p className="text-[12px] text-muted">
                      Columns the pipeline publishes that this UI has no grouping for. They are shown
                      rather than dropped.
                    </p>
                  </div>
                  <div className="card card-pad">
                    <dl className="kv text-[12.5px]">
                      {extraColumns.map((column) => (
                        <div key={column} style={{ display: "contents" }}>
                          <dt className="mono">{column}</dt>
                          <dd>
                            <Value column={column} value={row[column]} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </section>
              ) : null}
            </div>

            <aside>
              <div className="mb-2 text-[13.5px] font-semibold">Location</div>
              <MapThumb latitude={latitude} longitude={longitude} size={320} />

              <div className="card card-pad mt-4">
                <div className="text-[12.5px] font-semibold">Provenance</div>
                <dl className="kv mt-2 text-[12px]">
                  <dt>source_system</dt>
                  <dd>
                    <Value column="source_system" value={row.source_system} />
                  </dd>
                  <dt>source_url</dt>
                  <dd>
                    <Value column="source_url" value={row.source_url} />
                  </dd>
                  <dt>fetched_at</dt>
                  <dd>
                    <Value column="fetched_at" value={row.fetched_at} />
                  </dd>
                  <dt>run_id</dt>
                  <dd>
                    <Value column="run_id" value={row.run_id} />
                  </dd>
                </dl>
                <p className="mt-2 text-[11.5px] text-faint">
                  <span className="mono">source_system</span> names the appraisal roll spine this
                  row is keyed on and nothing else. Every other group of values carries its own
                  source below.
                </p>
              </div>

              <FamilyProvenance row={row} />

              <div className="card card-pad mt-4">
                <div className="text-[12.5px] font-semibold">Per property IPFS JSON</div>
                {!openDataChecked ? (
                  <div className="mt-2">
                    <Spinner label="Looking for the consolidated record" />
                  </div>
                ) : openData ? (
                  <div className="mt-2 text-[12px]">
                    <div className="mb-1.5">
                      <IdWithCopy value={openData.cid} head={16} tail={8} />
                    </div>
                    <a className="mono break-all" href={openData.url} target="_blank" rel="noreferrer">
                      {openData.url}
                    </a>
                  </div>
                ) : (
                  <p className="mt-2 text-[12px] text-muted">
                    Not published for this parcel yet. The open data consolidation runs as a bounded
                    window, so it covers a growing subset of the roll rather than all of it at once.
                  </p>
                )}
              </div>
            </aside>
          </div>

          <Section
            title="Sales"
            description="Recorded ownership transfers. The query table carries the most recent one; the per property IPFS JSON carries the full list where it has been published."
          >
            {sales.length === 0 ? (
              <Callout tone="warn">
                No recorded transfer for this parcel. That is not the same as a long hold: it can
                also mean the sale is missing from the source, which is why the ownership question
                excludes rather than assumes.
              </Callout>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 300 }}>
                <table className="grid">
                  <thead>
                    <tr>
                      {Object.keys(sales[0]).map((key) => (
                        <th key={key}>{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((sale, index) => (
                      <tr key={index}>
                        {Object.keys(sales[0]).map((key) => (
                          <td key={key} className={sale[key] === null ? "na" : undefined}>
                            {key.includes("price") || key.includes("amount")
                              ? formatUsd(Number(sale[key]))
                              : displayCellForColumn(key, sale[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section
            title="Permits"
            description="Permit records linked to this parcel by the pipeline reconciliation."
          >
            {permits.length > 0 ? (
              <div className="table-wrap" style={{ maxHeight: 300 }}>
                <table className="grid">
                  <thead>
                    <tr>
                      {Object.keys(permits[0]).map((key) => (
                        <th key={key}>{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {permits.map((permit, index) => (
                      <tr key={index}>
                        {Object.keys(permits[0]).map((key) => (
                          <td key={key} style={{ whiteSpace: "normal" }}>
                            {displayCellForColumn(key, permit[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Callout tone="neutral">
                {row.has_permits === true
                  ? `The query table records ${formatInt(Number(row.permit_count ?? 0))} permits for this parcel, but the permit detail is not in the per property JSON published so far.`
                  : row.has_permits === false
                    ? "No permits linked to this parcel in the published data."
                    : "The permit source is blocked at the county, so no parcel has permit data. This is not a statement about this parcel."}
              </Callout>
            )}
          </Section>

          {openData ? (
            <Section
              title="Raw consolidated record"
              description="The per property JSON exactly as published on IPFS."
            >
              <pre className="block" style={{ maxHeight: 420, overflow: "auto" }}>
                {JSON.stringify(openData.document, null, 2)}
              </pre>
            </Section>
          ) : null}
        </>
      ) : !notFound && !error && engine.stage === "ready" ? (
        <Spinner label="Looking up the parcel" />
      ) : null}
    </div>
  );
}
