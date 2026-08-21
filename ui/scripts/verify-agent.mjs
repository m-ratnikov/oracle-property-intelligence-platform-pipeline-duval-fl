/** Drive the deployed agent page in a real browser and report every network failure. */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "https://duval-oracle-ui.vercel.app";
const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];

page.on("requestfailed", (r) => failures.push(`${r.method()} ${r.url().slice(0, 110)} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.url().includes("/api/agent") || r.url().includes("run-history")) {
    console.log(`[${r.status()}] ${r.request().method()} ${r.url().slice(0, 100)}`);
  }
});

await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(8000);

console.log("model dropdown present:", (await page.getByLabel("Model").count()) > 0);
const body = await page.locator("body").innerText();
console.log("run history badge:", /published run history|sample run history/i.test(body));

await page.getByRole("button", { name: /Which properties have roofs older/ }).click();

// The answer streams as NDJSON, so the response body cannot be read after the fact. Watch the page
// instead, which is what a visitor sees anyway.
const started = Date.now();
await page.waitForFunction(
  () => /of\s+404,023|AGENT ERROR|properties in Duval/i.test(document.body.innerText),
  undefined,
  { timeout: 300_000 },
);
const text = await page.locator("body").innerText();
console.log(`answered in ${Math.round((Date.now() - started) / 1000)}s, error shown: ${/AGENT ERROR/i.test(text)}`);
console.log("evidence panel present:", /Evidence \(\d+ parcels\)/i.test(text));

console.log("network failures:", failures.length);
for (const f of [...new Set(failures)].slice(0, 8)) console.log("  " + f);
await browser.close();
