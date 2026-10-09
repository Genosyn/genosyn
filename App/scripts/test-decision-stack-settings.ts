/**
 * Real Chrome coverage for Decision stack → Settings: the section rail's new
 * Settings page, the switch (on by default, off with the right note, a
 * refusal shown inline), the instructions box (the default text, editing,
 * saving with loading, Cancel, Restore default, refusals, an emptied box, too
 * many lines, the keyboard shortcut), the "off" banner on the stack with a
 * question that stays answerable, a Member's read-only view, and phone width.
 * The API is a deterministic fixture that stores what it is sent, the way the
 * server would. Run with `npm run test:decision-stack-settings`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  DEFAULT_DECISION_STACK_INSTRUCTIONS,
  normalizeDecisionStackInstructions,
  sameDecisionStackInstructions,
} from "../shared/decisionStackInstructions";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("decisionStackSettingsHarness.tsx", 0);
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

// ───────────────────────────── the API fixture ─────────────────────────────

let viewerRole: "owner" | "admin" | "member" = "admin";
let enabled = true;
/** The stored column: null follows the default. */
let stored: string | null = null;
let refusal: string | null = null;
let switchRefusal: string | null = null;
const patches: Array<Record<string, unknown>> = [];
const decides: Array<{ id: string; optionId: string }> = [];

const DEFAULT_LINES = DEFAULT_DECISION_STACK_INSTRUCTIONS.split("\n").length;
const NOW = "2026-10-09T09:00:00.000Z";

type Row = Record<string, unknown> & { id: string; status: string; title: string };
let rows: Row[] = [];

function waitingDecision(): Row {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company",
    title: "Choose Acme's renewal price",
    body: "Acme renews next week. Their usage doubled this year.",
    options: [
      { id: "keep", label: "Keep the price", detail: "I will renew at today's price.", tone: "neutral" },
      { id: "raise", label: "Raise it 5%", detail: "I will send the new quote.", tone: "primary" },
    ],
    status: "pending",
    urgency: "normal",
    routineId: null,
    runId: null,
    conversationId: null,
    mailThreadId: null,
    source: { kind: "unknown", routine: null, run: null, conversation: null, mailThread: null },
    chosenOptionId: null,
    chosenOptionLabel: null,
    note: null,
    decidedAt: null,
    decidedByUserId: null,
    decidedBy: null,
    decidedByEmployee: null,
    routedToEmployee: null,
    pickupStatus: "none",
    pickupSummary: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    snoozedUntil: null,
    expiresAt: null,
    createdAt: NOW,
    employee: { id: "employee", name: "Alex Rivera", slug: "alex", avatarKey: null },
    assignee: null,
  };
}

function settings() {
  return {
    enabled,
    instructions: stored ?? DEFAULT_DECISION_STACK_INSTRUCTIONS,
    usingDefaultInstructions: stored === null,
    pendingDecisions: rows.filter((row) => row.status === "pending").length,
    canManage: viewerRole !== "member",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the fixture to have seen something, polling from the test's side. */
async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(50);
  }
}

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const { pathname } = url;
  const method = request.method();
  const base = "/api/companies/company";
  if (pathname === `${base}/decision-stack/settings` && method === "GET") {
    return route.fulfill({ json: settings() });
  }
  if (pathname === `${base}/decision-stack/settings` && method === "PATCH") {
    const body = request.postDataJSON() as Record<string, unknown>;
    patches.push(body);
    // Slow enough to see the pressed control working.
    await sleep(350);
    if (viewerRole === "member") {
      return route.fulfill({ status: 403, json: { error: "admin company role required" } });
    }
    if (refusal && "instructions" in body) {
      return route.fulfill({ status: 400, json: { error: refusal } });
    }
    if (switchRefusal && "enabled" in body) {
      return route.fulfill({ status: 503, json: { error: switchRefusal } });
    }
    if (typeof body.enabled === "boolean") enabled = body.enabled;
    if ("instructions" in body) {
      const text = body.instructions;
      stored =
        text === null ||
        sameDecisionStackInstructions(String(text), DEFAULT_DECISION_STACK_INSTRUCTIONS)
          ? null
          : normalizeDecisionStackInstructions(String(text));
    }
    return route.fulfill({ json: settings() });
  }
  if (pathname === `${base}/decisions` && method === "GET") {
    const status = url.searchParams.get("status");
    return route.fulfill({ json: rows.filter((row) => !status || row.status === status) });
  }
  const one = pathname.match(/^\/api\/companies\/company\/decisions\/([^/]+)$/);
  if (one && method === "GET") {
    const row = rows.find((entry) => entry.id === one[1]);
    return row
      ? route.fulfill({ json: row })
      : route.fulfill({ status: 404, json: { error: "Not found" } });
  }
  const decide = pathname.match(/^\/api\/companies\/company\/decisions\/([^/]+)\/decide$/);
  if (decide && method === "POST") {
    const body = request.postDataJSON() as { optionId: string };
    decides.push({ id: decide[1], optionId: body.optionId });
    const row = rows.find((entry) => entry.id === decide[1]);
    if (!row) return route.fulfill({ status: 404, json: { error: "Not found" } });
    const option = (row.options as Array<{ id: string; label: string }>).find(
      (entry) => entry.id === body.optionId,
    );
    Object.assign(row, {
      status: "decided",
      chosenOptionId: body.optionId,
      chosenOptionLabel: option?.label ?? null,
      decidedAt: new Date().toISOString(),
      decidedByUserId: "admin-user",
      decidedBy: { id: "admin-user", name: "Morgan" },
      pickupStatus: "skipped",
      pickupSummary: "No AI Model is connected, so the answer waits on Alex's journal.",
    });
    return route.fulfill({ json: row });
  }
  if (pathname === `${base}/approvals` && method === "GET") {
    return route.fulfill({ json: [] });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

// ───────────────────────────── helpers ─────────────────────────────

const field = () => page.getByRole("textbox", { name: "Instructions", exact: true });
const button = (name: string) => page.getByRole("button", { name, exact: true });
const stackSwitch = () => page.getByRole("switch", { name: "Let AI Employees add decisions" });
const instructionsCard = () =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: "Which questions belong" }),
  });
const switchCard = () =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: "Let AI Employees add decisions" }),
  });

async function openSettings(role: typeof viewerRole = viewerRole) {
  viewerRole = role;
  await page.goto(`${fixture.origin}/?role=${role}&path=/c/acme/decisions/settings`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  });
  await page.getByRole("heading", { name: "Decision stack settings", exact: true }).waitFor();
  await field().waitFor();
}

async function openStack(role: typeof viewerRole = viewerRole) {
  viewerRole = role;
  await page.goto(`${fixture.origin}/?role=${role}&path=/c/acme/decisions`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  });
  await page.getByRole("heading", { name: "Decision stack", exact: true }).waitFor();
}

async function location(): Promise<string> {
  return (await page.getByTestId("location").textContent()) ?? "";
}

async function noHorizontalScroll(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function text(locator = page.locator("main, body").first()): Promise<string> {
  return ((await locator.textContent()) ?? "").replace(/\s+/g, " ");
}

try {
  await fs.mkdir(output, { recursive: true });
  rows = [waitingDecision()];

  // ── The section rail has a Settings page; on by default ─────────────────
  await openSettings("admin");
  const rail = page.getByRole("navigation").filter({ has: page.getByRole("link", { name: "History" }) });
  assert.deepEqual(
    await rail.getByRole("link").allTextContents(),
    ["Active", "History", "Settings"],
  );
  assert.equal(await stackSwitch().getAttribute("aria-checked"), "true");
  assert.equal(await stackSwitch().isEnabled(), true);
  await switchCard()
    .getByText(/^On\. AI Employees can bring you big decisions/)
    .waitFor();

  // ── The instructions box arrives with the default text ──────────────────
  assert.equal(await field().inputValue(), DEFAULT_DECISION_STACK_INSTRUCTIONS);
  await instructionsCard().getByText("Default", { exact: true }).waitFor();
  await instructionsCard().getByText(`${DEFAULT_LINES} instructions`, { exact: true }).waitFor();
  assert.equal(await button("Save instructions").isDisabled(), true, "nothing to save yet");
  assert.equal(await button("Restore default").count(), 0, "already the default");
  assert.equal(await button("Cancel").count(), 0);
  assert.equal(await field().getAttribute("maxlength"), "4000");
  const intro = await text(instructionsCard());
  assert.match(intro, /Before a question reaches the stack, it is checked against these instructions/);
  assert.match(intro, /A question your instructions keep off the stack is never created/);
  assert.match(intro, /it can.t take a bigger step because of it/);
  assert.match(intro, /Approvals, email reviews and work reviews always reach you/);
  assert.match(intro, /Leave the box empty to let every question through/);

  // Trailing spaces or a blank line at the end are not a change.
  await field().fill(`${DEFAULT_DECISION_STACK_INSTRUCTIONS}   \n\n`);
  assert.equal(await button("Save instructions").isDisabled(), true);

  // ── Editing: add a line, then Cancel ─────────────────────────────────────
  const withHiring = `${DEFAULT_DECISION_STACK_INSTRUCTIONS}\nAlways ask us before hiring anyone.`;
  await field().fill(withHiring);
  assert.equal(await button("Save instructions").isEnabled(), true);
  await instructionsCard().getByText(`${DEFAULT_LINES + 1} instructions`, { exact: true }).waitFor();
  assert.equal(await instructionsCard().getByText("Default", { exact: true }).count(), 0);
  await button("Cancel").click();
  assert.equal(await field().inputValue(), DEFAULT_DECISION_STACK_INSTRUCTIONS);
  assert.equal(patches.length, 0, "Cancel sends nothing");

  // ── Saving shows it is working, then what was stored ────────────────────
  await field().fill(`${withHiring}   `);
  await button("Save instructions").click();
  await page.locator('button[aria-busy="true"]', { hasText: "Save instructions" }).waitFor();
  await button("Restore default").waitFor();
  assert.deepEqual(patches.at(-1), { instructions: `${withHiring}   ` });
  assert.equal(stored, withHiring, "the server stored the tidy text");
  assert.equal(await field().inputValue(), withHiring);
  assert.equal(await button("Save instructions").isDisabled(), true);

  // It survives a reload.
  await openSettings();
  assert.equal(await field().inputValue(), withHiring);
  await button("Restore default").waitFor();

  // ── A refusal stays beside the box, with the person's text intact ───────
  refusal = "Keep the instructions under 4,000 characters.";
  const attempted = `${withHiring}\nNever ask about label colours.`;
  await field().fill(attempted);
  await button("Save instructions").click();
  await instructionsCard().getByRole("alert").filter({ hasText: refusal }).waitFor();
  assert.equal(await field().inputValue(), attempted);
  assert.equal(await page.getByRole("dialog").count(), 0, "no modal for a form error");
  assert.equal(stored, withHiring, "nothing changed");
  refusal = null;
  await field().press("End");
  await field().pressSequentially(" ");
  assert.equal(await instructionsCard().getByRole("alert").count(), 0, "typing clears it");
  // ⌘/Ctrl+Enter saves without reaching for the mouse.
  await field().press("Control+Enter");
  await until(() => stored === attempted, "the keyboard save");
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  await instructionsCard().getByText(`${DEFAULT_LINES + 2} instructions`, { exact: true }).waitFor();

  // ── Too many instructions is refused before anything is sent ────────────
  const sent = patches.length;
  await field().fill(Array.from({ length: 31 }, (_, index) => `Rule ${index + 1}`).join("\n"));
  await instructionsCard()
    .getByRole("alert")
    .filter({ hasText: "Keep it to 30 instructions or fewer, one per line." })
    .waitFor();
  assert.equal(await button("Save instructions").isDisabled(), true);
  assert.equal(patches.length, sent);
  await button("Cancel").click();
  assert.equal(await instructionsCard().getByRole("alert").count(), 0);

  // ── An emptied box means every question goes through, and says so ───────
  await field().fill("");
  await instructionsCard()
    .getByText("No instructions — every question goes on the stack", { exact: true })
    .waitFor();
  await button("Save instructions").click();
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  assert.deepEqual(patches.at(-1), { instructions: "" });
  assert.equal(stored, "");

  // ── Restore default puts the default back ────────────────────────────────
  await button("Restore default").click();
  await instructionsCard().getByText("Default", { exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { instructions: null });
  assert.equal(stored, null);
  assert.equal(await field().inputValue(), DEFAULT_DECISION_STACK_INSTRUCTIONS);
  assert.equal(await button("Restore default").count(), 0);

  // ── A refused switch says so beside it and stays as it was ──────────────
  switchRefusal = "The server is restarting. Try again in a moment.";
  await stackSwitch().click();
  await switchCard().getByRole("alert").filter({ hasText: switchRefusal }).waitFor();
  assert.equal(await stackSwitch().getAttribute("aria-checked"), "true");
  assert.equal(enabled, true);
  switchRefusal = null;

  // ── Switching off: busy while saving, then the note says what still works ─
  await stackSwitch().click();
  await page.locator('[role="switch"][aria-busy="true"]').waitFor();
  await page.getByText("Saving…", { exact: true }).waitFor();
  await until(() => enabled === false, "the switch off");
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false",
  );
  assert.deepEqual(patches.at(-1), { enabled: false });
  assert.equal(await switchCard().getByRole("alert").count(), 0, "the earlier refusal is gone");
  const offNote = await text(switchCard());
  assert.match(offNote, /Off\. AI Employees don.t add new questions/);
  assert.match(offNote, /The question already waiting stays in the stack until someone answers or dismisses it\./);
  assert.match(offNote, /Email and work reviews still arrive as usual\./);
  await instructionsCard()
    .getByText("These apply again as soon as the Decision stack is back on.", { exact: true })
    .waitFor();
  // The instructions stay editable while it is off.
  assert.equal(await field().isEditable(), true);

  // ── The stack says new questions are paused; the waiting one still works ─
  await rail.getByRole("link", { name: "Active" }).click();
  await page.getByRole("heading", { name: "Decision stack", exact: true }).waitFor();
  const banner = page.getByRole("status").filter({ hasText: "The Decision stack is off" });
  await banner.waitFor();
  const bannerText = await text(banner);
  assert.match(bannerText, /AI Employees aren.t adding new questions/);
  assert.match(bannerText, /Questions already here can still be answered or dismissed/);
  assert.match(bannerText, /email and work reviews still arrive/);
  await page.screenshot({ path: path.join(output, "decision-stack-off-desktop.png"), fullPage: true });

  const waitingCard = page.locator('[id="decision-11111111-1111-4111-8111-111111111111"]');
  await waitingCard.waitFor();
  await waitingCard.getByText("Raise it 5%", { exact: true }).click();
  await waitingCard.getByRole("button", { name: "Confirm: Raise it 5%", exact: true }).click();
  await until(() => decides.length === 1, "the answer");
  assert.deepEqual(decides, [{ id: "11111111-1111-4111-8111-111111111111", optionId: "raise" }]);
  await waitingCard.getByText("answered", { exact: true }).waitFor();

  // The banner's link goes back to Settings.
  await banner.getByRole("link", { name: "Turn it back on in Settings" }).click();
  await until(() => true, "navigation");
  await page.getByRole("heading", { name: "Decision stack settings", exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/decisions/settings");
  // The question was answered, so nothing is waiting now.
  await switchCard().getByText(/Off\. AI Employees don.t add new questions/).waitFor();
  assert.doesNotMatch(await text(switchCard()), /already waiting/);

  // ── Turning it back on restores the stack, with no banner ───────────────
  await stackSwitch().click();
  await until(() => enabled === true, "the switch on");
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true",
  );
  await switchCard().getByText(/^On\. AI Employees can bring you big decisions/).waitFor();
  await openStack();
  assert.equal(
    await page.getByRole("status").filter({ hasText: "The Decision stack is off" }).count(),
    0,
  );

  // ── A Member sees everything and changes nothing ─────────────────────────
  enabled = false;
  stored = "Only ask us about hiring.";
  rows = [waitingDecision()];
  const patchesBefore = patches.length;
  await openSettings("member");
  assert.equal(await stackSwitch().isDisabled(), true);
  assert.equal(await stackSwitch().getAttribute("aria-checked"), "false");
  await switchCard().getByText("Only owners and admins can change this.", { exact: true }).waitFor();
  assert.equal(await field().inputValue(), "Only ask us about hiring.");
  assert.equal(await field().getAttribute("readonly"), "");
  assert.equal(await button("Save instructions").count(), 0);
  assert.equal(await button("Restore default").count(), 0);
  await instructionsCard()
    .getByText("Only owners and admins can change these instructions.", { exact: true })
    .waitFor();
  await instructionsCard().getByText("1 instruction", { exact: true }).waitFor();
  await field().press("End");
  await page.keyboard.type(" more");
  assert.equal(await field().inputValue(), "Only ask us about hiring.", "read-only means read-only");
  assert.equal(patches.length, patchesBefore);
  await openStack("member");
  const memberBanner = page.getByRole("status").filter({ hasText: "The Decision stack is off" });
  await memberBanner.getByRole("link", { name: "See Settings" }).waitFor();
  // The waiting question is still answerable by a Member while it is off.
  await page.locator('[id="decision-11111111-1111-4111-8111-111111111111"]').waitFor();

  // ── Phone width ──────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  viewerRole = "admin";
  await openSettings("admin");
  await field().fill(`${stored}\nAlways ask us before signing anything with a supplier we have never used before.`);
  assert.equal(await button("Save instructions").isEnabled(), true);
  assert.equal(await noHorizontalScroll(), true, "the settings fit a phone");
  // Let the buttons' colour transition settle so the screenshot shows them as they are.
  await sleep(300);
  await page.screenshot({
    path: path.join(output, "decision-stack-settings-mobile.png"),
    fullPage: true,
  });
  await button("Cancel").click();
  await openStack("admin");
  await page.getByRole("status").filter({ hasText: "The Decision stack is off" }).waitFor();
  assert.equal(await noHorizontalScroll(), true, "the banner fits a phone");
  await page.screenshot({ path: path.join(output, "decision-stack-off-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  stored = null;
  enabled = true;
  await openSettings("admin");
  await page.screenshot({
    path: path.join(output, "decision-stack-settings-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Decision stack settings browser checks passed: rail Settings page, on by default, default text and Default pill, unchanged Save disabled, edit and Cancel, save with loading and reload, inline refusal and retry, keyboard save, too many lines, emptied box, Restore default, refused switch inline, switch off with busy state and note, off banner with a still-answerable question and its link back, switch on again, Member read-only view and banner, phone and desktop layouts.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
