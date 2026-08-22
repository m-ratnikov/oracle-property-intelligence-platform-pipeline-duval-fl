import { expect, test, type Locator, type Page } from "@playwright/test";
import { PRESETS, SIX_QUESTIONS } from "../../lib/sql";
import { SOURCE_FAMILIES } from "../../lib/columns";

/**
 * Browser smoke suite against a production build.
 *
 * What it proves:
 *  - DuckDB-WASM boots in a real browser and the published parquet loads
 *  - every preset the app ships returns rows, with readable provenance on each one
 *  - the workbench enforces its read only guard
 *  - the coverage page reports a blocked source as blocked rather than as complete
 *  - the MCP page resolves the artifact and verifies the parquet header
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT IS GONE. Three tests drove `/settings` and asserted on
 * `window.localStorage`. There is no `/settings` route: the model picker became a dropdown on the
 * Agent page in "ui: model choice becomes a dropdown on the Agent page; the Settings tab goes", and
 * nothing in app/, components/ or lib/ touches localStorage. Those tests could only ever fail, and
 * they were never run in CI, so a committed `test-results/.last-run.json` reading "passed" was the
 * only evidence anyone had. They are replaced below by assertions about the model row that actually
 * exists. The stale run artifact is not tracked (ui/.gitignore already ignores `test-results/`).
 *
 * The preset list is imported from lib/sql rather than copied, so a preset renamed or added there
 * is covered here without this file being touched.
 */

const QUESTION_IDS = PRESETS.map((preset) => preset.id);
const FIRST_QUESTION_ID = SIX_QUESTIONS[0].id;

/** "2026-08-21 13:58Z" or "2026-08-21 13:58:56Z". What a provenance timestamp must look like. */
const READABLE_UTC = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?Z/;
/** An epoch integer with no separators. What a provenance cell must never look like. */
const RAW_EPOCH = /\b1\d{12}\b/;

/**
 * Grid columns whose value is the name of a source system rather than a code inside one.
 *
 * `<family>_source` for every family the pipeline publishes, plus tenure_source, which the artifact
 * documents as "the source system that published the tenure date". last_sale_source ends in _source
 * too and is deliberately not here: it carries "SDF" or "PA_DETAIL", which name a column inside the
 * sales family rather than who published it.
 */
const SYSTEM_NAMING_COLUMNS = new Set<string>([
  ...SOURCE_FAMILIES.map((family) => `${family.key}_source`),
  "tenure_source",
]);

async function headerNames(card: Locator): Promise<string[]> {
  const names = await card.locator("thead th").allTextContents();
  return names.map((name) => name.trim());
}

async function columnsNamingASystem(card: Locator): Promise<string[]> {
  return (await headerNames(card)).filter((name) => SYSTEM_NAMING_COLUMNS.has(name));
}

async function cellText(card: Locator, row: Locator, column: string): Promise<string> {
  const index = (await headerNames(card)).indexOf(column);
  if (index < 0) return "";
  return (await row.locator("td").nth(index).textContent()) ?? "";
}

/**
 * The published dataset-coverage.json, trimmed to three rows: the source that is genuinely
 * complete, the one that is a single row short of its published total, and the one behind a WAF
 * that answers every request with 403.
 */
const COVERAGE_FIXTURE = {
  county: "duval",
  exportedAt: "2026-08-21T21:51:54.453Z",
  datasets: [
    {
      county: "duval",
      source: "appraisal",
      ingested_count: 404023,
      expected_count: 404023,
      first_loaded_at: "2026-08-21T13:58:56Z",
      last_loaded_at: "2026-08-21T13:58:56Z",
      ipns_label: "duval-oracle-artifacts",
      implemented: true,
      limitations: ["FDOR posts only the current roll type; prior years by email request"],
    },
    {
      county: "duval",
      source: "coj_parcels",
      ingested_count: 407985,
      expected_count: 407986,
      first_loaded_at: "2026-08-21T18:38:33Z",
      last_loaded_at: "2026-08-21T18:38:33Z",
      ipns_label: null,
      implemented: true,
      requires_us_egress: true,
      limitations: ["US egress only (COJ hosts block non-US and cloud IPs)"],
    },
    {
      county: "duval",
      source: "permits",
      ingested_count: 0,
      expected_count: 0,
      first_loaded_at: null,
      last_loaded_at: null,
      ipns_label: null,
      implemented: true,
      constrained: true,
      requires_us_egress: true,
      reason:
        "JaxEPICS API behind Akamai WAF; search/reports require login; no open dataset; PRR is the documented path",
      last_skip_reason: "skipped: non-US egress (HTTP 0, fetch failed)",
      limitations: [
        "No open-data permit layer found; search/reports require login",
        "US egress only (COJ hosts block non-US and cloud IPs)",
      ],
    },
  ],
};

async function waitForEngine(page: Page) {
  await expect(page.getByTestId("engine-ready").first()).toBeVisible({ timeout: 90_000 });
}

test.describe("query engine", () => {
  test("boots DuckDB-WASM and loads the published parquet", async ({ page }) => {
    await page.goto("/query");
    await waitForEngine(page);

    const status = page.getByTestId("engine-ready").first();
    await expect(status).toContainText(/parcels/);
    await expect(status).toContainText(/columns/);

    // The starter statement runs on load, so a grid must be present.
    const rowCount = page.getByTestId("row-count").first();
    await expect(rowCount).toBeVisible({ timeout: 60_000 });
    const rows = Number(await rowCount.getAttribute("data-rows"));
    expect(rows).toBeGreaterThan(0);

    // The schema sidebar comes from DESCRIBE against the artifact.
    await expect(page.getByText("property_id", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("roof_year_est", { exact: true }).first()).toBeVisible();
  });

  test("rejects a write statement", async ({ page }) => {
    await page.goto("/query");
    await waitForEngine(page);

    const editor = page.getByLabel("SQL statement");
    const runButton = page.getByRole("button", { name: "run statement" });

    // A statement that does not start with a read only verb is refused outright.
    await editor.fill("DROP TABLE properties");
    await runButton.click();
    await expect(page.getByText("Statement rejected")).toBeVisible();
    await expect(page.getByText(/Statements must start with one of/)).toBeVisible();

    // A read verb carrying a write keyword is refused by the keyword guard.
    await editor.fill("SELECT * FROM properties ORDER BY drop");
    await runButton.click();
    await expect(page.getByText(/"drop" is not allowed/)).toBeVisible();

    // A second statement smuggled in behind a semicolon is refused too.
    await editor.fill("SELECT 1; DELETE FROM properties");
    await runButton.click();
    await expect(page.getByText(/One statement at a time/)).toBeVisible();
  });

  test("runs DESCRIBE against the view", async ({ page }) => {
    await page.goto("/query");
    await waitForEngine(page);

    await page.getByRole("button", { name: "DESCRIBE properties" }).click();
    const rowCount = page.getByTestId("row-count").first();
    await expect(rowCount).toBeVisible();
    expect(Number(await rowCount.getAttribute("data-rows"))).toBeGreaterThan(30);
  });

  test("renders a TIMESTAMP column as a readable instant, not an epoch integer", async ({ page }) => {
    // fetched_at is the only TIMESTAMP column in the published table and it crosses the Arrow
    // bridge as an epoch number. Selecting it directly is the narrowest possible proof that the
    // shared formatter, not the caller, is what makes it readable.
    await page.goto("/query");
    await waitForEngine(page);

    await page
      .getByLabel("SQL statement")
      .fill("SELECT property_id, fetched_at FROM properties LIMIT 5");
    await page.getByRole("button", { name: "run statement" }).click();
    await expect(page.getByTestId("row-count").first()).toBeVisible({ timeout: 60_000 });

    const grid = page.locator("table.grid").first();
    await expect(grid).toContainText(READABLE_UTC);
    await expect(grid).not.toContainText(RAW_EPOCH);
  });
});

test.describe("the questions", () => {
  test("the first question answers itself on arrival", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/questions");
    await waitForEngine(page);

    const card = page.getByTestId(`question-${FIRST_QUESTION_ID}`);
    // Nothing is clicked in this test. The card has to produce rows on its own.
    const rowCount = card.getByTestId("row-count");
    await expect(rowCount).toBeVisible({ timeout: 90_000 });
    expect(Number(await rowCount.getAttribute("data-rows"))).toBeGreaterThan(0);
    await expect(card.getByTestId(`autorun-${FIRST_QUESTION_ID}`)).toBeVisible();

    // The per card timing line is a strong detail and must survive the auto run.
    await expect(card.getByText(/parcels match\s+this rule/)).toBeVisible();
    await expect(card.getByText(/showing the first [\d,]+ in \d+ ms/)).toBeVisible();

    // Every other card stays on the button, and says it is ready rather than "not run yet".
    const second = page.getByTestId(`question-${SIX_QUESTIONS[1].id}`);
    await expect(second.getByTestId("row-count")).toHaveCount(0);
    await expect(second.getByTestId(`idle-${SIX_QUESTIONS[1].id}`)).toContainText(/Ready to run/);
    await expect(second.getByTestId(`autorun-${SIX_QUESTIONS[1].id}`)).toHaveCount(0);
  });

  test("no card claims a column is missing while the engine is still booting", async ({ page }) => {
    // The "Cannot answer from this artifact" callout is computed against the engine's column list,
    // which is empty until DuckDB-WASM has described the parquet. Shown too early it tells a
    // reviewer the published table has no roof_year_est, which is the opposite of the truth.
    await page.goto("/questions");
    await expect(page.getByText("Cannot answer from this artifact")).toHaveCount(0);
    await waitForEngine(page);
    await expect(page.getByText("Cannot answer from this artifact")).toHaveCount(0);
  });

  test("every preset returns evidence backed rows with readable provenance", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/questions");
    await waitForEngine(page);

    for (const id of QUESTION_IDS) {
      const card = page.getByTestId(`question-${id}`);
      await expect(card).toBeVisible();

      // A card is only disabled when the artifact lacks a required column.
      const runButton = card.getByRole("button", { name: /^run$/ });
      await expect(runButton).toBeEnabled({ timeout: 60_000 });
      await runButton.click();

      const rowCount = card.getByTestId("row-count");
      await expect(rowCount).toBeVisible({ timeout: 60_000 });
      const rows = Number(await rowCount.getAttribute("data-rows"));
      expect(rows, `preset ${id} returned no rows`).toBeGreaterThan(0);

      // Every result grid carries provenance.
      // Header text is uppercased by CSS, so match case insensitively.
      await expect(card.getByRole("columnheader", { name: /provenance/i })).toBeVisible();

      const firstRow = card.locator("tbody tr").first();
      const provenance = firstRow.getByTestId("provenance");
      await expect(provenance).toBeVisible();
      // The collection timestamp in that cell is a date a person can read, never a raw epoch.
      await expect(provenance).toContainText(READABLE_UTC);
      await expect(provenance).not.toContainText(RAW_EPOCH);

      /*
       * The assertion this test used to make was `hasText: /duval_appraiser/i`, and it passed
       * against the defect it was supposed to catch. source_system is duval_appraiser on all
       * 404,023 rows, so requiring the cell to say it proved only that the cell existed, and never
       * that the system beside a value was the system that produced it. A row showing an Overture
       * walking distance credited the county property appraiser and this test called it readable.
       *
       * What it asserts now: the systems the cell names must include whatever the row's own
       * `<family>_source` column says. That column is on screen next to the evidence, so the two
       * cannot disagree without the grid contradicting itself in the same row.
       */
      const named = (await provenance.getAttribute("data-systems")) ?? "";
      expect(named, `preset ${id} names no source system`).not.toBe("");
      expect(named.split(","), `preset ${id} drops the spine`).toContain("duval_appraiser");

      for (const column of await columnsNamingASystem(card)) {
        const shown = (await cellText(card, firstRow, column)).trim();
        if (shown === "" || shown === "not available") continue;
        expect(
          named.split(","),
          `preset ${id} shows ${column} = ${shown} but its provenance names ${named}`,
        ).toContain(shown);
      }
    }
  });

  test("each card states its assumptions", async ({ page }) => {
    await page.goto("/questions");
    for (const preset of PRESETS) {
      const card = page.getByTestId(`question-${preset.id}`);
      await expect(card.getByText("Assumptions and missing data")).toBeVisible();
      // The assumption text itself lives in lib/sql; assert it is rendered, not what it says.
      expect(preset.assumptions.length, `preset ${preset.id} states no assumptions`).toBeGreaterThan(0);
      await expect(card.getByText(preset.assumptions[0], { exact: false })).toBeVisible();
    }
  });
});

test.describe("published artifacts", () => {
  test("overview lists CIDs, IPNS names and gateway URLs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Duval County/ })).toBeVisible();
    await expect(page.getByText("How this costs nothing to keep running")).toBeVisible();

    await expect(page.getByText("query-table.parquet").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("CID", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("IPNS name", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Gateway URL", { exact: true }).first()).toBeVisible();
  });

  test("no stat tile is ever a blank box", async ({ page }) => {
    /*
     * The first screen of the demo is four stat tiles fed by an IPFS gateway. A gateway that has
     * not got the IPNS name warm takes many seconds to answer, and the tiles used to sit there
     * with no value and no caption, which reads as broken rather than busy. Holding the run
     * history reproduces that exactly.
     */
    await page.route("**/ipns/**", async (route) => {
      if (route.request().resourceType() === "fetch") {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
      }
      await route.continue();
    });
    await page.goto("/", { waitUntil: "commit" });

    const tiles = page.locator(".card").filter({ has: page.locator(".uppercase.tracking-wide") });
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < count; index += 1) {
      const tile = tiles.nth(index);
      const text = (await tile.innerText()).trim();
      const label = text.split("\n")[0] ?? "";
      // Either a value, or a labelled skeleton with a caption saying what is being waited on.
      expect(text.length, `tile "${label}" rendered nothing but its label`).toBeGreaterThan(
        label.length + 3,
      );
    }
  });

  test("run history shows multiple runs with deltas and limitations", async ({ page }) => {
    /*
     * Two assertions in this test were stale in the same way the deleted /settings tests were: a
     * `latest` badge and an image captioned "Cumulative rows per source", neither of which the
     * page has rendered since the run charts were faceted per source and the run table was rebuilt
     * around expandable rows. They are replaced by what the page does render.
     */
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Pipeline run history" })).toBeVisible();
    await expect(page.getByText("Runs recorded")).toBeVisible({ timeout: 30_000 });

    // More than one run is the whole claim of the page: ingestion is continuous, not a bulk load.
    // Each run row carries an expand control named after the run it opens.
    const detailRows = page.getByRole("button", { name: /^Expand run / });
    await expect(detailRows.first()).toBeVisible({ timeout: 30_000 });
    expect(await detailRows.count()).toBeGreaterThan(1);
    await expect(page.getByText("Run by run")).toBeVisible();
    await expect(page.getByText("Documented source limitations").first()).toBeVisible();

    // Both run charts are published with accessible names, so the page is readable without them.
    const charts = page.getByRole("img");
    expect(await charts.count()).toBeGreaterThan(0);
  });

  test("data page computes column coverage in the browser", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/data");
    await waitForEngine(page);
    await expect(page.getByRole("heading", { name: "Per column non null coverage" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /^roof_age_basis$/i }).first()).toBeVisible({
      timeout: 90_000,
    });
    // hoa_flag is a documented null placeholder and must be named as empty.
    await expect(
      page.getByText("Published but entirely null", { exact: true }),
    ).toBeVisible({ timeout: 90_000 });
  });

  test("a source that could not be collected is reported as blocked, never as complete", async ({
    page,
  }) => {
    /*
     * The permits source sits behind a WAF that answers every request with 403. The pipeline
     * records that honestly as ingested_count 0 with constrained: true and three limitation
     * strings, and the coverage table used to run that pair through the same ratio arithmetic as
     * every other row and print "0 / 0 = 100.0%" with a full green bar. This is the evidence
     * quality story of the whole submission, so it gets its own test.
     */
    /*
     * The snapshot is served as a fixture so this holds whichever artifact the build points at,
     * and so the assertion does not silently pass on a dataset where the source happens to be
     * healthy. The synthetic sample now models the blocked source too, copied field for field
     * from the live coverage artifact, so the fixture and the sample agree rather than the
     * fixture standing in for something the sample lacked. The rows below are the published
     * dataset-coverage.json verbatim, including the 407,985 / 407,986 pair that used to round
     * up to a tidy 100.0%.
     */
    await page.route("**/*", async (route) => {
      const request = route.request();
      /*
       * Only small JSON artifacts are read and sniffed. The query table is a 47 MB parquet the
       * engine range reads, and the coverage snapshot is requested by a <link rel="preload">
       * whose resourceType is not "fetch", so neither a size guess nor a resourceType filter
       * would do: skip anything ranged or obviously binary and inspect the rest.
       */
      const url = request.url();
      const ranged = (await request.allHeaders()).range !== undefined;
      if (ranged || /\.(parquet|wasm|js|css|png|svg|ico|map)(\?|$)/.test(url)) {
        return route.continue();
      }
      const response = await route.fetch();
      if (!(response.headers()["content-type"] ?? "").includes("json")) {
        return route.fulfill({ response });
      }
      const body = await response.text();
      if (!body.includes('"datasets"')) return route.fulfill({ response, body });
      return route.fulfill({ response, body: JSON.stringify(COVERAGE_FIXTURE) });
    });

    await page.goto("/data");
    const row = page.getByTestId("coverage-row-permits");
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByTestId("coverage-state-permits")).toHaveText("source blocked");
    await expect(row).not.toContainText("100.0%");
    await expect(row).not.toContainText("0 / 0");
    // A blocked source has no denominator, so the expected cell must not print the snapshot's 0.
    await expect(row).toContainText("not available");

    // The pipeline's own explanation has to be on the page, not hidden in a tooltip.
    const callout = page.getByTestId("unavailable-sources");
    await expect(callout).toContainText("permits");
    await expect(callout).toContainText(/WAF|403|login|open dataset/i);

    // A source one row short of its published total must not read as complete.
    const short = page.getByTestId("coverage-row-coj_parcels");
    await expect(short).toContainText("99.9%");
    await expect(short).toContainText("1 row short");
    await expect(short).not.toContainText("100.0%");

    // The genuinely complete source still reads as complete.
    await expect(page.getByTestId("coverage-row-appraisal")).toContainText("100.0%");
  });
});

test.describe("MCP page", () => {
  test("resolves the artifact and verifies the parquet header", async ({ page }) => {
    await page.goto("/mcp");
    await expect(page.getByRole("heading", { name: "MCP access" })).toBeVisible();
    await expect(page.getByText("Live resolution check")).toBeVisible();

    await expect(page.getByText("resolved", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/a valid parquet header/)).toBeVisible();
  });

  test("addresses the two settings DuckDB reads by immutable CID", async ({ page }) => {
    /*
     * The hosted MCP hard-failed every data tool when these two pointed at mutable /ipns/ URLs:
     * DuckDB pins the ETag it saw when it created its view, and on IPFS the ETag is the CID, so
     * re-pointing a name under a warm instance breaks it permanently. The page must not tell a
     * reviewer to paste an /ipns/ URL into either of them.
     */
    await page.goto("/mcp");
    for (const env of ["PROPERTY_QUERY_TABLE_MAP", "DATASET_COVERAGE_MAP"]) {
      const row = page.getByTestId(`mcp-binding-${env}`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText("immutable CID");
      await expect(row).toContainText("every publish");
    }
    // The catalog is fetched as JSON behind a short TTL, so it keeps its name and is set once.
    await expect(page.getByTestId("mcp-binding-PUBLISHED_COUNTY_CATALOG_URL")).toContainText(
      "IPNS name",
    );

    const perPublishBlock = page.getByText(/PROPERTY_QUERY_TABLE_MAP=/).first();
    await expect(perPublishBlock).toBeVisible({ timeout: 60_000 });
    await expect(perPublishBlock).toContainText("/ipfs/");
    await expect(perPublishBlock).not.toContainText("/ipns/");
  });
});

test.describe("agent shell", () => {
  test("names the model that will answer and the tools it may use", async ({ page }) => {
    /*
     * Replaces three tests that drove a `/settings` route which does not exist. What the page
     * actually offers is a model dropdown bound to the deployment's own server side registry, and
     * a named, closed set of read only tools.
     */
    await page.goto("/agent");
    await expect(page.getByRole("heading", { name: "Agent" })).toBeVisible();

    /*
     * A build with no model provider key - which is what CI produces - must say so rather than
     * render an empty picker. Either outcome is correct; silence is not, so both are asserted.
     */
    const model = page.getByLabel("Model");
    const noModel = page.getByText("no model configured");
    await expect(model.or(noModel).first()).toBeVisible({ timeout: 60_000 });
    if ((await model.count()) > 0) {
      expect(await model.locator("option").count()).toBeGreaterThan(0);
      expect(await model.inputValue()).not.toBe("");
    }

    // The claim the page rests on: the agent can only read.
    await expect(page.getByText(/Read-only tools:/)).toContainText("run_sql");
    await expect(page.getByText(/Read-only tools:/)).toContainText("get_property");
  });

  test("shows no credential input anywhere, because the browser holds none", async ({ page }) => {
    // The deployment answers on its own key. Nothing is stored in the browser, and this asserts
    // that rather than leaving the removed settings page as folklore.
    await page.goto("/agent");
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const stored = await page.evaluate(() => Object.keys(window.localStorage).length);
    expect(stored).toBe(0);
  });
});

test.describe("property detail", () => {
  test("opens a parcel from a question result and shows readable provenance", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/questions");
    await waitForEngine(page);

    const card = page.getByTestId(`question-${FIRST_QUESTION_ID}`);
    await expect(card.getByTestId("row-count")).toBeVisible({ timeout: 90_000 });

    const firstLink = card.getByRole("link").first();
    const folio = (await firstLink.textContent())?.trim() ?? "";
    await firstLink.click();

    await expect(page).toHaveURL(new RegExp(`/property/${folio}`));
    await expect(page.getByText("Provenance", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Ownership", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sales" }).first()).toBeVisible();

    // The provenance card carries an instant, not the epoch integer behind it.
    const provenanceCard = page.locator(".card").filter({ hasText: "Provenance" }).first();
    await expect(provenanceCard).toContainText(READABLE_UTC);
    await expect(provenanceCard).not.toContainText(RAW_EPOCH);
  });
});
