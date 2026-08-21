/** Ask two questions in one page load and report each outcome, with console and network errors. */
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "https://duval-oracle-ui.vercel.app";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [console.error] ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));
page.on("requestfailed", (r) => {
  if (r.url().includes("/api/agent")) console.log(`  [requestfailed] ${r.failure()?.errorText}`);
});
page.on("response", (r) => {
  if (r.url().includes("/api/agent") && r.request().method() === "POST") {
    console.log(`  [POST ${r.status()}] content-type=${r.headers()["content-type"]}`);
  }
});

await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => /duckdb ready/i.test(document.body.innerText), undefined, { timeout: 180_000 });

const answerCount = () =>
  page.evaluate(() => (document.body.innerText.match(/Assumptions and missing data/gi) ?? []).length);

const ask = async (label, name) => {
  console.log(`\n--- ${label} ---`);
  const before = await answerCount();
  await page.getByRole("button", { name }).click();
  const started = Date.now();
  try {
    // wait for a NEW answer block, or for an error banner to appear
    await page.waitForFunction(
      (prev) => {
        const t = document.body.innerText;
        const answers = (t.match(/Assumptions and missing data/gi) ?? []).length;
        return answers > prev || /AGENT ERROR/i.test(t);
      },
      before,
      { timeout: 300_000 },
    );
  } catch {
    console.log("  outcome: TIMED OUT waiting for an answer");
    return;
  }
  const text = await page.locator("body").innerText();
  const failed = /AGENT ERROR|Could not reach/i.test(text);
  console.log(`  outcome: ${failed ? "FAILED" : "ok"} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (failed) {
    const line = text.split("\n").find((l) => /Could not reach|AGENT ERROR/i.test(l));
    console.log(`  message: ${line}`);
  }
};

await ask("first question", /Which properties have roofs older/);
await ask("second question", /Which properties are near public transportation/);
await browser.close();
