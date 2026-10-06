/**
 * Real Chrome coverage for Routines → AI access, inside the real Routines
 * layout. The APIs and the company socket are deterministic fixtures; the
 * suite runs on an ephemeral port so it never collides with another.
 * Run with `npm run test:routines-ai-access`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type WebSocketRoute } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

type Level = "run" | "write";
type Row = {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: null };
  accessLevel: Level;
  isDefault: boolean;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await startBrowserFixture("routinesAiAccessHarness.tsx", 0);
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

function employee(id: string, name: string, role: string): Row["employee"] {
  return { id, name, slug: id.replace("emp-", ""), role, avatarKey: null };
}
const ADA = employee("emp-ada", "Ada Lovelace", "Operations lead");
const BOB = employee("emp-bob", "Bob Ledger", "Bookkeeper");
const CY = employee("emp-cy", "Cy Scheduler", "Support");

function initialRows(): Row[] {
  return [
    { employee: ADA, accessLevel: "write", isDefault: true },
    { employee: BOB, accessLevel: "run", isDefault: false },
    { employee: CY, accessLevel: "run", isDefault: false },
  ];
}

function routine(id: string, name: string, owner: Row["employee"]) {
  return {
    id,
    employeeId: owner.id,
    name,
    slug: id,
    cronExpr: "0 9 * * 1",
    enabled: true,
    folderId: null,
    goalId: null,
    lastRunAt: null,
    nextRunAt: "2026-10-12T09:00:00.000Z",
    timeoutSec: 600,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    employee: owner,
    lastRun: null,
    standdown: null,
    tags: [],
  };
}

let rows = initialRows();
let listReads = 0;
let listFailure: string | null = null;
let putFailure: string | null = null;
let emptyRoster = false;
const puts: Array<{ employeeId: string; body: unknown }> = [];
const sockets = new Set<WebSocketRoute>();

await page.routeWebSocket("**/api/ws?*", (socket) => {
  sockets.add(socket);
  socket.onClose(() => sockets.delete(socket));
});

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const base = "/api/companies/company";
  if (method === "POST" && pathname === `${base}/workspace/ws-token`) {
    return route.fulfill({ json: { token: "fixture" } });
  }
  if (method === "GET" && pathname === `${base}/routines`) {
    return route.fulfill({
      json: [
        routine("weekly-report", "Weekly report", ADA),
        routine("close", "Month-end close", BOB),
      ],
    });
  }
  if (method === "GET" && pathname === `${base}/employees`) {
    return route.fulfill({
      json: [ADA, BOB, CY].map((e) => ({ ...e, companyId: "company" })),
    });
  }
  if (method === "GET" && pathname === `${base}/routine-folders`) {
    return route.fulfill({ json: { folders: [], unfiledCount: 2, maxDepth: 5 } });
  }
  if (method === "GET" && pathname === `${base}/routines/ai-access`) {
    listReads += 1;
    if (listFailure) return route.fulfill({ status: 503, json: { error: listFailure } });
    return route.fulfill({ json: { rows: emptyRoster ? [] : rows } });
  }
  const put = /^\/api\/companies\/company\/routines\/ai-access\/([^/]+)$/.exec(pathname);
  if (put && method === "PUT") {
    const body = request.postDataJSON() as { accessLevel: Level };
    puts.push({ employeeId: put[1], body });
    if (putFailure) return route.fulfill({ status: 403, json: { error: putFailure } });
    rows = rows.map((row) =>
      row.employee.id === put[1]
        ? { ...row, accessLevel: body.accessLevel, isDefault: false }
        : row,
    );
    return route.fulfill({ json: { row: rows.find((row) => row.employee.id === put[1]) ?? null } });
  }
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

function radio(employeeName: string, label: string) {
  return page
    .getByRole("radiogroup", { name: `Routines access for ${employeeName}`, exact: true })
    .getByRole("radio", { name: label, exact: true });
}

async function checked(employeeName: string): Promise<string> {
  for (const label of ["Read + run", "Read + write"]) {
    if ((await radio(employeeName, label).getAttribute("aria-checked")) === "true") return label;
  }
  return "none";
}

async function location(): Promise<string> {
  return (await page.getByTestId("location").textContent()) ?? "";
}

async function noHorizontalScroll(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function broadcast(kind: string) {
  for (const socket of sockets) {
    socket.send(JSON.stringify({ type: "resource.changed", kind, scopeIds: [] }));
  }
}

try {
  // ── Owner: the roster, the defaults, and the Routines rail ────────────────
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: "AI access", exact: true }).waitFor();
  const sidebar = page.locator("aside").first();
  const settingsNav = sidebar.getByRole("navigation", { name: "Routines settings" });
  await settingsNav.getByRole("link", { name: "AI access", exact: true }).waitFor();
  await sidebar.getByRole("link", { name: /All routines/ }).waitFor();
  await sidebar.getByText("Ada Lovelace", { exact: true }).waitFor();
  assert.equal(
    await checked("Ada Lovelace"),
    "Read + write",
    "untouched employees default to write",
  );
  assert.equal(await checked("Bob Ledger"), "Read + run");
  assert.equal(await checked("Cy Scheduler"), "Read + run");
  await page.getByText("2 of 3 read + run", { exact: true }).waitFor();
  assert.equal(await page.getByText("Only owners and admins can change access.").count(), 0);
  // Both levels are explained, and the default is marked.
  await page.getByText("Run Routines as written", { exact: true }).waitFor();
  await page.getByText("Run and maintain Routines", { exact: true }).waitFor();
  await page.getByText("Includes Read + run", { exact: true }).waitFor();
  await page.getByText(/never stops a Run/).waitFor();

  // A click narrows Ada at once and tells the server exactly that.
  await radio("Ada Lovelace", "Read + run").click();
  await page.getByText("3 of 3 read + run", { exact: true }).waitFor();
  assert.equal(await checked("Ada Lovelace"), "Read + run");
  assert.deepEqual(puts.at(-1), { employeeId: "emp-ada", body: { accessLevel: "run" } });

  // Clicking the level an employee already holds sends nothing.
  const before = puts.length;
  await radio("Ada Lovelace", "Read + run").click();
  assert.equal(puts.length, before);

  // The radio group answers to the keyboard like any other.
  await radio("Bob Ledger", "Read + run").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Routines access for Bob Ledger"] [aria-checked="true"]')
        ?.textContent?.includes("Read + write") ?? false,
  );
  assert.deepEqual(puts.at(-1), { employeeId: "emp-bob", body: { accessLevel: "write" } });
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    "Read + write",
    "focus follows the selection",
  );

  // A refused change snaps back and explains itself in the error modal.
  putFailure = "admin company role required";
  await radio("Cy Scheduler", "Read + write").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Couldn’t update Routines access", { exact: true }).waitFor();
  await dialog.getByText("admin company role required The change was undone.").waitFor();
  assert.equal(await checked("Cy Scheduler"), "Read + run", "the optimistic change rolled back");
  await dialog.locator("button", { hasText: /^Close$/ }).click();
  await dialog.waitFor({ state: "hidden" });
  putFailure = null;
  assert.equal(rows.find((row) => row.employee.id === "emp-cy")?.accessLevel, "run");

  // ── Live: a level changed elsewhere arrives without a reload ──────────────
  for (let attempt = 0; attempt < 100 && sockets.size === 0; attempt += 1) {
    await page.waitForTimeout(50);
  }
  assert.ok(sockets.size > 0, "the company socket connected");
  const readsBefore = listReads;
  rows = rows.map((row) =>
    row.employee.id === "emp-cy" ? { ...row, accessLevel: "write", isDefault: false } : row,
  );
  await broadcast("grant");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Routines access for Cy Scheduler"] [aria-checked="true"]')
        ?.textContent?.includes("Read + write") ?? false,
  );
  assert.ok(listReads > readsBefore, "a grant event refetched the roster");

  // ── Rail navigation, the per-employee Routines filter, and chat ───────────
  await sidebar.getByRole("link", { name: /All routines/ }).click();
  await page.getByText("Routines index", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/routines");
  await settingsNav.getByRole("link", { name: "AI access", exact: true }).click();
  await page.getByRole("heading", { name: "AI access", exact: true }).waitFor();
  await page.getByRole("link", { name: "Ada Lovelace's Routines", exact: true }).click();
  await page.getByText("Routines index", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/routines?employee=ada");
  await settingsNav.getByRole("link", { name: "AI access", exact: true }).click();
  await page.getByRole("link", { name: "Chat with Ada Lovelace", exact: true }).click();
  await page.getByText("Employee chat", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/employees/ada/chat");

  // ── Member: sees the roster, cannot change it ─────────────────────────────
  rows = initialRows();
  await page.goto(`${fixture.origin}/?role=member`, { waitUntil: "networkidle" });
  await page.getByText("Only owners and admins can change access.", { exact: true }).waitFor();
  for (const name of ["Ada Lovelace", "Bob Ledger", "Cy Scheduler"]) {
    for (const label of ["Read + run", "Read + write"]) {
      assert.equal(await radio(name, label).isDisabled(), true, `${name} ${label}`);
    }
  }
  const memberPuts = puts.length;
  await radio("Cy Scheduler", "Read + write").click({ force: true });
  await radio("Ada Lovelace", "Read + run").focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(puts.length, memberPuts, "a disabled control sends nothing");

  // ── Load failure, then a successful retry ─────────────────────────────────
  listFailure = "Routines access is temporarily unavailable";
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByText("Routines access is temporarily unavailable", { exact: true }).waitFor();
  listFailure = null;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await radio("Ada Lovelace", "Read + run").waitFor();
  assert.equal(await page.getByText("Routines access is temporarily unavailable").count(), 0);

  // ── Empty roster, for an owner and for a Member ───────────────────────────
  emptyRoster = true;
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByText("No AI employees yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Hire an AI employee", exact: true }).waitFor();
  await page.goto(`${fixture.origin}/?role=member`, { waitUntil: "networkidle" });
  await page.getByText("No AI employees yet", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Hire an AI employee" }).count(), 0);
  emptyRoster = false;

  // ── Phone width ───────────────────────────────────────────────────────────
  const output = path.resolve(root, "../output/playwright");
  await fs.mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await radio("Cy Scheduler", "Read + write").scrollIntoViewIfNeeded();
  assert.equal(await noHorizontalScroll(), true, "no horizontal scroll at 390px");
  await radio("Ada Lovelace", "Read + run").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Routines access for Ada Lovelace"] [aria-checked="true"]')
        ?.textContent?.includes("Read + run") ?? false,
  );
  await page.screenshot({
    path: path.join(output, "routines-ai-access-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: path.join(output, "routines-ai-access-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Routines AI access browser checks passed: default roster, level cards, optimistic narrow and restore, keyboard radio group, refused change rollback, live grant refetch, rail and chat navigation, Member read-only view, load retry, empty roster, phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
