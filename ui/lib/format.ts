/** Presentation helpers. Pure, so they are covered by unit tests. */

export const NOT_AVAILABLE = "not available";

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(part: number | null, whole: number | null): string {
  if (part === null || whole === null || whole === 0) return NOT_AVAILABLE;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Parse a published timestamp, treating a zoneless stamp as UTC.
 *
 * Every stamp this app renders is UTC at the point it was recorded, but not every one
 * says so. DuckDB TIMESTAMP columns carry no zone, so run records published before the
 * pipeline fix read "2026-08-21 16:34:49.119" - and the ECMAScript rule for a date-time
 * string with no offset is LOCAL time. `new Date(...)` therefore moved every run record
 * by the reader's UTC offset: a 16:34Z run showed as 09:34Z with "7h ago" in Bangkok and
 * sat in the future in New York, on a page whose whole claim is continuous refresh.
 *
 * Anything that already names a zone - a trailing Z or a +HH:MM / -HH:MM offset - is
 * handed to the platform parser untouched, so the newly published `Z` stamps and the
 * coverage snapshot are unaffected. A bare `YYYY-MM-DD` is already UTC by specification.
 */
const ZONELESS_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;

export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const zoneless = ZONELESS_DATE_TIME.exec(trimmed);
  const date = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return NOT_AVAILABLE;
  const date = parseTimestamp(value);
  if (date === null) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return NOT_AVAILABLE;
  const date = parseTimestamp(value);
  if (date === null) return value;
  return date.toISOString().slice(0, 10);
}

/** "3 hours ago" style, deliberately coarse. */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return NOT_AVAILABLE;
  const then = parseTimestamp(value)?.getTime() ?? Number.NaN;
  if (Number.isNaN(then)) return NOT_AVAILABLE;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Elapsed milliseconds between two published stamps, or null if either is unusable. */
export function durationMs(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  const start = parseTimestamp(startIso)?.getTime();
  const end = parseTimestamp(endIso)?.getTime();
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}

export function formatDurationMs(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string {
  const elapsed = durationMs(startIso, endIso);
  if (elapsed === null) return NOT_AVAILABLE;
  return formatElapsed(elapsed);
}

/** "27m 4s" / "24s". Coarse on purpose: a run is not timed to the millisecond. */
export function formatElapsed(elapsed: number | null): string {
  if (elapsed === null || !Number.isFinite(elapsed) || elapsed < 0) return NOT_AVAILABLE;
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function formatMetres(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} km`;
  return `${Math.round(value)} m`;
}

/**
 * Shorten a CID or long hash for display, keeping head and tail.
 *
 * `tail: 0` means "head only", which is how a git sha is shown. It has to be special cased:
 * `slice(-0)` is `slice(0)`, so the naive form returned the entire string after the ellipsis
 * and the runs page printed "5be287e...5be287e52c628428eaaa72e10a3d71d22f6d3ec1".
 */
export function shortenId(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return NOT_AVAILABLE;
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${tail === 0 ? "" : value.slice(-tail)}`;
}

export function signedDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  if (value > 0) return `+${formatInt(value)}`;
  return formatInt(value);
}

/**
 * Arrow gives us BigInt for 64 bit ints, Date for temporal columns and typed
 * objects for nested values. Flatten everything into something React can render
 * and CSV can carry.
 */
export function toPlain(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // Arrow Vector rows, structs, lists.
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      return JSON.stringify((value as { toJSON: () => unknown }).toJSON());
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return String(value);
}

export function displayCell(value: unknown): string {
  const plain = toPlain(value);
  if (plain === null) return NOT_AVAILABLE;
  if (typeof plain === "boolean") return plain ? "yes" : "no";
  if (typeof plain === "number") {
    return Number.isInteger(plain) ? formatInt(plain) : formatNumber(plain, 4);
  }
  return plain;
}

/**
 * Integers that are calendar years or identifiers. A thousands separator turns
 * built_year 1954 into "1,954", so these render as plain digits. The regex also
 * catches ad hoc aliases a reviewer types in the workbench, such as
 * "SELECT built_year AS sale_year".
 */
const PLAIN_INTEGER_COLUMNS = new Set([
  "built_year",
  "roof_year_est",
  "address_zip",
  "county_fips",
  "state_fips",
]);

export function isPlainIntegerColumn(column: string): boolean {
  return PLAIN_INTEGER_COLUMNS.has(column) || /(^|_)(year|zip|fips)$/.test(column);
}

/** displayCell, but aware of which columns must not be group separated. */
export function displayCellForColumn(column: string, value: unknown): string {
  const plain = toPlain(value);
  if (typeof plain === "number" && Number.isInteger(plain) && isPlainIntegerColumn(column)) {
    return String(plain);
  }
  return displayCell(value);
}

/** RFC 4180 flavoured CSV. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => {
    const plain = toPlain(value);
    if (plain === null) return "";
    const text = String(plain);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  return lines.join("\r\n");
}
