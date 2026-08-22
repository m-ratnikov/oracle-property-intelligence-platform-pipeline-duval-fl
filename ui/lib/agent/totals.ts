/**
 * Totals are claims, and a claim without a receipt does not get printed.
 *
 * The defect this exists for: asked for "strong candidates" over four signals the model wrote a
 * scored OR query, then narrated its row count as though it were the four way AND. The number it
 * printed (357,350) was larger than the whole universe of one of its own conditions
 * (owner_region_class = 'REGIONAL' is 34,649 rows of 404,023), so it was impossible on its face,
 * and the true conjunction was 5,441. No wording in a system prompt makes that impossible; it only
 * makes it less likely, and "less likely" is not a property you can show a reviewer.
 *
 * So the guarantee is moved out of the prompt and into the boundary between the model and the
 * reader. Stated precisely, in two halves that have to be read together:
 *
 *   A numeral the answer presents as a population count is one this turn computed AS a population
 *   count.
 *
 * 1. WHAT COUNTS AS A CLAIM is decided by failing closed. Any integer above MIN_POPULATION_COUNT is
 *    a population claim unless it is demonstrably something else: an amount of money, a
 *    unit qualified measurement, a year, a street number, an identifier, an operand inside a
 *    condition, or a per row cell in an evidence table. The earlier version worked the other way
 *    round, asking whether the numeral matched a phrasing it recognised, which meant every
 *    phrasing nobody had thought of was unguarded. "The scored population is 357,350." was such a
 *    phrasing.
 * 2. WHAT CAN BACK A CLAIM is role separated. A count a tool computed and registered as a
 *    CountClaim can back one. A number a tool stated in words AS a count ("404,023 rows") can back
 *    one, because the same reading is applied to tool prose and to the answer, so anything a tool
 *    said the model may repeat. A per row cell value cannot back one: market_value 357,350 is a
 *    real number the turn saw, but it is not a count of parcels, and with 200 rows times many
 *    numeric columns a collision between a fabricated total and some cell is not far fetched.
 *
 * Every count a tool computes is additionally registered with the SHAPE of the predicate that
 * produced it. A count whose predicate is a disjunction or a score threshold is not a conjunction
 * count, is never handed back under the name `total_matched`, and keeps its predicate stapled to it
 * wherever it appears in the prose, so the count cannot be read apart from what it counted.
 *
 * The result is not "the model is told to be careful". It is that prose totals are a rendering of
 * tool output, and a numeral with no tool output behind it has nothing to render.
 */

/** What a count's predicate actually was, which is what decides how it may be described. */
export type CountShape =
  /** A plain AND of conditions: this count IS the number of rows meeting all of them. */
  | "conjunction"
  /** No WHERE at all: the count is every row in the view, which is exact and has no criteria to misattribute. */
  | "unfiltered"
  /** An OR appears in the predicate: the row count is not a count of rows meeting every condition. */
  | "disjunction"
  /** A CASE based score with a threshold: the row count is a count at that score, not at full score. */
  | "scored"
  /** Aggregated or grouped: the row count is the number of result rows, not a population. */
  | "aggregate"
  /** The statement could not be classified, so it is not allowed to claim conjunction semantics. */
  | "unknown";

export interface CountClaim {
  /** The integer the database returned. */
  value: number;
  /** What the number counts, in the reader's language. Rendered beside the value. */
  counts: string;
  /** The exact statement that produced the value. This is the receipt. */
  sql: string;
  shape: CountShape;
  /** Which tool computed it. */
  tool: string;
}

/**
 * How a count of each shape may be described, in the words handed back to the model.
 *
 * These are returned as tool output rather than written into the system prompt because the prompt
 * caches once and the shape is a property of the statement the model just wrote. Telling it here
 * means the correction arrives attached to the number it is about.
 */
export const COUNT_SEMANTICS: Record<CountShape, string> = {
  conjunction:
    "The predicate is a plain AND of conditions, so this count IS the number of rows meeting all of them. It may be reported as the total matched.",
  unfiltered:
    "The statement has no WHERE clause, so this is every row in the view. It may be reported as a total, but say that no criteria were applied.",
  disjunction:
    "The predicate contains OR, so this is the number of rows the statement selects and NOT the number of rows meeting every stated condition. Do not report it as the total matched. To get that total, run one statement whose WHERE clause ANDs the conditions, or call count_criteria, which computes both and labels them.",
  scored:
    "This statement scores or ranks rows rather than requiring every condition, so its row count is the number of rows at the score threshold used, NOT the number meeting all conditions. Say the scoring rule in words and report the per score counts from count_criteria instead of presenting this as the total matched.",
  aggregate:
    "This statement has no row filter or groups rows, so the count describes the whole table or a group, not a set of rows meeting stated criteria.",
  unknown:
    "The predicate could not be classified as a plain AND of conditions, so its row count must not be reported as the number of rows meeting all stated criteria. Run an explicit conjunction count, or call count_criteria.",
};

/** How to name a shape inside a sentence about what a count counted. */
export const SHAPE_IN_WORDS: Record<CountShape, string> = {
  conjunction: "a plain AND of conditions",
  unfiltered: "absent, so this is every row in the view",
  disjunction: "not a plain AND, because it contains OR",
  scored: "a score, not a requirement that every condition holds",
  aggregate: "aggregated or grouped, so this counts result rows and not parcels",
  unknown: "not classifiable as a plain AND of conditions",
};

/** Short tag stapled to a non conjunction count where it appears in the prose. */
const SHAPE_TAG: Record<CountShape, string | null> = {
  conjunction: null,
  unfiltered: null,
  disjunction: "rows selected by a predicate containing OR, not a count of rows meeting every criterion",
  scored: "rows at a score threshold, not a count of rows meeting every criterion",
  aggregate: "a grouped or aggregated result, not a criteria count",
  unknown: "an unclassified predicate, not a verified conjunction count",
};

/** Everything after the statement's own WHERE, stopping at the first clause that ends it. */
function whereClauseOf(statement: string): string | null {
  const upper = statement.toUpperCase();
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    if (inString) {
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (start === -1 && upper.startsWith("WHERE", index) && !/[A-Z0-9_]/.test(upper[index + 5] ?? " ")) {
        start = index + 5;
      } else if (start !== -1) {
        for (const stop of ["GROUP BY", "ORDER BY", "HAVING", "WINDOW", "LIMIT", "QUALIFY"]) {
          if (upper.startsWith(stop, index)) return statement.slice(start, index);
        }
      }
    }
  }
  return start === -1 ? null : statement.slice(start);
}

/** Strip CASE expressions so their internal ORs and ANDs do not decide the shape of the predicate. */
function withoutCaseExpressions(text: string): string {
  return text.replace(/\bCASE\b[\s\S]*?\bEND\b/gi, " CASE_EXPR ");
}

/**
 * Classify the statement whose row count is being taken.
 *
 * Deliberately conservative: anything not provably a plain AND of conditions is refused conjunction
 * semantics. The cost of being wrong in that direction is one extra tool call. The cost of being
 * wrong in the other direction is the defect this module exists for.
 *
 * Pass the model's own statement (or a bare predicate), not the COUNT wrapper built around it: the
 * wrapper puts the interesting WHERE one paren deep, where a depth aware scan will not see it.
 */
export function classifyCountShape(statement: string): CountShape {
  const trimmed = statement.trim();
  if (!trimmed) return "unknown";
  // A scoring rule is usually a sum of CASE expressions, and it can live in the SELECT list, in a
  // CTE, or in an outer WHERE over a score alias, so look for it across the whole statement.
  if (/\bCASE\b[\s\S]*?\bTHEN\b\s*1\b/i.test(trimmed) || /\bIF\s*\([^)]*,\s*1\s*,\s*0\s*\)/i.test(trimmed)) {
    return "scored";
  }
  // A grouped or aggregated statement's row count is a count of result rows, which was never a
  // population count even before this module existed.
  if (
    /\bGROUP\s+BY\b/i.test(trimmed) ||
    /\bHAVING\b/i.test(trimmed) ||
    /\b(?:COUNT|SUM|AVG|MIN|MAX|MEDIAN|QUANTILE|ARRAY_AGG|STRING_AGG|LIST)\s*\(/i.test(trimmed)
  ) {
    return "aggregate";
  }
  return shapeOfPredicate(trimmed);
}

/** The shape of the row filter alone, ignoring what the statement then does with the rows. */
function shapeOfPredicate(trimmed: string): CountShape {
  const looksLikeStatement = /\bSELECT\b/i.test(trimmed);
  const where = whereClauseOf(trimmed);
  if (where === null) {
    // A bare predicate with no SELECT around it (a preset's WHERE clause) versus a statement that
    // genuinely has no filter. The first is a predicate to classify; the second selects every row.
    if (looksLikeStatement) return "unfiltered";
    return /\bOR\b/i.test(withoutCaseExpressions(trimmed)) ? "disjunction" : "conjunction";
  }
  const bare = withoutCaseExpressions(where);
  if (!bare.trim()) return "unfiltered";
  if (/\bOR\b/i.test(bare)) return "disjunction";
  return "conjunction";
}

/**
 * The shape to attach to a number a COUNT(*) statement returned in its result row.
 *
 * `SELECT COUNT(*) AS total FROM properties WHERE a AND b` is the honest way to get a total, and
 * classifyCountShape calls it an aggregate because its ROW count (one) is not a population. The
 * value inside that row is a population count, and its shape is the shape of the WHERE that
 * produced it. This is what lets a hand written COUNT still arrive with a receipt.
 */
export function aggregateValueShape(statement: string): CountShape {
  const trimmed = statement.trim();
  if (!trimmed) return "unknown";
  if (/\bCASE\b[\s\S]*?\bTHEN\b\s*1\b/i.test(trimmed)) return "scored";
  // A grouped count is per group, and which group a number belongs to is not recoverable here.
  if (/\bGROUP\s+BY\b/i.test(trimmed) || /\bHAVING\b/i.test(trimmed)) return "aggregate";
  return shapeOfPredicate(trimmed);
}

/** Result column names whose value is a population count rather than some other statistic. */
export const COUNT_COLUMN = /(^|_)(count|total|totals|parcels|properties|rows|matched|matching|n)($|_)/i;

/**
 * The value that may be handed back under the name `total_matched`.
 *
 * Only shapes whose row count is an exact, unambiguous count of parcels qualify. Everything else
 * gets null, so the field cannot carry a number that did not match what its name says it matched.
 */
export function conjunctionTotal(shape: CountShape, value: number | null): number | null {
  return shape === "conjunction" || shape === "unfiltered" ? value : null;
}

/** An integer, with or without thousands separators. */
const NUMERAL = /\d{1,3}(?:,\d{3})+|\d+/g;

/**
 * Above this, a numeral in the prose cannot be a description of what the answer printed.
 *
 * No tool in this agent returns more than 200 rows, so any population count above 200 is
 * necessarily a claim about rows the model never saw, and therefore has to have come from a
 * computed total. Below it the numeral is a threshold, a year, a per row value or a count of the
 * rows in the table right there on the page, all of which the reader can check against the answer
 * itself, and redacting them would damage true answers to buy nothing.
 */
export const MIN_POPULATION_COUNT = 200;

// ---------------------------------------------------------------------------
// Reading a numeral: is this one a population count?
// ---------------------------------------------------------------------------

/**
 * The count noun has to be the word right after the numeral, optionally through one adjective.
 * "1998 for 12 properties" must not read as a claim that 1998 properties matched.
 *
 * This is no longer what DECIDES that a numeral is a claim: it now only OVERRIDES the exclusions
 * below, so that "more than 5,441 properties" is read as a count even though it follows an
 * operator. A numeral with no count noun near it is still a claim; it simply has to survive the
 * exclusions to be left alone.
 */
const COUNT_NOUN_AFTER =
  /^\s*(?:total\s+|matching\s+|matched\s+|more\s+|other\s+|such\s+|distinct\s+|unique\s+)?(properties|property|parcels|parcel|rows|row|records|record|folios|folio|matches)\b/i;

/** Or the numeral is introduced as a total: "Total matched: 357,350", "a total of 5,441", "8 of 5,441". */
const COUNT_PHRASE_BEFORE =
  /(?:\btotals?(?:\s+matched)?\s*(?:of|is|are|:|=)?\s*|\bmatched\s*(?:of|:|=)?\s*|\bmatching\s*(?:of|:)?\s*|\bcounts?\s*(?:of|:|=)?\s*|\bout\s+of\s+|\bof\s+)$/i;

/** The last few words before the numeral, with underscores read as spaces so `market_value` reads as words. */
function wordsBefore(before: string, howMany: number): string[] {
  const words = before.replace(/_/g, " ").toLowerCase().match(/[a-z$]+/g);
  return words ? words.slice(-howMany) : [];
}

/**
 * Words that make the numeral beside them an amount of money.
 *
 * Kept to words that appear in this dataset's own column names (market_value, just_value,
 * assessed_value, sale_price) so that a sentence about the tax roll does not accidentally read as a
 * sentence about money and escape the gate. "tax", "revenue" and the like are deliberately absent
 * for that reason.
 */
const MONEY_WORDS = new Set([
  "$",
  "usd",
  "value",
  "values",
  "valued",
  "price",
  "prices",
  "cost",
  "amount",
  "assessed",
  "appraised",
  "worth",
  "paid",
  "sold",
]);

/** Words after which a numeral is an identifier the reader looks up, not a population. */
const IDENTIFIER_WORDS = new Set([
  "folio",
  "id",
  "ids",
  "identifier",
  "parcel",
  "property",
  "zip",
  "postal",
  "cid",
  "run",
  "account",
  "apn",
  "sha",
  "version",
]);

/** A unit right after the numeral makes it a measurement: "800 m", "1,250 sq ft", "12 acres". */
const UNIT_AFTER =
  /^\s*(?:m|km|mi|ft|meters?|metres?|kilometers?|kilometres?|miles?|feet|sq\s?ft|sqft|acres?|%|percent|percentage|degrees?)\b/i;

/** A duration right after the numeral: "15 years", "90 days". */
const DURATION_AFTER = /^\s*(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|ms)\b/i;

/**
 * A street number: the numeral opens an address that ends in a street type.
 *
 * Taken from real answers, which cite parcels in prose as well as in tables ("829 S 1ST ST",
 * "4212 IRVINGTON AVE"). Without this the fail closed default would delete house numbers.
 */
const STREET_AFTER =
  /^\s+[A-Za-z0-9#'.\-/ ]{0,40}\b(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|WAY|PL|PLACE|TER|TERRACE|CIR|CIRCLE|HWY|PKWY|TRL|TRAIL|LOOP|SQ|PT|POINT)\b/i;

function isMoney(before: string, after: string): boolean {
  if (/[$£€]\s*$/.test(before)) return true;
  if (/^\s*(?:dollars|usd)\b/i.test(after)) return true;
  return wordsBefore(before, 3).some((word) => MONEY_WORDS.has(word));
}

/** A four digit numeral in the calendar range, written without separators, is a year. */
function isYear(raw: string, value: number): boolean {
  return raw.length === 4 && !raw.includes(",") && value >= 1500 && value <= 2100;
}

function isIdentifier(raw: string, before: string): boolean {
  if (/#\s*$/.test(before)) return true;
  // A leading zero is a folio, an account or a padded code. A count is never written that way.
  if (raw.length > 1 && raw.startsWith("0")) return true;
  // "JACKSONVILLE FL 32202": five digits straight after a two letter state code is a postcode.
  if (raw.length === 5 && !raw.includes(",") && /\b[A-Z]{2}\s+$/.test(before)) return true;
  return wordsBefore(before, 2).some((word) => IDENTIFIER_WORDS.has(word));
}

/**
 * The numeral is the right hand side of a condition rather than a stated count.
 *
 * This is what protects thresholds in prose ("nearest_transit_stop_m <= 800") and literals in
 * quoted SQL, and it is why a model cannot launder a number by writing it into a WHERE clause and
 * then citing the echoed statement.
 */
function isOperand(before: string): boolean {
  return /[<>=+\-*/^%≤≥]\s*$/.test(before);
}

/**
 * Markdown code regions to leave alone, but only the ones that are demonstrably code.
 *
 * Skipping code exists to protect quoted SQL and column names from being rewritten. It said nothing
 * about a bare numeral in backticks, which is not code but a number with emphasis on it, and
 * treating the backticks alone as a reason to skip turned them into a laundering channel: a
 * measured `357,350` reached the reader verbatim. So a region is skipped only when it carries
 * evidence of being code, and `357,350` on its own carries none.
 */
const CODE_EVIDENCE =
  /\b(?:select|from|where|group|order|having|limit|offset|join|case|when|then|else|end|count|sum|avg|min|max|cast|extract|and|or|not|null|as|with|filter|over|between|like|in)\b|[()<>=;*+/[\]{}]|[A-Za-z]_[A-Za-z]/i;

function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) {
    if (!CODE_EVIDENCE.test(match[0])) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** A markdown table column whose header says its cells are counts of rows rather than row values. */
const COUNT_HEADER = /\b(?:count|counts|total|totals|parcels|properties|rows|records|matched|matching|n)\b/i;

/** Cells of one markdown table line, as absolute character ranges, outer pipes dropped. */
function cellsOf(line: string, offset: number): Array<{ start: number; end: number; text: string }> {
  const cells: Array<{ start: number; end: number; text: string }> = [];
  let cellStart = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index === line.length || (line[index] === "|" && line[index - 1] !== "\\")) {
      cells.push({ start: offset + cellStart, end: offset + index, text: line.slice(cellStart, index) });
      cellStart = index + 1;
    }
  }
  if (cells.length > 0 && cells[0].text.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].text.trim() === "") cells.pop();
  return cells;
}

/**
 * The ranges of markdown table cells whose column is per row evidence rather than counts.
 *
 * A parcel table is the evidence the answer rests on: its market values, distances and house
 * numbers are properties of the row they sit on, printed next to the parcel they belong to, and the
 * reader checks them there. Reading them as population claims would delete most of a correct
 * answer. A summary table is a different object, and its Parcels or Count column is gated like any
 * other number, which is what keeps the score breakdown honest.
 */
function recordCellRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines: Array<{ text: string; start: number }> = [];
  let at = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line, start: at });
    at += line.length + 1;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const delimiter = lines[index].text;
    // The row of dashes is what makes the lines around it a table rather than prose with pipes.
    if (!/^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(delimiter) || !lines[index - 1].text.includes("|")) continue;
    const header = cellsOf(lines[index - 1].text, lines[index - 1].start);
    ranges.push([lines[index - 1].start, lines[index].start + delimiter.length]);
    for (let row = index + 1; row < lines.length && lines[row].text.includes("|"); row += 1) {
      for (const [column, cell] of cellsOf(lines[row].text, lines[row].start).entries()) {
        if (COUNT_HEADER.test(header[column]?.text ?? "")) continue;
        ranges.push([cell.start, cell.end]);
      }
      index = row;
    }
  }
  return ranges;
}

/** A numeral in some text that reads as a count of a population. */
export interface PopulationClaim {
  start: number;
  end: number;
  /** The numeral as written, separators and all. */
  text: string;
  value: number;
}

/**
 * Every numeral in `text` that reads as a population count.
 *
 * The default is that a large integer IS a claim; the list below is the set of things it can
 * demonstrably be instead. That direction is the whole point: an unanticipated sentence now fails
 * closed and loses its number, where before an unanticipated sentence was simply not inspected.
 *
 * The same function is applied to the answer and to prose a tool returned, which is what lets a
 * dataset fact a tool stated in words ("404,023 rows") back the model repeating it.
 */
export function findPopulationClaims(text: string): PopulationClaim[] {
  const code = codeRanges(text);
  const recordCells = recordCellRanges(text);
  const claims: PopulationClaim[] = [];
  const within = (ranges: Array<[number, number]>, index: number) =>
    ranges.some(([from, to]) => index >= from && index < to);

  for (const match of text.matchAll(NUMERAL)) {
    const start = match.index;
    const end = start + match[0].length;
    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= MIN_POPULATION_COUNT) continue;
    if (within(code, start)) continue;

    const before = text.slice(Math.max(0, start - 48), start);
    const after = text.slice(end, end + 48);
    const named = COUNT_NOUN_AFTER.test(after) || COUNT_PHRASE_BEFORE.test(before);

    // A cell in an evidence table is a row value unless it says otherwise in the cell itself.
    if (!named && within(recordCells, start)) continue;
    // Part of a longer token (a date, an identifier, a decimal) rather than a standalone number.
    // A dot or comma only continues a token when a digit sits on the other side of it: the period
    // that ends a sentence must not hide the numeral in front of it, which is where "The scored
    // population is 357,350." would otherwise slip through the same crack twice.
    if (/[\w-]$/.test(before) || /\d[.,]$/.test(before)) continue;
    if (!named && (/^[\w-]/.test(after) || /^[.,]\d/.test(after))) continue;

    if (!named) {
      if (isMoney(before, after)) continue;
      if (UNIT_AFTER.test(after) || DURATION_AFTER.test(after)) continue;
      if (isYear(match[0], value)) continue;
      if (isIdentifier(match[0], before)) continue;
      if (isOperand(before)) continue;
      if (STREET_AFTER.test(after)) continue;
    }
    claims.push({ start, end, text: match[0], value });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The allow list: which numbers a tool returned may back a claim
// ---------------------------------------------------------------------------

/**
 * Keys under which a tool returns a COUNT OF ROWS.
 *
 * The old rule was that any number a tool emitted anywhere could back a population claim, which
 * meant a fabricated total colliding with any per row cell passed. These names are the ones that
 * say, in the tool's own contract, that the value beneath them counts rows.
 */
const COUNT_ROLE_FIELD =
  /(^|_)(count|counts|cnt|total|totals|rows|records|parcels|properties|folios|matched|matching|universe|inserted|updated|unchanged|delta|n|num)($|_)/i;

/**
 * Keys naming a measured quantity, which veto the above.
 *
 * `total_value` and `total_area` say "total" and are not counts of anything. Matching by whole
 * underscore separated segment rather than by substring, so "updated" is not read as "date".
 */
const MEASURED_FIELD =
  /(^|_)(value|values|amount|price|cost|area|sqft|acres|distance|m|km|ft|mi|year|years|date|at|id|ids|pct|percent|percentage|ratio|score|lat|lon|lng|cid|ms|len|length|width|height)($|_)/i;

/**
 * Keys whose value is a per parcel record payload.
 *
 * Inside one of these the column names are chosen by the model's own SELECT, so a name alone
 * carries no authority. The one exception is a genuine aggregate: `SELECT owner_region_class,
 * COUNT(*) AS n ... GROUP BY 1` returns counts in rows, and the enclosing output says so through
 * count_shape, which the model cannot fake by aliasing a literal because classifyCountShape only
 * calls a statement an aggregate when it groups or applies an aggregate function.
 */
const RECORD_PAYLOAD = /^(rows?|evidence|document|open_data)$/i;

/**
 * Keys whose string value is text the MODEL wrote and a tool echoed back.
 *
 * An echoed statement is a receipt, not an assertion by the tool, so a numeral inside it must not
 * become permission to print that numeral as a count.
 */
const MODEL_AUTHORED = /^(sql|count_sql|query|expression|predicate|input|criteria)$/i;

function isCountRoleKey(key: string): boolean {
  return COUNT_ROLE_FIELD.test(key) && !MEASURED_FIELD.test(key);
}

const HARVEST_NODE_BUDGET = 200_000;

interface HarvestContext {
  /** The key this value sits under. Empty at the root. */
  key: string;
  /** True once inside a per parcel record payload. */
  inRecord: boolean;
  /** True when the enclosing tool output reported an aggregated or grouped statement. */
  aggregate: boolean;
}

/**
 * Collect the numbers a tool returned IN A COUNTING ROLE.
 *
 * This is the allow list the answer is checked against, and its rule is one line: a numeral may be
 * printed as a population count only if a tool presented that number as a count. Two ways to
 * qualify, and a per row cell value is neither: the number sits under a key that names a count, or
 * a tool stated it in words as a count, judged by the same reading applied to the answer.
 */
export function harvestNumbers(value: unknown, into: Set<number>, budget = { left: HARVEST_NODE_BUDGET }): void {
  walkForCounts(value, into, budget, { key: "", inRecord: false, aggregate: false });
}

function walkForCounts(value: unknown, into: Set<number>, budget: { left: number }, context: HarvestContext): void {
  if (budget.left <= 0) return;
  budget.left -= 1;
  if (typeof value === "number" || typeof value === "bigint") {
    const numeric = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isFinite(numeric)) return;
    if (context.inRecord && !context.aggregate) return;
    if (isCountRoleKey(context.key)) into.add(numeric);
    return;
  }
  if (typeof value === "string") {
    if (context.inRecord || MODEL_AUTHORED.test(context.key)) return;
    for (const claim of findPopulationClaims(value)) into.add(claim.value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkForCounts(item, into, budget, context);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const aggregate = context.aggregate || (value as { count_shape?: unknown }).count_shape === "aggregate";
    for (const [key, item] of entries) {
      walkForCounts(item, into, budget, {
        key,
        inRecord: context.inRecord || RECORD_PAYLOAD.test(key),
        aggregate,
      });
    }
  }
}

export interface TotalsVerification {
  /** The answer with uncomputed totals removed and non conjunction totals labelled. */
  answer: string;
  /** Claims the answer actually cited, in the order they first appear. */
  cited: CountClaim[];
  /** Numerals that were removed because no tool produced them, as written. */
  unverified: string[];
}

/** Marker left where a total was removed. Deliberately not the number. */
export const REMOVED_TOTAL = "[total removed: not computed in this turn]";

/**
 * Rewrite the answer so every population count in it is backed by tool output.
 *
 * `seen` is every number a tool returned in a counting role this turn; `claims` are the counts that
 * were computed as counts, which additionally carry a shape and a receipt.
 */
export function verifyAnswerTotals(
  answer: string,
  claims: readonly CountClaim[],
  seen: ReadonlySet<number>,
): TotalsVerification {
  const cited: CountClaim[] = [];
  const unverified: string[] = [];
  let out = "";
  let cursor = 0;

  for (const found of findPopulationClaims(answer)) {
    out += answer.slice(cursor, found.start);
    cursor = found.end;

    // Prefer a conjunction claim when several claims share a value: it is the least disruptive
    // reading and, the values being equal, the honest one.
    const claim =
      claims.find((entry) => entry.value === found.value && entry.shape === "conjunction") ??
      claims.find((entry) => entry.value === found.value);

    if (!claim && !seen.has(found.value)) {
      unverified.push(found.text);
      out += REMOVED_TOTAL;
      continue;
    }
    out += found.text;
    if (claim) {
      if (!cited.includes(claim)) cited.push(claim);
      const tag = SHAPE_TAG[claim.shape];
      // Staple the predicate to the number so the two cannot be read apart.
      if (tag && !answer.slice(found.end).startsWith(` (${tag}`)) out += ` (${tag})`;
    }
  }
  out += answer.slice(cursor);
  return { answer: out, cited, unverified };
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Collapse a statement to one line so it fits a table cell without breaking the row. */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * The counts the answer cited, rendered as a table with the statement that produced each one.
 *
 * This is the "never detached from its predicate" half. A reader who wants to check the headline
 * number does not have to trust the prose around it: the query is on the page next to it.
 */
export function formatCountLedger(cited: readonly CountClaim[], unverified: readonly string[]): string {
  const lines: string[] = [];
  if (cited.length > 0) {
    lines.push("### Counts in this answer");
    lines.push("");
    lines.push("| Count | What it counts | Query that produced it |");
    lines.push("| ---: | --- | --- |");
    for (const claim of cited) {
      lines.push(`| ${formatCount(claim.value)} | ${claim.counts} | \`${oneLine(claim.sql)}\` |`);
    }
  }
  if (unverified.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `**${unverified.length} number${unverified.length === 1 ? "" : "s"} removed.** ${
        unverified.length === 1 ? "A total was" : "Totals were"
      } written into the answer above that no query in this turn produced, so ${
        unverified.length === 1 ? "it was" : "they were"
      } deleted rather than shown. The removed values are in \`unverified_totals\` in the response JSON, and every count that WAS computed is listed above.`,
    );
  }
  return lines.join("\n");
}
