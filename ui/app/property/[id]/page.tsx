"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useEngineBoot } from "@/lib/hooks";
import { runQuery } from "@/lib/duckdb";
import { queryTableParquetUrl } from "@/lib/config";
import { propertyByIdSql } from "@/lib/sql";
import { COLUMN_GROUPS, CURRENCY_COLUMNS, METRE_COLUMNS, ungroupedColumns } from "@/lib/columns";
import {
  NOT_AVAILABLE,
  displayCell,
  formatDateOnly,
  formatInt,
  formatMetres,
  formatTimestamp,
  formatUsd,
} from "@/lib/format";
import { lookupPropertyJson } from "@/lib/openData";
import type { OpenDataLookup } from "@/lib/openData";
import { PageHeader, Section, Callout, Spinner, ErrorBox, IdWithCopy } from "@/components/ui";
import { MapThumb } from "@/components/MapThumb";
import { EngineStatus } from "@/components/EngineStatus";

function Value({ column, value }: { column: string; value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="na">{NOT_AVAILABLE}</span>;
  }
  if (CURRENCY_COLUMNS.has(column) && typeof value === "number") {
    return <span className="mono">{formatUsd(value)}</span>;
  }
  if (METRE_COLUMNS.has(column) && typeof value === "number") {
    return <span className="mono">{formatMetres(value)}</span>;
  }
  if (column === "fetched_at") {
    return <span className="mono">{formatTimestamp(String(value))}</span>;
  }
  if (column === "last_sale_date") {
    return <span className="mono">{formatDateOnly(String(value))}</span>;
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
  return <span>{displayCell(value)}</span>;
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

  const sales = useMemo(() => {
    const fromJson = readArray(openData?.document ?? null, "sales");
    if (fromJson.length > 0) return fromJson;
    if (row?.last_sale_date) {
      return [
        {
          ownership_transfer_date: row.last_sale_date,
          purchase_price_amount: row.last_sale_price ?? null,
          source: "query table last_sale_date",
        },
      ];
    }
    return [];
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
              </div>

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
                              : displayCell(sale[key])}
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
                            {displayCell(permit[key])}
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
                  : "No permits linked to this parcel in the published data."}
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
