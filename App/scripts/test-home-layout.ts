/**
 * Run with `npm run test:home-layout`; local Chrome or GENOSYN_TEST_BROWSER.
 * Tests the real Home greeting, cards and employee day with deterministic API
 * fixtures. Geometry assertions catch reserved columns and overflow that static
 * rendering cannot. Every unexpected request fails the suite.
 * Set GENOSYN_HOME_TEST_FILTER to a check-name substring while iterating.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import type {
  Approval,
  Decision,
  Employee,
  EmployeeQueueItem,
  EmployeeWorkQueue,
  HomeApproval,
  HomeChannel,
  HomeData,
  HomeFailedRun,
  Notification,
  Run,
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
function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: "decision",
    companyId: "company",
    title: "Which retention commitment needs attention?",
    body: "Confirm the owner and next update.",
    status: "pending",
    urgency: "high",
    options: [{ id: "confirm", label: "Confirm the owner", detail: null, tone: "primary" }],
    createdAt: fixtureNow.toISOString(),
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
  };
}
function review(kind: "proactive_work" | "mail_send"): HomeApproval {
  return {
    id: kind === "proactive_work" ? "work-review" : "mail-review",
    kind,
    title:
      kind === "proactive_work" ? "Prepare the retention follow-up" : "Review the customer reply",
    summary: null,
    requestedAt: "2026-09-09T08:00:00.000Z",
    employee: { id: "employee-1", name: "Jamie Mallers", slug: "employee-1" },
    routine: null,
    review:
      kind === "proactive_work"
        ? {
            kind: "work",
            revision: "work-revision",
            context: "The customer asked for an update on their retention review.",
            plan: "Prepare the owner summary and next steps for the customer.",
            source: {
              routineId: null,
              runId: null,
              conversationId: null,
              mailThreadId: null,
              mailAccountId: null,
              mailHandoverId: null,
            },
          }
        : {
            kind: "mail",
            revision: "mail-revision",
            context: "The customer asked who will own their next update.",
            workSummary: "Checked the owner and prepared a reply.",
            steps: [],
            attachments: [],
            source: {
              accountId: "account",
              threadId: "thread",
              mailHandoverId: null,
              routineId: null,
              runId: null,
              conversationId: null,
            },
            draft: {
              to: "customer@example.test",
              cc: "",
              bcc: "",
              subject: "Your next update",
              bodyText: "Jamie will send your next update tomorrow.",
            },
          },
  };
}
function channel(id: string, label: string, unreadCount: number): HomeChannel {
  return { id, kind: "channel", label, unreadCount, lastReadAt: null };
}
function notification(id: string, title: string): Notification {
  return {
    id,
    kind: "approval_stale",
    title,
    body: "A review has been waiting for 24 hours.",
    link: `/c/company/decisions#review-${id}`,
    actor: {
      kind: "ai",
      id: "employee-1",
      name: "Jamie Mallers",
      avatarKey: null,
      slug: "employee-1",
    },
    entityKind: "approval",
    entityId: id,
    readAt: null,
    createdAt: fixtureNow.toISOString(),
  };
}

function failedRun(changes: Partial<HomeFailedRun> = {}): HomeFailedRun {
  return {
    runId: "failed-run",
    routineId: "customer-update",
    routineName: "Daily customer update",
    status: "failed",
    errorKind: null,
    failureReason: "The customer update could not be delivered.",
    exitCode: 1,
    startedAt: "2026-09-09T08:00:00.000Z",
    employee: { id: "employee-1", name: "Jamie Mallers", slug: "employee-1", avatarKey: null },
    ...changes,
  };
}

const failureExplanation =
  "## What happened\n\nThe mailbox rejected the update because **the Connection expired**.\n\n" +
  "## What to do next\n\nReconnect the mailbox, then check for a sent message before retrying.";
const failureTranscript =
  "[08:00:01] Looking up customer requests.\n[08:00:05] Mailbox rejected the request: Connection expired.";
const failureFollowup =
  "The recorded evidence shows no sent message. Reconnect the mailbox and confirm its Sent folder before retrying.";

function homeData(
  employeeCount: number,
  options: {
    quiet?: boolean;
    unreadChannels?: HomeChannel[];
    notifications?: Notification[];
  } = {},
): HomeData {
  const quiet = options.quiet ?? false;
  return {
    repositoryWork: [],
    repositoryWorkCount: 0,
    decisions: quiet ? [] : [decision()],
    pendingDecisionCount: quiet ? 0 : 1,
    notifications: options.notifications ?? [],
    unreadNotificationCount: options.notifications?.length ?? 0,
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
        source: null,
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
function queueItem(changes: Partial<EmployeeQueueItem> = {}): EmployeeQueueItem {
  return {
    id: "queued-1",
    runId: "queued-1",
    routine: { id: "routine-1", name: "Review customer requests", slug: "review-customers" },
    triggerKind: "schedule",
    queuedAt: "2026-09-09T08:55:00.000Z",
    availableAt: null,
    position: 1,
    blockedReason: null,
    ...changes,
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
  workQueue?: EmployeeWorkQueue;
  queueError?: boolean;
  holdQueue?: boolean;
  holdMarkRead?: boolean;
  markReadError?: boolean;
  holdNotificationMarkAll?: boolean;
  notificationMarkAllError?: boolean;
  working?: boolean;
  brokenAvatar?: boolean;
  touch?: boolean;
  channels?: HomeChannel[];
  notifications?: Notification[];
  unreadNotificationCount?: number;
  statCounts?: Partial<Pick<HomeData, "myTodoCount" | "reviewTodoCount" | "pendingApprovalCount">>;
  decisions?: Decision[];
  decisionApprovals?: HomeApproval[];
  pendingDecisionCount?: number;
  pendingDecisionApprovalCount?: number;
  role?: "member" | "admin" | "owner";
  allowDecisionAnswer?: boolean;
  allowDecisionSnooze?: boolean;
  allowReview?: boolean;
  decisionAnswerError?: boolean;
  failedRuns?: HomeFailedRun[];
  allowRunResume?: boolean;
  runResumeError?: boolean;
  holdExplanation?: boolean;
  explanationError?: boolean;
  explanationOptionsError?: boolean;
  noExplanationEmployees?: boolean;
  longFailureTranscript?: boolean;
  longRunExplanation?: boolean;
  live?: boolean;
};
async function open(options: FixtureOptions = {}) {
  const page = await (options.touch ? touchContext : context).newPage();
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 1000 });
  await page.emulateMedia({
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  await page.clock.setFixedTime(fixtureNow);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("home-fixture-started")) {
      for (const key of Object.keys(localStorage))
        if (key.startsWith("genosyn.decisionFollowUps.v1:")) localStorage.removeItem(key);
      sessionStorage.setItem("home-fixture-started", "1");
    }
    localStorage.setItem("genosyn.pushPromptDismissed", "1");
  });
  let employees = roster(options.count ?? 1);
  if (options.longNames) employees[0].name = "Alexandria Rivera-Montgomery ".repeat(5).trim();
  if (options.brokenAvatar) employees[0].avatarKey = "missing";
  let rosterError = options.rosterError ?? false;
  let workError = options.workError ?? false;
  let workQueue = options.workQueue;
  let queueError = options.queueError ?? false;
  let decisionAnswerError = options.decisionAnswerError ?? false;
  let explanationError = options.explanationError ?? false;
  let explanationOptionsError = options.explanationOptionsError ?? false;
  let failedRuns = options.failedRuns ?? [];
  const runHistory = [...failedRuns];
  let decisions = options.decisions ?? (options.quiet ? [] : [decision()]);
  let decisionApprovals = options.decisionApprovals ?? [];
  const decisionDetails = new Map(decisions.map((row) => [row.id, row]));
  const reviewDetails = new Map(
    decisionApprovals.map((row): [string, Approval] => [
      row.id,
      {
        ...row,
        companyId: "company",
        routineId: row.routine?.id ?? "",
        employeeId: row.employee?.id ?? "",
        status: "pending",
        errorMessage: null,
        decidedAt: null,
        decidedByUserId: null,
      },
    ]),
  );
  let pendingDecisionCount = options.pendingDecisionCount ?? decisions.length;
  let pendingDecisionApprovalCount =
    options.pendingDecisionApprovalCount ?? decisionApprovals.length;
  const mutations: Array<{ path: string; body: unknown }> = [];
  let homeError = false;
  let markReadError = options.markReadError ?? false;
  let unreadChannels = (
    options.channels ?? (options.quiet ? [] : [channel("support", "Support", 2)])
  ).map((row) => ({ ...row }));
  let notifications = (options.notifications ?? []).map((row) => ({ ...row }));
  let releaseWork: () => void = () => {};
  const workGate = new Promise<void>((resolve) => {
    releaseWork = resolve;
  });
  let releaseQueue: () => void = () => {};
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  let releaseMarkRead: () => void = () => {};
  const markReadGate = new Promise<void>((resolve) => {
    releaseMarkRead = resolve;
  });
  let releaseNotificationMarkAll: () => void = () => {};
  const notificationMarkAllGate = new Promise<void>((resolve) => {
    releaseNotificationMarkAll = resolve;
  });
  let holdNextHome = false;
  let releaseHome: () => void = () => {};
  const homeGate = new Promise<void>((resolve) => {
    releaseHome = resolve;
  });
  let releaseExplanation: () => void = () => {};
  const explanationGate = new Promise<void>((resolve) => {
    releaseExplanation = resolve;
  });
  let markExplanationStarted: () => void = () => {};
  const explanationStarted = new Promise<void>((resolve) => {
    markExplanationStarted = resolve;
  });
  const reads: string[] = [];
  const writes: string[] = [];
  const sockets: WebSocketRoute[] = [];
  if (options.live) {
    await page.routeWebSocket(`${origin.replace(/^http/, "ws")}/api/ws?token=*`, (socket) => {
      sockets.push(socket);
    });
  }
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() === "POST") {
      if (options.live && url.pathname === "/api/companies/company/workspace/ws-token")
        return route.fulfill({ json: { token: "fixture-token" } });
      const resuming = failedRuns.find(
        (item) => url.pathname === `/api/companies/company/runs/${item.runId}/resume`,
      );
      if (options.allowRunResume && resuming) {
        assert.ok(options.role === "admin" || options.role === "owner");
        writes.push(`${request.method()} ${url.pathname}`);
        mutations.push({ path: url.pathname, body: request.postDataJSON() });
        assert.deepEqual(request.postDataJSON(), { acknowledgeNewAllowance: true });
        if (options.runResumeError)
          return route.fulfill({
            status: 409,
            json: { error: "A newer Run already continued this work." },
          });
        const resumed: Run = {
          id: "resumed-run",
          routineId: resuming.routineId,
          startedAt: fixtureNow.toISOString(),
          finishedAt: null,
          createdAt: fixtureNow.toISOString(),
          status: "running",
          exitCode: null,
          hasUnfinishedWork: false,
          triggerKind: "continuation",
          continuationCount: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        runHistory.push({
          ...resuming,
          ...resumed,
          runId: resumed.id,
          failureReason: null,
          retryAt: null,
          continuationPending: false,
        });
        failedRuns = failedRuns.filter((item) => item.runId !== resuming.runId);
        return route.fulfill({ json: resumed });
      }
      const explaining = failedRuns.find(
        (item) => url.pathname === `/api/companies/company/runs/${item.runId}/explanation`,
      );
      if (explaining) {
        writes.push(`${request.method()} ${url.pathname}`);
        mutations.push({ path: url.pathname, body: request.postDataJSON() });
        markExplanationStarted();
        if (options.holdExplanation) await explanationGate;
        if (explanationError)
          return route.fulfill({
            contentType: "text/event-stream",
            body: `event: error\ndata: ${JSON.stringify({ error: "The AI Model is unavailable. Please try again." })}\n\n`,
          });
        const requested = request.postDataJSON() as { employeeId?: string; message?: string };
        assert.equal(requested.employeeId, undefined, "the server chooses this Run's AI Employee");
        const employee = employees.find((item) => item.id === explaining.employee?.id);
        assert.ok(employee, "an explanation requires the AI Employee who ran this Routine");
        const response = {
          explanation: requested.message
            ? failureFollowup
            : failureExplanation +
              (options.longRunExplanation
                ? Array.from(
                    { length: 16 },
                    (_, index) =>
                      `\n\n### Evidence ${index + 1}\n\nThe recorded mailbox request was rejected. Check the Connection and the Sent folder before retrying this Run.`,
                  ).join("")
                : ""),
          employee: { id: employee.id, name: employee.name, slug: employee.slug },
        };
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: explanation\ndata: ${JSON.stringify(response)}\n\n`,
        });
      }
      const answering = decisions.find(
        (item) => url.pathname === `/api/companies/company/decisions/${item.id}/decide`,
      );
      if (options.allowDecisionAnswer && answering) {
        writes.push(`${request.method()} ${url.pathname}`);
        mutations.push({ path: url.pathname, body: request.postDataJSON() });
        if (decisionAnswerError)
          return route.fulfill({ status: 503, json: { error: "The answer could not be saved." } });
        decisions = decisions.filter((item) => item.id !== answering.id);
        pendingDecisionCount--;
        const body = request.postDataJSON() as { optionId: string; note?: string };
        const answered: Decision = {
          ...answering,
          status: "decided",
          chosenOptionId: body.optionId,
          chosenOptionLabel:
            answering.options.find((option) => option.id === body.optionId)?.label ?? null,
          note: body.note ?? null,
          decidedAt: fixtureNow.toISOString(),
          decidedByUserId: "member",
          decidedBy: { id: "member", name: "Nawaz Dhandala" },
        };
        decisionDetails.set(answered.id, answered);
        return route.fulfill({ json: answered });
      }
      const snoozing = decisions.find(
        (item) => url.pathname === `/api/companies/company/decisions/${item.id}/snooze`,
      );
      if (options.allowDecisionSnooze && snoozing) {
        writes.push(`${request.method()} ${url.pathname}`);
        mutations.push({ path: url.pathname, body: request.postDataJSON() });
        decisions = decisions.filter((item) => item.id !== snoozing.id);
        pendingDecisionCount--;
        return route.fulfill({ json: { ...snoozing, snoozedUntil: "2026-09-10T09:00:00.000Z" } });
      }
      const approving = decisionApprovals.find(
        (item) => url.pathname === `/api/companies/company/approvals/${item.id}/approve`,
      );
      if (options.allowReview && approving) {
        assert.ok(options.role === "admin" || options.role === "owner");
        writes.push(`${request.method()} ${url.pathname}`);
        mutations.push({ path: url.pathname, body: request.postDataJSON() });
        decisionApprovals = decisionApprovals.filter((item) => item.id !== approving.id);
        pendingDecisionApprovalCount--;
        const approved: Approval = {
          ...reviewDetails.get(approving.id)!,
          status: approving.kind === "proactive_work" ? "executing" : "approved",
          decidedAt: fixtureNow.toISOString(),
          decidedByUserId: "member",
          ...(approving.kind === "mail_send"
            ? {
                mailDeliveryStatus: "sent" as const,
                mailOutcome: {
                  sentMessageId: "sent-message",
                  providerMessageRef: "provider-ref",
                  sentAt: fixtureNow.toISOString(),
                },
              }
            : {}),
        };
        reviewDetails.set(approved.id, approved);
        return route.fulfill({ json: approved });
      }
    }
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
    if (
      request.method() === "POST" &&
      url.pathname === "/api/companies/company/notifications/mark-all-read"
    ) {
      writes.push(`${request.method()} ${url.pathname}`);
      if (options.holdNotificationMarkAll) await notificationMarkAllGate;
      if (options.notificationMarkAllError) {
        return route.fulfill({ status: 503, json: { error: "Notifications are unavailable." } });
      }
      notifications = [];
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    reads.push(url.pathname + url.search);
    const detailMatch = url.pathname.match(
      /^\/api\/companies\/company\/(decisions|approvals)\/([^/]+)$/,
    );
    if (detailMatch) {
      const row =
        detailMatch[1] === "decisions"
          ? decisionDetails.get(detailMatch[2])
          : reviewDetails.get(detailMatch[2]);
      return row
        ? route.fulfill({ json: row })
        : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (url.pathname === "/api/companies/company/home") {
      if (holdNextHome) {
        holdNextHome = false;
        await homeGate;
      }
      if (homeError) {
        return route.fulfill({ status: 503, json: { error: "Home is unavailable." } });
      }
      return route.fulfill({
        json: {
          ...homeData(employees.length, {
            quiet: options.quiet,
            unreadChannels,
            notifications,
          }),
          ...options.statCounts,
          unreadNotificationCount: notifications.length
            ? (options.unreadNotificationCount ?? notifications.length)
            : 0,
          decisions,
          pendingDecisionCount,
          decisionApprovals,
          pendingDecisionApprovalCount,
          failedRuns,
          failedRunCount: failedRuns.length,
        },
      });
    }
    const failure = runHistory.find((item) =>
      url.pathname.startsWith(`/api/companies/company/runs/${item.runId}/`),
    );
    if (failure && url.pathname.endsWith("/explanation")) {
      if (explanationOptionsError)
        return route.fulfill({
          status: 503,
          json: { error: "Could not load this Run's AI Employee." },
        });
      const employee = options.noExplanationEmployees
        ? undefined
        : employees.find((item) => item.id === failure.employee?.id);
      return route.fulfill({
        json: {
          employees: employee
            ? [{ id: employee.id, name: employee.name, slug: employee.slug }]
            : [],
          defaultEmployeeId: employee?.id ?? null,
        },
      });
    }
    if (failure && url.pathname.endsWith("/log"))
      return route.fulfill({
        json: {
          content:
            failure.runId === "resumed-run"
              ? "Continuing from saved progress. Verifying earlier Effects before the next batch."
              : options.longFailureTranscript
                ? `${"[07:59:00] Reviewing earlier customer updates.\n".repeat(200)}${failureTranscript}`
                : failureTranscript,
          live: false,
          status: failure.status,
          errorKind: failure.errorKind,
          failureReason: failure.failureReason,
          hasUnfinishedWork: failure.hasUnfinishedWork,
          retryAt: failure.retryAt,
          continuationPending: failure.continuationPending,
          exitCode: failure.exitCode,
          startedAt: failure.startedAt,
          finishedAt: failure.status === "running" ? null : "2026-09-09T08:00:06.000Z",
          browserRecordings: [],
        },
      });
    const evidenceRun = runHistory.find((item) =>
      url.pathname.startsWith(`/api/companies/company/routines/runs/${item.runId}/`),
    );
    if (evidenceRun && url.pathname.endsWith("/checks"))
      return route.fulfill({ json: { results: [] } });
    if (evidenceRun && url.pathname.endsWith("/effects"))
      return route.fulfill({ json: { effects: [], total: 0 } });
    if (url.pathname === "/api/companies/company/employees")
      return route.fulfill(
        rosterError
          ? { status: 503, json: { error: "Could not load your AI employees." } }
          : { json: employees },
      );
    if (url.pathname === "/api/companies/company/members") return route.fulfill({ json: [] });
    if (url.pathname === "/api/companies/company/onboarding-status")
      return route.fulfill({
        json: {
          complete: true,
          employee: null,
          modelConnected: true,
          routineCount: 0,
          scheduledRoutineCount: 0,
          nextRunAt: null,
          skillCount: 0,
          mailGranted: false,
          mailAccessLevel: null,
          nextStep: "done",
        },
      });
    if (url.pathname === "/api/companies/company/work-timeline") {
      if (options.holdWork && !url.searchParams.has("employeeId")) await workGate;
      if (workError && !url.searchParams.has("employeeId"))
        return route.fulfill({
          status: 503,
          json: { error: "Recent work is temporarily unavailable." },
        });
      return route.fulfill({ json: timeline(employees, url.searchParams, options.working) });
    }
    const queueMatch = /^\/api\/companies\/company\/employees\/([^/]+)\/work-queue$/.exec(
      url.pathname,
    );
    if (queueMatch) {
      if (options.holdQueue) await queueGate;
      if (queueError)
        return route.fulfill({
          status: 503,
          json: { error: "Work queue is temporarily unavailable." },
        });
      return route.fulfill({
        json:
          workQueue?.employeeId === queueMatch[1]
            ? workQueue
            : { employeeId: queueMatch[1], current: null, pending: [], pendingCount: 0 },
      });
    }
    if (
      options.brokenAvatar &&
      url.pathname === "/api/companies/company/employees/employee-1/avatar"
    )
      return route.fulfill({ status: 404, body: "" });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  const query = new URLSearchParams();
  if (options.longNames) query.set("longNames", "1");
  if (options.role) query.set("role", options.role);
  if (options.live) query.set("live", "1");
  await page.goto(`${origin}/__home_layout?${query}`, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page.locator('header[aria-label="Home greeting"]').waitFor({ timeout: 300000 });
  await page
    .getByRole("heading", {
      name:
        decisions.length ||
        ((options.role === "admin" || options.role === "owner") && decisionApprovals.length)
          ? "Active decisions"
          : failedRuns.length > 0
            ? "Routines needing attention"
            : options.quiet && unreadChannels.length === 0 && notifications.length === 0
              ? "Nothing needs you right now"
              : notifications.length > 0
                ? "Needs your attention"
                : options.quiet
                  ? "Unread messages"
                  : "Active decisions",
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
  if (options.live)
    await page.locator('[data-socket-status="open"]').waitFor({ state: "attached" });
  return {
    page,
    reads,
    writes,
    mutations,
    releaseWork,
    releaseQueue,
    releaseMarkRead,
    releaseNotificationMarkAll,
    releaseHome,
    releaseExplanation,
    explanationStarted,
    recover: () => {
      rosterError = false;
      workError = false;
      queueError = false;
      homeError = false;
      markReadError = false;
      decisionAnswerError = false;
      explanationError = false;
      explanationOptionsError = false;
    },
    failHome: () => {
      homeError = true;
    },
    failExplanation: () => {
      explanationError = true;
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
    setDecisions: (items: Decision[]) => {
      decisions = items;
      pendingDecisionCount = items.length;
      for (const row of items) decisionDetails.set(row.id, row);
    },
    setReviews: (items: HomeApproval[]) => {
      decisionApprovals = items;
      pendingDecisionApprovalCount = items.length;
    },
    updateReview: (id: string, changes: Partial<Approval>) => {
      const row = reviewDetails.get(id);
      assert.ok(row);
      reviewDetails.set(id, { ...row, ...changes });
    },
    setQueue: (value: EmployeeWorkQueue) => {
      workQueue = value;
    },
    emitResourceEvent: (
      kind: "decision" | "approval" | "run" | "routine" | "employee" | "standdown",
    ) => {
      for (const socket of sockets)
        socket.send(JSON.stringify({ type: "resource.changed", kind, scopeIds: [] }));
    },
  };
}
const greeting = (page: Page) => page.locator('header[aria-label="Home greeting"]');
const work = (page: Page) =>
  page.getByRole("complementary", { name: "AI employee work", exact: true });
const bubbles = (page: Page) => work(page).getByRole("button");
const card = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const activeDecisions = (page: Page) =>
  page.getByRole("region", { name: "Active decisions", exact: true });
const statTiles = (page: Page) =>
  page.getByRole("link").filter({
    has: page.getByText(
      /^(Unread notifications|Todos assigned to you|Reviews waiting on you|Pending approvals)$/,
    ),
  });
const decisionRows = (page: Page) => activeDecisions(page).locator(":scope > ul > li");
async function editMailReply(page: Page, id: string, body: string) {
  const row = page.locator(`#review-${id}`);
  await row.getByRole("button", { name: "Edit email", exact: true }).click();
  const textarea = row.getByRole("textbox", { name: "Email", exact: true });
  await textarea.fill(body);
  await textarea.press("ArrowLeft");
  const element = await textarea.elementHandle();
  assert.ok(element);
  return { row, textarea, element, body };
}
async function retainsMailEditor(
  editor: Awaited<ReturnType<typeof editMailReply>>,
  focused = false,
) {
  assert.equal(await editor.element.evaluate((element) => element.isConnected), true);
  assert.equal(await editor.textarea.inputValue(), editor.body);
  assert.equal(
    await editor.textarea.evaluate((element) => (element as HTMLTextAreaElement).selectionStart),
    editor.body.length - 1,
    "the editor must retain the insertion point",
  );
  if (focused)
    assert.equal(
      await editor.element.evaluate((element) => element === document.activeElement),
      true,
      "refresh must leave keyboard focus in the same textarea",
    );
}
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
async function statRowsFillContent(page: Page, count: number) {
  assert.equal(await statTiles(page).count(), count, "only nonzero counters occupy space");
  const header = await box(greeting(page));
  const tiles = await Promise.all((await statTiles(page).all()).map(box));
  const rows = new Map<number, typeof tiles>();
  for (const tile of tiles) rows.set(tile.y, [...(rows.get(tile.y) ?? []), tile]);
  assert.equal(rows.size, page.viewportSize()!.width >= 1024 ? 1 : Math.ceil(count / 2));
  for (const row of rows.values()) {
    const first = row[0];
    const last = row[row.length - 1];
    assert.ok(Math.abs(first.x - header.x) < 1, "counter row starts at the content's left edge");
    assert.ok(
      Math.abs(last.x + last.width - header.x - header.width) < 1,
      "counter row fills the content's right edge without empty slots",
    );
    for (const tile of row)
      assert.ok(Math.abs(tile.width - first.width) < 1, "counter tiles share their row equally");
  }
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
const filters = process.argv.slice(2).map((value) => value.toLowerCase());
async function check(name: string, run: () => Promise<void>) {
  if (filters.length && !filters.some((filter) => name.toLowerCase().includes(filter))) return;
  if (process.env.GENOSYN_HOME_TEST_FILTER && !name.includes(process.env.GENOSYN_HOME_TEST_FILTER))
    return;
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
  for (const width of [1440, 390]) {
    await check(
      `Resume unfinished work confirms a fresh time window without a token limit and follows the Run at ${width}px`,
      async () => {
        const { page, mutations } = await open({
          width,
          quiet: true,
          role: "admin",
          allowRunResume: true,
          failedRuns: [failedRun({ hasUnfinishedWork: true })],
        });
        await card(page, "Routines needing attention")
          .getByRole("link", { name: /Daily customer update/ })
          .click();
        const modal = page.getByRole("dialog", { name: "Run: Daily customer update", exact: true });
        await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
        const resume = modal.getByRole("button", { name: "Resume unfinished work", exact: true });
        await resume.click();
        const confirmation = page.getByRole("dialog", {
          name: "Resume Daily customer update?",
          exact: true,
        });
        await confirmation
          .getByText(/configured time limit starts again, with no total model token limit/)
          .waitFor();
        await confirmation.getByText(/verify earlier Effects/).waitFor();
        assert.equal(mutations.length, 0, "opening the confirmation cannot start a Run");
        await page.screenshot({
          path: path.join(output, `home-run-resume-confirm-${width}.png`),
          fullPage: true,
        });
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(mutations.length, 0, "cancelling preserves the original Run without a write");
        await resume.click();
        await confirmation
          .getByRole("button", { name: "Resume unfinished work", exact: true })
          .click();
        await modal.locator("pre").filter({ hasText: "Continuing from saved progress." }).waitFor();
        assert.deepEqual(mutations, [
          {
            path: "/api/companies/company/runs/failed-run/resume",
            body: { acknowledgeNewAllowance: true },
          },
        ]);
        assert.equal(
          await modal.getByRole("button", { name: "Resume unfinished work", exact: true }).count(),
          0,
        );
        assert.equal(await modal.getByRole("button", { name: "Retry", exact: true }).count(), 0);
        await fits(page);
        assert.equal(
          await modal.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(output, `home-run-resumed-${width}.png`),
          fullPage: true,
        });
        await page.close();
      },
    );
  }
  await check(
    "Resume unfinished work is unavailable to Members, Errors, missing progress, or pending recovery",
    async () => {
      for (const scenario of [
        { role: "member" as const, run: failedRun({ hasUnfinishedWork: true }) },
        { role: "admin" as const, run: failedRun({ hasUnfinishedWork: false }) },
        {
          role: "admin" as const,
          run: failedRun({ status: "error", errorKind: "timeout", hasUnfinishedWork: true }),
        },
        {
          role: "admin" as const,
          run: failedRun({ errorKind: "runtime", hasUnfinishedWork: true }),
        },
        {
          role: "admin" as const,
          run: failedRun({
            hasUnfinishedWork: true,
            retryAt: "2026-09-09T10:00:00.000Z",
            continuationPending: true,
          }),
        },
      ]) {
        const { page, mutations } = await open({
          quiet: true,
          role: scenario.role,
          failedRuns: [scenario.run],
        });
        assert.equal(
          await page.getByRole("button", { name: "Resume unfinished work", exact: true }).count(),
          0,
        );
        await card(page, "Routines needing attention")
          .getByRole("link", { name: /Daily customer update/ })
          .click();
        const modal = page.getByRole("dialog", { name: "Run: Daily customer update", exact: true });
        await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
        assert.equal(
          await modal.getByRole("button", { name: "Resume unfinished work", exact: true }).count(),
          0,
        );
        assert.equal(mutations.length, 0);
        await page.close();
      }
    },
  );
  await check(
    "Resume unfinished work on Home keeps progress visible when the server refuses",
    async () => {
      const { page, mutations } = await open({
        quiet: true,
        role: "owner",
        allowRunResume: true,
        runResumeError: true,
        failedRuns: [failedRun({ hasUnfinishedWork: true })],
      });
      const panel = card(page, "Routines needing attention");
      await panel.getByRole("button", { name: "Resume unfinished work", exact: true }).click();
      const confirmation = page.getByRole("dialog", {
        name: "Resume Daily customer update?",
        exact: true,
      });
      await confirmation
        .getByRole("button", { name: "Resume unfinished work", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Couldn’t resume unfinished work", exact: true })
        .getByText("A newer Run already continued this work.", { exact: true })
        .waitFor();
      assert.equal(mutations.length, 1);
      assert.equal(await panel.getByRole("link", { name: /Daily customer update/ }).count(), 1);
      await page.close();
    },
  );
  for (const width of [1440, 390, 320]) {
    await check(
      `Run explanation opens once, renders markdown and preserves the log at ${width}px`,
      async () => {
        const fixture = await open({
          width,
          quiet: true,
          count: 2,
          failedRuns: [failedRun({ employee: roster(2)[1] })],
          holdExplanation: true,
          longFailureTranscript: width === 1440,
        });
        const { page, mutations } = fixture;
        const panel = card(page, "Routines needing attention");
        const explain = panel.getByRole("button", { name: /^Why did it fail\?/ });
        await explain.click();
        const modal = page.getByRole("dialog", { name: "Run: Daily customer update", exact: true });
        await modal.getByRole("status").waitFor();
        await fixture.explanationStarted;
        assert.equal(
          mutations.length,
          1,
          "opening the modal starts exactly one analysis in Strict Mode",
        );
        assert.equal(
          await modal.getByRole("combobox").count(),
          0,
          "the Run's AI Employee is fixed and never shown in a dropdown",
        );
        await modal
          .getByRole("status")
          .filter({ hasText: /Reviewing this Run/ })
          .waitFor();
        const message = modal.getByRole("textbox", { name: "Message Employee 2", exact: true });
        await message.fill("Which Connection needs attention?");
        assert.equal(
          await modal.getByRole("button", { name: "Send", exact: true }).isDisabled(),
          true,
          "a question can be drafted while the initial analysis runs, but cannot be sent yet",
        );
        await message.press("Control+Enter");
        assert.equal(mutations.length, 1, "the shortcut cannot send while analysis is in progress");
        assert.equal(
          await modal.getByRole("button", { name: "Ask AI Employee", exact: true }).count(),
          0,
        );
        assert.equal(await modal.getByRole("button", { name: "Retry", exact: true }).count(), 0);
        fixture.releaseExplanation();
        await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
        await modal
          .getByLabel("Conversation about this Run", { exact: true })
          .getByText("Employee 2", { exact: true })
          .waitFor();
        assert.equal(await message.inputValue(), "Which Connection needs attention?");
        assert.equal(
          await modal.locator("strong").filter({ hasText: "the Connection expired" }).count(),
          1,
        );
        await modal
          .getByText("Reconnect the mailbox, then check for a sent message before retrying.", {
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page.getByLabel("Opened route").count(),
          0,
          "explanations stay in Home's modal",
        );
        await fits(page);
        const bounds = await box(modal);
        assert.ok(
          bounds.x >= 0 && bounds.x + bounds.width <= width,
          "explanation modal stays inside the viewport",
        );
        assert.equal(
          await modal.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(output, `home-run-explanation-${width}.png`),
          fullPage: true,
        });
        const logTab = modal.getByRole("tab", { name: "Run log", exact: true });
        const explanationTab = modal.getByRole("tab", { name: "Why did it fail?", exact: true });
        assert.equal(await explanationTab.getAttribute("aria-selected"), "true");
        await logTab.click();
        assert.equal(await logTab.getAttribute("aria-selected"), "true");
        await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
        if (width === 1440) {
          await page.waitForFunction(() => {
            const log = document.querySelector('[role="dialog"] pre');
            return (
              log &&
              log.scrollHeight > log.clientHeight &&
              log.scrollHeight - log.clientHeight - log.scrollTop < 24
            );
          });
        }
        await explanationTab.click();
        await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
        assert.equal(
          await message.inputValue(),
          "Which Connection needs attention?",
          "switching tabs preserves the unsent draft",
        );
        assert.deepEqual(
          mutations,
          [
            {
              path: "/api/companies/company/runs/failed-run/explanation",
              body: {},
            },
          ],
          "returning from the log reuses the explanation and never retries or dismisses the Run",
        );
        assert.equal(await modal.getByRole("button", { name: "Close", exact: true }).count(), 1);
        await modal.getByRole("button", { name: "Close", exact: true }).click();
        await modal.waitFor({ state: "detached" });
        assert.equal(await panel.getByText("Daily customer update", { exact: true }).count(), 1);
        await page.close();
      },
    );
  }
  for (const width of [1440, 390, 320]) {
    await check(
      `Run explanation keeps its composer visible with long replies at ${width}px`,
      async () => {
        const { page } = await open({
          width,
          height: 740,
          quiet: true,
          failedRuns: [failedRun()],
          longRunExplanation: true,
        });
        await card(page, "Routines needing attention")
          .getByRole("button", { name: /^Why did it fail\?/ })
          .click();
        const modal = page.getByRole("dialog");
        await modal.getByRole("heading", { name: "Evidence 16", exact: true }).waitFor();
        const conversation = modal.getByLabel("Conversation about this Run", { exact: true });
        const message = modal.getByRole("textbox", { name: "Message Jamie Mallers", exact: true });
        const send = modal.getByRole("button", { name: "Send", exact: true });
        assert.equal(
          await conversation.evaluate((element) => element.scrollHeight > element.clientHeight),
          true,
          "long explanations scroll within the conversation",
        );
        const modalBounds = await box(modal);
        const messageBounds = await box(message);
        const sendBounds = await box(send);
        assert.ok(messageBounds.y > modalBounds.y);
        assert.ok(
          sendBounds.y + sendBounds.height <= Math.min(modalBounds.y + modalBounds.height, 740),
          "the Send button stays inside the modal and viewport",
        );
        await conversation.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        assert.ok(
          Math.abs((await box(message)).y - messageBounds.y) < 1,
          "scrolling the reply does not move the composer",
        );
        assert.ok(
          Math.abs((await box(send)).y - sendBounds.y) < 1,
          "scrolling the reply does not move Send",
        );
        await fits(page);
        await page.screenshot({
          path: path.join(output, `home-run-explanation-long-${width}.png`),
          fullPage: true,
        });
        await page.close();
      },
    );
  }
  await check(
    "Run explanation preserves its reading position when returning from the log",
    async () => {
      const { page, mutations } = await open({
        quiet: true,
        failedRuns: [failedRun()],
        longRunExplanation: true,
      });
      await card(page, "Routines needing attention")
        .getByRole("button", { name: /^Why did it fail\?/ })
        .click();
      const modal = page.getByRole("dialog");
      await modal.getByRole("heading", { name: "Evidence 16", exact: true }).waitFor();
      const message = modal.getByRole("textbox", { name: "Message Jamie Mallers", exact: true });
      await message.fill("Was any email sent?");
      await modal.getByRole("button", { name: "Send", exact: true }).click();
      await modal.getByText(failureFollowup, { exact: true }).waitFor();
      const conversation = modal.getByLabel("Conversation about this Run", { exact: true });
      const readingPosition = await conversation.evaluate((element) => {
        element.scrollTop = 160;
        return element.scrollTop;
      });
      assert.ok(readingPosition > 0, "the reader is partway through an earlier explanation");
      await modal.getByRole("tab", { name: "Run log", exact: true }).click();
      await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
      await modal.getByRole("tab", { name: "Why did it fail?", exact: true }).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await conversation.evaluate((element) => element.scrollTop),
        readingPosition,
        "checking the log and returning keeps the reader's place when no reply arrived",
      );
      assert.equal(mutations.length, 2, "changing tabs does not request another explanation");
      await page.close();
    },
  );
  await check(
    "Run explanation keeps its composer reachable in a short landscape viewport",
    async () => {
      const { page, mutations } = await open({
        width: 740,
        height: 360,
        quiet: true,
        failedRuns: [failedRun()],
        longRunExplanation: true,
      });
      await card(page, "Routines needing attention")
        .getByRole("button", { name: /^Why did it fail\?/ })
        .click();
      const modal = page.getByRole("dialog");
      await modal.getByRole("heading", { name: "Evidence 16", exact: true }).waitFor();
      const explanationPanel = modal.getByRole("tabpanel", {
        name: "Why did it fail?",
        exact: true,
      });
      const message = modal.getByRole("textbox", { name: "Message Jamie Mallers", exact: true });
      const send = modal.getByRole("button", { name: "Send", exact: true });
      await send.scrollIntoViewIfNeeded();
      assert.ok(
        await explanationPanel.evaluate((element) => (element.parentElement?.scrollTop ?? 0) > 0),
        "the modal body can scroll to reveal the composer on a short screen",
      );
      const modalBounds = await box(modal);
      const messageBounds = await box(message);
      const sendBounds = await box(send);
      assert.ok(
        messageBounds.y >= modalBounds.y &&
          messageBounds.y + messageBounds.height <= modalBounds.y + modalBounds.height,
        "the complete message field is reachable inside the modal",
      );
      assert.ok(
        sendBounds.y >= modalBounds.y &&
          sendBounds.y + sendBounds.height <= Math.min(modalBounds.y + modalBounds.height, 360),
        "Send is reachable inside the modal and viewport",
      );
      assert.equal(
        await send.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit === element || element.contains(hit);
        }),
        true,
        "the Send button is not hidden behind clipped chrome",
      );
      await message.fill("Was any email sent?");
      await send.click();
      await modal.getByText(failureFollowup, { exact: true }).waitFor();
      assert.equal(mutations.length, 2);
      await fits(page);
      await page.screenshot({
        path: path.join(output, "home-run-explanation-landscape.png"),
        fullPage: true,
      });
      await page.close();
    },
  );
  await check(
    "Run explanation supports inline errors and retries with its original AI Employee",
    async () => {
      const fixture = await open({
        quiet: true,
        count: 2,
        failedRuns: [
          failedRun({
            status: "error",
            errorKind: "runtime",
            failureReason: null,
            employee: roster(2)[1],
          }),
        ],
        explanationError: true,
      });
      const { page, mutations } = fixture;
      await card(page, "Routines needing attention")
        .getByRole("button", { name: /^Why did it error\?/ })
        .click();
      const modal = page.getByRole("dialog");
      await modal
        .getByRole("alert")
        .filter({ hasText: "The AI Model is unavailable. Please try again." })
        .waitFor();
      assert.equal(
        await page.getByRole("dialog").count(),
        1,
        "request failures remain in the explanation modal",
      );
      assert.equal(await modal.getByRole("combobox").count(), 0);
      assert.equal(await modal.getByRole("button", { name: "Try again", exact: true }).count(), 1);
      fixture.recover();
      await modal.getByRole("button", { name: "Try again", exact: true }).click();
      await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
      await modal
        .getByLabel("Conversation about this Run", { exact: true })
        .getByText("Employee 2", { exact: true })
        .waitFor();
      assert.deepEqual(mutations, [
        {
          path: "/api/companies/company/runs/failed-run/explanation",
          body: {},
        },
        {
          path: "/api/companies/company/runs/failed-run/explanation",
          body: {},
        },
      ]);
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      await page.close();
    },
  );
  for (const shortcut of ["Control+Enter", "Meta+Enter"]) {
    await check(
      `Run explanation accepts ${shortcut} follow-up chat and retains its conversation beside the log`,
      async () => {
        const { page, mutations } = await open({ quiet: true, failedRuns: [failedRun()] });
        await card(page, "Routines needing attention")
          .getByRole("button", { name: /^Why did it fail\?/ })
          .click();
        const modal = page.getByRole("dialog");
        await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
        const message = modal.getByRole("textbox", { name: "Message Jamie Mallers", exact: true });
        await message.fill("Was any email sent?");
        await message.press(shortcut);
        await modal.getByText(failureFollowup, { exact: true }).waitFor();
        await modal.getByText("Was any email sent?", { exact: true }).waitFor();
        assert.equal(
          await modal.getByRole("heading", { name: "What happened", exact: true }).count(),
          1,
        );
        assert.equal(await message.inputValue(), "", "sending a follow-up clears the composer");
        assert.equal(mutations.length, 2);
        const followup = mutations[1].body as {
          employeeId?: string;
          message: string;
          history: Array<{ role: string; content: string }>;
        };
        assert.equal(mutations[1].path, "/api/companies/company/runs/failed-run/explanation");
        assert.equal(followup.employeeId, undefined);
        assert.equal(followup.message, "Was any email sent?");
        assert.ok(
          followup.history.some(
            (item) => item.role === "assistant" && item.content === failureExplanation,
          ),
          "the follow-up includes the initial explanation for context",
        );
        await modal.getByRole("tab", { name: "Run log", exact: true }).click();
        await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
        await modal.getByRole("tab", { name: "Why did it fail?", exact: true }).click();
        await modal.getByText(failureFollowup, { exact: true }).waitFor();
        assert.equal(
          mutations.length,
          2,
          "switching panels preserves the conversation without resending",
        );
        await page.close();
      },
    );
  }
  await check(
    "Run explanation retries a failed follow-up with the same employee and message",
    async () => {
      const fixture = await open({
        quiet: true,
        count: 2,
        failedRuns: [failedRun({ employee: roster(2)[1] })],
      });
      const { page, mutations } = fixture;
      await card(page, "Routines needing attention")
        .getByRole("button", { name: /^Why did it fail\?/ })
        .click();
      const modal = page.getByRole("dialog");
      await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
      fixture.failExplanation();
      const message = modal.getByRole("textbox", { name: "Message Employee 2", exact: true });
      await message.fill("Was any email sent?");
      await modal.getByRole("button", { name: "Send", exact: true }).click();
      await modal.getByRole("alert").waitFor();
      assert.equal(await message.inputValue(), "Was any email sent?");
      assert.equal(await modal.getByRole("combobox").count(), 0);
      fixture.recover();
      await modal.getByRole("button", { name: "Try again", exact: true }).click();
      await modal.getByText(failureFollowup, { exact: true }).waitFor();
      assert.equal(mutations.length, 3);
      assert.deepEqual(
        mutations[2],
        mutations[1],
        "retry preserves the failed question and history",
      );
      assert.equal((mutations[2].body as { employeeId?: string }).employeeId, undefined);
      assert.equal(
        await modal
          .getByLabel("Conversation about this Run", { exact: true })
          .getByText("Employee 2", { exact: true })
          .count(),
        2,
      );
      assert.equal(await modal.getByText("Was any email sent?", { exact: true }).count(), 1);
      assert.equal(await message.inputValue(), "");
      await page.close();
    },
  );
  await check("Run explanation can recover when its AI Employee fails to load", async () => {
    const fixture = await open({
      quiet: true,
      failedRuns: [failedRun()],
      explanationOptionsError: true,
    });
    const { page, mutations } = fixture;
    await card(page, "Routines needing attention")
      .getByRole("button", { name: /^Why did it fail\?/ })
      .click();
    const modal = page.getByRole("dialog");
    await modal
      .getByRole("alert")
      .filter({ hasText: "Could not load this Run's AI Employee." })
      .waitFor();
    assert.deepEqual(mutations, [], "the model is not called before its AI Employee is known");
    fixture.recover();
    await modal.getByRole("button", { name: "Try again", exact: true }).click();
    await modal.getByRole("heading", { name: "What happened", exact: true }).waitFor();
    assert.equal(mutations.length, 1);
    await page.close();
  });
  await check("Run explanation can close while analysis is in progress", async () => {
    const fixture = await open({ quiet: true, failedRuns: [failedRun()], holdExplanation: true });
    const { page, mutations } = fixture;
    await card(page, "Routines needing attention")
      .getByRole("button", { name: /^Why did it fail\?/ })
      .click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("status").waitFor();
    await fixture.explanationStarted;
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.method() === "POST" && request.url().endsWith("/explanation"),
    });
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    fixture.releaseExplanation();
    await aborted;
    await page.getByRole("heading", { name: "Routines needing attention", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(mutations.length, 1);
    await page.close();
  });
  await check("Run explanation never falls back when its AI Employee cannot analyze", async () => {
    const { page, mutations } = await open({
      quiet: true,
      count: 2,
      failedRuns: [failedRun()],
      noExplanationEmployees: true,
    });
    await card(page, "Routines needing attention")
      .getByRole("button", { name: /^Why did it fail\?/ })
      .click();
    const modal = page.getByRole("dialog");
    await modal
      .getByText(
        "The AI Employee who ran this Routine needs a connected AI Model to explain this Run. You can still read the Run log.",
        { exact: true },
      )
      .waitFor();
    assert.deepEqual(mutations, []);
    assert.equal(await modal.getByRole("combobox").count(), 0);
    assert.equal(await modal.getByRole("textbox").count(), 0);
    assert.equal(
      await modal.getByRole("button", { name: "Ask AI Employee", exact: true }).count(),
      0,
    );
    await modal.getByRole("tab", { name: "Run log", exact: true }).click();
    await modal.locator("pre").filter({ hasText: failureTranscript }).waitFor();
    await page.close();
  });
  await check("Run explanation uses Error wording for legacy operational failures", async () => {
    const { page, mutations } = await open({
      quiet: true,
      failedRuns: [
        failedRun({ runId: "timeout-run", status: "timeout" }),
        failedRun({ runId: "interrupted-run", status: "interrupted" }),
      ],
    });
    const panel = card(page, "Routines needing attention");
    assert.equal(await panel.getByRole("button", { name: /^Why did it error\?/ }).count(), 2);
    assert.equal(await panel.getByRole("button", { name: /^Why did it fail\?/ }).count(), 0);
    assert.deepEqual(mutations, [], "analysis remains an explicit action");
    await page.close();
  });
  for (const count of [1, 2, 3, 4]) {
    await check(`${count} Home counters fill every responsive row`, async () => {
      const { page } = await open({
        quiet: count === 1,
        notifications: [notification("review-one", "The customer reply is waiting for review")],
        unreadNotificationCount: 69,
        statCounts: {
          reviewTodoCount: count >= 3 ? 2 : 0,
          pendingApprovalCount: count >= 4 ? 1 : 0,
        },
      });
      await statTiles(page).filter({ hasText: "Unread notifications" }).getByText("69").waitFor();
      for (const width of [320, 390, 768, 1440, 2560]) {
        await page.setViewportSize({ width, height: 1000 });
        await statRowsFillContent(page, count);
        await fits(page);
        if (count === 1 && width === 2560) {
          const body = card(page, "Needs your attention").locator(":scope > div").last();
          const bodyBox = await box(body);
          const rowsBox = await box(body.locator(":scope > ul"));
          assert.ok(
            Math.abs(bodyBox.height - rowsBox.height) < 1,
            "a single short queue has no forced empty body space",
          );
        }
        if (count === 1 && (width === 390 || width === 1440 || width === 2560)) {
          await page.screenshot({
            path: path.join(output, `home-single-notification-counter-${width}.png`),
            fullPage: true,
          });
        }
      }
      if (count === 2) {
        await page.getByRole("button", { name: "Mark all as read", exact: true }).click();
        await page
          .getByText("Unread notifications", { exact: true })
          .waitFor({ state: "detached" });
        await statRowsFillContent(page, 1);
        await fits(page);
      }
      await page.close();
    });
  }
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
          await page.getByRole("heading", { name: "Active decisions", exact: true }).count(),
          1,
        );
        assert.equal(
          await page
            .getByText("Which retention commitment needs attention?", { exact: true })
            .count(),
          1,
        );
        await fillsContent(page, "Active decisions");
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
    "a Member can answer an active Decision from Home and recover an inline failure",
    async () => {
      const fixture = await open({
        quiet: true,
        decisions: [decision()],
        allowDecisionAnswer: true,
        decisionAnswerError: true,
      });
      const { page, mutations } = fixture;
      assert.equal(
        await page.getByRole("heading", { name: "Nothing needs you right now" }).count(),
        0,
      );
      await fillsContent(page, "Active decisions");
      await activeDecisions(page).getByText("Confirm the owner", { exact: true }).click();
      assert.equal(
        await activeDecisions(page)
          .getByRole("radio", { name: /^Confirm the owner/ })
          .isChecked(),
        true,
      );
      assert.deepEqual(mutations, [], "choosing an answer must not submit it");
      await activeDecisions(page)
        .getByRole("button", { name: "Add guidance", exact: true })
        .click();
      await activeDecisions(page).getByRole("textbox").fill("Jamie owns the next update.");
      await activeDecisions(page)
        .getByRole("button", { name: "Confirm: Confirm the owner", exact: true })
        .click();
      await activeDecisions(page)
        .getByText("The answer could not be saved.", { exact: true })
        .waitFor();
      assert.equal(await decisionRows(page).count(), 1, "failed answers stay available on Home");
      fixture.recover();
      await activeDecisions(page)
        .getByRole("button", { name: "Confirm: Confirm the owner", exact: true })
        .click();
      await activeDecisions(page).getByText("answered", { exact: true }).waitFor();
      assert.equal(
        await decisionRows(page).count(),
        1,
        "the final answer keeps its Home stack mounted",
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "Nothing needs you right now", exact: true })
          .count(),
        0,
      );
      await activeDecisions(page)
        .getByRole("button", { name: "Close decision", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(
        await activeDecisions(page).count(),
        0,
        "Close clears the followed Decision from Home",
      );
      await page
        .getByRole("status")
        .getByText(`Decision “${decision().title}” answered.`, { exact: true })
        .waitFor();
      assert.deepEqual(mutations, [
        {
          path: "/api/companies/company/decisions/decision/decide",
          body: { optionId: "confirm", note: "Jamie owns the next update." },
        },
        {
          path: "/api/companies/company/decisions/decision/decide",
          body: { optionId: "confirm", note: "Jamie owns the next update." },
        },
      ]);
      await page.close();
    },
  );
  await check(
    "a failed Home refresh preserves the saved answer and cannot reopen it after Close",
    async () => {
      const fixture = await open({
        quiet: true,
        decisions: [decision()],
        allowDecisionAnswer: true,
      });
      const { page } = fixture;
      fixture.failHome();
      await activeDecisions(page).getByText("Confirm the owner", { exact: true }).click();
      await activeDecisions(page)
        .getByRole("button", { name: "Confirm: Confirm the owner", exact: true })
        .click();
      await activeDecisions(page).getByText("answered", { exact: true }).waitFor();
      await page.getByText("Home is unavailable.", { exact: true }).waitFor();
      await activeDecisions(page)
        .getByRole("button", { name: "Close decision", exact: true })
        .click();
      await page.locator("#decision-decision").waitFor({ state: "detached" });
      assert.equal(
        await page.getByRole("button", { name: "Confirm: Confirm the owner", exact: true }).count(),
        0,
      );
      fixture.recover();
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await page.locator("#decision-decision").count(), 0);
      assert.deepEqual(fixture.mutations, [
        { path: "/api/companies/company/decisions/decision/decide", body: { optionId: "confirm" } },
      ]);
      await page.close();
    },
  );
  await check(
    "snoozing a Decision from Home removes it and announces the selected duration",
    async () => {
      const { page, mutations } = await open({
        quiet: true,
        decisions: [decision()],
        allowDecisionSnooze: true,
        width: 390,
      });
      await activeDecisions(page).getByRole("button", { name: "Snooze", exact: true }).click();
      await page.getByRole("menuitem", { name: "1 day", exact: true }).click();
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).count(), 0);
      await page
        .getByRole("status")
        .getByText(`Decision “${decision().title}” snoozed for 1 day.`, { exact: true })
        .waitFor();
      assert.deepEqual(mutations, [
        { path: "/api/companies/company/decisions/decision/snooze", body: { duration: "one_day" } },
      ]);
      await page.close();
    },
  );
  for (const width of [1440, 390]) {
    await check(
      `active Decisions preview prioritizes urgency and age with the complete count at ${width}px`,
      async () => {
        const { page } = await open({
          quiet: true,
          width,
          role: "admin",
          decisions: [
            decision({ id: "new-urgent", title: "A new urgent customer question" }),
            decision({
              id: "low",
              title: "A lower priority question",
              urgency: "low",
              createdAt: "2026-09-08T06:00:00.000Z",
            }),
            decision({
              id: "old-urgent",
              title: "The oldest urgent customer question",
              createdAt: "2026-09-09T07:00:00.000Z",
            }),
            decision({
              id: "normal",
              title: "A routine customer question",
              urgency: "normal",
              createdAt: "2026-09-09T08:30:00.000Z",
            }),
          ],
          decisionApprovals: [review("proactive_work"), review("mail_send")],
          pendingDecisionCount: 12,
          pendingDecisionApprovalCount: 4,
        });
        assert.deepEqual(
          await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
          [
            "The oldest urgent customer question",
            "A new urgent customer question",
            "Prepare the retention follow-up",
          ],
        );
        assert.equal(
          await activeDecisions(page).getByText("16 waiting", { exact: true }).count(),
          1,
        );
        assert.equal(
          await activeDecisions(page)
            .getByText("A lower priority question", { exact: true })
            .count(),
          0,
        );
        const all = activeDecisions(page).getByRole("link", { name: "All decisions", exact: true });
        const more = activeDecisions(page).getByRole("link", {
          name: "View all decisions · 13 more waiting",
          exact: true,
        });
        assert.equal(await all.getAttribute("href"), "/c/company/decisions");
        assert.equal(await more.getAttribute("href"), "/c/company/decisions");
        await fillsContent(page, "Active decisions");
        await fits(page);
        await page.screenshot({
          path: path.join(output, `home-active-decisions-${width}.png`),
          fullPage: true,
        });
        await (width === 1440 ? all : more).click();
        await page.getByRole("status").filter({ hasText: "/c/company/decisions" }).waitFor();
        await page.close();
      },
    );
  }
  await check(
    "Members see only Decisions even when an unexpected response includes privileged reviews",
    async () => {
      const { page, mutations } = await open({
        quiet: true,
        role: "member",
        decisions: [decision()],
        decisionApprovals: [review("proactive_work"), review("mail_send")],
        pendingDecisionApprovalCount: 20,
        allowDecisionAnswer: true,
      });
      assert.equal(await decisionRows(page).count(), 1);
      assert.equal(await activeDecisions(page).getByText("1 waiting", { exact: true }).count(), 1);
      assert.equal(
        await page.getByText("Prepare the retention follow-up", { exact: true }).count(),
        0,
      );
      assert.equal(await page.getByText("Review the customer reply", { exact: true }).count(), 0);
      assert.equal(
        await activeDecisions(page)
          .getByRole("link", { name: /more waiting/ })
          .count(),
        0,
      );
      await activeDecisions(page).getByText("Confirm the owner", { exact: true }).click();
      await activeDecisions(page)
        .getByRole("button", { name: "Confirm: Confirm the owner", exact: true })
        .click();
      await activeDecisions(page)
        .getByRole("button", { name: "Close decision", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).count(), 0);
      assert.deepEqual(mutations, [
        { path: "/api/companies/company/decisions/decision/decide", body: { optionId: "confirm" } },
      ]);
      await page.close();
    },
  );
  for (const role of ["owner", "admin"] as const) {
    await check(`${role} can review proposed work and email directly on Home`, async () => {
      const { page, mutations } = await open({
        quiet: true,
        role,
        decisionApprovals: [review("proactive_work"), review("mail_send")],
        allowReview: true,
        width: role === "owner" ? 1440 : 390,
        dark: role === "admin",
      });
      assert.equal(await decisionRows(page).count(), 2);
      assert.equal(await activeDecisions(page).getByText("2 waiting", { exact: true }).count(), 1);
      assert.equal(
        await page.getByRole("heading", { name: "Nothing needs you right now" }).count(),
        0,
      );
      await activeDecisions(page)
        .getByText("Jamie will send your next update tomorrow.", { exact: true })
        .waitFor();
      await fits(page);
      await page.screenshot({
        path: path.join(output, `home-active-reviews-${role}.png`),
        fullPage: true,
      });
      await activeDecisions(page)
        .getByRole("button", { name: "Approve & start", exact: true })
        .click();
      await activeDecisions(page).getByText("Work in progress", { exact: true }).waitFor();
      assert.equal(await decisionRows(page).count(), 2);
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        ["Prepare the retention follow-up", "Review the customer reply"],
      );
      await page
        .getByRole("status")
        .getByText("Work review “Prepare the retention follow-up” approved.", { exact: true })
        .waitFor();
      await activeDecisions(page).getByRole("button", { name: "Send now", exact: true }).click();
      await activeDecisions(page).getByText("Sent", { exact: true }).waitFor();
      assert.equal(
        await decisionRows(page).count(),
        2,
        "both outcomes stay in their original slots",
      );
      await fits(page);
      await page
        .getByRole("status")
        .getByText("Email review “Review the customer reply” sent.", { exact: true })
        .waitFor();
      await page
        .locator("#review-work-review")
        .getByRole("button", { name: "Close review", exact: true })
        .click();
      assert.equal(await decisionRows(page).count(), 1);
      await page
        .locator("#review-mail-review")
        .getByRole("button", { name: "Close review", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).count(), 0);
      assert.deepEqual(mutations, [
        {
          path: "/api/companies/company/approvals/work-review/approve",
          body: { reviewRevision: "work-revision" },
        },
        {
          path: "/api/companies/company/approvals/mail-review/approve",
          body: { reviewRevision: "mail-revision" },
        },
      ]);
      await page.close();
    });
  }
  await check(
    "a followed work review receives a live failed outcome and survives mobile reload",
    async () => {
      const fixture = await open({
        quiet: true,
        live: true,
        role: "admin",
        width: 320,
        decisionApprovals: [review("proactive_work")],
        allowReview: true,
      });
      const { page } = fixture;
      await activeDecisions(page)
        .getByRole("button", { name: "Approve & start", exact: true })
        .click();
      await activeDecisions(page).getByText("Work in progress", { exact: true }).waitFor();
      fixture.updateReview("work-review", {
        status: "execution_failed",
        errorMessage: "The checkout service was unavailable; no fix was published.",
        outcomeSummary: "Investigation stopped when the service became unavailable.",
      });
      fixture.emitResourceEvent("approval");
      await activeDecisions(page).getByText("Work failed", { exact: true }).waitFor();
      await activeDecisions(page)
        .getByText("The checkout service was unavailable; no fix was published.", { exact: true })
        .waitFor();
      await page.reload({ waitUntil: "commit" });
      await activeDecisions(page).getByText("Work failed", { exact: true }).waitFor();
      await fits(page);
      await page.screenshot({
        path: path.join(output, "home-followed-work-failed-mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await activeDecisions(page)
          .getByRole("button", { name: "Approve & start", exact: true })
          .count(),
        0,
      );
      await activeDecisions(page)
        .getByRole("button", { name: "Close review", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.deepEqual(fixture.mutations, [
        {
          path: "/api/companies/company/approvals/work-review/approve",
          body: { reviewRevision: "work-revision" },
        },
      ]);
      await page.close();
    },
  );
  await check(
    "Decision and Approval events refresh active work without reloading Home",
    async () => {
      const fixture = await open({ quiet: true, live: true, role: "admin" });
      const { page } = fixture;
      assert.equal(await activeDecisions(page).count(), 0, "an empty section stays hidden");
      fixture.setDecisions([decision()]);
      fixture.emitResourceEvent("decision");
      await activeDecisions(page)
        .getByRole("heading", { name: decision().title, exact: true })
        .waitFor();
      fixture.setReviews([review("proactive_work")]);
      fixture.emitResourceEvent("approval");
      await activeDecisions(page)
        .getByRole("heading", { name: "Prepare the retention follow-up", exact: true })
        .waitFor();
      assert.equal(await decisionRows(page).count(), 2);
      fixture.setDecisions([]);
      fixture.emitResourceEvent("decision");
      await activeDecisions(page)
        .getByRole("heading", { name: decision().title, exact: true })
        .waitFor({ state: "detached" });
      assert.equal(await decisionRows(page).count(), 1);
      fixture.setReviews([]);
      fixture.emitResourceEvent("approval");
      await page
        .getByRole("heading", { name: "Nothing needs you right now", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).count(), 0);
      await page.close();
    },
  );
  await check(
    "an open email editor survives urgent Decisions changing the Home preview",
    async () => {
      const existing = [
        decision({
          id: "first",
          title: "First customer question",
          urgency: "normal",
          createdAt: "2026-09-09T06:00:00.000Z",
        }),
        decision({
          id: "second",
          title: "Second customer question",
          urgency: "normal",
          createdAt: "2026-09-09T07:00:00.000Z",
        }),
      ];
      const urgent = decision({ id: "urgent", title: "A new urgent question" });
      const fixture = await open({
        quiet: true,
        live: true,
        role: "admin",
        decisions: existing,
        decisionApprovals: [review("mail_send")],
      });
      const { page } = fixture;
      const originalOrder = [
        "First customer question",
        "Second customer question",
        "Review the customer reply",
      ];
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        originalOrder,
      );
      const editor = await editMailReply(
        page,
        "mail-review",
        "My unsaved reply must survive the urgent arrival.",
      );

      fixture.setDecisions([urgent, ...existing]);
      fixture.emitResourceEvent("decision");
      await activeDecisions(page)
        .getByRole("link", { name: "View all decisions · 1 more waiting", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).getByText("4 waiting", { exact: true }).count(), 1);
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        originalOrder,
      );
      assert.equal(await decisionRows(page).count(), 3);
      await retainsMailEditor(editor, true);
      await page.screenshot({
        path: path.join(output, "home-active-email-editor.png"),
        fullPage: true,
      });

      await editor.row.getByRole("button", { name: "Cancel", exact: true }).click();
      await activeDecisions(page)
        .getByRole("heading", { name: urgent.title, exact: true })
        .waitFor();
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        [urgent.title, ...existing.map((item) => item.title)],
      );
      assert.equal(
        await editor.row.count(),
        0,
        "closing the editor restores the normal three-item cutoff",
      );
      assert.deepEqual(
        fixture.mutations,
        [],
        "unsaved edits and cancellation must not write the email",
      );
      await page.close();
    },
  );
  await check(
    "multiple open email editors keep the Home preview stable until the last closes",
    async () => {
      const existing = decision({
        id: "existing",
        title: "Existing customer question",
        urgency: "normal",
        createdAt: "2026-09-09T06:00:00.000Z",
      });
      const firstMail = {
        ...review("mail_send"),
        id: "first-mail",
        title: "Review the first email",
        requestedAt: "2026-09-09T07:00:00.000Z",
      };
      const secondMail = {
        ...review("mail_send"),
        id: "second-mail",
        title: "Review the second email",
      };
      const urgent = [
        decision({
          id: "urgent-one",
          title: "First urgent arrival",
          createdAt: "2026-09-09T08:50:00.000Z",
        }),
        decision({
          id: "urgent-two",
          title: "Second urgent arrival",
          createdAt: "2026-09-09T08:55:00.000Z",
        }),
      ];
      const fixture = await open({
        quiet: true,
        live: true,
        role: "admin",
        decisions: [existing],
        decisionApprovals: [firstMail, secondMail],
      });
      const { page } = fixture;
      const firstEditor = await editMailReply(page, firstMail.id, "Unsaved first reply.");
      const secondEditor = await editMailReply(page, secondMail.id, "Unsaved second reply.");
      const originalOrder = [existing.title, firstMail.title, secondMail.title];

      fixture.setDecisions([...urgent, existing]);
      fixture.emitResourceEvent("decision");
      await activeDecisions(page)
        .getByRole("link", { name: "View all decisions · 2 more waiting", exact: true })
        .waitFor();
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        originalOrder,
      );
      assert.equal(
        await activeDecisions(page).getByRole("form", { name: "Edit email", exact: true }).count(),
        2,
      );
      await retainsMailEditor(firstEditor);
      await retainsMailEditor(secondEditor, true);

      await firstEditor.row.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        originalOrder,
      );
      await retainsMailEditor(secondEditor);
      // Cancel restores focus on the next frame. Let that finish before
      // moving to the other editor so its callback cannot race this check.
      await page.waitForFunction(
        (button) => button === document.activeElement,
        await firstEditor.row
          .getByRole("button", { name: "Edit email", exact: true })
          .elementHandle(),
      );
      await secondEditor.textarea.focus();
      const oldestUrgent = decision({
        id: "oldest-urgent",
        title: "An older urgent question",
        createdAt: "2026-09-09T08:40:00.000Z",
      });
      fixture.setDecisions([oldestUrgent, ...urgent, existing]);
      fixture.emitResourceEvent("decision");
      await activeDecisions(page)
        .getByRole("link", { name: "View all decisions · 3 more waiting", exact: true })
        .waitFor();
      assert.equal(await activeDecisions(page).getByText("6 waiting", { exact: true }).count(), 1);
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        originalOrder,
      );
      assert.equal(await decisionRows(page).count(), 3);
      await retainsMailEditor(secondEditor, true);

      await secondEditor.row.getByRole("button", { name: "Cancel", exact: true }).click();
      await activeDecisions(page)
        .getByRole("heading", { name: oldestUrgent.title, exact: true })
        .waitFor();
      assert.deepEqual(
        await decisionRows(page).getByRole("heading", { level: 3 }).allTextContents(),
        [oldestUrgent.title, ...urgent.map((item) => item.title)],
      );
      assert.equal(
        await activeDecisions(page).getByRole("form", { name: "Edit email", exact: true }).count(),
        0,
      );
      assert.deepEqual(fixture.mutations, []);
      await page.close();
    },
  );
  await check("an unpaired final card fills its row without leaving a middle gap", async () => {
    const { page } = await open({
      width: 1440,
      notifications: [notification("review-one", "The customer reply is waiting for review")],
    });
    const header = await box(greeting(page));
    const attention = await box(card(page, "Needs your attention"));
    const todo = await box(card(page, "Your todos"));
    const messages = await box(card(page, "Unread messages"));

    assert.equal(attention.y, todo.y, "the first pair must stay together on the first row");
    assert.ok(todo.x > attention.x, "the first pair must retain two columns");
    assert.ok(messages.y >= attention.y + attention.height, "the final card must use the next row");
    assert.ok(
      Math.abs(messages.x - header.x) < 1,
      "the unpaired card must align with the content's left edge",
    );
    assert.ok(
      Math.abs(messages.width - header.width) < 1,
      "the unpaired card must span the full content width",
    );
    await fits(page);
    await page.screenshot({
      path: path.join(output, "home-unpaired-card-full-width.png"),
      fullPage: true,
    });
    await page.close();
  });
  await check(
    "marking every notification read clears the attention card without navigating",
    async () => {
      const fixture = await open({
        quiet: true,
        width: 320,
        notifications: [
          notification("review-one", "The customer reply is waiting for review"),
          notification("review-two", "The renewal plan has waited 24 hours"),
        ],
      });
      const attention = card(fixture.page, "Needs your attention");
      const header = attention.locator(":scope > div").first();
      await header.getByText("2", { exact: true }).waitFor();
      const action = header.getByRole("button", { name: "Mark all as read", exact: true });
      await action.waitFor();
      await header.getByRole("link", { name: "Bell has history", exact: false }).waitFor();
      await fits(fixture.page);
      await fixture.page.screenshot({
        path: path.join(output, "home-notifications-mark-all-mobile.png"),
        fullPage: true,
      });
      await fixture.page.setViewportSize({ width: 1440, height: 1000 });
      const headingBounds = await box(
        header.getByRole("heading", { name: "Needs your attention", exact: true }),
      );
      const actionBounds = await box(action);
      assert.ok(
        Math.abs(
          headingBounds.y + headingBounds.height / 2 - actionBounds.y - actionBounds.height / 2,
        ) < 2,
        "the bulk action shares the card header row on a wide screen",
      );
      await fits(fixture.page);
      await fixture.page.screenshot({
        path: path.join(output, "home-notifications-mark-all-desktop.png"),
        fullPage: true,
      });

      await action.focus();
      const response = fixture.page.waitForResponse(
        (row) =>
          row.request().method() === "POST" &&
          new URL(row.url()).pathname === "/api/companies/company/notifications/mark-all-read" &&
          row.status() === 200,
      );
      await fixture.page.keyboard.press("Space");
      await response;

      const allClear = fixture.page.getByRole("heading", {
        name: "Nothing needs you right now",
        exact: true,
      });
      await allClear.waitFor();
      await fixture.page.waitForFunction(
        () => document.activeElement?.hasAttribute("data-home-all-clear") === true,
      );
      await fixture.page
        .getByRole("status")
        .getByText("All notifications marked as read.")
        .waitFor();
      assert.equal(await attention.count(), 0);
      assert.equal(await statTiles(fixture.page).count(), 0, "zero counters leave no empty tiles");
      assert.deepEqual(fixture.writes, ["POST /api/companies/company/notifications/mark-all-read"]);
      assert.equal(await fixture.page.getByRole("dialog").count(), 0);
      assert.equal(await fixture.page.getByLabel("Opened route").count(), 0);
      await fits(fixture.page);
      await fixture.page.close();
    },
  );
  await check("a failed notification bulk read restores the attention card", async () => {
    const fixture = await open({
      quiet: true,
      holdNotificationMarkAll: true,
      notificationMarkAllError: true,
      notifications: [
        notification("review-one", "The customer reply is waiting for review"),
        notification("review-two", "The renewal plan has waited 24 hours"),
      ],
    });
    try {
      const attention = card(fixture.page, "Needs your attention");
      const request = fixture.page.waitForRequest(
        (row) =>
          row.method() === "POST" &&
          new URL(row.url()).pathname === "/api/companies/company/notifications/mark-all-read",
      );
      await attention.getByRole("button", { name: "Mark all as read", exact: true }).click();
      await request;
      await attention.waitFor({ state: "detached" });
      fixture.releaseNotificationMarkAll();

      const dialog = fixture.page.getByRole("dialog", {
        name: "Couldn’t mark all notifications as read",
        exact: true,
      });
      await dialog.waitFor();
      await dialog
        .getByText("Notifications are unavailable. They have been restored.", { exact: true })
        .waitFor();
      await card(fixture.page, "Needs your attention").getByText("2", { exact: true }).waitFor();
      assert.equal(
        await fixture.page
          .getByText("The customer reply is waiting for review", { exact: true })
          .count(),
        1,
      );
      assert.equal(
        await fixture.page
          .getByText("The renewal plan has waited 24 hours", { exact: true })
          .count(),
        1,
      );
      assert.deepEqual(fixture.writes, ["POST /api/companies/company/notifications/mark-all-read"]);
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    } finally {
      fixture.releaseNotificationMarkAll();
      await fixture.page.close();
    }
  });
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
      await fixture.page.getByRole("heading", { name: "Active decisions", exact: true }).waitFor();
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
  for (const width of [1440, 390, 320]) {
    await check(
      `employee work queue stays above the calendar and shows waiting order at ${width}px`,
      async () => {
        const fixture = await open({
          width,
          dark: width === 320,
          workQueue: {
            employeeId: "employee-1",
            current: queueItem({
              id: "active",
              runId: "active",
              position: null,
              routine: {
                id: "active-routine",
                name: "Morning customer briefing",
                slug: "morning-briefing",
              },
            }),
            pending: [
              queueItem(),
              queueItem({
                id: "queued-2",
                position: 2,
                triggerKind: "retry",
                routine: { id: "routine-2", name: "Refresh customer notes", slug: "refresh-notes" },
                availableAt: "2026-09-09T10:30:00.000Z",
              }),
              queueItem({
                id: "queued-3",
                position: 3,
                triggerKind: "continuation",
                routine: { id: "routine-3", name: "Finish weekly report", slug: "weekly-report" },
                blockedReason: "Waiting for the employee Standdown to be lifted.",
              }),
            ],
            pendingCount: 3,
          },
        });
        try {
          const day = await openDay(fixture.page);
          const queue = day.getByRole("region", { name: "Work queue", exact: true });
          await queue.getByText("3 pending", { exact: true }).waitFor();
          await queue.getByText("Working now", { exact: true }).waitFor();
          assert.equal(
            await queue
              .getByRole("link", { name: "Morning customer briefing", exact: true })
              .getAttribute("href"),
            "/c/company/routines/employee-1/morning-briefing?run=active",
          );
          const pending = queue.getByRole("list", { name: "Pending Routines", exact: true });
          assert.deepEqual(await pending.getByRole("link").allTextContents(), [
            "Review customer requests",
            "Refresh customer notes",
            "Finish weekly report",
          ]);
          assert.deepEqual(
            await pending.locator("[aria-label^='Queue position']").allTextContents(),
            ["1", "2", "3"],
          );
          await pending.getByText(/Waiting until/).waitFor();
          await pending
            .getByText("Waiting for the employee Standdown to be lifted.", { exact: true })
            .waitFor();
          await day.getByLabel("Jamie Mallers's hourly work timeline", { exact: true }).waitFor();
          const queueHeading = await box(
            queue.getByRole("heading", { name: "Work queue", exact: true }),
          );
          const bounds = await box(day);
          assert.ok(
            queueHeading.y > bounds.y && queueHeading.y < bounds.y + bounds.height / 2,
            "opening the calendar never scrolls the queue away",
          );
          assert.equal(
            await day.evaluate((element) => element.scrollWidth > element.clientWidth),
            false,
            "modal has no horizontal overflow",
          );
          await fixture.page.screenshot({
            path: path.join(output, `employee-work-queue-${width}.png`),
            fullPage: true,
          });
          const before = fixture.reads.filter((url) => url.includes("/work-queue")).length;
          await day.getByRole("button", { name: "Previous day", exact: true }).click();
          await day.getByRole("heading", { name: /Tuesday/ }).waitFor();
          assert.equal(
            fixture.reads.filter((url) => url.includes("/work-queue")).length,
            before,
            "changing calendar date does not reload or replace the queue",
          );
          await queue.getByText("3 pending", { exact: true }).waitFor();
          assert.deepEqual(fixture.writes, []);
        } finally {
          await fixture.page.close();
        }
      },
    );
  }
  await check(
    "employee work queue refreshes after a Run finishes while an earlier day stays selected",
    async () => {
      const first = queueItem();
      const second = queueItem({
        id: "queued-2",
        runId: "queued-2",
        position: 2,
        routine: { id: "routine-2", name: "Refresh customer notes", slug: "refresh-notes" },
      });
      const fixture = await open({
        live: true,
        workQueue: { employeeId: "employee-1", current: first, pending: [second], pendingCount: 1 },
      });
      try {
        const day = await openDay(fixture.page);
        const queue = day.getByRole("region", { name: "Work queue", exact: true });
        await queue.getByText("1 pending", { exact: true }).waitFor();
        await day.getByRole("button", { name: "Previous day", exact: true }).click();
        fixture.setQueue({
          employeeId: "employee-1",
          current: { ...second, position: null },
          pending: [],
          pendingCount: 0,
        });
        fixture.emitResourceEvent("run");
        await queue.getByText("0 pending", { exact: true }).waitFor();
        await queue.getByText("No Routines waiting.", { exact: true }).waitFor();
        assert.equal(
          await queue.getByRole("link", { name: "Review customer requests", exact: true }).count(),
          0,
        );
        assert.equal(
          await queue
            .getByRole("link", { name: "Refresh customer notes", exact: true })
            .getAttribute("href"),
          "/c/company/routines/employee-1/refresh-notes?run=queued-2",
        );
        assert.equal(await day.getByLabel("Work day", { exact: true }).inputValue(), "2026-09-08");
      } finally {
        await fixture.page.close();
      }
    },
  );
  await check(
    "employee work queue loading and empty states leave recorded work usable",
    async () => {
      const fixture = await open({ holdQueue: true });
      try {
        const day = await openDay(fixture.page);
        const queue = day.getByRole("region", { name: "Work queue", exact: true });
        await queue.getByRole("status").getByText("Loading work queue…", { exact: true }).waitFor();
        await day.getByLabel("Jamie Mallers's hourly work timeline", { exact: true }).waitFor();
        fixture.releaseQueue();
        await queue.getByText("No Routines waiting.", { exact: true }).waitFor();
        assert.equal(await queue.getByText("Working now", { exact: true }).count(), 0);
      } finally {
        fixture.releaseQueue();
        await fixture.page.close();
      }
    },
  );
  await check(
    "employee work queue expands a long preview without hiding its full pending count",
    async () => {
      const fixture = await open({
        width: 390,
        workQueue: {
          employeeId: "employee-1",
          current: null,
          pending: Array.from({ length: 7 }, (_, index) =>
            queueItem({ id: `queued-${index + 1}`, position: index + 1 }),
          ),
          pendingCount: 120,
        },
      });
      try {
        const day = await openDay(fixture.page);
        const queue = day.getByRole("region", { name: "Work queue", exact: true });
        await queue.getByText("120 pending", { exact: true }).waitFor();
        assert.equal(await queue.getByRole("listitem").count(), 5);
        await queue
          .getByText("Showing the first 5 of 120 pending Routines.", { exact: true })
          .waitFor();
        await queue.getByRole("button", { name: "Show 2 more", exact: true }).click();
        assert.equal(await queue.getByRole("listitem").count(), 7);
        await queue
          .getByText("Showing the first 7 of 120 pending Routines.", { exact: true })
          .waitFor();
        await queue.getByRole("button", { name: "Show fewer", exact: true }).click();
        assert.equal(await queue.getByRole("listitem").count(), 5);
        await day.getByRole("button", { name: "Go to first work", exact: true }).click();
        const firstWork = await box(day.getByText(/Jamie Mallers replied in/));
        const bounds = await box(day);
        assert.ok(
          firstWork.y > bounds.y && firstWork.y < bounds.y + bounds.height,
          "recorded work is reachable beside a long queue",
        );
      } finally {
        await fixture.page.close();
      }
    },
  );
  await check(
    "employee work queue failure is inline and retries independently of the calendar",
    async () => {
      const fixture = await open({ queueError: true, width: 320 });
      try {
        const day = await openDay(fixture.page);
        const queue = day.getByRole("region", { name: "Work queue", exact: true });
        await queue
          .getByRole("alert")
          .getByText("Work queue is temporarily unavailable.", { exact: true })
          .waitFor();
        await day.getByLabel("Jamie Mallers's hourly work timeline", { exact: true }).waitFor();
        fixture.recover();
        await queue.getByRole("button", { name: "Try again", exact: true }).click();
        await queue.getByText("No Routines waiting.", { exact: true }).waitFor();
        assert.equal(await queue.getByRole("alert").count(), 0);
      } finally {
        await fixture.page.close();
      }
    },
  );
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
