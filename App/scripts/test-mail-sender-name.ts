/**
 * Real Chrome coverage for a mailbox's sender name on Email → Settings, inside
 * the real settings page. The API is a deterministic fixture that stores what
 * it is sent, the way the server would. Run with `npm run test:mail-sender-name`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { normalizeSenderName } from "../shared/mailSenderName";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("mailSenderNameHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
const unexpected: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);

let provider: "imap" | "gmail" = "imap";
let senderName = "";
let refusal: string | null = null;
const patches: Array<Record<string, unknown>> = [];

function account() {
  return {
    id: "mbx",
    connectionId: "conn",
    provider,
    address: provider === "imap" ? "avery@example.com" : "ops@gmail.com",
    senderName: provider === "imap" ? senderName : "",
    status: "active",
    statusMessage: "",
    lastSyncAt: "2026-10-06T09:00:00.000Z",
    syncState: "succeeded",
    syncAttemptId: null,
    syncStartedAt: null,
    syncFinishedAt: null,
    backfilledAt: "2026-10-01T00:00:00.000Z",
    backfilledCount: 120,
    aiAnalysisEnabled: false,
    aiAnalysisEmployeeId: null,
    aiAnalysisModelId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const base = "/api/companies/company/mail";
  if (method === "GET" && pathname === `${base}/accounts`) {
    return route.fulfill({ json: { accounts: [account()] } });
  }
  if (method === "PATCH" && pathname === `${base}/accounts/mbx`) {
    const body = request.postDataJSON() as Record<string, unknown>;
    patches.push(body);
    if (refusal) return route.fulfill({ status: 400, json: { error: refusal } });
    senderName = normalizeSenderName(String(body.senderName ?? senderName));
    return route.fulfill({ json: { account: account() } });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/ai-analysis`) {
    return route.fulfill({
      json: { enabled: false, employeeId: null, modelId: null, roster: [], resolved: null },
    });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/grants`) {
    return route.fulfill({ json: { direct: [] } });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/grant-candidates`) {
    return route.fulfill({ json: { candidates: [] } });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

/** The mailbox's own card — the first section on the page. */
const card = () => page.locator("section").first();
const field = () => card().getByRole("textbox", { name: "Sender name", exact: true });
const button = (name: string) => card().getByRole("button", { name, exact: true });

async function open() {
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: "Email settings", exact: true }).waitFor();
  await card().getByRole("heading", { name: "Sender name", exact: true }).waitFor();
}

/** What the card says recipients will see. */
async function shown(): Promise<string> {
  const line = card().locator("h2 + p");
  return ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
}

async function refreshes(): Promise<number> {
  return Number(await page.getByTestId("refreshes").textContent());
}

async function noHorizontalScroll(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

try {
  // ── An IMAP mailbox with no name yet ──────────────────────────────────────
  await open();
  assert.equal(await shown(), "Not set — recipients see only avery@example.com.");
  await button("Set name").click();
  assert.equal(
    await field().evaluate((element) => element === document.activeElement),
    true,
    "the field takes focus as it opens",
  );
  assert.equal(await field().getAttribute("maxlength"), "100");
  await card().getByText(/drafts already waiting included/).waitFor();
  assert.equal(await button("Save").isDisabled(), true, "nothing to save before typing");

  // Saving sends the tidy form of what was typed, and the card shows it.
  const before = await refreshes();
  await field().fill("  Avery   Monroe ");
  await button("Save").click();
  await card().getByRole("button", { name: "Edit", exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { senderName: "Avery Monroe" });
  assert.equal(await shown(), "Avery Monroe <avery@example.com>");
  assert.equal(await field().count(), 0, "the editor closes on success");
  await page.waitForFunction(
    (count) => Number(document.querySelector('[data-testid="refreshes"]')?.textContent) > count,
    before,
  );

  // Save has nothing to do until the name actually changes.
  await button("Edit").click();
  assert.equal(await field().inputValue(), "Avery Monroe");
  assert.equal(await button("Save").isDisabled(), true);
  await field().fill(" Avery  Monroe ");
  assert.equal(await button("Save").isDisabled(), true, "the same name, spaced differently");
  await field().fill("Monroe, Avery (Ops)");
  assert.equal(await button("Save").isEnabled(), true);

  // A refusal stays where the person is looking, with their text intact.
  refusal = "A sender name can be at most 100 characters.";
  const patchCount = patches.length;
  await button("Save").click();
  await card().getByText(refusal, { exact: true }).waitFor();
  assert.equal(patches.length, patchCount + 1);
  assert.equal(await field().inputValue(), "Monroe, Avery (Ops)");
  assert.equal(await page.getByRole("dialog").count(), 0, "no modal for a form error");
  assert.equal(await shown(), "Avery Monroe <avery@example.com>", "nothing changed");
  refusal = null;
  await button("Save").click();
  await card().getByRole("button", { name: "Edit", exact: true }).waitFor();
  assert.equal(await shown(), "Monroe, Avery (Ops) <avery@example.com>");
  assert.equal(await card().getByText("A sender name can be at most").count(), 0);

  // Escape and Cancel both close the editor and send nothing.
  const untouched = patches.length;
  await button("Edit").click();
  await field().fill("Somebody else");
  await field().press("Escape");
  await field().waitFor({ state: "detached" });
  await button("Edit").click();
  assert.equal(await field().inputValue(), "Monroe, Avery (Ops)", "Escape kept nothing");
  await field().fill("Somebody else");
  await button("Cancel").click();
  await field().waitFor({ state: "detached" });
  assert.equal(patches.length, untouched);
  assert.equal(await shown(), "Monroe, Avery (Ops) <avery@example.com>");

  // Clearing the name goes back to the bare address.
  await button("Edit").click();
  await field().fill("   ");
  await button("Save").click();
  await card().getByRole("button", { name: "Set name", exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { senderName: "" });
  assert.equal(await shown(), "Not set — recipients see only avery@example.com.");

  // ── A Gmail mailbox: where its name lives, and nothing to edit ────────────
  provider = "gmail";
  await open();
  await card().getByText(/Settings → Accounts → Send mail as/).waitFor();
  for (const label of ["Set name", "Edit"]) assert.equal(await button(label).count(), 0, label);
  assert.equal(await field().count(), 0);

  // ── Phone width, with a long name ─────────────────────────────────────────
  provider = "imap";
  senderName = "Avery Monroe — Customer Success, Acme Northwind Holdings International";
  await fs.mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  assert.equal(await noHorizontalScroll(), true, "a long name truncates instead of scrolling");
  await button("Edit").click();
  assert.equal(await noHorizontalScroll(), true, "the editor fits a phone");
  await page.screenshot({ path: path.join(output, "mail-sender-name-mobile.png"), fullPage: true });
  await field().fill("Avery Monroe");
  await button("Save").click();
  await card().getByRole("button", { name: "Edit", exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: path.join(output, "mail-sender-name-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Mail sender name browser checks passed: unset state, set and normalize, refresh, unchanged Save disabled, inline refusal and retry, Escape and Cancel, clear, Gmail explanation, phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
