/**
 * Real Chrome coverage for the shorter Home flows, on the real App: a
 * notification written with a bare section path ("/goals") opens inside its
 * own company instead of the first company's Home; an approval or a review
 * notification on Home opens straight into the peek where it is decided; the
 * "Unread notifications" tile and "Bell has history" open the bell; Esc
 * closes the bell and hands focus back; dismissing the last Active decision
 * leaves focus on the page; "Ask a question" on a TLDR puts the cursor in the
 * box; a Revision or Initiative confirm opens with its note focused and
 * ⌘/Ctrl+Enter confirms; an accepted Initiative links to its Routine; and a
 * goal's title opens Edit while "Add sub-goal" starts under its parent. Each
 * flow counts its clicks. Run with `npm run test:clicks-home`.
 */
import assert from "node:assert/strict";
import type {
  Company,
  Decision,
  Goal,
  HomeApproval,
  HomeData,
  HomeTodo,
  Initiative,
  Notification,
  Project,
  RevisionProposal,
  TldrItem,
  Todo,
} from "../client/lib/api";
import {
  API,
  COMPANY,
  ME,
  NOW,
  focused,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Fewer clicks — Home");

// ───────────────────────────── fixtures ─────────────────────────────

const ALEX = { id: "alex", name: "Alex Rivera", slug: "alex", role: "Engineer", avatarKey: null };

function homeData(changes: Partial<HomeData> = {}): HomeData {
  const data: HomeData = {
    repositoryWork: [],
    repositoryWorkCount: 0,
    notifications: [],
    unreadNotificationCount: 0,
    decisions: [],
    pendingDecisionCount: 0,
    myTodos: [],
    myTodoCount: 0,
    reviewTodos: [],
    reviewTodoCount: 0,
    approvals: [],
    pendingApprovalCount: 0,
    draftEmailCount: 0,
    draftEmails: [],
    draftEmailAccounts: [],
    starredEmailCount: 0,
    starredEmailAccounts: [],
    unreadChannels: [],
    failedRuns: [],
    failedRunCount: 0,
    tldrs: [],
    unreadTldrCount: 0,
    systemHealth: { status: "ok", issueCount: 0, checks: [] },
    counts: { employees: 1, projects: 1 },
    ...changes,
  };
  data.unreadNotificationCount = changes.unreadNotificationCount ?? data.notifications.length;
  return data;
}

function notification(id: string, changes: Partial<Notification> = {}): Notification {
  return {
    id,
    kind: "goal_achieved",
    title: "Signups reached its target",
    body: "The Signups goal hit 1,000.",
    link: "/goals",
    actor: null,
    entityKind: "goal",
    entityId: "goal-signups",
    readAt: null,
    createdAt: hoursAgo(1),
    ...changes,
  };
}

const baseRoutes: ApiRoute[] = [
  ["GET", `${API}/employees`, () => []],
  ["GET", `${API}/members`, () => []],
  [
    "GET",
    `${API}/work-timeline`,
    () => ({
      since: hoursAgo(24),
      until: NOW.toISOString(),
      employeeId: null,
      entries: [],
      entryCount: 0,
      employeeSummaries: [],
    }),
  ],
  ["POST", `${API}/notifications/mark-read`, () => ({ ok: true })],
  [
    "GET",
    `${API}/onboarding-status`,
    () => ({
      complete: true,
      employee: null,
      modelConnected: true,
      routineCount: 1,
      scheduledRoutineCount: 1,
      nextRunAt: null,
      skillCount: 0,
      mailGranted: false,
      mailAccessLevel: null,
      nextStep: "done",
    }),
  ],
];

function homeRoutes(data: () => HomeData, extra: ApiRoute[] = []): ApiRoute[] {
  return [...extra, ["GET", `${API}/home`, () => data()], ...baseRoutes];
}

// ─────────────────────────── notifications ───────────────────────────

const GLOBEX: Company = { ...COMPANY, id: "globex", slug: "globex", name: "Globex" };

await app.check(
  "a bell row written as a bare path opens inside its own company, not the first one",
  async () => {
    const view = await app.open({
      path: "/c/acme",
      routes: [
        // Globex is first in the list: the router's catch-all would land there.
        ["GET", "/api/companies", () => [GLOBEX, { ...COMPANY }]],
        ["GET", `${API}/notifications`, () => ({ notifications: [notification("n-goal")] })],
        ["GET", `${API}/notifications/unread-count`, () => ({ count: 1 })],
        ["GET", `${API}/goals`, () => []],
        ...homeRoutes(() => homeData()),
      ],
    });
    const { page } = view;
    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    await view.click(bell);
    await view.click(page.getByRole("button", { name: /Signups reached its target/ }));
    await view.landedOn("/c/acme/goals");
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check(
  "the bell: Esc closes it and hands focus back; its state is announced",
  async () => {
    const view = await app.open({
      path: "/c/acme",
      routes: [
        ["GET", `${API}/notifications`, () => ({ notifications: [notification("n-goal")] })],
        ...homeRoutes(() => homeData()),
      ],
    });
    const { page } = view;
    const bell = page.getByRole("button", { name: "Notifications", exact: true });
    assert.equal(await bell.getAttribute("aria-expanded"), "false");
    await view.click(bell);
    assert.equal(await bell.getAttribute("aria-expanded"), "true");
    const panel = page.getByRole("region", { name: "Notifications" });
    await panel.waitFor();
    assert.equal(await bell.getAttribute("aria-controls"), await panel.getAttribute("id"));
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    assert.equal(await bell.getAttribute("aria-expanded"), "false");
    await waitForFocus(bell, "focus returns to the bell");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Home: the Unread notifications tile and Bell has history open the bell, focus on its first row",
  async () => {
    const view = await app.open({
      path: "/c/acme",
      routes: [
        ["GET", `${API}/notifications`, () => ({ notifications: [notification("n-goal")] })],
        ...homeRoutes(() => homeData({ notifications: [notification("n-goal")] })),
      ],
    });
    const { page } = view;
    const tile = page.getByRole("link", { name: /Unread notifications/ });
    await view.click(tile);
    const firstRow = page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Signups reached its target/ });
    await waitForFocus(firstRow, "the first notification has focus");
    assert.equal(await view.location(), "/c/acme", "still on Home");
    await page.keyboard.press("Escape");
    await view.click(page.getByRole("link", { name: "Bell has history" }));
    await waitForFocus(firstRow, "Bell has history opens it the same way");
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check(
  "Home: a notification's link, even an old bare one, stays in the company",
  async () => {
    const view = await app.open({
      path: "/c/acme",
      routes: homeRoutes(() => homeData({ notifications: [notification("n-goal")] })),
    });
    const row = view.page.getByRole("link", { name: /Signups reached its target/ });
    assert.equal(await row.getAttribute("href"), "/c/acme/goals");
    await view.page.close();
  },
);

const APPROVAL: HomeApproval = {
  id: "approval-refund",
  kind: "routine",
  title: "Refund order #1042",
  summary: "Refund $40 to Priya Shah for the duplicate charge.",
  review: null,
  requestedAt: hoursAgo(2),
  employee: { id: "alex", name: "Alex Rivera", slug: "alex" },
  routine: { id: "routine-refunds", name: "Refunds", slug: "refunds" },
};

await app.check(
  "Home: an approval notification opens straight into its decision — Approve is one click away",
  async () => {
    const bell = notification("n-approval", {
      kind: "approval_pending",
      title: "Alex Rivera requested approval: Refund order #1042",
      link: "/c/acme/approvals",
      entityKind: "approval",
      entityId: APPROVAL.id,
    });
    const view = await app.open({
      path: "/c/acme",
      routes: homeRoutes(() =>
        homeData({ notifications: [bell], approvals: [APPROVAL], pendingApprovalCount: 1 }),
      ),
    });
    const { page } = view;
    await view.click(page.getByRole("link", { name: /requested approval: Refund order/ }));
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Approve" }).waitFor();
    await dialog.getByRole("button", { name: "Reject" }).waitFor();
    await view.waitForWrite((w) => w.path === `${API}/notifications/mark-read`);
    assert.equal(
      view.writes.filter((w) => w.path.includes("/approvals/")).length,
      0,
      "opening decides nothing",
    );
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

const LAUNCH = {
  id: "p-launch",
  companyId: "company",
  name: "Launch",
  slug: "launch",
  description: "",
  key: "LAU",
  accessMode: "open",
  createdById: ME.id,
  todoCounter: 1,
  createdAt: hoursAgo(300),
  myAccessLevel: "write",
  totalTodos: 1,
  openTodos: 1,
  reviewTodos: 1,
} as Project;

const REVIEW_TODO: Todo = {
  id: "todo-post",
  projectId: LAUNCH.id,
  number: 1,
  title: "Write the launch post",
  description: "",
  status: "in_review",
  priority: "none",
  assigneeEmployeeId: "alex",
  assigneeUserId: null,
  reviewerEmployeeId: null,
  reviewerUserId: ME.id,
  createdById: ME.id,
  dueAt: null,
  sortOrder: 1,
  completedAt: null,
  recurrence: "none",
  recurrenceParentId: null,
  parentTodoId: null,
  createdAt: hoursAgo(30),
  updatedAt: hoursAgo(2),
  assignee: { kind: "ai", id: "alex", name: "Alex Rivera", slug: "alex", role: "Engineer" },
  reviewer: null,
} as Todo;

await app.check(
  "Home: a review notification opens the review itself — Approve & mark done",
  async () => {
    const home: HomeTodo = {
      id: REVIEW_TODO.id,
      number: 1,
      title: REVIEW_TODO.title,
      status: "in_review",
      priority: "none",
      dueAt: null,
      parentTodoId: null,
      project: { id: LAUNCH.id, key: LAUNCH.key, name: LAUNCH.name, slug: LAUNCH.slug },
    };
    const bell = notification("n-review", {
      kind: "todo_review_requested",
      title: "Alex Rivera requested your review on LAU-1",
      body: REVIEW_TODO.title,
      link: `/c/acme/tasks/p/launch?todo=${REVIEW_TODO.id}`,
      entityKind: "todo",
      entityId: REVIEW_TODO.id,
    });
    const view = await app.open({
      path: "/c/acme",
      routes: homeRoutes(
        () => homeData({ notifications: [bell], reviewTodos: [home], reviewTodoCount: 1 }),
        [
          [
            "GET",
            `${API}/projects/launch/todos`,
            () => ({ project: LAUNCH, todos: [REVIEW_TODO] }),
          ],
          ["GET", /\/todos\/[^/]+\/comments$/, () => []],
        ],
      ),
    });
    const { page } = view;
    await view.click(page.getByRole("link", { name: /requested your review on LAU-1/ }));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Approve & mark done/ })
      .first()
      .waitFor();
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Home at phone width: the bell opens over the page with no sideways scroll",
  async () => {
    const view = await app.open({
      path: "/c/acme",
      routes: [
        ["GET", `${API}/notifications`, () => ({ notifications: [notification("n-goal")] })],
        ...homeRoutes(() => homeData({ notifications: [notification("n-goal")] })),
      ],
      touch: true,
      width: 375,
      height: 812,
    });
    const { page } = view;
    await page.getByRole("link", { name: /Signups reached its target/ }).waitFor();
    await noSidewaysScroll(page, "Home at 375px");
    await view.click(page.getByRole("button", { name: "Notifications", exact: true }));
    await page.getByRole("region", { name: "Notifications" }).waitFor();
    await noSidewaysScroll(page, "the open bell at 375px");
    await page.close();
  },
);

// ─────────────────────────── Active decisions ───────────────────────────

function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: "decision",
    companyId: "company",
    title: "Which retention commitment needs attention?",
    body: "Confirm the owner and next update.",
    status: "pending",
    urgency: "high",
    options: [{ id: "confirm", label: "Confirm the owner", detail: null, tone: "primary" }],
    createdAt: NOW.toISOString(),
    employee: null,
    source: { kind: "unknown", routine: null, run: null, conversation: null, mailThread: null },
    routineId: null,
    runId: null,
    conversationId: null,
    mailThreadId: null,
    chosenOptionId: null,
    chosenOptionLabel: null,
    note: null,
    decidedAt: null,
    decidedByUserId: null,
    decidedBy: null,
    decidedByEmployee: null,
    routedToEmployee: null,
    pickupStatus: "none",
    pickupSummary: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    snoozedUntil: null,
    expiresAt: null,
    assignee: null,
    ...changes,
  } as Decision;
}

await app.check(
  "Home: dismissing the last Active decision leaves focus on the page, not lost on <body>",
  async () => {
    let pending = [decision()];
    const view = await app.open({
      path: "/c/acme",
      routes: homeRoutes(
        () => homeData({ decisions: pending, pendingDecisionCount: pending.length }),
        [
          [
            "POST",
            `${API}/decisions/decision/dismiss`,
            () => {
              const dismissed = { ...pending[0], status: "dismissed" as const };
              pending = [];
              return dismissed;
            },
          ],
        ],
      ),
    });
    const { page } = view;
    const dismiss = page.getByRole("button", { name: /^Dismiss/ }).first();
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await view.waitForWrite((w) => w.path === `${API}/decisions/decision/dismiss`);
    await page.getByRole("heading", { name: "Active decisions" }).waitFor({ state: "detached" });
    await waitForFocus(page.locator("#main-content"), "focus lands on the main region");
    await page.close();
  },
);

// ───────────────────────────── TLDR ─────────────────────────────

await app.check("TLDR on Home: Ask a question opens with the cursor in the box", async () => {
  const tldr: TldrItem = {
    id: "tldr-1",
    title: "Tuesday briefing",
    summary: "Three customers asked about refunds; the release slipped a day.",
    body: "Three customers asked about refunds; the release slipped a day.",
    periodStart: hoursAgo(24),
    periodEnd: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    sourceStats: { journalEntries: 3, routineRuns: 2, channelMessages: 5, channels: 1 },
    employee: ALEX,
    dismissed: false,
    triggerKind: "schedule",
    questionCount: 0,
  };
  const view = await app.open({
    path: "/c/acme",
    routes: homeRoutes(
      () => homeData({ tldrs: [tldr], unreadTldrCount: 1 }),
      [
        [
          "GET",
          `${API}/tldrs/tldr-1/questions`,
          () => ({
            questions: [],
            canAsk: true,
            canDelegateAutomation: false,
            maxQuestions: 5,
          }),
        ],
      ],
    ),
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: /Ask a question/ }));
  await waitForFocus(
    page.getByRole("textbox", { name: /Ask Alex Rivera anything about this briefing/ }),
    "the question box has focus",
  );
  assert.equal(view.clicks(), 1);
  await page.close();
});

// ────────────────────────── Revisions and Initiatives ──────────────────────────

const PROPOSAL: RevisionProposal = {
  id: "proposal-1",
  employeeId: "alex",
  kind: "soul",
  targetId: null,
  targetLabel: "Alex Rivera's Soul",
  baseBody: "Be brief.",
  proposedBody: "Be brief. Link the source for every number.",
  rationale: "Two runs this week quoted numbers without a source.",
  evidenceRunIds: [],
  status: "pending",
  errorMessage: "",
  decidedAt: null,
  decidedByUserId: null,
  reviewNote: "",
  createdAt: hoursAgo(5),
};

const employeeRoute: ApiRoute = [
  "GET",
  `${API}/employees`,
  () => [{ ...ALEX, companyId: "company", model: null, modelCount: 0 }],
];

await app.check(
  "Revisions: Apply opens with the note focused, and ⌘/Ctrl+Enter applies it",
  async () => {
    const view = await app.open({
      path: "/c/acme/revisions",
      routes: [
        employeeRoute,
        ["GET", `${API}/revision-proposals`, () => [PROPOSAL]],
        [
          "POST",
          `${API}/revision-proposals/proposal-1/apply`,
          () => ({ ...PROPOSAL, status: "applied" }),
        ],
        ...baseRoutes,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Review" }).first());
    await view.click(page.getByRole("button", { name: "Apply", exact: true }));
    const group = page.getByRole("group", { name: /Apply this revision\?/ });
    await group.waitFor();
    const note = group.getByLabel("Note (optional)");
    await waitForFocus(note, "the note has focus");
    await page.keyboard.type("Good catch — keep the sources.");
    await page.keyboard.press("ControlOrMeta+Enter");
    const write = await view.waitForWrite(
      (w) => w.path === `${API}/revision-proposals/proposal-1/apply`,
    );
    assert.deepEqual(write.body, { note: "Good catch — keep the sources." });
    assert.equal(view.clicks(), 2, "Review, Apply — then the keyboard");
    await page.close();
  },
);

const INITIATIVE: Initiative = {
  id: "initiative-1",
  employeeId: "alex",
  title: "Weekly churn digest",
  evidence: "Three churned accounts this month went unnoticed for a week.",
  proposal: "Send a Monday digest of accounts that went quiet.",
  routineSpec: {
    name: "Churn digest",
    cronExpr: "0 9 * * 1",
    body: "List accounts with no activity in 14 days.",
  },
  status: "pending",
  decidedByUserId: null,
  decidedAt: null,
  reviewNote: "",
  createdRoutineId: null,
  createdAt: hoursAgo(6),
};

await app.check(
  "Initiatives: Accept opens with the note focused; ⌘/Ctrl+Enter accepts; the Routine is a click away",
  async () => {
    let current = INITIATIVE;
    const view = await app.open({
      path: "/c/acme/initiatives",
      routes: [
        employeeRoute,
        ["GET", `${API}/initiatives`, () => [current]],
        [
          "POST",
          `${API}/initiatives/initiative-1/accept`,
          () => {
            current = {
              ...INITIATIVE,
              status: "accepted",
              decidedAt: NOW.toISOString(),
              decidedByUserId: ME.id,
              createdRoutineId: "routine-churn",
            };
            return current;
          },
        ],
        ...baseRoutes,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Accept", exact: true }));
    const note = page
      .getByRole("group", { name: /Accept this initiative\?/ })
      .getByLabel("Note (optional)");
    await waitForFocus(note, "the note has focus");
    await page.keyboard.press("ControlOrMeta+Enter");
    await view.waitForWrite((w) => w.path === `${API}/initiatives/initiative-1/accept`);
    const routine = page.getByRole("link", { name: "Open the Routine" });
    await routine.waitFor();
    assert.equal(await routine.getAttribute("href"), "/c/acme/routines?routine=routine-churn");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Revisions on a phone: Apply does not raise the keyboard over the confirm",
  async () => {
    const view = await app.open({
      path: "/c/acme/revisions",
      routes: [
        employeeRoute,
        ["GET", `${API}/revision-proposals`, () => [PROPOSAL]],
        ...baseRoutes,
      ],
      touch: true,
      width: 375,
      height: 812,
    });
    const { page } = view;
    await page.getByRole("button", { name: "Review" }).first().click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByRole("group", { name: /Apply this revision\?/ }).waitFor();
    await page.waitForTimeout(200);
    assert.notEqual(
      await focused(page),
      "textarea:Note (optional)",
      "no keyboard pops up on touch",
    );
    await noSidewaysScroll(page, "Revisions at 375px");
    await page.close();
  },
);

// ───────────────────────────── Goals ─────────────────────────────

function goal(id: string, title: string, changes: Partial<Goal> = {}): Goal {
  return {
    id,
    slug: id,
    title,
    description: "",
    parentGoalId: null,
    ownerEmployeeId: null,
    metricKind: "manual",
    chartId: null,
    startValue: 0,
    targetValue: 1000,
    currentValue: 400,
    currentValueUpdatedAt: hoursAgo(5),
    direction: "increase_to",
    unit: "",
    dueAt: null,
    status: "active",
    settledAt: null,
    createdAt: hoursAgo(100),
    progress: 0.4,
    met: false,
    ...changes,
  };
}

await app.check(
  "Goals: the title opens Edit; Add sub-goal starts a goal under its parent",
  async () => {
    const view = await app.open({
      path: "/c/acme/goals",
      routes: [
        ["GET", `${API}/goals`, () => [goal("goal-signups", "Signups")]],
        ["GET", /\/explore\/charts/, () => []],
        ...baseRoutes,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Edit Signups" }));
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByLabel("Title", { exact: true }).inputValue(), "Signups");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await view.click(page.getByRole("button", { name: "Actions for Signups" }));
    await view.click(page.getByRole("menuitem", { name: "Add sub-goal" }));
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="dialog"] select')].some(
        (select) => (select as HTMLSelectElement).value === "goal-signups",
      ),
    );
    assert.equal(
      await page.getByRole("dialog").getByLabel("Title", { exact: true }).inputValue(),
      "",
    );
    assert.equal(view.clicks(), 3);
    await page.close();
  },
);

await app.finish();
