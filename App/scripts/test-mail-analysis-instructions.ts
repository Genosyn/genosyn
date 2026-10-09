/**
 * Real Chrome coverage for a mailbox's AI analysis instructions: the box on
 * Email → Settings (the default text, editing, saving, Cancel, Restore
 * default, refusals, an emptied box, the keyboard shortcut, phone width) and
 * what the instructions did on the email itself (each outcome, Undo, a failed
 * Undo, phone width). The API is a deterministic fixture that stores what it
 * is sent, the way the server would. Run with
 * `npm run test:mail-analysis-instructions`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import {
  DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
  normalizeMailAnalysisInstructions,
  sameMailAnalysisInstructions,
} from "../shared/mailAnalysisInstructions";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("mailAnalysisInstructionsHarness.tsx", 0);
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

/** The stored column: null follows the default. */
let stored: string | null = null;
let enabled = true;
let readerAccess: "read" | "draft" = "draft";
let refusal: string | null = null;
let undoRefusal: string | null = null;
const patches: Array<Record<string, unknown>> = [];
const undos: string[] = [];

const STAR_LINE = "Star emails that need my response and look important.";
const UNSUBSCRIBE_LINE = "Unsubscribe me automatically from marketing emails.";
let steps: Array<Record<string, unknown>> = [];

function freshSteps() {
  return [
    {
      id: "auto-0",
      action: "unsubscribe",
      instruction: UNSUBSCRIBE_LINE,
      reason: "A store newsletter you never signed up for.",
      status: "done",
      targetHost: "lists.shop.example",
      detail: "via lists.shop.example",
      appliedAt: "2026-10-09T09:00:00.000Z",
    },
    {
      id: "auto-1",
      action: "star",
      instruction: STAR_LINE,
      reason: "It asks you to confirm Friday's delivery.",
      status: "done",
      appliedAt: "2026-10-09T09:00:01.000Z",
    },
    {
      id: "auto-2",
      action: "archive",
      instruction: "Archive shipping notifications.",
      reason: "Not a shipping notification.",
      status: "skipped",
      detail: "Your instructions changed before this ran.",
    },
    {
      id: "auto-3",
      action: "applyLabel",
      labelName: "Finance",
      instruction: "Label invoices as Finance.",
      reason: "An invoice is attached.",
      status: "failed",
      detail: "The mail server refused the label.",
    },
  ];
}

function account() {
  return {
    id: "mbx",
    connectionId: "conn",
    provider: "gmail",
    address: "owner@acme.example",
    senderName: "",
    status: "active",
    statusMessage: "",
    lastSyncAt: "2026-10-09T09:00:00.000Z",
    syncState: "succeeded",
    syncAttemptId: null,
    syncStartedAt: null,
    syncFinishedAt: null,
    backfilledAt: "2026-10-01T00:00:00.000Z",
    backfilledCount: 120,
    aiAnalysisEnabled: enabled,
    aiAnalysisEmployeeId: null,
    aiAnalysisModelId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function settings() {
  return {
    enabled,
    employeeId: null,
    modelId: null,
    instructions: stored ?? DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
    usingDefaultInstructions: stored === null,
    roster: [
      {
        id: "jamie",
        name: "Jamie Mallers",
        slug: "jamie-mallers",
        role: "Inbox manager",
        avatarKey: null,
        accessLevel: readerAccess,
        hasModel: true,
        models: [{ id: "qwen", provider: "custom", model: "Qwen/Qwen3.8-27B", isActive: true }],
      },
    ],
    resolved: {
      employeeId: "jamie",
      employeeName: "Jamie Mallers",
      modelId: "qwen",
      modelLabel: "Qwen/Qwen3.8-27B",
      accessLevel: readerAccess,
    },
  };
}

function analysis() {
  return {
    id: "analysis",
    threadId: "thread",
    messageId: "message",
    status: "succeeded",
    employeeId: "jamie",
    modelId: "qwen",
    category: "marketing",
    summary: "A spring sale from a shop, with an invoice attached.",
    actions: [{ id: "0", kind: "draft_reply", label: "Prepare a reply", bodyText: "Thanks!" }],
    automaticActions: steps,
    errorMessage: "",
    createdAt: "2026-10-09T08:59:00.000Z",
    finishedAt: new Date().toISOString(),
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
  const { pathname } = new URL(request.url());
  const method = request.method();
  const base = "/api/companies/company/mail";
  if (method === "GET" && pathname === `${base}/accounts`) {
    return route.fulfill({ json: { accounts: [account()] } });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/ai-analysis`) {
    return route.fulfill({ json: settings() });
  }
  if (method === "PATCH" && pathname === `${base}/accounts/mbx/ai-analysis`) {
    const body = request.postDataJSON() as Record<string, unknown>;
    patches.push(body);
    // Slow enough to see the pressed button working.
    await sleep(350);
    if (refusal && "instructions" in body) {
      return route.fulfill({ status: 400, json: { error: refusal } });
    }
    if (typeof body.enabled === "boolean") enabled = body.enabled;
    if ("instructions" in body) {
      const text = body.instructions;
      stored =
        text === null || sameMailAnalysisInstructions(String(text), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS)
          ? null
          : normalizeMailAnalysisInstructions(String(text));
    }
    const current = settings();
    return route.fulfill({
      json: {
        account: account(),
        resolved: current.resolved,
        instructions: current.instructions,
        usingDefaultInstructions: current.usingDefaultInstructions,
      },
    });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/grants`) {
    return route.fulfill({ json: { direct: [] } });
  }
  if (method === "GET" && pathname === `${base}/accounts/mbx/grant-candidates`) {
    return route.fulfill({ json: { candidates: [] } });
  }
  if (method === "GET" && pathname === `${base}/threads/thread`) {
    return route.fulfill({
      json: {
        thread: { id: "thread", subject: "Spring sale" },
        account: { id: "mbx", address: "owner@acme.example" },
        messages: [],
        handovers: [],
        analyses: [analysis()],
        reviewTimeline: { events: [], truncated: false },
      },
    });
  }
  const undo = pathname.match(/^\/api\/companies\/company\/mail\/analyses\/analysis\/automatic\/([^/]+)\/undo$/);
  if (method === "POST" && undo) {
    undos.push(undo[1]);
    await sleep(350);
    if (undoRefusal) return route.fulfill({ status: 400, json: { error: undoRefusal } });
    steps = steps.map((step) =>
      step.id === undo[1] ? { ...step, status: "undone", undoneAt: new Date().toISOString() } : step,
    );
    return route.fulfill({ json: { analysis: analysis(), message: "Unstarred" } });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

// ───────────────────────────── helpers ─────────────────────────────

const card = () =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "AI analysis" }) });
const field = () => card().getByRole("textbox", { name: "Instructions", exact: true });
const button = (name: string) => card().getByRole("button", { name, exact: true });

async function openSettings() {
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: "Email settings", exact: true }).waitFor();
  await field().waitFor();
}

async function openCard() {
  await page.goto(`${fixture.origin}/?view=card`, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByText("Your instructions", { exact: true }).waitFor();
}

async function noHorizontalScroll(target: Page = page): Promise<boolean> {
  return target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function cardText(): Promise<string> {
  return ((await card().textContent()) ?? "").replace(/\s+/g, " ");
}

try {
  // ── The box arrives with the default instructions in it ──────────────────
  await openSettings();
  assert.equal(await field().inputValue(), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
  await card().getByText("Default", { exact: true }).waitFor();
  assert.equal(await button("Save instructions").isDisabled(), true, "nothing to save yet");
  assert.equal(await button("Restore default").count(), 0, "already the default");
  assert.equal(await button("Cancel").count(), 0);
  await card().getByText("2 instructions", { exact: true }).waitFor();
  const intro = await cardText();
  assert.match(intro, /Only your instructions run on their own/);
  assert.match(intro, /Every new email is checked against these/);
  assert.match(intro, /It never replies, sends, forwards or deletes/);
  assert.match(intro, /all but an unsubscribe can be undone there/);
  assert.match(intro, /Jamie Mallers reads new mail on Qwen\/Qwen3\.8-27B\./);
  assert.equal(
    await field().evaluate((element) => element.getAttribute("maxlength")),
    "4000",
  );

  // Trailing spaces or a blank line at the end are not a change.
  await field().fill(`${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}   \n\n`);
  assert.equal(await button("Save instructions").isDisabled(), true);

  // ── Editing: add a line of their own, then Cancel ────────────────────────
  const withArchive = `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}\nArchive shipping notifications.`;
  await field().fill(withArchive);
  assert.equal(await button("Save instructions").isEnabled(), true);
  await card().getByText("3 instructions", { exact: true }).waitFor();
  assert.equal(await card().getByText("Default", { exact: true }).count(), 0);
  await button("Cancel").click();
  assert.equal(await field().inputValue(), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
  assert.equal(patches.length, 0, "Cancel sends nothing");

  // ── Saving shows it is working, then shows what was stored ───────────────
  await field().fill(`${withArchive}   `);
  await button("Save instructions").click();
  await card()
    .locator('button[aria-busy="true"]', { hasText: "Save instructions" })
    .waitFor();
  await button("Restore default").waitFor();
  assert.deepEqual(patches.at(-1), { instructions: `${withArchive}   ` });
  assert.equal(stored, withArchive, "the server stored the tidy text");
  assert.equal(await field().inputValue(), withArchive);
  assert.equal(await button("Save instructions").isDisabled(), true);
  assert.equal(await card().getByText("Default", { exact: true }).count(), 0);

  // It survives a reload.
  await openSettings();
  assert.equal(await field().inputValue(), withArchive);
  await button("Restore default").waitFor();

  // ── A refusal stays in the card, with the person's text intact ───────────
  refusal = "Keep the instructions under 4,000 characters.";
  const attempted = `${withArchive}\nLabel invoices as Finance.`;
  await field().fill(attempted);
  await button("Save instructions").click();
  await card().getByRole("alert").filter({ hasText: refusal }).waitFor();
  assert.equal(await field().inputValue(), attempted);
  assert.equal(await page.getByRole("dialog").count(), 0, "no modal for a form error");
  assert.equal(stored, withArchive, "nothing changed");
  refusal = null;
  // Typing clears the stale error; saving again works.
  await field().press("End");
  await field().pressSequentially(" ");
  assert.equal(await card().getByRole("alert").count(), 0);
  // ⌘/Ctrl+Enter saves without reaching for the mouse.
  await field().press("Control+Enter");
  await until(() => stored === `${withArchive}\nLabel invoices as Finance.`, "the keyboard save");
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  await card().getByText("4 instructions", { exact: true }).waitFor();
  assert.equal(await field().inputValue(), `${withArchive}\nLabel invoices as Finance.`);

  // ── Too many instructions is refused before anything is sent ────────────
  const sent = patches.length;
  await field().fill(Array.from({ length: 31 }, (_, index) => `Rule ${index + 1}`).join("\n"));
  await card()
    .getByRole("alert")
    .filter({ hasText: "Keep it to 30 instructions or fewer, one per line." })
    .waitFor();
  assert.equal(await button("Save instructions").isDisabled(), true);
  assert.equal(patches.length, sent);
  await button("Cancel").click();
  assert.equal(await card().getByRole("alert").count(), 0);

  // ── An emptied box means no instructions, and says so ────────────────────
  await field().fill("");
  await card()
    .getByText("No instructions — new mail gets a summary and suggestions only", { exact: true })
    .waitFor();
  await button("Save instructions").click();
  await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
  assert.deepEqual(patches.at(-1), { instructions: "" });
  assert.equal(stored, "");
  assert.equal(await field().inputValue(), "");
  await button("Restore default").waitFor();

  // ── Restore default puts the default back ────────────────────────────────
  await button("Restore default").click();
  await card().getByText("Default", { exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { instructions: null });
  assert.equal(stored, null);
  assert.equal(await field().inputValue(), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
  assert.equal(await button("Restore default").count(), 0);

  // ── Turning analysis off hides the box; a Read-access reader is warned ──
  const toggle = card().getByRole("switch", { name: "Analyse new email with AI" });
  await toggle.click();
  await card().getByText(/without a summary, action buttons, or automatic steps/).waitFor();
  assert.equal(await field().count(), 0);
  await until(() => !enabled, "analysis switched off");
  await toggle.click();
  await field().waitFor();
  await until(() => enabled, "analysis switched back on");
  await page.waitForFunction(() => !document.querySelector('[role="switch"][disabled]'));
  assert.equal(await field().inputValue(), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
  readerAccess = "read";
  await openSettings();
  await card().getByText(/cannot prepare a reply for Needs you or carry out your instructions/).waitFor();
  readerAccess = "draft";

  // ── Phone width ──────────────────────────────────────────────────────────
  await fs.mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  stored = `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}\nArchive shipping notifications from couriers, carriers and every marketplace we sell on.`;
  await openSettings();
  await field().fill(`${stored}\nLabel invoices as Finance.`);
  assert.equal(await noHorizontalScroll(), true, "the box and its buttons fit a phone");
  await card().scrollIntoViewIfNeeded();
  await card().screenshot({ path: path.join(output, "mail-analysis-instructions-mobile.png") });
  await button("Cancel").click();
  await page.setViewportSize({ width: 1280, height: 900 });
  stored = null;
  await openSettings();
  await card().screenshot({ path: path.join(output, "mail-analysis-instructions-desktop.png") });

  // ── On the email: what the instructions did, and Undo ───────────────────
  steps = freshSteps();
  await openCard();
  const steps0 = ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
  for (const expected of [
    "Unsubscribed",
    "Sent to lists.shop.example. An unsubscribe can’t be undone.",
    "Starred",
    "It asks you to confirm Friday's delivery.",
    `Your instruction: “${STAR_LINE}”`,
    "Didn’t archive",
    "Your instructions changed before this ran.",
    "Couldn’t label “Finance”",
    "The mail server refused the label.",
  ]) {
    assert.ok(steps0.includes(expected), `the card shows: ${expected}`);
  }
  // Only the star can be taken back; an unsubscribe cannot.
  const undoButtons = page.getByRole("button", { name: /^Undo:/ });
  assert.equal(await undoButtons.count(), 1);
  assert.equal(await page.getByRole("button", { name: "Undo: Starred" }).count(), 1);

  // A failed Undo explains itself and leaves the step undoable.
  undoRefusal = "Gmail is unavailable right now.";
  await page.getByRole("button", { name: "Undo: Starred" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Gmail is unavailable right now.").waitFor();
  await dialog.getByText(/Couldn’t undo “Starred”/).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Undo: Starred" }).count(), 1);
  undoRefusal = null;

  const reloadsBefore = Number(await page.getByTestId("reloads").textContent());
  await page.getByRole("button", { name: "Undo: Starred" }).click();
  await page.locator('button[aria-busy="true"]').first().waitFor();
  await page.getByText("Starred — undone", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Undo:/ }).count(), 0);
  assert.deepEqual(undos, ["auto-1", "auto-1"]);
  await page.waitForFunction(
    (count) => Number(document.querySelector('[data-testid="reloads"]')?.textContent) > count,
    reloadsBefore,
  );

  // Phone width.
  steps = freshSteps();
  await page.setViewportSize({ width: 390, height: 844 });
  await openCard();
  assert.equal(await noHorizontalScroll(), true, "the steps wrap on a phone");
  await page.screenshot({
    path: path.join(output, "mail-analysis-automatic-steps-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCard();
  await page.screenshot({
    path: path.join(output, "mail-analysis-automatic-steps-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Mail analysis instructions browser checks passed: default text, unchanged Save disabled, edit and Cancel, save with loading and reload, inline refusal and retry, keyboard save, too many lines, emptied box, Restore default, analysis off/on, Read-access warning, phone and desktop layouts; on the email: every outcome, Undo only where possible, failed Undo dialog, Undo with loading, phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
