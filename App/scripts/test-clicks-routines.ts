/**
 * Real Chrome coverage for the shorter Routine flows, on the real App: pause
 * and resume from the routine's header in one click (snapping back with the
 * reason if refused; Members see the state only), with a Save on the Settings
 * tab never sending `enabled` back; Run now disabled with the reason while a
 * Standdown covers the routine; New routine opens on the form, which creates
 * the routine with its brief written, so it starts on, while Describe it
 * instead opens the box (an example fills it, only employees whose Chat is
 * ready are offered, and Continue to Chat stages the request as an unsent
 * draft); a routine made through the API without a brief waits paused until
 * one save writes it and switches it on; ⌘S saves the brief; the list's last
 * Run opens in one click; an empty folder deletes without a confirm while a
 * full one still asks; and the same employee carry-over for New skill. Each
 * flow counts its clicks. Every way to New routine, and switching between the
 * form and the box, are covered by `scripts/test-new-routine.ts`. Run with
 * `npm run test:clicks-routines`.
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
import { buildInitiativeRequestPrompt } from "../client/lib/initiativePrompt";
import { ROUTINE_EXAMPLES } from "../client/lib/routineExamples";
import { API, hoursAgo, noSidewaysScroll, startApp, status, type ApiRoute } from "./appFixture";

const app = await startApp("Fewer clicks — Routines and Skills");

// ───────────────────────────── fixtures ─────────────────────────────

const employee = (id: string, name: string, role: string, chatReady = true): Employee => ({
  id,
  companyId: "company",
  name,
  slug: id,
  role,
  avatarKey: null,
  model: chatReady ? { provider: "anthropic", model: "claude", status: "connected" } : null,
  modelCount: chatReady ? 1 : 0,
  chatReady,
});
const ALEX = employee("alex", "Alex Rivera", "Account manager");
const SAM = employee("sam", "Sam Okafor", "Engineer");
/** Hired, but no AI Model connected: cannot answer a Chat. */
const NOVA = employee("nova", "Nova Chen", "Designer", false);
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
  /** Routines created without a brief, paused until their first brief is saved. */
  awaitingBrief: Set<string>;
  /** The company's AI Employees, as the roster answers. */
  roster: Employee[];
  refusePatch?: boolean;
  /** Refuse a create with this message, as a duplicate name is. */
  refuseCreate?: string;
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
    awaitingBrief: new Set(),
    roster: [ALEX, SAM],
  };
}

/** What the server writes for a routine made without a brief. */
const starterOutline = (name: string) =>
  `# ${name}\n\n## Goal\nWhat this routine is meant to achieve.\n`;

function routes(s: Store): ApiRoute[] {
  const find = (id: string) => s.routines.find((r) => r.id === id)!;
  return [
    ["GET", `${API}/routines`, () => s.routines],
    ["GET", `${API}/employees`, () => s.roster],
    ["GET", `${API}/routine-folders`, () => ({ folders: s.folders, unfiledCount: 2, maxDepth: 5 })],
    ["GET", `${API}/routines/activity`, () => ({ running: [], queued: [], queuedCount: 0, today: [] })],
    ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
    ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
    ["GET", /\/tags$/, () => []],
    [
      "GET",
      /^\/api\/companies\/company\/routines\/([^/]+)\/readme$/,
      ({ match }) => ({
        content: s.briefs.get(match[1]) ?? "",
        awaitingBrief: s.awaitingBrief.has(match[1]) && !find(match[1]).enabled,
      }),
    ],
    [
      "PUT",
      /^\/api\/companies\/company\/routines\/([^/]+)\/readme$/,
      ({ match, body }) => {
        const content = String(body.content);
        s.briefs.set(match[1], content);
        // As on the server: the first brief written into a routine waiting
        // for one switches it on.
        if (s.awaitingBrief.has(match[1]) && content.trim()) {
          s.awaitingBrief.delete(match[1]);
          Object.assign(find(match[1]), { enabled: true, nextRunAt: hoursAgo(-20) });
        }
        return { ok: true, enabled: find(match[1]).enabled };
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
        if (s.refuseCreate) return status(409, { error: s.refuseCreate });
        const owner = s.roster.find((e) => e.id === match[1])!;
        // As on the server: a brief that says something starts the routine on,
        // and without one it waits paused with the starter outline.
        const brief = typeof body.brief === "string" ? body.brief.trim() : "";
        const created = routine(
          String(body.name).toLowerCase().replace(/\s+/g, "-"),
          String(body.name),
          owner,
          {
            folderId: (body.folderId as string | null | undefined) ?? null,
            ...(brief ? {} : { enabled: false, nextRunAt: null }),
          },
        );
        s.routines.push(created);
        s.briefs.set(created.id, brief || starterOutline(created.name));
        if (!brief) s.awaitingBrief.add(created.id);
        return { ...created, body: s.briefs.get(created.id) };
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
  "pause and resume from the routine's header in one click each — no Settings tab, no Save — and a Settings save never undoes it",
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
    // Settings has no second Enabled box to fall out of step with the switch,
    // and a Save there never sends `enabled`, so it cannot quietly undo a pause.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await save.waitFor();
    assert.equal(
      await page
        .locator("label")
        .filter({ hasText: /^Enabled$/ })
        .count(),
      0,
      "the header switch is the only control for pausing",
    );
    await save.click();
    const saved = await view.waitForWrite(
      (w) => w.method === "PATCH" && "name" in w.body,
      "Save sent the settings",
    );
    assert.equal("enabled" in saved.body, false, "a Save never sends enabled");
    await page.getByRole("switch", { name: "Resume this routine", exact: true }).waitFor();
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

const REQUEST_BOX = "What should happen, and how often?";
const requestBox = (page: Page) => page.getByRole("textbox", { name: REQUEST_BOX, exact: true });
const employeePicker = (page: Page) =>
  page.getByRole("combobox", { name: "AI Employee", exact: true });
const continueToChat = (page: Page) =>
  page.getByRole("button", { name: "Continue to Chat", exact: true });
const describeInstead = (page: Page) =>
  page.getByRole("button", { name: "Describe it instead", exact: true });
const backToTheForm = (page: Page) =>
  page.getByRole("button", { name: "Back to the form", exact: true });
const assignedTo = (page: Page) => page.getByRole("combobox", { name: "Assigned to", exact: true });
const examples = (page: Page) => page.getByRole("group", { name: "Examples", exact: true });
/** The options a combobox offers, read by opening it. */
async function optionsOf(page: Page, combobox: ReturnType<typeof employeePicker>) {
  await combobox.click();
  const options = await page.getByRole("listbox").getByRole("option").allTextContents();
  await page.keyboard.press("Escape");
  return options;
}

/** What an employee's Chat asks for when a flow lands in it. */
function chatRoutes(): ApiRoute[] {
  return [
    [
      "GET",
      /^\/api\/companies\/company\/employees\/(alex|sam)$/,
      ({ match }) => (match[1] === "sam" ? SAM : ALEX),
    ],
    ["GET", /^\/api\/companies\/company\/employees\/(alex|sam)\/conversations$/, () => []],
    [
      "GET",
      /^\/api\/companies\/company\/employees\/(alex|sam)\/models$/,
      () => [
        {
          id: "model-1",
          employeeId: "sam",
          provider: "anthropic",
          model: "claude-sonnet",
          authMode: "apikey",
          status: "connected",
          isActive: true,
          connectedAt: hoursAgo(100),
          name: "Claude",
        },
      ],
    ],
    ["GET", /^\/api\/companies\/company\/member-browsers\/for-employee\/[^/]+$/, () => []],
  ];
}

await app.check(
  "New routine from one employee's list opens on the form, with that employee assigned",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines?employee=sam", routes: routes(s) });
    const { page } = view;
    await page.getByText("Weekly report").first().waitFor();
    // The page's own button (the sidebar's + is checked separately below).
    await view.click(page.getByRole("button", { name: "New routine", exact: true }).last());
    await view.landedOn("/c/acme/routines/new?employee=sam");
    await page.getByLabel("Name", { exact: true }).waitFor();
    // The form, not the box: describing the work waits behind its link.
    assert.equal(await requestBox(page).count(), 0);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("input")].some((i) => i.value === "Sam Okafor — Engineer"),
    );
    assert.equal(await assignedTo(page).inputValue(), "Sam Okafor — Engineer");
    assert.equal(
      await page.getByRole("button", { name: "Create routine", exact: true }).isDisabled(),
      true,
      "nothing to create yet",
    );
    await describeInstead(page).waitFor();
    assert.equal(view.clicks(), 1, "one click to get here, and the employee is already chosen");
    assert.deepEqual(view.writes, []);
    await page.close();
  },
);

await app.check(
  "an example fills the box, and the examples step aside once the person writes their own words",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/new?describe=1", routes: routes(s) });
    const { page } = view;
    await requestBox(page).waitFor();
    const chips = examples(page).getByRole("button");
    assert.deepEqual(
      await chips.allTextContents(),
      ROUTINE_EXAMPLES.map((example) => example.label),
    );
    await view.click(chips.nth(1));
    assert.equal(await requestBox(page).inputValue(), ROUTINE_EXAMPLES[1].request);
    assert.equal(
      await chips.count(),
      ROUTINE_EXAMPLES.length,
      "an untouched example can be swapped",
    );
    await view.click(chips.nth(0));
    assert.equal(await requestBox(page).inputValue(), ROUTINE_EXAMPLES[0].request);
    await requestBox(page).press("End");
    await page.keyboard.type(" Also flag any refund requests.");
    await examples(page).waitFor({ state: "detached" });
    assert.equal(view.clicks(), 2);
    assert.deepEqual(view.writes, []);
    await page.close();
  },
);

await app.check(
  "the form lists every employee; only those whose Chat is ready can be asked",
  async () => {
    const s = store();
    s.roster = [ALEX, SAM, NOVA];
    const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s) });
    const { page } = view;
    await page.getByLabel("Name", { exact: true }).waitFor();
    assert.deepEqual(await optionsOf(page, assignedTo(page)), [
      "Alex Rivera — Account manager",
      "Sam Okafor — Engineer",
      "Nova Chen — Designer",
    ]);
    await view.click(describeInstead(page));
    await requestBox(page).waitFor();
    assert.deepEqual(await optionsOf(page, employeePicker(page)), [
      "Choose an AI Employee",
      "Alex Rivera — Account manager",
      "Sam Okafor — Engineer",
    ]);
    assert.equal(
      await employeePicker(page).inputValue(),
      "Choose an AI Employee",
      "two can answer, so the person chooses",
    );
    await page.close();
  },
);

await app.check("with one employee able to answer, they are already chosen", async () => {
  const s = store();
  s.roster = [ALEX, NOVA];
  const view = await app.open({ path: "/c/acme/routines/new?describe=1", routes: routes(s) });
  const { page } = view;
  assert.equal(await employeePicker(page).inputValue(), "Alex Rivera — Account manager");
  await requestBox(page).fill("Every Monday, review open customer commitments.");
  assert.equal(await continueToChat(page).isEnabled(), true);
  assert.equal(view.clicks(), 0, "no picking from a list of one");
  await page.close();
});

await app.check(
  "Continue to Chat stages the exact request as an unsent draft in that employee's Chat",
  async () => {
    const s = store();
    const view = await app.open({
      path: "/c/acme/routines/new?employee=sam",
      routes: [...chatRoutes(), ...routes(s)],
    });
    const { page } = view;
    const request = "Every Friday, collect the week's merged pull requests and post a summary.";
    await view.click(describeInstead(page));
    await requestBox(page).fill(request);
    await view.click(continueToChat(page));
    await view.landedOn("/c/acme/employees/sam/chat");
    const composer = page.getByPlaceholder("Message Sam Okafor…");
    await composer.waitFor();
    assert.equal(await composer.inputValue(), buildInitiativeRequestPrompt(request));
    assert.deepEqual(
      view.writes,
      [],
      "nothing is created or sent: the person reads the draft first",
    );
    assert.equal(view.clicks(), 2, "Describe it instead, then Continue to Chat");
    await page.close();
  },
);

await app.check(
  "the form creates the routine with its brief written, so it starts on",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/new?employee=sam", routes: routes(s) });
    const { page } = view;
    const name = page.getByLabel("Name", { exact: true });
    await name.fill("Release notes");
    const create = page.getByRole("button", { name: "Create routine", exact: true });
    assert.equal(await create.isDisabled(), true, "a routine needs its brief");
    await page
      .getByLabel("What should happen on each run?", { exact: true })
      .fill("List every pull request merged since the last notes.");
    assert.equal(await create.isEnabled(), true);
    await name.press("Enter");
    // It has its brief, so the routine itself opens rather than its Brief tab.
    await view.landedOn("/c/acme/routines/sam/release-notes");
    const posts = view.writes.filter((w) => w.method === "POST");
    assert.deepEqual(
      posts.map((w) => w.path),
      [`${API}/employees/sam/routines`],
      "created for Sam, the employee whose list it came from",
    );
    assert.deepEqual(posts[0].body, {
      name: "Release notes",
      cronExpr: "0 9 * * 1-5",
      brief: "List every pull request merged since the last notes.",
      folderId: null,
      tagIds: [],
    });
    await page.getByRole("switch", { name: "Pause this routine", exact: true }).waitFor();
    assert.equal(await page.getByText("Paused until its brief is saved").count(), 0);
    assert.equal(view.clicks(), 0, "the form is already open, and it submits from the keyboard");
    await page.close();
  },
);

await app.check("⌘Enter in the box continues to Chat, as the button does", async () => {
  const s = store();
  s.roster = [ALEX, NOVA];
  const view = await app.open({
    path: "/c/acme/routines/new?describe=1",
    routes: [...chatRoutes(), ...routes(s)],
  });
  const { page } = view;
  const request = "Every morning, tidy the shared inbox.";
  await requestBox(page).fill(request);
  await requestBox(page).press("ControlOrMeta+Enter");
  await view.landedOn("/c/acme/employees/alex/chat");
  const composer = page.getByPlaceholder("Message Alex Rivera…");
  await composer.waitFor();
  assert.equal(await composer.inputValue(), buildInitiativeRequestPrompt(request));
  assert.deepEqual(view.writes, []);
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check(
  "an unsent Chat draft is kept: the request waits until it is sent or cleared",
  async () => {
    const s = store();
    const view = await app.open({
      path: "/c/acme/employees/sam/chat",
      routes: [...chatRoutes(), ...routes(s), ["GET", `${API}/search`, () => ({ results: [] })]],
    });
    const { page } = view;
    const draft = "Remind me to ask about the renewal.";
    const composer = page.getByPlaceholder("Message Sam Okafor…");
    await composer.fill(draft);
    // On to New routine without a reload, so the unsent draft stays in the shell.
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await palette.getByRole("combobox").fill("New routine");
    const best = palette.getByRole("option").first();
    await best.waitFor();
    assert.match((await best.textContent()) ?? "", /New routine/);
    await best.click();
    await view.landedOn("/c/acme/routines/new");
    await view.click(describeInstead(page));
    await requestBox(page).fill("Every Monday, review open customer commitments.");
    await employeePicker(page).click();
    await page.getByRole("option", { name: /^Sam Okafor/ }).click();
    await page.getByText(/Sam Okafor already has an unsent Chat draft/).waitFor();
    assert.equal(await continueToChat(page).isDisabled(), true, "it would bury the draft");
    await view.click(page.getByRole("link", { name: "Open existing draft", exact: true }));
    await view.landedOn("/c/acme/employees/sam/chat");
    assert.equal(await composer.inputValue(), draft, "the draft is exactly as it was left");
    assert.deepEqual(view.writes, []);
    await page.close();
  },
);

await app.check("a refused create says why beside the form and keeps what was typed", async () => {
  const s = store();
  s.refuseCreate = "A routine with that name already exists for this employee";
  const view = await app.open({ path: "/c/acme/routines/new?employee=sam", routes: routes(s) });
  const { page } = view;
  await page.getByLabel("Name", { exact: true }).fill("Weekly report");
  await page
    .getByLabel("What should happen on each run?", { exact: true })
    .fill("Summarize the week.");
  await view.click(page.getByRole("button", { name: "Create routine", exact: true }));
  await page.getByRole("alert").getByText(s.refuseCreate, { exact: true }).waitFor();
  assert.equal(await view.location(), "/c/acme/routines/new?employee=sam");
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Weekly report");
  assert.equal(
    await page.getByRole("button", { name: "Create routine", exact: true }).isEnabled(),
    true,
    "the person can fix the name and try again",
  );
  assert.equal(await page.getByRole("dialog").count(), 0, "an inline error, not a popup");
  await page.close();
});

await app.check("what was typed in one way is still there after a look at the other", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s) });
  const { page } = view;
  await page.getByLabel("Name", { exact: true }).fill("Inbox tidy");
  await view.click(describeInstead(page));
  await requestBox(page).fill("Every morning, tidy the shared inbox.");
  await view.click(backToTheForm(page));
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Inbox tidy");
  await view.click(describeInstead(page));
  assert.equal(await requestBox(page).inputValue(), "Every morning, tidy the shared inbox.");
  await page.close();
});

await app.check(
  "Folder and Tags wait behind Advanced, which says what is set while it is closed",
  async () => {
    const s = store();
    const view = await app.open({
      path: "/c/acme/routines/new?folder=ops&employee=alex",
      routes: routes(s),
    });
    const { page } = view;
    const more = page.getByRole("button", { name: /^Advanced/ });
    // The folder it was opened from lands with the folders.
    await page.getByRole("button", { name: /^Advanced\s*Folder: Operations$/ }).waitFor();
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("combobox", { name: "Folder", exact: true }).count(), 0);
    assert.match((await more.textContent()) ?? "", /Folder: Operations/);
    await view.click(more);
    assert.equal(await more.getAttribute("aria-expanded"), "true");
    assert.equal(
      await page.getByRole("combobox", { name: "Folder", exact: true }).inputValue(),
      "Operations",
    );
    await page.getByText("Tags", { exact: true }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Inbox tidy");
    await page.getByLabel("What should happen on each run?").fill("Tidy the shared inbox.");
    await page.getByLabel("Name", { exact: true }).press("Enter");
    await view.landedOn("/c/acme/routines/alex/inbox-tidy");
    assert.equal(view.writes.find((w) => w.method === "POST")?.body.folderId, "ops");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check("with nobody able to answer, the form says why under it", async () => {
  const s = store();
  s.roster = [
    { ...ALEX, chatReady: false },
    { ...SAM, chatReady: false },
  ];
  const view = await app.open({ path: "/c/acme/routines/new?employee=sam", routes: routes(s) });
  const { page } = view;
  await page.getByLabel("Name", { exact: true }).waitFor();
  await page
    .getByText(/Describing a Routine needs an AI Employee with a connected AI Model/)
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Connect an AI Model", exact: true }).getAttribute("href"),
    "/c/acme/employees/sam/settings/model",
  );
  assert.equal(await requestBox(page).count(), 0);
  assert.equal(await describeInstead(page).count(), 0);
  await page.close();
});

await app.check("Members get a note instead of a form that could only be refused", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s), role: "member" });
  const { page } = view;
  await page.getByText("Only owners and admins create Routines", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox").count(), 0);
  assert.equal(await describeInstead(page).count(), 0);
  assert.deepEqual(view.writes, []);
  await page.close();
});

await app.check(
  "a routine made without a brief waits paused, and saving its brief switches it on",
  async () => {
    const s = store();
    // As the API makes one when no brief is sent.
    const waiting = routine("release-notes", "Release notes", SAM, {
      enabled: false,
      nextRunAt: null,
    });
    s.routines.push(waiting);
    s.briefs.set(waiting.id, starterOutline(waiting.name));
    s.awaitingBrief.add(waiting.id);
    const view = await app.open({
      path: "/c/acme/routines/sam/release-notes?tab=brief",
      routes: routes(s),
    });
    const { page } = view;
    await page.getByText("Paused until its brief is saved", { exact: true }).waitFor();
    await header(page).getByText("paused", { exact: true }).waitFor();
    await page
      .locator("textarea")
      .first()
      .fill("List every pull request merged since the last notes.");
    await view.click(page.getByRole("button", { name: "Save brief & switch on", exact: true }));
    await page.getByRole("switch", { name: "Pause this routine", exact: true }).waitFor();
    await page.getByRole("button", { name: "Save brief", exact: true }).waitFor();
    assert.equal(await page.getByText("Paused until its brief is saved").count(), 0);
    assert.equal(view.clicks(), 1, "one save writes the brief and switches the routine on");
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

await app.check("phone width: the form and Describe it both fit", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s), touch: true });
  await view.page.getByLabel("Name", { exact: true }).waitFor();
  await noSidewaysScroll(view.page, "the form on a phone");
  await view.click(describeInstead(view.page));
  await requestBox(view.page).waitFor();
  await noSidewaysScroll(view.page, "Describe it on a phone");
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
