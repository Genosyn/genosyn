/**
 * Run with `npm run test:home-repository-work`; local Chrome or
 * GENOSYN_TEST_BROWSER. Drives production Home with deterministic API fixtures.
 * No external services or writes, apart from a mocked company socket token.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import type { HomeData, HomeRepositoryWork } from "../client/lib/api";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixtureNow = new Date("2026-09-09T09:00:00.000Z");
const browserErrors: string[] = [];
const unexpectedRequests: string[] = [];
const timeoutScale = Math.max(1, Number(process.env.GENOSYN_BROWSER_TIMEOUT_SCALE ?? 1));
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18482, strictPort: false, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-home-repository-work"),
  plugins: [
    {
      name: "home-repository-work-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__home_repository_work", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__home_repository_work",
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
if (server.httpServer && timeoutScale > 1) {
  // A heavily loaded local machine can starve Vite long enough for Node's
  // header timeout to become an unrelated 400 on an otherwise valid module.
  server.httpServer.headersTimeout = 300000 * timeoutScale;
  server.httpServer.requestTimeout = 300000 * timeoutScale;
}
server.httpServer?.on("clientError", (error) => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ECONNRESET") console.error("Browser fixture HTTP error:", code, error.message);
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
context.setDefaultTimeout(15000 * timeoutScale);

function sessions(count = 4, longNames = false): HomeRepositoryWork[] {
  const statuses = ["ready", "proposed", "failed", "empty"] as const;
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    title: longNames
      ? `Review ${"UnbrokenQuarterlyPlanningTitle".repeat(8)} ${index + 1}`
      : [
          "Improve the signup flow",
          "Update operating policies",
          "Fix release validation",
          "Investigate the customer report",
        ][index % 4] + ` ${index + 1}`,
    status: statuses[index % statuses.length],
    filesChanged: index % 4 === 3 ? 0 : index + 1,
    insertions: index + 12,
    deletions: index + 2,
    // A pull request survives a later failed revision, whose status is no
    // longer `proposed`; Home still has to warn about that remote work.
    hasPullRequest: index % 4 === 1 || index % 4 === 2,
    updatedAt: fixtureNow.toISOString(),
    repository: {
      id: `repository-${index % 2}`,
      name: longNames
        ? "InternationalOperationsAndProductRepository".repeat(8)
        : index % 2
          ? "Company policies"
          : "Customer app",
      slug: index % 2 ? "company-policies" : "customer-app",
      kind: index % 2 ? "documents" : "code",
    },
    employee:
      index % 4 === 3
        ? null
        : {
            id: "employee-1",
            slug: "jamie",
            name: longNames ? "AlexandriaRiveraMontgomery".repeat(8) : "Jamie Mallers",
            avatarKey: null,
          },
  }));
}

function homeData(items: HomeRepositoryWork[]): HomeData {
  return {
    repositoryWork: items.slice(0, 8),
    repositoryWorkCount: items.length,
    draftEmails: [],
    draftEmailCount: 0,
    draftEmailAccounts: [],
    starredEmailCount: 0,
    starredEmailAccounts: [],
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
    unreadChannels: [],
    failedRuns: [],
    failedRunCount: 0,
    tldrs: [],
    unreadTldrCount: 0,
    systemHealth: { status: "ok", issueCount: 0, checks: [] },
    counts: { employees: 1, projects: 1 },
  };
}

async function open(
  options: {
    count?: number;
    width?: number;
    dark?: boolean;
    longNames?: boolean;
    homeError?: boolean;
    paginationError?: boolean;
    discardError?: boolean;
    holdDiscard?: boolean;
    holdPagination?: boolean;
    live?: boolean;
  } = {},
) {
  const page = await context.newPage();
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 });
  await page.emulateMedia({
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  await page.clock.setFixedTime(fixtureNow);
  await page.addInitScript(() => localStorage.setItem("genosyn.pushPromptDismissed", "1"));
  let items = sessions(options.count, options.longNames);
  let homeError = options.homeError ?? false;
  let paginationError = options.paginationError ?? false;
  let discardError = options.discardError ?? false;
  let releasePagination: () => void = () => {};
  const paginationGate = new Promise<void>((resolve) => {
    releasePagination = resolve;
  });
  let releaseDiscard: () => void = () => {};
  const discardGate = new Promise<void>((resolve) => {
    releaseDiscard = resolve;
  });
  let holdRefresh = false;
  let releaseRefresh: () => void = () => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const reads: string[] = [];
  const posts: string[] = [];
  const sockets: WebSocketRoute[] = [];
  if (options.live) {
    await page.routeWebSocket(`${origin.replace(/^http/, "ws")}/api/ws?token=*`, (socket) => {
      sockets.push(socket);
    });
  }
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
    console.error("Browser error:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error("Browser console:", message.text(), message.location());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith("/api/")) {
      const failure = `${response.status()} ${response.url()}`;
      browserErrors.push(failure);
      console.error("Browser asset failure:", failure);
      void response
        .text()
        .then((body) => console.error("Browser asset response:", body.slice(0, 1000)))
        .catch(() => {});
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      options.live &&
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/companies/company/workspace/ws-token"
    ) {
      return route.fulfill({ json: { token: "fixture-token" } });
    }
    const discardMatch = url.pathname.match(
      /^\/api\/companies\/company\/repositories\/([^/]+)\/sessions\/([^/]+)\/discard$/,
    );
    if (url.origin === origin && request.method() === "POST" && discardMatch) {
      posts.push(url.pathname);
      if (options.holdDiscard) await discardGate;
      if (discardError) {
        return route.fulfill({
          status: 503,
          json: { error: "Repository work is temporarily unavailable." },
        });
      }
      const [, repositorySlug, sessionId] = discardMatch;
      const item = items.find(
        (row) => row.id === sessionId && row.repository.slug === repositorySlug,
      );
      if (!item) return route.fulfill({ status: 404, json: { error: "Work session not found." } });
      items = items.filter((row) => row.id !== sessionId);
      return route.fulfill({ json: { ...item, status: "discarded" } });
    }
    if (url.origin !== origin || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    reads.push(url.pathname + url.search);
    if (url.pathname === "/api/companies/company/home")
      return route.fulfill(
        homeError
          ? { status: 503, json: { error: "Home is temporarily unavailable." } }
          : { json: homeData(items) },
      );
    if (url.pathname === "/api/companies/company/home/repository-work") {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 50);
      // Snapshot before the gate to simulate a late response from an old queue.
      const next = { items: items.slice(offset, offset + limit), total: items.length };
      if (options.holdPagination) await paginationGate;
      if (holdRefresh) await refreshGate;
      return route.fulfill(
        paginationError
          ? { status: 503, json: { error: "Repository work is temporarily unavailable." } }
          : { json: next },
      );
    }
    if (
      url.pathname === "/api/companies/company/employees" ||
      url.pathname === "/api/companies/company/members"
    ) {
      return route.fulfill({ json: [] });
    }
    if (url.pathname === "/api/companies/company/work-timeline") {
      return route.fulfill({
        json: {
          since: url.searchParams.get("since"),
          until: url.searchParams.get("until"),
          employeeId: null,
          entries: [],
          entryCount: 0,
          employeeSummaries: [],
        },
      });
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(`${origin}/__home_repository_work${options.live ? "?live=1" : ""}`, {
    waitUntil: "commit",
    timeout: 60000 * timeoutScale,
  });
  await page
    .locator('header[aria-label="Home greeting"]')
    .waitFor({ timeout: 300000 * timeoutScale });
  if (homeError)
    await page.getByText("Home is temporarily unavailable.", { exact: true }).waitFor();
  else
    await page
      .getByRole("heading", {
        name: items.length ? "Repository AI work" : "Nothing needs you right now",
        exact: true,
      })
      .waitFor();
  if (options.live)
    await page.locator('[data-socket-status="open"]').waitFor({ state: "attached" });
  return {
    page,
    reads,
    posts,
    releaseDiscard,
    releasePagination,
    releaseRefresh,
    holdRefresh: () => {
      holdRefresh = true;
    },
    recover: () => {
      homeError = false;
      paginationError = false;
      discardError = false;
    },
    failHomeRefresh: () => {
      homeError = true;
    },
    clearWork: () => {
      items = [];
    },
    keepFirstWork: () => {
      items = items.slice(0, 1);
    },
    emitRepositoryEvent: () => {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            type: "resource.changed",
            kind: "repository",
            scopeIds: [],
          }),
        );
    },
  };
}

const card = (page: Page) => page.getByRole("region", { name: "Repository AI work", exact: true });
const rows = (page: Page) => card(page).getByRole("listitem");
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "page must not scroll horizontally",
  );
  for (const locator of [page.locator("#main-content"), card(page), ...(await rows(page).all())]) {
    assert.equal(
      await locator.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
      "Home, repository card and every row must fit without hidden horizontal overflow",
    );
  }
}

let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GENOSYN_HOME_TEST_FILTER && !name.includes(process.env.GENOSYN_HOME_TEST_FILTER))
    return;
  console.log(`RUN ${name}`);
  try {
    await run();
  } catch (error) {
    const page = context.pages().at(-1);
    if (browserErrors.length) console.error("Browser errors:", browserErrors);
    if (unexpectedRequests.length) console.error("Unexpected requests:", unexpectedRequests);
    if (page)
      await page
        .screenshot({
          path: path.join(output, "home-repository-work-failure.png"),
          fullPage: true,
          timeout: 5000,
        })
        .catch(() => {});
    throw error;
  }
  checks++;
  console.log(`PASS ${name}`);
}

try {
  await fs.mkdir(output, { recursive: true });
  await check("initial Home failure offers Retry and recovers the repository queue", async () => {
    const fixture = await open({ homeError: true });
    assert.equal(await card(fixture.page).count(), 0);
    assert.equal(
      await fixture.page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .count(),
      0,
    );
    assert.equal(await fixture.page.locator("#main-content .animate-spin").count(), 0);
    fixture.recover();
    await fixture.page.getByRole("button", { name: "Retry", exact: true }).click();
    await rows(fixture.page).nth(3).waitFor();
    assert.equal(
      await fixture.page.getByText("Home is temporarily unavailable.", { exact: true }).count(),
      0,
    );
    assert.equal(await fixture.page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
    await fixture.page.close();
  });
  await check(
    "repository-only attention replaces all-clear and presents all four outcomes",
    async () => {
      const { page } = await open();
      assert.equal(
        await page
          .getByRole("heading", { name: "Nothing needs you right now", exact: true })
          .count(),
        0,
      );
      assert.equal(await rows(page).count(), 4);
      for (const label of ["Ready to review", "Pull request open", "Failed", "No changes made"]) {
        await card(page).getByText(label, { exact: true }).waitFor();
      }
      assert.equal(await card(page).getByText("Review work", { exact: true }).count(), 2);
      assert.equal(await card(page).getByText("Open session", { exact: true }).count(), 2);
      assert.equal(await card(page).getByRole("button", { name: /^Throw away / }).count(), 4);
      await rows(page).first().getByText("· 1 file · +12 −2", { exact: true }).waitFor();
      await fits(page);
      await page.screenshot({
        path: path.join(output, "home-repository-work-desktop.png"),
        fullPage: true,
      });
      await page.close();
    },
  );
  await check(
    "each work row opens its exact repository session, including document repositories",
    async () => {
      for (const [index, item] of sessions().entries()) {
        const { page } = await open();
        const expected = `/c/company/repositories/${item.repository.slug}/ai/${item.id}`;
        const row = rows(page).nth(index);
        const link = row.getByRole("link");
        assert.equal(await link.getAttribute("href"), expected);
        assert.equal(
          await row
            .getByRole("button", { name: `Throw away ${item.title}`, exact: true })
            .evaluate((button) => button.closest("a") === null),
          true,
          "the destructive action must not be nested inside row navigation",
        );
        await link.focus();
        await page.keyboard.press("Enter");
        await page.getByLabel("Opened route", { exact: true }).waitFor();
        assert.equal(await page.getByLabel("Opened route", { exact: true }).innerText(), expected);
        await page.close();
      }
      const { page } = await open();
      await card(page).getByRole("link", { name: "All repositories", exact: true }).click();
      assert.equal(
        await page.getByLabel("Opened route", { exact: true }).innerText(),
        "/c/company/repositories",
      );
      await page.close();
    },
  );
  await check("throw-away confirmations explain local work and existing pull requests", async () => {
    const fixture = await open();
    const first = rows(fixture.page).first();
    await first.getByRole("button", { name: /^Throw away / }).click();
    await fixture.page
      .getByRole("heading", { name: "Throw this work away?", exact: true })
      .waitFor();
    await fixture.page
      .getByText(
        "Nothing changed by Jamie Mallers is merged into Customer app. The local session branch is removed. Any remote branch or pull request created for this work stays open. The work session stays in Repository history.",
        { exact: true },
      )
      .waitFor();
    await fixture.page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(fixture.posts.length, 0, "cancelling must leave the work untouched");
    assert.equal(await rows(fixture.page).count(), 4);

    const proposed = rows(fixture.page).nth(1);
    await proposed.getByRole("button", { name: /^Throw away / }).click();
    await fixture.page
      .getByText(
        "The local session branch is removed, but the existing pull request and its remote branch are not closed or deleted. The work session stays in Repository history.",
        { exact: true },
      )
      .waitFor();
    await fixture.page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(fixture.posts.length, 0);

    const failedRevision = rows(fixture.page).nth(2);
    await failedRevision.getByRole("button", { name: /^Throw away / }).click();
    await fixture.page
      .getByText(
        "The local session branch is removed, but the existing pull request and its remote branch are not closed or deleted. The work session stays in Repository history.",
        { exact: true },
      )
      .waitFor();
    await fixture.page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(fixture.posts.length, 0);
    await fixture.page.close();
  });
  await check("throwing work away posts to its exact Repository and removes only that row", async () => {
    const fixture = await open();
    const item = sessions()[2];
    const row = rows(fixture.page).nth(2);
    await row.getByRole("button", { name: /^Throw away / }).click();
    const request = fixture.page.waitForRequest(
      (value) => value.method() === "POST" && value.url().endsWith(`/${item.id}/discard`),
    );
    await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
    await request;
    await fixture.page.getByText(item.title, { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(fixture.posts, [
      `/api/companies/company/repositories/${item.repository.slug}/sessions/${item.id}/discard`,
    ]);
    assert.equal(await rows(fixture.page).count(), 3);
    assert.equal(await card(fixture.page).getByText("3", { exact: true }).count(), 1);
    assert.equal(await fixture.page.getByLabel("Opened route", { exact: true }).count(), 0);
    await fixture.page.close();
  });
  await check("a pending throw-away cannot be submitted twice", async () => {
    const fixture = await open({ holdDiscard: true });
    try {
      await rows(fixture.page)
        .first()
        .getByRole("button", { name: /^Throw away / })
        .click();
      const request = fixture.page.waitForRequest(
        (value) => value.method() === "POST" && value.url().endsWith("/session-1/discard"),
      );
      await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
      await request;
      await rows(fixture.page).first().locator(".animate-spin").waitFor();
      const buttons = card(fixture.page).getByRole("button", { name: /^Throw away / });
      assert.equal(await buttons.count(), 4);
      for (const button of await buttons.all()) assert.equal(await button.isDisabled(), true);
      assert.equal(await rows(fixture.page).first().locator(".animate-spin").count(), 1);
      assert.equal(fixture.posts.length, 1);
      fixture.releaseDiscard();
      await fixture.page
        .getByText(sessions()[0].title, { exact: true })
        .waitFor({ state: "detached" });
      assert.equal(fixture.posts.length, 1);
    } finally {
      fixture.releaseDiscard();
      await fixture.page.close();
    }
  });
  await check("throwing away the last item restores Home's all-clear state", async () => {
    const fixture = await open({ count: 1 });
    await rows(fixture.page)
      .first()
      .getByRole("button", { name: /^Throw away / })
      .click();
    await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
    await fixture.page
      .getByRole("heading", { name: "Nothing needs you right now", exact: true })
      .waitFor();
    assert.equal(await card(fixture.page).count(), 0);
    assert.equal(fixture.posts.length, 1);
    await fixture.page.close();
  });
  await check("a failed throw-away keeps the row, explains the error, and can be retried", async () => {
    const fixture = await open({ discardError: true });
    const item = sessions()[0];
    await rows(fixture.page)
      .first()
      .getByRole("button", { name: /^Throw away / })
      .click();
    await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
    await fixture.page
      .getByRole("heading", { name: "Couldn’t throw the work away", exact: true })
      .waitFor();
    await fixture.page
      .getByText("Repository work is temporarily unavailable.", { exact: true })
      .waitFor();
    assert.equal(await fixture.page.getByText(item.title, { exact: true }).count(), 1);
    assert.equal(await rows(fixture.page).count(), 4);
    await fixture.page.getByText("Close", { exact: true }).click();

    fixture.recover();
    await rows(fixture.page)
      .first()
      .getByRole("button", { name: /^Throw away / })
      .click();
    await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
    await fixture.page.getByText(item.title, { exact: true }).waitFor({ state: "detached" });
    assert.equal(fixture.posts.length, 2);
    await fixture.page.close();
  });
  await check("show more appends the next page and removes the exhausted control", async () => {
    const fixture = await open({ count: 12, holdPagination: true });
    try {
      assert.equal(await rows(fixture.page).count(), 8);
      await card(fixture.page)
        .getByRole("button", { name: "Show more (4 remaining)", exact: true })
        .click();
      await card(fixture.page).getByRole("button", { name: "Loading…", exact: true }).waitFor();
      assert.equal(
        await card(fixture.page)
          .getByRole("button", { name: "Loading…", exact: true })
          .isDisabled(),
        true,
      );
      fixture.releasePagination();
      await rows(fixture.page).nth(11).waitFor();
      assert.equal(await rows(fixture.page).count(), 12);
      assert.equal(
        await card(fixture.page).getByRole("button", { name: /Show more|Loading|Try again/ }).count(),
        0,
      );
      assert.equal(
        fixture.reads.filter((url) => url.includes("repository-work?offset=8&limit=8")).length,
        1,
      );
    } finally {
      fixture.releasePagination();
      await fixture.page.close();
    }
  });
  await check("show-more failure keeps existing work and retries the same page", async () => {
    const fixture = await open({ count: 12, paginationError: true });
    await card(fixture.page)
      .getByRole("button", { name: "Show more (4 remaining)", exact: true })
      .click();
    await card(fixture.page)
      .getByText("Repository work is temporarily unavailable.", { exact: true })
      .waitFor();
    assert.equal(await rows(fixture.page).count(), 8);
    fixture.recover();
    await card(fixture.page).getByRole("button", { name: "Try again", exact: true }).click();
    await rows(fixture.page).nth(11).waitFor();
    assert.equal(
      await card(fixture.page)
        .getByText("Repository work is temporarily unavailable.", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      fixture.reads.filter((url) => url.includes("repository-work?offset=8&limit=8")).length,
      2,
    );
    await fixture.page.close();
  });
  await check("throwing away expanded work preserves every remaining page", async () => {
    const fixture = await open({ count: 12 });
    await card(fixture.page)
      .getByRole("button", { name: "Show more (4 remaining)", exact: true })
      .click();
    await rows(fixture.page).nth(11).waitFor();

    const removed = sessions(12)[0];
    await rows(fixture.page)
      .first()
      .getByRole("button", { name: /^Throw away / })
      .click();
    const refill = fixture.page.waitForResponse((value) =>
      value.url().includes("/home/repository-work?offset=8&limit=3"),
    );
    await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
    await (await refill).finished();
    await fixture.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await fixture.page.getByText(removed.title, { exact: true }).waitFor({ state: "detached" });
    await rows(fixture.page).nth(10).waitFor();
    assert.equal(await rows(fixture.page).count(), 11);
    assert.deepEqual(
      await rows(fixture.page).getByRole("link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href")),
      ),
      sessions(12)
        .slice(1)
        .map((item) => `/c/company/repositories/${item.repository.slug}/ai/${item.id}`),
    );
    assert.equal(
      await card(fixture.page).getByRole("button", { name: /Show more/ }).count(),
      0,
    );
    await fixture.page.close();
  });
  await check("a late page cannot undo a throw-away when the Home refresh fails", async () => {
    const fixture = await open({ count: 12, holdPagination: true });
    try {
      const staleRequest = fixture.page.waitForRequest((value) =>
        value.url().includes("repository-work?offset=8"),
      );
      await card(fixture.page)
        .getByRole("button", { name: "Show more (4 remaining)", exact: true })
        .click();
      await staleRequest;
      fixture.failHomeRefresh();

      const removed = sessions(12)[0];
      await rows(fixture.page)
        .first()
        .getByRole("button", { name: /^Throw away / })
        .click();
      await fixture.page.getByRole("button", { name: "Throw it away", exact: true }).click();
      await fixture.page
        .getByText("Home is temporarily unavailable.", { exact: true })
        .waitFor();
      await fixture.page.getByText(removed.title, { exact: true }).waitFor({ state: "detached" });
      assert.equal(await rows(fixture.page).count(), 7);

      const staleResponse = fixture.page.waitForResponse((value) =>
        value.url().includes("repository-work?offset=8"),
      );
      fixture.releasePagination();
      await (await staleResponse).finished();
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      assert.equal(await rows(fixture.page).count(), 7);
      assert.equal(await fixture.page.getByText(removed.title, { exact: true }).count(), 0);

      await card(fixture.page)
        .getByRole("button", { name: "Show more (4 remaining)", exact: true })
        .click();
      await rows(fixture.page).nth(10).waitFor();
      assert.equal(await rows(fixture.page).count(), 11);
      assert.equal(await card(fixture.page).getByRole("button", { name: /Show more/ }).count(), 0);
    } finally {
      fixture.releasePagination();
      await fixture.page.close();
    }
  });
  for (const width of [1440, 390, 320]) {
    await check(`long repository work and metadata fit at ${width}px in dark mode`, async () => {
      const { page } = await open({ width, dark: true, longNames: true });
      assert.equal(
        await page.locator("html").evaluate((element) => element.classList.contains("dark")),
        true,
      );
      await fits(page);
      await page.screenshot({
        path: path.join(output, `home-repository-work-dark-${width}.png`),
        fullPage: true,
      });
      await page.close();
    });
  }
  for (const trigger of ["focus", "repository event"] as const) {
    await check(`${trigger} refresh preserves the expanded queue while reloading`, async () => {
      const fixture = await open({ count: 12, live: trigger === "repository event" });
      try {
        await card(fixture.page)
          .getByRole("button", { name: "Show more (4 remaining)", exact: true })
          .click();
        await rows(fixture.page).nth(11).waitFor();
        fixture.holdRefresh();
        const request = fixture.page.waitForRequest((value) =>
          value.url().includes("/home/repository-work?"),
        );
        if (trigger === "focus")
          await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
        else fixture.emitRepositoryEvent();
        await request;
        assert.equal(
          await rows(fixture.page).count(),
          12,
          "a background refresh must leave the Member's expanded work available",
        );
        const response = fixture.page.waitForResponse((value) =>
          value.url().includes("/home/repository-work?"),
        );
        fixture.releaseRefresh();
        await (await response).finished();
        await fixture.page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        assert.equal(
          await rows(fixture.page).count(),
          12,
          "unchanged work must stay expanded after the refresh completes",
        );
      } finally {
        fixture.releaseRefresh();
        await fixture.page.close();
      }
    });
    await check(`${trigger} refresh clears expanded work and restores all-clear`, async () => {
      const fixture = await open({ count: 12, live: trigger === "repository event" });
      await card(fixture.page)
        .getByRole("button", { name: "Show more (4 remaining)", exact: true })
        .click();
      await rows(fixture.page).nth(11).waitFor();
      fixture.clearWork();
      if (trigger === "focus") await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
      else fixture.emitRepositoryEvent();
      await fixture.page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await card(fixture.page).count(), 0);
      await fixture.page.close();
    });
  }
  await check("late show-more response cannot restore old work after a Home refresh", async () => {
    const fixture = await open({ count: 12, holdPagination: true });
    try {
      const request = fixture.page.waitForRequest((value) =>
        value.url().includes("repository-work?offset=8"),
      );
      await card(fixture.page)
        .getByRole("button", { name: "Show more (4 remaining)", exact: true })
        .click();
      await request;
      fixture.keepFirstWork();
      await fixture.page.evaluate(() => dispatchEvent(new Event("focus")));
      await rows(fixture.page).nth(1).waitFor({ state: "detached" });
      const response = fixture.page.waitForResponse((value) =>
        value.url().includes("repository-work?offset=8"),
      );
      fixture.releasePagination();
      await (await response).finished();
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      assert.equal(await rows(fixture.page).count(), 1);
      assert.equal(
        await card(fixture.page).getByRole("button", { name: /Show more|Loading|Try again/ }).count(),
        0,
      );
    } finally {
      fixture.releasePagination();
      await fixture.page.close();
    }
  });
  await check("empty repository queue has no card or extra pagination request", async () => {
    const { page, reads } = await open({ count: 0 });
    assert.equal(await card(page).count(), 0);
    assert.equal(
      reads.some((url) => url.includes("repository-work?")),
      false,
    );
    await page.close();
  });
  assert.deepEqual(browserErrors, [], "browser must have no uncaught errors");
  assert.deepEqual(unexpectedRequests, [], "browser must only make expected fixture requests");
  console.log(`PASS ${checks} Home repository work browser regressions`);
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
