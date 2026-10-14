/**
 * Real Chrome coverage for the Advanced disclosures, on the real App: a
 * routine's Settings tab shows the basics and tucks everything else under one
 * Advanced disclosure that says what is set inside; its Overview keeps the
 * useful rows and puts the rest under More details; an AI Employee's Settings
 * rail keeps the everyday panes and opens its Advanced group on a deep link;
 * and each Admin → Runtime section is a single summary line until it is opened.
 * Screenshots land in output/playwright. Run with `npm run test:advanced-disclosures`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type {
  Employee,
  HostedSignInReport,
  RoutineCheck,
  RoutineFolder,
  RoutineTrigger,
  RoutineWithMeta,
  RuntimeSettingsGroup,
  RuntimeSettingsSnapshot,
} from "../client/lib/api";
import { RUNTIME_DEFAULTS } from "../client/lib/runtimeSettingsSummary";
import { API, hoursAgo, noSidewaysScroll, startApp, type ApiRoute } from "./appFixture";

const app = await startApp("Advanced disclosures");

/**
 * These pages scroll inside their own pane, which a document screenshot does not
 * follow. Stretch the window to the pane's content first, so the picture shows
 * all of it: the closed disclosure and what sits below it.
 */
async function shotWhole(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 1280;
  const height = await page.evaluate(() => {
    const panes = [
      document.documentElement,
      ...document.querySelectorAll<HTMLElement>("main, .page-shell, .overflow-y-auto"),
    ];
    return Math.max(...panes.map((pane) => pane.scrollHeight)) + 120;
  });
  await page.setViewportSize({ width, height: Math.min(height, 6000) });
  await app.shot(page, name);
}

// ───────────────────────────── fixtures ─────────────────────────────

const ALEX: Employee = {
  id: "alex",
  companyId: "company",
  name: "Alex Rivera",
  slug: "alex",
  role: "Account manager",
  avatarKey: null,
  model: null,
  modelCount: 0,
};

const OPERATIONS: RoutineFolder = {
  id: "ops",
  companyId: "company",
  name: "Operations",
  slug: "ops",
  parentId: null,
  sortOrder: 0,
  path: "Operations",
  depth: 1,
  routineCount: 1,
  totalRoutineCount: 1,
  createdAt: hoursAgo(300),
};

/** A routine with a handful of things changed from the defaults. */
function routine(): RoutineWithMeta {
  return {
    id: "daily-inbox",
    employeeId: "alex",
    name: "Daily inbox sweep",
    slug: "daily-inbox",
    cronExpr: "0 9 * * 1-5",
    enabled: true,
    folderId: "ops",
    goalId: null,
    lastRunAt: null,
    nextRunAt: hoursAgo(-20),
    timeoutSec: 7200,
    requiresApproval: true,
    webhookEnabled: true,
    webhookToken: "fixture-webhook-token",
    acceptanceCriteria: "",
    createdAt: hoursAgo(500),
    employee: {
      id: "alex",
      name: "Alex Rivera",
      slug: "alex",
      role: "Account manager",
      avatarKey: null,
    },
    lastRun: null,
    standdown: null,
    tags: [],
  } as RoutineWithMeta;
}

const check = (id: string, name: string, position: number): RoutineCheck => ({
  id,
  routineId: "daily-inbox",
  name,
  kind: "effect",
  spec: JSON.stringify({ action: "mail.send", min: 0, max: 0 }),
  required: true,
  enabled: true,
  timeoutSec: 120,
  position,
  createdById: null,
  createdAt: null,
  updatedAt: null,
});

const trigger: RoutineTrigger = {
  id: "trigger-1",
  routineId: "daily-inbox",
  kind: "deals",
  scopeId: null,
  minIntervalSec: 900,
  enabled: true,
  lastFiredAt: null,
  createdAt: hoursAgo(10),
};

function routineRoutes(
  current: RoutineWithMeta,
  rows: { checks: RoutineCheck[]; triggers: RoutineTrigger[] } = {
    checks: [check("check-1", "No email was sent", 0), check("check-2", "No file was deleted", 1)],
    triggers: [trigger],
  },
): ApiRoute[] {
  return [
    ["GET", `${API}/routines`, () => [current]],
    ["GET", `${API}/employees`, () => [ALEX]],
    [
      "GET",
      `${API}/routine-folders`,
      () => ({ folders: [OPERATIONS], unfiledCount: 0, maxDepth: 5 }),
    ],
    ["GET", `${API}/routines/activity`, () => ({ running: [], today: [] })],
    ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
    ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
    ["GET", /\/tags$/, () => []],
    ["GET", /^\/api\/companies\/company\/routines\/[^/]+\/runs$/, () => []],
    ["GET", /^\/api\/companies\/company\/run-lessons\/routine\/[^/]+$/, () => []],
    ["GET", `${API}/workstreams`, () => []],
    ["GET", /^\/api\/companies\/company\/employees\/[^/]+\/models$/, () => []],
    ["GET", `${API}/goals`, () => []],
    ["GET", /^\/api\/companies\/company\/member-browsers\/for-employee\/[^/]+$/, () => []],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/[^/]+\/checks$/,
      () => ({
        checks: rows.checks,
        commandChecks: { available: false, reason: "Command execution is off." },
      }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/routine-triggers\/routine\/[^/]+$/,
      () => ({ kinds: ["deals", "mail"], triggers: rows.triggers }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/history\/routine\/[^/]+$/,
      () => ({ items: [], nextCursor: null }),
    ],
    [
      "PATCH",
      /^\/api\/companies\/company\/routines\/[^/]+$/,
      ({ body }) => Object.assign(current, body),
    ],
  ];
}

const SETTINGS_PATH = "/c/acme/routines/alex/daily-inbox?tab=settings";
const SUMMARY =
  "Filed in Operations · Timeout 2h · Approval required · 2 Checks · 1 Trigger · Webhook on";

// ───────────────────────── routine Settings ─────────────────────────

await app.check(
  "routine Settings: the basics up front, everything else under one closed Advanced disclosure",
  async () => {
    const current = routine();
    const view = await app.open({ path: SETTINGS_PATH, routes: routineRoutes(current) });
    const { page } = view;

    // The basics, each with its label.
    await page.getByLabel("Name", { exact: true }).waitFor();
    await page.getByText("Schedule", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Goal", exact: true }).waitFor();
    const criteria = page.getByLabel("What counts as done", { exact: true });
    await criteria.waitFor();
    // (React's generated ids contain colons, so match the id as an attribute.)
    const hint = page.locator(`[id="${await criteria.getAttribute("id")}-hint"]`);
    assert.match(
      (await hint.textContent()) ?? "",
      /acceptance criteria/,
      "the helper text keeps the words acceptance criteria",
    );
    assert.equal(
      await page.getByRole("button", { name: "Save changes", exact: true }).count(),
      1,
      "one Save",
    );
    assert.equal(
      await page
        .locator("label")
        .filter({ hasText: /^Enabled$/ })
        .count(),
      0,
      "the header switch is the only enable control",
    );

    // Advanced starts closed, and its summary names what is set inside once
    // the Checks and Triggers have said how many there are.
    const advanced = page.getByRole("button", { name: /^Advanced/ });
    assert.equal(await advanced.getAttribute("aria-expanded"), "false");
    await advanced.getByText(SUMMARY, { exact: true }).waitFor();
    for (const label of [
      "Timeout (seconds)",
      "Require approval before each scheduled run",
      "Attempts",
      "Trigger via incoming webhook",
    ]) {
      assert.equal(
        await page.getByLabel(label, { exact: true }).isVisible(),
        false,
        `${label} is tucked away`,
      );
    }
    for (const name of ["Add a check", "Add trigger", "Regenerate token"]) {
      assert.equal(
        await page.getByRole("button", { name, exact: true }).isVisible(),
        false,
        `${name} is tucked away`,
      );
    }

    // The danger zone is not tucked away.
    await page.getByText("Stand this routine down", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Delete", exact: true }).waitFor();
    await shotWhole(page, "advanced-routine-settings-closed");

    // Opening it shows all of it, with the stored values.
    await advanced.click();
    assert.equal(await advanced.getAttribute("aria-expanded"), "true");
    const timeout = page.getByLabel("Timeout (seconds)", { exact: true });
    await timeout.waitFor();
    assert.equal(await timeout.inputValue(), "7200");
    assert.equal(
      await page
        .getByLabel("Require approval before each scheduled run", { exact: true })
        .isChecked(),
      true,
    );
    await page.getByRole("button", { name: "Add a check", exact: true }).waitFor();
    await page.getByText("No email was sent", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add trigger", exact: true }).waitFor();
    await page.getByText("Reliability", { exact: true }).waitFor();
    await page.getByText("Execution", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Regenerate token", exact: true }).waitFor();
    await shotWhole(page, "advanced-routine-settings-open");

    // One Save covers a basic and an Advanced setting — and never `enabled`.
    await timeout.fill("900");
    await criteria.fill("The inbox is at zero.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const saved = await view.waitForWrite(
      (w) => w.method === "PATCH" && "timeoutSec" in w.body,
      "Save sent the settings",
    );
    assert.equal(saved.body.timeoutSec, 900);
    assert.equal(saved.body.acceptanceCriteria, "The inbox is at zero.");
    assert.equal(saved.body.requiresApproval, true);
    assert.equal("enabled" in saved.body, false, "a Save never sends enabled");
    await advanced.getByText(/Timeout 15m/).waitFor();

    // Closing it again keeps what was typed.
    await advanced.click();
    assert.equal(await advanced.getAttribute("aria-expanded"), "false");
    assert.equal(await timeout.isVisible(), false);
    await advanced.click();
    assert.equal(await timeout.inputValue(), "900");
    await page.close();
  },
);

await app.check(
  "routine Settings: a phone gets the same layout without scrolling sideways",
  async () => {
    const view = await app.open({
      path: SETTINGS_PATH,
      routes: routineRoutes(routine()),
      touch: true,
    });
    const { page } = view;
    const advanced = page.getByRole("button", { name: /^Advanced/ });
    await advanced.getByText(SUMMARY, { exact: true }).waitFor();
    await noSidewaysScroll(page, "routine Settings, closed");
    await shotWhole(page, "advanced-routine-settings-phone");
    await advanced.click();
    await page.getByLabel("Timeout (seconds)", { exact: true }).waitFor();
    await noSidewaysScroll(page, "routine Settings, open");
    await page.close();
  },
);

await app.check("routine Settings: nothing set says so, in a few words", async () => {
  const current = {
    ...routine(),
    folderId: null,
    timeoutSec: 3600,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
  } as RoutineWithMeta;
  const view = await app.open({
    path: SETTINGS_PATH,
    routes: routineRoutes(current, { checks: [], triggers: [] }),
  });
  const advanced = view.page.getByRole("button", { name: /^Advanced/ });
  await advanced.getByText("All defaults", { exact: true }).waitFor();
  await view.page.close();
});

// ───────────────────────── routine Overview ─────────────────────────

await app.check(
  "routine Overview: the useful rows up front, the rest under More details",
  async () => {
    const view = await app.open({
      path: "/c/acme/routines/alex/daily-inbox",
      routes: routineRoutes(routine()),
    });
    const { page } = view;
    for (const label of ["Runs on", "Fires", "Next run", "Last run"]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
    const more = page.getByRole("button", { name: /^More details/ });
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    await more
      .getByText("Filed in Operations · Timeout 2h · Approval required · Webhook on", {
        exact: true,
      })
      .waitFor();
    for (const label of [
      "Filed in",
      "Timeout",
      "Approval",
      "Outcome check",
      "Browser",
      "Catch-up",
      "Retries",
      "Webhook",
    ]) {
      assert.equal(
        await page.getByText(label, { exact: true }).isVisible(),
        false,
        `${label} is tucked away`,
      );
    }
    await shotWhole(page, "advanced-routine-overview-closed");
    await more.click();
    assert.equal(await more.getAttribute("aria-expanded"), "true");
    for (const label of [
      "Filed in",
      "Timeout",
      "Approval",
      "Outcome check",
      "Browser",
      "Catch-up",
      "Retries",
      "Webhook",
    ]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
    await page.getByText("Each scheduled run waits for a human", { exact: true }).waitFor();
    await shotWhole(page, "advanced-routine-overview-open");
    await page.close();
  },
);

// ─────────────────────── employee Settings rail ───────────────────────

const ADA: Employee = { ...ALEX, id: "ada", name: "Ada Lovelace", slug: "ada", role: "Analyst" };
const employeeRoutes: ApiRoute[] = [
  ["GET", `${API}/employees`, () => [ADA]],
  ["GET", `${API}/employees/ada`, () => ADA],
  ["GET", /^\/api\/companies\/company\/employees\/ada\/models$/, () => []],
  ["GET", /\/teams$/, () => []],
  ["GET", /\/tags$/, () => []],
  ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
  ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
  ["GET", /\/employees\/ada\/journal.*/, () => []],
  ["GET", /\/employees\/ada\/memory.*/, () => []],
  [
    "GET",
    /^\/api\/companies\/company\/history\/employee\/[^/]+$/,
    () => ({ items: [], nextCursor: null }),
  ],
];

const EVERYDAY = ["General", "Soul", "Model", "Skills", "Routines", "Connections", "Autonomy"];
const ADVANCED = ["Memory", "Journal", "Handoffs", "Phone", "MCP", "Browser", "Integrations"];

await app.check(
  "employee Settings: the everyday panes up front, the rest in a collapsed Advanced group",
  async () => {
    const view = await app.open({
      path: "/c/acme/employees/ada/settings/general",
      routes: employeeRoutes,
    });
    const { page } = view;
    const rail = page.getByRole("navigation", { name: "Employee settings" });
    for (const name of EVERYDAY) {
      await rail.getByRole("link", { name, exact: true }).waitFor();
    }
    for (const name of ADVANCED) {
      assert.equal(
        await rail.getByRole("link", { name, exact: true }).count(),
        0,
        `${name} is tucked away`,
      );
    }
    // Autonomy holds the Standdown, so it stays one click away.
    assert.match(
      (await rail.getByRole("link", { name: "Autonomy", exact: true }).getAttribute("href")) ?? "",
      /\/employees\/ada\/settings\/autonomy$/,
    );
    const advanced = rail.getByRole("button", { name: /^Advanced/ });
    assert.equal(await advanced.getAttribute("aria-expanded"), "false");
    await shotWhole(page, "advanced-employee-rail-closed");

    await advanced.click();
    assert.equal(await advanced.getAttribute("aria-expanded"), "true");
    for (const name of ADVANCED) {
      await rail.getByRole("link", { name, exact: true }).waitFor();
    }
    await shotWhole(page, "advanced-employee-rail-open");
    await advanced.click();
    assert.equal(await rail.getByRole("link", { name: "Journal", exact: true }).count(), 0);
    await page.close();
  },
);

await app.check("employee Settings: landing on an Advanced pane opens its group", async () => {
  const view = await app.open({
    path: "/c/acme/employees/ada/settings/journal",
    routes: employeeRoutes,
  });
  const { page } = view;
  const rail = page.getByRole("navigation", { name: "Employee settings" });
  const journal = rail.getByRole("link", { name: "Journal", exact: true });
  await journal.waitFor();
  assert.equal(await journal.getAttribute("aria-current"), "page");
  assert.equal(
    await rail.getByRole("button", { name: /^Advanced/ }).getAttribute("aria-expanded"),
    "true",
  );
  // Following a link from the open group to a default pane leaves it open.
  await rail.getByRole("link", { name: "General", exact: true }).click();
  await view.landedOn("/c/acme/employees/ada/settings/general");
  await rail.getByRole("link", { name: "Journal", exact: true }).waitFor();
  await page.close();
});

await app.check("employee Settings: a phone gets the same groups as pills", async () => {
  const view = await app.open({
    path: "/c/acme/employees/ada/settings/general",
    routes: employeeRoutes,
    touch: true,
  });
  const { page } = view;
  const rail = page.getByRole("navigation", { name: "Employee settings" });
  await rail.getByRole("link", { name: "Autonomy", exact: true }).waitFor();
  assert.equal(await rail.getByRole("link", { name: "Journal", exact: true }).count(), 0);
  const advanced = rail.getByRole("button", { name: /^Advanced/ });
  await advanced.click();
  await rail.getByRole("link", { name: "Journal", exact: true }).waitFor();
  await noSidewaysScroll(page, "employee Settings rail on a phone");
  await shotWhole(page, "advanced-employee-rail-phone");
  await page.close();
});

// ───────────────────────────── Admin → Runtime ─────────────────────────────

function runtimeSnapshot(): RuntimeSettingsSnapshot {
  const snapshot = structuredClone(RUNTIME_DEFAULTS) as RuntimeSettingsSnapshot;
  snapshot.web.maxSearchResults = 20;
  snapshot.agent.taintPolicy = "off";
  snapshot.agent.toolDiscovery.minCatalogueSize = 10;
  snapshot.overridden = {
    web: true,
    mail: false,
    oauth: false,
    meetings: false,
    browser: false,
    agent: true,
    containment: false,
    network: false,
  };
  return snapshot;
}

const HOSTED: HostedSignInReport = {
  enabled: true,
  url: "https://connect.genosyn.com",
  apps: [
    {
      app: "google",
      name: "Google",
      status: "available",
      integrations: [{ provider: "gmail", name: "Gmail", groups: ["mail"] }],
    },
  ],
};

function runtimeRoutes(snapshot: RuntimeSettingsSnapshot): ApiRoute[] {
  return [
    ["GET", "/api/admin/runtime-settings", () => snapshot],
    ["GET", "/api/admin/hosted-sign-in", () => HOSTED],
    [
      "PUT",
      /^\/api\/admin\/runtime-settings\/([a-z]+)$/,
      ({ match, body }) => {
        const group = match[1] as RuntimeSettingsGroup;
        (snapshot as Record<string, unknown>)[group] = body;
        snapshot.overridden[group] = true;
        return snapshot;
      },
    ],
  ];
}

const SECTIONS: Array<[title: string, summary: string]> = [
  ["Web tools", "1 customized"],
  ["Hosted sign-in", "Defaults"],
  ["Mail sync", "Defaults"],
  ["Meetings", "Defaults"],
  ["Browser", "Defaults"],
  ["Agent", "2 customized"],
  ["Containment", "Defaults"],
  ["Outbound network", "Defaults"],
];

await app.check(
  "Admin → Runtime: every section is one summary line until it is opened",
  async () => {
    const snapshot = runtimeSnapshot();
    const view = await app.open({
      path: "/c/acme/admin/runtime",
      routes: runtimeRoutes(snapshot),
      me: { isMasterAdmin: true },
    });
    const { page } = view;
    for (const [title, summary] of SECTIONS) {
      const header = page.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) });
      await header.waitFor();
      const toggle = header.getByRole("button");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${title} starts closed`);
      await toggle.getByText(summary, { exact: true }).waitFor();
    }
    // Closed, no form: no Save, no Reset, no field.
    assert.equal(await page.getByRole("button", { name: /Save changes/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Reset to defaults/ }).count(), 0);
    assert.equal(await page.getByLabel("Max search results", { exact: true }).count(), 0);
    await shotWhole(page, "advanced-admin-runtime-closed");
    await page.close();
  },
);

await app.check(
  "Admin → Runtime: a section opens to its form, keeps a draft, and saves on its own",
  async () => {
    const snapshot = runtimeSnapshot();
    const view = await app.open({
      path: "/c/acme/admin/runtime",
      routes: runtimeRoutes(snapshot),
      me: { isMasterAdmin: true },
    });
    const { page } = view;
    const web = page.getByRole("heading", { level: 2, name: /^Web tools/ }).getByRole("button");
    await web.click();
    assert.equal(await web.getAttribute("aria-expanded"), "true");
    const results = page.getByLabel("Max search results", { exact: true });
    assert.equal(await results.inputValue(), "20");
    const save = page.getByRole("button", { name: /Save changes/ });
    assert.equal(await save.isDisabled(), true, "nothing to save yet");
    await page.getByRole("button", { name: /Reset to defaults/ }).waitFor();
    await shotWhole(page, "advanced-admin-runtime-open");

    // A draft survives closing the section, and the closed line says it is unsaved.
    await results.fill("25");
    await web.getByText("Unsaved", { exact: true }).waitFor();
    await web.click();
    assert.equal(await page.getByLabel("Max search results", { exact: true }).count(), 0);
    await web.getByText("Unsaved", { exact: true }).waitFor();
    await web.click();
    assert.equal(await results.inputValue(), "25");

    await save.click();
    const put = await view.waitForWrite((w) => w.method === "PUT", "the section was saved");
    assert.equal(put.path, "/api/admin/runtime-settings/web");
    assert.equal(put.body.maxSearchResults, 25);
    assert.equal(put.body.searchProvider, "duckduckgo");
    await web.getByText("1 customized", { exact: true }).waitFor();
    assert.equal(await web.getByText("Unsaved", { exact: true }).count(), 0);
    // Only that section was written.
    assert.deepEqual(
      view.writes.map((w) => w.path),
      ["/api/admin/runtime-settings/web"],
    );
    await page.close();
  },
);

await app.check(
  "Admin → Runtime: the (advanced) Connect URL sits behind its own Advanced disclosure",
  async () => {
    const snapshot = runtimeSnapshot();
    const view = await app.open({
      path: "/c/acme/admin/runtime",
      routes: runtimeRoutes(snapshot),
      me: { isMasterAdmin: true },
    });
    const { page } = view;
    await page
      .getByRole("heading", { level: 2, name: /^Hosted sign-in/ })
      .getByRole("button")
      .click();
    await page.getByLabel("Use Genosyn Connect", { exact: true }).waitFor();
    const advanced = page.getByRole("button", { name: /^Advanced/ });
    assert.equal(await advanced.getAttribute("aria-expanded"), "false");
    await advanced.getByText("Defaults", { exact: true }).waitFor();
    const url = page.getByLabel("Sign-in service URL", { exact: true });
    assert.equal(await url.isVisible(), false, "the URL is tucked away");
    assert.equal(await page.getByText("(advanced)").count(), 0);
    await advanced.click();
    await url.waitFor();
    await shotWhole(page, "advanced-admin-runtime-hosted-open");
    await url.fill("https://connect.example.com");
    await page.getByRole("button", { name: /Save changes/ }).click();
    const put = await view.waitForWrite((w) => w.method === "PUT", "the section was saved");
    assert.equal(put.path, "/api/admin/runtime-settings/oauth");
    assert.equal(put.body.hostedSignInUrl, "https://connect.example.com");
    assert.equal(put.body.hostedSignInEnabled, true);
    await advanced.getByText("1 customized", { exact: true }).waitFor();
    await page.close();
  },
);

await app.check("Admin → Runtime: a phone gets the same single lines", async () => {
  const view = await app.open({
    path: "/c/acme/admin/runtime",
    routes: runtimeRoutes(runtimeSnapshot()),
    me: { isMasterAdmin: true },
    touch: true,
  });
  const { page } = view;
  await page.getByRole("heading", { level: 2, name: /^Web tools/ }).waitFor();
  await noSidewaysScroll(page, "Admin → Runtime on a phone, closed");
  await page
    .getByRole("heading", { level: 2, name: /^Web tools/ })
    .getByRole("button")
    .click();
  await page.getByLabel("Max search results", { exact: true }).waitFor();
  await noSidewaysScroll(page, "Admin → Runtime on a phone, open");
  await shotWhole(page, "advanced-admin-runtime-phone");
  await page.close();
});

await app.finish();
