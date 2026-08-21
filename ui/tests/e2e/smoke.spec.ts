import { expect, test, type Page } from "@playwright/test";

/**
 * Browser smoke suite against a production build.
 *
 * What it proves:
 *  - DuckDB-WASM boots in a real browser and the published parquet loads
 *  - all eight presets return rows against the sample data, with provenance
 *  - the workbench enforces its read only guard
 *  - the MCP page resolves the artifact and verifies the parquet header
 */

const QUESTION_IDS = [
  "roof-older-than-15",
  "water-view",
  "no-sale-10-years",
  "regional-owners",
  "near-transit",
  "near-starbucks",
  "roof-and-long-hold",
  "transit-and-regional",
] as const;

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
});

test.describe("the six questions", () => {
  test("every preset returns evidence backed rows", async ({ page }) => {
    test.setTimeout(240_000);
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
      await expect(
        card.getByRole("cell").filter({ hasText: /duval_appraiser/i }).first(),
      ).toBeVisible();
    }
  });

  test("each card states its assumptions", async ({ page }) => {
    await page.goto("/questions");
    const card = page.getByTestId("question-water-view");
    await expect(card.getByText("Assumptions and missing data")).toBeVisible();
    await expect(card.getByText(/proximity proxy/)).toBeVisible();
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

  test("run history shows multiple runs with deltas and limitations", async ({ page }) => {
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Pipeline run history" })).toBeVisible();
    await expect(page.getByText("Runs recorded")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("latest", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Documented source limitations").first()).toBeVisible();
    await expect(page.getByRole("img", { name: /Cumulative rows per source/ })).toBeVisible();
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
});

test.describe("MCP page", () => {
  test("resolves the artifact and verifies the parquet header", async ({ page }) => {
    await page.goto("/mcp");
    await expect(page.getByRole("heading", { name: "MCP access" })).toBeVisible();
    await expect(page.getByText("Live resolution check")).toBeVisible();

    await expect(page.getByText("resolved", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/a valid parquet header/)).toBeVisible();

    await expect(page.getByText("PROPERTY_QUERY_TABLE_MAP")).toBeVisible();
    await expect(page.getByText("PUBLISHED_COUNTY_CATALOG_URL")).toBeVisible();
  });
});

test.describe("agent shell", () => {
  test("shows an honest not wired state rather than inventing an answer", async ({ page }) => {
    await page.goto("/agent");
    // Nothing stored in this browser and no server key: the page says so and
    // offers the way in, rather than a badge naming one vendor's env var.
    await expect(page.getByText("no model configured", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "add your own key" })).toBeVisible();

    await page.getByRole("button", { name: /Which properties have roofs older/ }).click();
    // The route refuses rather than inventing an answer, and points at settings.
    await expect(page.getByText(/agent not configured/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/settings page/).first()).toBeVisible();
  });
});

test.describe("model settings", () => {
  test("lists the provider registry and stores a key in the browser only", async ({ page }) => {
    await page.goto("/settings");

    // The registry drives the UI, so every provider the server supports is here.
    for (const label of ["Google AI Studio (Gemini)", "Groq", "Cerebras", "Hugging Face", "Vercel AI Gateway", "Anthropic", "Amazon Bedrock"]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    await expect(page.getByText("nothing configured", { exact: true })).toBeVisible();

    // The warning has to be in plain words, not buried in a tooltip.
    await expect(page.getByText(/saved in .*localStorage.* in this browser/i).first()).toBeVisible();

    // The key field is a password input, so it is deliberately not a textbox role.
    await page.locator('input[type="password"]').fill("test-key-not-a-real-credential-0000");
    await page.getByRole("button", { name: "save to this browser" }).click();
    await expect(page.getByText("your key", { exact: true })).toBeVisible();

    // Stored in this browser, and nowhere else.
    const stored = await page.evaluate(() => window.localStorage.getItem("duval-oracle.agent.llm"));
    expect(stored).toContain("test-key-not-a-real-credential-0000");

    // The agent page reads the same store and names the model that will answer.
    await page.goto("/agent");
    await expect(page.getByText("google:gemini-3.7-flash", { exact: true })).toBeVisible();

    await page.goto("/settings");
    await page.getByRole("button", { name: "clear stored key" }).click();
    await expect(page.getByText("nothing configured", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("duval-oracle.agent.llm"))).toBeNull();
  });
});

test.describe("property detail", () => {
  test("opens a parcel from a question result", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/questions");
    await waitForEngine(page);

    const card = page.getByTestId("question-regional-owners");
    await card.getByRole("button", { name: /^run$/ }).click();
    await expect(card.getByTestId("row-count")).toBeVisible({ timeout: 60_000 });

    const firstLink = card.getByRole("link").first();
    const folio = (await firstLink.textContent())?.trim() ?? "";
    await firstLink.click();

    await expect(page).toHaveURL(new RegExp(`/property/${folio}`));
    await expect(page.getByText("Provenance", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Ownership", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sales" }).first()).toBeVisible();
  });
});
