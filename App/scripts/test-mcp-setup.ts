/**
 * Real Chrome coverage for setting up the Genosyn MCP server from Settings →
 * API keys: the endpoint with the company's real id, copied in one click; the
 * setup for Claude Desktop, Claude Code, Cursor and any other client, each
 * shown and copied exactly as the client takes it, with a placeholder for the
 * key; the new-key dialog filling in the real key; and all of it at phone
 * width without the page scrolling sideways. The API is a deterministic
 * fixture that stores what it is sent. Run with `npm run test:mcp-setup`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import {
  API_KEY_PLACEHOLDER,
  MCP_CLIENTS,
  mcpClientSetup,
  type McpClientId,
} from "../client/lib/mcpSetup";
import { startBrowserFixture } from "./browserFixture";

// Matches the company in apiKeysHarness.tsx.
const COMPANY_ID = "3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f";
const TOKEN = `gen_${"M".repeat(43)}`;

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
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-10-23T09:00:00.000Z",
    };
    keys = [key, ...keys];
    return route.fulfill({ json: { ...key, token: TOKEN } });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

const endpoint = `${fixture.origin}/api/companies/${COMPANY_ID}/mcp`;

async function open(p: Page) {
  await p.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await p.getByRole("heading", { name: "MCP server", exact: true }).waitFor();
}

const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());

/**
 * Walk every client in a setup panel: its tab, the snippet it shows, and the
 * snippet it copies — both exactly what `mcpClientSetup` builds.
 */
async function checkClients(scope: Locator, token: string | null) {
  const tabs = scope.getByRole("tablist", { name: "MCP client", exact: true });
  assert.deepEqual(
    await tabs.getByRole("tab").allInnerTexts(),
    MCP_CLIENTS.map((client) => client.label),
  );
  for (const client of MCP_CLIENTS) {
    const tab = tabs.getByRole("tab", { name: client.label, exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute("aria-selected"), "true", `${client.label} is selected`);
    const panel = scope.getByRole("tabpanel", { name: `${client.label} setup`, exact: true });
    const expected = mcpClientSetup(client.id as McpClientId, { url: endpoint, token });
    assert.equal(
      (await panel.locator("pre").innerText()).trim(),
      expected.snippet,
      `${client.label} shows its setup`,
    );
    await panel.getByText(expected.where, { exact: true }).waitFor();
    await panel.getByText(expected.note, { exact: true }).waitFor();
    await panel.getByRole("button", { name: `Copy the ${client.label} setup`, exact: true }).click();
    await panel
      .getByRole("button", { name: `Copy the ${client.label} setup`, exact: true })
      .getByText("Copied")
      .waitFor();
    const copied = await clipboard(scope.page());
    assert.equal(copied, expected.snippet, `${client.label} copies its setup`);
    if (expected.language === "json") {
      // What lands in claude_desktop_config.json or mcp.json must parse.
      assert.doesNotThrow(() => JSON.parse(copied), `${client.label} copies valid JSON`);
    }
    assert.ok(copied.includes(endpoint), `${client.label} names the endpoint`);
    assert.ok(
      copied.includes(`Bearer ${token ?? API_KEY_PLACEHOLDER}`),
      `${client.label} carries the key as a Bearer token`,
    );
  }
}

try {
  await open(page);

  // The endpoint, with the company's real id, ready to copy.
  const card = page.locator("div.rounded-xl", {
    has: page.getByRole("heading", { name: "MCP server", exact: true }),
  });
  await card.getByText("Endpoint", { exact: true }).waitFor();
  await card.getByText(endpoint, { exact: true }).waitFor();
  await card
    .getByText("Streamable HTTP. Send an API key from above as a Bearer token.", { exact: true })
    .waitFor();
  await card.getByRole("button", { name: "Copy the MCP endpoint", exact: true }).click();
  await card
    .getByRole("button", { name: "Copy the MCP endpoint", exact: true })
    .getByText("Copied")
    .waitFor();
  assert.equal(await clipboard(page), endpoint);

  // Claude Desktop is the first client shown, before anything is clicked.
  const desktop = card.getByRole("tab", { name: "Claude Desktop", exact: true });
  assert.equal(await desktop.getAttribute("aria-selected"), "true");
  await card.getByText(`Replace ${API_KEY_PLACEHOLDER} with a key from above.`).waitFor();
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "mcp-setup-desktop.png"), fullPage: true });

  // Every client: shown and copied exactly, with the placeholder for the key.
  await checkClients(card, null);

  // A new key fills the real key into the same setup.
  await page.getByRole("button", { name: "Generate key", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Claude Desktop");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Copy your new API key", { exact: true }).waitFor();
  await dialog.getByText("Connect an MCP client", { exact: true }).waitFor();
  assert.deepEqual(created, [{ name: "Claude Desktop", expiresAt: null }]);
  assert.equal(
    await dialog.getByText(`Replace ${API_KEY_PLACEHOLDER}`).count(),
    0,
    "with the real key there is nothing to replace",
  );
  await page.screenshot({ path: path.join(output, "mcp-setup-new-key.png") });
  await checkClients(dialog, TOKEN);
  // The first request the dialog offers is still the REST one.
  assert.match(await dialog.locator("pre").filter({ hasText: "curl -H" }).innerText(), /\/me$/m);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByText("Claude Desktop", { exact: true }).first().waitFor();

  // At phone width nothing pushes the page sideways: long setup scrolls in its own box.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const url = page.getByText(endpoint, { exact: true });
  const box = await url.boundingBox();
  assert.ok(box, "the endpoint is laid out");
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "the endpoint wraps to fit a phone");
  for (const client of MCP_CLIENTS) {
    await page.getByRole("tab", { name: client.label, exact: true }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false, `${client.label}: the page does not scroll sideways on a phone`);
    const pre = page
      .getByRole("tabpanel", { name: `${client.label} setup`, exact: true })
      .locator("pre");
    const preBox = await pre.boundingBox();
    assert.ok(preBox && preBox.x + preBox.width <= 390, `${client.label}: the setup box fits`);
  }
  await page.screenshot({ path: path.join(output, "mcp-setup-phone.png"), fullPage: true });

  assert.deepEqual(unexpected, [], "every API call was expected");
  assert.deepEqual(errors, [], "the page threw no errors");
  // eslint-disable-next-line no-console
  console.log(
    "Settings → API keys → MCP server: endpoint, four clients' setup, new-key setup and phone layout verified.",
  );
} finally {
  await browser.close();
  await fixture.close();
}
