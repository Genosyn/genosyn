/**
 * Real Chrome coverage for the API reference at /api/docs, served by the real
 * App (`createApp()` on an in-memory database): the full document loads,
 * product areas are listed in order and collapsed, the search box matches an
 * area, a path, a summary or an operation id in any case, an operation shows
 * its id, parameters and access, and a browser-only operation is marked for
 * the cookie alone. Run with `npm run test:api-docs`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { createApp } from "../server/app";
import { errorHandler } from "../server/middleware/error";
import { setPublicUrl } from "../server/services/publicUrl";
import { withTestInstanceSecrets } from "../server/test/apiAccess";
import { closeTestDb, initTestDb } from "../server/test/dbHarness";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");

const restoreSecrets = withTestInstanceSecrets();
await initTestDb();
const app = createApp();
app.use(errorHandler);
const server = await new Promise<Server>((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
await setPublicUrl(origin);

const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    server.close();
    throw error;
  });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(30_000);

const search = (p: Page) => p.getByRole("textbox", { name: "Search the API reference" });
const tagNames = (p: Page) =>
  p
    .locator(".opblock-tag-section h3 .opblock-tag, .opblock-tag-section .opblock-tag")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute("data-tag") ?? node.textContent ?? "").trim()),
    );
const visibleOperationIds = (p: Page) =>
  p
    .locator(".opblock .opblock-summary-operation-id")
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));

async function searchFor(p: Page, text: string) {
  await search(p).fill(text);
  // Swagger UI filters on input; give the list a beat to re-render.
  await p.waitForTimeout(300);
}

async function expandTag(p: Page, name: string) {
  await p.locator(`.opblock-tag[data-tag="${name}"]`).click();
}

try {
  await page.goto(`${origin}/api/docs`, { waitUntil: "domcontentloaded" });
  assert.match(page.url(), /\/api\/docs\/?$/);
  await page.locator(".opblock-tag").first().waitFor();
  assert.equal(await page.title(), "Genosyn API");
  await page.locator(".info .title").filter({ hasText: "Genosyn API" }).waitFor();
  await page.locator(".info").getByText("Settings → API keys", { exact: false }).first().waitFor();

  // Every area is listed, in the reference's product order, collapsed.
  const tags = await tagNames(page);
  assert.ok(tags.length > 50, `only ${tags.length} areas`);
  assert.equal(tags[0], "Auth");
  for (const area of ["Revenue", "Finance", "Routines", "API Keys", "Inbound webhooks"]) {
    assert.ok(tags.includes(area), `${area} is listed`);
  }
  assert.ok(tags.indexOf("Employees") < tags.indexOf("Revenue"), "areas keep the product order");
  assert.equal(await page.locator(".opblock").count(), 0, "areas start collapsed");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "api-docs-areas.png") });

  // The search box says what it matches.
  assert.equal(
    await search(page).getAttribute("placeholder"),
    "Search areas, paths, summaries and operation ids",
  );

  // An operation id finds its one operation, inside its area.
  await searchFor(page, "listRevenueDeals");
  assert.deepEqual(await tagNames(page), ["Revenue"]);
  await expandTag(page, "Revenue");
  assert.deepEqual(await visibleOperationIds(page), ["listRevenueDeals"]);

  // Any case, and a path fragment, work too.
  await searchFor(page, "LISTREVENUEDEALS");
  assert.deepEqual(await tagNames(page), ["Revenue"]);
  await searchFor(page, "/revenue/deals/{id}/archive");
  assert.deepEqual(await visibleOperationIds(page), ["archiveRevenueDeal"]);

  // An area name keeps the whole area.
  await searchFor(page, "banking");
  assert.deepEqual(await tagNames(page), ["Banking"]);

  // A summary matches as written, and nothing matches nothing.
  await searchFor(page, "hang up phone call");
  assert.deepEqual(await tagNames(page), ["Phone numbers"]);
  await searchFor(page, "no-such-operation-anywhere");
  assert.deepEqual(await tagNames(page), []);

  // An operation shows its id, its parameters and who may call it.
  await searchFor(page, "getCompanyMe");
  await expandTag(page, "Companies");
  await page.locator(".opblock-summary", { hasText: "getCompanyMe" }).click();
  const operation = page.locator(".opblock.is-open");
  await operation.getByText("Accepts an API key for this company", { exact: false }).waitFor();
  await operation.locator('tr[data-param-name="cid"]').waitFor();
  await page.screenshot({ path: path.join(output, "api-docs-operation.png") });

  // A browser-only operation says so.
  await searchFor(page, "createApiKey");
  await expandTag(page, "API Keys");
  await page.locator(".opblock-summary", { hasText: "createApiKey" }).click();
  await page
    .locator(".opblock.is-open")
    .getByText("Needs a signed-in browser session. API keys are refused with 403.", {
      exact: false,
    })
    .waitFor();

  // Authorize offers both ways in.
  await searchFor(page, "");
  await page
    .getByRole("button", { name: /Authorize/ })
    .first()
    .click();
  const dialog = page.locator(".dialog-ux");
  await dialog.getByText("bearerAuth", { exact: false }).waitFor();
  await dialog.getByText("cookieAuth", { exact: false }).waitFor();

  assert.deepEqual(errors, [], "the page threw no errors");
  // eslint-disable-next-line no-console
  console.log("API reference: areas, search, operation detail and Authorize verified.");
} catch (error) {
  await page.screenshot({ path: path.join(output, "api-docs-failure.png") }).catch(() => undefined);
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  restoreSecrets();
}
// The App's services start timers on import; they are not this script's to
// wait for.
process.exit();
