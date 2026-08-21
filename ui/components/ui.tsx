"use client";

import { useCopy } from "@/lib/hooks";
import { NOT_AVAILABLE, shortenId } from "@/lib/format";

/**
 * Ask the document to start fetching the artifacts this page needs.
 *
 * React hoists these <link> elements into <head>, and every page here is prerendered to static
 * HTML, so the browser opens the requests while it is still parsing the document rather than after
 * the bundle has downloaded, parsed and hydrated. On the overview that is the difference between
 * the run history request leaving at hydration time and leaving immediately.
 *
 * Declared per page rather than in the layout: the run history is 600 KB, and the workbench never
 * reads it.
 */
export function ArtifactPreload({ urls }: { urls: (string | null | undefined)[] }) {
  const wanted = [...new Set(urls.filter((url): url is string => !!url))];
  return (
    <>
      {wanted.map((url) => (
        <link key={url} rel="preload" as="fetch" href={url} crossOrigin="anonymous" />
      ))}
    </>
  );
}

export function PageHeader({
  title,
  lead,
  right,
}: {
  title: string;
  lead?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {lead ? <p className="mt-1 text-[13px] text-muted">{lead}</p> : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 max-w-3xl text-[12.5px] text-muted">{description}</p>
          ) : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  loading = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
  /** Reserves the value and hint boxes so the card does not resize on arrival. */
  loading?: boolean;
}) {
  const toneClass =
    tone === "good"
      ? "text-good"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "text-text";
  return (
    <div className="card card-pad">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-[22px] font-semibold leading-tight ${toneClass}`}>
        {loading ? (
          <span
            className="skeleton block h-[27px] w-24"
            role="status"
            aria-label={`${label}, loading`}
          />
        ) : (
          value
        )}
      </div>
      {/*
        The hint box holds its height whether or not there is a hint yet. The
        engine status message that lands here is two lines and the value that
        replaces it is one, so without this the card shrinks on arrival and
        shifts every section below it.
      */}
      <div className="mt-1 line-clamp-2 min-h-[36px] text-[12px] text-faint">{hint}</div>
    </div>
  );
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => copy(text)}
      title={`Copy: ${text}`}
      aria-label={`Copy ${label}`}
    >
      {copied ? "copied" : label}
    </button>
  );
}

/** Monospace id with a copy button. Used for CIDs, IPNS names, folios, hashes. */
export function IdWithCopy({
  value,
  head = 12,
  tail = 8,
  href,
}: {
  value: string | null | undefined;
  head?: number;
  tail?: number;
  href?: string | null;
}) {
  if (!value) return <span className="na">{NOT_AVAILABLE}</span>;
  const shown = shortenId(value, head, tail);
  return (
    <span className="inline-flex items-center gap-1.5">
      {href ? (
        <a className="mono" href={href} target="_blank" rel="noopener noreferrer" title={value}>
          {shown}
        </a>
      ) : (
        <span className="mono" title={value}>
          {shown}
        </span>
      )}
      <CopyButton text={value} />
    </span>
  );
}

export function NotAvailable({ why }: { why?: string }) {
  return (
    <span className="na" title={why}>
      {NOT_AVAILABLE}
      {why ? ` (${why})` : ""}
    </span>
  );
}

export function Callout({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "warn" | "bad" | "good";
  title?: string;
  children: React.ReactNode;
}) {
  const map = {
    neutral: "border-border bg-sunken text-text",
    warn: "border-warn/40 bg-warn-soft text-warn",
    bad: "border-bad/40 bg-bad-soft text-bad",
    good: "border-good/40 bg-good-soft text-good",
  } as const;
  return (
    <div className={`rounded-md border px-3 py-2 text-[12.5px] ${map[tone]}`}>
      {title ? <div className="mb-0.5 font-semibold">{title}</div> : null}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <span className="pulsing inline-block h-2 w-2 rounded-full bg-accent" />
      {label}
    </div>
  );
}

export function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <Callout tone="bad" title={title}>
      <span className="mono">{message}</span>
    </Callout>
  );
}
