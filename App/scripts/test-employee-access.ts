/** Real Chrome + real Express/services/SQLite: one AI Employee's Access page, end to end.
 * Run with Node 22 after `npm run build:client`: npm run test:employee-access
 * Boots an isolated in-memory company (scripts/employeeAccessServer.ts) on free ports,
 * signs in through the UI, and drives the page at desktop and phone widths.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(appRoot, "../output/playwright");
await fs.mkdir(output, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-employee-access-"));

/** A port nobody is listening on right now — other suites run beside this one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const uiPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`;
const serverLogPath = path.join(output, "employee-access-server.log");
const browserLogPath = path.join(output, "employee-access-browser.log");
await fs.writeFile(serverLogPath, "");
await fs.writeFile(browserLogPath, "");

const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/employeeAccessServer.ts", testRoot, String(port), String(uiPort)],
  { cwd: appRoot, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
child.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
  for (const line of String(chunk).split("\n")) {
    if (line.startsWith("[access-stage]") || line.startsWith("[genosyn] listening")) console.log(line);
  }
});
child.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});

let browser: Browser | undefined;
let page: Page | undefined;
const checks: string[] = [];
const pageErrors: string[] = [];

function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (child.exitCode !== null) {
      throw new Error(`App exited (${child.exitCode}) while ${what}: ${serverLog.slice(-6000)}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out ${what}: ${serverLog.slice(-4000)}`);
    await delay(200);
  }
}

type Listing = {
  items: Array<{
    key: string;
    kind: string;
    label: string;
    grant: { level: string | null; byDefault: boolean } | null;
    canChange: boolean;
  }>;
};

async function readListing(companyId: string, employeeId: string): Promise<Listing> {
  const response = await page!.request.get(
    `${origin}/api/companies/${companyId}/employees/${employeeId}/access`,
  );
  assert.equal(response.status(), 200, await response.text());
  return response.json() as Promise<Listing>;
}

function grantOf(listing: Listing, label: string) {
  const item = listing.items.find((entry) => entry.label === label);
  assert.ok(item, `${label} is listed`);
  return item.grant;
}

/** The row for one thing on the page, by its exact name. */
function row(label: string): Locator {
  return page!.locator(`li[data-access-label=${JSON.stringify(label)}]`);
}

async function tick(label: string) {
  await row(label).getByRole("checkbox", { name: `Select ${label}`, exact: true }).check();
}

async function badge(label: string): Promise<string> {
  return (await row(label).locator("[data-access-badge]").innerText()).trim();
}

async function waitForBadge(label: string, text: string) {
  await row(label).locator("[data-access-badge]", { hasText: text }).waitFor({ timeout: 60_000 });
  assert.equal(await badge(label), text, `${label} shows ${text}`);
}

async function bulk(action: "Grant" | "Change level" | "Level" | "Revoke") {
  await page!
    .getByRole("toolbar", { name: "Selected items" })
    .getByRole("button", { name: action, exact: true })
    .click();
  return page!.getByRole("dialog");
}

async function chooseOption(combobox: Locator, option: string) {
  await combobox.click();
  await page!.getByRole("option", { name: option, exact: true }).click();
}

async function noHorizontalScroll(where: string) {
  const overflow = await page!.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `${where}: the page scrolls sideways by ${overflow}px`);
}

try {
  await until(
    () =>
      serverLog.includes(`[genosyn] listening on :${port}`) &&
      serverLog.includes(`[access-stage] built client listening on :${uiPort}`),
    "starting the isolated app",
    600_000,
  );
  const seed = JSON.parse(serverLog.match(/\[access-seed\] (\{.*\})/)![1]) as {
    companyId: string;
    companySlug: string;
    employeeId: string;
    employeeSlug: string;
  };
  const accessPath = `/c/${seed.companySlug}/employees/${seed.employeeSlug}/settings/access`;

  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  // The machine runs other suites at once; give every step room.
  context.setDefaultTimeout(60_000);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") appendFileSync(browserLogPath, `CONSOLE ${message.text()}\n`);
  });
  page.on("response", (response) => {
    const request = response.request();
    if (response.url().startsWith(`${origin}/api/`) && (request.method() !== "GET" || response.status() >= 400)) {
      appendFileSync(browserLogPath, `${request.method()} ${response.status()} ${response.url()}\n`);
    }
  });

  // ── Sign in as the owner through the real form.
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByLabel("Email", { exact: true }).fill("access-owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Access-QA-password-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "Access QA Co", exact: true }).waitFor({
    timeout: 120_000,
  });
  record("Signed in as the company owner through the UI");

  // ── The new employee's Access page, as the hire flow opens it.
  await page.goto(`${origin}${accessPath}?welcome=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Access", exact: true }).waitFor();
  await page.getByText("Ada is hired. Next, choose what Ada can reach.", { exact: true }).waitFor();
  assert.match(await page.locator("[data-access-summary]").innerText(), /^Ada holds\s+0 Grants/);
  const rail = page.getByRole("navigation", { name: "Employee settings" }).last();
  assert.equal(
    await rail.getByRole("link", { name: "Access", exact: true }).getAttribute("aria-current"),
    "page",
  );
  for (const group of [
    "Connections",
    "Mailboxes",
    "Calendars",
    "Repositories",
    "Notes and notebooks",
    "Bases",
    "Charts and dashboards",
    "Resources",
    "Vault items",
    "Member browsers",
    "Routines",
    "Company sections",
  ]) {
    await page.getByRole("heading", { name: group, exact: true }).waitFor();
  }
  // Notes in the trash are not offered.
  assert.equal(await row("Retired pricing").count(), 0);
  // A sub-page under nothing granted has no access yet.
  assert.equal(await badge("Refund exceptions"), "No access");
  record("A new employee's Access page lists every grantable kind, nothing granted, trash left out");
  await page.screenshot({ path: path.join(output, "employee-access-desktop.png"), fullPage: true });

  // ── Consent-only: another Member's browser cannot be granted from here.
  const colleagueBrowser = row("Bob Member's browser");
  await colleagueBrowser.getByText(/Only Bob Member can grant this browser/).waitFor();
  assert.equal(
    await colleagueBrowser.getByRole("checkbox", { name: "Select Bob Member's browser" }).isDisabled(),
    true,
  );
  assert.equal(await badge("Bob Member's browser"), "Not shown to you");
  record("Another Member's browser is shown locked, with the reason only its owner can grant it");

  // ── Search and the kind filter.
  const search = page.getByRole("searchbox");
  await search.fill("refund");
  await row("Refund policy").waitFor();
  assert.equal(await row("Refund exceptions").count(), 1);
  assert.equal(await row("Onboarding checklist").count(), 0);
  assert.equal(await row("ops@acme.test").count(), 0);
  await search.fill("");
  await chooseOption(page.getByRole("combobox", { name: "Kind" }), "Mailboxes");
  await row("ops@acme.test").waitFor();
  assert.equal(await row("Refund policy").count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Company sections" }).count(), 0);
  await chooseOption(page.getByRole("combobox", { name: "Kind" }), "Every kind");
  await row("Refund policy").waitFor();
  record("Search and the kind filter narrow the list and clear back to everything");

  // ── Grant several things of mixed kinds at once, one level chosen under Advanced.
  for (const label of [
    "ops@acme.test",
    "Playbooks",
    "Refund policy",
    "Leads",
    "Stripe dashboard",
    "Work laptop",
    "Finance",
  ]) {
    await tick(label);
  }
  await page.getByRole("toolbar", { name: "Selected items" }).getByText("7 selected").waitFor();
  let dialog = await bulk("Grant");
  await dialog.getByRole("heading", { name: "Grant access to Ada" }).waitFor();
  await dialog.getByText("Will grant").waitFor();
  await dialog.getByRole("button", { name: /Advanced/ }).click();
  await chooseOption(dialog.getByRole("combobox", { name: "Level for Mailboxes" }), "Send");
  await chooseOption(dialog.getByRole("combobox", { name: "Level for Notes" }), "Can view");
  await dialog.getByRole("button", { name: "Grant 7 items", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForBadge("ops@acme.test", "Send");
  await waitForBadge("Playbooks", "Can edit");
  await waitForBadge("Refund policy", "Can view");
  await waitForBadge("Leads", "Granted");
  await waitForBadge("Stripe dashboard", "Use");
  await waitForBadge("Work laptop", "Granted");
  await waitForBadge("Finance", "Read only");
  // The notebook's Grant reaches every page in it, so the sub-page says so.
  await waitForBadge("Refund exceptions", "Can edit via notebook");
  assert.equal(await page.getByRole("toolbar", { name: "Selected items" }).count(), 0);
  let listing = await readListing(seed.companyId, seed.employeeId);
  assert.deepEqual(grantOf(listing, "ops@acme.test"), { level: "send", byDefault: false });
  assert.deepEqual(grantOf(listing, "Refund policy"), { level: "read", byDefault: false });
  assert.deepEqual(grantOf(listing, "Finance"), { level: "read", byDefault: false });
  record("Granted seven things of six kinds at once, each at its own level");
  await page.screenshot({ path: path.join(output, "employee-access-granted.png"), fullPage: true });

  // ── Change the level of a mailbox and a note together.
  await tick("ops@acme.test");
  await tick("Refund policy");
  dialog = await bulk("Change level");
  await dialog.getByRole("heading", { name: "Change Ada's access level" }).waitFor();
  await chooseOption(dialog.getByRole("combobox", { name: "Level for Mailboxes" }), "Read");
  await chooseOption(dialog.getByRole("combobox", { name: "Level for Notes" }), "Can edit");
  await dialog.getByRole("button", { name: "Change 2 items", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForBadge("ops@acme.test", "Read");
  await waitForBadge("Refund policy", "Can edit");
  record("Changed two Grants' levels in one go");

  // ── Revoke two.
  await tick("Leads");
  await tick("Stripe dashboard");
  dialog = await bulk("Revoke");
  await dialog.getByRole("heading", { name: "Revoke Ada's access" }).waitFor();
  await dialog.getByRole("button", { name: "Revoke 2 items", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForBadge("Leads", "No access");
  await waitForBadge("Stripe dashboard", "No access");
  record("Revoked two Grants at once");

  // ── Granted / not granted filters.
  await page.getByRole("button", { name: "Has access", exact: true }).click();
  await row("ops@acme.test").waitFor();
  assert.equal(await row("Leads").count(), 0);
  await page.getByRole("button", { name: "No access", exact: true }).click();
  await row("Leads").waitFor();
  assert.equal(await row("ops@acme.test").count(), 0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  record("The granted / not granted filter splits the list");

  // ── Reload: everything was saved.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBadge("ops@acme.test", "Read");
  await waitForBadge("Refund policy", "Can edit");
  await waitForBadge("Playbooks", "Can edit");
  await waitForBadge("Finance", "Read only");
  await waitForBadge("Work laptop", "Granted");
  await waitForBadge("Leads", "No access");
  await waitForBadge("Stripe dashboard", "No access");
  assert.match(await page.locator("[data-access-summary]").innerText(), /^Ada holds\s+5 Grants/);
  listing = await readListing(seed.companyId, seed.employeeId);
  assert.equal(grantOf(listing, "Leads"), null);
  record("After a reload the page shows exactly what was saved");

  // ── The audit log has one row per Grant change, written by each kind's own route.
  const audit = await page.request.get(`${origin}/api/companies/${seed.companyId}/audit?take=200`);
  assert.equal(audit.status(), 200, await audit.text());
  const actions = ((await audit.json()) as { items: Array<{ action: string }> }).items.map(
    (event) => event.action,
  );
  for (const action of [
    "mail.grant.create",
    "mail.grant.update",
    "notebook.grant",
    "note.grant",
    "note.access.update",
    "base_grant.create",
    "base_grant.delete",
    "vault.employee_grant.upsert",
    "vault.employee_grant.delete",
    "member_browser.grant",
    "finance.grant.create",
  ]) {
    assert.ok(actions.includes(action), `audit has ${action}: ${actions.join(", ")}`);
  }
  record("Every change was audited by its own kind's route");

  // ── ⌘K reaches the page from anywhere.
  await page.goto(`${origin}/c/${seed.companySlug}/employees`, { waitUntil: "domcontentloaded" });
  await page.locator("header").getByRole("button", { name: "Access QA Co", exact: true }).waitFor();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.waitFor();
  await palette.getByRole("combobox").fill("ada access");
  await palette.getByRole("option", { name: /Access — Ada/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === accessPath);
  await page.getByRole("heading", { name: "Access", exact: true }).waitFor();
  record("⌘K finds “Access — Ada” and opens it");

  // ── Phone width: the same page, one column, no sideways scroll, the bar in reach.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}${accessPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Access", exact: true }).waitFor();
  const pills = page.getByRole("navigation", { name: "Employee settings" }).first();
  await pills.getByRole("link", { name: "Access", exact: true }).waitFor();
  await waitForBadge("ops@acme.test", "Read");
  await noHorizontalScroll("Access page on a phone");
  await tick("Leads");
  await tick("Brand guide");
  const bar = page.getByRole("toolbar", { name: "Selected items" });
  await bar.getByText("2 selected").waitFor();
  const box = await bar.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, "the bulk bar fits the phone");
  await page.screenshot({ path: path.join(output, "employee-access-phone.png"), fullPage: false });
  dialog = await bulk("Grant");
  await dialog.getByRole("button", { name: "Grant 2 items", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForBadge("Leads", "Granted");
  await waitForBadge("Brand guide", "Read");
  await noHorizontalScroll("Access page on a phone after granting");
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForBadge("Leads", "Granted");
  await waitForBadge("Brand guide", "Read");
  record("At phone width the page fits, the bulk bar is in reach, and a grant sticks");

  // ── A plain Member: rows only owners and admins change are locked, said once
  // per group; their own browser is theirs to grant, and notes are anyone's.
  const ownerPage = page;
  const memberContext = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  memberContext.setDefaultTimeout(60_000);
  await memberContext.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });
  page = await memberContext.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByLabel("Email", { exact: true }).fill("access-colleague@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Access-QA-password-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "Access QA Co", exact: true }).waitFor({
    timeout: 120_000,
  });
  await page.goto(`${origin}${accessPath}`, { waitUntil: "domcontentloaded" });
  const mailGroup = page.locator('section[data-access-group="mail"]');
  await mailGroup.getByText("Only owners and admins can grant Mailboxes.", { exact: true }).waitFor();
  assert.equal(
    await row("ops@acme.test").getByRole("checkbox", { name: "Select ops@acme.test" }).isDisabled(),
    true,
  );
  // The owner's browser is theirs: Bob sees it locked, by its owner's name only.
  await row("Olivia Owner's browser").getByText(/Only Olivia Owner can grant this browser/).waitFor();
  await tick("Home desktop");
  await tick("Onboarding checklist");
  dialog = await bulk("Grant");
  await dialog.getByRole("button", { name: "Grant 2 items", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForBadge("Home desktop", "Granted");
  await waitForBadge("Onboarding checklist", "Can edit");
  await memberContext.close();
  page = ownerPage;
  await page.goto(`${origin}${accessPath}`, { waitUntil: "domcontentloaded" });
  // The owner sees the note Bob granted, but not who may use Bob's browser.
  await waitForBadge("Onboarding checklist", "Can edit");
  await waitForBadge("Bob Member's browser", "Not shown to you");
  record("A Member grants their own browser and a note; owners-and-admins rows stay locked for them");

  // ── The guided setup's Access step is the same panel.
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto(`${origin}/c/${seed.companySlug}/onboarding?step=access&employee=${seed.employeeId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Choose what Ada can reach", exact: true }).waitFor();
  await waitForBadge("ops@acme.test", "Read");
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await page.getByRole("heading", { name: "Ada has joined Access QA Co", exact: true }).waitFor();
  // Five kept from the desktop run, two granted at phone width, and the note
  // Bob granted; Bob's browser is not counted for someone who cannot see it.
  await page.getByText(/^8 Grants\b/).waitFor();
  record("The guided setup has an Access step, and its summary counts the Grants");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
  console.log(`\n${checks.length} checks passed.`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, "employee-access-failure.png"), fullPage: true }).catch(() => undefined);
  }
  console.error(error);
  console.error(`Server log: ${serverLogPath}\nBrowser log: ${browserLogPath}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.rm(testRoot, { recursive: true, force: true });
}
