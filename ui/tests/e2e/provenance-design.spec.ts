import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AgentResponse } from "@/lib/agent/types";

/**
 * Design coverage for the provenance cell, across breakpoints, on both surfaces that render it.
 *
 * Two defects live here.
 *
 * ONE. The Agent page rendered its own single `source_system` badge instead of the cell the results
 * grid uses. source_system is "duval_appraiser" on all 404,023 rows, so every answer about a
 * Starbucks walking distance or a JTA transit distance credited the county property appraiser for
 * another organisation's work - on the one page a reviewer actually drives. The fix is not "add
 * badges to the Agent page": it is that the Agent page renders the SAME component, so a third copy
 * of the provenance logic cannot exist to drift. The test for that is structural, and it is
 * `data-testid="provenance"` with a `data-systems` list: only components/DataTable.tsx emits those,
 * so an Agent page that grew its own badges again would fail here even if the badges were right.
 *
 * TWO. The provenance column is the last column of a grid that is wider than the card holding it.
 * At 1440px the Questions cards gave it a 1316px scrollport against a 1512px table, so 94px of a
 * 290px column was on screen and the reader saw DUVAL_APPRAISER and OVERTURE_PLACES sliced by the
 * container edge with FDOR_PAR, the shortest badge, the only system that rendered whole. Every
 * badge is now asserted to sit inside its own scrollport, at every breakpoint, which is the
 * assertion that fails against that layout.
 *
 * LANE. This repository has one browser lane, `tests/e2e`, driving a production build. The Agent
 * cases mock `/api/agent` at the network boundary, which is what makes them deterministic and lets
 * them run with no model credential; the Questions cases cannot be mocked, because the state under
 * test only exists once DuckDB-WASM has run a preset over the published parquet in the browser.
 */

/**
 * Mobile is below the `md` breakpoint the pinned column starts at, and asserts the other half of
 * that decision: a 290px column pinned inside a 322px scrollport would bury the data it explains,
 * so on a phone the column stays in the flow and is read at the end of the scroll.
 */
const BREAKPOINTS = [
  { name: "Mobile", viewport: { width: 390, height: 844 }, provenancePinned: false },
  { name: "Tablet", viewport: { width: 834, height: 1112 }, provenancePinned: true },
  { name: "Desktop", viewport: { width: 1440, height: 900 }, provenancePinned: true },
] as const;

/** The three cards the demo walks through, and the system each one's evidence actually came from. */
const PROXIMITY_CARDS = [
  { id: "water-view", system: "coj_nhd_hydrography" },
  { id: "near-transit", system: "jta_gtfs" },
  { id: "near-starbucks", system: "overture_places" },
] as const;

/** "2026-08-21 13:58Z". A provenance timestamp is an instant a person can read. */
const READABLE_UTC = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?Z/;
/** The Arrow epoch integer the same cell must never print. */
const RAW_EPOCH = /\b1\d{12}\b/;

async function ensureBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/**
 * Badges that hang outside the scrollport they live in, by name.
 *
 * Named rather than counted so a failure says which system the reader could not read. The half
 * pixel absorbs subpixel column widths; a clipped badge misses by tens of pixels, not by one.
 */
function clippedSystems(cell: Locator): Promise<string[]> {
  return cell.evaluate((element) => {
    const scrollport = element.closest<HTMLElement>(".table-wrap, .overflow-auto");
    if (scrollport === null) throw new Error("provenance cell is not inside a scrollport");
    const view = scrollport.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>(".badge")]
      .filter((badge) => {
        const box = badge.getBoundingClientRect();
        return box.left < view.left - 0.5 || box.right > view.right + 0.5;
      })
      .map((badge) => badge.textContent ?? "");
  });
}

/** Scroll the grid to its right hand end, which is where an unpinned last column is legible. */
async function scrollToTableEnd(cell: Locator): Promise<void> {
  await cell.evaluate((element) => {
    const scrollport = element.closest<HTMLElement>(".table-wrap, .overflow-auto");
    if (scrollport !== null) scrollport.scrollLeft = scrollport.scrollWidth;
  });
}

async function waitForEngine(page: Page) {
  await expect(page.getByTestId("engine-ready").first()).toBeVisible({ timeout: 90_000 });
}

/**
 * Whether this build reads the published artifact or the synthetic sample.
 *
 * It decides how much the cell can be held to. The sample parquet carries all 131 columns and no KV
 * metadata, so there is no column to family map, and an evidence row - which lib/agent/tools.ts
 * strips every per family source column out of - then has nothing left to attribute a value with.
 * On the sample the honest output is the spine alone, and demanding more would be demanding a
 * guess. CI builds with no NEXT_PUBLIC_QUERY_TABLE_URL and lands here; the deployed runtime does
 * not.
 */
async function readsPublishedArtifact(page: Page): Promise<boolean> {
  return (await page.getByText("SAMPLE DATA", { exact: true }).count()) === 0;
}

/** One answer, fixed, with the evidence shape the tools really produce. */
const MOCK_ANSWER: AgentResponse = {
  status: "ok",
  message: "Two parcels are within 800 m of a Starbucks.",
  answer: "Two parcels are within 800 m of a Starbucks.",
  toolCalls: [],
  tool_calls: [],
  /*
   * Copied in shape from lib/agent/tools.ts recordEvidence: identity, a joined address, the three
   * spine columns, `via`, and the matched columns. There is deliberately no `places_source`,
   * `geometry_source` or `source_systems` here, because an evidence row never carries one - which
   * is the whole reason this cell has to read the published column to family map.
   */
  evidence: [
    {
      property_id: "0707810100R",
      address: "1 MAIN ST, JACKSONVILLE, 32202",
      source_system: "duval_appraiser",
      source_url: "https://example.invalid/roll",
      fetched_at: "2026-08-21T13:58:56Z",
      via: "preset_question:near-starbucks",
      latitude: 30.3322,
      longitude: -81.6557,
      nearest_starbucks_name: "Starbucks",
      nearest_starbucks_m: 214,
      water_view_flag: true,
      water_dist_m: 88,
    },
    {
      property_id: "0707810110R",
      address: "3 MAIN ST, JACKSONVILLE, 32202",
      source_system: "duval_appraiser",
      source_url: "https://example.invalid/roll",
      fetched_at: "2026-08-21T13:58:56Z",
      via: "preset_question:near-starbucks",
      latitude: 30.3325,
      longitude: -81.6559,
      nearest_starbucks_name: "Starbucks",
      nearest_starbucks_m: 402,
      water_view_flag: false,
      water_dist_m: 1904,
    },
  ],
  assumptions: [],
  totals: [],
  unverified_totals: [],
  data_freshness: null,
  model: "mock-model",
  usage: null,
  elapsed_ms: 12,
};

/** Answer the page's own two calls so it renders a transcript without a model credential. */
async function mockAgentApi(page: Page): Promise<void> {
  await page.route("**/api/agent", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          configured: true,
          active: { provider: "mock", model: "mock-model", source: "server" },
          server_default: { provider: "mock", model: "mock-model", env_key: "MOCK_KEY" },
          model_choices: [{ id: "mock-model", label: "mock model" }],
        },
      });
      return;
    }
    // Plain JSON, not NDJSON: readAgentStream falls back to response.json() and the turn is one
    // deterministic step with no progress lines to wait on.
    await route.fulfill({ json: MOCK_ANSWER });
  });
}

async function openAgentEvidence(page: Page): Promise<Locator> {
  await mockAgentApi(page);
  await page.goto("/agent");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => document.fonts.ready);
  await waitForEngine(page);

  await page.getByRole("textbox").first().fill("Which properties are near a Starbucks?");
  await page.getByRole("button", { name: /^send$/i }).click();

  const summary = page.getByText(/Evidence \(\d+ parcels\)/);
  await expect(summary).toBeVisible({ timeout: 60_000 });
  await summary.click();
  return page.locator("table").filter({ hasText: "provenance" }).locator("tbody tr").first();
}

for (const breakpoint of BREAKPOINTS) {
  test.describe(`provenance design - ${breakpoint.name}`, () => {
    test.use({ viewport: breakpoint.viewport });

    test("the agent's evidence rows render the shared provenance cell", async ({ page }) => {
      const row = await openAgentEvidence(page);
      const cell = row.getByTestId("provenance");

      // Structural, and the assertion that fails against the page's own single badge: only
      // components/DataTable.tsx emits this cell, so passing here means there is no third copy.
      await expect(cell).toBeVisible();
      await expect(cell).toHaveAttribute("data-systems", /\S/);

      // The spine is still named and still dated, and still as an instant rather than an epoch.
      const named = ((await cell.getAttribute("data-systems")) ?? "").split(",");
      expect(named).toContain("duval_appraiser");
      await expect(cell).toContainText(READABLE_UTC);
      await expect(cell).not.toContainText(RAW_EPOCH);

      if (await readsPublishedArtifact(page)) {
        /*
         * The defect itself. This row shows an Overture walking distance, a JTA-independent water
         * distance and a parcel centroid from the FDOR shapefile, and every one of them used to be
         * attributed to the county property appraiser.
         */
        expect(named).toContain("overture_places");
        expect(named).toContain("coj_nhd_hydrography");
        expect(named).toContain("fdor_par");
      }

      await scrollToTableEnd(cell);
      expect(await clippedSystems(cell)).toEqual([]);
    });

    for (const card of PROXIMITY_CARDS) {
      test(`the ${card.id} card shows every contributing system whole`, async ({ page }) => {
        test.setTimeout(180_000);
        await page.goto("/questions");
        await page.waitForLoadState("domcontentloaded");
        await page.evaluate(() => document.fonts.ready);
        await waitForEngine(page);

        const questionCard = page.getByTestId(`question-${card.id}`);
        const run = questionCard.getByRole("button", { name: /^run$/ });
        await expect(run).toBeEnabled({ timeout: 60_000 });
        await run.click();
        await expect(questionCard.getByTestId("row-count")).toBeVisible({ timeout: 120_000 });

        const cell = questionCard.locator("tbody tr").first().getByTestId("provenance");
        await expect(cell).toBeVisible();
        const named = ((await cell.getAttribute("data-systems")) ?? "").split(",").filter(Boolean);
        expect(named).toContain("duval_appraiser");
        expect(named, `${card.id} names only the spine`).toContain(card.system);

        if (breakpoint.provenancePinned) {
          /*
           * Pinned, so the systems are legible without the reader first discovering that the grid
           * scrolls sideways. This is the state the defect was reported in: the grid at rest. The
           * pinned box is the cell, not the badge stack inside it.
           */
          await expect(cell.locator("xpath=ancestor::td[1]")).toHaveCSS("position", "sticky");
          expect(
            await clippedSystems(cell),
            `${card.id} cuts a provenance badge at ${breakpoint.name}`,
          ).toEqual([]);
        }

        // At every width, the end of the scroll shows the whole cell and every system in it.
        await scrollToTableEnd(cell);
        expect(await clippedSystems(cell)).toEqual([]);
        const badges = cell.locator(".badge");
        expect(await badges.count()).toBe(named.length);

        // Each badge is a real box the reader can read, not a collapsed sliver.
        for (let index = 0; index < named.length; index += 1) {
          const box = await ensureBox(badges.nth(index));
          expect(box.width, `${named[index]} rendered ${box.width}px wide`).toBeGreaterThan(30);
        }
      });
    }
  });
}
