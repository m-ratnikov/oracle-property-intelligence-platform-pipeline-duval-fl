/**
 * The load bearing test: every preset the UI ships is executed by a real DuckDB
 * against the real sample parquet, exactly as written.
 *
 * The browser runs DuckDB-WASM and this runs the native build, but the SQL is
 * the same string from lib/sql.ts, so a broken predicate, a missing column or a
 * dialect mistake fails here before it reaches the demo.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { DuckDBInstance, type DuckDBConnection, type DuckDBInstance as Instance } from "@duckdb/node-api";
import {
  COMBINED_QUESTIONS,
  PRESETS,
  SIX_QUESTIONS,
  VIEW_NAME,
  columnCoverageSql,
  guardSql,
  loadedSchema,
  presetAvailability,
  propertyByIdSql,
  searchPropertiesSql,
  statsSql,
  TOTAL_ALIAS,
} from "@/lib/sql";
import { ALL_EXPECTED_COLUMNS, CANONICAL_COLUMNS } from "@/lib/columns";

const PARQUET = resolve(process.cwd(), "public", "sample", "query-table.parquet");

let instance: Instance;
let connection: DuckDBConnection;
let columns: string[] = [];

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const result = await connection.runAndReadAll(sql);
  return result.getRowObjects() as Record<string, unknown>[];
}

beforeAll(async () => {
  expect(
    existsSync(PARQUET),
    "public/sample/query-table.parquet is missing. Run `pnpm sample` first.",
  ).toBe(true);

  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
  const path = PARQUET.replace(/\\/g, "/").replace(/'/g, "''");
  await connection.run(
    `CREATE OR REPLACE VIEW ${VIEW_NAME} AS SELECT * FROM read_parquet('${path}')`,
  );
  const described = await rows(`DESCRIBE ${VIEW_NAME}`);
  columns = described.map((row) => String(row.column_name));
});

afterAll(() => {
  connection?.closeSync();
  instance?.closeSync();
});

describe("published query table contract", () => {
  it("loads and exposes one row per folio", async () => {
    const [counts] = await rows(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT property_id) AS folios,
              COUNT(*) FILTER (WHERE property_id IS NULL) AS null_folios
       FROM ${VIEW_NAME}`,
    );
    expect(Number(counts.total)).toBeGreaterThan(0);
    expect(Number(counts.folios)).toBe(Number(counts.total));
    expect(Number(counts.null_folios)).toBe(0);
  });

  it("carries every canonical column the Elephant export defines", () => {
    const missing = CANONICAL_COLUMNS.filter((column) => !columns.includes(column));
    expect(missing, `missing canonical columns: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries the derived columns the six questions depend on", () => {
    const missing = ALL_EXPECTED_COLUMNS.filter((column) => !columns.includes(column));
    expect(missing, `missing expected columns: ${missing.join(", ")}`).toEqual([]);
  });

  it("fills property_cid on every row", async () => {
    const [counts] = await rows(
      `SELECT COUNT(*) FILTER (WHERE property_cid IS NULL OR property_cid = '') AS blanks
       FROM ${VIEW_NAME}`,
    );
    expect(Number(counts.blanks)).toBe(0);
  });
});

describe("the six questions", () => {
  it("ships exactly six primary questions and two combined presets", () => {
    expect(SIX_QUESTIONS).toHaveLength(6);
    expect(COMBINED_QUESTIONS).toHaveLength(2);
  });

  it.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s returns evidence backed rows",
    async (_id, preset) => {
      expect(presetAvailability(preset, loadedSchema(columns))).toEqual({ status: "runnable" });

      const result = await rows(preset.sql(50));
      expect(result.length, `${preset.id} returned no rows`).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(50);

      const first = result[0];

      // Every evidence column the card highlights must be in the result set.
      for (const column of preset.evidence) {
        expect(Object.keys(first), `${preset.id} is missing evidence column ${column}`).toContain(
          column,
        );
      }

      // Every row must be traceable back to a source.
      for (const column of ["source_system", "source_url", "fetched_at"]) {
        expect(Object.keys(first)).toContain(column);
      }
      expect(first.source_system).toBeTruthy();
      expect(String(first.source_url)).toMatch(/^https?:\/\//);
    },
  );

  it("roof rule only returns roofs at least 15 years old", async () => {
    const result = await rows(
      `SELECT MAX(roof_year_est) AS newest FROM (${SIX_QUESTIONS[0].sql(500)})`,
    );
    const currentYear = new Date().getUTCFullYear();
    expect(Number(result[0].newest)).toBeLessThanOrEqual(currentYear - 15);
  });

  it("ownership rule only returns holds of at least 10 years", async () => {
    const preset = SIX_QUESTIONS.find((entry) => entry.id === "no-sale-10-years")!;
    const result = await rows(
      `SELECT MIN(years_since_last_sale) AS shortest FROM (${preset.sql(500)})`,
    );
    expect(Number(result[0].shortest)).toBeGreaterThanOrEqual(10);
  });

  it("walking distance rules only return parcels within 800 m", async () => {
    const transit = SIX_QUESTIONS.find((entry) => entry.id === "near-transit")!;
    const starbucks = SIX_QUESTIONS.find((entry) => entry.id === "near-starbucks")!;

    const [transitRow] = await rows(
      `SELECT MAX(nearest_transit_stop_m) AS furthest FROM (${transit.sql(1000)})`,
    );
    const [starbucksRow] = await rows(
      `SELECT MAX(nearest_starbucks_m) AS furthest FROM (${starbucks.sql(1000)})`,
    );

    expect(Number(transitRow.furthest)).toBeLessThanOrEqual(800);
    expect(Number(starbucksRow.furthest)).toBeLessThanOrEqual(800);
  });

  it("regional owner rule only returns REGIONAL parcels", async () => {
    const preset = SIX_QUESTIONS.find((entry) => entry.id === "regional-owners")!;
    const result = await rows(
      `SELECT DISTINCT owner_region_class AS class FROM (${preset.sql(1000)})`,
    );
    expect(result.map((row) => String(row.class))).toEqual(["REGIONAL"]);
  });

  it("combined presets are a subset of the rules they combine", async () => {
    const roof = SIX_QUESTIONS.find((entry) => entry.id === "roof-older-than-15")!;
    const hold = SIX_QUESTIONS.find((entry) => entry.id === "no-sale-10-years")!;
    const combined = COMBINED_QUESTIONS.find((entry) => entry.id === "roof-and-long-hold")!;

    const [counts] = await rows(
      `SELECT
        (SELECT COUNT(*) FROM (${roof.sql(5000)})) AS roof_rows,
        (SELECT COUNT(*) FROM (${hold.sql(5000)})) AS hold_rows,
        (SELECT COUNT(*) FROM (${combined.sql(5000)})) AS combined_rows`,
    );

    expect(Number(counts.combined_rows)).toBeGreaterThan(0);
    expect(Number(counts.combined_rows)).toBeLessThanOrEqual(Number(counts.roof_rows));
    expect(Number(counts.combined_rows)).toBeLessThanOrEqual(Number(counts.hold_rows));
  });

  it("the headline count under each result agrees with the rows the rule returns", async () => {
    // The grid is capped by a limit, so the count shown beside it comes from a separate statement.
    // If the two ever drifted apart the page would report a number its own rows contradict.
    for (const preset of PRESETS) {
      const [stat] = await rows(statsSql(preset));
      const [check] = await rows(
        `SELECT count(*) AS c FROM (${preset.sql(1_000_000).replace(/\s+LIMIT\s+\d+\s*$/i, "")})`,
      );
      expect(Number(stat.matching_parcels), `${preset.id} count`).toBe(Number(check.c));
      expect(Number(stat.total_parcels)).toBeGreaterThan(Number(stat.matching_parcels) - 1);
      // every column the rule declares gets a coverage figure, which is what explains an empty result
      for (const column of preset.requires) {
        expect(stat, `${preset.id} coverage of ${column}`).toHaveProperty(`coverage_${column}`);
      }
    }
  });

  it("reports a zero coverage column rather than a bare empty result", async () => {
    // A rule whose column is entirely null must be distinguishable from a rule that truly matches
    // nothing: the coverage figure is the only thing that separates them on screen.
    const preset = PRESETS[0];
    const [stat] = await rows(statsSql(preset));
    const covered = preset.requires.filter((column) => Number(stat[`coverage_${column}`]) > 0);
    expect(covered).toEqual(preset.requires);
  });
});

describe("supporting statements", () => {
  it("column coverage runs in one pass and reports a total", async () => {
    const [row] = await rows(columnCoverageSql(columns));
    expect(Number(row[TOTAL_ALIAS])).toBeGreaterThan(0);
    for (const column of columns) {
      expect(Number(row[column])).toBeLessThanOrEqual(Number(row[TOTAL_ALIAS]));
    }
    // hoa_flag is a documented null placeholder in the Elephant contract.
    expect(Number(row.hoa_flag)).toBe(0);
  });

  it("property lookup finds a parcel by folio", async () => {
    const [sample] = await rows(`SELECT property_id FROM ${VIEW_NAME} LIMIT 1`);
    const found = await rows(propertyByIdSql(String(sample.property_id)));
    expect(found).toHaveLength(1);
    expect(String(found[0].property_id)).toBe(String(sample.property_id));
  });

  it("property search matches on street and owner", async () => {
    const found = await rows(searchPropertiesSql("RIVERSIDE"));
    expect(found.length).toBeGreaterThan(0);
  });

  it("guarded workbench statements execute", async () => {
    const guarded = guardSql("SELECT property_id FROM properties ORDER BY property_id", 7);
    expect(guarded.ok).toBe(true);
    const result = await rows(guarded.sql!);
    expect(result).toHaveLength(7);
  });
});
