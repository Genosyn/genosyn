/** Real Chrome coverage for Resources → AI access; the APIs are deterministic fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

type Level = "read" | "write";
type Row = {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: null };
  accessLevel: Level;
  isDefault: boolean;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Port 0: an ephemeral port, so concurrent suites never collide.
const fixture = await startBrowserFixture("resourcesAiAccessHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);

function employee(id: string, name: string, role: string): Row["employee"] {
  return { id, name, slug: id.replace("emp-", ""), role, avatarKey: null };
}
const ADA = employee("emp-ada", "Ada Lovelace", "Research analyst");
const BOB = employee("emp-bob", "Bob Writer", "Content writer");
const CY = employee("emp-cy", "Cy Archivist", "Librarian");

function initialRows(): Row[] {
  return [
    { employee: ADA, accessLevel: "write", isDefault: true },
    { employee: BOB, accessLevel: "read", isDefault: false },
    { employee: CY, accessLevel: "read", isDefault: false },
  ];
}

let rows = initialRows();
let listFailure: string | null = null;
let putFailure: string | null = null;
let emptyRoster = false;
const puts: Array<{ employeeId: string; body: unknown }> = [];

const resource = {
  id: "res-handbook",
  companyId: "company",
  title: "Support handbook",
  slug: "handbook",
  sourceKind: "text",
  sourceUrl: null,
  sourceFilename: null,
  storageKey: null,
  summary: "How we answer customers.",
  bodyText: "# Support handbook\n\nAnswer within a day.",
  bodyLength: 40,
  tags: [],
  tagList: [],
  bytes: 40,
  status: "ready",
  errorMessage: "",
  createdById: "owner",
  createdByEmployeeId: null,
  createdBy: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const base = "/api/companies/company/resources";
  if (pathname === `${base}/ai-access` && request.method() === "GET") {
    if (listFailure) return route.fulfill({ status: 503, json: { error: listFailure } });
    return route.fulfill({ json: { rows: emptyRoster ? [] : rows } });
  }
  const put = /^\/api\/companies\/company\/resources\/ai-access\/([^/]+)$/.exec(pathname);
  if (put && request.method() === "PUT") {
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
  if (pathname === `${base}/handbook`) return route.fulfill({ json: resource });
  if (pathname === `${base}/handbook/grants`) {
    const grant = (who: Row["employee"], accessLevel: string) => ({
      id: `grant-${who.id}`,
      employeeId: who.id,
      resourceId: resource.id,
      accessLevel,
      createdAt: "2026-10-01T00:00:00.000Z",
      employee: who,
    });
    // Bob holds Can edit but is read only; Ada holds Can delete at read + write.
    return route.fulfill({ json: { direct: [grant(ADA, "delete"), grant(BOB, "edit")] } });
  }
  if (pathname === `${base}/handbook/grant-candidates`) {
    return route.fulfill({
      json: [
        { ...ADA, alreadyGranted: true },
        { ...BOB, alreadyGranted: true },
        { ...CY, alreadyGranted: false },
      ],
    });
  }
  if (pathname === "/api/companies/company/tags") return route.fulfill({ json: [] });
  return route.fulfill({
    status: 404,
    json: { error: `Unhandled ${request.method()} ${pathname}` },
  });
});

function radio(page: Page, employeeName: string, label: string) {
  return page
    .getByRole("radiogroup", { name: `Resources access for ${employeeName}`, exact: true })
    .getByRole("radio", { name: label, exact: true });
}

async function checked(employeeName: string): Promise<string> {
  for (const label of ["Read only", "Read + write"]) {
    if ((await radio(page, employeeName, label).getAttribute("aria-checked")) === "true") {
      return label;
    }
  }
  return "none";
}

async function location(): Promise<string> {
  return (await page.getByTestId("location").textContent()) ?? "";
}

async function noHorizontalScroll(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

try {
  // ── Owner: the roster, the defaults, and the section's sidebar entry ──────
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: "AI access", exact: true }).waitFor();
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("link", { name: "Library", exact: true }).waitFor();
  await sidebar.getByRole("link", { name: "AI access", exact: true }).waitFor();
  assert.equal(
    await checked("Ada Lovelace"),
    "Read + write",
    "untouched employees default to write",
  );
  assert.equal(await checked("Bob Writer"), "Read only");
  assert.equal(await checked("Cy Archivist"), "Read only");
  await page.getByText("2 of 3 read only", { exact: true }).waitFor();
  assert.equal(await page.getByText("Only owners and admins can change access.").count(), 0);

  // A click narrows Ada at once and tells the server exactly that.
  await radio(page, "Ada Lovelace", "Read only").click();
  await page.getByText("3 of 3 read only", { exact: true }).waitFor();
  assert.equal(await checked("Ada Lovelace"), "Read only");
  assert.deepEqual(puts.at(-1), { employeeId: "emp-ada", body: { accessLevel: "read" } });

  // Clicking the level an employee already holds sends nothing.
  const before = puts.length;
  await radio(page, "Ada Lovelace", "Read only").click();
  assert.equal(puts.length, before);

  // The radio group answers to the keyboard like any other.
  await radio(page, "Bob Writer", "Read only").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Resources access for Bob Writer"] [aria-checked="true"]')
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
  await radio(page, "Cy Archivist", "Read + write").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Couldn’t update Resources access", { exact: true }).waitFor();
  await dialog.getByText("admin company role required The change was undone.").waitFor();
  assert.equal(await checked("Cy Archivist"), "Read only", "the optimistic change rolled back");
  // The modal also has an icon-only close button labelled "Close"; take the text one.
  await dialog.locator("button", { hasText: /^Close$/ }).click();
  await dialog.waitFor({ state: "hidden" });
  putFailure = null;
  assert.equal(rows.find((row) => row.employee.id === "emp-cy")?.accessLevel, "read");

  // ── Sidebar navigation and the chat shortcut ──────────────────────────────
  await sidebar.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByText("Library index", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/resources");
  await sidebar.getByRole("link", { name: "AI access", exact: true }).click();
  await page.getByRole("heading", { name: "AI access", exact: true }).waitFor();
  await page.getByRole("link", { name: "Chat with Ada Lovelace", exact: true }).click();
  await page.getByText("Employee chat", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/employees/ada/chat");

  // ── Member: sees the roster, cannot change it ─────────────────────────────
  await page.goto(`${fixture.origin}/?role=member`, { waitUntil: "networkidle" });
  await page.getByText("Only owners and admins can change access.", { exact: true }).waitFor();
  for (const name of ["Ada Lovelace", "Bob Writer", "Cy Archivist"]) {
    for (const label of ["Read only", "Read + write"]) {
      assert.equal(await radio(page, name, label).isDisabled(), true, `${name} ${label}`);
    }
  }
  const memberPuts = puts.length;
  await radio(page, "Cy Archivist", "Read + write").click({ force: true });
  assert.equal(puts.length, memberPuts, "a disabled control sends nothing");

  // ── Load failure, then a successful retry ─────────────────────────────────
  listFailure = "Resources access is temporarily unavailable";
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByText("Resources access is temporarily unavailable", { exact: true }).waitFor();
  listFailure = null;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await radio(page, "Ada Lovelace", "Read only").waitFor();
  assert.equal(await page.getByText("Resources access is temporarily unavailable").count(), 0);

  // ── Empty roster ──────────────────────────────────────────────────────────
  emptyRoster = true;
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByText("No AI employees yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Hire an AI employee", exact: true }).waitFor();
  emptyRoster = false;

  // ── The Share modal shows the ceiling where per-Resource levels are set ───
  // Ada: Can delete at read + write. Bob: Can edit but read only. Cy: read
  // only and not yet shared this Resource.
  rows = initialRows();
  await page.goto(`${fixture.origin}/?path=/c/acme/resources/handbook`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const share = page.getByRole("dialog");
  await share.getByText("Share with AI employees", { exact: true }).waitFor();
  await share
    .locator("li", { hasText: "Bob Writer" })
    .getByText("Paused — Read only under AI access", { exact: true })
    .waitFor();
  assert.equal(
    await share
      .locator("li", { hasText: "Ada Lovelace" })
      .getByText(/Paused/)
      .count(),
    0,
    "Ada holds read + write, so her Can delete applies",
  );
  await share
    .locator("li", { hasText: "Cy Archivist" })
    .getByText("Read only under AI access", { exact: true })
    .waitFor();

  // Narrow Ada too: her Can delete is now held in abeyance as well.
  rows = rows.map((row) =>
    row.employee.id === "emp-ada" ? { ...row, accessLevel: "read", isDefault: false } : row,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await share
    .locator("li", { hasText: "Ada Lovelace" })
    .getByText("Paused — Read only under AI access", { exact: true })
    .waitFor();

  // The modal links to the page that owns the setting.
  await share.getByRole("link", { name: "AI access", exact: true }).click();
  await page.getByRole("heading", { name: "AI access", exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/resources/ai-access");

  // ── Phone width ───────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await radio(page, "Cy Archivist", "Read + write").scrollIntoViewIfNeeded();
  assert.equal(await noHorizontalScroll(), true, "no horizontal scroll at 390px");
  await radio(page, "Ada Lovelace", "Read + write").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Resources access for Ada Lovelace"] [aria-checked="true"]')
        ?.textContent?.includes("Read + write") ?? false,
  );
  const output = path.resolve(root, "../output/playwright");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "resources-ai-access-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: path.join(output, "resources-ai-access-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  console.log(
    "Resources AI access browser checks passed: default roster, optimistic narrow and restore, keyboard radio group, refused change rollback, sidebar and chat navigation, Member read-only view, load retry, empty roster, Share-modal pause hints, phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
