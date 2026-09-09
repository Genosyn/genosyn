/**
 * npm run test:home-mail-drafts [-- "case substring"]
 * Real Chrome exercises production Home, company sockets, mailbox selection,
 * Drafts review and the thread editor. Only HTTP/WebSocket responses are local
 * fixtures; unexpected requests and every mail write fail the suite.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import type { HomeData, HomeDraftEmail } from "../client/lib/api";
import type { MailAccount, MailDraft, MailMessage } from "../client/lib/mail";
import type { WsInboundEvent } from "../client/lib/workspace";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const now = new Date("2026-09-09T09:00:00.000Z");
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-home-mail-drafts"),
  plugins: [
    {
      name: "home-mail-drafts-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__home_mail_drafts", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__home_mail_drafts",
            '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
              `<script type="module" src="/@fs${root}/scripts/homeMailDraftsHarness.tsx"></script></html>`,
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

function preview(index = 1, accountId = "support"): HomeDraftEmail {
  return {
    id: `draft-${index}`,
    threadId: `thread-${index}`,
    accountId,
    subject: `Customer update ${index}`,
    recipientSummary: `customer${index}@example.test`,
    accountEmail: `${accountId}@example.test`,
    updatedAt: now.toISOString(),
  };
}
function home(
  count = 0,
  drafts = Array.from({ length: Math.min(count, 5) }, (_, index) => preview(index + 1)),
): HomeData {
  return {
    decisions: [],
    pendingDecisionCount: 0,
    repositoryWork: [],
    repositoryWorkCount: 0,
    notifications: [],
    unreadNotificationCount: 0,
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
    draftEmails: drafts,
    draftEmailCount: count,
    draftEmailAccounts: count ? [{ id: "support", email: "support@example.test", count }] : [],
    systemHealth: { status: "ok", issueCount: 0, checks: [] },
    counts: { employees: 0, projects: 0 },
  };
}
function mailbox(id: string): MailAccount {
  return {
    id,
    connectionId: `connection-${id}`,
    provider: "gmail",
    address: `${id}@example.test`,
    status: "active",
    statusMessage: "",
    lastSyncAt: now.toISOString(),
    syncState: "idle",
    syncAttemptId: null,
    syncStartedAt: null,
    syncFinishedAt: null,
    backfilledAt: now.toISOString(),
    backfilledCount: 12,
    aiAnalysisEnabled: true,
    aiAnalysisEmployeeId: null,
    aiAnalysisModelId: null,
    createdAt: now.toISOString(),
  };
}
function draftMessage(row: HomeDraftEmail): MailMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    gmailMessageId: `remote-${row.id}`,
    isDraft: true,
    fromName: "",
    fromEmail: row.accountEmail,
    toEmails: row.recipientSummary,
    ccEmails: "",
    bccEmails: "",
    subject: row.subject,
    snippet: "Please review before sending.",
    bodyText: "Please review before sending.",
    bodyHtml: "",
    labelIds: ["DRAFT"],
    sentAt: null,
    createdAt: now.toISOString(),
    createdByUserId: null,
    createdByEmployeeId: null,
    createdByRoutineId: null,
    createdByRunId: null,
    attachments: [],
  };
}
type Options = {
  data?: HomeData;
  width?: number;
  dark?: boolean;
  error?: boolean;
  start?: string;
  savedAccount?: string;
};
const card = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Draft emails", exact: true }) });
const stat = (page: Page) => page.getByRole("link", { name: /^\d[\d,]* Draft emails$/i });
const rows = (page: Page) => card(page).locator('a[href*="/mail/t/"]');
const routePath = (page: Page) => page.getByTestId("route").textContent();
const quiet = (page: Page) =>
  page.getByRole("heading", { name: "Nothing needs you right now", exact: true });

async function open(options: Options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: 1000 },
    colorScheme: options.dark ? "dark" : "light",
    timezoneId: "Europe/London",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.clock.setFixedTime(now);
  await page.addInitScript((savedAccount) => {
    localStorage.setItem("genosyn.pushPromptDismissed", "1");
    if (savedAccount) localStorage.setItem("genosyn.mail.account.company", savedAccount);
  }, options.savedAccount);
  let data = options.data ?? home(1);
  let failHome = options.error ?? false;
  const reads: string[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  const moduleErrors: string[] = [];
  const pendingModules = new Set<string>();
  const sockets = new Set<WebSocketRoute>();
  const held: Array<() => void> = [];
  let holdNextHome = false;
  let onHeld: (() => void) | null = null;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") moduleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (!request.url().includes("/api/")) pendingModules.add(request.url());
  });
  page.on("requestfinished", (request) => pendingModules.delete(request.url()));
  page.on("requestfailed", (request) => {
    pendingModules.delete(request.url());
    moduleErrors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("/api/"))
      moduleErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.routeWebSocket("**/api/ws?*", (socket) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((message) => unexpected.push(`Unexpected socket write: ${message}`));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(`External request: ${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST" && /\/workspace\/ws-token$/.test(url.pathname))
      return route.fulfill({ json: { token: "fixture" } });
    if (request.method() !== "GET") {
      unexpected.push(`Unexpected write: ${request.method()} ${url.pathname}`);
      return route.fulfill({
        status: 500,
        json: { error: "Writes are forbidden in Home review tests" },
      });
    }
    reads.push(url.pathname + url.search);
    const match = url.pathname.match(/^\/api\/companies\/([^/]+)(.*)$/);
    const companyId = match?.[1];
    const endpoint = match?.[2];
    if (endpoint === "/home") {
      const response =
        companyId === "company-two"
          ? home(1, [{ ...preview(99, "other"), subject: "Private to the other company" }])
          : structuredClone(data);
      const failed = failHome;
      if (holdNextHome) {
        holdNextHome = false;
        await new Promise<void>((resolve) => {
          held.push(resolve);
          onHeld?.();
          onHeld = null;
        });
      }
      return route.fulfill(
        failed
          ? { status: 503, json: { error: "Home temporarily unavailable" } }
          : { json: response },
      );
    }
    if (endpoint === "/employees" || endpoint === "/members") return route.fulfill({ json: [] });
    if (endpoint === "/work-timeline")
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
    if (endpoint === "/mail/accounts")
      return route.fulfill({ json: { accounts: [mailbox("sales"), mailbox("support")] } });
    const accountEndpoint = endpoint?.match(/^\/mail\/accounts\/([^/]+)\/(.+)$/);
    if (accountEndpoint) {
      const [, accountId, resource] = accountEndpoint;
      if (resource === "saved-searches") return route.fulfill({ json: { savedSearches: [] } });
      if (resource === "labels")
        return route.fulfill({
          json: {
            labels: [],
            counts: { inboxUnread: 0, starred: 0, drafts: accountId === "support" ? 7 : 2 },
          },
        });
      if (resource === "drafts/send-queue") return route.fulfill({ json: { batch: null } });
      if (resource === "drafts") {
        const draft: MailDraft = {
          id: `${accountId}-review`,
          threadId: `${accountId}-thread`,
          subject: `${accountId} review draft`,
          toEmails: "recipient@example.test",
          ccEmails: "",
          snippet: "Check this before sending.",
          bodyPreview: "Check this before sending.",
          hasAttachments: false,
          missingRecipient: false,
          queuedForSend: false,
          createdAt: now.toISOString(),
          author: { kind: "none" },
        };
        return route.fulfill({
          json: {
            drafts: [draft],
            nextOffset: null,
            facets: { employees: [], routines: [] },
            totals: { total: 1, sendable: 1, missingRecipient: 0, queued: 0 },
          },
        });
      }
      if (resource === "assistant")
        return route.fulfill({ json: { messages: [], roster: [], modelId: null } });
    }
    const threadId = endpoint?.match(/^\/mail\/threads\/([^/]+)$/)?.[1];
    if (threadId) {
      const row = data.draftEmails.find((draft) => draft.threadId === threadId) ?? preview();
      return route.fulfill({
        json: {
          thread: {
            id: row.threadId,
            gmailThreadId: `remote-${row.threadId}`,
            accountId: row.accountId,
            subject: row.subject,
            snippet: "Please review before sending.",
            participants: row.recipientSummary,
            labelIds: ["DRAFT"],
            unread: false,
            messageCount: 1,
            hasAttachments: false,
            lastMessageAt: now.toISOString(),
          },
          account: mailbox(row.accountId),
          messages: [draftMessage(row)],
          handovers: [],
          analyses: [],
        },
      });
    }
    unexpected.push(`Unexpected read: ${url.pathname}${url.search}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(
    `${origin}/__home_mail_drafts${options.start ? `?start=${encodeURIComponent(options.start)}` : ""}`,
    { waitUntil: "commit", timeout: 60_000 },
  );
  const startupDiagnostic = setTimeout(
    () =>
      console.error("Browser startup diagnostic after 20s", {
        errors,
        unexpected,
        reads,
        moduleErrors,
        pendingModules: [...pendingModules],
      }),
    20_000,
  );
  await page
    .getByTestId("socket-status")
    .filter({ hasText: "open" })
    .waitFor({ state: "attached", timeout: 300_000 })
    .catch(async (error) => {
      console.error("Browser startup failed", {
        errors,
        unexpected,
        reads,
        moduleErrors,
        pendingModules: [...pendingModules],
      });
      await page
        .screenshot({ path: path.join(output, "home-mail-drafts-startup.png"), fullPage: true })
        .catch(() => {});
      await context.close();
      throw error;
    });
  clearTimeout(startupDiagnostic);
  if (!options.start) {
    await page.locator('header[aria-label="Home greeting"]').waitFor();
    if (failHome) await page.getByRole("alert").waitFor();
    else await (data.draftEmailCount ? card(page) : quiet(page)).waitFor();
  }
  return {
    page,
    reads,
    errors,
    unexpected,
    setData: (next: HomeData) => {
      data = next;
    },
    setError: (next: boolean) => {
      failHome = next;
    },
    event: (event: WsInboundEvent) => {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    hold: () => {
      holdNextHome = true;
      return new Promise<void>((resolve) => {
        onHeld = resolve;
      });
    },
    heldCount: () => held.length,
    release: () => {
      for (const resolve of held.splice(0)) resolve();
    },
    close: async () => {
      for (const resolve of held.splice(0)) resolve();
      await context.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof open>>;
async function fits(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "The document must not overflow horizontally",
  );
  assert.equal(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "Home must not hide horizontal overflow",
  );
  for (const link of await card(page).getByRole("link").all()) {
    const box = await link.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 1,
      "Every draft link fits on screen",
    );
  }
}
async function navigate(page: Page, to: string) {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("fixture:navigate", { detail })),
    to,
  );
}
async function countIs(page: Page, count: number) {
  if (count === 0) {
    await quiet(page).waitFor();
    assert.equal(await card(page).count(), 0);
    assert.equal(await stat(page).count(), 0);
  } else {
    await page
      .getByRole("link", { name: new RegExp(`^${count.toLocaleString()} Draft emails$`, "i") })
      .waitFor();
    assert.equal(await card(page).count(), 1);
    assert.equal(await quiet(page).count(), 0);
  }
}
async function reviewLoaded(page: Page, accountId: string) {
  await page.getByRole("heading", { name: "Review queue", exact: true }).waitFor();
  await page.getByText(`${accountId} review draft`, { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("genosyn.mail.account.company")),
    accountId,
  );
}
const cases: Array<{ name: string; options?: Options; run: (fixture: Fixture) => Promise<void> }> =
  [];
function add(name: string, run: (fixture: Fixture) => Promise<void>, options?: Options) {
  cases.push({ name, run, options });
}

add(
  "zero drafts leaves the all-clear state and no draft card or statistic",
  async ({ page }) => {
    await countIs(page, 0);
    assert.equal(await page.getByRole("link", { name: "Review drafts", exact: true }).count(), 0);
  },
  { data: home() },
);
add(
  "one draft shows its count, recipient and mailbox without claiming all clear",
  async ({ page }) => {
    await countIs(page, 1);
    assert.equal(await rows(page).count(), 1);
    assert.match(await rows(page).first().innerText(), /Customer update 1/);
    assert.match(await rows(page).first().innerText(), /customer1@example.test/);
    assert.match(await rows(page).first().innerText(), /support@example.test/);
    assert.equal(await card(page).getByRole("button", { name: /send/i }).count(), 0);
    await page.screenshot({
      path: path.join(output, "home-mail-drafts-desktop.png"),
      fullPage: true,
    });
  },
);
add(
  "the total remains 12 when only five previews are returned",
  async ({ page }) => {
    await countIs(page, 12);
    assert.equal(await rows(page).count(), 5);
    assert.match(await card(page).innerText(), /12/);
  },
  { data: home(12) },
);
add(
  "missing subject and recipient are clearly identified and remain reviewable",
  async ({ page }) => {
    await rows(page).first().getByText("(No subject)", { exact: true }).waitFor();
    await rows(page).first().getByText("No recipient yet", { exact: true }).waitFor();
    assert.equal(
      await rows(page).first().getAttribute("href"),
      "/c/company/mail/t/thread-1?account=support",
    );
  },
  { data: home(1, [{ ...preview(), subject: "", recipientSummary: "" }]) },
);
add(
  "mailboxes outside the preview limit still have a counted review link",
  async ({ page }) => {
    await countIs(page, 9);
    assert.equal(await rows(page).count(), 5);
    const sales = card(page).locator('a[href="/c/company/mail?view=drafts&account=sales"]');
    assert.match(await sales.innerText(), /sales@example.test/);
    assert.match(await sales.innerText(), /2/);
    await sales.click();
    await reviewLoaded(page, "sales");
  },
  {
    data: {
      ...home(9),
      draftEmailAccounts: [
        { id: "support", email: "support@example.test", count: 7 },
        { id: "sales", email: "sales@example.test", count: 2 },
      ],
    },
  },
);
add(
  "Review drafts opens the intended mailbox despite a previously selected mailbox",
  async ({ page, reads }) => {
    await card(page).getByRole("link", { name: "Review drafts", exact: true }).click();
    assert.equal(await routePath(page), "/c/company/mail?view=drafts&account=support");
    await reviewLoaded(page, "support");
    assert.equal(
      reads.some((read) => read.includes("/accounts/sales/")),
      false,
      "The saved mailbox must not briefly load ahead of the requested mailbox",
    );
  },
  { savedAccount: "sales" },
);
add("the count link opens the Drafts review queue", async ({ page }) => {
  await stat(page).click();
  await reviewLoaded(page, "support");
});
add(
  "keyboard navigation opens an individual draft for review without sending",
  async ({ page }) => {
    const row = rows(page).first();
    await row.focus();
    assert.equal(await row.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await routePath(page), "/c/company/mail/t/thread-1?account=support");
    await page.getByRole("main").getByRole("button", { name: "Edit", exact: true }).waitFor();
    await page.getByRole("main").getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Subject", exact: true }).inputValue(),
      "Customer update 1",
    );
    assert.equal(
      await page.getByRole("textbox", { name: "To", exact: true }).inputValue(),
      "customer1@example.test",
    );
  },
  { savedAccount: "sales" },
);
for (const width of [1440, 768, 390, 320]) {
  add(
    `long subjects, recipients and mailbox names fit at ${width}px`,
    async ({ page }) => {
      await fits(page);
      assert.equal(await rows(page).count(), 5);
      await page.screenshot({
        path: path.join(output, `home-mail-drafts-${width}.png`),
        fullPage: true,
      });
    },
    {
      width,
      data: {
        ...home(
          12,
          Array.from({ length: 5 }, (_, index) => ({
            ...preview(index + 1),
            subject: "長い件名-CustomerRenewalWithoutWhitespace".repeat(8),
            recipientSummary: `${"customer".repeat(25)}@example.test`,
            accountEmail: `${"mailbox".repeat(25)}@example.test`,
          })),
        ),
        draftEmailAccounts: [
          { id: "support", email: `${"mailbox".repeat(25)}@example.test`, count: 12 },
        ],
      },
    },
  );
}
add(
  "dark mobile keeps a legible draft card with all links visible",
  async ({ page }) => {
    assert.equal(
      await page.locator("html").evaluate((element) => element.classList.contains("dark")),
      true,
    );
    await fits(page);
    await page.screenshot({ path: path.join(output, "home-mail-drafts-dark.png"), fullPage: true });
  },
  { width: 390, dark: true, data: home(6) },
);
add(
  "returning focus refreshes the count and removes a cleared backlog",
  async ({ page, setData }) => {
    setData(home(3));
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await countIs(page, 3);
    setData(home());
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await countIs(page, 0);
  },
);
add(
  "mail updates from any mailbox reveal new drafts and remove sent or discarded ones",
  async ({ page, setData, event }) => {
    setData(home(2));
    event({ type: "mail.updated", accountId: "support" });
    await countIs(page, 2);
    setData(home());
    event({ type: "mail.updated", accountId: "sales" });
    await countIs(page, 0);
  },
  { data: home() },
);
add(
  "manual mailbox switching survives a subsequent mail refresh",
  async ({ page, event }) => {
    await card(page).getByRole("link", { name: "Review drafts", exact: true }).click();
    await reviewLoaded(page, "support");
    await page.getByRole("button", { name: "support@example.test", exact: true }).click();
    await page.getByRole("menuitem", { name: "sales@example.test", exact: true }).click();
    await reviewLoaded(page, "sales");
    assert.equal(await routePath(page), "/c/company/mail?view=drafts&account=sales");
    const refreshed = page.waitForResponse((response) => response.url().endsWith("/mail/accounts"));
    event({ type: "mail.updated", accountId: "sales" });
    await refreshed;
    await reviewLoaded(page, "sales");
  },
  { savedAccount: "sales" },
);
add(
  "a failed initial Home read offers retry and never says nothing needs attention",
  async ({ page, setError }) => {
    assert.equal(await quiet(page).count(), 0);
    setError(false);
    await page.getByRole("button", { name: /retry/i }).click();
    await countIs(page, 1);
    assert.equal(await page.getByRole("alert").count(), 0);
  },
  { error: true },
);
add(
  "a failed background refresh retains drafts and retry recovers the count",
  async ({ page, setData, setError }) => {
    setError(true);
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.getByRole("alert").waitFor();
    await countIs(page, 1);
    setError(false);
    setData(home(7));
    await page.getByRole("button", { name: /retry/i }).click();
    await countIs(page, 7);
    assert.equal(await page.getByRole("alert").count(), 0);
  },
);
add("a delayed old response cannot overwrite a newer draft count", async (fixture) => {
  const { page } = fixture;
  const held = fixture.hold();
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await held;
  assert.equal(fixture.heldCount(), 1);
  fixture.setData(home(8));
  fixture.event({ type: "mail.updated", accountId: "support" });
  await countIs(page, 8);
  const staleResponse = page.waitForResponse((response) => response.url().endsWith("/home"));
  fixture.release();
  await (await staleResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await countIs(page, 8);
});
add("switching companies discards an in-flight response from the old company", async (fixture) => {
  const { page } = fixture;
  const held = fixture.hold();
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await held;
  await navigate(page, "/c/company-two");
  await rows(page).first().getByText("Private to the other company", { exact: true }).waitFor();
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/companies/company/home"),
  );
  fixture.release();
  await (await staleResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await rows(page).first().getByText("Private to the other company", { exact: true }).waitFor();
  assert.equal(await page.getByText("Customer update 1", { exact: true }).count(), 0);
  assert.equal(
    await rows(page).first().getAttribute("href"),
    "/c/company-two/mail/t/thread-99?account=other",
  );
});
add(
  "an unknown mailbox deep link falls back to a real mailbox without breaking review",
  async ({ page }) => {
    await page.getByRole("heading", { name: "Review queue", exact: true }).waitFor();
    await page.getByText("sales review draft", { exact: true }).waitFor();
  },
  { start: "/c/company/mail?view=drafts&account=removed", savedAccount: "sales" },
);

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];
const filter = process.argv.slice(2).join(" ").toLowerCase();
try {
  await fs.mkdir(output, { recursive: true });
  const selected = cases.filter((test) => test.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No cases match ${JSON.stringify(filter)}`);
  for (const [index, test] of selected.entries()) {
    console.log(`RUN ${test.name}`);
    const fixture = await open(test.options);
    try {
      await test.run(fixture);
      assert.deepEqual(fixture.errors, [], "Browser must have no uncaught errors");
      assert.deepEqual(
        fixture.unexpected,
        [],
        "Home and draft review must not write or make unexpected requests",
      );
      console.log(`PASS ${test.name}`);
      passed++;
    } catch (error) {
      await fixture.page
        .screenshot({
          path: path.join(output, `home-mail-drafts-failure-${index + 1}.png`),
          fullPage: true,
        })
        .catch(() => {});
      console.error({
        errors: fixture.errors,
        unexpected: fixture.unexpected,
        reads: fixture.reads,
      });
      failures.push({ name: test.name, error });
      console.error(`FAIL ${test.name}`, error);
    } finally {
      await fixture.close();
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `${failures.length} Home draft-email browser cases failed (${passed} passed): ${failures.map((failure) => failure.name).join("; ")}`,
    );
  }
  console.log(`PASS ${passed} Home draft-email browser regressions`);
} finally {
  await browser.close();
  await server.close();
}
