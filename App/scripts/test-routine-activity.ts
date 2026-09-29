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
import { chromium, type Page, type Route as BrowserRoute, type WebSocketRoute } from "playwright-core";
import type { CompanyTag, EmployeeSummary, RoutineFolder, RoutineWithMeta, Run, RunCheckResultList, RunEffectList } from "../client/lib/api";
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

const employees: EmployeeSummary[] = [
  { id: "jamie", slug: "jamie", name: "Jamie Mallers", role: "Support", avatarKey: null },
  { id: "alex", slug: "alex", name: "Alex Rivera", role: "Finance", avatarKey: null },
];

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
    standdown: null,
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
    controlledActivity?: boolean;
    lifecycle?: boolean;
    strictLifecycle?: boolean;
    evidence?: boolean;
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
  if (options.controlledActivity) {
    // Count fetch starts synchronously, so asserting no request was issued does
    // not depend on whether Playwright has delivered its route callback yet.
    await page.addInitScript(() => {
      const state = { started: 0, active: 0, maxActive: 0 };
      (window as unknown as { activityRequests: typeof state }).activityRequests = state;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!new URL(url, location.href).pathname.endsWith("/routines/activity"))
          return originalFetch(input, init);
        state.started += 1;
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        return originalFetch(input, init).finally(() => { state.active -= 1; });
      };
    });
  }
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
  const activityRoutes: BrowserRoute[] = [];
  const activityWaiters = new Map<number, () => void>();
  const evidenceRoutes: BrowserRoute[] = [];
  const evidenceWaiters = new Map<number, () => void>();
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
    if (request.method() === "POST" && /^\/api\/companies\/(company|other)\/workspace\/ws-token$/.test(url.pathname))
      return route.fulfill({ json: { token: "fixture" } });
    if (request.method() !== "GET") {
      unexpectedRequests.push(`Unexpected write: ${request.method()} ${url.pathname}`);
      return route.abort();
    }
    reads.push(url);
    if (options.evidence && /^\/api\/companies\/(company|other)\/routines\/runs\/run-[ab]\/(checks|effects)$/.test(url.pathname)) {
      evidenceRoutes.push(route);
      evidenceWaiters.get(evidenceRoutes.length)?.();
      return;
    }
    if (url.pathname === "/api/companies/company/routines")
      return route.fulfill({ json: data.routines });
    if (url.pathname === "/api/companies/company/employees")
      return route.fulfill({ json: employees });
    if (url.pathname === "/api/companies/company/routine-folders")
      return route.fulfill({ json: { folders, unfiledCount: 2, maxDepth: 5 } });
    if (/^\/api\/companies\/(company|other)\/routines\/activity$/.test(url.pathname)) {
      if (options.controlledActivity) {
        activityRoutes.push(route);
        activityWaiters.get(activityRoutes.length)?.();
        return;
      }
      if (options.holdActivity) await heldActivity;
      if (failed) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      return route.fulfill({ json: activity });
    }
    unexpectedRequests.push(`Unexpected read: ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  const search = options.evidence ? "?evidence" : options.lifecycle ? `?lifecycle${options.strictLifecycle ? "&strict" : ""}` : "";
  await page.goto(`${origin}/__routine_activity${search}`, { waitUntil: "commit", timeout: 60_000 });
  await (options.evidence
    ? page.getByTestId("evidence-identity")
    : options.lifecycle
    ? page.getByRole("button", { name: "Unmount activity", exact: true })
    : page.getByRole("textbox", { name: "Search routines", exact: true })
  ).waitFor({ timeout: 300_000 });
  if (!options.evidence) await page.locator('[data-socket-status="open"]').waitFor({ state: "attached" });
  return {
    page,
    reads,
    releaseActivity,
    waitForEvidence: async (count: number) => {
      if (evidenceRoutes.length >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Evidence request ${count} did not start`)), 15_000);
        evidenceWaiters.set(count, () => { clearTimeout(timeout); resolve(); });
      });
    },
    respondEvidence: async (batch: number, label: string, status = 200, count = 2) => {
      for (const index of [batch * 2, batch * 2 + 1]) {
        const route = evidenceRoutes[index];
        assert.ok(route, `Evidence request ${index + 1} must exist before responding`);
        const checks = new URL(route.request().url()).pathname.endsWith("/checks");
        const response = page.waitForResponse((value) => value.request() === route.request());
        await route.fulfill({ status, json: status === 200
          ? evidenceReply(checks, label, count)
          : { error: `${label} ${checks ? "Checks" : "Effects"} unavailable` } });
        await (await response).finished();
      }
      // Flush browser rendering after old replies, including ignored errors.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    },
    evidenceRequestCount: () => evidenceRoutes.length,
    waitForActivity: async (count: number) => {
      if (activityRoutes.length >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Activity request ${count} did not start`)), 15_000);
        activityWaiters.set(count, () => { clearTimeout(timeout); resolve(); });
      });
    },
    respondActivity: async (index: number, body: RoutineActivityData = activity, status = 200) => {
      const route = activityRoutes[index];
      assert.ok(route, `Activity request ${index + 1} must exist before responding`);
      const response = page.waitForResponse((value) => value.request() === route.request());
      await route.fulfill({ status, json: status === 200 ? body : { error: "Unavailable" } });
      await response;
    },
    requestCounts: () => page.evaluate(() =>
      (window as unknown as { activityRequests: { started: number; active: number; maxActive: number } }).activityRequests,
    ),
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

type RoutineLoadResource = "routines" | "employees" | "routine-folders";

/** The real layout, detail editor and index share these controlled responses. */
async function openRoutineLoading(options: {
  failed?: RoutineLoadResource;
  empty?: boolean;
  holdInitial?: boolean;
} = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.clock.setFixedTime(fixtureNow);
  await page.addInitScript(() => localStorage.setItem("genosyn.routineAssistant.open", "0"));
  const data = fixtures();
  let failed = options.failed;
  let holdLoads = options.holdInitial ?? false;
  let holdBriefs = false;
  const loads: BrowserRoute[] = [];
  const saves: BrowserRoute[] = [];
  const briefReads: BrowserRoute[] = [];
  const briefs = new Map([["company", "Original brief"], ["other", "Other company brief"]]);
  const sockets = new Set<WebSocketRoute>();
  const waiters = new Set<() => void>();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.routeWebSocket("**/api/ws?*", (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((message) => unexpectedRequests.push(`Unexpected socket write: ${message}`));
  });
  const parts = (route: BrowserRoute) => new URL(route.request().url()).pathname.split("/");
  const reply = async (route: BrowserRoute, failure?: RoutineLoadResource) => {
    const [, , , companyId, resource] = parts(route);
    const rows = companyId === "other"
      ? [{ ...data.routines[0], name: "Other company Routine", tags: [], folderId: null }]
      : options.empty ? [] : data.routines;
    const json = resource === "routines" ? rows : resource === "employees" ? employees : {
      folders: companyId === "other" || options.empty ? [] : folders,
      unfiledCount: 2,
      maxDepth: 5,
    };
    await route.fulfill({
      status: resource === failure ? 503 : 200,
      json: resource === failure ? { error: `${resource} temporarily unavailable` } : json,
    });
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpectedRequests.push(`External request: ${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST" && url.pathname.endsWith("/workspace/ws-token"))
      return route.fulfill({ json: { token: "fixture" } });
    if (request.method() === "PUT" && url.pathname.endsWith("/routines/inbox/readme")) {
      saves.push(route);
      for (const notify of waiters) notify();
      return;
    }
    if (request.method() !== "GET") {
      unexpectedRequests.push(`Unexpected write: ${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (/^\/api\/companies\/(company|other)\/(routines|employees|routine-folders)$/.test(url.pathname)) {
      if (holdLoads) {
        loads.push(route);
        for (const notify of waiters) notify();
        return;
      }
      return reply(route, failed);
    }
    if (/\/routines\/(inbox|invoices)\/readme$/.test(url.pathname)) {
      if (holdBriefs) {
        briefReads.push(route);
        for (const notify of waiters) notify();
        return;
      }
      return route.fulfill({ json: { content: url.pathname.endsWith("/inbox/readme")
        ? briefs.get(parts(route)[3]) : "Other Routine brief" } });
    }
    if (url.pathname.endsWith("/standdowns/active"))
      return route.fulfill({ json: { standdown: null } });
    if (url.pathname.endsWith("/tags")) return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/routines/activity"))
      return route.fulfill({ json: { running: [], today: [] } });
    unexpectedRequests.push(`Unexpected read: ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  const waitFor = async (ready: () => boolean) => {
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(notify);
        reject(new Error("The controlled Routine request did not start"));
      }, 15_000);
      const notify = () => {
        if (!ready()) return;
        clearTimeout(timer);
        waiters.delete(notify);
        resolve();
      };
      waiters.add(notify);
    });
  };
  await page.goto(`${origin}/__routine_activity?loading`, { waitUntil: "commit", timeout: 60_000 });
  await page.getByRole("button", { name: "Show brief", exact: true }).waitFor({ timeout: 300_000 });
  await page.locator('[data-socket-status="open"]').waitFor({ state: "attached" });
  return {
    page,
    editor: page.locator("textarea"),
    fail: (resource?: RoutineLoadResource) => { failed = resource; },
    hold: () => { holdLoads = true; },
    holdBriefs: () => { holdBriefs = true; },
    event: () => {
      for (const socket of sockets)
        socket.send(JSON.stringify({ type: "resource.changed", kind: "run", scopeIds: [] }));
    },
    waitForLoads: (count: number) => waitFor(() => loads.length >= count),
    loadCount: () => loads.length,
    respondLoads: async (batch: number, failure?: RoutineLoadResource) => {
      for (const route of loads.slice(batch * 3, batch * 3 + 3)) await reply(route, failure);
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    },
    waitForSave: (count: number) => waitFor(() => saves.length >= count),
    waitForBriefs: (count: number) => waitFor(() => briefReads.length >= count),
    respondBriefs: async (start: number, end: number, content: string, status = 200) => {
      for (const route of briefReads.slice(start, end))
        await route.fulfill({ status, json: status === 200 ? { content } : { error: content } });
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    },
    respondSave: async (index: number, status: number) => {
      const route = saves[index];
      assert.ok(route, "The save request must exist before acknowledgment");
      if (status === 200) briefs.set(parts(route)[3], route.request().postDataJSON().content);
      await route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "Brief save unavailable" } });
    },
    close: () => context.close(),
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

/** Polls, focus, visibility and separate socket bursts all arrive before a reply. */
async function refreshWhilePending(fixture: Awaited<ReturnType<typeof open>>) {
  await fixture.page.clock.fastForward(30_001);
  await fixture.page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  for (const kind of ["run", "routine"]) {
    fixture.event(kind);
    await fixture.page.clock.runFor(200);
  }
  await fixture.page.clock.fastForward(30_001);
}

function evidenceReply(checks: boolean, label: string, count: number): RunCheckResultList | RunEffectList {
  if (checks) return {
    runStatus: "completed",
    results: Array.from({ length: count }, (_, index) => ({
      id: `${label}-${index}`,
      runId: "fixture-run",
      checkId: null,
      name: `${label} Check ${index + 1}`,
      kind: "effect",
      required: true,
      passed: true,
      exitCode: null,
      detail: `${label} verified result ${index + 1}`,
      durationMs: 10,
      attempt: 0,
      createdAt: fixtureNow.toISOString(),
    })),
  };
  return {
    effects: [{ action: "note.update", targetType: "note", targetId: null, targetLabel: `${label} effect`, at: fixtureNow.toISOString() }],
    total: count + 1,
  };
}

async function assertEvidenceVisible(page: Page, label: string, count = 2) {
  await page.getByTestId("run-checks").getByText(`${label} Check 1`, { exact: true }).waitFor();
  await page.getByTestId("run-effects").getByText(`${label} effect`, { exact: true }).waitFor();
  assert.equal(await page.getByTestId("run-checks").getByText(`${count} result${count === 1 ? "" : "s"}`, { exact: true }).count(), 1);
  assert.equal(await page.getByTestId("run-effects").getByText(`${count + 1} recorded`, { exact: true }).count(), 1);
  assert.equal(await page.getByRole("alert").count(), 0);
}

async function assertEvidenceLoading(page: Page) {
  await page.getByTestId("run-effects").getByText("Loading effects…", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("run-checks").innerText(), "");
  assert.equal(await page.getByTestId("run-effects").getByText(/^\d+ recorded$/).count(), 0);
  assert.equal(await page.getByTestId("run-effects").getByText(/more not shown/).count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
}

try {
  await fs.mkdir(output, { recursive: true });
  for (const resource of ["routines", "employees", "routine-folders"] as const) {
    await check(`Routine loading initial ${resource} failure is retryable, not missing data`, async () => {
      const fixture = await openRoutineLoading({ failed: resource });
      try {
        await fixture.page.getByRole("alert").getByText("Could not load Routines.", { exact: true }).waitFor();
        assert.equal(await fixture.page.getByText("Routine not found", { exact: true }).count(), 0);
        await fixture.page.getByRole("button", { name: "Show Routines", exact: true }).click();
        assert.equal(await fixture.page.getByText("No routines yet", { exact: true }).count(), 0);
        fixture.fail();
        await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
        await fixture.page.getByRole("textbox", { name: "Search routines", exact: true }).waitFor();
        assert.equal(await fixture.page.getByRole("alert").count(), 0);
        await fixture.page.getByRole("button", { name: "Show brief", exact: true }).click();
        await fixture.editor.waitFor();
        assert.equal(await fixture.editor.inputValue(), "Original brief");
      } finally { await fixture.close(); }
    });
    await check(`Routine loading ${resource} refresh failure preserves sidebar and exact edited brief`, async () => {
      const fixture = await openRoutineLoading();
      try {
        await fixture.editor.waitFor();
        const editor = await fixture.editor.elementHandle();
        const sidebar = await fixture.page.locator("aside").innerText();
        const draft = `Edited ${resource} brief\n\nKeep every line and Unicode: café ✓.`;
        await fixture.editor.fill(draft);
        fixture.fail(resource);
        fixture.event();
        await fixture.page.getByRole("alert").getByText(/Could not refresh Routines/).waitFor();
        assert.equal(await editor!.evaluate((element) => element.isConnected), true);
        assert.equal(await fixture.editor.inputValue(), draft);
        assert.equal(await fixture.page.locator("aside").innerText(), sidebar);
        assert.equal(await fixture.page.getByText("Routine not found", { exact: true }).count(), 0);
        fixture.fail();
        await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
        await fixture.page.getByRole("alert").waitFor({ state: "detached" });
        assert.equal(await editor!.evaluate((element) => element.isConnected), true);
        assert.equal(await fixture.editor.inputValue(), draft);
        assert.equal(await fixture.page.getByText("Unsaved changes", { exact: true }).count(), 1);
      } finally { await fixture.close(); }
    });
  }
  await check("Routine loading refresh and failed save preserve newer editable text until acknowledged", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      await fixture.editor.fill("Submitted snapshot");
      await fixture.page.getByRole("button", { name: "Save brief", exact: true }).click();
      await fixture.waitForSave(1);
      await fixture.editor.fill("Newer edit while save is pending\nSecond line");
      fixture.fail("routine-folders");
      fixture.event();
      await fixture.page.getByRole("alert").getByText(/Could not refresh Routines/).waitFor();
      await fixture.respondSave(0, 503);
      await fixture.page.getByRole("alert").getByText("Brief save unavailable", { exact: true }).waitFor();
      assert.equal(await fixture.editor.inputValue(), "Newer edit while save is pending\nSecond line");
      assert.equal(await fixture.page.getByRole("button", { name: "Save brief", exact: true }).isEnabled(), true);
      fixture.fail();
      await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
      await fixture.page.getByText(/Could not refresh Routines/).waitFor({ state: "detached" });
      await fixture.page.getByRole("button", { name: "Save brief", exact: true }).click();
      await fixture.waitForSave(2);
      assert.equal(await fixture.page.getByText("Unsaved changes", { exact: true }).count(), 1);
      await fixture.respondSave(1, 200);
      await fixture.page.getByText("Unsaved changes", { exact: true }).waitFor({ state: "detached" });
      assert.equal(await fixture.page.getByRole("button", { name: "Save brief", exact: true }).isDisabled(), true);
      await fixture.page.getByRole("button", { name: "Show Routines", exact: true }).click();
      await fixture.page.getByRole("button", { name: "Show brief", exact: true }).click();
      await fixture.editor.waitFor();
      assert.equal(await fixture.editor.inputValue(), "Newer edit while save is pending\nSecond line");
    } finally { await fixture.close(); }
  });
  await check("Routine loading confirmed empty data and missing addresses keep their genuine empty states", async () => {
    const fixture = await openRoutineLoading({ empty: true });
    try {
      await fixture.page.getByText("Routine not found", { exact: true }).waitFor();
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
      await fixture.page.getByRole("button", { name: "Show Routines", exact: true }).click();
      await fixture.page.getByText("No routines yet", { exact: true }).waitFor();
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
    } finally { await fixture.close(); }
  });
  await check("Routine loading a successful save acknowledges only the submitted snapshot", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      await fixture.editor.fill("Submitted brief");
      await fixture.page.getByRole("button", { name: "Save brief", exact: true }).click();
      await fixture.waitForSave(1);
      await fixture.editor.fill("Newer unsaved brief");
      fixture.event();
      await fixture.respondSave(0, 200);
      await fixture.page.getByRole("button", { name: "Save brief", exact: true }).waitFor();
      assert.equal(await fixture.editor.inputValue(), "Newer unsaved brief");
      assert.equal(await fixture.page.getByRole("button", { name: "Save brief", exact: true }).isEnabled(), true);
      assert.equal(await fixture.page.getByText("Unsaved changes", { exact: true }).count(), 1);
    } finally { await fixture.close(); }
  });
  await check("Routine loading a genuine brief 404 stays an error and can be retried", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      fixture.holdBriefs();
      await fixture.page.getByRole("button", { name: "Show other brief", exact: true }).click();
      await fixture.waitForBriefs(2);
      await fixture.respondBriefs(0, 2, "Brief not found", 404);
      await fixture.page.getByRole("alert").getByText("Brief not found", { exact: true }).waitFor();
      assert.equal(await fixture.editor.count(), 0);
      assert.equal(await fixture.page.getByText("No routines yet", { exact: true }).count(), 0);
      await fixture.page.getByRole("button", { name: "Retry brief", exact: true }).click();
      await fixture.waitForBriefs(3);
      await fixture.respondBriefs(2, 3, "Recovered brief");
      await fixture.editor.waitFor();
      assert.equal(await fixture.editor.inputValue(), "Recovered brief");
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
    } finally { await fixture.close(); }
  });
  for (const oldFailure of [false, true]) {
    await check(`Routine loading company change rejects old ${oldFailure ? "failed" : "successful"} responses and drafts`, async () => {
      const fixture = await openRoutineLoading();
      try {
        await fixture.editor.waitFor();
        await fixture.editor.fill("Company private unsaved draft");
        fixture.hold();
        fixture.event();
        await fixture.waitForLoads(3);
        await fixture.page.getByRole("button", { name: "Switch Routine company", exact: true }).click();
        // StrictMode restarts the new keyed company's initial effect.
        await fixture.waitForLoads(9);
        assert.equal(await fixture.editor.count(), 0);
        assert.equal(await fixture.page.getByRole("heading", { name: "Inbox sweep", exact: true }).count(), 0);
        assert.equal(await fixture.page.locator("aside").getByText("Operations", { exact: true }).count(), 0);
        await fixture.respondLoads(2);
        await fixture.editor.waitFor();
        assert.equal(await fixture.editor.inputValue(), "Other company brief");
        await fixture.respondLoads(1, oldFailure ? "employees" : undefined);
        await fixture.respondLoads(0, oldFailure ? "routines" : undefined);
        assert.equal(await fixture.editor.inputValue(), "Other company brief");
        assert.equal(await fixture.page.getByRole("heading", { name: "Other company Routine", exact: true }).count(), 1);
        assert.equal(await fixture.page.getByRole("alert").count(), 0);
      } finally { await fixture.close(); }
    });
    await check(`Routine loading rapid brief navigation ignores delayed ${oldFailure ? "error" : "success"}`, async () => {
      const fixture = await openRoutineLoading();
      try {
        await fixture.editor.waitFor();
        await fixture.editor.fill("Previous Routine draft");
        fixture.holdBriefs();
        await fixture.page.getByRole("button", { name: "Show other brief", exact: true }).click();
        await fixture.waitForBriefs(2);
        assert.equal(await fixture.editor.count(), 0, "The previous brief cannot be saved under the next Routine");
        assert.equal(await fixture.page.getByRole("button", { name: "Save brief", exact: true }).count(), 0);
        await fixture.page.getByRole("button", { name: "Show brief", exact: true }).click();
        await fixture.waitForBriefs(4);
        await fixture.respondBriefs(2, 4, "Selected fresh brief");
        await fixture.editor.waitFor();
        await fixture.editor.fill("Selected unsaved edit");
        await fixture.respondBriefs(0, 2, "Obsolete other Routine reply", oldFailure ? 503 : 200);
        assert.equal(await fixture.editor.inputValue(), "Selected unsaved edit");
        assert.equal(await fixture.page.getByRole("alert").count(), 0);
        assert.equal(await fixture.page.getByText("Unsaved changes", { exact: true }).count(), 1);
      } finally { await fixture.close(); }
    });
  }
  await check("Routine loading StrictMode discards its obsolete initial failure", async () => {
    const fixture = await openRoutineLoading({ holdInitial: true });
    try {
      await fixture.waitForLoads(6);
      await fixture.respondLoads(1);
      await fixture.editor.waitFor();
      await fixture.editor.fill("Loaded editor draft");
      await fixture.respondLoads(0, "routines");
      assert.equal(await fixture.editor.inputValue(), "Loaded editor draft");
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
    } finally { await fixture.close(); }
  });
  await check("Routine loading slow refresh coalesces notifications without starving snapshots", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      fixture.hold();
      fixture.event();
      await fixture.waitForLoads(3);
      fixture.event();
      await fixture.page.waitForTimeout(160);
      fixture.event();
      await fixture.page.waitForTimeout(160);
      assert.equal(fixture.loadCount(), 3);
      await fixture.respondLoads(0, "employees");
      await fixture.waitForLoads(6);
      await fixture.page.getByRole("alert").getByText(/Could not refresh Routines/).waitFor();
      assert.equal(await fixture.editor.inputValue(), "Original brief");
      await fixture.respondLoads(1);
      await fixture.page.getByRole("alert").waitFor({ state: "detached" });
      assert.equal(fixture.loadCount(), 6);
    } finally { await fixture.close(); }
  });
  await check("Routine loading post-write callers await the next snapshot but not later notifications", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      fixture.hold();
      fixture.event();
      await fixture.waitForLoads(3);
      await fixture.page.getByRole("button", { name: "Await post-write refresh", exact: true }).click();
      await fixture.respondLoads(0);
      await fixture.waitForLoads(6);
      assert.equal(await fixture.page.getByTestId("routine-refresh-status").innerText(), "Waiting for post-write refresh");
      fixture.event();
      await fixture.page.waitForTimeout(160);
      await fixture.respondLoads(1);
      await fixture.waitForLoads(9);
      await fixture.page.getByTestId("routine-refresh-status").getByText("Post-write refresh settled", { exact: true }).waitFor();
      await fixture.respondLoads(2);
      assert.equal(await fixture.editor.inputValue(), "Original brief");
    } finally { await fixture.close(); }
  });
  await check("Routine loading failed refresh cannot confirm a missing address or discard its deep link", async () => {
    const fixture = await openRoutineLoading();
    try {
      await fixture.editor.waitFor();
      fixture.fail("routines");
      fixture.event();
      await fixture.page.getByRole("alert").getByText(/Could not refresh Routines/).waitFor();
      await fixture.page.getByRole("button", { name: "Show missing Routine", exact: true }).click();
      assert.equal(await fixture.page.getByText("Routine not found", { exact: true }).count(), 0);
      await fixture.page.getByRole("button", { name: "Show missing deep link", exact: true }).click();
      assert.equal(await fixture.page.getByRole("dialog").count(), 0);
      fixture.fail();
      await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
      await fixture.page.getByRole("dialog").getByText("Couldn’t open that routine", { exact: true }).waitFor();
    } finally { await fixture.close(); }
  });
  for (const identity of ["Run", "company"] as const) {
    await check(`Run evidence clears previous data and counts when changing ${identity}`, async () => {
      const fixture = await open({ evidence: true });
      try {
        await fixture.waitForEvidence(2);
        await fixture.respondEvidence(0, "Previous");
        await assertEvidenceVisible(fixture.page, "Previous");
        await fixture.page.getByRole("button", { name: `Switch evidence ${identity}`, exact: true }).click();
        await fixture.waitForEvidence(4);
        assert.ok(fixture.reads.slice(-2).every((url) => url.pathname.includes(identity === "Run" ? "/runs/run-b/" : "/companies/other/")));
        await assertEvidenceLoading(fixture.page);
        assert.equal(await fixture.page.getByTestId("run-evidence").getByText(/Previous/).count(), 0);
        await fixture.respondEvidence(1, "Selected", 200, 1);
        await assertEvidenceVisible(fixture.page, "Selected", 1);
        assert.equal(fixture.evidenceRequestCount(), 4);
      } finally {
        await fixture.close();
      }
    });
    await check(`Run evidence clears previous errors when changing ${identity}`, async () => {
      const fixture = await open({ evidence: true });
      try {
        await fixture.waitForEvidence(2);
        await fixture.respondEvidence(0, "Previous", 524);
        assert.equal(await fixture.page.getByRole("alert").count(), 2);
        await fixture.page.getByRole("button", { name: `Switch evidence ${identity}`, exact: true }).click();
        await fixture.waitForEvidence(4);
        await assertEvidenceLoading(fixture.page);
        assert.equal(await fixture.page.getByText(/Previous .* unavailable/).count(), 0);
        await fixture.respondEvidence(1, "Selected");
        await assertEvidenceVisible(fixture.page, "Selected");
      } finally {
        await fixture.close();
      }
    });
    for (const oldStatus of [200, 524]) {
      for (const oldFirst of [true, false]) {
        await check(`Run evidence ignores old ${oldStatus} reply ${oldFirst ? "before" : "after"} the new ${identity} reply`, async () => {
          const fixture = await open({ evidence: true });
          try {
            await fixture.waitForEvidence(2);
            await fixture.respondEvidence(0, "Previous");
            await assertEvidenceVisible(fixture.page, "Previous");
            await fixture.page.getByRole("button", { name: "Reload evidence", exact: true }).click();
            await fixture.waitForEvidence(4);
            await fixture.page.getByRole("button", { name: `Switch evidence ${identity}`, exact: true }).click();
            await fixture.waitForEvidence(6);
            await assertEvidenceLoading(fixture.page);
            if (oldFirst) {
              await fixture.respondEvidence(1, "Obsolete", oldStatus);
              await assertEvidenceLoading(fixture.page);
            }
            await fixture.respondEvidence(2, "Selected", 200, 1);
            await assertEvidenceVisible(fixture.page, "Selected", 1);
            if (!oldFirst) await fixture.respondEvidence(1, "Obsolete", oldStatus);
            await assertEvidenceVisible(fixture.page, "Selected", 1);
            assert.equal(await fixture.page.getByTestId("run-evidence").getByText(/Previous|Obsolete/).count(), 0);
            assert.equal(fixture.evidenceRequestCount(), 6);
          } finally {
            await fixture.close();
          }
        });
      }
    }
  }
  await check("Run evidence keeps same-Run results visible until its reload settles", async () => {
    const fixture = await open({ evidence: true });
    try {
      await fixture.waitForEvidence(2);
      await fixture.respondEvidence(0, "Existing");
      await assertEvidenceVisible(fixture.page, "Existing");
      await fixture.page.getByRole("button", { name: "Reload evidence", exact: true }).click();
      await fixture.waitForEvidence(4);
      await assertEvidenceVisible(fixture.page, "Existing");
      assert.equal(await fixture.page.getByText("Loading effects…", { exact: true }).count(), 0);
      await fixture.respondEvidence(1, "Updated", 200, 1);
      await assertEvidenceVisible(fixture.page, "Updated", 1);
      assert.equal(await fixture.page.getByText(/Existing/).count(), 0);
      assert.equal(fixture.evidenceRequestCount(), 4);
    } finally {
      await fixture.close();
    }
  });
  await check("Run evidence ignores late errors after unmount and loads cleanly on remount", async () => {
    const fixture = await open({ evidence: true });
    try {
      await fixture.waitForEvidence(2);
      await fixture.page.getByRole("button", { name: "Unmount evidence", exact: true }).click();
      await fixture.respondEvidence(0, "Unmounted", 524);
      assert.equal(await fixture.page.getByTestId("run-evidence").count(), 0);
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
      await fixture.page.getByRole("button", { name: "Mount evidence", exact: true }).click();
      await fixture.waitForEvidence(4);
      await assertEvidenceLoading(fixture.page);
      await fixture.respondEvidence(1, "Remounted");
      await assertEvidenceVisible(fixture.page, "Remounted");
      assert.equal(fixture.evidenceRequestCount(), 4);
    } finally {
      await fixture.close();
    }
  });
  await check("slow activity success stays visible while refreshes coalesce", async () => {
    const fixture = await open({ lifecycle: true, controlledActivity: true, tickingClock: true });
    try {
      await fixture.waitForActivity(1);
      await refreshWhilePending(fixture);
      assert.deepEqual(await fixture.requestCounts(), { started: 1, active: 1, maxActive: 1 });
      await fixture.respondActivity(0);
      await running(fixture.page).waitFor();
      await fixture.waitForActivity(2);
      assert.deepEqual(await fixture.requestCounts(), { started: 2, active: 1, maxActive: 1 });
      assert.equal(await fixture.page.getByText("Loading recent Runs…", { exact: true }).count(), 0);
      await fixture.respondActivity(1, { running: [], today: [] });
      await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
      await fixture.page.clock.runFor(200);
      assert.deepEqual(await fixture.requestCounts(), { started: 2, active: 0, maxActive: 1 });
    } finally {
      await fixture.close();
    }
  });
  await check("slow activity errors stay retryable while refreshes coalesce", async () => {
    const fixture = await open({ lifecycle: true, controlledActivity: true, tickingClock: true });
    try {
      await fixture.waitForActivity(1);
      await refreshWhilePending(fixture);
      assert.equal((await fixture.requestCounts()).started, 1);
      await fixture.respondActivity(0, undefined, 524);
      await fixture.page.getByRole("alert").waitFor();
      await fixture.waitForActivity(2);
      assert.equal(await today(fixture.page).count(), 0);
      await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
      await fixture.page.getByRole("button", { name: "Try again", exact: true }).click();
      assert.deepEqual(await fixture.requestCounts(), { started: 2, active: 1, maxActive: 1 });
      await fixture.respondActivity(1);
      await running(fixture.page).waitFor();
      await fixture.waitForActivity(3);
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
      await fixture.respondActivity(2);
      await fixture.page.clock.runFor(200);
      assert.deepEqual(await fixture.requestCounts(), { started: 3, active: 0, maxActive: 1 });
    } finally {
      await fixture.close();
    }
  });
  await check("StrictMode effect restart keeps one usable slow activity request", async () => {
    const fixture = await open({ lifecycle: true, strictLifecycle: true, controlledActivity: true, tickingClock: true });
    try {
      await fixture.waitForActivity(1);
      await refreshWhilePending(fixture);
      assert.deepEqual(await fixture.requestCounts(), { started: 1, active: 1, maxActive: 1 });
      await fixture.respondActivity(0);
      await running(fixture.page).waitFor();
      await fixture.waitForActivity(2);
      await fixture.respondActivity(1, { running: [], today: [] });
      await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
      await fixture.page.clock.runFor(200);
      assert.deepEqual(await fixture.requestCounts(), { started: 2, active: 0, maxActive: 1 });
    } finally {
      await fixture.close();
    }
  });
  await check("unmount discards a slow activity response and its pending refresh", async () => {
    const fixture = await open({ lifecycle: true, controlledActivity: true, tickingClock: true });
    try {
      await fixture.waitForActivity(1);
      await refreshWhilePending(fixture);
      await fixture.page.getByRole("button", { name: "Unmount activity", exact: true }).click();
      await fixture.respondActivity(0, undefined, 524);
      await refreshWhilePending(fixture);
      assert.deepEqual(await fixture.requestCounts(), { started: 1, active: 0, maxActive: 1 });
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
      assert.equal(await today(fixture.page).count(), 0);
      await fixture.page.getByRole("button", { name: "Mount activity", exact: true }).click();
      await fixture.waitForActivity(2);
      await fixture.respondActivity(1, { running: [], today: [] });
      await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
    } finally {
      await fixture.close();
    }
  });
  for (const oldStatus of [200, 524]) {
    await check(`company change discards old activity data, ${oldStatus} reply and pending refresh`, async () => {
      const fixture = await open({ lifecycle: true, controlledActivity: true, tickingClock: true });
      try {
        await fixture.waitForActivity(1);
        await fixture.respondActivity(0);
        await running(fixture.page).waitFor();
        await fixture.page.clock.fastForward(30_001);
        await fixture.waitForActivity(2);
        await refreshWhilePending(fixture);
        await fixture.page.getByRole("button", { name: "Switch company", exact: true }).click();
        await fixture.waitForActivity(3);
        await fixture.page.getByText("Loading recent Runs…", { exact: true }).waitFor();
        assert.equal(await running(fixture.page).count(), 0, "the previous company's snapshot must not remain visible");
        await fixture.respondActivity(2, { running: [], today: [] });
        await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
        await fixture.respondActivity(1, undefined, oldStatus);
        await fixture.page.clock.runFor(200);
        assert.equal(await running(fixture.page).count(), 0);
        assert.equal(await fixture.page.getByRole("alert").count(), 0);
        assert.equal((await fixture.requestCounts()).started, 3, "old-company pending work must not refetch");
        await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
      } finally {
        await fixture.close();
      }
    });
  }
  await check("company change hides the previous company's activity error immediately", async () => {
    const fixture = await open({ lifecycle: true, controlledActivity: true, tickingClock: true });
    try {
      await fixture.waitForActivity(1);
      await fixture.respondActivity(0, undefined, 524);
      await fixture.page.getByRole("alert").waitFor();
      await fixture.page.getByRole("button", { name: "Switch company", exact: true }).click();
      await fixture.waitForActivity(2);
      await fixture.page.getByText("Loading recent Runs…", { exact: true }).waitFor();
      assert.equal(await fixture.page.getByRole("alert").count(), 0);
      await fixture.respondActivity(1, { running: [], today: [] });
      await today(fixture.page).getByText(/No routines have finished a Run today/).waitFor();
    } finally {
      await fixture.close();
    }
  });
  for (const width of [1440, 375]) {
    await check(
      `continuation link keeps the historical badge and opens the current child at ${width}px`,
      async () => {
        const fixture = await open({ width });
        try {
          const child = {
            ...run("inbox-continuation", "inbox", {
              status: "running",
              finishedAt: null,
              exitCode: null,
            }),
            triggerKind: "continuation" as const,
            continuationCount: 1,
            retryPending: false,
            awaitingOutcome: false,
            isLatest: true,
          };
          const parent = run("inbox-parent", "inbox", {
            status: "failed",
            checksVerdict: "failed",
            outcomeVerdict: "unverified",
            followUpRun: child,
          });
          fixture.setActivity({
            running: [child],
            today: [{ routineId: "inbox", runCount: 1, latestRun: parent }],
          });
          fixture.event();
          const related = today(fixture.page).getByRole("link", {
            name: "Continuation running · Open continuation",
            exact: true,
          });
          await related.waitFor();
          await today(fixture.page).getByText("failed", { exact: true }).waitFor();
          await today(fixture.page).getByText("checks failed", { exact: true }).waitFor();
          assert.equal(
            await related.getAttribute("href"),
            "/c/company/routines/jamie/inbox?run=inbox-continuation",
          );
          await fits(fixture.page);
          await related.click();
          assert.equal(
            await fixture.page.getByLabel("Opened route", { exact: true }).innerText(),
            "/c/company/routines/jamie/inbox?run=inbox-continuation",
          );
        } finally {
          await fixture.close();
        }
      },
    );
  }
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
