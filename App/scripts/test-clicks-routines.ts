/**
 * Real Chrome coverage for the shorter Routine flows, on the real App: pause
 * and resume from the routine's header in one click (snapping back with the
 * reason if refused; Members see the state only), the Settings checkbox
 * following it; Run now disabled with the reason while a Standdown covers
 * the routine; New routine from one employee's list keeps that employee and
 * lands on the Brief; ⌘S saves the brief; the list's last Run opens in one
 * click; an empty folder deletes without a confirm while a full one still
 * asks; and the same employee carry-over for New skill. Each flow counts its
 * clicks. Run with `npm run test:clicks-routines`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type {
  Employee,
  RoutineFolder,
  RoutineWithMeta,
  Run,
  SkillWithMeta,
} from "../client/lib/api";
import { API, hoursAgo, noSidewaysScroll, startApp, status, type ApiRoute } from "./appFixture";

const app = await startApp("Fewer clicks — Routines and Skills");

// ───────────────────────────── fixtures ─────────────────────────────

const employee = (id: string, name: string, role: string): Employee => ({
  id,
  companyId: "company",
  name,
  slug: id,
  role,
  avatarKey: null,
  model: { provider: "anthropic", model: "claude", status: "connected" },
  modelCount: 1,
});
const ALEX = employee("alex", "Alex Rivera", "Account manager");
const SAM = employee("sam", "Sam Okafor", "Engineer");
const summary = (e: Employee) => ({
  id: e.id,
  name: e.name,
  slug: e.slug,
  role: e.role,
  avatarKey: null,
});

function run(id: string, routineId: string, status: Run["status"], hours: number): Run {
  return {
    id,
    routineId,
    startedAt: hoursAgo(hours),
    finishedAt: hoursAgo(hours - 0.1),
    status,
    exitCode: status === "completed" ? 0 : 1,
    createdAt: hoursAgo(hours),
  } as Run;
}

function routine(
  id: string,
  name: string,
  owner: Employee,
  changes: Partial<RoutineWithMeta> = {},
): RoutineWithMeta {
  return {
    id,
    employeeId: owner.id,
    name,
    slug: id,
    cronExpr: "0 9 * * 1-5",
    enabled: true,
    folderId: null,
    goalId: null,
    lastRunAt: null,
    nextRunAt: hoursAgo(-20),
    timeoutSec: 600,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
    createdAt: hoursAgo(500),
    updatedAt: hoursAgo(5),
    employee: summary(owner),
    lastRun: null,
    standdown: null,
    tags: [],
    ...changes,
  } as RoutineWithMeta;
}

function folder(id: string, name: string, routineCount: number): RoutineFolder {
  return {
    id,
    companyId: "company",
    name,
    slug: id,
    parentId: null,
    sortOrder: 0,
    path: name,
    depth: 1,
    routineCount,
    totalRoutineCount: routineCount,
    createdAt: hoursAgo(300),
  } as RoutineFolder;
}

type Store = {
  routines: RoutineWithMeta[];
  folders: RoutineFolder[];
  briefs: Map<string, string>;
  refusePatch?: boolean;
};

function store(): Store {
  const failed = run("run-9", "daily-inbox", "failed", 3);
  return {
    routines: [
      routine("daily-inbox", "Daily inbox sweep", ALEX, {
        lastRun: failed,
        lastRunAt: failed.startedAt,
        folderId: "ops",
      }),
      routine("weekly-report", "Weekly report", SAM),
      routine("renewals", "Renewal reminders", ALEX, {
        standdown: {
          id: "sd-1",
          scope: "routine",
          scopeId: "renewals",
          reason: "Billing migration this week",
          source: "member",
          placedByUserId: "viewer",
          placedAt: hoursAgo(2),
          liftedAt: null,
          liftedByUserId: null,
          liftedReason: "",
          active: true,
          createdAt: hoursAgo(2),
        } as RoutineWithMeta["standdown"],
      }),
    ],
    folders: [folder("ops", "Operations", 1), folder("drafts", "Drafts", 0)],
    briefs: new Map([["daily-inbox", "Sweep the inbox every weekday morning."]]),
  };
}

function routes(s: Store): ApiRoute[] {
  const find = (id: string) => s.routines.find((r) => r.id === id)!;
  return [
    ["GET", `${API}/routines`, () => s.routines],
    ["GET", `${API}/employees`, () => [ALEX, SAM]],
    ["GET", `${API}/routine-folders`, () => ({ folders: s.folders, unfiledCount: 2, maxDepth: 5 })],
    ["GET", `${API}/routines/activity`, () => ({ running: [], today: [] })],
    ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
    ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
    ["GET", /\/tags$/, () => []],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/([^/]+)\/readme$/,
      ({ match }) => ({ content: s.briefs.get(match[1]) ?? "" }),
    ],
    [
      "PUT",
      /^\/api\/companies\/company\/routines\/([^/]+)\/readme$/,
      ({ match, body }) => {
        s.briefs.set(match[1], String(body.content));
        return { content: body.content };
      },
    ],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/([^/]+)\/runs$/,
      ({ match }) => (find(match[1]).lastRun ? [find(match[1]).lastRun] : []),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/runs\/([^/]+)\/log$/,
      () => ({ content: "The mailbox refused the connection.", truncated: false, live: false }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/runs\/([^/]+)\/checks$/,
      () => ({ results: [] }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/runs\/([^/]+)\/effects$/,
      () => ({ effects: [], total: 0 }),
    ],
    ["GET", /^\/api\/companies\/company\/run-lessons\/routine\/[^/]+$/, () => []],
    ["GET", `${API}/workstreams`, () => []],
    ["GET", /^\/api\/companies\/company\/employees\/[^/]+\/models$/, () => []],
    [
      "PATCH",
      /^\/api\/companies\/company\/routines\/([^/]+)$/,
      ({ match, body }) => {
        if (s.refusePatch)
          return status(403, { error: "Only owners and admins can change Routines." });
        Object.assign(find(match[1]), body);
        return find(match[1]);
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/employees\/([^/]+)\/routines$/,
      ({ match, body }) => {
        const owner = [ALEX, SAM].find((e) => e.id === match[1])!;
        const created = routine(
          String(body.name).toLowerCase().replace(/\s+/g, "-"),
          String(body.name),
          owner,
        );
        s.routines.push(created);
        return created;
      },
    ],
    [
      "DELETE",
      /^\/api\/companies\/company\/routine-folders\/([^/]+)$/,
      ({ match }) => {
        s.folders = s.folders.filter((f) => f.id !== match[1]);
        return { ok: true };
      },
    ],
  ];
}

const header = (page: Page) => page.locator("div.page-shell");
const toggle = (page: Page) => page.getByRole("switch", { name: /(Pause|Resume) this routine/ });

// ───────────────────────────── checks ─────────────────────────────

await app.check(
  "pause and resume from the routine's header in one click each — no Settings tab, no Save",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/alex/daily-inbox", routes: routes(s) });
    const { page } = view;
    await view.click(page.getByRole("switch", { name: "Pause this routine", exact: true }));
    await page.getByRole("switch", { name: "Resume this routine", exact: true }).waitFor();
    await header(page).getByText("paused", { exact: true }).waitFor();
    await page
      .locator("label", { has: toggle(page) })
      .getByText("Paused", { exact: true })
      .waitFor();
    assert.deepEqual(view.writes.at(-1)?.body, { enabled: false });
    // The Settings checkbox follows, so a later Save cannot quietly undo it.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.waitForFunction(() => {
      const box = [...document.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === "Enabled")
        ?.querySelector("input");
      return box !== undefined && box !== null && !box.checked;
    });
    await view.click(page.getByRole("switch", { name: "Resume this routine", exact: true }));
    await page.getByRole("switch", { name: "Pause this routine", exact: true }).waitFor();
    assert.deepEqual(view.writes.at(-1)?.body, { enabled: true });
    assert.equal(view.clicks(), 2, "one click to pause, one to resume");
    assert.equal(await page.getByRole("dialog").count(), 0, "reversible, so no confirmation");
    await page.close();
  },
);

await app.check("a refused pause snaps the switch back and says why", async () => {
  const s = store();
  s.refusePatch = true;
  const view = await app.open({ path: "/c/acme/routines/alex/daily-inbox", routes: routes(s) });
  const { page } = view;
  await view.click(page.getByRole("switch", { name: "Pause this routine", exact: true }));
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Couldn’t pause the routine").waitFor();
  await dialog
    .getByText(/Only owners and admins can change Routines\. The switch was put back\./)
    .waitFor();
  await page.getByRole("switch", { name: "Pause this routine", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("switch", { name: "Pause this routine" }).getAttribute("aria-checked"),
    "true",
  );
  await page.close();
});

await app.check("Members see whether a routine is paused, without the switch", async () => {
  const s = store();
  s.routines[0].enabled = false;
  const view = await app.open({
    path: "/c/acme/routines/alex/daily-inbox",
    routes: routes(s),
    role: "member",
  });
  await header(view.page).getByText("paused", { exact: true }).waitFor();
  assert.equal(await toggle(view.page).count(), 0);
  await view.page.close();
});

await app.check(
  "Run now is disabled, with the reason, while a Standdown covers the routine",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/alex/renewals", routes: routes(s) });
    const runNow = view.page.getByRole("button", { name: "Run now", exact: true });
    await runNow.waitFor();
    assert.equal(await runNow.isDisabled(), true);
    assert.equal(
      await runNow.getAttribute("title"),
      "Routine Standdown: Billing migration this week",
    );
    assert.deepEqual(view.writes, [], "no Run is attempted, so no error to close");
    await view.page.close();
  },
);

await app.check(
  "New routine from one employee's list keeps them as the owner and lands on the Brief",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines?employee=sam", routes: routes(s) });
    const { page } = view;
    await page.getByText("Weekly report").first().waitFor();
    // The page's own button (the sidebar's + is checked separately below).
    await view.click(page.getByRole("button", { name: "New routine", exact: true }).last());
    await view.landedOn("/c/acme/routines/new?employee=sam");
    const name = page.getByLabel("Name", { exact: true });
    await name.fill("Release notes");
    await name.press("Enter");
    await view.landedOn("/c/acme/routines/sam/release-notes?tab=brief");
    assert.equal(
      view.writes
        .filter((w) => w.method === "POST")
        .map((w) => w.path)
        .join(),
      `${API}/employees/sam/routines`,
      "created for Sam, the employee whose list it came from",
    );
    await page.getByRole("button", { name: "Save brief", exact: true }).waitFor();
    assert.equal(view.clicks(), 1, "no re-picking the owner, no Brief tab click");
    await page.close();
  },
);

await app.check("the sidebar's + carries the employee too", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines?employee=alex", routes: routes(s) });
  await view.page.getByText("Daily inbox sweep").first().waitFor();
  await view.click(view.page.locator('button[title="New routine"]'));
  await view.landedOn("/c/acme/routines/new?employee=alex");
  await view.page.close();
});

await app.check("⌘S saves the brief, and only when there is something to save", async () => {
  const s = store();
  const view = await app.open({
    path: "/c/acme/routines/alex/daily-inbox?tab=brief",
    routes: routes(s),
  });
  const { page } = view;
  const editor = page.locator("textarea").first();
  await page.getByText("⌘S to save").waitFor();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(250);
  assert.equal(view.writes.length, 0, "nothing changed, nothing saved");
  await page.keyboard.press("End");
  await page.keyboard.type(" Flag anything urgent.");
  await page.getByText("Unsaved changes").waitFor();
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("Unsaved changes").waitFor({ state: "detached" });
  assert.equal(
    view.writes.at(-1)?.body.content,
    "Sweep the inbox every weekday morning. Flag anything urgent.",
  );
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check("the list's last Run opens that Run in one click", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines", routes: routes(s) });
  const { page } = view;
  await view.click(page.getByRole("link", { name: /Open the last Run of Daily inbox sweep/ }));
  await view.landedOn("/c/acme/routines/alex/daily-inbox?run=run-9");
  await page.getByText("The mailbox refused the connection.").waitFor();
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check("an empty folder deletes without a confirm; a full one still asks", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines", routes: routes(s) });
  const { page } = view;
  await page.getByText("Daily inbox sweep").first().waitFor();
  await view.click(page.getByRole("button", { name: "Actions for Drafts", exact: true }));
  await view.click(page.getByRole("menuitem", { name: "Delete folder" }));
  await page.getByRole("button", { name: "Actions for Drafts" }).waitFor({ state: "detached" });
  assert.equal(await page.getByRole("dialog").count(), 0, "nothing to lose, nothing to ask");
  assert.equal(view.clicks(), 2);
  await page.getByRole("button", { name: "Actions for Operations", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete folder" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByText(/1 routine will move to/).waitFor();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(
    view.writes.map((w) => `${w.method} ${w.path}`),
    [`DELETE ${API}/routine-folders/drafts`],
  );
  await page.close();
});

await app.check("phone width: the header with its switch fits", async () => {
  const s = store();
  const view = await app.open({
    path: "/c/acme/routines/alex/daily-inbox",
    routes: routes(s),
    touch: true,
  });
  await toggle(view.page).waitFor();
  await noSidewaysScroll(view.page, "a routine on a phone");
  await view.page.close();
});

// ───────────────────────────── Skills ─────────────────────────────

await app.check("New skill from one employee's skills keeps them as the owner", async () => {
  const skill: SkillWithMeta = {
    id: "skill-1",
    employeeId: "alex",
    name: "Qualify a lead",
    slug: "qualify-a-lead",
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(10),
    employee: summary(ALEX),
    tags: [],
  } as unknown as SkillWithMeta;
  const view = await app.open({
    path: "/c/acme/skills?employee=alex",
    routes: [
      ["GET", `${API}/skills`, () => [skill]],
      ["GET", `${API}/employees`, () => [SAM, ALEX]],
      ["GET", /\/tags$/, () => []],
    ],
  });
  const { page } = view;
  await page.getByText("Qualify a lead").first().waitFor();
  await view.click(page.getByRole("button", { name: "New skill", exact: true }).first());
  await view.landedOn("/c/acme/skills/new?employee=alex");
  // The roster lists Sam first; the form still starts on Alex.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("select")].some((select) => select.value === "alex"),
  );
  await page.close();
});

await app.finish();
