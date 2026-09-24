/** Real Chrome coverage for SSH publishing setup; APIs are deterministic fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await startBrowserFixture("repositorySettingsHarness.tsx", 18478);
const browser = await chromium
  .launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);
const selectedId = "8925cfdf-f492-4928-90bd-d92e5472c509";
let repo = {
  id: "repository",
  companyId: "company",
  slug: "product",
  name: "Product",
  description: "",
  origin: "remote",
  kind: "code",
  gitUrl: "git@github.com:acme/product.git",
  defaultBranch: "main",
  authMode: "ssh",
  httpsUsername: null,
  hasSshKey: true,
  hasToken: false,
  githubConnectionId: null as string | null,
  committerName: null,
  committerEmail: null,
  commandMode: "allowlist",
  allowedCommands: "",
  grantCount: 1,
  forge: null,
};
const patches: Array<Record<string, unknown>> = [];
let failSave = false;
let failConnections = false;
await context.route("**/api/**", async (route) => {
  const request = route.request();
  if (new URL(request.url()).pathname.endsWith("/forge-connections")) {
    return failConnections
      ? route.fulfill({ status: 503, json: { error: "Connections temporarily unavailable" } })
      : route.fulfill({
          json: {
            connections: [
              {
                id: selectedId,
                provider: "github",
                providerName: "GitHub",
                label: "Company GitHub",
                accountLogin: "acme",
                host: "github.com",
              },
            ],
          },
        });
  }
  if (request.method() === "PATCH") {
    const patch = request.postDataJSON() as Record<string, unknown>;
    patches.push(patch);
    if (failSave)
      return route.fulfill({
        status: 400,
        json: { error: "That Connection does not match this repository's clone URL." },
      });
    repo = { ...repo, ...patch };
  }
  return route.fulfill({ json: repo });
});

try {
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  const picker = page.getByRole("combobox", { name: "Pull request Connection", exact: true });
  await picker.click();
  await page
    .getByRole("option", { name: "Company GitHub — @acme · github.com", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Save changes" && button.disabled,
    ),
  );
  assert.equal(patches.length, 1);
  assert.equal(patches[0].githubConnectionId, selectedId);
  assert.equal(patches[0].authMode, "ssh");
  assert.equal(patches[0].gitUrl, "git@github.com:acme/product.git");
  assert.equal(patches[0].sshKey, undefined, "unchanged private key must not be submitted");

  failSave = true;
  await picker.click();
  await page.getByRole("option", { name: "No Connection selected", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText("That Connection does not match this repository's clone URL.", { exact: true })
    .waitFor();
  assert.equal(repo.githubConnectionId, selectedId);
  failSave = false;

  failConnections = true;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Connections temporarily unavailable", { exact: true }).waitFor();
  failConnections = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByText("Connections temporarily unavailable", { exact: true })
    .waitFor({ state: "hidden" });
  await picker.click();
  await page
    .getByRole("option", { name: "Company GitHub — @acme · github.com", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await picker.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const output = path.resolve(root, "../output/playwright");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "repository-ssh-publishing-settings-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Repository Settings browser checks passed: SSH pin/save, preserved key, inline failure, retry, mobile layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
