/**
 * Real Chrome coverage for the shorter Tasks, Notes, Repositories and
 * Resources flows, on the real App: a todo has a URL (`?todo=`), so the
 * Review queue opens the todo itself; approving from the side panel closes
 * it and returns focus to the row, pushing back puts the cursor in the
 * comment box; a new project lands ready for its first todo; the board's `c`
 * no longer swallows `G` `C`; List/Board is remembered (never Board on a
 * phone); Enter in the project filter and in Notes' Quick find opens the top
 * match; a new note page arrives with its title selected and Enter moves to
 * the body; the sidebar's + is reachable from the keyboard; a work-session
 * starter selects the part to fill in; and Enter adds a URL resource. Each
 * flow counts its clicks. Run with `npm run test:clicks-tasks`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { Note, Notebook, Project, Resource, ReviewItem, Todo } from "../client/lib/api";
import {
  API,
  ME,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Fewer clicks — Tasks, Notes, Repositories and Resources");

// ───────────────────────────── Tasks fixtures ─────────────────────────────

function project(slug: string, name: string, key: string): Project {
  return {
    id: `p-${slug}`,
    companyId: "company",
    name,
    slug,
    description: "",
    key,
    accessMode: "open",
    createdById: ME.id,
    todoCounter: 3,
    createdAt: hoursAgo(300),
    myAccessLevel: "write",
    totalTodos: 3,
    openTodos: 2,
    reviewTodos: 1,
  } as Project;
}

function todo(p: Project, n: number, title: string, changes: Partial<Todo> = {}): Todo {
  return {
    id: `${p.slug}-t${n}`,
    projectId: p.id,
    number: n,
    title,
    description: "",
    status: "todo",
    priority: "none",
    assigneeEmployeeId: null,
    assigneeUserId: null,
    reviewerEmployeeId: null,
    reviewerUserId: null,
    createdById: ME.id,
    dueAt: null,
    sortOrder: n,
    completedAt: null,
    recurrence: "none",
    recurrenceParentId: null,
    parentTodoId: null,
    createdAt: hoursAgo(50 - n),
    updatedAt: hoursAgo(10 - n),
    assignee: null,
    reviewer: null,
    ...changes,
  };
}

type TaskStore = { projects: Project[]; todos: Todo[] };

function taskStore(): TaskStore {
  const eng = project("engineering", "Engineering", "ENG");
  const ops = project("operations", "Operations", "OPS");
  return {
    projects: [eng, ops],
    todos: [
      todo(eng, 1, "Fix the checkout bug"),
      todo(eng, 2, "Write the release notes", {
        status: "in_review",
        assigneeEmployeeId: "alex",
        assignee: { kind: "ai", id: "alex", name: "Alex Rivera", slug: "alex", role: "Engineer" },
      }),
      todo(eng, 3, "Plan the Q4 roadmap"),
      todo(ops, 1, "Renew the office lease"),
    ],
  };
}

function taskRoutes(s: TaskStore): ApiRoute[] {
  const projectOf = (slug: string) => s.projects.find((p) => p.slug === slug);
  return [
    ["GET", `${API}/projects`, () => s.projects],
    [
      "GET",
      /^\/api\/companies\/company\/projects\/([^/]+)\/todos$/,
      ({ match }) => {
        const p = projectOf(match[1])!;
        return { project: p, todos: s.todos.filter((t) => t.projectId === p.id) };
      },
    ],
    [
      "GET",
      `${API}/reviews`,
      () => ({
        todos: s.todos
          .filter((t) => t.status === "in_review")
          .map((t): ReviewItem => {
            const p = s.projects.find((row) => row.id === t.projectId)!;
            return { ...t, project: { id: p.id, key: p.key, name: p.name, slug: p.slug } };
          }),
      }),
    ],
    ["GET", /^\/api\/companies\/company\/todos\/([^/]+)\/comments$/, () => []],
    [
      "PATCH",
      /^\/api\/companies\/company\/todos\/([^/]+)$/,
      ({ match, body }) => {
        const t = s.todos.find((row) => row.id === match[1])!;
        Object.assign(t, body);
        return t;
      },
    ],
    [
      "POST",
      `${API}/projects`,
      ({ body }) => {
        const p = project(
          String(body.name).toLowerCase(),
          String(body.name),
          String(body.key || "NEW"),
        );
        p.reviewTodos = 0;
        s.projects.push(p);
        return p;
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/projects\/([^/]+)\/todos$/,
      ({ match, body }) => {
        const p = projectOf(match[1])!;
        const created = todo(p, s.todos.length + 10, String(body.title));
        s.todos.push(created);
        return created;
      },
    ],
    ["GET", `${API}/employees`, () => []],
    ["GET", `${API}/members`, () => []],
  ];
}

const todoRow = (page: Page, title: string) => page.locator("li").filter({ hasText: title });
const sidePanel = (page: Page) => page.locator("aside").filter({ hasText: "Created" });

// ───────────────────────────── Tasks ─────────────────────────────

await app.check("Review queue → the todo itself opens beside its board, in one click", async () => {
  const s = taskStore();
  const view = await app.open({ path: "/c/acme/tasks/review", routes: taskRoutes(s) });
  const { page } = view;
  await page.getByText("Write the release notes").first().waitFor();
  await view.click(page.getByRole("button", { name: /Open in project/ }));
  await view.landedOn("/c/acme/tasks/p/engineering");
  await sidePanel(page).getByText("ENG-2").waitFor();
  assert.equal(
    await sidePanel(page).locator('input[placeholder="Task title"]').inputValue(),
    "Write the release notes",
  );
  assert.equal(view.clicks(), 1, "no hunting for the row on the board");
  await page.close();
});

await app.check(
  "approving from the side panel closes it and returns focus to the todo's row",
  async () => {
    const s = taskStore();
    const view = await app.open({ path: "/c/acme/tasks/p/engineering", routes: taskRoutes(s) });
    const { page } = view;
    await view.click(
      todoRow(page, "Write the release notes").getByRole("button", {
        name: "Write the release notes",
      }),
    );
    await sidePanel(page).getByText("Under review").waitFor();
    await view.click(sidePanel(page).getByRole("button", { name: /Approve & mark done/ }));
    await sidePanel(page).waitFor({ state: "detached" });
    await waitForFocus(
      page.locator('[data-todo-title="engineering-t2"]'),
      "focus is back on the todo's row",
    );
    assert.deepEqual(
      view.writes.map((w) => w.body),
      [{ status: "done" }],
    );
    assert.equal(view.clicks(), 2, "open + approve; no Close click");
    await page.close();
  },
);

await app.check("pushing back puts the cursor in the comment box for the reason", async () => {
  const s = taskStore();
  const view = await app.open({
    path: "/c/acme/tasks/p/engineering?todo=engineering-t2",
    routes: taskRoutes(s),
  });
  const { page } = view;
  await sidePanel(page).getByText("Under review").waitFor();
  await view.click(sidePanel(page).getByRole("button", { name: /Push back to AI/ }));
  await waitForFocus(page.locator("#todo-comment-engineering-t2"), "the comment box has focus");
  assert.deepEqual(
    view.writes.map((w) => w.body),
    [{ status: "in_progress" }],
  );
  await sidePanel(page).getByText("ENG-2").waitFor();
  // The param did its job and left the URL.
  assert.equal(await view.location(), "/c/acme/tasks/p/engineering");
  await page.close();
});

await app.check(
  "a new project: name typed straight away, Enter, and the first todo box is ready",
  async () => {
    const s = taskStore();
    const view = await app.open({ path: "/c/acme/tasks", routes: taskRoutes(s) });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "New project", exact: true }).first());
    await waitForFocus(page.getByLabel("Name", { exact: true }), "Name has focus");
    await page.keyboard.type("Launch");
    await page.keyboard.press("Enter");
    await view.landedOn("/c/acme/tasks/p/launch");
    const add = page.getByPlaceholder("Add a todo… (c)");
    await waitForFocus(add, "the add-todo box has focus on arrival");
    await page.keyboard.type("Book the venue");
    await page.keyboard.press("Enter");
    await todoRow(page, "Book the venue").first().waitFor();
    assert.equal(view.clicks(), 1, "one click, the rest is typing");
    // The arrival state is spent: a reload does not grab focus again.
    assert.equal(await view.location(), "/c/acme/tasks/p/launch");
    await page.close();
  },
);

await app.check("on a project page, G then C still goes to Repositories", async () => {
  const s = taskStore();
  const view = await app.open({
    path: "/c/acme/tasks/p/engineering",
    routes: [...taskRoutes(s), ["GET", `${API}/repositories`, () => []]],
  });
  const { page } = view;
  await todoRow(page, "Fix the checkout bug").first().waitFor();
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  await view.landedOn(/^\/c\/acme\/repositories/);
  await page.close();
});

await app.check("c still focuses the add-todo box, and Esc closes the panel", async () => {
  const s = taskStore();
  const view = await app.open({
    path: "/c/acme/tasks/p/engineering?todo=engineering-t1",
    routes: taskRoutes(s),
  });
  const { page } = view;
  await sidePanel(page).getByText("ENG-1").waitFor();
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("Escape");
  await sidePanel(page).waitFor({ state: "detached" });
  await page.keyboard.press("c");
  await waitForFocus(page.getByPlaceholder("Add a todo… (c)"));
  await page.close();
});

await app.check(
  "List or Board is remembered between visits, but a phone always gets the list",
  async () => {
    const s = taskStore();
    const view = await app.open({ path: "/c/acme/tasks/p/engineering", routes: taskRoutes(s) });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Board/ }).first());
    await page.getByText("In review", { exact: false }).first().waitFor();
    await page.reload();
    await page.getByRole("button", { name: /Board/ }).first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("genosyn.tasks.view")), "board");
    await page.waitForFunction(() => document.querySelectorAll("[data-todo-title]").length === 0);
    await page.close();
    const phone = await app.open({
      path: "/c/acme/tasks/p/engineering",
      routes: taskRoutes(taskStore()),
      touch: true,
      storage: { "genosyn.tasks.view": "board" },
    });
    await phone.page.locator("[data-todo-title]").first().waitFor();
    await noSidewaysScroll(phone.page, "a project on a phone");
    await phone.page.close();
  },
);

await app.check("Enter in the project filter opens the top match", async () => {
  const s = taskStore();
  for (const name of ["Design", "Finance", "Support"]) {
    s.projects.push(project(name.toLowerCase(), name, name.slice(0, 3).toUpperCase()));
  }
  const view = await app.open({ path: "/c/acme/tasks", routes: taskRoutes(s) });
  const { page } = view;
  const filter = page.getByRole("textbox", { name: "Filter projects" });
  await filter.fill("oper");
  await filter.press("Enter");
  await view.landedOn("/c/acme/tasks/p/operations");
  await page.close();
});

// ───────────────────────────── Notes ─────────────────────────────

function notebook(slug: string, title: string, noteCount: number): Notebook {
  return {
    id: `nb-${slug}`,
    companyId: "company",
    title,
    slug,
    icon: "",
    sortOrder: 0,
    createdById: ME.id,
    createdByEmployeeId: null,
    createdAt: hoursAgo(400),
    updatedAt: hoursAgo(10),
    noteCount,
    archivedCount: 0,
  };
}

function note(nb: Notebook, slug: string, title: string, body = ""): Note {
  return {
    id: `note-${slug}`,
    companyId: "company",
    notebookId: nb.id,
    title,
    slug,
    body,
    icon: "",
    parentId: null,
    sortOrder: 0,
    createdById: ME.id,
    createdByEmployeeId: null,
    lastEditedById: ME.id,
    lastEditedByEmployeeId: null,
    archivedAt: null,
    createdAt: hoursAgo(20),
    updatedAt: hoursAgo(2),
    createdBy: null,
    lastEditedBy: null,
  };
}

function noteRoutes() {
  const handbook = notebook("handbook", "Handbook", 2);
  const notes = [
    note(handbook, "onboarding", "Onboarding checklist", "Day one: laptop and accounts."),
    note(handbook, "expenses", "Expense policy", "Receipts within 30 days."),
  ];
  const routes: ApiRoute[] = [
    ["GET", `${API}/notebooks`, () => [handbook]],
    ["GET", `${API}/notes`, () => notes],
    [
      "GET",
      /^\/api\/companies\/company\/notes\/([^/]+)$/,
      ({ match }) => notes.find((n) => n.slug === match[1]),
    ],
    [
      "POST",
      `${API}/notes`,
      ({ body }) => {
        const created = note(handbook, `untitled-${notes.length}`, String(body.title));
        notes.push(created);
        return created;
      },
    ],
    [
      "PATCH",
      /^\/api\/companies\/company\/notes\/([^/]+)$/,
      ({ match, body }) => {
        const row = notes.find((n) => n.slug === match[1])!;
        Object.assign(row, body);
        return row;
      },
    ],
    ["GET", /^\/api\/companies\/company\/notes\/([^/]+)\/(grants|access)$/, () => []],
    ["GET", /^\/api\/companies\/company\/tags.*/, () => []],
    ["GET", /^\/api\/companies\/company\/resource-tags.*/, () => []],
  ];
  return { routes, notes };
}

await app.check(
  "a new note page arrives with its title selected; type it, Enter, and keep writing",
  async () => {
    const { routes } = noteRoutes();
    const view = await app.open({ path: "/c/acme/notes/handbook", routes });
    const { page } = view;
    await page.getByText("Onboarding checklist").first().waitFor();
    await view.click(page.getByRole("button", { name: "New page in this notebook" }).first());
    const title = page.getByRole("textbox", { name: "Page title" });
    await waitForFocus(title, "the new page's title has focus");
    assert.deepEqual(
      await title.evaluate((el) => {
        const input = el as HTMLInputElement;
        return [input.selectionStart, input.selectionEnd, input.value.length];
      }),
      [0, "Untitled".length, "Untitled".length],
      "the whole placeholder title is selected",
    );
    await page.keyboard.type("Travel policy");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute("contenteditable") === "true",
    );
    assert.equal(await title.inputValue(), "Travel policy");
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check("Quick find: type and press Enter to open the best match", async () => {
  const { routes } = noteRoutes();
  const view = await app.open({ path: "/c/acme/notes/handbook", routes });
  const { page } = view;
  const find = page.getByRole("textbox", { name: "Quick find" });
  await find.fill("expense");
  await find.press("Enter");
  await view.landedOn("/c/acme/notes/handbook/expenses");
  await page.getByRole("textbox", { name: "Page title" }).waitFor();
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check("the sidebar's + is reachable from the keyboard and shown on touch", async () => {
  const { routes } = noteRoutes();
  const view = await app.open({ path: "/c/acme/notes/handbook", routes });
  const add = view.page.getByRole("button", { name: "New page in this notebook" }).first();
  // Hidden from the eye until hovered, but always in the tab order.
  assert.equal(await add.evaluate((el) => getComputedStyle(el).opacity), "0");
  await add.focus();
  await waitForFocus(add);
  assert.equal(await add.evaluate((el) => getComputedStyle(el).opacity), "1");
  await view.page.close();
  // A touch screen has no hover to reveal it, so it is simply shown.
  const tablet = await app.open({
    path: "/c/acme/notes/handbook",
    routes: noteRoutes().routes,
    touch: true,
    width: 1024,
    height: 768,
  });
  const touchAdd = tablet.page.getByRole("button", { name: "New page in this notebook" }).first();
  await touchAdd.waitFor({ state: "attached" });
  assert.equal(await touchAdd.evaluate((el) => getComputedStyle(el).opacity), "1");
  await tablet.page.close();
});

// ───────────────────────────── Repositories & Resources ─────────────────────────────

await app.check(
  "a work-session starter puts the cursor in the brief with the part to fill in selected",
  async () => {
    const repository = {
      id: "repo-1",
      companyId: "company",
      name: "Storefront",
      slug: "storefront",
      kind: "code",
      description: "",
      defaultBranch: "main",
      remoteUrl: null,
      status: "ready",
      createdAt: hoursAgo(100),
      updatedAt: hoursAgo(1),
    };
    const routes: ApiRoute[] = [
      ["GET", `${API}/repositories`, () => [repository]],
      ["GET", `${API}/repositories/storefront`, () => repository],
      [
        "GET",
        /^\/api\/companies\/company\/repositories\/storefront\/session-candidates$/,
        () => ({
          employees: [
            {
              id: "alex",
              name: "Alex Rivera",
              slug: "alex",
              avatarKey: null,
              role: "Engineer",
              models: [],
            },
          ],
        }),
      ],
      [
        "GET",
        /^\/api\/companies\/company\/repositories\/storefront\/sessions$/,
        () => ({ sessions: [] }),
      ],
      ["GET", /\/workspace\/status$/, () => ({ branch: "main" })],
    ];
    const view = await app.open({ path: "/c/acme/repositories/storefront/ai", routes });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Fix a bug", exact: true }));
    const brief = page.getByRole("textbox", { name: "Work brief" });
    await waitForFocus(brief);
    await page.keyboard.type("checkout fails with a 10% code");
    assert.match(
      await brief.inputValue(),
      /^Investigate and fix this bug: checkout fails with a 10% code\. Add a regression test/,
    );
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check("Files: ⌘/Ctrl+Enter in the message commits, once", async () => {
  const repository = {
    id: "repo-1",
    companyId: "company",
    name: "Storefront",
    slug: "storefront",
    kind: "code",
    description: "",
    defaultBranch: "main",
    remoteUrl: null,
    status: "ready",
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(1),
  };
  let changes = [{ path: "README.md", fromPath: null, status: "modified", staged: false }];
  const routes: ApiRoute[] = [
    ["GET", `${API}/repositories`, () => [repository]],
    ["GET", `${API}/repositories/storefront`, () => repository],
    ["GET", /\/repositories\/storefront\/workspace\/tree$/, () => ({ entries: [] })],
    [
      "GET",
      /\/repositories\/storefront\/workspace\/status$/,
      () => ({
        branch: "main",
        unborn: false,
        detached: false,
        ahead: 0,
        behind: 0,
        upstream: null,
        changes,
      }),
    ],
    [
      "GET",
      /\/repositories\/storefront\/workspace\/branches$/,
      () => ({ branches: [{ name: "main", current: true, upstream: null }] }),
    ],
    [
      "POST",
      /\/repositories\/storefront\/workspace\/commit$/,
      () => {
        changes = [];
        return { committed: true, sha: "abc1234" };
      },
    ],
  ];
  const view = await app.open({ path: "/c/acme/repositories/storefront/files", routes });
  const { page } = view;
  const message = page.getByRole("textbox", { name: "What changed" });
  await message.waitFor();
  await page.waitForFunction(
    () =>
      !(document.querySelector('textarea[aria-label="What changed"]') as HTMLTextAreaElement)
        ?.disabled,
  );
  // Choosing what goes in stays a deliberate tick.
  await view.click(page.getByRole("checkbox", { name: "Include README.md in the next commit" }));
  await message.fill("Explain the new pricing tiers");
  await message.press("ControlOrMeta+Enter");
  await message.press("ControlOrMeta+Enter");
  await page.waitForFunction(
    () =>
      (document.querySelector('textarea[aria-label="What changed"]') as HTMLTextAreaElement)
        ?.value === "",
  );
  const commits = view.writes.filter((w) => w.path.endsWith("/workspace/commit"));
  assert.equal(commits.length, 1, "a second ⌘Enter while committing does not commit twice");
  assert.equal(commits[0].body.message, "Explain the new pricing tiers");
  assert.equal(view.clicks(), 1, "tick the file, type, ⌘Enter: no Commit click");
  await page.close();
});

await app.check("Add resource: paste a URL and press Enter", async () => {
  const created: Resource = {
    id: "res-1",
    companyId: "company",
    title: "Pricing guide",
    slug: "pricing-guide",
    sourceKind: "url",
    sourceUrl: "https://example.com/pricing",
    sourceFilename: null,
    storageKey: null,
    summary: "How to price a SaaS product.",
    bodyText: "How to price a SaaS product.",
    bodyLength: 28,
    tags: [],
    tagList: [],
    bytes: 2048,
    status: "ready",
    errorMessage: "",
    createdById: ME.id,
    createdByEmployeeId: null,
    createdBy: null,
    createdAt: hoursAgo(0),
    updatedAt: hoursAgo(0),
  };
  const routes: ApiRoute[] = [
    ["GET", `${API}/resources`, () => []],
    ["POST", `${API}/resources`, () => created],
    ["GET", /^\/api\/companies\/company\/resources\/pricing-guide.*/, () => created],
    ["GET", /^\/api\/companies\/company\/tags.*/, () => []],
  ];
  const view = await app.open({ path: "/c/acme/resources", routes });
  const { page } = view;
  // An empty library offers the three ways in directly.
  await view.click(page.getByRole("button", { name: /Paste a URL/ }).first());
  const url = page.getByLabel("URL", { exact: true });
  await waitForFocus(url);
  await page.keyboard.type("https://example.com/pricing");
  await page.keyboard.press("Enter");
  await view.landedOn(/^\/c\/acme\/resources\/pricing-guide/);
  assert.deepEqual(view.writes.find((w) => w.path === `${API}/resources`)?.body, {
    sourceKind: "url",
    url: "https://example.com/pricing",
    tagIds: [],
  });
  assert.equal(view.clicks(), 1, "Paste a URL, paste, Enter: no Add click");
  await page.close();
});

await app.finish();
