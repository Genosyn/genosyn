/**
 * Real Chrome coverage for the ⌘K palette's page search. Run with
 * `npm run test:command-palette`; local Chrome or GENOSYN_TEST_BROWSER.
 *
 * The real palette runs in a router with deterministic `/search` fixtures, so
 * these checks see what a person sees: which groups appear and in what order,
 * where ↵ and a click go, what each role is offered, and that the dialog fits
 * a phone. Every unexpected request fails the suite.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import type { CompanySearchResult } from "../client/lib/api";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("commandPaletteHarness.tsx", 18497);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(20_000);
const errors: string[] = [];
const unexpected: string[] = [];
const searches: string[] = [];

/** One company record that answers to "recurring", so entity results show up too. */
const NOTE: CompanySearchResult = {
  kind: "note",
  id: "note-1",
  label: "Recurring revenue plan",
  sublabel: "Strategy",
  path: "/notes/strategy/recurring-revenue-plan",
};

await context.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/companies/company/search" && route.request().method() === "GET") {
    const q = url.searchParams.get("q") ?? "";
    searches.push(q);
    const results = q.toLowerCase().includes("recurring") ? [NOTE] : [];
    return route.fulfill({ json: { results } });
  }
  unexpected.push(`${route.request().method()} ${url.pathname}`);
  return route.fulfill({ status: 404, json: { error: "Unexpected request" } });
});

type Row = { id: string; label: string; context: string; selected: boolean; current: boolean };

/** The listbox as rendered: group headers and option rows, top to bottom. */
async function snapshot(page: Page): Promise<{ groups: string[]; rows: Row[] }> {
  return page.evaluate(() => {
    const list = document.getElementById("command-palette-list");
    if (!list) return { groups: [], rows: [] };
    const groups = [...list.querySelectorAll(":scope > div > div.uppercase")].map(
      (el) => el.textContent?.trim() ?? "",
    );
    const rows = [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => {
      const spans = el.querySelectorAll(":scope > span.min-w-0 > span");
      return {
        id: el.id,
        label: spans[0]?.textContent?.trim() ?? "",
        context: (spans[1]?.textContent ?? "").replace(/^in\s+/, "").trim(),
        selected: el.getAttribute("aria-selected") === "true",
        current: el.textContent?.includes("Current") ?? false,
      };
    });
    return { groups, rows };
  });
}

async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Search" }).waitFor();
}

async function search(page: Page, query: string) {
  const q = query.trim();
  // The palette keeps the previous query's records on screen until the next
  // answer lands, so "settled" means this query's own response has rendered.
  const answered =
    q.length >= 2
      ? page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname.endsWith("/search") && url.searchParams.get("q") === q;
        })
      : null;
  await page.getByRole("combobox").fill(query);
  if (answered) {
    await answered;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.waitForFunction(
      () => !document.getElementById("command-palette-list")?.textContent?.includes("Searching"),
    );
  }
}

/** Press a key and wait for the highlighted row to become `label`. */
async function pressTo(page: Page, key: string, label: string) {
  await page.keyboard.press(key);
  try {
    await page.waitForFunction(
      (want) =>
        document.querySelector('[role="option"][aria-selected="true"] span span')?.textContent ===
        want,
      label,
      { timeout: 5_000 },
    );
  } catch {
    const selected = (await snapshot(page)).rows.find((r) => r.selected)?.label;
    assert.fail(`${key} should highlight "${label}", but "${selected}" is highlighted`);
  }
}

/**
 * Wait for the router to land on `expected`. The palette closes in the same
 * keystroke that navigates, but the router may commit a moment later.
 */
async function expectLocation(page: Page, expected: string) {
  const readout = page.getByTestId("location");
  try {
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid="location"]')?.textContent === want,
      expected,
      { timeout: 5_000 },
    );
  } catch {
    assert.equal(await readout.textContent(), expected);
  }
}

async function newPage(query = ""): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${fixture.origin}/${query}`, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("button", { name: "Open palette" }).waitFor();
  return page;
}

try {
  await fs.mkdir(output, { recursive: true });

  // ── "recurring": the requested page, beside Routines and the company's records ──
  const owner = await newPage();
  await openPalette(owner);
  await search(owner, "recurring");
  await owner.getByText(NOTE.label, { exact: true }).waitFor();
  let view = await snapshot(owner);
  assert.deepEqual(view.groups, ["Pages", "Sections", "Notes"], "the named page leads");
  assert.deepEqual(
    view.rows.map((r) => [r.label, r.context]),
    [
      ["Recurring invoices", "Finance"],
      ["New recurring invoice", "Finance"],
      ["Routines", "Scheduled work, and how every run went."],
      [NOTE.label, "Strategy"],
    ],
  );
  assert.equal(view.rows[0].id, "command-palette-opt-page-finance-recurring-invoices");
  assert.equal(view.rows[0].selected, true, "the best match is ready for ↵");
  assert.equal(
    await owner.getByRole("combobox").getAttribute("aria-activedescendant"),
    view.rows[0].id,
  );
  assert.equal(
    await owner.locator(`#${view.rows[0].id} mark`).textContent(),
    "Recurring",
    "the matched words are highlighted",
  );
  await owner.screenshot({ path: path.join(output, "command-palette-recurring.png") });

  await owner.keyboard.press("Enter");
  await owner.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
  await expectLocation(owner, "/c/acme/finance/recurring-invoices");

  // ── ↓ and ↑ walk pages, sections, and records as one list ──
  await openPalette(owner);
  await search(owner, "recurring");
  await owner.getByText(NOTE.label, { exact: true }).waitFor();
  view = await snapshot(owner);
  assert.equal(view.rows[0].current, true, "the open page says so");
  assert.equal(view.rows.find((r) => r.selected)?.label, "Recurring invoices");
  await pressTo(owner, "ArrowDown", "New recurring invoice");
  await pressTo(owner, "ArrowDown", "Routines");
  await pressTo(owner, "ArrowDown", NOTE.label);
  await pressTo(owner, "ArrowDown", "Recurring invoices"); // ↓ wraps to the top
  await pressTo(owner, "ArrowUp", NOTE.label); // ↑ wraps to the bottom
  await pressTo(owner, "ArrowUp", "Routines");
  await owner.keyboard.press("Enter");
  await owner.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
  await expectLocation(owner, "/c/acme/routines");

  // ── a click opens a page too; a page named for the query leads its section ──
  await openPalette(owner);
  await search(owner, "members");
  view = await snapshot(owner);
  assert.deepEqual(view.groups, ["Pages", "Sections"]);
  assert.deepEqual(view.rows[0], {
    id: "command-palette-opt-page-settings-members",
    label: "Members",
    context: "Settings",
    selected: true,
    current: false,
  });
  await owner.locator(`#${view.rows[0].id}`).click();
  await owner.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
  await expectLocation(owner, "/c/acme/settings/members");

  // ── the section leads when it is the better match ──
  await openPalette(owner);
  await search(owner, "settings");
  view = await snapshot(owner);
  assert.deepEqual(view.groups, ["Sections", "Pages"]);
  assert.equal(view.rows[0].label, "Settings");
  assert.equal(view.rows[0].current, true, "Settings is the current section");
  assert.deepEqual(
    view.rows.slice(1, 4).map((r) => `${r.label} · ${r.context}`),
    ["TLDR settings · TLDRs", "Email settings · Email", "Finance settings · Finance"],
  );

  // ── one destination, one row: Revenue's landing page isn't offered twice ──
  await search(owner, "revenue");
  view = await snapshot(owner);
  assert.equal(view.rows[0].label, "Revenue");
  assert.equal(view.rows.some((r) => r.label === "Insights"), false);
  assert.equal(new Set(view.rows.map((r) => r.id)).size, view.rows.length);
  await search(owner, "insights");
  assert.deepEqual(
    (await snapshot(owner)).rows.map((r) => `${r.label} · ${r.context}`),
    ["Insights · Revenue"],
  );

  // ── case, spacing, and accents don't matter ──
  await search(owner, "  RÉCURRING   Invoices ");
  assert.equal((await snapshot(owner)).rows[0]?.label, "Recurring invoices");

  // ── an empty query browses sections only ──
  await search(owner, "");
  view = await snapshot(owner);
  assert.deepEqual(view.groups, ["Essentials", "AI", "Knowledge", "Engineering", "Money", "System", "You"]);
  assert.equal(view.rows.some((r) => r.id.startsWith("command-palette-opt-page-")), false);

  // ── admin-only pages are offered to owners… ──
  await search(owner, "usage");
  assert.equal((await snapshot(owner)).rows[0]?.label, "Usage");
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog", { name: "Search" }).waitFor({ state: "detached" });
  await owner.close();

  // ── …and never to a Member, who also sees no Finance pages without access ──
  const member = await newPage("?role=member&finance=none");
  await openPalette(member);
  await search(member, "recurring");
  await member.getByText(NOTE.label, { exact: true }).waitFor();
  view = await snapshot(member);
  assert.deepEqual(view.groups, ["Sections", "Notes"]);
  assert.deepEqual(view.rows.map((r) => r.label), ["Routines", NOTE.label]);
  await search(member, "usage");
  assert.deepEqual(
    (await snapshot(member)).rows.map((r) => `${r.label} · ${r.context}`),
    ["Signals · Revenue"],
    "Usage is admin-only; Signals still answers to its synonym",
  );
  await search(member, "zzzz");
  await member.getByText("No matches for “zzzz”").waitFor();
  await search(member, "members");
  assert.equal((await snapshot(member)).rows[0]?.label, "Members", "a Member's own pages remain");
  await member.close();

  const reader = await newPage("?role=member&finance=read");
  await openPalette(reader);
  await search(reader, "recurring");
  await reader.getByText(NOTE.label, { exact: true }).waitFor();
  assert.deepEqual(
    (await snapshot(reader)).rows.map((r) => r.label),
    ["Recurring invoices", "Routines", NOTE.label],
    "read-only finance access opens the list, not the create form",
  );
  await reader.close();

  // ── a phone gets the same rows without sideways scrolling ──
  const phone = await newPage("?at=/c/acme/finance");
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.getByRole("button", { name: "Open palette" }).click();
  await phone.getByRole("dialog", { name: "Search" }).waitFor();
  await search(phone, "recurring");
  await phone.getByText(NOTE.label, { exact: true }).waitFor();
  const fits = await phone.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[role="option"]')].map((row) =>
      row.getBoundingClientRect(),
    );
    return {
      noPageScroll: document.documentElement.scrollWidth <= window.innerWidth,
      dialogInside: dialog.left >= 0 && dialog.right <= window.innerWidth,
      rowsInside: rows.every((r) => r.left >= dialog.left && r.right <= dialog.right),
    };
  });
  assert.deepEqual(fits, { noPageScroll: true, dialogInside: true, rowsInside: true });
  await phone.screenshot({ path: path.join(output, "command-palette-recurring-mobile.png") });
  await phone.keyboard.press("Enter");
  await expectLocation(phone, "/c/acme/finance/recurring-invoices");
  await phone.close();

  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(unexpected, [], "no unexpected requests");
  // Record search still runs beside page search, from two characters up.
  assert.ok(searches.includes("recurring") && searches.includes("members"));
  assert.equal(searches.some((q) => q.trim().length < 2), false);
  console.log(
    "Command palette browser checks passed: recurring → Recurring invoices beside Routines and records; " +
      "↵, arrows with wrap, and click navigation; group order by best match; no duplicate destinations; " +
      "folding of case, spaces, and accents; browse mode unchanged; owner / Member / finance-access " +
      "visibility; current-page marker; phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
