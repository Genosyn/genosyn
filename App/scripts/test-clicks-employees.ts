/**
 * Real Chrome coverage for the shorter AI Employee flows, on the real App:
 * connecting an AI Model starts in the API key field; the Proactive starter
 * and Ask dialogs arrive with the only AI Employee (and the only mailbox)
 * already chosen; Enter renames a Skill; switching hire templates replaces
 * the name the last template filled in but never one the Member typed; and
 * ⌘/Ctrl+Enter submits a Journal entry, a Memory and a handoff close-out from
 * their text boxes. Each flow counts its clicks. (Picking a Team saves on the
 * pick; `npm run test:employees-roster` covers that.) Run with
 * `npm run test:clicks-employees`.
 */
import assert from "node:assert/strict";
import type { Employee, EmployeeTemplate } from "../client/lib/api";
import type { ProactiveOverview } from "../shared/proactive";
import { API, hoursAgo, startApp, waitForFocus, type ApiRoute } from "./appFixture";

const app = await startApp("Fewer clicks — AI Employees");

// ───────────────────────────── fixtures ─────────────────────────────

const ADA: Employee = {
  id: "ada",
  companyId: "company",
  name: "Ada Lovelace",
  slug: "ada",
  role: "Analyst",
  avatarKey: null,
  model: null,
  modelCount: 0,
};

const base: ApiRoute[] = [
  ["GET", `${API}/employees`, () => [ADA]],
  ["GET", `${API}/employees/ada`, () => ADA],
  ["GET", /^\/api\/companies\/company\/employees\/ada\/models$/, () => []],
  ["GET", /\/teams$/, () => []],
  ["GET", /\/tags$/, () => []],
  ["GET", /\/standdowns\/active$/, () => ({ standdown: null })],
  ["GET", /\/standdowns$/, () => ({ standdowns: [] })],
];

// ───────────────────────────── checks ─────────────────────────────

await app.check("connecting an AI Model starts with the cursor in the API key field", async () => {
  const view = await app.open({ path: "/c/acme/employees/ada/settings/model", routes: base });
  const { page } = view;
  const key = page.getByLabel("API key", { exact: true });
  await waitForFocus(key, "the key field has focus — paste, Enter");
  assert.equal(view.clicks(), 0);
  await page.close();
});

function proactive(employees: number, mailboxes: number): ProactiveOverview {
  const employee = (n: number) => ({
    id: `emp-${n}`,
    name: ["Ada Lovelace", "Grace Hopper"][n] ?? `Employee ${n}`,
    slug: `emp-${n}`,
    modelReady: true,
    chatReady: true,
    financeAccess: null,
    revenueAccess: null,
    repositoryWrite: false,
    calendarRead: false,
    mailGrants: [{ accountId: "mailbox-0", accessLevel: "draft" }],
  });
  return {
    automaticSetup: false,
    defaultAssignments: {},
    recipes: [
      {
        id: "inbox-triage",
        name: "Inbox triage",
        description: "Sort new mail every morning.",
        kind: "email",
        requirements: ["mail"],
        brief: "Triage the inbox.",
        acceptanceCriteria: "Every new email is labelled.",
      },
    ],
    employees: Array.from({ length: employees }, (_, n) => employee(n)),
    mailboxes: Array.from({ length: mailboxes }, (_, n) => ({
      id: `mailbox-${n}`,
      address: `support${n}@acme.example`,
      status: "active",
      analysisEnabled: true,
      analysisReady: true,
    })),
    installations: [],
  } as ProactiveOverview;
}

await app.check(
  "Proactive: with one AI Employee and one mailbox, the starter dialog arrives ready to assign",
  async () => {
    const view = await app.open({
      path: "/c/acme/proactive",
      routes: [["GET", `${API}/proactive`, () => proactive(1, 1)], ...base],
    });
    const { page } = view;
    await view.click(
      page.getByRole("button", { name: /Browse (the )?(starter library|1 starters)/ }).first(),
    );
    await view.click(page.getByRole("button", { name: "Set up", exact: true }).first());
    const dialog = page.getByRole("dialog");
    await page.waitForFunction(() => {
      const values = [...document.querySelectorAll('[role="dialog"] select')].map(
        (select) => (select as HTMLSelectElement).value,
      );
      return values.includes("emp-0") && values.includes("mailbox-0");
    });
    const assign = dialog.getByRole("button", { name: "Assign work", exact: true });
    assert.equal(await assign.isDisabled(), false, "nothing left to pick before Assign work");
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check("Proactive: with several, nobody is picked for you", async () => {
  const view = await app.open({
    path: "/c/acme/proactive",
    routes: [["GET", `${API}/proactive`, () => proactive(2, 2)], ...base],
  });
  const { page } = view;
  await page
    .getByRole("button", { name: /Browse/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Set up", exact: true }).first().click();
  await page.getByRole("dialog").waitFor();
  const values = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] select')].map(
      (select) => (select as HTMLSelectElement).value,
    ),
  );
  assert.ok(
    values.every((value) => value === ""),
    `nothing preselected: ${values.join(",")}`,
  );
  await page.close();
});

await app.check(
  "Proactive: Ask an AI Employee has the only one chosen, and ⌘Enter continues to Chat",
  async () => {
    const view = await app.open({
      path: "/c/acme/proactive",
      routes: [
        ["GET", `${API}/proactive`, () => proactive(1, 1)],
        ["GET", /^\/api\/companies\/company\/employees\/emp-0\/conversations$/, () => []],
        ...base,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Ask AI Employee/ }).first());
    const dialog = page.getByRole("dialog", { name: "Ask an AI Employee" });
    const request = dialog.getByLabel("What should become standing work?");
    await waitForFocus(request);
    await page.keyboard.type("Every Monday, review open customer commitments.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await view.landedOn("/c/acme/employees/emp-0/chat");
    assert.equal(view.clicks(), 1, "Ask, type, ⌘Enter: no employee pick, no Continue click");
    await page.close();
  },
);

await app.check("Enter renames a Skill from its Settings tab", async () => {
  const skill = {
    id: "skill-1",
    employeeId: "ada",
    name: "Qualify a lead",
    slug: "qualify-a-lead",
    toolset: [],
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(10),
    employee: { id: "ada", name: ADA.name, slug: "ada", role: ADA.role, avatarKey: null },
    tags: [],
  };
  const view = await app.open({
    path: "/c/acme/skills/ada/qualify-a-lead?tab=settings",
    routes: [
      ["GET", `${API}/skills`, () => [skill]],
      ["GET", /\/skills\/skill-1\/readme$/, () => ({ content: "1. Check the budget." })],
      [
        "PATCH",
        /\/skills\/skill-1$/,
        ({ body }) => {
          Object.assign(skill, body);
          return skill;
        },
      ],
      ...base,
    ],
  });
  const { page } = view;
  const settingsTab = page.getByRole("button", { name: "Settings", exact: true });
  if (await settingsTab.count()) await settingsTab.first().click();
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Qualify an inbound lead");
  await name.press("Enter");
  const patch = await view.waitForWrite((w) => w.method === "PATCH", "Enter saved the rename");
  assert.deepEqual(patch.body, { name: "Qualify an inbound lead", toolset: [] });
  // Nothing changed since: another Enter saves nothing more.
  await name.press("Enter");
  await page.waitForTimeout(250);
  assert.equal(view.writes.filter((w) => w.method === "PATCH").length, 1);
  await page.close();
});

await app.check(
  "hire: switching template replaces the name the last one filled, never a typed one",
  async () => {
    const templates: EmployeeTemplate[] = [
      {
        id: "t-sales",
        name: "Ava",
        role: "Sales rep",
        category: "Revenue",
        tagline: "Books meetings",
        skills: [],
        routines: [],
      },
      {
        id: "t-eng",
        name: "Sam",
        role: "Engineer",
        category: "Engineering",
        tagline: "Fixes bugs",
        skills: [],
        routines: [],
      },
    ];
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: [["GET", "/api/employee-templates", () => templates], ...base],
    });
    const { page } = view;
    const name = page.getByLabel("Name", { exact: true });
    await page.getByText("Ava", { exact: false }).first().click();
    await page
      .waitForFunction(
        () =>
          (document.querySelector('input[name="name"], input#name') as HTMLInputElement | null)
            ?.value !== "",
      )
      .catch(() => undefined);
    assert.equal(await name.inputValue(), "Ava");
    await page.getByText("Sam", { exact: false }).first().click();
    assert.equal(await name.inputValue(), "Sam", "the new template's name follows the pick");
    await name.fill("Morgan");
    await page.getByText("Ava", { exact: false }).first().click();
    assert.equal(await name.inputValue(), "Morgan", "a name the Member typed is kept");
    await page.close();
  },
);

await app.check("⌘Enter adds a Journal entry and a Memory from their detail boxes", async () => {
  const view = await app.open({
    path: "/c/acme/employees/ada/settings/journal",
    routes: [
      ["GET", /\/employees\/ada\/journal.*/, () => []],
      ["POST", /\/employees\/ada\/journal$/, ({ body }) => ({ id: "j1", ...body })],
      ["GET", /\/employees\/ada\/memory.*/, () => []],
      ["POST", /\/employees\/ada\/memory$/, ({ body }) => ({ id: "m1", ...body })],
      ...base,
    ],
  });
  const { page } = view;
  await page.getByLabel("Add note", { exact: true }).fill("Renewal call went well");
  const detail = page.getByRole("textbox", { name: "Detail (optional)" });
  await detail.fill("Acme wants a three-year term.");
  await detail.press("ControlOrMeta+Enter");
  const journal = await view.waitForWrite(
    (w) => w.method === "POST" && /journal$/.test(w.path),
    "the entry was added from the detail box",
  );
  assert.equal(journal.body.title, "Renewal call went well");
  await page.close();

  const memory = await app.open({
    path: "/c/acme/employees/ada/settings/memory",
    routes: [
      ["GET", /\/employees\/ada\/memory.*/, () => []],
      ["POST", /\/employees\/ada\/memory$/, ({ body }) => ({ id: "m1", ...body })],
      ...base,
    ],
  });
  await memory.page.getByLabel("New memory", { exact: true }).fill("Prefers ARR over MRR");
  const elaboration = memory.page.getByRole("textbox", { name: "Elaboration (optional)" });
  await elaboration.fill("When talking about revenue.");
  await elaboration.press("ControlOrMeta+Enter");
  await memory.waitForWrite(
    (w) => w.method === "POST" && /memory$/.test(w.path),
    "the memory was added from the elaboration box",
  );
  assert.equal(memory.clicks(), 0);
  await memory.page.close();
});

await app.check("⌘Enter completes a handoff from its resolution note, once", async () => {
  const handoff = {
    id: "handoff-1",
    companyId: "company",
    fromEmployeeId: "grace",
    toEmployeeId: "ada",
    from: { id: "grace", name: "Grace Hopper", slug: "grace" },
    to: { id: "ada", name: ADA.name, slug: "ada" },
    title: "Reconcile the September invoices",
    body: "Three invoices do not match the bank feed.",
    status: "pending",
    resolutionNote: null,
    dueAt: null,
    completedAt: null,
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(5),
  };
  const view = await app.open({
    path: "/c/acme/employees/ada/settings/handoffs",
    routes: [
      ["GET", `${API}/handoffs`, () => [handoff]],
      [
        "POST",
        /\/handoffs\/handoff-1\/complete$/,
        ({ body }) =>
          Object.assign(handoff, { status: "completed", resolutionNote: body.resolutionNote }),
      ],
      ...base,
    ],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Complete", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Mark as completed" });
  const note = dialog.getByRole("textbox");
  await waitForFocus(note, "the note has the cursor when the dialog opens");
  await page.keyboard.type("Matched all three; one was a duplicate charge.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.press("ControlOrMeta+Enter");
  const done = await view.waitForWrite((w) => /complete$/.test(w.path), "⌘Enter completed it");
  assert.deepEqual(done.body, { resolutionNote: "Matched all three; one was a duplicate charge." });
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    view.writes.filter((w) => /complete$/.test(w.path)).length,
    1,
    "a second ⌘Enter while saving completes nothing twice",
  );
  assert.equal(view.clicks(), 1, "Complete, type, ⌘Enter");
  await page.close();
});

await app.finish();
