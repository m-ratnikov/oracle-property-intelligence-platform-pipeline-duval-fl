/** Diagnose why the live page's query engine is not becoming ready. Prints console, failures and requests. */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "https://duval-oracle-ui.vercel.app";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`));
page.on("requestfailed", (r) => console.log(`[failed] ${r.method()} ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("ipfs") || u.includes("parquet") || u.includes("duckdb")) {
    console.log(`[resp ${r.status()}] ${r.request().method()} ${u.slice(0, 140)}`);
  }
});

await page.goto(`${BASE}/questions`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(45_000);
const body = await page.locator("body").innerText();
console.log("\n=== visible status text ===");
for (const line of body.split("\n").filter((l) => /duckdb|engine|error|failed|sample|loading|parcels/i.test(l)).slice(0, 12)) {
  console.log("  " + line.trim().slice(0, 200));
}
await browser.close();
