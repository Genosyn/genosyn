/**
 * Real Chrome tests the production Routines overview and its existing filters.
 * HTTP and company socket fixtures are deterministic; unexpected requests and
 * product writes fail. Run with tsx scripts/test-routine-activity.ts; optional
 * arguments select case name substrings.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import type { CompanyTag, Employee, RoutineFolder, RoutineWithMeta, Run } from "../client/lib/api";
import type { RoutineActivityData } from "../client/components/routines/RoutineActivity";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixtureNow = new Date("2026-09-17T12:00:00.000Z");
const browserErrors: string[] = [];
const unexpectedRequests: string[] = [];
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-routine-activity"),
  plugins: [
    {
      name: "routine-activity-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__routine_activity", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__routine_activity",
            '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
              `<script type="module" src="/@fs${root}/scripts/routineActivityHarness.tsx"></script></html>`,
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

const employees = [
  { id: "jamie", slug: "jamie", name: "Jamie Mallers", role: "Support", avatarKey: null },
  { id: "alex", slug: "alex", name: "Alex Rivera", role: "Finance", avatarKey: null },
] as Employee[];

function tag(id: string, name: string, color: CompanyTag["color"]): CompanyTag {
  return {
    id,
    name,
    color,
    normalizedName: name.toLowerCase(),
    companyId: "company",
    createdAt: fixtureNow.toISOString(),
    updatedAt: fixtureNow.toISOString(),
  };
}
const customerTag = tag("customer", "Customer", "blue");
const financeTag = tag("finance", "Finance", "green");
const folders: RoutineFolder[] = [
  {
    id: "operations",
    name: "Operations",
    slug: "operations",
    parentId: null,
    path: "Operations",
    depth: 1,
    routineCount: 0,
    totalRoutineCount: 2,
  },
  {
    id: "support",
    name: "Support",
    slug: "support",
    parentId: "operations",
    path: "Operations/Support",
    depth: 2,
    routineCount: 2,
    totalRoutineCount: 2,
  },
  {
    id: "finance",
    name: "Finance",
    slug: "finance",
    parentId: null,
    path: "Finance",
    depth: 1,
    routineCount: 1,
    totalRoutineCount: 1,
  },
].map((row, index) => ({
  ...row,
  companyId: "company",
  sortOrder: index,
  createdAt: fixtureNow.toISOString(),
  updatedAt: fixtureNow.toISOString(),
}));

function run(id: string, routineId: string, changes: Partial<Run> = {}): Run {
  return {
    id,
    routineId,
    status: "completed",
    startedAt: "2026-09-17T09:00:00.000Z",
    finishedAt: "2026-09-17T09:05:00.000Z",
    exitCode: 0,
    createdAt: "2026-09-17T09:00:00.000Z",
    outcomeVerdict: "achieved",
    checksVerdict: "passed",
    ...changes,
  };
}

function fixtures(extra = 0, longNames = false) {
  const inboxLive = run("inbox-live", "inbox", {
    status: "running",
    startedAt: "2026-09-17T11:52:00.000Z",
    finishedAt: null,
    outcomeVerdict: null,
    checksVerdict: null,
    exitCode: null,
  });
  const overnightLive = run("audit-live", "audit", {
    status: "running",
    startedAt: "2026-09-16T22:45:00.000Z",
    finishedAt: null,
    outcomeVerdict: null,
    checksVerdict: null,
    exitCode: null,
  });
  const inboxEnded = run("inbox-earlier", "inbox");
  const invoices = run("invoice-latest", "invoices", {
    startedAt: "2026-09-17T10:00:00.000Z",
    finishedAt: "2026-09-17T10:04:00.000Z",
    outcomeVerdict: "unverified",
    checksVerdict: null,
  });
  const accountReview = run("account-failed", "accounts", {
    status: "failed",
    outcomeVerdict: "off_goal",
    checksVerdict: "failed",
    exitCode: 1,
  });
  const rows: Array<
    Pick<RoutineWithMeta, "id" | "name" | "employee" | "folderId" | "tags" | "lastRun"> & {
      enabled?: boolean;
    }
  > = [
    {
      id: "inbox",
      name: "Inbox sweep",
      employee: employees[0],
      folderId: "support",
      tags: [customerTag],
      lastRun: inboxLive,
    },
    {
      id: "invoices",
      name: "Invoice follow-up",
      employee: employees[1],
      folderId: "finance",
      tags: [financeTag],
      lastRun: invoices,
    },
    {
      id: "accounts",
      name: "Account review",
      employee: employees[0],
      folderId: "support",
      tags: [customerTag],
      lastRun: accountReview,
    },
    {
      id: "audit",
      name: "Overnight audit",
      employee: employees[1],
      folderId: null,
      tags: [financeTag],
      lastRun: overnightLive,
      enabled: false,
    },
    {
      id: "weekly",
      name: "Weekly summary",
      employee: employees[0],
      folderId: null,
      tags: [],
      lastRun: null,
    },
  ];
  const activity: RoutineActivityData = {
    running: [inboxLive, overnightLive],
    today: [
      { routineId: "invoices", runCount: 3, latestRun: invoices },
      { routineId: "inbox", runCount: 1, latestRun: inboxEnded },
      { routineId: "accounts", runCount: 1, latestRun: accountReview },
    ],
  };
  for (let index = 0; index < extra; index += 1) {
    const id = `extra-${index}`;
    const latestRun = run(`${id}-run`, id);
    rows.push({
      id,
      name: `Daily report ${index + 1}`,
      employee: employees[0],
      folderId: null,
      tags: [],
      lastRun: latestRun,
    });
    activity.today.push({ routineId: id, runCount: 1, latestRun });
  }
  if (longNames) {
    rows[0].name = "CustomerOperationsFollowUp ".repeat(8).trim();
    rows[0].employee = { ...employees[0], name: "Alexandria Rivera-Montgomery ".repeat(5).trim() };
  }
  const routines: RoutineWithMeta[] = rows.map((row) => ({
    slug: row.id,
    employeeId: row.employee!.id,
    cronExpr: "0 9 * * *",
    enabled: true,
    goalId: null,
    lastRunAt: row.lastRun?.startedAt ?? null,
    nextRunAt: "2026-09-18T09:00:00.000Z",
    timeoutSec: 300,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
    createdAt: fixtureNow.toISOString(),
    updatedAt: fixtureNow.toISOString(),
    ...row,
  }));
  return { routines, activity };
}

async function open(
  options: {
    width?: number;
    dark?: boolean;
    longNames?: boolean;
    extra?: number;
    empty?: boolean;
    noRunning?: boolean;
    holdActivity?: boolean;
    activityError?: boolean;
    tickingClock?: boolean;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: 1000 },
    timezoneId: "Europe/London",
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (options.tickingClock) {
    await page.clock.install({ time: new Date(fixtureNow.getTime() - 1000) });
    await page.clock.pauseAt(fixtureNow);
  } else {
    await page.clock.setFixedTime(fixtureNow);
  }
  const data = fixtures(options.extra, options.longNames);
  let activity = options.empty ? { running: [], today: [] } : data.activity;
  if (options.noRunning) activity = { ...activity, running: [] };
  let failed = options.activityError ?? false;
  let releaseActivity: () => void = () => {};
  const heldActivity = new Promise<void>((resolve) => {
    releaseActivity = resolve;
  });
  const reads: URL[] = [];
  const sockets = new Set<WebSocketRoute>();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.routeWebSocket("**/api/ws?*", (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((message) => unexpectedRequests.push(`Unexpected socket write: ${message}`));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpectedRequests.push(`External request: ${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST" && url.pathname === "/api/companies/company/workspace/ws-token")
      return route.fulfill({ json: { token: "fixture" } });
    if (request.method() !== "GET") {
      unexpectedRequests.push(`Unexpected write: ${request.method()} ${url.pathname}`);
      return route.abort();
    }
    reads.push(url);
    if (url.pathname === "/api/companies/company/routines")
      return route.fulfill({ json: data.routines });
    if (url.pathname === "/api/companies/company/employees")
      return route.fulfill({ json: employees });
    if (url.pathname === "/api/companies/company/routine-folders")
      return route.fulfill({ json: { folders, unfiledCount: 2, maxDepth: 5 } });
    if (url.pathname === "/api/companies/company/routines/activity") {
      if (options.holdActivity) await heldActivity;
      if (failed) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      return route.fulfill({ json: activity });
    }
    unexpectedRequests.push(`Unexpected read: ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(`${origin}/__routine_activity`, { waitUntil: "commit", timeout: 60_000 });
  await page
    .getByRole("textbox", { name: "Search routines", exact: true })
    .waitFor({ timeout: 300_000 });
  await page.locator('[data-socket-status="open"]').waitFor({ state: "attached" });
  return {
    page,
    reads,
    releaseActivity,
    routines: data.routines,
    recover: () => {
      failed = false;
    },
    setActivity: (next: RoutineActivityData) => {
      activity = next;
    },
    activity: () => activity,
    event: (kind = "run") => {
      for (const socket of sockets)
        socket.send(JSON.stringify({ type: "resource.changed", kind, scopeIds: [] }));
    },
    close: async () => {
      releaseActivity();
      await context.close();
    },
  };
}

const running = (page: Page) => page.getByRole("region", { name: "Running now", exact: true });
const today = (page: Page) => page.getByRole("region", { name: "Ran today", exact: true });
async function names(page: Page, section: "running" | "today") {
  const links = (section === "running" ? running(page) : today(page)).getByRole("link");
  return links.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("aria-label")!.split(": view ")[0]),
  );
}
async function expectNames(page: Page, section: "running" | "today", expected: string[]) {
  const headingId = section === "running" ? "running-now-heading" : "ran-today-heading";
  await page.waitForFunction(
    ({ headingId, expected }) => {
      const region = document.querySelector(`section[aria-labelledby="${headingId}"]`);
      const actual = Array.from(
        region?.querySelectorAll("a") ?? [],
        (link) => link.getAttribute("aria-label")!.split(": view ")[0],
      );
      return JSON.stringify(actual) === JSON.stringify(expected);
    },
    { headingId, expected },
  );
  assert.deepEqual(await names(page, section), expected);
}
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "Routines must not scroll sideways",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "New routine", exact: true })
      // The desktop sidebar has an icon button with the same accessible name.
      .filter({ hasText: /^New routine$/ })
      .evaluate((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      }),
    true,
    "the New routine button must remain fully visible on narrow screens",
  );
  for (const region of [running(page), today(page)]) {
    if (!(await region.count())) continue;
    const geometry = await region.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        viewport: innerWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    assert.ok(
      geometry.left >= 0 &&
        geometry.right <= geometry.viewport &&
        geometry.scrollWidth <= geometry.clientWidth,
      `activity sections must fit the viewport: ${JSON.stringify(geometry)}`,
    );
    assert.equal(
      await region
        .getByRole("link")
        .evaluateAll((links) => links.every((link) => link.scrollWidth <= link.clientWidth)),
      true,
      "activity cards must contain badges and times",
    );
  }
}
let checks = 0;
async function check(name: string, test: () => Promise<void>) {
  const requested = process.argv.slice(2);
  if (requested.length && !requested.some((part) => name.includes(part))) return;
  console.log(`RUN ${name}`);
  await test();
  checks += 1;
  console.log(`PASS ${name}`);
}

try {
  await fs.mkdir(output, { recursive: true });
  await check(
    "running work and unique routines that ran today are visible with local-day bounds",
    async () => {
      const fixture = await open();
      try {
        await running(fixture.page).waitFor();
        await expectNames(fixture.page, "running", ["Inbox sweep", "Overnight audit"]);
        await expectNames(fixture.page, "today", [
          "Invoice follow-up",
          "Inbox sweep",
          "Account review",
        ]);
        await today(fixture.page).getByText("3 routines · 5 Runs", { exact: true }).waitFor();
        await today(fixture.page)
          .getByText(/3 Runs · latest/)
          .waitFor();
        await today(fixture.page).getByText("unverified", { exact: true }).waitFor();
        assert.equal(
          await today(fixture.page)
            .getByRole("link", { name: /Weekly summary/ })
            .count(),
          0,
        );
        const ranges = fixture.reads.filter((url) => url.pathname.endsWith("/activity"));
        assert.ok(ranges.length > 0);
        assert.ok(
          ranges.every(
            (url) =>
              url.searchParams.get("from") === "2026-09-16T23:00:00.000Z" &&
              url.searchParams.get("to") === "2026-09-17T23:00:00.000Z",
          ),
        );
        await fits(fixture.page);
        await fixture.page.screenshot({
          path: path.join(output, "routines-activity-desktop.png"),
          fullPage: true,
        });
      } finally {
        await fixture.close();
      }
    },
  );
  await check("activity links open the selected live or latest Run", async () => {
    for (const [section, label, expected] of [
      ["running", "Inbox sweep: view live Run", "/c/company/routines/jamie/inbox?run=inbox-live"],
      [
        "today",
        "Invoice follow-up: view latest Run",
        "/c/company/routines/alex/invoices?run=invoice-latest",
      ],
    ] as const) {
      const fixture = await open();
      try {
        await (section === "running" ? running(fixture.page) : today(fixture.page))
          .getByRole("link", { name: label, exact: true })
          .click();
        assert.equal(
          await fixture.page.getByLabel("Opened route", { exact: true }).innerText(),
          expected,
        );
      } finally {
        await fixture.close();
      }
    }
  });
  await check(
    "no running work hides its section and an empty day has an honest empty state",
    async () => {
      const fixture = await open({ empty: true });
      try {
        await today(fixture.page)
          .getByText(/No routines have finished a Run today/)
          .waitFor();
        assert.equal(await running(fixture.page).count(), 0);
        assert.equal(
          await fixture.page.getByRole("heading", { name: "Running now", exact: true }).count(),
          0,
        );
        assert.equal(await today(fixture.page).getByRole("link").count(), 0);
        await fits(fixture.page);
      } finally {
        await fixture.close();
      }
      const completed = await open({ noRunning: true });
      try {
        await today(completed.page).getByRole("link").first().waitFor();
        assert.equal(await running(completed.page).count(), 0);
        assert.equal(await today(completed.page).getByRole("link").count(), 3);
      } finally {
        await completed.close();
      }
    },
  );
  await check("search, tag and health filters narrow both sections", async () => {
    const fixture = await open();
    const { page } = fixture;
    try {
      await running(page).waitFor();
      const search = page.getByRole("textbox", { name: "Search routines", exact: true });
      await search.fill("inbox");
      await expectNames(page, "running", ["Inbox sweep"]);
      await expectNames(page, "today", ["Inbox sweep"]);
      await search.press("Escape");
      await page.getByRole("button", { name: "Customer", exact: true }).click();
      await expectNames(page, "running", ["Inbox sweep"]);
      await expectNames(page, "today", ["Inbox sweep", "Account review"]);
      await page.getByRole("button", { name: /^Needs attention/ }).click();
      await running(page).waitFor({ state: "detached" });
      await expectNames(page, "today", ["Account review"]);
      await page.getByRole("button", { name: /^All \d/ }).click();
      await page.getByRole("button", { name: "Customer", exact: true }).click();
      await page.getByRole("button", { name: /^Paused/ }).click();
      await expectNames(page, "running", ["Overnight audit"]);
      await expectNames(page, "today", []);
    } finally {
      await fixture.close();
    }
  });
  await check("employee and parent-folder filters apply to both activity sections", async () => {
    const fixture = await open();
    const { page } = fixture;
    try {
      await running(page).waitFor();
      await page.locator('aside a[href="/c/company/routines?employee=alex"]').click();
      await expectNames(page, "running", ["Overnight audit"]);
      await expectNames(page, "today", ["Invoice follow-up"]);
      await page.locator('aside a[href="/c/company/routines?folder=operations"]').click();
      await expectNames(page, "running", ["Inbox sweep"]);
      await expectNames(page, "today", ["Inbox sweep", "Account review"]);
      await page.locator('aside a[href="/c/company/routines?folder=unfiled"]').click();
      await expectNames(page, "running", ["Overnight audit"]);
      await expectNames(page, "today", []);
    } finally {
      await fixture.close();
    }
  });
  await check(
    "a completed Run leaves Running now and updates today's latest Run after a live event",
    async () => {
      const fixture = await open();
      try {
        await running(fixture.page).waitFor();
        const latest = run("inbox-live", "inbox", { finishedAt: fixtureNow.toISOString() });
        fixture.setActivity({
          running: [],
          today: [{ routineId: "inbox", runCount: 2, latestRun: latest }],
        });
        fixture.event();
        await running(fixture.page).waitFor({ state: "detached" });
        await today(fixture.page).getByText("1 routine · 2 Runs", { exact: true }).waitFor();
        await expectNames(fixture.page, "today", ["Inbox sweep"]);
        assert.equal(
          await today(fixture.page).getByRole("link").getAttribute("href"),
          "/c/company/routines/jamie/inbox?run=inbox-live",
        );
      } finally {
        await fixture.close();
      }
    },
  );
  await check(
    "polling refreshes activity and advances the local calendar day at midnight",
    async () => {
      const fixture = await open({ tickingClock: true });
      try {
        await running(fixture.page).waitFor();
        const before = fixture.reads.filter((url) => url.pathname.endsWith("/activity")).length;
        fixture.setActivity({ running: [], today: [] });
        await fixture.page.clock.fastForward(30_001);
        await running(fixture.page).waitFor({ state: "detached" });
        assert.ok(
          fixture.reads.filter((url) => url.pathname.endsWith("/activity")).length > before,
        );
        await fixture.page.clock.setFixedTime(new Date("2026-09-17T23:01:00.000Z"));
        const nextDayResponse = fixture.page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname.endsWith("/activity") &&
            url.searchParams.get("from") === "2026-09-17T23:00:00.000Z"
          );
        });
        await fixture.page.clock.fastForward(30_001);
        await nextDayResponse;
        await today(fixture.page)
          .getByText(/No routines have finished a Run today/)
          .waitFor();
        const ranges = fixture.reads.filter((url) => url.pathname.endsWith("/activity"));
        assert.equal(ranges.at(-1)!.searchParams.get("from"), "2026-09-17T23:00:00.000Z");
        assert.equal(ranges.at(-1)!.searchParams.get("to"), "2026-09-18T23:00:00.000Z");
      } finally {
        await fixture.close();
      }
    },
  );
  await check("loading and retryable errors never masquerade as an empty day", async () => {
    const pending = await open({ holdActivity: true });
    try {
      await pending.page
        .getByRole("status")
        .getByText("Loading recent Runs…", { exact: true })
        .waitFor();
      assert.equal(await today(pending.page).count(), 0);
      pending.releaseActivity();
      await running(pending.page).waitFor();
    } finally {
      await pending.close();
    }
    const failed = await open({ activityError: true });
    try {
      await failed.page.getByRole("alert").waitFor();
      assert.equal(await today(failed.page).count(), 0);
      failed.recover();
      await failed.page.getByRole("button", { name: "Try again", exact: true }).click();
      await running(failed.page).waitFor();
      assert.equal(await failed.page.getByRole("alert").count(), 0);
    } finally {
      await failed.close();
    }
  });
  await check(
    "mobile cards fit long names, badges and times, and Show all reveals the whole day",
    async () => {
      for (const width of [390, 320]) {
        const fixture = await open({ width, dark: width === 320, longNames: true, extra: 4 });
        try {
          await running(fixture.page).waitFor();
          assert.equal(await today(fixture.page).getByRole("link").count(), 5);
          await today(fixture.page)
            .getByRole("button", { name: "Show all 7 routines", exact: true })
            .click();
          await today(fixture.page).getByRole("link").nth(6).waitFor();
          assert.equal(await today(fixture.page).getByRole("link").count(), 7);
          await fixture.page.screenshot({
            path: path.join(output, `routines-activity-mobile-${width}.png`),
            fullPage: true,
          });
          await fits(fixture.page);
          const liveName = `${fixture.routines[0].name}: view live Run`;
          assert.equal(
            await running(fixture.page).getByRole("link", { name: liveName, exact: true }).count(),
            1,
          );
          await today(fixture.page)
            .getByRole("button", { name: "Show fewer", exact: true })
            .click();
          await today(fixture.page).getByRole("link").nth(5).waitFor({ state: "detached" });
          assert.equal(await today(fixture.page).getByRole("link").count(), 5);
        } finally {
          await fixture.close();
        }
      }
    },
  );
  assert.deepEqual(browserErrors, [], "browser must have no uncaught errors");
  assert.deepEqual(
    unexpectedRequests,
    [],
    "only expected fixture reads and socket auth are allowed",
  );
  console.log(`PASS ${checks} Routines activity browser regressions`);
} finally {
  await browser.close();
  await server.close();
}
