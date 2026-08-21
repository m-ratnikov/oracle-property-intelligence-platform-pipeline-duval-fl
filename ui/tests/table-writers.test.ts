import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableDelta } from "@/components/TableDelta";
import { parseCoverage, parseRunHistory, type RunSource } from "@/lib/types";
import { otherWritersLookup, tableDeltaNote, tableDeltaNoteLookup } from "@/lib/writers";

/**
 * The question these answer: `sales` shows inserted 0, updated 0, unchanged 64,532 and a table
 * delta of +1,782. Who moved the table?
 *
 * `sales_history` has two writers, and that fact is already published in the coverage snapshot.
 * The note is a join between two artifacts the page already loads, so it renders for every run in
 * the published history, including the ones published before this line existed.
 */

/* Trimmed from the published coverage snapshot at config.coverageUrl. */
const coverage = parseCoverage({
  county: "duval",
  exportedAt: "2026-08-21T16:34:46Z",
  datasets: [
    {
      county: "duval",
      source: "appraisal",
      track: "appraisal",
      table: "parcels",
      ingested_count: 404023,
      expected_count: 404023,
    },
    {
      county: "duval",
      source: "sales",
      track: "sales",
      table: "sales_history",
      ingested_count: 64532,
      expected_count: 64532,
      table_rows_total: 73404,
      rows_from_other_tracks: 8872,
      additional_rows_by_source: { PA_DETAIL: 8872 },
    },
    {
      county: "duval",
      source: "pa_detail",
      track: "pa_detail",
      table: "pa_detail_buildings",
      ingested_count: 1332,
    },
  ],
});

/* The published run-record shape: sources are keyed by `track` and carry `target_table`. */
const history = parseRunHistory({
  county: "duval",
  runs: [
    {
      run_id: "01M0JHFY6FBNXW0523KPNP5D7Y",
      started_at: "2026-08-21 16:12:03.152",
      status: "completed",
      trigger: "workflow_dispatch",
      tracks: ["appraisal", "sales", "pa_detail"],
      sources: [
        {
          track: "appraisal",
          target_table: "parcels",
          rows_staged: 404023,
          inserted: 0,
          updated: 0,
          unchanged: 404023,
          delta_vs_prev_total: 0,
          table_total_after: 404023,
          status: "completed",
        },
        {
          track: "sales",
          target_table: "sales_history",
          rows_staged: 64532,
          inserted: 0,
          updated: 0,
          unchanged: 64532,
          delta_vs_prev_total: 1782,
          table_total_after: 71992,
          status: "completed",
        },
        {
          track: "pa_detail",
          target_table: "pa_detail_buildings",
          rows_staged: 206,
          inserted: 206,
          updated: 0,
          unchanged: 0,
          delta_vs_prev_total: 206,
          table_total_after: 1332,
          status: "completed",
        },
      ],
    },
  ],
});

const sources = history.runs[0]!.sources;
const sourceNamed = (name: string): RunSource => {
  const found = sources.find((source) => source.source === name);
  if (!found) throw new Error(`fixture has no source ${name}`);
  return found;
};

const noteFor = tableDeltaNoteLookup(coverage);

describe("the published artifacts carry everything the join needs", () => {
  it("reads the target table off a run source and off a coverage row", () => {
    expect(sourceNamed("sales").target_table).toBe("sales_history");
    const dataset = coverage.datasets.find((entry) => entry.source === "sales");
    expect(dataset?.table).toBe("sales_history");
    expect(dataset?.rows_from_other_tracks).toBe(8872);
    expect(dataset?.additional_rows_by_source).toEqual({ PA_DETAIL: 8872 });
  });

  it("names the other writers generically, from what the snapshot published", () => {
    const writers = otherWritersLookup(coverage)(sourceNamed("sales"));
    expect(writers).toEqual({ table: "sales_history", writers: ["PA_DETAIL"] });
  });

  it("joins on the track, which is not always the same string as the source", () => {
    // The live snapshot publishes { source: "hydrography", track: "water" } and three more like
    // it, while a run record names its sources by track. Joining on `source` alone misses them.
    const aliased = parseCoverage({
      datasets: [
        {
          source: "hydrography",
          track: "water",
          table: "water_bodies",
          rows_from_other_tracks: 12,
          additional_rows_by_source: { COJ_PARCELS: 12 },
        },
      ],
    });
    const waterTrack: RunSource = {
      ...sourceNamed("sales"),
      source: "water",
      target_table: "water_bodies",
    };
    expect(otherWritersLookup(aliased)(waterTrack)).toEqual({
      table: "water_bodies",
      writers: ["COJ_PARCELS"],
    });
  });
});

describe("a track that wrote nothing while its table moved", () => {
  it("says who moved it", () => {
    expect(noteFor(sourceNamed("sales"))).toBe(
      "Moved by another writer: sales_history is also written by PA_DETAIL, and this track " +
        "inserted and updated nothing this run.",
    );
  });

  it("renders under the delta, without disturbing the number", () => {
    const source = sourceNamed("sales");
    const html = renderToStaticMarkup(createElement(TableDelta, { source, note: noteFor(source) }));
    expect(html).toContain("+1,782");
    expect(html).toContain("sales_history is also written by PA_DETAIL");
    expect(html).toContain("text-faint");
  });
});

describe("a track whose own inserts account for the whole move", () => {
  it("says nothing at all", () => {
    // pa_detail inserted 206 and its table moved 206. The row explains itself.
    expect(noteFor(sourceNamed("pa_detail"))).toBeNull();
  });

  it("renders exactly the number and nothing else", () => {
    const source = sourceNamed("pa_detail");
    const html = renderToStaticMarkup(createElement(TableDelta, { source, note: noteFor(source) }));
    expect(html).toContain("+206");
    expect(html).not.toContain("written by");
  });

  it("says nothing for a table that did not move", () => {
    expect(noteFor(sourceNamed("appraisal"))).toBeNull();
  });

  it("says nothing even when the table does have another writer", () => {
    // The control that matters: sales_history has a second writer, but on this run `sales` moved
    // it by exactly what it inserted, so there is nothing to explain and no line to add.
    const selfExplaining: RunSource = {
      ...sourceNamed("sales"),
      inserted: 1782,
      updated: 0,
      delta_vs_previous: 1782,
    };
    expect(otherWritersLookup(coverage)(selfExplaining)).not.toBeNull();
    expect(noteFor(selfExplaining)).toBeNull();
  });
});

describe("a track that wrote some of the move but not all of it", () => {
  it("uses the second shape, and never asserts a direction it did not check", () => {
    const partial: RunSource = {
      ...sourceNamed("sales"),
      inserted: 400,
      updated: 100,
      delta_vs_previous: 1782,
    };
    expect(noteFor(partial)).toBe(
      "Partly another writer: sales_history is also written by PA_DETAIL, so the move does not " +
        "match the 500 rows this track wrote.",
    );

    const correction: RunSource = { ...partial, inserted: 900, delta_vs_previous: 100 };
    expect(noteFor(correction)).toContain("does not match the 1,000 rows this track wrote");
  });

  it("names several writers when the snapshot publishes several", () => {
    const three = parseCoverage({
      datasets: [
        {
          source: "sales",
          table: "sales_history",
          rows_from_other_tracks: 9000,
          additional_rows_by_source: { PA_DETAIL: 8872, COJ_PARCELS: 128 },
        },
      ],
    });
    expect(tableDeltaNoteLookup(three)(sourceNamed("sales"))).toContain(
      "written by PA_DETAIL and COJ_PARCELS",
    );
  });
});

describe("degrading to exactly what rendered before", () => {
  const source = sourceNamed("sales");

  it("says nothing when the coverage snapshot did not load", () => {
    expect(tableDeltaNoteLookup(null)(source)).toBeNull();
    expect(tableDeltaNoteLookup(parseCoverage("<html>504</html>"))(source)).toBeNull();
  });

  it("says nothing when the snapshot has no row for this track", () => {
    const other = parseCoverage({
      datasets: [{ source: "permits", table: "permits", rows_from_other_tracks: 5 }],
    });
    expect(tableDeltaNoteLookup(other)(source)).toBeNull();
  });

  it("says nothing when the table has no rows from other tracks", () => {
    const alone = parseCoverage({
      datasets: [{ source: "sales", table: "sales_history", rows_from_other_tracks: 0 }],
    });
    expect(tableDeltaNoteLookup(alone)(source)).toBeNull();

    const older = parseCoverage({ datasets: [{ source: "sales", table: "sales_history" }] });
    expect(tableDeltaNoteLookup(older)(source)).toBeNull();
  });

  it("says nothing when the writer list is empty or only names this track", () => {
    const selfOnly = parseCoverage({
      datasets: [
        {
          source: "sales",
          table: "sales_history",
          rows_from_other_tracks: 8872,
          additional_rows_by_source: { SALES: 8872 },
        },
      ],
    });
    expect(tableDeltaNoteLookup(selfOnly)(source)).toBeNull();
  });

  it("says nothing when the two artifacts disagree about the table", () => {
    // A disagreement is not evidence. Attributing this row's writers to a different table would
    // be inventing the explanation rather than reading it.
    const mismatched = parseCoverage({
      datasets: [
        {
          source: "sales",
          table: "some_other_table",
          rows_from_other_tracks: 8872,
          additional_rows_by_source: { PA_DETAIL: 8872 },
        },
      ],
    });
    expect(tableDeltaNoteLookup(mismatched)(source)).toBeNull();
  });

  it("still joins on the track name when an older run record has no target_table", () => {
    const older: RunSource = { ...source, target_table: null };
    expect(noteFor(older)).toContain("sales_history is also written by PA_DETAIL");
  });

  it("says nothing when the delta itself is absent", () => {
    expect(
      tableDeltaNote({ ...source, delta_vs_previous: null }, { table: "t", writers: ["X"] }),
    ).toBeNull();
  });
});
