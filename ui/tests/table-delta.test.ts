import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableDelta } from "@/components/TableDelta";
import { parseRunHistory, summariseRun, type RunSource } from "@/lib/types";
import { tableDeltaNote } from "@/lib/writers";

/**
 * "No previous run recorded" is a third state, and the page has to be able to say it.
 *
 * The pipeline used to report the whole table as the delta when its `run_log` had no earlier run
 * of that track, which is how `water` published "inserted 0, updated 0, unchanged 757" beside
 * "table delta +757". The pipeline now publishes null for that case. Null must arrive here as
 * unknown and stay unknown: coercing it to zero, or re-deriving it from inserted + updated, would
 * put the same wrong claim back on the page from the other end.
 */

const waterFirstRun = {
  county: "duval",
  runs: [
    {
      run_id: "01M0HP2S7S6JN6AKPBNGEP87T8",
      started_at: "2026-08-21T08:13:00.538Z",
      status: "completed",
      tracks: ["water", "permits"],
      sources: [
        {
          track: "water",
          target_table: "water_bodies",
          rows_staged: 757,
          inserted: 0,
          updated: 0,
          unchanged: 757,
          table_total_after: 757,
          delta_vs_prev_total: null,
          status: "completed",
          limitations: [],
        },
        {
          track: "permits",
          target_table: "permits",
          rows_staged: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          table_total_after: null,
          delta_vs_prev_total: null,
          status: "skipped",
          limitations: ["skipped: non-US egress"],
        },
      ],
    },
  ],
};

describe("an explicitly published null delta means unknown", () => {
  it("does not fall back to inserted plus updated", () => {
    const [run] = parseRunHistory(waterFirstRun).runs;
    const water = run!.sources.find((s) => s.source === "water");
    // inserted + updated is 0 here, and 0 is a claim: it says the table did not move. The run
    // record did not say that.
    expect(water?.inserted).toBe(0);
    expect(water?.delta_vs_previous).toBeNull();
  });

  it("still derives inserted plus updated for a record that never carried the field", () => {
    const parsed = parseRunHistory({
      runs: [{ run_id: "r", sources: [{ track: "pa_detail", inserted: 252, updated: 0, limitations: [] }] }],
    });
    expect(parsed.runs[0]!.sources[0]!.delta_vs_previous).toBe(252);
  });

  it("honours an explicit null under the older field name too", () => {
    const parsed = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [{ source: "water", inserted: 0, updated: 0, delta_vs_previous: null, limitations: [] }],
        },
      ],
    });
    expect(parsed.runs[0]!.sources[0]!.delta_vs_previous).toBeNull();
  });

  it("keeps a published zero as a fact rather than folding it into unknown", () => {
    const parsed = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [{ track: "water", inserted: 5, updated: 5, delta_vs_prev_total: 0, limitations: [] }],
        },
      ],
    });
    expect(parsed.runs[0]!.sources[0]!.delta_vs_previous).toBe(0);
  });
});

describe("the run level total never adds unknown as zero", () => {
  it("is unknown when a track that did record a table total has an unknown delta", () => {
    const [run] = parseRunHistory(waterFirstRun).runs;
    expect(summariseRun(run!).tableDelta).toBeNull();
  });

  it("is unknown even when the other tracks on the run did report a number", () => {
    // The case that discriminates: summing the knowns and dropping the unknown publishes 1,782 as
    // "the table delta for this run", which is a total nobody measured. water moved the table by
    // an amount this run cannot name, so the run's total cannot be named either.
    const parsed = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [
            {
              track: "sales",
              rows_staged: 64532,
              inserted: 0,
              updated: 0,
              table_total_after: 73774,
              delta_vs_prev_total: 1782,
              status: "completed",
              limitations: [],
            },
            {
              track: "water",
              rows_staged: 757,
              inserted: 0,
              updated: 0,
              table_total_after: 757,
              delta_vs_prev_total: null,
              status: "completed",
              limitations: [],
            },
          ],
        },
      ],
    });
    expect(parsed.runs[0]!.sources.map((s) => s.delta_vs_previous)).toEqual([1782, null]);
    expect(summariseRun(parsed.runs[0]!).tableDelta).toBeNull();
  });

  it("is a number when the only unknowns are tracks that never observed a table total", () => {
    const parsed = parseRunHistory({
      runs: [
        {
          run_id: "r",
          sources: [
            {
              track: "sales",
              rows_staged: 64532,
              inserted: 0,
              updated: 0,
              table_total_after: 73774,
              delta_vs_prev_total: 1782,
              status: "completed",
              limitations: [],
            },
            {
              track: "permits",
              rows_staged: 0,
              inserted: 0,
              updated: 0,
              table_total_after: null,
              delta_vs_prev_total: null,
              status: "skipped",
              limitations: [],
            },
          ],
        },
      ],
    });
    // A track that was skipped moved nothing, so it contributes nothing; that is not the same
    // as a track that moved the table by an amount nobody can name.
    expect(summariseRun(parsed.runs[0]!).tableDelta).toBe(1782);
  });
});

describe("the table delta cell", () => {
  const base: RunSource = {
    source: "water",
    status: "completed",
    rows_fetched: 757,
    inserted: 0,
    updated: 0,
    unchanged: 757,
    delta_vs_previous: null,
    target_table: "water_bodies",
    table_total_after: 757,
    artifact_sha256: null,
    source_url: null,
    limitations: [],
  };

  const html = (source: RunSource, note?: string | null) =>
    renderToStaticMarkup(createElement(TableDelta, { source, note }));

  it("says there is no previous run rather than printing a signed number", () => {
    const rendered = html(base);
    expect(rendered).toContain("no previous run recorded");
    expect(rendered).toContain("text-muted");
    expect(rendered).not.toContain("+757");
    expect(rendered).not.toContain(">0<");
  });

  it("still renders the signed number when the delta is known", () => {
    expect(html({ ...base, delta_vs_previous: 1782 })).toContain("+1,782");
    expect(html({ ...base, delta_vs_previous: 0 })).toContain(">0<");
  });

  it("does not claim a missing previous run for a track that never observed a table total", () => {
    const skipped = html({ ...base, status: "skipped", table_total_after: null });
    expect(skipped).not.toContain("no previous run recorded");
    expect(skipped).toContain("not available");
  });

  it("carries the writer note alongside a known delta exactly as before", () => {
    expect(html({ ...base, delta_vs_previous: 1782 }, "Moved by another writer.")).toContain(
      "Moved by another writer.",
    );
  });
});

describe("the table delta note", () => {
  const source: RunSource = {
    source: "water",
    status: "completed",
    rows_fetched: 757,
    inserted: 0,
    updated: 0,
    unchanged: 757,
    delta_vs_previous: null,
    target_table: "water_bodies",
    table_total_after: 757,
    artifact_sha256: null,
    source_url: null,
    limitations: [],
  };

  it("says nothing about another writer when the delta itself is unknown", () => {
    // The note explains a move. An unknown delta is not a move, and "another writer moved it"
    // would be an explanation of something nobody measured.
    expect(tableDeltaNote(source, { table: "water_bodies", writers: ["COJ"] })).toBeNull();
  });
});
