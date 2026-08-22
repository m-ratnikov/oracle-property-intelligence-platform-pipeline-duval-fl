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

/* ------------------------------------------------------------------------- *
 * Per column provenance
 * ------------------------------------------------------------------------- */

/**
 * The parquet KV key under which the pipeline publishes its column to family map.
 *
 * The map is read from the artifact rather than restated here. The pipeline decides which column
 * belongs to which family, and a second copy in the UI is a copy that drifts: the screen would go
 * on attributing a column to a system the published file had already moved it away from.
 */
export const COLUMN_PROVENANCE_KEY = "elephant_column_provenance";

export interface ProvenanceFamily {
  key: string;
  label: string;
  /** Null for the families this pipeline computes rather than fetches. */
  sourceSystem: string | null;
  /** The per row column naming the system that reached this parcel, null when the family has none. */
  sourceColumn: string | null;
  fetchedAtColumn: string | null;
}

export interface ColumnProvenanceMap {
  families: Readonly<Record<string, ProvenanceFamily>>;
  /** Column name to family key, for every column the artifact publishes. */
  columns: Readonly<Record<string, string>>;
  /**
   * Every system name any family declares.
   *
   * This is what separates a source column that names a system (tenure_source is "coj_parcels")
   * from one that names a basis code inside a family (last_sale_source is "SDF"). Both end in
   * _source and only the first is a provenance claim.
   */
  systems: ReadonlySet<string>;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Parse the published map. Returns null for anything this UI cannot trust, so callers fall back. */
export function parseColumnProvenance(value: unknown): ColumnProvenanceMap | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const document = parsed as { families?: unknown; columns?: unknown };
  if (!Array.isArray(document.families)) return null;
  if (typeof document.columns !== "object" || document.columns === null) return null;

  const families: Record<string, ProvenanceFamily> = {};
  const systems = new Set<string>();
  for (const entry of document.families) {
    if (typeof entry !== "object" || entry === null) continue;
    const family = entry as Record<string, unknown>;
    if (typeof family.key !== "string" || family.key === "") continue;
    const sourceSystem = asText(family.sourceSystem);
    families[family.key] = {
      key: family.key,
      label: typeof family.label === "string" ? family.label : family.key,
      sourceSystem,
      sourceColumn: asText(family.sourceColumn),
      fetchedAtColumn: asText(family.fetchedAtColumn),
    };
    if (sourceSystem !== null) systems.add(sourceSystem);
  }

  const columns: Record<string, string> = {};
  for (const [column, entry] of Object.entries(document.columns as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const family = (entry as { family?: unknown }).family;
    if (typeof family === "string" && family !== "") columns[column] = family;
  }

  if (Object.keys(families).length === 0 || Object.keys(columns).length === 0) return null;
  return { families, columns, systems };
}

/**
 * One contributing source behind part of a row.
 *
 * `columns` is what makes the entry checkable: it names the displayed values this source actually
 * produced, so a badge can never be read as covering values it had no part in.
 */
export interface RowSource {
  /**
   * "system" was fetched from a named external system. "derived" was computed by this pipeline
   * from other families. "unattributed" is a value whose family source column is NULL on this row,
   * which is a hole in the provenance and is shown as one rather than guessed at.
   */
  kind: "system" | "derived" | "unattributed";
  /** The system exactly as the artifact spells it. Empty for "derived" and "unattributed". */
  system: string;
  /** The displayed columns this source produced, in display order. */
  columns: string[];
  /** The fetch instant for this source, when the row carries one. */
  fetchedAt: unknown;
}

const KIND_ORDER: Record<RowSource["kind"], number> = {
  system: 0,
  unattributed: 1,
  derived: 2,
};

/**
 * When this system's data was fetched, from whatever the row happens to carry.
 *
 * The family's own fetched_at column is preferred. The canonical `fetched_at` is used only for the
 * system `source_system` names, since those two are a pair by the Elephant contract; using it for
 * any other system would date that system's work by the appraisal roll's clock.
 */
function fetchedAtFor(
  map: ColumnProvenanceMap,
  row: Record<string, unknown>,
  system: string,
  family?: ProvenanceFamily,
): unknown {
  const candidates =
    family?.fetchedAtColumn != null
      ? [family.fetchedAtColumn]
      : Object.values(map.families)
          .filter((entry) => entry.sourceSystem === system && entry.fetchedAtColumn !== null)
          .map((entry) => entry.fetchedAtColumn as string);
  for (const candidate of candidates) {
    const value = row[candidate];
    if (value !== null && value !== undefined) return value;
  }
  if (asText(row.source_system) === system) return row.fetched_at ?? null;
  return null;
}

/**
 * Which sources produced the displayed values of one row.
 *
 * The point of this function is that a provenance badge names the provenance OF THE VALUES BESIDE
 * IT. `source_system` describes the appraisal roll spine the row is keyed on and nothing else, so a
 * row showing a Starbucks walking distance next to it was claiming Overture's work for the county
 * property appraiser. Every displayed column is resolved through the artifact's own map to the
 * family that produced it, and that family's source value ON THIS ROW names the system, because a
 * family can fall back to a different system per parcel and is NULL on parcels it never reached.
 */
export function rowSources(
  map: ColumnProvenanceMap | null,
  displayColumns: readonly string[],
  row: Record<string, unknown>,
): RowSource[] {
  if (map === null) return [];

  const groups = new Map<string, RowSource>();
  const credit = (
    kind: RowSource["kind"],
    system: string,
    column: string,
    fetchedAt: unknown,
  ): void => {
    const key = `${kind}:${system}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { kind, system, columns: [column], fetchedAt });
      return;
    }
    existing.columns.push(column);
    if (existing.fetchedAt === null || existing.fetchedAt === undefined) {
      existing.fetchedAt = fetchedAt;
    }
  };

  for (const column of displayColumns) {
    // No value, no provenance claim: a NULL cell reads "not available" and needs no source.
    if (row[column] === null || row[column] === undefined) continue;

    const familyKey = map.columns[column];
    // A workbench alias the artifact never named. Attributing it would be a guess.
    if (familyKey === undefined) continue;

    /*
     * A source column whose value is one of the systems the artifact declares carries its own
     * provenance and is believed over its family. This is how the pipeline-derived tenure date
     * still names the system that published it: tenure_source sits in the derived family, but its
     * value is a real system such as "coj_parcels".
     */
    const ownSystem = column.endsWith("_source") ? asText(row[column]) : null;
    if (ownSystem !== null && map.systems.has(ownSystem)) {
      credit("system", ownSystem, column, fetchedAtFor(map, row, ownSystem));
      continue;
    }

    const family = map.families[familyKey];
    if (family === undefined) continue;

    if (family.sourceColumn !== null && family.sourceColumn in row) {
      const onRow = asText(row[family.sourceColumn]);
      if (onRow === null) {
        credit("unattributed", "", column, null);
        continue;
      }
      credit("system", onRow, column, fetchedAtFor(map, row, onRow, family));
      continue;
    }

    if (family.sourceSystem !== null) {
      const system = family.sourceSystem;
      credit("system", system, column, fetchedAtFor(map, row, system, family));
      continue;
    }

    credit("derived", "", column, null);
  }

  const spine = asText(row.source_system);
  return [...groups.values()].sort((left, right) => {
    // The spine is what the row is keyed on, so it reads first.
    const leftSpine = left.kind === "system" && left.system === spine ? 0 : 1;
    const rightSpine = right.kind === "system" && right.system === spine ? 0 : 1;
    if (leftSpine !== rightSpine) return leftSpine - rightSpine;
    if (KIND_ORDER[left.kind] !== KIND_ORDER[right.kind]) {
      return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    }
    return left.system.localeCompare(right.system);
  });
}

/**
 * The same summary for an artifact that publishes no column map.
 *
 * The generated sample parquet carries all 131 columns but no KV metadata, so without this the
 * sample and every e2e run would fall back to the single spine badge that is the bug. It cannot
 * say which column each system produced, only which systems the row names, so it reports the
 * systems and leaves `columns` empty. `familyKeys` is the family list the UI already holds
 * (lib/columns.ts SOURCE_FAMILIES); it is passed in rather than imported so this module stays pure.
 */
export function fallbackRowSources(
  familyKeys: readonly string[],
  displayColumns: readonly string[],
  row: Record<string, unknown>,
): RowSource[] {
  const known = new Set(familyKeys.map((family) => `${family}_source`));
  const systems = new Map<string, unknown>();

  const spine = asText(row.source_system);
  if (spine !== null) systems.set(spine, row.fetched_at ?? null);

  /*
   * source_systems is the row's own list of every system that contributed a value to it, so where
   * the query selected it there is nothing left to infer. tenure_source is included by name because
   * the artifact documents it as "the source system that published the tenure date": it is the one
   * source column outside the family list whose value is a system rather than a basis code.
   */
  for (const entry of (asText(row.source_systems) ?? "").split(",")) {
    const system = entry.trim();
    if (system !== "" && !systems.has(system)) systems.set(system, null);
  }

  for (const column of displayColumns) {
    if (!known.has(column) && column !== "tenure_source") continue;
    const system = asText(row[column]);
    if (system === null) continue;
    const family = column.slice(0, -"_source".length);
    const fetchedAt = row[`${family}_fetched_at`] ?? null;
    if (!systems.has(system) || systems.get(system) == null) systems.set(system, fetchedAt);
  }

  return [...systems.entries()]
    .map(([system, fetchedAt]): RowSource => ({
      kind: "system",
      system,
      columns: [],
      fetchedAt,
    }))
    .sort((left, right) => {
      const leftSpine = left.system === spine ? 0 : 1;
      const rightSpine = right.system === spine ? 0 : 1;
      if (leftSpine !== rightSpine) return leftSpine - rightSpine;
      return left.system.localeCompare(right.system);
    });
}
