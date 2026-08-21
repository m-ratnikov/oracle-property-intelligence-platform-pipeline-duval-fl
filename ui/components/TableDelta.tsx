"use client";

import { signedDelta } from "@/lib/format";
import type { RunSource } from "@/lib/types";

/**
 * The "table delta" cell, shared by the overview totals table and the per run source detail.
 *
 * The number on its own left a reader stuck: `sales` inserted 0, updated 0, and the table still
 * moved +1,782. The sub-line says who moved it, joined from the published coverage snapshot (see
 * lib/writers.ts). When there is nothing to add, or the coverage snapshot did not load, this
 * renders exactly what it rendered before: the signed number and nothing else.
 *
 * The third state is no number at all. A null delta is the run record saying it had no previous run
 * of this track to compare against, and the cell says so rather than print a signed number it does
 * not have: `water` published "inserted 0, updated 0, unchanged 757" beside "+757" because the
 * pipeline reported the whole table when it had nothing to subtract. Two causes, kept apart by
 * whether the run observed a table total at all:
 *
 *   total recorded, delta null -> the track merged and has nothing to compare against yet, which is
 *                                 the first run of a track, or of a whole county
 *   no total, delta null       -> the track never got as far as a merge (skipped, failed), so there
 *                                 is no movement to describe and "not available" is still the word
 */
export function TableDelta({ source, note }: { source: RunSource; note?: string | null }) {
  const delta = source.delta_vs_previous;
  const noPreviousRun = delta === null && source.table_total_after !== null;
  return (
    <>
      {noPreviousRun ? (
        <span className="text-muted font-sans text-[11px] leading-snug" style={{ whiteSpace: "normal" }}>
          no previous run recorded
        </span>
      ) : (
        <span className={delta !== null && delta > 0 ? "text-good" : "text-muted"}>
          {signedDelta(delta)}
        </span>
      )}
      {note ? (
        <div
          className="mt-1 text-left text-[11px] font-sans leading-snug text-faint"
          style={{ whiteSpace: "normal", maxWidth: 260 }}
        >
          {note}
        </div>
      ) : null}
    </>
  );
}
