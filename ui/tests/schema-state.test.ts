/**
 * The cold load contract: not knowing the schema is a loading state, never a finding.
 *
 * The defect: a first visit to /questions showed "Cannot answer from this artifact - The published
 * query table does not contain roof_year_est, roof_age_basis" on all eight cards, for the three or
 * more minutes DuckDB-WASM took to boot and attach the parquet over HTTP range reads. Every one of
 * those claims was false; the artifact publishes all 131 columns the rules need. The card was
 * deciding from an empty column array, which for that whole window is what an engine that has not
 * described anything yet and an artifact that publishes nothing look like to a caller.
 *
 * The fix is a type, not a condition, so these tests assert the type's guarantee: there is no
 * SchemaState that means "loaded with nothing", and `presetAvailability` cannot return the
 * "unanswerable" arm - the only arm that renders the callout - from a schema that is still loading.
 */

import { describe, expect, it } from "vitest";
import {
  PRESETS,
  SCHEMA_LOADING,
  loadedSchema,
  presetAvailability,
  presetById,
} from "@/lib/sql";
import { ALL_EXPECTED_COLUMNS } from "@/lib/columns";

describe("a card cannot claim a column is missing before the schema is known", () => {
  it.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s reports unknown, not unanswerable, while the engine is still attaching",
    (_id, preset) => {
      const availability = presetAvailability(preset, SCHEMA_LOADING);
      expect(availability).toEqual({ status: "unknown" });
      // The narrowing is the point: nothing here can reach `missing`, so nothing can render it.
      expect(availability.status).not.toBe("unanswerable");
      expect(availability.status).not.toBe("runnable");
    },
  );

  it("stays unknown for a preset that requires a column no artifact could have", () => {
    // A rule whose column genuinely does not exist must still be unknown while the schema is
    // unknown. If the loading state ever leaked a verdict, this is where it would leak first.
    const invented = { ...presetById("roof-older-than-15")!, requires: ["column_that_never_existed"] };
    expect(presetAvailability(invented, SCHEMA_LOADING)).toEqual({ status: "unknown" });
  });

  it("only turns unanswerable once the engine has described the artifact", () => {
    const preset = presetById("roof-older-than-15")!;
    expect(presetAvailability(preset, loadedSchema([]))).toEqual({
      status: "unanswerable",
      missing: preset.requires,
    });
  });

  it("is runnable against the schema the pipeline publishes", () => {
    for (const preset of PRESETS) {
      expect(presetAvailability(preset, loadedSchema(ALL_EXPECTED_COLUMNS)), preset.id).toEqual({
        status: "runnable",
      });
    }
  });

  it("names only the columns actually absent, and matches case insensitively", () => {
    const preset = presetById("roof-older-than-15")!;
    const partial = loadedSchema(["ROOF_YEAR_EST", "property_id"]);
    expect(presetAvailability(preset, partial)).toEqual({
      status: "unanswerable",
      missing: ["roof_age_basis"],
    });
  });

  it("does not read the caller's array after the fact", () => {
    // loadedSchema copies. A caller that keeps mutating the engine's column list - which is what
    // an incremental DESCRIBE would do - cannot retroactively change a verdict already rendered.
    const columns = ["roof_year_est", "roof_age_basis"];
    const schema = loadedSchema(columns);
    columns.length = 0;
    expect(presetAvailability(presetById("roof-older-than-15")!, schema)).toEqual({
      status: "runnable",
    });
  });
});
