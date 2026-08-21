/**
 * Drive a locally running instance that is pointed at the real publish artifacts and report what
 * the page actually shows. Verification for a local rehearsal, not part of the test suite.
 *
 *   node scripts/local-smoke.mjs [http://localhost:3000]
 */

import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];

page.on("console", (m) => {
  if (m.type() === "error") failures.push(`console: ${m.text().slice(0, 160)}`);
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
const banner = await page.locator("body").innerText();
console.log(`SAMPLE banner present: ${banner.includes("SAMPLE DATA")}`);

// engine status reports the row count it actually loaded from the parquet
await page.goto(`${BASE}/questions`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.getByText(/duckdb ready/i).first().waitFor({ timeout: 120_000 });
const status = await page.locator("text=/parcels, \\d+ columns/").first().innerText();
console.log(`engine: ${status.replace(/\s+/g, " ").trim()}`);

const ids = [
  "roof-older-than-15",
  "water-view",
  "no-sale-10-years",
  "regional-owners",
  "near-transit",
  "near-starbucks",
];

for (const id of ids) {
  const card = page.locator(`[data-testid="question-${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "run", exact: true }).click();
  const summary = card.locator("text=/of .* published parcels match this rule/");
  try {
    await summary.first().waitFor({ timeout: 120_000 });
    const line = (await summary.first().innerText()).replace(/\s+/g, " ").trim();
    const empty = await card.getByText("Nothing matches, and here is why").count();
    console.log(`${id.padEnd(20)} ${line}${empty > 0 ? "   [coverage callout shown]" : ""}`);
  } catch {
    console.log(`${id.padEnd(20)} NO SUMMARY RENDERED`);
    failures.push(`${id}: no summary`);
  }
}

await page.goto(`${BASE}/runs`, { waitUntil: "domcontentloaded", timeout: 120_000 });
const runs = await page.locator("body").innerText();
console.log(`runs page mentions run ids: ${/01M0H[A-Z0-9]{6,}/.test(runs)}`);

await browser.close();
if (failures.length > 0) {
  console.log("\nissues:");
  for (const f of [...new Set(failures)]) console.log(` - ${f}`);
  process.exit(1);
}
