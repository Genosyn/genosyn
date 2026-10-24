/**
 * Real Chrome coverage for New routine opening on the form, on the real App:
 * every way to the page — the Routines list and its empty state, the sidebar's
 * +, a folder, one employee's routines, Running, Proactive and ⌘K — lands on
 * Name, Assigned to, Schedule and the brief, never on the box to describe the
 * work in. Describe it instead switches to the box (writing `?describe=1`),
 * Back to the form returns with everything typed still there, the `?employee=`
 * and `?folder=` presets apply in both and survive the switch, an explicit
 * `?describe=1` opens straight on the box, a New routine pressed from the box
 * lands on the form, and with nobody able to answer a Chat the form says why
 * under it instead of offering the link. Run with `npm run test:new-routine`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type { Employee, RoutineFolder, RoutineWithMeta } from "../client/lib/api";
import {
  API,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
  type AppView,
} from "./appFixture";

const app = await startApp("New routine opens on the form");

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

function routine(id: string, name: string, owner: Employee, folderId: string | null = null) {
  return {
    id,
    employeeId: owner.id,
    name,
    slug: id,
    cronExpr: "0 9 * * 1-5",
    enabled: true,
    folderId,
    goalId: null,
    lastRunAt: null,
    nextRunAt: hoursAgo(-20),
    timeoutSec: 600,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
    createdAt: hoursAgo(500),
    updatedAt: hoursAgo(5),
    employee: {
      id: owner.id,
      name: owner.name,
      slug: owner.slug,
      role: owner.role,
      avatarKey: null,
    },
    lastRun: null,
    standdown: null,
    tags: [],
  } as unknown as RoutineWithMeta;
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
  roster: Employee[];
  briefs: Map<string, string>;
};

function store(changes: Partial<Store> = {}): Store {
  return {
    routines: [
      routine("daily-inbox", "Daily inbox sweep", ALEX, "ops"),
      routine("weekly-report", "Weekly report", SAM),
    ],
    folders: [folder("ops", "Operations", 1), folder("revenue", "Revenue", 0)],
    roster: [ALEX, SAM, NOVA],
    briefs: new Map(),
    ...changes,
  };
}

function routes(s: Store): ApiRoute[] {
  return [
    ["GET", `${API}/routines`, () => s.routines],
    ["GET", `${API}/employees`, () => s.roster],
    ["GET", `${API}/routine-folders`, () => ({ folders: s.folders, unfiledCount: 1, maxDepth: 5 })],
    [
      "GET",
      `${API}/routines/activity`,
      () => ({ running: [], queued: [], queuedCount: 0, today: [] }),
    ],
    ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
    ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
    ["GET", /\/tags$/, () => []],
    ["GET", `${API}/search`, () => ({ results: [] })],
    [
      "GET",
      `${API}/proactive`,
      () => ({
        automaticSetup: true,
        defaultAssignments: {},
        recipes: [],
        employees: [],
        mailboxes: [],
        installations: [],
      }),
    ],
    // The routine a create lands on.
    [
      "GET",
      /^\/api\/companies\/company\/routines\/([^/]+)\/readme$/,
      ({ match }) => ({ content: s.briefs.get(match[1]) ?? "", awaitingBrief: false }),
    ],
    ["GET", /^\/api\/companies\/company\/routines\/[^/]+\/runs$/, () => []],
    ["GET", /^\/api\/companies\/company\/run-lessons\/routine\/[^/]+$/, () => []],
    ["GET", `${API}/workstreams`, () => []],
    ["GET", /^\/api\/companies\/company\/employees\/[^/]+\/models$/, () => []],
    [
      "POST",
      /^\/api\/companies\/company\/employees\/([^/]+)\/routines$/,
      ({ match, body }) => {
        const owner = s.roster.find((e) => e.id === match[1])!;
        const created = routine(
          String(body.name).toLowerCase().replace(/\s+/g, "-"),
          String(body.name),
          owner,
          (body.folderId as string | null | undefined) ?? null,
        );
        s.routines.push(created);
        s.briefs.set(created.id, String(body.brief ?? ""));
        return { ...created, body: s.briefs.get(created.id) };
      },
    ],
  ];
}

// ───────────────────────────── the page ─────────────────────────────

const nameField = (page: Page) => page.getByLabel("Name", { exact: true });
const assignedTo = (page: Page) => page.getByRole("combobox", { name: "Assigned to", exact: true });
const briefField = (page: Page) =>
  page.getByLabel("What should happen on each run?", { exact: true });
const createRoutine = (page: Page) =>
  page.getByRole("button", { name: "Create routine", exact: true });
const moreOptions = (page: Page) => page.getByRole("button", { name: /^Advanced/ });
const folderPicker = (page: Page) => page.getByRole("combobox", { name: "Folder", exact: true });
const describeInstead = (page: Page) =>
  page.getByRole("button", { name: "Describe it instead", exact: true });
const backToTheForm = (page: Page) =>
  page.getByRole("button", { name: "Back to the form", exact: true });
const requestBox = (page: Page) =>
  page.getByRole("textbox", { name: "What should happen, and how often?", exact: true });
const askEmployee = (page: Page) =>
  page.getByRole("combobox", { name: "AI Employee", exact: true });
const continueToChat = (page: Page) =>
  page.getByRole("button", { name: "Continue to Chat", exact: true });
const sidebarNew = (page: Page) => page.locator('button[title="New routine"]');
/** Advanced, closed, naming the folder the routine will be filed in. */
const filedIn = (page: Page, folder: string) =>
  page.getByRole("button", { name: new RegExp(`^Advanced\\s*Folder: ${folder}$`) });
const NO_MODEL = /Describing a Routine needs an AI Employee with a connected AI Model/;

/** Pick `option` from a combobox the way a person does: open it, click the row. */
async function choose(page: Page, combobox: Locator, option: RegExp) {
  await combobox.click();
  await page.getByRole("listbox").getByRole("option", { name: option }).click();
}

/** Wait until a field reads `value` — a preset lands once the roster has. */
async function waitForValue(field: Locator, value: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const now = await field.inputValue();
    if (now === value) return;
    if (Date.now() > deadline) assert.equal(now, value);
    await field.page().waitForTimeout(50);
  }
}

/**
 * The page as the owner's screenshot shows it: the form's fields, its two
 * buttons, Describe it instead under the card, and no box to describe in.
 */
async function assertOnTheForm(view: AppView, where: string) {
  const { page } = view;
  await nameField(page).waitFor();
  await assignedTo(page).waitFor();
  await page.getByText("Schedule", { exact: true }).waitFor();
  await briefField(page).waitFor();
  await moreOptions(page).waitFor();
  await createRoutine(page).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  await describeInstead(page).waitFor();
  assert.equal(await requestBox(page).count(), 0, `${where}: the box waits behind the link`);
  assert.equal(await continueToChat(page).count(), 0, `${where}: nothing to hand to Chat yet`);
  assert.equal(await backToTheForm(page).count(), 0, `${where}: already on the form`);
}

async function assertInTheBox(view: AppView, where: string) {
  const { page } = view;
  await requestBox(page).waitFor();
  await askEmployee(page).waitFor();
  await continueToChat(page).waitFor();
  await backToTheForm(page).waitFor();
  for (const field of [nameField(page), assignedTo(page), briefField(page), createRoutine(page)]) {
    assert.equal(await field.count(), 0, `${where}: the form waits behind Back to the form`);
  }
  assert.equal(await describeInstead(page).count(), 0, `${where}: already describing`);
}

// ───────────────────────────── checks ─────────────────────────────

await app.check(
  "New routine on the Routines list opens on the form, with the cursor in Name",
  async () => {
    const s = store();
    // Tall enough to show the whole card and the link beneath it.
    const view = await app.open({ path: "/c/acme/routines", routes: routes(s), height: 1100 });
    const { page } = view;
    await page.getByText("Weekly report").first().waitFor();
    await view.click(page.getByRole("button", { name: "New routine", exact: true }).last());
    await view.landedOn("/c/acme/routines/new");
    await assertOnTheForm(view, "the list's New routine");
    await waitForFocus(nameField(page), "the cursor starts in Name");
    await waitForValue(assignedTo(page), "Alex Rivera — Account manager");
    assert.equal(
      await page.getByRole("combobox", { name: "How often", exact: true }).inputValue(),
      "Weekly",
    );
    await page.getByText("0 9 * * 1-5", { exact: true }).waitFor();
    // Describe it instead sits under the card, below its buttons.
    const create = await createRoutine(page).boundingBox();
    const link = await describeInstead(page).boundingBox();
    assert.ok(create && link && link.y > create.y + create.height, "the link is under the form");
    assert.equal(view.clicks(), 1, "one click to the form");
    assert.deepEqual(view.writes, []);
    await app.shot(page, "new-routine-form");
    await page.close();
  },
);

await app.check("the sidebar's + opens the form", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines", routes: routes(s) });
  await view.page.getByText("Weekly report").first().waitFor();
  await view.click(sidebarNew(view.page));
  await view.landedOn("/c/acme/routines/new");
  await assertOnTheForm(view, "the sidebar's +");
  await view.page.close();
});

await app.check("New routine in a folder opens the form, filing it in that folder", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines?folder=ops", routes: routes(s) });
  const { page } = view;
  await page.getByText("Daily inbox sweep").first().waitFor();
  await view.click(page.getByRole("button", { name: "New routine", exact: true }).last());
  await view.landedOn("/c/acme/routines/new?folder=ops");
  await assertOnTheForm(view, "a folder's New routine");
  await filedIn(page, "Operations").waitFor();
  await page.close();
});

await app.check(
  "New routine on one employee's routines opens the form, assigned to them",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines?employee=sam", routes: routes(s) });
    const { page } = view;
    await page.getByText("Weekly report").first().waitFor();
    await view.click(page.getByRole("button", { name: "New routine", exact: true }).last());
    await view.landedOn("/c/acme/routines/new?employee=sam");
    await assertOnTheForm(view, "one employee's New routine");
    await waitForValue(assignedTo(page), "Sam Okafor — Engineer");
    await page.close();
  },
);

await app.check("an empty Routines list's New routine opens the form", async () => {
  const s = store({ routines: [] });
  const view = await app.open({ path: "/c/acme/routines", routes: routes(s) });
  const { page } = view;
  const empty = page.getByRole("heading", { name: "No routines yet", exact: true });
  await view.click(
    empty.locator("xpath=..").getByRole("button", { name: "New routine", exact: true }),
  );
  await view.landedOn("/c/acme/routines/new");
  await assertOnTheForm(view, "the empty list's New routine");
  await page.close();
});

await app.check("Running's New routine opens the form", async () => {
  const s = store({ routines: [] });
  const view = await app.open({ path: "/c/acme/routines/running", routes: routes(s) });
  const { page } = view;
  const empty = page.getByRole("heading", { name: "No routines yet", exact: true });
  await view.click(
    empty.locator("xpath=..").getByRole("button", { name: "New routine", exact: true }),
  );
  await view.landedOn("/c/acme/routines/new");
  await assertOnTheForm(view, "Running's New routine");
  await page.close();
});

await app.check("Proactive's New Routine opens the form", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/proactive", routes: routes(s) });
  const { page } = view;
  await view.click(page.getByRole("link", { name: "New Routine", exact: true }));
  await view.landedOn("/c/acme/routines/new");
  await assertOnTheForm(view, "Proactive's New Routine");
  await page.close();
});

await app.check("⌘K's New routine opens the form", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines", routes: routes(s) });
  const { page } = view;
  await page.getByText("Weekly report").first().waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("combobox").fill("New routine");
  const best = palette.getByRole("option").first();
  await best.waitFor();
  assert.match((await best.textContent()) ?? "", /New routine/);
  await view.click(best);
  await view.landedOn("/c/acme/routines/new");
  await assertOnTheForm(view, "⌘K's New routine");
  await page.close();
});

await app.check(
  "Describe it instead switches to the box, and Back to the form keeps everything typed",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s) });
    const { page } = view;
    await assertOnTheForm(view, "before typing");
    await nameField(page).fill("Inbox tidy");
    await choose(page, assignedTo(page), /^Sam Okafor/);
    await page.getByRole("button", { name: "Every Monday, 9:00 AM", exact: true }).click();
    await briefField(page).fill("Tidy the shared inbox and flag anything urgent.");
    await moreOptions(page).click();
    await choose(page, folderPicker(page), /^Operations$/);

    await view.click(describeInstead(page));
    await view.landedOn("/c/acme/routines/new?describe=1");
    await assertInTheBox(view, "after Describe it instead");
    await waitForFocus(requestBox(page), "the cursor moves to the box");
    await requestBox(page).fill("Every morning, tidy the shared inbox.");
    await choose(page, askEmployee(page), /^Alex Rivera/);

    await view.click(backToTheForm(page));
    await view.landedOn("/c/acme/routines/new");
    await assertOnTheForm(view, "after Back to the form");
    await waitForFocus(nameField(page), "the cursor is back in Name");
    assert.equal(await nameField(page).inputValue(), "Inbox tidy");
    assert.equal(await assignedTo(page).inputValue(), "Sam Okafor — Engineer");
    await page.getByText("0 9 * * 1", { exact: true }).waitFor();
    assert.equal(
      await briefField(page).inputValue(),
      "Tidy the shared inbox and flag anything urgent.",
    );
    // Advanced opens closed again, and says where the routine will be filed.
    await filedIn(page, "Operations").waitFor();

    // And the box kept its words too.
    await view.click(describeInstead(page));
    assert.equal(await requestBox(page).inputValue(), "Every morning, tidy the shared inbox.");
    assert.equal(await askEmployee(page).inputValue(), "Alex Rivera — Account manager");
    // A length, not deepEqual: that would narrow `writes` to `never[]` for the create below.
    assert.equal(view.writes.length, 0, "switching sends nothing");

    await view.click(backToTheForm(page));
    await nameField(page).press("Enter");
    await view.landedOn("/c/acme/routines/sam/inbox-tidy");
    const posts = view.writes.filter((w) => w.method === "POST");
    assert.deepEqual(
      posts.map((w) => w.path),
      [`${API}/employees/sam/routines`],
    );
    assert.deepEqual(posts[0].body, {
      name: "Inbox tidy",
      cronExpr: "0 9 * * 1",
      brief: "Tidy the shared inbox and flag anything urgent.",
      folderId: "ops",
      tagIds: [],
    });
    assert.equal(view.clicks(), 4, "two switches there and two back");
    await page.close();
  },
);

await app.check(
  "the employee and folder presets apply on the form, in the box, and across the switch",
  async () => {
    const s = store();
    const view = await app.open({
      path: "/c/acme/routines/new?folder=ops&employee=sam",
      routes: routes(s),
    });
    const { page } = view;
    await assertOnTheForm(view, "with presets");
    await waitForValue(assignedTo(page), "Sam Okafor — Engineer");
    await filedIn(page, "Operations").waitFor();

    await view.click(describeInstead(page));
    await view.landedOn("/c/acme/routines/new?folder=ops&employee=sam&describe=1");
    await assertInTheBox(view, "with presets");
    await app.shot(page, "new-routine-describe");
    assert.equal(await askEmployee(page).inputValue(), "Sam Okafor — Engineer");
    await page.getByText(/Sam Okafor then proposes the Routine as an Initiative/).waitFor();

    await view.click(backToTheForm(page));
    await view.landedOn("/c/acme/routines/new?folder=ops&employee=sam");
    assert.equal(await assignedTo(page).inputValue(), "Sam Okafor — Engineer");
    await filedIn(page, "Operations").waitFor();

    await nameField(page).fill("Release notes");
    await briefField(page).fill("List every pull request merged since the last notes.");
    await view.click(createRoutine(page));
    await view.landedOn("/c/acme/routines/sam/release-notes");
    const post = view.writes.find((w) => w.method === "POST");
    assert.equal(post?.path, `${API}/employees/sam/routines`);
    assert.equal(post?.body.folderId, "ops");
    assert.equal(post?.body.cronExpr, "0 9 * * 1-5");
    await page.close();
  },
);

await app.check("an explicit ?describe=1 opens straight on the box", async () => {
  const s = store();
  const view = await app.open({
    path: "/c/acme/routines/new?describe=1&employee=sam",
    routes: routes(s),
  });
  const { page } = view;
  await assertInTheBox(view, "?describe=1");
  await waitForFocus(requestBox(page), "the cursor starts in the box");
  assert.equal(await askEmployee(page).inputValue(), "Sam Okafor — Engineer");
  // Only the employees who can answer a Chat are offered here.
  await askEmployee(page).click();
  assert.deepEqual(await page.getByRole("listbox").getByRole("option").allTextContents(), [
    "Choose an AI Employee",
    "Alex Rivera — Account manager",
    "Sam Okafor — Engineer",
  ]);
  await page.keyboard.press("Escape");
  await view.click(backToTheForm(page));
  await view.landedOn("/c/acme/routines/new?employee=sam");
  await assertOnTheForm(view, "Back to the form from ?describe=1");
  assert.equal(await assignedTo(page).inputValue(), "Sam Okafor — Engineer");
  // The form offers everyone, ready to answer a Chat or not.
  await assignedTo(page).click();
  assert.deepEqual(await page.getByRole("listbox").getByRole("option").allTextContents(), [
    "Alex Rivera — Account manager",
    "Sam Okafor — Engineer",
    "Nova Chen — Designer",
  ]);
  await page.keyboard.press("Escape");
  assert.deepEqual(view.writes, []);
  await page.close();
});

await app.check(
  "a New routine pressed from the box lands on the form, keeping what was typed",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s) });
    const { page } = view;
    await nameField(page).fill("Inbox tidy");
    await view.click(describeInstead(page));
    await requestBox(page).fill("Every morning, tidy the shared inbox.");
    await view.click(sidebarNew(page));
    await view.landedOn("/c/acme/routines/new");
    await assertOnTheForm(view, "the sidebar's + from the box");
    assert.equal(await nameField(page).inputValue(), "Inbox tidy");

    await view.click(describeInstead(page));
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    await palette.getByRole("combobox").fill("New routine");
    const best = palette.getByRole("option").first();
    await best.waitFor();
    await view.click(best);
    await view.landedOn("/c/acme/routines/new");
    await assertOnTheForm(view, "⌘K's New routine from the box");
    assert.deepEqual(view.writes, []);
    await page.close();
  },
);

await app.check(
  "with nobody able to answer, the form opens without Describe it instead and says why under it",
  async () => {
    const s = store({
      roster: [
        { ...ALEX, chatReady: false },
        { ...SAM, chatReady: false },
      ],
    });
    for (const path of [
      "/c/acme/routines/new?employee=sam",
      "/c/acme/routines/new?employee=sam&describe=1",
    ]) {
      const view = await app.open({ path, routes: routes(s), height: 1100 });
      const { page } = view;
      await nameField(page).waitFor();
      const note = page.getByText(NO_MODEL);
      await note.waitFor();
      if (!path.includes("describe")) await app.shot(page, "new-routine-no-model");
      assert.equal(
        await page
          .getByRole("link", { name: "Connect an AI Model", exact: true })
          .getAttribute("href"),
        "/c/acme/employees/sam/settings/model",
      );
      assert.equal(await describeInstead(page).count(), 0, `${path}: nobody to describe it to`);
      assert.equal(await requestBox(page).count(), 0, path);
      const create = await createRoutine(page).boundingBox();
      const below = await note.boundingBox();
      assert.ok(create && below && below.y > create.y + create.height, `${path}: under the form`);
      await page.close();
    }
  },
);

await app.check("Cancel leaves for the Routines list from the form and from the box", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s) });
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await view.landedOn("/c/acme/routines");
  await page.close();

  const box = await app.open({ path: "/c/acme/routines/new?describe=1", routes: routes(s) });
  await requestBox(box.page).waitFor();
  await box.click(box.page.getByRole("button", { name: "Cancel", exact: true }));
  await box.landedOn("/c/acme/routines");
  assert.deepEqual([...view.writes, ...box.writes], []);
  await box.page.close();
});

await app.check("Members get a note, with neither the form nor the box", async () => {
  const s = store();
  for (const path of ["/c/acme/routines/new", "/c/acme/routines/new?describe=1"]) {
    const view = await app.open({ path, routes: routes(s), role: "member" });
    const { page } = view;
    await page.getByText("Only owners and admins create Routines", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox").count(), 0, path);
    assert.equal(await describeInstead(page).count(), 0, path);
    assert.equal(await backToTheForm(page).count(), 0, path);
    await page.close();
  }
});

await app.check("phone width: the form and the box both fit", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/routines/new", routes: routes(s), touch: true });
  const { page } = view;
  await assertOnTheForm(view, "a phone");
  await noSidewaysScroll(page, "the form on a phone");
  await view.click(describeInstead(page));
  await requestBox(page).waitFor();
  await noSidewaysScroll(page, "the box on a phone");
  await app.shot(page, "new-routine-describe-phone");
  await view.click(backToTheForm(page));
  await nameField(page).waitFor();
  await noSidewaysScroll(page, "the form again on a phone");
  await page.close();
});

await app.finish();
