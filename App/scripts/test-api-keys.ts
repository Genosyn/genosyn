/**
 * Real Chrome coverage for Settings → API keys as the way into the REST API:
 * the company's base URL shown with its real id and copied in one click, the
 * API reference link, generating a key, and a first request that names the
 * company and the new token — on a desktop and at phone width. The API is a
 * deterministic fixture that stores what it is sent. Run with
 * `npm run test:api-keys`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

const COMPANY_ID = "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f";
const TOKEN = `gen_${"Q".repeat(43)}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("apiKeysHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.origin });
const page = await context.newPage();
const errors: string[] = [];
const unexpected: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);

// ───────────────────────────── the API fixture ─────────────────────────────

type Key = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
let keys: Key[] = [];
const created: Array<Record<string, unknown>> = [];

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const base = `/api/companies/${COMPANY_ID}/api-keys`;
  if (pathname === base && method === "GET") return route.fulfill({ json: keys });
  if (pathname === base && method === "POST") {
    const body = request.postDataJSON() as Record<string, unknown>;
    created.push(body);
    const key: Key = {
      id: `key-${created.length}`,
      name: String(body.name),
      prefix: TOKEN.slice(0, 12),
      lastUsedAt: null,
      expiresAt: (body.expiresAt as string | null) ?? null,
      revokedAt: null,
      createdAt: "2026-10-23T09:00:00.000Z",
    };
    keys = [key, ...keys];
    return route.fulfill({ json: { ...key, token: TOKEN } });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

const baseUrl = `${fixture.origin}/api/companies/${COMPANY_ID}`;

async function open(p: Page) {
  await p.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await p.getByRole("heading", { name: "API keys", exact: true }).waitFor();
}

try {
  await open(page);
  await page.getByText("No API keys yet", { exact: true }).waitFor();

  // The company's base URL, with its real id, ready to copy.
  await page.getByText("Base URL", { exact: true }).waitFor();
  await page.getByText(baseUrl, { exact: true }).waitFor();
  await page
    .getByText("Every request a key for this company makes starts here.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Copy the base URL", exact: true }).click();
  await page
    .getByRole("button", { name: "Copy the base URL", exact: true })
    .getByText("Copied")
    .waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), baseUrl);

  // The reference opens from the same card.
  assert.equal(
    await page.getByRole("link", { name: "API reference", exact: true }).getAttribute("href"),
    `${fixture.origin}/api/docs`,
  );
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "api-keys-desktop.png") });

  // Generating a key ends on a first request naming this company and the new token.
  await page.getByRole("button", { name: "Generate key", exact: true }).click();
  await page.getByRole("dialog").getByText("Generate API key", { exact: true }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill("Nightly export");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByText("Copy your new API key", { exact: true }).waitFor();
  assert.deepEqual(created, [{ name: "Nightly export", expiresAt: null }]);
  const example = (await page.locator("pre").filter({ hasText: "curl" }).innerText()).trim();
  assert.equal(example, `curl -H "Authorization: Bearer ${TOKEN}" \\\n  ${baseUrl}/me`);
  await page
    .getByText("It answers with the Member the key acts as, their role, and the key.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: path.join(output, "api-keys-new-key.png") });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByText("Nightly export", { exact: true }).waitFor();

  // At phone width the base URL wraps rather than running off the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const url = page.getByText(baseUrl, { exact: true });
  const box = await url.boundingBox();
  assert.ok(box, "the base URL is laid out");
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "the base URL fits a phone");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, "the page does not scroll sideways on a phone");
  await page.screenshot({ path: path.join(output, "api-keys-phone.png"), fullPage: true });

  assert.deepEqual(unexpected, [], "every API call was expected");
  assert.deepEqual(errors, [], "the page threw no errors");
  // eslint-disable-next-line no-console
  console.log("Settings → API keys: base URL, copy, reference link and first request verified.");
} finally {
  await browser.close();
  await fixture.close();
}
