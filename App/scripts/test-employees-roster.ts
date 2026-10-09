/**
 * Real Chrome coverage for the Employees page after reporting lines were
 * removed: the roster (no org chart), the employee's Team card (no Reports
 * to), and Decision routing (no "their manager"). The APIs are deterministic
 * fixtures.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

type Fixture = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: null;
  teamId: string | null;
};
type Rule = {
  id: string;
  askingEmployeeId: string | null;
  deciderKind: "employee" | "manager";
  deciderEmployeeId: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Port 0: an ephemeral port, so concurrent suites never collide.
const fixture = await startBrowserFixture("employeesRosterHarness.tsx", 0);
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

function person(id: string, name: string, role: string, teamId: string | null): Fixture {
  return {
    id,
    companyId: "company",
    name,
    slug: id.replace("emp-", ""),
    role,
    avatarKey: null,
    teamId,
  };
}

// Out of name order on purpose: the page sorts. Cy's team is archived, so the
// live team list never mentions it and the card shows no badge.
function initialEmployees(): Fixture[] {
  return [
    person("emp-cy", "Cy Archivist", "Librarian", "team-legacy"),
    person("emp-bob", "Bob Writer", "Content writer", null),
    person("emp-ada", "Ada Lovelace", "Research analyst", "team-ops"),
  ];
}
const TEAMS = [
  {
    id: "team-ops",
    name: "Operations",
    slug: "operations",
    description: "",
    archivedAt: null,
    memberCount: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];
function initialRules(): Rule[] {
  return [
    {
      id: "rule-legacy",
      askingEmployeeId: null,
      deciderKind: "manager",
      deciderEmployeeId: null,
      sortOrder: 0,
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "rule-named",
      askingEmployeeId: "emp-bob",
      deciderKind: "employee",
      deciderEmployeeId: "emp-ada",
      sortOrder: 0,
      enabled: true,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ];
}

let employees = initialEmployees();
let rules = initialRules();
let teamsFailure = false;
let patchFailure: string | null = null;
const requested: string[] = [];
const patches: Array<{ employeeId: string; body: Record<string, unknown> }> = [];
const posts: unknown[] = [];
const deletes: string[] = [];

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const method = request.method();
  const pathname = new URL(request.url()).pathname;
  requested.push(`${method} ${pathname}`);
  const base = "/api/companies/company";
  if (pathname === `${base}/employees` && method === "GET") {
    return route.fulfill({ json: employees });
  }
  const employeePatch = /^\/api\/companies\/company\/employees\/([^/]+)$/.exec(pathname);
  if (employeePatch && method === "PATCH") {
    const body = request.postDataJSON() as Record<string, unknown>;
    patches.push({ employeeId: employeePatch[1], body });
    if (patchFailure) return route.fulfill({ status: 400, json: { error: patchFailure } });
    // The real route is strict: a key it does not handle is a 400.
    const unknown = Object.keys(body).filter((key) => key !== "teamId");
    if (unknown.length > 0) {
      return route.fulfill({ status: 400, json: { error: `Unrecognized keys: ${unknown}` } });
    }
    employees = employees.map((entry) =>
      entry.id === employeePatch[1] ? { ...entry, teamId: body.teamId as string | null } : entry,
    );
    return route.fulfill({ json: employees.find((entry) => entry.id === employeePatch[1]) });
  }
  if (pathname === `${base}/teams` && method === "GET") {
    if (teamsFailure)
      return route.fulfill({ status: 503, json: { error: "Teams are unavailable" } });
    return route.fulfill({ json: TEAMS });
  }
  if (pathname === `${base}/decision-policies` && method === "GET") {
    return route.fulfill({ json: rules });
  }
  if (pathname === `${base}/decision-policies` && method === "POST") {
    const body = request.postDataJSON() as Partial<Rule>;
    posts.push(body);
    const created: Rule = {
      id: `rule-${posts.length}`,
      askingEmployeeId: body.askingEmployeeId ?? null,
      deciderKind: "employee",
      deciderEmployeeId: body.deciderEmployeeId ?? null,
      sortOrder: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    rules = [...rules, created];
    return route.fulfill({ json: created });
  }
  const ruleItem = /^\/api\/companies\/company\/decision-policies\/([^/]+)$/.exec(pathname);
  if (ruleItem && method === "DELETE") {
    deletes.push(ruleItem[1]);
    rules = rules.filter((rule) => rule.id !== ruleItem[1]);
    return route.fulfill({ json: { ok: true } });
  }
  if (pathname === `${base}/decisions` || pathname === `${base}/approvals`) {
    return route.fulfill({ json: [] });
  }
  return route.fulfill({
    status: 404,
    json: { error: `Unhandled ${method} ${pathname}` },
  });
});

async function location(): Promise<string> {
  return (await page.getByTestId("location").textContent()) ?? "";
}

async function noHorizontalScroll(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

function roster(target: Page = page) {
  return target.getByRole("list", { name: "AI Employees", exact: true });
}

/** Each card's text — name, then role, then any team badge. */
async function rosterCards(): Promise<string[]> {
  return (await roster().getByRole("listitem").allTextContents()).map((text) => text.trim());
}

/** Text the org chart drew, none of which may come back. */
const ORG_CHART_COPY = [
  /Reporting structure/i,
  /reporting lines? yet/i,
  /\breports? to\b/i,
  /Edit org/i,
  /No manager/i,
  /org chart/i,
];

async function assertNoOrgChart(): Promise<void> {
  for (const pattern of ORG_CHART_COPY) {
    assert.equal(await page.getByText(pattern).count(), 0, `${pattern} is gone`);
  }
  assert.equal(await page.getByText("Human", { exact: true }).count(), 0, "no Member nodes");
  assert.equal(await page.getByTitle("Edit team & manager").count(), 0, "no pencil editor");
}

async function choose(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Poll a condition the page settles into, without a fixed sleep. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  // ── The roster ────────────────────────────────────────────────────────────
  await page.goto(fixture.origin, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: "Employees", exact: true }).waitFor();
  await page
    .getByText("Open an AI Employee to chat with them or change their settings.", { exact: true })
    .waitFor();
  await roster()
    .getByRole("link", { name: /Ada Lovelace/ })
    .waitFor();
  // Alphabetical whatever the API order; Ada wears her team, Bob has none, and
  // Cy's archived team leaves no badge at all.
  await eventually(
    async () => (await rosterCards()).join("|").includes("Operations"),
    "team badges load",
  );
  // Each card reads: avatar initials, name, role, then any team badge.
  assert.deepEqual(await rosterCards(), [
    "ALAda LovelaceResearch analystOperations",
    "BWBob WriterContent writer",
    "CACy ArchivistLibrarian",
  ]);
  await assertNoOrgChart();
  // Human Members were org-chart nodes only; the roster no longer asks for them.
  assert.equal(
    requested.some((entry) => entry.endsWith("/members")),
    false,
    "the roster does not fetch Members",
  );

  // A card opens that employee's Chat.
  await roster()
    .getByRole("link", { name: /Bob Writer/ })
    .click();
  await page.getByText("Employee chat", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/employees/bob/chat");

  // Hiring is where it was (the sidebar's icon button shares the name).
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: "New employee" }).click();
  await page.getByText("Hire form", { exact: true }).waitFor();
  assert.equal(await location(), "/c/acme/employees/new");

  // A failed team list costs only the badges, never the roster or a modal.
  teamsFailure = true;
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await roster()
    .getByRole("link", { name: /Ada Lovelace/ })
    .waitFor();
  assert.equal(await roster().getByText("Operations").count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  teamsFailure = false;

  // An empty company is invited to hire.
  employees = [];
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await page.getByText("Hire your first AI employee", { exact: true }).waitFor();
  assert.equal(await roster().count(), 0);
  employees = initialEmployees();

  // ── The employee's Team card ──────────────────────────────────────────────
  await page.goto(`${fixture.origin}/?path=/c/acme/employees/ada/settings/general`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  await page.getByText("The team this employee belongs to", { exact: false }).waitFor();
  assert.equal(await page.getByText("Org chart", { exact: true }).count(), 0);
  assert.equal(await page.getByText("toManager").count(), 0);
  await assertNoOrgChart();
  const teamPicker = page.getByRole("combobox", { name: "Team", exact: true });
  await eventually(
    async () => (await teamPicker.inputValue()) === "Operations",
    "Ada's team shows",
  );
  // Picking a team is the edit: it saves as it is picked, with no Save button
  // in its card (the name card above keeps its own).
  const teamCard = teamPicker.locator(
    'xpath=ancestor::*[.//*[contains(text(), "The team this employee belongs to")]][1]',
  );
  assert.equal(await teamCard.getByRole("button", { name: "Save changes", exact: true }).count(), 0);
  assert.equal(patches.length, 0, "looking saves nothing");

  await choose(page, "Team", "— No team —");
  await eventually(async () => patches.length === 1, "the clear is sent on pick");
  assert.deepEqual(patches.at(-1), { employeeId: "emp-ada", body: { teamId: null } });
  // The page reloads the employee and the card settles on what was saved.
  await eventually(
    async () => (await teamPicker.inputValue()) === "— No team —" && !(await teamPicker.isDisabled()),
    "the cleared team is saved",
  );

  await choose(page, "Team", "Operations");
  await eventually(async () => patches.length === 2, "the team is sent on pick");
  assert.deepEqual(patches.at(-1), { employeeId: "emp-ada", body: { teamId: "team-ops" } });
  await eventually(async () => !(await teamPicker.isDisabled()), "the team is saved");
  assert.ok(
    patches.every(({ body }) => Object.keys(body).every((key) => key === "teamId")),
    "the Team card sends teamId and nothing else",
  );

  // A refused save puts the old team back and says why inside the card — not
  // in a toast or a modal.
  patchFailure = "Team not found in this company";
  await choose(page, "Team", "— No team —");
  await page.getByText("Team not found in this company", { exact: true }).waitFor();
  await eventually(
    async () => (await teamPicker.inputValue()) === "Operations",
    "the refused change is put back",
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  patchFailure = null;

  // ── Decision routing ──────────────────────────────────────────────────────
  await page.goto(`${fixture.origin}/?path=/c/acme/decisions`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByText("Add a rule", { exact: true }).waitFor();
  const legacy = modal.getByRole("listitem").filter({ hasText: "was their manager" });
  await legacy.getByText("Any employee", { exact: true }).waitFor();
  await legacy.getByText("people", { exact: true }).waitFor();
  await modal
    .getByText("stopped routing when reporting lines were removed", { exact: false })
    .waitFor();
  const named = modal.getByRole("listitem").filter({ hasText: "Bob Writer" });
  await named.getByText("Ada Lovelace", { exact: true }).waitFor();
  assert.equal(await named.getByText("was their manager").count(), 0);

  // The form names the decider; "Their manager" is no longer a choice.
  assert.equal(await modal.getByText("Their manager", { exact: true }).count(), 0);
  assert.equal(await modal.getByText("A named employee", { exact: true }).count(), 0);
  await modal.getByRole("combobox", { name: "Are answered by", exact: true }).click();
  const offered = await page.getByRole("option").allTextContents();
  assert.deepEqual(
    offered.map((label) => label.trim()),
    ["Choose an employee…", "Cy Archivist", "Bob Writer", "Ada Lovelace"],
  );
  // Close the list by clicking away: Escape would close the whole modal.
  await modal.getByText("Add a rule", { exact: true }).click();

  // Saving without a decider is caught in the form, and sends nothing.
  await modal.getByRole("button", { name: "Add rule", exact: true }).click();
  await modal.getByText("Pick the employee who answers.", { exact: true }).waitFor();
  assert.equal(posts.length, 0);

  // An asker cannot answer itself: picking it clears that decider.
  await choose(page, "Are answered by", "Cy Archivist");
  await choose(page, "Questions from", "Cy Archivist");
  assert.equal(
    await modal.getByRole("combobox", { name: "Are answered by", exact: true }).inputValue(),
    "Choose an employee…",
  );
  await modal.getByRole("combobox", { name: "Are answered by", exact: true }).click();
  assert.equal(await page.getByRole("option", { name: "Cy Archivist", exact: true }).count(), 0);
  // Close the list by clicking away: Escape would close the whole modal.
  await modal.getByText("Add a rule", { exact: true }).click();

  await choose(page, "Are answered by", "Ada Lovelace");
  await modal.getByRole("button", { name: "Add rule", exact: true }).click();
  await modal
    .getByRole("listitem")
    .filter({ hasText: "Cy Archivist" })
    .getByText("Ada Lovelace", { exact: true })
    .waitFor();
  assert.deepEqual(posts, [
    { askingEmployeeId: "emp-cy", deciderKind: "employee", deciderEmployeeId: "emp-ada" },
  ]);

  // Deleting the retired rule removes it, and its explanation with it.
  await modal
    .getByRole("button", { name: "Delete routing Any employee → people", exact: true })
    .click();
  await modal.getByText("was their manager").waitFor({ state: "detached" });
  assert.deepEqual(deletes, ["rule-legacy"]);
  assert.equal(
    await modal
      .getByText("stopped routing when reporting lines were removed", { exact: false })
      .count(),
    0,
  );

  // A Member reads the same rules, retired label included, with no controls.
  rules = initialRules();
  await page.goto(`${fixture.origin}/?path=/c/acme/decisions&role=member`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await modal.getByText("was their manager", { exact: true }).waitFor();
  assert.equal(await modal.getByText("Add a rule").count(), 0);
  assert.equal(await modal.getByRole("button", { name: /^Delete routing/ }).count(), 0);

  // ── Phone width ───────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await roster()
    .getByRole("link", { name: /Cy Archivist/ })
    .scrollIntoViewIfNeeded();
  assert.equal(await noHorizontalScroll(), true, "no horizontal scroll at 390px");
  const output = path.resolve(root, "../output/playwright");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "employees-roster-mobile.png"), fullPage: true });
  await page.goto(`${fixture.origin}/?path=/c/acme/employees/ada/settings/general`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("combobox", { name: "Team", exact: true }).waitFor();
  assert.equal(await noHorizontalScroll(), true, "the Team card fits at 390px");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixture.origin, { waitUntil: "networkidle" });
  await roster()
    .getByRole("link", { name: /Ada Lovelace/ })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "employees-roster-desktop.png"),
    fullPage: true,
  });

  assert.deepEqual(errors, []);
  console.log(
    "Employees roster browser checks passed: sorted roster with no org chart, team badges, card and hire navigation, team-list failure, empty state, Team-only General card with inline error, Decision routing without a manager option, retired-rule label and note, decider/asker guard, Member read-only view, phone layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
