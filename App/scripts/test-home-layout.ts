/**
 * Run with `npm run test:home-layout`; local Chrome or GENOSYN_TEST_BROWSER.
 * Tests the real Home greeting, cards and employee day with deterministic API
 * fixtures. Geometry assertions catch reserved columns and overflow that static
 * rendering cannot. Every unexpected request fails the suite.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Locator, type Page } from "playwright-core";
import type {
  Decision,
  Employee,
  HomeChannel,
  HomeData,
  WorkEntry,
  WorkTimeline,
} from "../client/lib/api";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixtureNow = new Date("2026-09-09T09:00:00.000Z");
const browserErrors: string[] = [];
const unexpectedRequests: string[] = [];
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18481, strictPort: false, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-home-layout"),
  plugins: [
    {
      name: "home-layout-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__home_layout", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__home_layout",
            '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
              `<script type="module" src="/@fs${root}/scripts/homeLayoutHarness.tsx"></script></html>`,
          );
          response.setHeader("Content-Type", "text/html");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen().catch(async (error) => {
  await server.close();
  throw error;
});
const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
const browser = await chromium
  .launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const context = await browser
  .newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "Europe/London",
  })
  .catch(async (error) => {
    await browser.close();
    await server.close();
    throw error;
  });
context.setDefaultTimeout(15000);
const touchContext = await browser.newContext({
  viewport: { width: 390, height: 1000 },
  timezoneId: "Europe/London",
  hasTouch: true,
});
touchContext.setDefaultTimeout(15000);

function roster(count = 1): Employee[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `employee-${index + 1}`,
    slug: `employee-${index + 1}`,
    name: index === 0 ? "Jamie Mallers" : `Employee ${index + 1}`,
    role: "Customer support",
    avatarKey: null,
  })) as Employee[];
}
function channel(id: string, label: string, unreadCount: number): HomeChannel {
  return { id, kind: "channel", label, unreadCount, lastReadAt: null };
}

function homeData(
  employeeCount: number,
  options: { quiet?: boolean; unreadChannels?: HomeChannel[] } = {},
): HomeData {
  const quiet = options.quiet ?? false;
  return {
    repositoryWork: [],
    repositoryWorkCount: 0,
    decisions: quiet
      ? []
      : [
          {
            id: "decision",
            companyId: "company",
            title: "Which retention commitment needs attention?",
            body: "Confirm the owner and next update.",
            status: "pending",
            urgency: "high",
            options: [{ id: "confirm", label: "Confirm the owner", detail: null, tone: "primary" }],
            createdAt: fixtureNow.toISOString(),
            employee: null,
            source: {
              kind: "unknown",
              routine: null,
              run: null,
              conversation: null,
              mailThread: null,
            },
          } as Decision,
        ],
    pendingDecisionCount: quiet ? 0 : 1,
    notifications: [],
    unreadNotificationCount: 0,
    myTodos: quiet
      ? []
      : [
          {
            id: "todo",
            number: 1,
            title: "Review the customer update",
            status: "todo",
            priority: "medium",
            dueAt: null,
            parentTodoId: null,
            project: { id: "project", key: "OPS", name: "Operations", slug: "operations" },
          },
        ],
    myTodoCount: quiet ? 0 : 1,
    reviewTodos: [],
    reviewTodoCount: 0,
    approvals: [],
    pendingApprovalCount: 0,
    unreadChannels: options.unreadChannels ?? (quiet ? [] : [channel("support", "Support", 2)]),
    failedRuns: [],
    failedRunCount: 0,
    tldrs: [],
    unreadTldrCount: 0,
    draftEmails: [],
    draftEmailCount: 0,
    draftEmailAccounts: [],
    starredEmailCount: 0,
    starredEmailAccounts: [],
    systemHealth: { status: "ok", issueCount: 0, checks: [] },
    counts: { employees: employeeCount, projects: 1 },
  };
}
function timeline(employees: Employee[], query: URLSearchParams, working = false): WorkTimeline {
  const since = query.get("since") ?? new Date(fixtureNow.getTime() - 86400000).toISOString();
  const until = query.get("until") ?? fixtureNow.toISOString();
  const employeeId = query.get("employeeId");
  const latest = employees[0]
    ? ({
        id: "chat:work",
        kind: "chat",
        at: new Date(fixtureNow.getTime() - 19 * 60000).toISOString(),
        endedAt: working ? null : fixtureNow.toISOString(),
        active: working,
        employee: employees[0],
        title: "Customer update",
        subject: "Customer update",
        detail: "Reviewed customer requests",
        effects: [],
        effectCount: 0,
        run: null,
      } as WorkEntry)
    : null;
  return {
    since,
    until,
    employeeId,
    entries: employeeId && latest && employeeId === latest.employee.id ? [latest] : [],
    entryCount: latest ? 1 : 0,
    employeeSummaries: latest
      ? [
          {
            employeeId: latest.employee.id,
            entryCount: 1,
            latest,
            current: working ? latest : null,
            waiting: null,
          },
        ]
      : [],
  };
}
type FixtureOptions = {
  count?: number;
  width?: number;
  height?: number;
  quiet?: boolean;
  dark?: boolean;
  longNames?: boolean;
  rosterError?: boolean;
  workError?: boolean;
  holdWork?: boolean;
  holdMarkRead?: boolean;
  markReadError?: boolean;
  working?: boolean;
  brokenAvatar?: boolean;
  touch?: boolean;
  channels?: HomeChannel[];
};
async function open(options: FixtureOptions = {}) {
  const page = await (options.touch ? touchContext : context).newPage();
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 1000 });
  await page.emulateMedia({
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  await page.clock.setFixedTime(fixtureNow);
  await page.addInitScript(() => localStorage.setItem("genosyn.pushPromptDismissed", "1"));
  let employees = roster(options.count ?? 1);
  if (options.longNames) employees[0].name = "Alexandria Rivera-Montgomery ".repeat(5).trim();
  if (options.brokenAvatar) employees[0].avatarKey = "missing";
  let rosterError = options.rosterError ?? false;
  let workError = options.workError ?? false;
  let homeError = false;
  let markReadError = options.markReadError ?? false;
  let unreadChannels = (
    options.channels ?? (options.quiet ? [] : [channel("support", "Support", 2)])
  ).map((row) => ({ ...row }));
  let releaseWork: () => void = () => {};
  const workGate = new Promise<void>((resolve) => {
    releaseWork = resolve;
  });
  let releaseMarkRead: () => void = () => {};
  const markReadGate = new Promise<void>((resolve) => {
    releaseMarkRead = resolve;
  });
  let holdNextHome = false;
  let releaseHome: () => void = () => {};
  const homeGate = new Promise<void>((resolve) => {
    releaseHome = resolve;
  });
  const reads: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const markRead = url.pathname.match(
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/read$/,
    );
    if (request.method() === "POST" && markRead) {
      writes.push(`${request.method()} ${url.pathname}`);
      if (options.holdMarkRead) await markReadGate;
      if (markReadError) {
        return route.fulfill({ status: 503, json: { error: "Workspace is unavailable." } });
      }
      unreadChannels = unreadChannels.filter((row) => row.id !== decodeURIComponent(markRead[1]));
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    reads.push(url.pathname + url.search);
    if (url.pathname === "/api/companies/company/home") {
      if (holdNextHome) {
        holdNextHome = false;
        await homeGate;
      }
      if (homeError) {
        return route.fulfill({ status: 503, json: { error: "Home is unavailable." } });
      }
      return route.fulfill({
        json: homeData(employees.length, {
          quiet: options.quiet,
          unreadChannels,
        }),
      });
    }
    if (url.pathname === "/api/companies/company/employees")
      return route.fulfill(
        rosterError
          ? { status: 503, json: { error: "Could not load your AI employees." } }
          : { json: employees },
      );
    if (url.pathname === "/api/companies/company/members") return route.fulfill({ json: [] });
    if (url.pathname === "/api/companies/company/work-timeline") {
      if (options.holdWork && !url.searchParams.has("employeeId")) await workGate;
      if (workError && !url.searchParams.has("employeeId"))
        return route.fulfill({
          status: 503,
          json: { error: "Recent work is temporarily unavailable." },
        });
      return route.fulfill({ json: timeline(employees, url.searchParams, options.working) });
    }
    if (
      options.brokenAvatar &&
      url.pathname === "/api/companies/company/employees/employee-1/avatar"
    )
      return route.fulfill({ status: 404, body: "" });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(`${origin}/__home_layout${options.longNames ? "?longNames=1" : ""}`, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page.locator('header[aria-label="Home greeting"]').waitFor({ timeout: 300000 });
  await page
    .getByRole("heading", {
      name:
        options.quiet && unreadChannels.length === 0
          ? "Nothing needs you right now"
          : options.quiet
            ? "Unread messages"
            : "Pending Decisions",
      exact: true,
    })
    .waitFor();
  if (employees.length && !rosterError) {
    await page.getByRole("group", { name: "Open an AI employee's day", exact: true }).waitFor();
    if (!options.holdWork)
      await page.waitForFunction(
        () => !document.querySelector('button[aria-label*="Loading work"]'),
      );
  }
  if (rosterError) await page.getByRole("alert").waitFor();
  return {
    page,
    reads,
    writes,
    releaseWork,
    releaseMarkRead,
    releaseHome,
    recover: () => {
      rosterError = false;
      workError = false;
      homeError = false;
      markReadError = false;
    },
    failHome: () => {
      homeError = true;
    },
    holdNextHome: () => {
      holdNextHome = true;
    },
    removeChannel: (channelId: string) => {
      unreadChannels = unreadChannels.filter((row) => row.id !== channelId);
    },
    removeEmployees: () => {
      employees = [];
    },
  };
}
const greeting = (page: Page) => page.locator('header[aria-label="Home greeting"]');
const work = (page: Page) =>
  page.getByRole("complementary", { name: "AI employee work", exact: true });
const bubbles = (page: Page) => work(page).getByRole("button");
const card = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const markReadButton = (page: Page, label: string) =>
  page.getByRole("button", {
    name: `Mark ${label} as read`,
    exact: true,
    includeHidden: true,
  });
async function markReadPresentation(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
}
async function unreadCardCount(page: Page, expected: number) {
  const header = card(page, "Unread messages").locator(":scope > div").first();
  await header.getByText(String(expected), { exact: true }).waitFor();
}
async function box(locator: Locator) {
  const value = await locator.boundingBox();
  assert.ok(value, "element must be visible");
  return value;
}
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "page must not scroll horizontally",
  );
  assert.equal(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "Home itself must not have hidden horizontal overflow",
  );
}
async function fillsContent(page: Page, title?: string) {
  const header = await box(greeting(page));
  const content = await box(title ? card(page, title) : card(page, "Your todos").locator(".."));
  assert.ok(Math.abs(content.x - header.x) < 1, "card must align with the greeting's left edge");
  assert.ok(
    Math.abs(content.width - header.width) < 1,
    "card must use the greeting's entire width without a reserved employee column",
  );
  assert.ok(
    content.y >= header.y + header.height,
    "cards must start below the greeting and employee bubbles",
  );
}
async function openDay(page: Page, index = 0, key?: string) {
  const bubble = bubbles(page).nth(index);
  if (key) {
    await bubble.focus();
    await page.keyboard.press(key);
  } else await bubble.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return dialog;
}
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  try {
    await run();
  } catch (error) {
    const page = context.pages().at(-1);
    if (page)
      await page.screenshot({ path: path.join(output, "home-layout-failure.png"), fullPage: true });
    if (browserErrors.length) console.error("Browser errors:", browserErrors);
    if (unexpectedRequests.length) console.error("Unexpected requests:", unexpectedRequests);
    throw error;
  }
  checks++;
  console.log(`PASS ${name}`);
}
try {
  await fs.mkdir(output, { recursive: true });
  for (const width of [1440, 768, 390, 320]) {
    await check(
      `greeting contains compact employee bubble on the right at ${width}px`,
      async () => {
        const { page, reads } = await open({ width });
        const heading = await box(
          page.getByRole("heading", { name: "Good morning, Nawaz", exact: true }),
        );
        const employee = await box(bubbles(page).first());
        assert.equal(await greeting(page).getByRole("complementary").count(), 1);
        assert.ok(
          employee.x >= heading.x + heading.width,
          "bubble belongs to the right of the greeting text",
        );
        assert.ok(
          employee.height >= 44 && employee.height <= 52,
          "compact bubble retains a 44px touch target",
        );
        const avatar = await box(
          bubbles(page).first().locator("[aria-hidden=true] > span[aria-label]").first(),
        );
        assert.equal(avatar.width, 24);
        assert.equal(avatar.height, 24);
        assert.equal(
          await page.getByRole("heading", { name: "Pending Decisions", exact: true }).count(),
          1,
        );
        assert.equal(
          await page
            .getByText("Which retention commitment needs attention?", { exact: true })
            .count(),
          1,
        );
        await fillsContent(page, "Pending Decisions");
        await fits(page);
        const todo = await box(card(page, "Your todos"));
        const messages = await box(card(page, "Unread messages"));
        const header = await box(greeting(page));
        if (width >= 1024) {
          assert.equal(todo.y, messages.y);
          assert.ok(
            Math.abs(messages.x + messages.width - header.x - header.width) < 1,
            "card grid reaches the full right edge",
          );
        } else {
          assert.equal(todo.width, header.width);
          assert.equal(messages.width, header.width);
        }
        assert.equal(
          reads.some((url) => url.includes("employeeId=")),
          false,
          "day detail stays lazy",
        );
        assert.equal(await page.getByRole("dialog").count(), 0);
        await page.screenshot({
          path: path.join(output, `home-compact-${width}.png`),
          fullPage: true,
        });
        await page.close();
      },
    );
  }
  await check(
    "hover reveals only the selected channel action and preserves unread totals",
    async () => {
      const { page } = await open({
        quiet: true,
        channels: [
          channel("marketing", "#marketing", 1),
          channel("sales", "#sales", 89),
          channel("youtube", "#youtube", 26),
        ],
      });
      await unreadCardCount(page, 116);
      const action = markReadButton(page, "#sales");
      const otherAction = markReadButton(page, "#marketing");
      assert.deepEqual(await markReadPresentation(action), {
        opacity: "0",
        pointerEvents: "none",
      });
      assert.equal(await card(page, "Unread messages").getByText("89", { exact: true }).count(), 1);

      await action.locator("..").hover();
      await page.waitForTimeout(200);
      assert.deepEqual(await markReadPresentation(action), {
        opacity: "1",
        pointerEvents: "auto",
      });
      assert.deepEqual(await markReadPresentation(otherAction), {
        opacity: "0",
        pointerEvents: "none",
      });
      const count = card(page, "Unread messages").getByText("89", { exact: true });
      assert.equal(await count.evaluate((element) => getComputedStyle(element).opacity), "1");
      const actionBox = await box(action);
      const countBox = await box(count);
      assert.ok(
        countBox.x + countBox.width < actionBox.x,
        "the unread count stays beside the revealed action",
      );
      assert.ok(actionBox.width <= 28 && actionBox.height <= 28, "the row action stays compact");
      assert.equal(await action.getAttribute("title"), "Mark as read");
      await page.screenshot({ path: path.join(output, "home-channel-mark-read-hover.png") });
      await page.close();
    },
  );
  await check(
    "marking one channel read sends one exact write without opening or navigating",
    async () => {
      const fixture = await open({
        quiet: true,
        channels: [
          channel("marketing", "#marketing", 1),
          channel("sales", "#sales", 89),
          channel("youtube", "#youtube", 8),
        ],
      });
      const action = markReadButton(fixture.page, "#sales");
      await action.locator("..").hover();
      const request = fixture.page.waitForRequest(
        (row) =>
          row.method() === "POST" &&
          new URL(row.url()).pathname === "/api/companies/company/workspace/channels/sales/read",
      );
      await action.click();
      await request;

      await fixture.page.getByText("#sales", { exact: true }).waitFor({ state: "detached" });
      await unreadCardCount(fixture.page, 9);
      assert.equal(await fixture.page.getByText("#marketing", { exact: true }).count(), 1);
      assert.equal(await fixture.page.getByText("#youtube", { exact: true }).count(), 1);
      assert.deepEqual(fixture.writes, [
        "POST /api/companies/company/workspace/channels/sales/read",
      ]);
      assert.equal(await fixture.page.getByRole("dialog").count(), 0);
      assert.equal(await fixture.page.getByLabel("Opened route").count(), 0);
      await fixture.page.close();
    },
  );
  await check("keyboard focus reveals and activates the channel action", async () => {
    const fixture = await open({
      quiet: true,
      channels: [channel("support", "#support", 2), channel("sales", "#sales", 3)],
    });
    const messages = card(fixture.page, "Unread messages");
    const supportLink = messages.getByRole("link").filter({ hasText: "#support" });
    const action = markReadButton(fixture.page, "#support");
    const nextAction = markReadButton(fixture.page, "#sales");

    await supportLink.focus();
    await fixture.page.waitForTimeout(200);
    assert.deepEqual(await markReadPresentation(action), {
      opacity: "1",
      pointerEvents: "auto",
    });
    await fixture.page.keyboard.press("Tab");
    assert.equal(
      await action.evaluate((element) => element === document.activeElement),
      true,
      "the action follows its channel link in keyboard order",
    );
    const request = fixture.page.waitForRequest((row) =>
      new URL(row.url()).pathname.endsWith("/workspace/channels/support/read"),
    );
    await fixture.page.keyboard.press("Space");
    await request;
    await fixture.page.getByText("#support", { exact: true }).waitFor({ state: "detached" });
    await unreadCardCount(fixture.page, 3);
    await fixture.page.waitForFunction(
      (channelId) =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.dataset.homeMarkReadChannel === channelId,
      "sales",
    );
    assert.equal(
      await nextAction.evaluate((element) => element === document.activeElement),
      true,
      "focus moves to the next channel action after its predecessor disappears",
    );
    await fixture.page.getByRole("status").getByText("#support marked as read.").waitFor();
    assert.equal(fixture.writes.length, 1);
    await fixture.page.close();
  });
  await check(
    "marking the last unread channel removes the queue and reveals all-clear",
    async () => {
      const fixture = await open({
        quiet: true,
        channels: [channel("support", "#support", 2)],
      });
      const action = markReadButton(fixture.page, "#support");
      await action.focus();
      await fixture.page.keyboard.press("Space");
      const allClear = fixture.page.getByRole("heading", {
        name: "Nothing needs you right now",
        exact: true,
      });
      await allClear.waitFor();
      await fixture.page.waitForFunction(
        () => document.activeElement?.hasAttribute("data-home-all-clear") === true,
      );
      assert.equal(
        await allClear.evaluate((element) => element === document.activeElement),
        true,
        "focus moves to the all-clear state after the final channel disappears",
      );
      assert.equal(await card(fixture.page, "Unread messages").count(), 0);
      assert.deepEqual(fixture.writes, [
        "POST /api/companies/company/workspace/channels/support/read",
      ]);
      await fixture.page.close();
    },
  );
  await check(
    "last-channel focus fallback scrolls into view when other Home queues remain",
    async () => {
      const fixture = await open({
        width: 390,
        height: 320,
        channels: [channel("support", "#support", 2)],
      });
      const action = markReadButton(fixture.page, "#support");
      await action.scrollIntoViewIfNeeded();
      await action.focus();
      const before = await fixture.page.evaluate(() => scrollY);
      assert.ok(before > 0, "the compact viewport starts below the greeting");

      await fixture.page.keyboard.press("Space");
      await fixture.page.getByText("#support", { exact: true }).waitFor({ state: "detached" });
      await fixture.page.waitForFunction(
        () => document.activeElement?.hasAttribute("data-home-mark-read-fallback") === true,
      );

      const greeting = fixture.page.locator("[data-home-mark-read-fallback]");
      assert.equal(await greeting.evaluate((element) => element === document.activeElement), true);
      assert.ok(
        (await fixture.page.evaluate(() => scrollY)) < before,
        "moving focus to the fallback also brings it back into view",
      );
      assert.equal(await fixture.page.locator("[data-home-all-clear]").count(), 0);
      await fixture.page.getByRole("heading", { name: "Pending Decisions", exact: true }).waitFor();
      await fixture.page.close();
    },
  );
  await check("a rapid physical double-click cannot clear or open the next channel", async () => {
    const fixture = await open({
      quiet: true,
      channels: [
        channel("marketing", "#marketing", 1),
        channel("sales", "#sales", 89),
        channel("youtube", "#youtube", 8),
      ],
    });
    const action = markReadButton(fixture.page, "#sales");
    await action.locator("..").hover();
    const actionBox = await box(action);
    const point = {
      x: actionBox.x + actionBox.width / 2,
      y: actionBox.y + actionBox.height / 2,
    };

    await fixture.page.mouse.click(point.x, point.y);
    await fixture.page.getByText("#sales", { exact: true }).waitFor({ state: "detached" });
    await fixture.page.mouse.click(point.x, point.y);
    await fixture.page.waitForTimeout(550);

    assert.deepEqual(fixture.writes, ["POST /api/companies/company/workspace/channels/sales/read"]);
    await unreadCardCount(fixture.page, 9);
    assert.equal(await fixture.page.getByText("#marketing", { exact: true }).count(), 1);
    assert.equal(await fixture.page.getByText("#youtube", { exact: true }).count(), 1);
    assert.equal(await fixture.page.getByRole("dialog").count(), 0);
    assert.equal(await fixture.page.getByLabel("Opened route").count(), 0);
    await fixture.page.close();
  });
  await check(
    "a failed channel write restores the exact row and total without duplicating it",
    async () => {
      const fixture = await open({
        quiet: true,
        holdMarkRead: true,
        markReadError: true,
        channels: [
          channel("marketing", "#marketing", 1),
          channel("sales", "#sales", 89),
          channel("youtube", "#youtube", 8),
        ],
      });
      try {
        const action = markReadButton(fixture.page, "#sales");
        await action.locator("..").hover();
        const request = fixture.page.waitForRequest((row) =>
          new URL(row.url()).pathname.endsWith("/workspace/channels/sales/read"),
        );
        await action.click();
        await request;
        await fixture.page.getByText("#sales", { exact: true }).waitFor({ state: "detached" });
        await unreadCardCount(fixture.page, 9);

        // A focus refresh may put the authoritative unread row back while the
        // write is still pending. The later rejection must not insert a
        // duplicate from its optimistic snapshot.
        await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
        await fixture.page.getByText("#sales", { exact: true }).waitFor();
        fixture.releaseMarkRead();
        const dialog = fixture.page.getByRole("dialog", {
          name: "Couldn’t mark #sales as read",
          exact: true,
        });
        await dialog.waitFor();
        await dialog
          .getByText("Workspace is unavailable. The latest Home data has been kept.", {
            exact: true,
          })
          .waitFor();
        await unreadCardCount(fixture.page, 98);
        assert.deepEqual(
          (await card(fixture.page, "Unread messages").getByRole("link").allTextContents())
            .map((text) => text.trim())
            .filter((text) => text.startsWith("#")),
          ["#marketing1", "#sales89", "#youtube8"],
        );
        assert.equal(await fixture.page.getByText("#sales", { exact: true }).count(), 1);
        assert.equal(fixture.writes.length, 1);
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
      } finally {
        fixture.releaseMarkRead();
        await fixture.page.close();
      }
    },
  );
  await check(
    "a failed refresh cannot suppress rollback after a failed channel write",
    async () => {
      const fixture = await open({
        quiet: true,
        holdMarkRead: true,
        markReadError: true,
        channels: [
          channel("marketing", "#marketing", 1),
          channel("sales", "#sales", 89),
          channel("youtube", "#youtube", 8),
        ],
      });
      try {
        const action = markReadButton(fixture.page, "#sales");
        await action.locator("..").hover();
        await action.click();
        await fixture.page.getByText("#sales", { exact: true }).waitFor({ state: "detached" });
        await unreadCardCount(fixture.page, 9);

        fixture.failHome();
        const failedRefresh = fixture.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/companies/company/home" &&
            response.status() === 503,
        );
        await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
        await failedRefresh;
        fixture.releaseMarkRead();

        const dialog = fixture.page.getByRole("dialog", {
          name: "Couldn’t mark #sales as read",
          exact: true,
        });
        await dialog.waitFor();
        await dialog
          .getByText("Workspace is unavailable. It has been restored.", { exact: true })
          .waitFor();
        await unreadCardCount(fixture.page, 98);
        assert.deepEqual(
          (await card(fixture.page, "Unread messages").getByRole("link").allTextContents())
            .map((text) => text.trim())
            .filter((text) => text.startsWith("#")),
          ["#marketing1", "#sales89", "#youtube8"],
        );
        assert.equal(await fixture.page.getByText("#sales", { exact: true }).count(), 1);
        assert.equal(fixture.writes.length, 1);
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
      } finally {
        fixture.releaseMarkRead();
        await fixture.page.close();
      }
    },
  );
  await check(
    "a successful Home refresh landing after the click remains authoritative",
    async () => {
      const fixture = await open({
        quiet: true,
        holdMarkRead: true,
        markReadError: true,
        channels: [
          channel("marketing", "#marketing", 1),
          channel("sales", "#sales", 89),
          channel("youtube", "#youtube", 8),
        ],
      });
      try {
        fixture.holdNextHome();
        const refreshStarted = fixture.page.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/companies/company/home",
        );
        await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
        await refreshStarted;

        const action = markReadButton(fixture.page, "#sales");
        await action.locator("..").hover();
        await action.click();
        await fixture.page.getByText("#sales", { exact: true }).waitFor({ state: "detached" });
        fixture.removeChannel("sales");
        const refreshed = fixture.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/companies/company/home" &&
            response.status() === 200,
        );
        fixture.releaseHome();
        await refreshed;
        fixture.releaseMarkRead();

        const dialog = fixture.page.getByRole("dialog", {
          name: "Couldn’t mark #sales as read",
          exact: true,
        });
        await dialog.waitFor();
        await dialog
          .getByText("Workspace is unavailable. The latest Home data has been kept.", {
            exact: true,
          })
          .waitFor();
        await unreadCardCount(fixture.page, 9);
        assert.equal(await fixture.page.getByText("#sales", { exact: true }).count(), 0);
        assert.equal(fixture.writes.length, 1);
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
      } finally {
        fixture.releaseHome();
        fixture.releaseMarkRead();
        await fixture.page.close();
      }
    },
  );
  await check(
    "touch Home keeps the unread count visible without a permanent quick action",
    async () => {
      const fixture = await open({
        quiet: true,
        touch: true,
        width: 320,
        channels: [
          channel(
            "customer-success",
            "#customer-success-with-a-name-that-must-truncate-on-mobile",
            101,
          ),
        ],
      });
      const action = markReadButton(
        fixture.page,
        "#customer-success-with-a-name-that-must-truncate-on-mobile",
      );
      assert.equal(await action.isVisible(), false);
      const count = card(fixture.page, "Unread messages").getByText("99+", { exact: true });
      assert.equal(await count.evaluate((element) => getComputedStyle(element).opacity), "1");
      const countBox = await box(count);
      const rowBox = await box(
        card(fixture.page, "Unread messages")
          .getByRole("link")
          .filter({ hasText: "#customer-success-with-a-name-that-must-truncate-on-mobile" }),
      );
      assert.ok(countBox.x + countBox.width <= rowBox.x + rowBox.width);
      await fits(fixture.page);
      await fixture.page.screenshot({
        path: path.join(output, "home-channel-mark-read-touch.png"),
        fullPage: true,
      });
      assert.deepEqual(fixture.writes, []);
      await fixture.page.close();
    },
  );
  for (const width of [1440, 390, 320]) {
    await check(
      `large roster stays one scrollable row and last employee is keyboard reachable at ${width}px`,
      async () => {
        const { page } = await open({ count: 25, width });
        const row = page.getByRole("group", { name: "Open an AI employee's day", exact: true });
        assert.equal(await bubbles(page).count(), 25);
        const first = await box(bubbles(page).first());
        const last = await box(bubbles(page).last());
        assert.equal(first.y, last.y, "employees remain on one horizontal row");
        assert.equal(
          await row.evaluate((element) => element.scrollWidth > element.clientWidth),
          true,
        );
        await bubbles(page).first().focus();
        for (let index = 1; index < 25; index++) await page.keyboard.press("Tab");
        assert.equal(
          await bubbles(page)
            .last()
            .evaluate((element) => element === document.activeElement),
          true,
        );
        const rowBox = await box(row);
        const focused = await box(bubbles(page).last());
        assert.ok(
          focused.x >= rowBox.x - 1 && focused.x + focused.width <= rowBox.x + rowBox.width + 1,
          "keyboard focus scrolls the last employee fully into view",
        );
        assert.ok(await row.evaluate((element) => element.scrollLeft > 0));
        await page.keyboard.press("Enter");
        await page.getByRole("dialog", { name: "Employee 25's day", exact: true }).waitFor();
        await page.getByText("No work recorded on this day", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(
          await bubbles(page)
            .last()
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await fillsContent(page);
        await fits(page);
        await page.close();
      },
    );
  }
  await check(
    "click, Enter and Space open only the selected employee and restore focus",
    async () => {
      const { page, reads } = await open({ count: 2 });
      for (const key of [undefined, "Enter", "Space"]) {
        const day = await openDay(page, 0, key);
        await day.getByRole("heading", { name: "Jamie Mallers's day", exact: true }).waitFor();
        assert.equal(await page.getByRole("dialog").count(), 1);
        await page.keyboard.press("Escape");
        assert.equal(
          await bubbles(page)
            .first()
            .evaluate((element) => element === document.activeElement),
          true,
        );
      }
      const dayReads = reads.filter((url) => url.includes("employeeId="));
      assert.ok(dayReads.length > 0);
      assert.ok(
        dayReads.every(
          (url) => new URL(url, origin).searchParams.get("employeeId") === "employee-1",
        ),
      );
      await page.close();
    },
  );
  await check("pending work reads say Loading work while the cards remain usable", async () => {
    const fixture = await open({ holdWork: true });
    try {
      await bubbles(fixture.page).first().getByText("Loading work", { exact: true }).waitFor();
      assert.doesNotMatch(await work(fixture.page).innerText(), /Quiet today|Status unavailable/);
      await fillsContent(fixture.page);
      fixture.releaseWork();
      await bubbles(fixture.page).first().getByText("Active 19m ago", { exact: true }).waitFor();
    } finally {
      fixture.releaseWork();
      await fixture.page.close();
    }
  });
  await check(
    "work read failure remains inline, allows opening a day and recovers on focus",
    async () => {
      const fixture = await open({ workError: true, width: 320 });
      await work(fixture.page)
        .getByRole("alert")
        .getByText("Recent work is temporarily unavailable.", { exact: true })
        .waitFor();
      assert.match(
        (await bubbles(fixture.page).first().getAttribute("aria-label")) ?? "",
        /Status unavailable/,
      );
      await fits(fixture.page);
      await fillsContent(fixture.page);
      const day = await openDay(fixture.page);
      await day.getByRole("heading", { name: "Jamie Mallers's day", exact: true }).waitFor();
      await fixture.page.keyboard.press("Escape");
      fixture.recover();
      await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
      await bubbles(fixture.page).first().getByText("Active 19m ago", { exact: true }).waitFor();
      assert.equal(await work(fixture.page).getByRole("alert").count(), 0);
      await fits(fixture.page);
      await fillsContent(fixture.page);
      await fixture.page.close();
    },
  );
  await check("roster failure sits in the greeting and recovery restores bubbles", async () => {
    const fixture = await open({ rosterError: true, width: 320 });
    await greeting(fixture.page).getByRole("alert").waitFor();
    assert.equal(await bubbles(fixture.page).count(), 0);
    await fillsContent(fixture.page);
    await fits(fixture.page);
    fixture.recover();
    await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
    await bubbles(fixture.page).first().getByText("Active 19m ago", { exact: true }).waitFor();
    assert.equal(await greeting(fixture.page).getByRole("alert").count(), 0);
    await fixture.page.close();
  });
  await check("empty roster leaves the greeting and full-width all-clear card", async () => {
    const { page } = await open({ count: 0, quiet: true });
    assert.equal(await work(page).count(), 0);
    await fillsContent(page, "Nothing needs you right now");
    await fits(page);
    await page.close();
  });
  await check(
    "all-clear Home keeps employees available with honest working and quiet status",
    async () => {
      const { page } = await open({ count: 2, quiet: true, working: true });
      await bubbles(page).first().getByText("Working now", { exact: true }).waitFor();
      await bubbles(page).nth(1).getByText("Quiet today", { exact: true }).waitFor();
      await fillsContent(page, "Nothing needs you right now");
      await page.close();
    },
  );
  await check(
    "removing the selected employee dismisses their day and clears the header roster",
    async () => {
      const fixture = await open();
      await openDay(fixture.page);
      fixture.removeEmployees();
      await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
      await fixture.page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(await work(fixture.page).count(), 0);
      await fillsContent(fixture.page);
      await fixture.page.close();
    },
  );
  await check(
    "long names and failed photos fit a narrow dark-mode greeting with full accessible labels",
    async () => {
      const { page } = await open({ width: 320, longNames: true, brokenAvatar: true, dark: true });
      const name = "Alexandria Rivera-Montgomery ".repeat(5).trim();
      const bubble = bubbles(page).first();
      assert.ok(
        (await bubble.getAttribute("aria-label"))?.startsWith(`${name}, Customer support,`),
      );
      assert.ok((await bubble.getAttribute("title"))?.includes(name));
      await bubble.locator("img").waitFor({ state: "detached" });
      await bubble.getByText("AR", { exact: true }).waitFor();
      assert.equal(
        await page.locator("html").evaluate((element) => element.classList.contains("dark")),
        true,
      );
      await fits(page);
      await fillsContent(page);
      const day = await openDay(page);
      const bounds = await box(day);
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: path.join(output, "home-compact-long-dark.png"),
        fullPage: true,
      });
      await page.close();
    },
  );
  assert.deepEqual(browserErrors, [], "browser must have no uncaught errors");
  assert.deepEqual(unexpectedRequests, [], "browser must only make expected fixture requests");
  console.log(`PASS ${checks} Home layout browser regressions`);
} finally {
  await touchContext.close();
  await context.close();
  await browser.close();
  await server.close();
}
