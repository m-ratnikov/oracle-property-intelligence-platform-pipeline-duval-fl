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
 * A percentage that is never allowed to round into a claim the data does not support.
 *
 * `(407985 / 407986 * 100).toFixed(1)` is "100.0%", and a coverage meter reading 100.0% beside
 * "407,985 / 407,986" tells a reviewer the source is fully ingested when one row is missing. The
 * same rounding runs the other way: 400001/400000 also prints 100.0% and hides the overshoot.
 * Only an exact match may print 100.0%; a shortfall is floored to the nearest tenth below it and
 * an overshoot is raised to the nearest tenth above, so the digits always agree with the counts.
 */
export function formatRatioPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return NOT_AVAILABLE;
  if (part === whole) return "100.0%";
  const percent = (part / whole) * 100;
  const rounded = Number(percent.toFixed(1));
  if (percent < 100 && rounded >= 100) return "99.9%";
  if (percent > 100 && rounded <= 100) return "100.1%";
  // A non-zero count must never round away to 0.0%, for the same reason.
  if (percent > 0 && rounded === 0) return "0.1%";
  return `${rounded.toFixed(1)}%`;
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

/**
 * Anything a timestamp column can arrive as once it has crossed the Arrow bridge.
 *
 * `unknown` is in the union on purpose: these helpers are the render path for
 * `Record<string, unknown>` result rows, where the column type is only known at runtime.
 * Everything outside the union parses to null and renders as "not available".
 */
export type TimestampInput = string | number | bigint | Date | null | undefined | unknown;

/**
 * Epoch counts, resolved to a unit by magnitude.
 *
 * The parquet stores `fetched_at` as a DuckDB TIMESTAMP, and DuckDB-WASM hands a timestamp column
 * back over the Arrow bridge as a plain epoch NUMBER, not a Date and not a string. Every provenance
 * cell in the app therefore printed the integer: "DUVAL_APPRAISER source 1787320736294". The
 * published `dataset-coverage.json` says the same instant is 2026-08-21T13:58:56Z, which is what
 * fixes the unit as milliseconds rather than the seconds or microseconds an Arrow timestamp column
 * can also carry.
 *
 * Rather than hard code that one unit, the magnitude decides, because the Arrow unit is a property
 * of the published file and not of this code. The thresholds are chosen so that every instant
 * between 1973 and the year 5138 lands in the right bucket:
 *   < 1e11  seconds       (1e11 s  is the year 5138)
 *   < 1e14  milliseconds  (1e11 ms is 1973, 1e14 ms is the year 5138)
 *   < 1e17  microseconds
 *   else    nanoseconds
 * Sub-1973 timestamps do not occur in county pipeline provenance, and a value small enough to be
 * ambiguous would render as a 1970 date under any reading of it.
 */
const EPOCH_SECONDS_MAX = 1e11;
const EPOCH_MILLIS_MAX = 1e14;
const EPOCH_MICROS_MAX = 1e17;

export function epochToDate(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  const millis =
    magnitude < EPOCH_SECONDS_MAX
      ? value * 1000
      : magnitude < EPOCH_MILLIS_MAX
        ? value
        : magnitude < EPOCH_MICROS_MAX
          ? value / 1000
          : value / 1_000_000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A digit-only string long enough to be an epoch count rather than a bare year. Nine digits is
 * 1973 in seconds; four digits stay a calendar year and keep their existing Date parse.
 */
const EPOCH_DIGITS = /^-?\d{9,}$/;

export function parseTimestamp(value: TimestampInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "bigint") return epochToDate(Number(value));
  if (typeof value === "number") return epochToDate(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (EPOCH_DIGITS.test(trimmed)) return epochToDate(Number(trimmed));
  const zoneless = ZONELESS_DATE_TIME.exec(trimmed);
  const date = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-08-21 13:58:56Z". Always UTC, always readable, never a raw epoch. */
export function formatTimestamp(value: TimestampInput): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const date = parseTimestamp(value);
  // An unparseable value stays visible when it is text, so a malformed stamp is not hidden.
  // Anything else has no readable form and is reported as missing rather than as "[object Object]".
  if (date === null) return typeof value === "string" ? value : NOT_AVAILABLE;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** "2026-08-21 13:58Z". The compact form used where a provenance cell has one line to spare. */
export function formatTimestampShort(value: TimestampInput): string {
  const date = parseTimestamp(value);
  if (date === null) return formatTimestamp(value);
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export function formatDateOnly(value: TimestampInput): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const date = parseTimestamp(value);
  if (date === null) return typeof value === "string" ? value : NOT_AVAILABLE;
  return date.toISOString().slice(0, 10);
}

/** "3 hours ago" style, deliberately coarse. */
export function relativeTime(value: TimestampInput, now = Date.now()): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
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
  startIso: TimestampInput,
  endIso: TimestampInput,
): number | null {
  const start = parseTimestamp(startIso)?.getTime();
  const end = parseTimestamp(endIso)?.getTime();
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}

export function formatDurationMs(
  startIso: TimestampInput,
  endIso: TimestampInput,
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
  /*
   * Small counts that read as a measurement rather than a quantity. A roof age or a number of
   * recorded sales is a single or double digit figure a reader compares against a threshold, so it
   * renders as plain digits. Larger counts (address points, linked businesses) deliberately keep
   * their thousands separator, and `years_since_last_sale` stays out of this set because the
   * workbench alias rule already covers it and the existing contract pins it.
   */
  "roof_age_years",
  "sale_count",
]);

export function isPlainIntegerColumn(column: string): boolean {
  return PLAIN_INTEGER_COLUMNS.has(column) || /(^|_)(year|zip|fips)$/.test(column);
}

/**
 * Columns the published artifact carries but no Duval source fills, with what to read instead.
 *
 * A NULL here is not a gap in this row: it is a fact about the source, and the sentences are the
 * pipeline's own (pipeline/src/features/export.ts publishes them inside the parquet metadata).
 * Rendering these as a bare "not available" alongside genuinely missing values tells a reviewer the
 * pipeline failed to collect something that was never there to collect. owner_count is the sharpest
 * case: it used to be emitted as a literal 1 on every row, a constant dressed up as a count, and is
 * now honestly NULL - which only reads as honest if the page says why.
 */
export const UNPOPULATED_COLUMNS: Readonly<Record<string, string>> = {
  owner_count:
    "The FDOR roll publishes one 30 character owner name per parcel and no co-owner column, so the source carries no owner count at all. has_additional_owners is the multi owner signal the roll does have.",
  has_bbb_contractor:
    "BBB terms forbid aggregation and no contractor source resolves to a parcel. The column exists only to keep the canonical Elephant list complete.",
  hoa_flag: "A placeholder in the Elephant contract. No Duval source publishes it.",
  avm_value: "No automated valuation is published for Duval.",
};

export function unpopulatedReason(column: string): string | null {
  return UNPOPULATED_COLUMNS[column] ?? null;
}

/**
 * Columns that hold an instant rather than a number.
 *
 * `fetched_at` is the only TIMESTAMP column in the published query table, but the workbench lets a
 * reviewer alias it (`MAX(fetched_at) AS last_fetched_at`), and the Data page already does exactly
 * that. Anything DuckDB hands back from a TIMESTAMP column arrives as an epoch number, so the
 * naming convention is what tells the renderer to read it as a time instead of printing
 * "1,787,320,736,294".
 */
const TIMESTAMP_COLUMN = /(^|_)(fetched|loaded|created|updated|started|finished|exported|generated|published|collected)_at$/;

export function isTimestampColumn(column: string): boolean {
  return column === "fetched_at" || TIMESTAMP_COLUMN.test(column);
}

/**
 * Columns that carry a calendar date rather than an instant.
 *
 * The roll and the City sales file publish sale dates with year and month only, stored as the
 * first of the month, so rendering a time of day beside one would invent precision the source does
 * not have. `last_sale_date_any` and `coj_last_sale_date` are the two a reader actually sees, since
 * `last_sale_date` is NULL on most parcels.
 */
const DATE_ONLY_COLUMN = /(^|_)(date)$/;

export function isDateOnlyColumn(column: string): boolean {
  return DATE_ONLY_COLUMN.test(column) || column === "last_sale_date_any" || column === "features_as_of";
}

/** displayCell, but aware of which columns must not be group separated or read as numbers. */
export function displayCellForColumn(column: string, value: unknown): string {
  const plain = toPlain(value);
  if (plain === null) return NOT_AVAILABLE;
  if (isTimestampColumn(column)) return formatTimestamp(plain as TimestampInput);
  if (isDateOnlyColumn(column)) return formatDateOnly(plain as TimestampInput);
  if (typeof plain === "number" && Number.isInteger(plain) && isPlainIntegerColumn(column)) {
    return String(plain);
  }
  return displayCell(value);
}

/**
 * The value a CSV cell carries. The export is the artifact a reviewer opens in a spreadsheet to
 * check an answer against the county, so a provenance timestamp has to leave here as an instant
 * rather than as the epoch integer the Arrow bridge produced.
 */
export function csvCell(column: string, value: unknown): unknown {
  if (!isTimestampColumn(column)) return value;
  const date = parseTimestamp(toPlain(value) as TimestampInput);
  return date === null ? value : date.toISOString();
}

/** RFC 4180 flavoured CSV. `format` maps a raw cell to what the file should carry. */
export function toCsv(
  columns: string[],
  rows: Record<string, unknown>[],
  format: (column: string, value: unknown) => unknown = csvCell,
): string {
  const escape = (value: unknown): string => {
    const plain = toPlain(value);
    if (plain === null) return "";
    const text = String(plain);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((column) => escape(column)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(format(column, row[column]))).join(","));
  }
  return lines.join("\r\n");
}
