/**
 * Real Chrome coverage for the columns a person can drag, on the real App: a
 * Todo's side panel and the sidebar, by mouse and by keyboard, plus Ask AI, the
 * panels in chat, and the conversation lists in Chat, Workspace and Help.
 *
 * - The edge stays under the pointer, wherever the column sits in the window.
 * - A column stops where the page beside it would lose its readable column, and
 *   a drag past the stop leaves no dead zone on the way back.
 * - A width is remembered across a reload, another todo and another section.
 * - A wider sidebar, Ask AI or a smaller window squeezes a panel, never the
 *   board, and the panel comes back to its width when there is room again.
 * - A finger can drag an edge on a tablet. A phone has no handles, and a Todo's
 *   panel takes the screen.
 *
 * These read real layout because the limits are CSS: nothing but a browser can
 * say whether they hold. Run with `npm run test:panel-widths`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  ConversationMessage,
  ConversationSummary,
  Employee,
  Project,
  Todo,
} from "../client/lib/api";
import { API, ME, hoursAgo, noSidewaysScroll, startApp, type ApiRoute } from "./appFixture";

const app = await startApp("Columns a person can drag");

// ───────────────────────────── fixtures ─────────────────────────────

const PROJECT = {
  id: "p-engineering",
  companyId: "company",
  name: "Engineering",
  slug: "engineering",
  description: "",
  key: "ENG",
  accessMode: "open",
  createdById: ME.id,
  todoCounter: 3,
  createdAt: hoursAgo(300),
  myAccessLevel: "write",
  totalTodos: 3,
  openTodos: 3,
  reviewTodos: 0,
} as Project;

function todo(number: number, title: string): Todo {
  return {
    id: `t${number}`,
    projectId: PROJECT.id,
    number,
    title,
    description: "",
    status: "in_progress",
    priority: "none",
    assigneeEmployeeId: null,
    assigneeUserId: null,
    reviewerEmployeeId: null,
    reviewerUserId: null,
    createdById: ME.id,
    dueAt: null,
    sortOrder: number,
    completedAt: null,
    recurrence: "none",
    recurrenceParentId: null,
    parentTodoId: null,
    createdAt: hoursAgo(50 - number),
    updatedAt: hoursAgo(10 - number),
    assignee: null,
    reviewer: null,
  };
}

const taskRoutes: ApiRoute[] = [
  ["GET", `${API}/projects`, () => [PROJECT]],
  [
    "GET",
    `${API}/projects/engineering/todos`,
    () => ({
      project: PROJECT,
      todos: [
        todo(1, "Airgapped blogs"),
        todo(2, "Write the release notes"),
        todo(3, "Plan the Q4 roadmap"),
      ],
    }),
  ],
  ["GET", /^\/api\/companies\/company\/todos\/([^/]+)\/comments$/, () => []],
  [
    "GET",
    /^\/api\/companies\/company\/todos\/([^/]+)\/pickups$/,
    () => ({ active: null, recent: [] }),
  ],
  ["GET", `${API}/employees`, () => []],
  ["GET", `${API}/members`, () => []],
  ["GET", `${API}/repositories`, () => []],
];

const BOARD = "/c/acme/tasks/p/engineering";
const TODO = `${BOARD}?todo=t1`;

const ALEX: Employee = {
  id: "alex",
  companyId: "company",
  name: "Alex Rivera",
  slug: "alex",
  role: "Account manager",
  avatarKey: null,
  model: { provider: "anthropic", model: "claude-sonnet", status: "connected" },
  modelCount: 1,
};

const THREAD: ConversationSummary = {
  id: "thread-1",
  employeeId: ALEX.id,
  title: "Launch checklist",
  archivedAt: null,
  createdAt: hoursAgo(5),
  updatedAt: hoursAgo(5),
  lastMessageAt: hoursAgo(5),
  lastModelId: null,
  lastEffort: null,
};

const REPLY: ConversationMessage = {
  id: "thread-1-a",
  conversationId: THREAD.id,
  role: "assistant",
  content: "The work is in [the session](/c/acme/repositories/site/ai/session-1).",
  status: "ok",
  createdAt: hoursAgo(1),
};

const chatRoutes: ApiRoute[] = [
  ["GET", `${API}/employees`, () => [ALEX]],
  ["GET", `${API}/employees/alex`, () => ALEX],
  ["GET", `${API}/employees/alex/conversations`, () => [THREAD]],
  [
    "GET",
    `${API}/employees/alex/conversations/thread-1`,
    () => ({ conversation: THREAD, messages: [REPLY] }),
  ],
  ["GET", `${API}/employees/alex/models`, () => []],
  ["GET", `${API}/repositories`, () => []],
  ["GET", /^\/api\/companies\/company\/member-browsers\/for-employee\/[^/]+$/, () => []],
];

const askAiRoutes: ApiRoute[] = [
  ["GET", `${API}/ask-ai`, () => ({ conversations: [], roster: [] })],
  ["POST", `${API}/ask-ai/context`, () => ({ items: [], defaultEmployeeIds: [], withheld: {} })],
];

const workspaceRoutes: ApiRoute[] = [
  ["GET", `${API}/workspace/channels`, () => []],
  ["GET", `${API}/workspace/mentionables`, () => []],
  ["GET", `${API}/employees`, () => []],
];

const TODO_PANEL_KEY = "genosyn.todoPanel.width";
const SIDEBAR_KEY = "genosyn.sidebar.width";

// ───────────────────────────── helpers ─────────────────────────────

const handle = (page: Page, name: string) => page.getByRole("separator", { name, exact: true });
const sidebarHandle = (page: Page) => handle(page, "Resize the sidebar");
const todoHandle = (page: Page) => handle(page, "Resize the todo panel");
const askHandle = (page: Page) => handle(page, "Resize the Ask AI panel");
const listHandle = (page: Page) => handle(page, "Resize the conversation list");

/** A column's width, read through its handle, which is always its direct child. */
const widthOf = (h: Locator) =>
  h.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0);

/** What the column beside a right-docked panel has been left with. */
const companionWidth = (h: Locator) =>
  h.evaluate((el) => el.parentElement?.previousElementSibling?.getBoundingClientRect().width ?? 0);

/** The room a panel's flex row has, scrollbar excluded. */
const rowWidth = (h: Locator) =>
  h.evaluate((el) => el.parentElement?.parentElement?.clientWidth ?? 0);

/** Wait out a width transition, then require the width, to the pixel it rounds to. */
async function widthIs(h: Locator, expected: number, message?: string) {
  const deadline = Date.now() + 2_000;
  let actual = await widthOf(h);
  while (Math.abs(actual - expected) > 1 && Date.now() < deadline) {
    await h.page().waitForTimeout(25);
    actual = await widthOf(h);
  }
  assert.ok(
    Math.abs(actual - expected) <= 1,
    `${message ?? "column width"}: expected ${expected}, got ${actual}`,
  );
}

/** Press on a handle and move by `dx`, stopping at the window's edge. */
async function drag(page: Page, h: Locator, dx: number) {
  const box = await h.boundingBox();
  assert.ok(box, "the handle is on screen");
  const viewport = page.viewportSize();
  assert.ok(viewport);
  const x = box.x + box.width / 2;
  const y = box.y + 200;
  const to = Math.min(viewport.width - 1, Math.max(1, x + dx));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + to) / 2, y, { steps: 4 });
  await page.mouse.move(to, y, { steps: 4 });
  await page.mouse.up();
}

const stored = (page: Page, key: string) =>
  page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key);

const selectedText = (page: Page) => page.evaluate(() => String(window.getSelection()));

const todoPanel = (page: Page) => page.locator("aside").filter({ hasText: "Created" });

// ───────────────────────────── a Todo's panel ─────────────────────────────

await app.check("a Todo's panel drags wider and narrower, its edge under the pointer", async () => {
  const view = await app.open({ path: TODO, routes: taskRoutes, width: 1440 });
  const { page } = view;
  await todoPanel(page).getByText("ENG-1").waitFor();
  const h = todoHandle(page);
  await widthIs(h, 460, "it opens at the width it always has");

  const before = (await h.boundingBox())!;
  await drag(page, h, -200);
  await widthIs(h, 660);
  const after = (await h.boundingBox())!;
  assert.ok(Math.abs(after.x - (before.x - 200)) <= 1, "the edge moved as far as the pointer");
  await drag(page, h, 100);
  await widthIs(h, 560);

  assert.equal(await selectedText(page), "", "a drag selects no text");
  assert.equal(await stored(page, TODO_PANEL_KEY), "560");
  await app.shot(page, "panel-widths-todo");

  // Remembered on another todo, which mounts a panel of its own…
  await page.getByText("ENG-3").first().click();
  await todoPanel(page).getByText("ENG-3").waitFor();
  await widthIs(todoHandle(page), 560, "another todo");
  // …and after a reload.
  await page.reload();
  await todoHandle(page).waitFor();
  await widthIs(todoHandle(page), 560, "after a reload");
  await page.close();
});

await app.check(
  "the panel stops at its minimum, and where the board would lose its column",
  async () => {
    const view = await app.open({ path: TODO, routes: taskRoutes, width: 1440 });
    const { page } = view;
    const h = todoHandle(page);
    await h.waitFor();

    await drag(page, h, 2000);
    await widthIs(h, 360, "as narrow as it goes");

    await drag(page, h, -2000);
    const widest = (await rowWidth(h)) - 360;
    await widthIs(h, widest, "as wide as it goes");
    assert.ok(Math.abs((await companionWidth(h)) - 360) <= 1, "the board keeps its column");
    assert.equal(
      await stored(page, TODO_PANEL_KEY),
      String(Math.round(await widthOf(h))),
      "what is remembered is where it stopped, not how far the pointer went",
    );

    // No dead zone: the pointer went far past the stop, and the way back starts at once.
    await drag(page, h, 50);
    await widthIs(h, widest - 50, "back from the stop");
    await page.close();
  },
);

await app.check("a panel on a smaller window fits it and forgets nothing", async () => {
  const view = await app.open({
    path: TODO,
    routes: taskRoutes,
    width: 1280,
    storage: { [TODO_PANEL_KEY]: "900" },
  });
  const { page } = view;
  const h = todoHandle(page);
  await h.waitFor();
  await widthIs(h, (await rowWidth(h)) - 360, "a width from a wider monitor fits this one");
  assert.ok(Math.abs((await companionWidth(h)) - 360) <= 1, "the board keeps its column");

  // A press that never moves is not a resize.
  const box = (await h.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal(await stored(page, TODO_PANEL_KEY), "900", "a press changes nothing");
  await page.close();

  const fresh = await app.open({ path: TODO, routes: taskRoutes, width: 1280 });
  await todoHandle(fresh.page).waitFor();
  await widthIs(todoHandle(fresh.page), 460, "no narrower than it was on a laptop");
  await fresh.page.close();
});

// ───────────────────────────── the sidebar ─────────────────────────────

await app.check(
  "the sidebar drags wider and narrower, and keeps its width between sections",
  async () => {
    const view = await app.open({ path: BOARD, routes: taskRoutes, width: 1280 });
    const { page } = view;
    const h = sidebarHandle(page);
    await h.waitFor();
    await widthIs(h, 256, "it opens at the width it always has");

    await drag(page, h, 100);
    await widthIs(h, 356);
    assert.equal(await selectedText(page), "", "a drag selects no text");
    await drag(page, h, -60);
    await widthIs(h, 296);
    assert.equal(await stored(page, SIDEBAR_KEY), "296");
    await app.shot(page, "panel-widths-sidebar");

    // Another section mounts a sidebar of its own, and it must not jump.
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await view.landedOn(/^\/c\/acme\/repositories/);
    await sidebarHandle(page).waitFor();
    await widthIs(sidebarHandle(page), 296, "in another section");

    await page.reload();
    await sidebarHandle(page).waitFor();
    await widthIs(sidebarHandle(page), 296, "after a reload");
    await page.close();
  },
);

await app.check("the sidebar stops at both ends, and leaves a narrow window its page", async () => {
  const view = await app.open({ path: BOARD, routes: taskRoutes, width: 1280 });
  const { page } = view;
  const h = sidebarHandle(page);
  await h.waitFor();
  await drag(page, h, -500);
  await widthIs(h, 200, "as narrow as it goes");
  await drag(page, h, 800);
  await widthIs(h, 480, "as wide as it goes");

  await page.setViewportSize({ width: 800, height: 900 });
  await widthIs(h, 440, "the page keeps 360 on a narrow window");
  await page.setViewportSize({ width: 1280, height: 900 });
  await widthIs(h, 480, "and the width comes back with the room");
  await page.close();
});

await app.check("the keyboard moves the same edges, and shows where it is", async () => {
  const view = await app.open({ path: TODO, routes: taskRoutes, width: 1440 });
  const { page } = view;
  const rail = sidebarHandle(page);
  await rail.waitFor();

  // The handle follows the sidebar's own links, and takes the usual focus mark.
  await page.getByRole("link", { name: "Integrations" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await rail.evaluate((el) => el === document.activeElement), true);
  assert.equal(
    await rail.evaluate((el) => getComputedStyle(el).outlineStyle),
    "solid",
    "keyboard focus is visible",
  );

  await page.keyboard.press("ArrowRight");
  await widthIs(rail, 280, "→ grows a sidebar");
  await page.keyboard.press("Shift+ArrowRight");
  await widthIs(rail, 360, "shift takes bigger steps");
  await page.keyboard.press("ArrowLeft");
  await widthIs(rail, 336, "← shrinks a sidebar");
  assert.equal(await stored(page, SIDEBAR_KEY), "336");

  const panel = todoHandle(page);
  await panel.focus();
  await page.keyboard.press("ArrowLeft");
  await widthIs(panel, 484, "← grows a panel");
  await page.keyboard.press("ArrowRight");
  await widthIs(panel, 460, "→ shrinks a panel");
  await page.keyboard.press("Shift+ArrowLeft");
  await widthIs(panel, 540, "shift takes bigger steps");
  assert.equal(await stored(page, TODO_PANEL_KEY), "540");
  await page.close();
});

await app.check("a panel held narrow answers the first key press", async () => {
  const view = await app.open({
    path: TODO,
    routes: taskRoutes,
    width: 1100,
    storage: { [TODO_PANEL_KEY]: "900" },
  });
  const { page } = view;
  const panel = todoHandle(page);
  await panel.waitFor();
  const held = await widthOf(panel);
  assert.ok(held < 900, "the window is holding it narrower than its width");
  await panel.focus();
  await page.keyboard.press("ArrowRight");
  await widthIs(panel, held - 24, "no dead zone between 900 and what is on screen");
  await page.close();
});

await app.check(
  "a wider sidebar or a smaller window squeezes the panel, never the board, and it comes back",
  async () => {
    const view = await app.open({
      path: TODO,
      routes: taskRoutes,
      width: 1440,
      storage: { [TODO_PANEL_KEY]: "700" },
    });
    const { page } = view;
    const panel = todoHandle(page);
    const rail = sidebarHandle(page);
    await panel.waitFor();
    await widthIs(panel, 700);

    await drag(page, rail, 800);
    await widthIs(rail, 480);
    await widthIs(panel, (await rowWidth(panel)) - 360, "the panel gives way to the sidebar");
    assert.ok(Math.abs((await companionWidth(panel)) - 360) <= 1, "the board keeps its column");
    assert.equal(await stored(page, TODO_PANEL_KEY), "700", "giving way forgets nothing");

    await drag(page, rail, -224);
    await widthIs(rail, 256);
    await widthIs(panel, 700, "the panel comes back");

    await page.setViewportSize({ width: 1100, height: 900 });
    await widthIs(panel, (await rowWidth(panel)) - 360, "the panel gives way to a smaller window");
    await page.setViewportSize({ width: 1440, height: 900 });
    await widthIs(panel, 700, "and comes back with the room");
    await page.close();
  },
);

// ───────────────────────────── Ask AI ─────────────────────────────

await app.check(
  "Ask AI stops where the page keeps its columns, whatever the sidebar's width",
  async () => {
    const view = await app.open({
      path: BOARD,
      routes: [...askAiRoutes, ...taskRoutes],
      width: 1440,
    });
    const { page } = view;
    await page.getByRole("button", { name: /Ask AI/ }).click();
    const ask = askHandle(page);
    const rail = sidebarHandle(page);
    await ask.waitFor();
    await widthIs(ask, 440);

    await drag(page, ask, -2000);
    await widthIs(ask, 568, "1440 - 256 sidebar - 616 for the page");

    await drag(page, rail, -56);
    await widthIs(rail, 200);
    await widthIs(ask, 568, "its own width, which a narrower sidebar leaves alone");
    await drag(page, ask, -2000);
    await widthIs(ask, 624, "a narrower sidebar gives Ask AI more room");

    await drag(page, rail, 800);
    await widthIs(rail, 480);
    await widthIs(ask, 360, "a wide sidebar squeezes it to its minimum, no further");
    await drag(page, rail, -280);
    await widthIs(ask, 624, "and it comes back");
    await page.close();
  },
);

await app.check("with no sidebar on the page, Ask AI has that room too", async () => {
  const view = await app.open({
    path: "/c/acme/workspace",
    routes: [...askAiRoutes, ...workspaceRoutes],
    width: 1440,
  });
  const { page } = view;
  await page.getByRole("button", { name: /Ask AI/ }).click();
  const ask = askHandle(page);
  await ask.waitFor();
  await drag(page, ask, -2000);
  await widthIs(ask, 824, "1440 - 616 for the page");
  await page.close();
});

await app.check("a panel beside Ask AI still follows the pointer exactly", async () => {
  // Its right edge is not the window's: the old drag assumed it was, and jumped.
  const view = await app.open({
    path: TODO,
    routes: [...askAiRoutes, ...taskRoutes],
    width: 1920,
  });
  const { page } = view;
  await page.getByRole("button", { name: /Ask AI/ }).click();
  await askHandle(page).waitFor();
  await widthIs(askHandle(page), 440);
  const h = todoHandle(page);
  await widthIs(h, 460);
  await drag(page, h, -100);
  await widthIs(h, 560);
  await page.close();
});

// ───────────────────────────── Chat, Workspace and Help ─────────────────────────────

await app.check("Chat's conversation list drags, and a work panel leaves room for it", async () => {
  const view = await app.open({
    path: "/c/acme/employees/alex/chat",
    routes: chatRoutes,
    width: 1440,
  });
  const { page } = view;
  const list = listHandle(page);
  await list.waitFor();
  await widthIs(list, 256);
  await drag(page, list, 64);
  await widthIs(list, 320);
  assert.equal(await stored(page, "genosyn.chatRail.width"), "320");

  // With room, the header is the one line it has always been.
  const employeeNav = page.getByRole("navigation", { name: "Employee" });
  const employeeHeader = page.locator("header").filter({ has: employeeNav });
  const oneLine = (await employeeHeader.boundingBox())!.height;
  assert.ok(oneLine < 70, `the header holds one line, at ${oneLine}px`);

  await page.getByRole("link", { name: "the session" }).click();
  const work = handle(page, "Resize repository work panel");
  await work.waitFor();
  await widthIs(work, 520);
  await drag(page, work, -2000);
  await widthIs(work, 760, "1440 - 320 list - 360 for the conversation");
  assert.ok(Math.abs((await companionWidth(work)) - 360) <= 1, "the conversation keeps its column");

  await drag(page, list, 800);
  await widthIs(list, 480);
  await widthIs(work, 600, "1440 - 480 list - 360 for the conversation");
  assert.ok(Math.abs((await companionWidth(work)) - 360) <= 1, "the conversation keeps its column");

  // Squeezed like this on a wide window, the Chat / Settings switch must not be cut off.
  const nav = (await employeeNav.boundingBox())!;
  const headerBox = (await employeeHeader.boundingBox())!;
  assert.ok(
    nav.x + nav.width <= headerBox.x + headerBox.width,
    "the switch stays inside its header",
  );
  await page.getByRole("link", { name: "Settings" }).waitFor();
  await app.shot(page, "panel-widths-chat");
  await page.close();
});

await app.check(
  "Workspace's list drags on a wide window, and takes the phone as before",
  async () => {
    const view = await app.open({
      path: "/c/acme/workspace",
      routes: workspaceRoutes,
      width: 1280,
    });
    const { page } = view;
    const list = listHandle(page);
    await list.waitFor();
    await widthIs(list, 256);
    await drag(page, list, 44);
    await widthIs(list, 300);
    assert.equal(await stored(page, "genosyn.workspaceRail.width"), "300");
    await page.close();

    const phone = await app.open({
      path: "/c/acme/workspace",
      routes: workspaceRoutes,
      touch: true,
    });
    const rail = phone.page.getByRole("complementary", { name: "Workspace conversations" });
    await rail.waitFor();
    assert.equal(await phone.page.getByRole("separator").count(), 0, "nothing to drag on a phone");
    assert.equal((await rail.boundingBox())?.width, 390, "the list takes the screen");
    await noSidewaysScroll(phone.page, "Workspace on a phone");
    await phone.page.close();
  },
);

await app.check("Help's sidebar drags from where it shows", async () => {
  const routes: ApiRoute[] = [
    ["GET", `${API}/employees`, () => [ALEX]],
    ["GET", `${API}/employees/alex/conversations`, () => []],
    ["GET", `${API}/employees/alex/models`, () => []],
  ];
  const view = await app.open({ path: "/c/acme/help", routes, width: 1440 });
  const { page } = view;
  const h = handle(page, "Resize the Help sidebar");
  await h.waitFor();
  await widthIs(h, 288, "it opens at the width it always has");
  await drag(page, h, -48);
  await widthIs(h, 240);
  assert.equal(await stored(page, "genosyn.helpRail.width"), "240");
  await page.close();
});

// ───────────────────────────── a touch screen ─────────────────────────────

await app.check("on a tablet a finger can find the edge and drag it", async () => {
  const view = await app.open({
    path: BOARD,
    routes: taskRoutes,
    touch: true,
    width: 1024,
    height: 768,
  });
  const { page } = view;
  const h = sidebarHandle(page);
  await h.waitFor();
  await widthIs(h, 256);
  const box = (await h.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 200;

  // The visible edge is 8px wide; the part a finger lands on is 32.
  const under = (px: number) =>
    page.evaluate(
      ([atX, atY]) => document.elementFromPoint(atX, atY)?.getAttribute("aria-label") ?? null,
      [px, y],
    );
  assert.equal(await under(x + 14), "Resize the sidebar", "a finger just right of the edge");
  assert.equal(await under(x - 14), "Resize the sidebar", "a finger just left of the edge");

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, atX?: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type: type as "touchStart" | "touchMove" | "touchEnd",
      touchPoints: atX === undefined ? [] : [{ x: atX, y }],
    });
  await touch("touchStart", x);
  await touch("touchMove", x + 40);
  await touch("touchMove", x + 80);
  await touch("touchEnd");
  await widthIs(h, 336, "the rail follows the finger, and the page does not scroll instead");
  assert.equal(await stored(page, SIDEBAR_KEY), "336");
  await page.close();
});

// ───────────────────────────── a phone ─────────────────────────────

await app.check("on a phone a Todo's panel takes the screen, with nothing to drag", async () => {
  const view = await app.open({ path: TODO, routes: taskRoutes, touch: true });
  const { page } = view;
  const panel = todoPanel(page);
  await panel.getByText("ENG-1").waitFor();
  const box = (await panel.boundingBox())!;
  assert.equal(box.x, 0);
  assert.equal(box.width, 390);
  assert.equal(await page.getByRole("separator").count(), 0, "nothing to drag on a phone");
  await noSidewaysScroll(page, "a Todo on a phone");
  await app.shot(page, "panel-widths-todo-phone");

  await panel.getByRole("button", { name: "Close (Esc)" }).click();
  await panel.waitFor({ state: "detached" });
  await page.getByText("Write the release notes").first().waitFor();
  await noSidewaysScroll(page, "the list on a phone");
  await page.close();
});

await app.finish();
