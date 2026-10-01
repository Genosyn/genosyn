import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { browserSelector, pageSnapshot } from "./browserRpc.js";

function chromiumExecutablePath(): string | undefined {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
    .filter((value): value is string => Boolean(value))
    .find((value) => existsSync(value));
}

// 2026-10-01: a Qwen Run on primal.net called browser_click with selector
// "e89" twice; each call waited out the locate timeout and returned a full
// snapshot before the model tried anything else.
test("a snapshot ref written without its engine is read as that ref", () => {
  for (const written of ["e89", " e89 ", "ref=e89", "ref = e89", "[ref=e89]", "[ ref=e89 ]"]) {
    assert.equal(browserSelector(written), "aria-ref=e89", written);
  }
});

test("every other selector is passed through unchanged", () => {
  for (const selector of [
    "aria-ref=e89",
    "button.primary",
    "text=Sign in",
    'role=button[name="Save"]',
    "#e89",
    ".e89",
    "e89 > a",
    "section e89",
    "[ref=e89] a",
    "ref=89",
    "E89",
  ]) {
    assert.equal(browserSelector(selector), selector, selector);
  }
});

test("a bare ref acts on the element its snapshot marker names in Chromium", async (t) => {
  const executablePath = chromiumExecutablePath();
  if (!executablePath) {
    t.skip("No Chromium executable is available for the snapshot ref test");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button onclick="document.body.dataset.clicked = 'reply'">Reply</button>
      <button onclick="document.body.dataset.clicked = 'follow'">Follow</button>
    `);
    // pageSnapshot declares only the narrow Page shape the browser routes use.
    const snapshot = await pageSnapshot(page as never, "selector-test");
    const ref = /button "Follow" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    assert.ok(ref, snapshot);

    await assert.rejects(
      page.locator(ref).first().click({ timeout: 500 }),
      /Timeout/,
      "as CSS the bare ref matches nothing",
    );
    await page.locator(browserSelector(ref)).first().click({ timeout: 2_000 });
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), "follow");
  } finally {
    await browser.close();
  }
});
