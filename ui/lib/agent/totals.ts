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
 * reader, in two halves:
 *
 * 1. Every count a tool computes is registered here as a CountClaim carrying the exact statement
 *    that produced it and the SHAPE of that statement's predicate. A count whose predicate is a
 *    disjunction or a score threshold is not a conjunction count, and it is never handed back to
 *    the model under the name `total_matched`.
 * 2. Before the answer leaves runAgent, every numeral in the prose that reads as a population count
 *    is checked against what the tools actually returned this turn. A number the tools never
 *    produced is DELETED from the answer, not flagged. A number that came from a non conjunction
 *    count keeps its predicate stapled to it, so the count cannot be read apart from what it
 *    counted.
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

/**
 * Collect every number a tool actually returned, including numbers written into prose the tool
 * returned (get_schema documents dataset facts such as 404,023 rows in its notes).
 *
 * This is the allow list the answer is checked against. Its rule is simple enough to state in one
 * line: a numeral may be printed as a population count only if the model saw it come out of a tool.
 */
const HARVEST_NODE_BUDGET = 200_000;

export function harvestNumbers(value: unknown, into: Set<number>, budget = { left: HARVEST_NODE_BUDGET }): void {
  if (budget.left <= 0) return;
  budget.left -= 1;
  if (typeof value === "number") {
    if (Number.isFinite(value)) into.add(value);
    return;
  }
  if (typeof value === "bigint") {
    into.add(Number(value));
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(NUMERAL)) {
      const parsed = Number(match[0].replace(/,/g, ""));
      if (Number.isFinite(parsed)) into.add(parsed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestNumbers(item, into, budget);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) harvestNumbers(item, into, budget);
  }
}

/** An integer, with or without thousands separators. */
const NUMERAL = /\d{1,3}(?:,\d{3})+|\d+/g;

/**
 * The count noun has to be the word right after the numeral, optionally through one adjective.
 * "1998 for 12 properties" must not read as a claim that 1998 properties matched.
 */
const COUNT_NOUN_AFTER =
  /^\s*(?:total\s+|matching\s+|matched\s+|more\s+|other\s+|such\s+|distinct\s+|unique\s+)?(properties|property|parcels|parcel|rows|row|records|record|folios|folio|matches)\b/i;

/** Or the numeral is introduced as a total: "Total matched: 357,350", "a total of 5,441", "8 of 5,441". */
const COUNT_PHRASE_BEFORE =
  /(?:\btotals?(?:\s+matched)?\s*(?:of|is|are|:|=)?\s*|\bmatched\s*(?:of|:|=)?\s*|\bmatching\s*(?:of|:)?\s*|\bcounts?\s*(?:of|:|=)?\s*|\bout\s+of\s+|\bof\s+)$/i;

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

/** Character ranges that are markdown code, where a numeral is quoted SQL and not a claim. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
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
 * `seen` is every number any tool returned this turn; `claims` are the counts that were computed
 * as counts, which additionally carry a shape and a receipt.
 */
export function verifyAnswerTotals(
  answer: string,
  claims: readonly CountClaim[],
  seen: ReadonlySet<number>,
): TotalsVerification {
  const skip = codeRanges(answer);
  const cited: CountClaim[] = [];
  const unverified: string[] = [];
  let out = "";
  let cursor = 0;

  for (const match of answer.matchAll(NUMERAL)) {
    const start = match.index;
    const end = start + match[0].length;
    if (skip.some(([from, to]) => start >= from && start < to)) continue;
    // Part of a longer token (a date, an identifier, a decimal) rather than a standalone number.
    const before = answer.slice(Math.max(0, start - 40), start);
    const after = answer.slice(end, end + 40);
    if (/[\w.,-]$/.test(before.slice(-1)) && !/[\s(:=]$/.test(before.slice(-1))) continue;
    if (/^[\w.-]/.test(after) && !COUNT_NOUN_AFTER.test(after)) continue;

    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= MIN_POPULATION_COUNT) continue;
    const isClaim = COUNT_NOUN_AFTER.test(after) || COUNT_PHRASE_BEFORE.test(before);
    if (!isClaim) continue;

    out += answer.slice(cursor, start);
    cursor = end;

    // Prefer a conjunction claim when several claims share a value: it is the least disruptive
    // reading and, the values being equal, the honest one.
    const claim =
      claims.find((entry) => entry.value === value && entry.shape === "conjunction") ??
      claims.find((entry) => entry.value === value);

    if (!claim && !seen.has(value)) {
      unverified.push(match[0]);
      out += REMOVED_TOTAL;
      continue;
    }
    out += match[0];
    if (claim) {
      if (!cited.includes(claim)) cited.push(claim);
      const tag = SHAPE_TAG[claim.shape];
      // Staple the predicate to the number so the two cannot be read apart.
      if (tag && !after.startsWith(` (${tag}`)) out += ` (${tag})`;
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
