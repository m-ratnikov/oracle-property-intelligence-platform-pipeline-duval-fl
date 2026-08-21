/**
 * Who moved a table a track did not write to.
 *
 * A reader looking at the totals table asked a fair question: `sales` shows inserted 0, updated 0,
 * unchanged 64,532 and a table delta of +1,782. The number is right and the column description is
 * right. The row just does not say who moved the table.
 *
 * The answer is that `sales_history` has two writers. Nothing in a run record says that, and
 * nothing should: it is a property of the table, not of the run, and it is already published in
 * the coverage snapshot, per dataset:
 *
 *   { source: "sales", table: "sales_history",
 *     table_rows_total: 73404, rows_from_other_tracks: 8872,
 *     additional_rows_by_source: { "PA_DETAIL": 8872 } }
 *
 * So the explanation is a join between two artifacts that are already on the page, not a new
 * pipeline field. That matters beyond tidiness: a new field would only ever describe runs
 * published after it shipped, and this has to read correctly for the 29 runs already in the
 * published history.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. The exact chain is recoverable: a run's `sales` delta equals
 * the previous run's `pa_detail` fold into sales_history. But it is only recoverable by matching a
 * `notes.salesHistoryMerge` key, a private shape that no consumer contract covers and that the
 * next pipeline change may rename. Naming a row count and a specific prior run on the strength of
 * that would be precision this page cannot stand behind, so the note says the table has another
 * writer and names it, and stops there.
 */

import type { CoverageDataset, CoverageSnapshot, RunSource } from "./types";
import { formatInt } from "./format";

export interface OtherWriters {
  /** The target table, named as the coverage snapshot names it. */
  table: string;
  /** Writer labels exactly as `additional_rows_by_source` publishes them. */
  writers: string[];
}

/** How much of the table's movement this track can account for on its own. */
function ownMovement(source: RunSource): number {
  return (source.inserted ?? 0) + (source.updated ?? 0);
}

/**
 * Build the lookup once per page from the one coverage fetch the page already makes, not once per
 * row.
 *
 * The join is the track name, guarded by the target table. A coverage row's
 * `rows_from_other_tracks` is scoped to that row's own track, so reading it from a row belonging
 * to a different track would attribute someone else's writers to this one. Requiring both to
 * agree makes that impossible; where a published artifact is old enough to omit `target_table`
 * the track name alone still joins.
 *
 * A coverage row is indexed under BOTH its `track` and its `source`, because the snapshot does not
 * always use the same string for the two (`{ source: "hydrography", track: "water" }`) and a run
 * record names its sources by track. Indexing on `source` alone silently misses hydrography,
 * sunbiz, entity_links and addresses: four of the thirteen datasets.
 */
export function otherWritersLookup(
  coverage: CoverageSnapshot | null,
): (source: RunSource) => OtherWriters | null {
  if (coverage === null || coverage.datasets.length === 0) return () => null;

  const byTrack = new Map<string, CoverageDataset>();
  for (const dataset of coverage.datasets) {
    if (dataset.track !== null) byTrack.set(dataset.track, dataset);
    if (!byTrack.has(dataset.source)) byTrack.set(dataset.source, dataset);
  }

  return (source: RunSource): OtherWriters | null => {
    const dataset = byTrack.get(source.source);
    if (dataset === undefined) return null;
    const table = dataset.table ?? source.target_table;
    if (table === null) return null;
    // Two artifacts describing different tables is a disagreement, not evidence. Say nothing.
    if (source.target_table !== null && dataset.table !== null && source.target_table !== dataset.table) {
      return null;
    }
    if ((dataset.rows_from_other_tracks ?? 0) <= 0) return null;

    const writers = Object.entries(dataset.additional_rows_by_source ?? {})
      .filter(([name, rows]) => rows > 0 && name.toLowerCase() !== source.source.toLowerCase())
      .map(([name]) => name);
    if (writers.length === 0) return null;

    return { table, writers };
  };
}

function list(writers: string[]): string {
  if (writers.length === 1) return writers[0]!;
  return `${writers.slice(0, -1).join(", ")} and ${writers[writers.length - 1]!}`;
}

/**
 * The muted sub-line under a table delta, or null when the row already explains itself.
 *
 * Two shapes, because the row has two: a track that wrote nothing at all and watched the table
 * move, and a track that wrote some of the move but not all of it.
 */
export function tableDeltaNote(source: RunSource, others: OtherWriters | null): string | null {
  if (others === null) return null;
  const delta = source.delta_vs_previous;
  // Unknown (null: no previous run of this track recorded) and zero both leave nothing to explain.
  // The note accounts for a MOVE, and neither of those is a move this page measured.
  if (delta === null || delta === 0) return null;
  const own = ownMovement(source);
  if (own === delta) return null;

  const alsoWritten = `${others.table} is also written by ${list(others.writers)}`;
  if (own === 0) {
    return `Moved by another writer: ${alsoWritten}, and this track inserted and updated nothing this run.`;
  }
  // Neutral in both directions: the move is usually larger than this track's own, but a
  // correction can make it smaller, and the note must not assert a direction it did not check.
  return `Partly another writer: ${alsoWritten}, so the move does not match the ${formatInt(own)} rows this track wrote.`;
}

/** The whole thing, as a page uses it: one coverage snapshot in, a note per source row out. */
export function tableDeltaNoteLookup(
  coverage: CoverageSnapshot | null,
): (source: RunSource) => string | null {
  const writersOf = otherWritersLookup(coverage);
  return (source: RunSource) => tableDeltaNote(source, writersOf(source));
}
