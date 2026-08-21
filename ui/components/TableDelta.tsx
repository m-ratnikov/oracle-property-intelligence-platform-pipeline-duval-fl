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
 */
export function TableDelta({ source, note }: { source: RunSource; note?: string | null }) {
  return (
    <>
      <span className={(source.delta_vs_previous ?? 0) > 0 ? "text-good" : "text-muted"}>
        {signedDelta(source.delta_vs_previous)}
      </span>
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
