/**
 * The presentation contract: what a card shows must be what the SQL under it computed.
 *
 * The defect these tests exist to stop was not a wrong answer. The no-sale-10-years rule returned
 * the right parcels and the right count, and then displayed last_sale_date, a column that is null
 * on 351,742 of 404,023 published rows, beside the claim that tenure was "measured from
 * last_sale_date". Every evidence row read "not available", every tenure read 127 or 226, and the
 * card's own assumption said parcels with no recorded sale were excluded. A correct answer
 * presented that way reads as fabricated, which is worse than being wrong and admitting it.
 *
 * So these assertions are about evidence quality, not about correctness of the predicate:
 *   - an evidence column has to carry values on the rows it is evidence for
 *   - the rule text has to name the columns the SQL actually selects
 *   - the first rows a reader sees have to be the strongest ones, not sentinel valued artefacts
 *   - the agent and the Questions page have to state one rule, not two
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPropertyDb, SAMPLE_PARQUET_PATH, type PropertyDb } from "@/lib/agent/db";
import {
  COMBINED_QUESTIONS,
  PRESETS,
  SIX_QUESTIONS,
  TENURE_RECORD_STARTS,
  TENURE_QUALITY_VALUES,
  SCHEMA_LOADING,
  VIEW_NAME,
  loadedSchema,
  measureAlias,
  statsSql,
  presetAvailability,
  presetById,
} from "@/lib/sql";
import {
  PROVENANCE_COLUMNS,
  SOURCE_FAMILIES,
  SPINE_PROVENANCE_COLUMNS,
} from "@/lib/columns";
import { EVIDENCE_GUIDE, presetFor, PRESET_NAME_LIST } from "@/lib/agent/schema";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { parseCoverageStatuses } from "@/lib/coverageStatus";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The sample's own coverage snapshot, not a fixture written to make a point.
 *
 * The sample parquet and this file are generated together by ui/scripts/make-sample-data.mjs, so
 * reading the real one is what proves the two agree: a sample that publishes permit derived
 * columns while its coverage snapshot says the permit source ingested nothing would be caught here
 * rather than on the deployed runtime.
 */
const SAMPLE_COVERAGE: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), "public", "sample", "dataset-coverage.json"), "utf8"),
);

/**
 * The basis values the pipeline can emit, and the one the artifact actually carries.
 *
 * Measured against the published parquet the runtime serves (404,023 rows): roof_age_basis is
 * EFF_YR_BLT_PROXY on 359,129 rows and NULL on the other 44,894. PERMIT is on zero rows because
 * the JaxEPICS permit source ingests nothing, and ACT_YR_BLT_PROXY is on zero rows because the
 * roll publishes eff_year_built wherever it publishes a year at all, so the fallback to the actual
 * year built is never reached. The sample parquet carries the same single value.
 *
 * The card has to name all three - a reader needs to know PERMIT is the basis that would have made
 * roof_year_est a real roof date - and has to say which of them no row carries.
 */
const ROOF_BASIS_VALUES = ["PERMIT", "EFF_YR_BLT_PROXY", "ACT_YR_BLT_PROXY"];
const PUBLISHED_ROOF_BASIS = "EFF_YR_BLT_PROXY";
const UNPUBLISHED_ROOF_BASES = ["PERMIT", "ACT_YR_BLT_PROXY"];

let db: PropertyDb;

beforeAll(async () => {
  db = await openPropertyDb(SAMPLE_PARQUET_PATH, true);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** How much of a column has to be populated on a preset's own result before it counts as evidence. */
const MIN_EVIDENCE_COVERAGE = 0.5;

describe("every evidence column carries evidence", () => {
  it.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s: no evidence column is mostly null on its own rows",
    async (_id, preset) => {
      const result = await db.query(preset.sql(200));
      expect(result.rows.length).toBeGreaterThan(0);

      const thin: string[] = [];
      for (const column of preset.evidence) {
        expect(result.columns, `${preset.id} does not select its evidence column ${column}`).toContain(
          column,
        );
        const filled = result.rows.filter((row) => row[column] !== null && row[column] !== "").length;
        const coverage = filled / result.rows.length;
        if (coverage < MIN_EVIDENCE_COVERAGE) {
          thin.push(`${column} (${Math.round(coverage * 100)} percent populated)`);
        }
      }
      expect(
        thin,
        `${preset.id} presents columns as evidence that are mostly empty: ${thin.join(", ")}. ` +
          "Pick the column the pipeline actually computes the rule from.",
      ).toEqual([]);
    },
  );

  it("no preset selects a column the evidence guide says to avoid", async () => {
    // The guide is what the agent is told. If a preset contradicts it, the two surfaces are back to
    // describing the same rule differently, which is the bug this whole file is about.
    const avoid = new Set<string>(EVIDENCE_GUIDE.flatMap((entry) => [...entry.avoid]));
    for (const preset of PRESETS) {
      const cited = preset.evidence.filter((column) => avoid.has(column));
      expect(cited, `${preset.id} cites a column the evidence guide tells the agent to avoid`).toEqual(
        [],
      );
    }
  });
});

describe("the tenure rule", () => {
  const preset = presetById("no-sale-10-years")!;

  it("is measured from last_sale_date_any, and says so", () => {
    expect(preset.rule).toContain("last_sale_date_any");
    expect(preset.evidence).toContain("last_sale_date_any");
    expect(preset.evidence).toContain("tenure_basis");
    expect(preset.requires).toContain("last_sale_date_any");
    expect(preset.requires).toContain("tenure_basis");
  });

  it("does not display the FDOR roll's own sale date, which is null on most parcels", async () => {
    const result = await db.query(preset.sql(50));
    expect(result.columns).not.toContain("last_sale_date");
    expect(result.columns).not.toContain("last_sale_price");
  });

  it("uses has_sale_on_record to separate no transfer on record from a long hold", () => {
    // The pipeline made this explicit: has_sale_on_record is false on 2,191 parcels and
    // tenure_basis reads NO_SALE_ON_RECORD there, never NULL. The card has to use that language,
    // because "no recorded sale" and "held a long time" are different findings.
    const text = preset.assumptions.join(" ");
    expect(text).toContain("has_sale_on_record");
    expect(text).toContain("NO_SALE_ON_RECORD");
    expect(text.toLowerCase()).toContain("excluded");
    expect(preset.requires).toContain("has_sale_on_record");
  });

  it("cites the system behind the tenure date, not just the roll spine", () => {
    // source_system is the appraisal roll and is identical on every row, so it is not the
    // provenance of a tenure date that came from the COJ recorded sales file.
    expect(preset.evidence).toContain("tenure_source");
  });

  it("shows a tenure date on every row it returns, never a column of not available", async () => {
    /*
     * The defect this file opens with, asserted at full strength rather than at the 50 percent bar
     * the generic evidence check uses. Measured on the published artifact: the rule matches 153,240
     * parcels, 152,586 of which have last_sale_date NULL - so the roll's own column would read
     * "not available" on 99.6 percent of the evidence a reviewer looks at. last_sale_date_any is
     * populated on all 153,240, and tenure_basis on all 404,023 published rows.
     */
    const result = await db.query(preset.sql(200));
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.last_sale_date_any, "a matching row with no tenure date to show").toBeTruthy();
      expect(row.tenure_basis, "a matching row with no tenure basis to show").toBeTruthy();
      expect(String(row.tenure_basis)).not.toBe("NO_SALE_ON_RECORD");
    }
  });

  it("never leads with a date that predates the recorded index", async () => {
    /*
     * The card used to open on STATE OF FLORIDA at 226 years, then twelve rows of 127. Placeholder
     * dates satisfy the rule and stay in the count, but a reader meets the strongest evidence
     * first or the whole answer reads as fabricated.
     */
    const result = await db.query(preset.sql(20));
    for (const row of result.rows) {
      const date = String(row.last_sale_date_any);
      expect(date >= TENURE_RECORD_STARTS, `${date} leads the result set`).toBe(true);
      expect(row.tenure_quality).toBe("PLAUSIBLE");
    }
  });

  it("excludes every parcel with no transfer on record, rather than counting it as a long hold", async () => {
    // Measured on the published artifact: 2,191 parcels read NO_SALE_ON_RECORD and none of them
    // matches the rule. The assumption on the card claims exactly that, so it is checked here
    // against the data instead of being trusted as prose.
    const [counts] = (
      await db.query(
        `SELECT count(*) FILTER (WHERE NOT has_sale_on_record) AS no_sale,
                count(*) FILTER (WHERE NOT has_sale_on_record AND ${preset.predicate}) AS matched
         FROM ${VIEW_NAME}`,
      )
    ).rows;
    expect(Number(counts.no_sale), "the sample models no parcel without a transfer").toBeGreaterThan(0);
    expect(Number(counts.matched)).toBe(0);
  });

  it("groups the rows by label, best evidence first, without dropping any of them", async () => {
    /*
     * The ordering contract, asserted as a partition rather than as a threshold. The previous
     * version of this test compared years against a 100 year cut, which is the rule that failed:
     * rows at exactly 100.0 years satisfied it and led the card.
     */
    const result = await db.query(preset.sql(200));
    const rank = (row: Record<string, unknown>) => {
      if (row.tenure_quality !== "PLAUSIBLE") return 2;
      return row.tenure_date_check === "CONFIRMED" ? 0 : 1;
    };
    const ranks = result.rows.map(rank);
    expect(ranks[0], "the first row is not the strongest evidence available").toBe(0);
    expect(
      [...ranks].sort((a, b) => a - b),
      "a weaker row sorted above a stronger one",
    ).toEqual(ranks);
  });

  it("gives every row one of the four contract values, never null", async () => {
    // The values are shared with the pipeline, which publishes the same column on the artifact.
    // Drifting from them here would make the screen and every MCP client disagree.
    const result = await db.query(preset.sql(200));
    expect(result.columns).toContain("tenure_quality");
    for (const row of result.rows) {
      expect(TENURE_QUALITY_VALUES).toContain(row.tenure_quality as string);
    }
  });

  it("computes the contract identically to the published column when it is absent", async () => {
    /*
     * The artifact does not carry tenure_quality yet, so the UI computes it. This pins that
     * computation against the pipeline's rules, restated independently here: a sale before the
     * recorded index, or an institutional, governmental or miscellaneous use code.
     */
    const result = await db.query(
      `SELECT tenure_quality, last_sale_date_any,
              TRY_CAST(property_usage_type AS INTEGER) AS use_code
       FROM (${preset.sql(500)})`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      const useCode = row.use_code === null ? null : Number(row.use_code);
      const expected =
        String(row.last_sale_date_any) < TENURE_RECORD_STARTS
          ? "IMPLAUSIBLE_DATE"
          : useCode !== null && useCode >= 70 && useCode <= 99
            ? "INSTITUTIONAL_OR_CIVIC"
            : "PLAUSIBLE";
      expect(row.tenure_quality, `${row.last_sale_date_any} / use ${row.use_code}`).toBe(expected);
    }
  });

  it("cannot label a matching row NO_SALE_ON_RECORD, because the rule already excluded those", async () => {
    // The fourth contract value is unreachable inside this preset by construction, and that is a
    // property worth pinning: if it ever appears, the rule and the label have stopped agreeing.
    const result = await db.query(preset.sql(500));
    for (const row of result.rows) {
      expect(row.tenure_quality).not.toBe("NO_SALE_ON_RECORD");
    }
  });

  it("never calls a tenure confirmed when the sale predates the building it would convey", async () => {
    /*
     * The signal that keeps the municipal and railway rows off the top of the card, since the use
     * code does not reach them: F E C RAILWAY CO reads 048 and CSX TRANSPORTATION 055, so both
     * stay PLAUSIBLE, and only their own dates give them away.
     */
    const result = await db.query(preset.sql(500));
    for (const row of result.rows) {
      const builtYear = row.built_year === null ? null : Number(row.built_year);
      const saleYear = Number(String(row.last_sale_date_any).slice(0, 4));
      if (builtYear === null) {
        expect(row.tenure_date_check).toBe("UNVERIFIABLE");
      } else {
        expect(row.tenure_date_check, `sold ${saleYear}, built ${builtYear}`).toBe(
          saleYear < builtYear ? "CONTRADICTED" : "CONFIRMED",
        );
      }
    }
  });

  it("states the labels it sorts by, and claims no instrument the roll does not carry", () => {
    const assumptions = preset.assumptions.join(" ");
    expect(assumptions).toMatch(/IMPLAUSIBLE_DATE/);
    expect(assumptions).toMatch(/INSTITUTIONAL_OR_CIVIC/);
    expect(assumptions).toMatch(/tenure_date_check/);
    /*
     * The roll carries no deed type, price or qualification code for 98.7 percent of rows, so the
     * copy may say a PARCEL is civic and may not say a TRANSFER was a plat or a dedication. This
     * assertion is what stops the wording drifting back into claiming the instrument.
     */
    expect(assumptions).toMatch(/not that the transfer was a plat/i);
  });

  it("does not let the stated cut drift away from the one the SQL runs", () => {
    // The defect was a documented threshold that the rows on screen did not obey. Whatever the
    // copy names, the statement has to contain it.
    expect(preset.assumptions.join(" ")).toContain(TENURE_RECORD_STARTS);
    expect(preset.sql(10)).toContain(TENURE_RECORD_STARTS);
  });

  it("applies the same ordering and columns to the combined roof and hold preset", async () => {
    const combined = presetById("roof-and-long-hold")!;
    const result = await db.query(combined.sql(200));
    expect(result.columns).toContain("last_sale_date_any");
    expect(result.columns).toContain("tenure_basis");
    expect(result.columns).toContain("tenure_quality");
    expect(result.columns).toContain("tenure_date_check");
    expect(result.columns).not.toContain("last_sale_date");
    expect(result.rows[0].tenure_quality).toBe("PLAUSIBLE");
    expect(result.rows[0].tenure_date_check).toBe("CONFIRMED");
  });

  it("reads the published column instead of recomputing it once the artifact carries one", () => {
    /*
     * The pipeline is adding tenure_quality to the artifact. Until that republish lands the UI has
     * to work against the 131 column one, so the preset has to do both, and which one it did must
     * be invisible to everything downstream.
     */
    const withoutColumn = preset.sql(10, loadedSchema(["years_since_last_sale"]));
    expect(withoutColumn).toContain("AS tenure_quality");
    expect(withoutColumn).toContain("CASE");

    const withColumn = preset.sql(10, loadedSchema(["years_since_last_sale", "tenure_quality"]));
    expect(withColumn).not.toContain("AS tenure_quality");
    expect(withColumn).toContain("tenure_quality");

    // A schema that is merely unknown must behave like an artifact without the column, never like
    // one that has it: naming a column that is not there does not degrade, it fails to bind.
    expect(preset.sql(10, SCHEMA_LOADING)).toBe(withoutColumn);
    expect(preset.sql(10)).toBe(withoutColumn);
  });
});

describe("the roof rule does not claim evidence it never had", () => {
  const roofPresets = PRESETS.filter((preset) => preset.requires.includes("roof_age_basis"));

  it.each(roofPresets.map((preset) => [preset.id, preset] as const))(
    "%s never presents a roof age as a roof date without naming the basis",
    (_id, preset) => {
      // No published row is a permit derived roof date: the JaxEPICS permit source ingests zero
      // rows, so every populated row is a year built proxy. Wording that implies a roof DATE is
      // only honest if it says the PERMIT basis is what makes it one, and roof_age_basis has to be
      // on the row to check.
      const text = `${preset.rule} ${preset.assumptions.join(" ")}`;
      expect(text, `${preset.id} does not name roof_age_basis`).toContain("roof_age_basis");
      expect(text, `${preset.id} does not say the year built proxy is not a roof date`).toMatch(
        /proxy/i,
      );
      expect(preset.requires).toContain("roof_age_basis");
    },
  );

  it("names the one basis the artifact carries, and says the other two are on no row", async () => {
    /*
     * The wording this replaces read "EFF_YR_BLT_PROXY and ACT_YR_BLT_PROXY mean no county roof
     * date exists", which offers a reader three live possibilities where the data has one. A
     * reviewer checking roof_age_basis finds a single value on every populated row, and copy that
     * implies otherwise costs the card the credibility the basis column was added to earn.
     */
    const roof = presetById("roof-older-than-15")!;
    const text = `${roof.rule} ${roof.assumptions.join(" ")}`;

    expect(text, `the roof card does not name ${PUBLISHED_ROOF_BASIS}`).toContain(
      PUBLISHED_ROOF_BASIS,
    );
    for (const basis of UNPUBLISHED_ROOF_BASES) {
      expect(text, `the roof card does not name ${basis}`).toContain(basis);
    }
    // and says so, rather than listing them as alternatives a row might carry
    expect(text, "the roof card does not say which bases are on no published row").toMatch(
      /on no published row|is on no row|no published row/i,
    );

    const bases = await db.query(
      `SELECT DISTINCT roof_age_basis AS basis FROM ${VIEW_NAME} WHERE roof_age_basis IS NOT NULL`,
    );
    expect(bases.rows.map((row) => String(row.basis))).toEqual([PUBLISHED_ROOF_BASIS]);
  });

  it("reports the permit derived share on the card rather than only non-null coverage", async () => {
    /*
     * roof_age_basis is non-null on 88.9 percent of published parcels. On its own that badge reads
     * as a well covered column, and it is the reassuring half of the fact: none of those rows came
     * from a permit. The preset declares the split so the card measures it from the same scan as
     * the headline count, and the zero comes from the artifact rather than from copy that could
     * quietly go stale.
     */
    for (const preset of PRESETS.filter((entry) => entry.requires.includes("roof_age_basis"))) {
      const permitMeasure = (preset.measures ?? []).find((measure) => measure.key === "permit_basis");
      expect(permitMeasure, `${preset.id} does not measure its permit derived share`).toBeDefined();

      const [stat] = (await db.query(statsSql(preset))).rows;
      expect(stat, `${preset.id} stats query`).toHaveProperty(measureAlias(permitMeasure!));
      expect(Number(stat[measureAlias(permitMeasure!)]), `${preset.id} permit derived rows`).toBe(0);
    }
  });

  it("shows no basis the card does not name, and no PERMIT basis while the source is blocked", async () => {
    /*
     * The other half of the assertion above, and the half that used to be missing.
     *
     * Naming PERMIT in the rule text is required: a reader has to know which basis WOULD have been
     * a roof date rather than a proxy. Publishing a PERMIT row is a different thing entirely, and
     * for this county it is not reachable. roof_age_basis only reaches PERMIT through a re-roof
     * permit reconciled to the folio, and the JaxEPICS permit source ingests nothing at all: it is
     * behind an Akamai WAF that answers every request with 403, which the coverage snapshot
     * records as constrained rather than hiding.
     *
     * So this checks the two sides against each other, from the artifacts themselves: the sample's
     * coverage snapshot must still describe a blocked permit source, and the sample parquet must
     * carry no value the card does not explain, no PERMIT basis, and no permit derived column.
     * The previous version of this file was satisfied by a sample that manufactured PERMIT rows,
     * which meant the strongest honesty claim in the submission was contradicted by its own
     * fallback dataset.
     */
    const permits = parseCoverageStatuses(SAMPLE_COVERAGE).get("permits");
    expect(permits?.state, "the sample must model the blocked permit source").toBe("blocked");
    expect(permits?.ingested).toBe(0);
    expect(permits?.implemented).toBe(true);
    expect(permits?.constrained).toBe(true);

    const bases = await db.query(
      `SELECT DISTINCT roof_age_basis AS basis FROM ${VIEW_NAME} WHERE roof_age_basis IS NOT NULL`,
    );
    const published = bases.rows.map((row) => String(row.basis));
    expect(published.length, "no row carries a roof basis at all").toBeGreaterThan(0);
    expect(
      published.filter((basis) => !ROOF_BASIS_VALUES.includes(basis)),
      "a basis value the roof card never explains",
    ).toEqual([]);
    expect(published, "a PERMIT roof basis with no permit row behind it").not.toContain("PERMIT");
    expect(published, "a basis value beyond the single one the artifact carries").toEqual([
      PUBLISHED_ROOF_BASIS,
    ]);

    const [counts] = (
      await db.query(
        `SELECT count(permit_source) AS sources,
                count(permit_count) AS permit_counts,
                count(roof_permit_count) AS roof_permits,
                count(last_roof_permit_year) AS roof_permit_years
         FROM ${VIEW_NAME}`,
      )
    ).rows;
    for (const [column, value] of Object.entries(counts)) {
      expect(Number(value), `${column} is populated by a source that ingested nothing`).toBe(0);
    }
  });

  it("shows roof_age_basis on every returned row, so the claim is checkable", async () => {
    for (const preset of roofPresets) {
      const result = await db.query(preset.sql(10));
      expect(result.columns, `${preset.id}`).toContain("roof_age_basis");
    }
  });

  it("does not present roof_covering_material, which is null on every published row", async () => {
    const roof = presetById("roof-older-than-15")!;
    expect(roof.evidence).not.toContain("roof_covering_material");
    const result = await db.query(roof.sql(20));
    expect(result.columns).not.toContain("roof_covering_material");
  });
});

describe("the water rule states both thresholds the pipeline uses", () => {
  const water = presetById("water-view")!;

  it("names the 150 m centroid test and the 30 m bounding box test", () => {
    expect(water.rule).toContain("150 m");
    expect(water.rule).toContain("30 m");
  });

  it("explains why water_dist_m can exceed the threshold on a matching row", async () => {
    const result = await db.query(water.sql(200));
    const overThreshold = result.rows.filter((row) => Number(row.water_dist_m) > 150);
    // The published data has plenty of these. If the sample stops producing them the wording is
    // still required, because the live artifact has 21,307 of them.
    expect(water.rule).toMatch(/bounding box|bbox/i);
    if (overThreshold.length > 0) {
      expect(String(overThreshold[0].water_basis)).toMatch(/bbox|bounding box/i);
    }
  });
});

describe("the owner rule shows the address it classified", () => {
  const regional = presetById("regional-owners")!;

  it("cites the mailing city and state rather than a constant owner_count", async () => {
    expect(regional.evidence).toContain("owner_mailing_state");
    expect(regional.evidence).not.toContain("owner_count");
    expect(regional.evidence).not.toContain("owners_text");
    const result = await db.query(regional.sql(20));
    expect(result.columns).not.toContain("owner_count");
    expect(result.columns).not.toContain("owners_text");
  });

  it("says why owner_count and owners_text are absent instead of silently dropping them", () => {
    // owner_count is NULL on every published row now, not the old constant 1. Either way it is not
    // a count, and the card has to say so rather than leaving a reader to wonder where it went.
    const text = regional.assumptions.join(" ");
    expect(text).toMatch(/owner_count/);
    expect(text).toMatch(/ET AL|has_additional_owners/);
  });
});

describe("the published column contract, where breaking it would be silent", () => {
  it("never tests tenure_basis with IS NULL", () => {
    // tenure_basis stopped being nullable: a parcel with no transfer reads NO_SALE_ON_RECORD.
    // `tenure_basis IS NULL` now matches zero rows and shows an empty result rather than an error,
    // which is exactly the kind of break that reaches a reviewer instead of a test.
    const everySql = PRESETS.map((preset) => preset.sql(10)).join("\n");
    expect(everySql).not.toMatch(/tenure_basis\s+IS\s+NULL/i);
    expect(SYSTEM_PROMPT).not.toMatch(/tenure_basis IS NULL"?\s*$/im);
  });

  it("never presents owner_count, which is NULL on every published row", async () => {
    for (const preset of PRESETS) {
      const result = await db.query(preset.sql(5));
      expect(result.columns, `${preset.id} still selects owner_count`).not.toContain("owner_count");
    }
  });

  it("declares every family provenance pair as provenance", () => {
    // The canonical three describe the appraisal spine only. If the UI keeps treating them as the
    // provenance of the whole row, a transit distance from the GTFS feed is presented as if the
    // property appraiser published it.
    for (const family of SOURCE_FAMILIES) {
      expect(PROVENANCE_COLUMNS).toContain(`${family.key}_source`);
      expect(PROVENANCE_COLUMNS).toContain(`${family.key}_fetched_at`);
    }
    expect(PROVENANCE_COLUMNS).toContain("source_systems");
    expect(SPINE_PROVENANCE_COLUMNS).toEqual(["source_system", "source_url", "fetched_at"]);
  });

  it("cites the family source beside a value that family produced", async () => {
    // Not decoration: water_dist_m comes from the hydrography track, not from the appraisal roll,
    // so source_system is the wrong answer to "where did this number come from".
    const cases: [string, string][] = [
      ["water-view", "water_source"],
      ["near-transit", "transit_source"],
      ["near-starbucks", "places_source"],
    ];
    for (const [id, column] of cases) {
      const preset = presetById(id)!;
      const result = await db.query(preset.sql(5));
      expect(result.columns, `${id} does not carry ${column}`).toContain(column);
      expect(preset.requires).toContain(column);
    }
  });

  it("every column a preset requires exists in the published table", async () => {
    const described = await db.query(`DESCRIBE ${VIEW_NAME}`);
    const available = described.rows.map((row) => String(row.column_name));
    for (const preset of PRESETS) {
      expect(presetAvailability(preset, loadedSchema(available)), `${preset.id}`).toEqual({
        status: "runnable",
      });
    }
  });
});

describe("the agent and the Questions page state one rule", () => {
  it("every tool facing preset name resolves to a shipped preset", () => {
    for (const name of PRESET_NAME_LIST) {
      expect(() => presetFor(name)).not.toThrow();
    }
    expect(SIX_QUESTIONS).toHaveLength(6);
    expect(COMBINED_QUESTIONS).toHaveLength(2);
  });

  it("the system prompt says no transfer on record is excluded, the same as the card", () => {
    // The live /agent said "NULL means no recorded sale, treated here as a long hold" while the
    // card for the same question said such parcels were excluded. The SQL excludes them, so the
    // card was right and the prompt has to agree with it in as many words.
    expect(SYSTEM_PROMPT).toMatch(/EXCLUDED from the long hold/);
    expect(SYSTEM_PROMPT).toMatch(/never be described as "treated as a long hold"/);
    expect(presetById("no-sale-10-years")!.assumptions.join(" ")).toMatch(
      /excluded, not counted as long held/i,
    );
  });

  it("the system prompt names last_sale_date_any as the tenure basis and warns off last_sale_date", () => {
    expect(SYSTEM_PROMPT).toContain("last_sale_date_any");
    expect(SYSTEM_PROMPT).toMatch(/NOT from last_sale_date/);
  });

  it("the system prompt carries the evidence guide, so it cannot drift from the presets", () => {
    for (const entry of EVIDENCE_GUIDE) {
      for (const column of entry.use) expect(SYSTEM_PROMPT).toContain(column);
      for (const column of entry.avoid) expect(SYSTEM_PROMPT).toContain(column);
    }
  });

  it("the system prompt says no published row carries a permit derived roof date", () => {
    // Rewritten from "a roof date only where roof_age_basis says PERMIT", which was true of the
    // pipeline's intent and false of the published artifact. Measured there, roof_age_basis is
    // EFF_YR_BLT_PROXY on 359,129 rows and NULL on 44,894; PERMIT and ACT_YR_BLT_PROXY are on zero.
    // A prompt that offers PERMIT as a live possibility lets the agent describe a basis this data
    // does not contain, which is the same class of defect as reporting an uncomputed total.
    expect(SYSTEM_PROMPT).toContain("EFF_YR_BLT_PROXY");
    expect(SYSTEM_PROMPT).toMatch(/no published row carries a permit derived roof date/i);
    expect(SYSTEM_PROMPT).toMatch(/PERMIT on zero/i);
    // ACT_YR_BLT_PROXY is still named, but only to say it is on zero rows. Naming a value the data
    // does not contain is fine; implying the agent might meet one is not.
    expect(SYSTEM_PROMPT).toMatch(/PERMIT and ACT_YR_BLT_PROXY are on ZERO rows/);
  });

  it("the system prompt states the new tenure contract, not the old one", () => {
    expect(SYSTEM_PROMPT).toContain("has_sale_on_record");
    expect(SYSTEM_PROMPT).toContain("NO_SALE_ON_RECORD");
    // tenure_basis stopped being nullable; an IS NULL test against it now silently matches nothing.
    expect(SYSTEM_PROMPT).toMatch(/tenure_basis is NEVER NULL/);
  });

  it("the system prompt scopes source_system to the appraisal spine", () => {
    expect(SYSTEM_PROMPT).toMatch(/APPRAISAL ROLL SPINE only/);
    expect(SYSTEM_PROMPT).toContain("source_systems");
  });

  it("the system prompt says owner_count is not a count", () => {
    expect(SYSTEM_PROMPT).toMatch(/owner_count is NULL on every row/);
    expect(SYSTEM_PROMPT).toContain("has_additional_owners");
  });

  it("the system prompt routes tenure through the published columns, not a duration cut", () => {
    /*
     * Deliberately does not pin any number. A duration threshold was the defect: it moved with the
     * as-of date and let 1925 and 1926 plat dates through at exactly 100.0 years. What the prompt
     * owes the model is the two published columns and what their values mean, so this asserts the
     * contract rather than a sentence.
     */
    for (const value of [
      "PLAUSIBLE",
      "IMPLAUSIBLE_DATE",
      "INSTITUTIONAL_OR_CIVIC",
      "NO_SALE_ON_RECORD",
    ]) {
      expect(SYSTEM_PROMPT).toContain(value);
    }
    expect(SYSTEM_PROMPT).toContain("tenure_date_check");
    expect(SYSTEM_PROMPT).toMatch(/CONTRADICTED/);
    // The warning itself survives the rewrite: a pre-1901 date is filler, not a century long hold.
    expect(SYSTEM_PROMPT).toMatch(/placeholder/i);
    // And the prompt must not reintroduce the cut it replaced.
    expect(SYSTEM_PROMPT).toMatch(/no threshold on years_since_last_sale separates a placeholder/i);
  });
});
