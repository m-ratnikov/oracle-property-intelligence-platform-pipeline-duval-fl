import { describe, expect, it } from "vitest";
import { nextAddressWatermark, WATERMARK_HELD_RUNS_BUDGET } from "../src/tracks/coj_addresses.js";

/**
 * Defect: the EDIT_DATE watermark advanced over ground the pull never covered.
 *
 * The track set the cursor to max(edit_date) whatever happened, including on runs where pages had
 * failed or COJ_MAX_PAGES had truncated the pull. The next run then asks for
 * `EDIT_DATE >= cursor`, so every address edit that sat in a skipped page is never fetched again -
 * a permanent, silent hole. The information was already there: line 123 computed `partial` from the
 * same two conditions and used it only to scope the merge.
 */

const base = { maxEdit: "2026-08-21T10:00:00", previous: "2026-08-01T00:00:00", bounded: false, pageErrors: 0, heldRuns: 0 };

describe("nextAddressWatermark", () => {
  it("advances over a complete pull, because a complete pull covered the whole window", () => {
    const d = nextAddressWatermark(base);
    expect(d).toMatchObject({ advance: true, watermark: "2026-08-21T10:00:00", heldRuns: 0, limitation: null });
  });

  it("holds when pages failed, so the next run re-pulls the same window", () => {
    const d = nextAddressWatermark({ ...base, pageErrors: 2 });

    expect(d.advance).toBe(false);
    expect(d.watermark).toBe("2026-08-01T00:00:00");
    expect(d.heldRuns).toBe(1);
    expect(d.limitation).toContain("watermark held at 2026-08-01T00:00:00");
    expect(d.limitation).toContain("2 page(s) failed");
  });

  it("holds when COJ_MAX_PAGES truncated the pull", () => {
    const d = nextAddressWatermark({ ...base, bounded: true });

    expect(d.advance).toBe(false);
    expect(d.limitation).toContain("COJ_MAX_PAGES");
  });

  it("never spends the error budget on a bounded pull, however many times it runs", () => {
    // The cap is deterministic: the same tail is missed every run, so no retry policy covers it and
    // the escape below must not fire. The only fix is unsetting the cap, and until then the track
    // stays on a full pull; the counter is left where the error path put it.
    let heldRuns = 0;
    for (let i = 0; i < WATERMARK_HELD_RUNS_BUDGET + 5; i += 1) {
      const d = nextAddressWatermark({ ...base, bounded: true, heldRuns });
      expect(d.advance).toBe(false);
      heldRuns = d.heldRuns;
    }
    expect(heldRuns).toBe(0);
  });

  it("advances anyway once page errors have held the cursor for the whole budget", () => {
    // The deliberate trade: rows behind a page that fails on every run are unreachable whatever the
    // cursor says, and a permanently held cursor re-pulls the entire window forever without
    // recovering them. So it moves, and the run record names the window that was not revisited.
    let heldRuns = 0;
    for (let i = 0; i < WATERMARK_HELD_RUNS_BUDGET; i += 1) {
      const d = nextAddressWatermark({ ...base, pageErrors: 1, heldRuns });
      expect(d.advance, `run ${i + 1} must still hold`).toBe(false);
      heldRuns = d.heldRuns;
    }
    expect(heldRuns).toBe(WATERMARK_HELD_RUNS_BUDGET);

    const escape = nextAddressWatermark({ ...base, pageErrors: 1, heldRuns });
    expect(escape.advance).toBe(true);
    expect(escape.watermark).toBe("2026-08-21T10:00:00");
    expect(escape.heldRuns).toBe(0);
    expect(escape.limitation).toContain("watermark ADVANCED");
    expect(escape.limitation).toContain("2026-08-01T00:00:00");
    expect(escape.limitation).toContain("will NOT be revisited");
    expect(escape.limitation).toContain("--force");
  });

  it("clears the debt on the first clean pull", () => {
    const d = nextAddressWatermark({ ...base, heldRuns: WATERMARK_HELD_RUNS_BUDGET });
    expect(d).toMatchObject({ advance: true, heldRuns: 0, limitation: null });
  });

  it("says where a first run with no cursor was holding from", () => {
    const d = nextAddressWatermark({ ...base, previous: null, pageErrors: 1 });
    expect(d.advance).toBe(false);
    expect(d.watermark).toBeNull();
    expect(d.limitation).toContain("the start of the layer");
  });

  it("has nothing to advance to when no row carries an edit_date", () => {
    const d = nextAddressWatermark({ ...base, maxEdit: null, heldRuns: 2 });
    expect(d).toMatchObject({ advance: false, watermark: null, limitation: null });
    // an empty layer is not evidence about the errors either way, so the counter is untouched
    expect(d.heldRuns).toBe(2);
  });

  it("holds on a bounded pull that also hit errors, because the cap dominates", () => {
    const d = nextAddressWatermark({ ...base, bounded: true, pageErrors: 4, heldRuns: WATERMARK_HELD_RUNS_BUDGET + 3 });
    expect(d.advance).toBe(false);
    expect(d.limitation).toContain("COJ_MAX_PAGES");
  });
});
