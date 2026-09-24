/** Real Chrome coverage for SSH and stored-token publishing; APIs are deterministic fixtures. */
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
let connectionLookups = 0;
let grant = {
  id: "grant",
  repositoryId: "repository",
  employeeId: "employee",
  accessLevel: "read",
  createdAt: "2026-09-24T00:00:00.000Z",
  employee: {
    id: "employee",
    name: "Alex",
    slug: "alex",
    role: "Engineer",
    avatarKey: null,
    pullRequestReady: false,
  },
};
let grantReads = 0;
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname.endsWith("/grant-candidates")) return route.fulfill({ json: [] });
  if (pathname.endsWith("/grants/grant") && request.method() === "PATCH") {
    const patch = request.postDataJSON() as { accessLevel: string };
    grant = {
      ...grant,
      accessLevel: patch.accessLevel,
      employee: { ...grant.employee, pullRequestReady: patch.accessLevel === "write" },
    };
    return route.fulfill({ json: grant });
  }
  if (pathname.endsWith("/grants")) {
    grantReads += 1;
    return route.fulfill({ json: { direct: [grant] } });
  }
  if (pathname.endsWith("/forge-connections")) {
    connectionLookups += 1;
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

  repo = {
    ...repo,
    gitUrl: "https://github.com/acme/product.git",
    authMode: "https",
    hasSshKey: false,
    hasToken: true,
    // Earlier versions asked PAT repositories to select a Connection. It may
    // since have been deleted and must not prevent saving the stored token.
    githubConnectionId: "2bcc9906-0e58-402d-8c6b-cd9479b3f77f",
  };
  // A stored PAT works even when no Connection can be listed. The page must
  // not turn a separate Integration outage into a token setup requirement.
  failConnections = true;
  const previousLookups = connectionLookups;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Pull requests use this token", exact: true }).waitFor();
  assert.equal(await picker.count(), 0);
  assert.equal(connectionLookups, previousLookups);
  await page.getByLabel("Name", { exact: true }).fill("Product with token");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Save changes" && button.disabled,
    ),
  );
  const tokenPatch = patches.at(-1)!;
  assert.equal(tokenPatch.authMode, "https");
  assert.equal(tokenPatch.githubConnectionId, null);
  assert.equal(tokenPatch.gitUrl, "https://github.com/acme/product.git");
  assert.equal(tokenPatch.token, undefined, "unchanged stored token must not be submitted");
  assert.equal(repo.hasToken, true);
  assert.equal(repo.githubConnectionId, null, "a token save clears the obsolete Connection pin");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: path.join(output, "repository-token-publishing-settings-mobile.png"),
    fullPage: true,
  });

  await page.goto(`${fixture.origin}/?access`, { waitUntil: "networkidle" });
  await page.getByText("Alex", { exact: true }).waitFor();
  assert.equal(await page.getByText("PR access configured", { exact: true }).count(), 0);
  const previousGrantReads = grantReads;
  await page.getByRole("combobox", { name: "Repository access level", exact: true }).click();
  await page.getByRole("option", { name: "Work and push session branches", exact: true }).click();
  await page.getByText("PR access configured", { exact: true }).waitFor();
  assert.ok(grantReads > previousGrantReads, "changing access reloads server delivery readiness");
  assert.equal(connectionLookups, previousLookups);
  assert.deepEqual(errors, []);
  console.log(
    "Repository publishing browser checks passed: SSH pin/save, preserved key, inline failure, retry; stored PAT without Connection, preserved token, immediate write-Grant readiness; mobile layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
