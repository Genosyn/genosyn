/**
 * Real Chrome coverage for the shorter AI Employee flows, on the real App:
 * connecting an AI Model starts in the API key field; the Proactive starter
 * and Ask dialogs arrive with the only AI Employee (and the only mailbox)
 * already chosen; Enter renames a Skill; hiring is a role and one button, with the
 * company's AI Model reused, and switching roles replaces the name the last one
 * filled in but never one the Member typed; and
 * ⌘/Ctrl+Enter submits a Journal entry, a Memory and a handoff close-out from
 * their text boxes. Each flow counts its clicks. (Picking a Team saves on the
 * pick; `npm run test:employees-roster` covers that.) Run with
 * `npm run test:clicks-employees`.
 */
import assert from "node:assert/strict";
import type { Employee, EmployeeTemplate } from "../client/lib/api";
import type { ProactiveOverview } from "../shared/proactive";
import {
  API,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

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

// ───────────────────────────── hiring ─────────────────────────────

const HIRE_TEMPLATES: EmployeeTemplate[] = [
  {
    id: "t-sales",
    name: "Ava",
    role: "Sales rep",
    category: "Revenue",
    tagline: "Books meetings",
    skills: ["Qualify a lead", "Follow up"],
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

const AVA: Employee = {
  id: "ava",
  companyId: "company",
  name: "Ava",
  slug: "ava",
  role: "Sales rep",
  avatarKey: null,
  model: null,
  modelCount: 0,
};

/** A connected API-key model, with every field the Model page reads. */
const CONNECTED_MODEL = {
  id: "reused",
  employeeId: "ava",
  provider: "openai",
  model: "gpt-live",
  authMode: "apikey",
  isActive: true,
  connectedAt: "2026-10-09T08:00:00.000Z",
  status: "connected",
  apiKeyMasked: "sk-…••••",
  apiKeyEnv: "OPENAI_API_KEY",
  supportsApiKey: true,
  supportsSubscription: true,
  subscriptionAvailable: false,
  subscriptionUnavailableReason: null,
  subscriptionCredentialKind: null,
  subscriptionShellAvailable: false,
  supportsCustomEndpoint: false,
  customEndpointHost: null,
  customEndpointModelId: null,
  customEndpointHasApiKey: false,
  contextWindow: null,
  contextWindowSource: null,
  contextWindowProbeable: false,
  maxConcurrentRuns: null,
  effectiveMaxConcurrentRuns: null,
  concurrencySource: "unlimited",
};

/** What the launch plan fetches once an employee is hired. */
const LAUNCH_PLAN = {
  context: {
    companyName: "Acme",
    mission: "Answer every customer within the hour.",
    vision: "A company that runs itself and still feels personal.",
    employeeName: "Ava",
    employeeRole: "Sales rep",
  },
  routines: [],
  integrations: [],
};

/** The routes a hire touches after the employee row exists. */
function hireRoutes(options: { reusable: unknown[]; connected?: { value: boolean } }): ApiRoute[] {
  return [
    ["GET", "/api/employee-templates", () => HIRE_TEMPLATES],
    ["POST", `${API}/employees`, ({ body }) => ({ ...AVA, ...body })],
    ["GET", `${API}/employees/ava/models/reusable`, () => options.reusable],
    [
      "POST",
      `${API}/employees/ava/models/reuse`,
      () => {
        if (options.connected) options.connected.value = true;
        return { id: "reused", status: "connected" };
      },
    ],
    [
      "GET",
      `${API}/employees/ava/models`,
      () => (options.connected?.value ? [CONNECTED_MODEL] : []),
    ],
    ["GET", `${API}/employees/ava/onboarding-recommendations`, () => LAUNCH_PLAN],
    ...base,
  ];
}

await app.check(
  "hire: switching role replaces the name the last one filled, never a typed one",
  async () => {
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: hireRoutes({ reusable: [] }),
    });
    const { page } = view;
    const name = page.getByLabel("Name", { exact: true });
    await page.getByRole("button", { name: /Sales rep/ }).click();
    assert.equal(await name.inputValue(), "Ava");
    await page.getByRole("button", { name: /Engineer/ }).click();
    assert.equal(await name.inputValue(), "Sam", "the new role's name follows the pick");
    await name.fill("Morgan");
    await page.getByRole("button", { name: /Sales rep/ }).click();
    assert.equal(await name.inputValue(), "Morgan", "a name the Member typed is kept");
    await page.close();
  },
);

await app.check(
  "hire: the first screen leads with six roles, keeps the rest under More roles, and fits a phone",
  async () => {
    const roles = [
      ["executive-assistant", "Avery", "Executive Assistant"],
      ["sdr", "Sam", "Sales Development Rep"],
      ["support", "Pax", "Customer Support Specialist"],
      ["research-analyst", "Sage", "Research Analyst"],
      ["operations", "Remy", "Operations Coordinator"],
      ["engineer", "Ivy", "Software Engineer"],
      ["marketing", "Juno", "Marketing Manager"],
      ["data-analyst", "Nova", "Data Analyst"],
    ].map(([id, name, role]) => ({
      id,
      name,
      role,
      category: "Any",
      tagline: `${role} tagline`,
      skills: ["One", "Two"],
      routines: [],
    })) as EmployeeTemplate[];
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: [["GET", "/api/employee-templates", () => roles], ...base],
    });
    const { page } = view;
    // The app shell has toggles of its own; the role cards are the ones inside the form.
    const cards = page.locator("form button[aria-pressed]");
    await page.getByRole("button", { name: /Executive Assistant/ }).waitFor();
    assert.equal(await cards.count(), 6, "six roles lead");
    assert.equal(await page.getByRole("button", { name: /Marketing Manager/ }).count(), 0);
    // Nothing is chosen for them: Hire waits for a role and a name.
    assert.equal(await page.getByRole("button", { name: "Hire", exact: true }).isDisabled(), true);
    await app.shot(page, "hire-first-screen");
    await page.getByRole("button", { name: "More roles", exact: true }).click();
    assert.equal(await cards.count(), 8);
    await page.getByRole("button", { name: /Marketing Manager/ }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Juno");
    assert.equal(await page.getByLabel("Role", { exact: true }).inputValue(), "Marketing Manager");
    await page.getByText("Comes with a written Soul and 2 Skills", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Hire Juno", exact: true }).waitFor();
    // Typing a different role is a custom role: the picked card lets go.
    await page.getByLabel("Role", { exact: true }).fill("Bookkeeper");
    assert.equal(await page.locator('form button[aria-pressed="true"]').count(), 0);
    await page.close();

    const phone = await app.open({
      path: "/c/acme/employees/new",
      routes: [["GET", "/api/employee-templates", () => roles], ...base],
      width: 390,
      height: 844,
      touch: true,
    });
    await phone.page.getByRole("button", { name: /Executive Assistant/ }).waitFor();
    await noSidewaysScroll(phone.page, "the hire screen on a phone");
    await app.shot(phone.page, "hire-first-screen-phone");
    await phone.page.close();
  },
);

await app.check(
  "hire: a name a teammate already has is caught before Hire, not after",
  async () => {
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: hireRoutes({ reusable: [] }),
    });
    const { page } = view;
    await page.getByLabel("Role", { exact: true }).fill("Analyst");
    await page.getByLabel("Name", { exact: true }).fill("ada lovelace");
    await page
      .getByText("Someone named ada lovelace already works here", { exact: false })
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Hire ada lovelace" }).isDisabled(), true);
    await page.getByLabel("Name", { exact: true }).fill("Grace Hopper");
    assert.equal(await page.getByRole("button", { name: "Hire Grace Hopper" }).isEnabled(), true);
    await page.close();
  },
);

await app.check(
  "hire: pick a role and press Hire — the company's AI Model is reused, and the page says so",
  async () => {
    const offer = {
      id: "source-model",
      employeeId: "ada",
      employeeName: "Ada Lovelace",
      provider: "anthropic",
      model: "claude-sonnet-live",
      authMode: "apikey",
      endpointHost: null,
      isActive: true,
    };
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: hireRoutes({ reusable: [offer] }),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Sales rep/ }));
    await view.click(page.getByRole("button", { name: "Hire Ava", exact: true }));
    await page.getByText("Uses the same AI Model as Ada Lovelace", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Suggested Routines" }).waitFor();
    assert.equal(view.clicks(), 2, "a role and Hire — nothing else to decide");
    const hire = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${API}/employees`,
      "Hire created the employee",
    );
    assert.deepEqual(hire.body, { name: "Ava", role: "Sales rep", templateId: "t-sales" });
    const reuse = await view.waitForWrite(
      (w) => w.path === `${API}/employees/ava/models/reuse`,
      "the company's AI Model was reused",
    );
    assert.deepEqual(reuse.body, { sourceModelId: "source-model" });
    assert.equal(
      await page.getByRole("link", { name: "Settings → Model" }).getAttribute("href"),
      "/c/acme/employees/ava/settings/model",
    );
    assert.equal(
      await page.getByText("Connect an AI Model for Ava", { exact: false }).count(),
      0,
      "no model step when one was reused",
    );
    await page.close();
  },
);

await app.check(
  "hire: with no AI Model to reuse the model step comes next, and going without one is its own choice",
  async () => {
    const connected = { value: false };
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: hireRoutes({ reusable: [], connected }),
    });
    const { page } = view;
    await page.getByRole("button", { name: /Sales rep/ }).click();
    await page.getByRole("button", { name: "Hire Ava", exact: true }).click();
    await page.getByText("Connect an AI Model for Ava", { exact: false }).waitFor();
    assert.equal(
      view.writes.some((w) => w.path.endsWith("/models/reuse")),
      false,
    );
    // Continue means the AI Model is ready: with none, it says so instead of moving on.
    assert.equal(await page.getByRole("button", { name: "Continue without a model" }).count(), 0);
    await page.getByRole("button", { name: "Choose Routines", exact: true }).click();
    await page.getByText("No AI Model is connected yet", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Suggested Routines" }).count(), 0);
    // Going on anyway is a separate, named choice.
    await page.getByRole("button", { name: "Continue without a model", exact: true }).click();
    await page.getByRole("heading", { name: "Suggested Routines" }).waitFor();
    assert.equal(await page.getByText("Uses the same AI Model as", { exact: false }).count(), 0);
    await page.close();
  },
);

await app.check(
  "hire: Continue goes straight on once an AI Model is connected, with the Model page showing it plainly",
  async () => {
    const connected = { value: true };
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: hireRoutes({ reusable: [], connected }),
    });
    const { page } = view;
    await page.getByRole("button", { name: /Sales rep/ }).click();
    await page.getByRole("button", { name: "Hire Ava", exact: true }).click();
    await page.getByText("OpenAI · gpt-live", { exact: true }).waitFor();
    await app.shot(page, "hire-model-step-connected");
    await page.getByRole("button", { name: "Choose Routines", exact: true }).click();
    await page.getByRole("heading", { name: "Suggested Routines" }).waitFor();
    assert.equal(await page.getByText("No AI Model is connected yet").count(), 0);
    await page.close();
  },
);

await app.check(
  "hire: Customize the Soul first creates them and goes to the About questions, with no placeholder links",
  async () => {
    const view = await app.open({
      path: "/c/acme/employees/new",
      routes: [
        ...hireRoutes({
          reusable: [
            {
              id: "source-model",
              employeeId: "ada",
              employeeName: "Ada Lovelace",
              provider: "openai",
              model: "gpt-live",
              authMode: "apikey",
              endpointHost: null,
              isActive: true,
            },
          ],
        }),
        ["GET", `${API}/employees/ava/soul`, () => ({ content: "# Ava's Soul\n" })],
      ],
    });
    const { page } = view;
    await page.getByRole("button", { name: /Sales rep/ }).click();
    await page.getByRole("button", { name: "Customize the Soul first", exact: true }).click();
    await page.getByRole("heading", { name: "A few questions about Ava" }).waitFor();
    // Mission, tone, autonomy, hard no's, then reference material.
    const answers = page.locator("textarea");
    assert.equal(await answers.nth(4).inputValue(), "", "no stand-in links are written for them");
    await answers.nth(0).fill("Book qualified meetings.");
    await page.getByRole("button", { name: "Generate Soul", exact: true }).click();
    await page.getByText("Review Ava's Soul", { exact: false }).waitFor();
    const soul = await page.locator("textarea").first().inputValue();
    assert.match(soul, /Book qualified meetings\./);
    assert.doesNotMatch(soul, /Reference material|notion\.so|linear\.app/);
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
