/**
 * Real Chrome coverage for the simpler Decision stack: one compact row per
 * item on Home, the Active stack and History — who asks, the question, one
 * plain line, the recommendation and the answers — with everything else
 * behind a single Details disclosure; answering into one status line that
 * follows the work (the report up front, the full log behind its own toggle);
 * Dismiss, Snooze, Discard and Don’t do this taking the row off in one click
 * with focus moving on; Undismiss in History; Discuss in the row; grouped
 * email reviews that keep their own Send now; Members' read-only rows; deep
 * links; keyboard access; dark mode; and phone widths without sideways
 * scrolling. The API is a deterministic fixture that stores what it is sent,
 * the way the server would. Run with `npm run test:decision-stack-rows`.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import type { Approval, Decision, HomeApproval, HomeData } from "../client/lib/api";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const NOW = new Date("2026-10-09T09:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const VIEWER = { id: "viewer", name: "Morgan Lee" };

const ID = {
  contract: "11111111-1111-4111-8111-111111111111",
  legacy: "22222222-2222-4222-8222-222222222222",
  assigned: "33333333-3333-4333-8333-333333333333",
  done: "44444444-4444-4444-8444-444444444444",
  failed: "55555555-5555-4555-8555-555555555555",
  skipped: "66666666-6666-4666-8666-666666666666",
  dismissed: "77777777-7777-4777-8777-777777777777",
  withdrawn: "88888888-8888-4888-8888-888888888888",
  expired: "99999999-9999-4999-8999-999999999999",
  reported: "12121212-1212-4121-8121-121212121212",
  mailA: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  mailB: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  mailC: "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  work: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  sent: "ccccccc1-cccc-4ccc-8ccc-ccccccccccc1",
} as const;

// ───────────────────────────── fixture rows ─────────────────────────────

const LEGACY_REASON =
  "Bidding on UTA RFP UTA27 is a public-sector commercial commitment with a hard deadline (Oct 8 at 15:00 CT, about 36 hours out). Existing instructions do not settle it: I have no verified buyer contact, the deal has no owner, and the bid needs an account.";
const LEGACY_BODY =
  `## Why this needs a human decision\n${LEGACY_REASON}\n\n` +
  "What happened: UTA has an open RFP, reference UTA27, for an Incident Management and Alerting Platform.\n\n" +
  "What I checked: the deal record (no owner, no verified contact) and the last 24h of mail.\n\n" +
  "Recommended next step: name an owner and complete the BidNet registration today.";
const NARRATION = [
  "I found the deal and loaded BidNet Direct. Now I'll dismiss the cookie banner and search for UTA27.",
  "Found the solicitation on BidNet Direct. Opening the detail page.",
  "Password filled from Vault. Now checking the T&C box and submitting the registration.",
  "Registered OneUptime on BidNet Direct and saved the UTA27 solicitation to the deal. Jamie owns it now.",
].join("\n\n");

function decision(changes: Partial<Decision> = {}): Decision {
  return {
    id: ID.contract,
    companyId: "company",
    title: "Sign Acme's three-year renewal at 10% off?",
    body:
      "## Why this needs a human decision\nA three-year term at a discount is a commitment beyond my authority.\n\n" +
      "What happened: Acme asked for three years at 10% off on their renewal call.\n\n" +
      "What I checked: their usage doubled this year and they have paid on time for two years.",
    summary:
      "Acme will renew for three years if we take 10% off. That locks in $86k a year but cuts this year by $9.6k.",
    recommendation: "Sign it: three years of revenue is worth more than this year's discount.",
    options: [
      {
        id: "sign",
        label: "Sign at 10% off",
        detail: "I send the signed terms today.",
        tone: "primary",
      },
      {
        id: "counter",
        label: "Counter at 5%",
        detail: "I propose 5% for three years.",
        tone: "neutral",
      },
      { id: "decline", label: "Decline the deal", detail: null, tone: "danger" },
    ],
    status: "pending",
    urgency: "normal",
    routineId: "routine-1",
    runId: "run-1",
    conversationId: null,
    mailThreadId: null,
    source: {
      kind: "routine",
      routine: {
        id: "routine-1",
        name: "Daily CRM Sync & Sales Update",
        slug: "daily-crm-sync",
        employeeSlug: "alex",
      },
      run: { id: "run-1", status: "completed", startedAt: hoursAgo(5), triggerKind: "schedule" },
      conversation: null,
      mailThread: null,
    },
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
    pickupReport: null,
    pickupStartedAt: null,
    pickupFinishedAt: null,
    snoozedUntil: null,
    expiresAt: null,
    createdAt: hoursAgo(5),
    employee: { id: "alex", name: "Alex Rivera", slug: "alex", avatarKey: null },
    assignee: null,
    ...changes,
  };
}

/** A row from before Decisions carried a summary: everything is in the body. */
function legacyDecision(changes: Partial<Decision> = {}): Decision {
  return decision({
    id: ID.legacy,
    title: "Decide UTA RFP UTA27 response by Oct 8 15:00 CT",
    body: LEGACY_BODY,
    summary: null,
    recommendation: null,
    urgency: "high",
    createdAt: hoursAgo(9),
    options: [
      {
        id: "pursue",
        label: "Pursue: register and bid",
        detail: "I register on BidNet and prepare the bid for an owner to sign.",
        tone: "primary",
      },
      {
        id: "decline",
        label: "Decline this RFP",
        detail: "I close the deal as not pursued.",
        tone: "neutral",
      },
    ],
    employee: { id: "jamie", name: "Jamie Mallers", slug: "jamie", avatarKey: null },
    ...changes,
  });
}

function settled(changes: Partial<Decision>): Decision {
  return legacyDecision({
    status: "decided",
    chosenOptionId: "pursue",
    chosenOptionLabel: "Pursue: register and bid",
    decidedAt: hoursAgo(8),
    decidedByUserId: "nawaz",
    decidedBy: { id: "nawaz", name: "Nawaz Dhandala" },
    ...changes,
  });
}

function historyRows(): Decision[] {
  return [
    settled({
      id: ID.done,
      title: "Register for the UTA27 bid",
      pickupStatus: "done",
      pickupSummary: NARRATION,
      pickupReport: null,
      pickupStartedAt: hoursAgo(7.9),
      pickupFinishedAt: hoursAgo(6.8),
      decidedAt: hoursAgo(8),
    }),
    settled({
      id: ID.reported,
      title: "Choose the Q4 webinar date",
      pickupStatus: "done",
      pickupSummary: `${NARRATION}\n\nBooked the webinar for Nov 12 and invited the 40 contacts on the list.`,
      pickupReport: "Booked the webinar for Nov 12 and invited the 40 contacts on the list.",
      decidedAt: hoursAgo(7),
    }),
    settled({
      id: ID.failed,
      title: "Renew the Initech support plan",
      pickupStatus: "failed",
      pickupSummary: "The billing portal rejected the card on file. Nothing was renewed.",
      decidedAt: hoursAgo(6),
    }),
    settled({
      id: ID.skipped,
      title: "Approve the Globex logo use",
      pickupStatus: "skipped",
      pickupSummary:
        "Jamie Mallers has no AI Model connected, so nothing could start now. Your answer is on their journal.",
      decidedAt: hoursAgo(5),
    }),
    legacyDecision({
      id: ID.dismissed,
      title: "Archive the old pricing deck?",
      status: "cancelled",
      decidedAt: hoursAgo(4),
      decidedByUserId: VIEWER.id,
      decidedBy: VIEWER,
      note: null,
    }),
    legacyDecision({
      id: ID.withdrawn,
      title: "Book the trade show booth?",
      status: "cancelled",
      decidedAt: hoursAgo(3),
      decidedByUserId: null,
      decidedBy: null,
      note: "The organizer cancelled the show.",
    }),
    legacyDecision({
      id: ID.expired,
      title: "Pick the summer intern",
      status: "expired",
      decidedAt: hoursAgo(2),
    }),
  ];
}

function mailReview(id: string, n: number, changes: Partial<Approval> = {}): Approval {
  const to =
    ["priya@acme.example", "ops@globex.example", "sales@initech.example"][n] ?? "x@y.example";
  return {
    id,
    companyId: "company",
    kind: "mail_send",
    routineId: "routine-mail",
    employeeId: "riley",
    title:
      [
        "Reply to Priya about the checkout error",
        "Send the launch update to Globex",
        "Answer Initech's pricing question",
      ][n] ?? "Email",
    summary: null,
    errorMessage: null,
    status: "pending",
    requestedAt: hoursAgo(3 - n),
    decidedAt: null,
    decidedByUserId: null,
    review: {
      kind: "mail",
      revision: `${n}`.repeat(64),
      context: "Priya reported that checkout fails after applying an annual-plan discount code.",
      workSummary: "I reproduced the issue and prepared a fix in the Repository.",
      steps: [{ title: "Reproduced the report", detail: "Confirmed on annual plans." }],
      attachments: [],
      source: {
        accountId: "mail-account",
        threadId: `thread-${n}`,
        mailHandoverId: null,
        routineId: null,
        runId: null,
        conversationId: null,
      },
      draft: {
        to,
        cc: "",
        bcc: "",
        subject:
          [
            "Re: Checkout error with annual-plan discount",
            "Our launch is next week",
            "Re: Pricing for 50 seats",
          ][n] ?? "Hello",
        bodyText: `Hi there,\n\nThanks for writing in (${n}). We found the issue and prepared a fix.\n\nBest,\nMorgan`,
      },
    },
    routine: null,
    employee: { id: "riley", name: "Riley Chen", slug: "riley" },
    ...changes,
  };
}

function workReview(changes: Partial<Approval> = {}): Approval {
  return {
    id: ID.work,
    companyId: "company",
    kind: "proactive_work",
    routineId: "routine-1",
    employeeId: "alex",
    title: "Fix the checkout error reported by Acme",
    summary: null,
    errorMessage: null,
    status: "pending",
    requestedAt: hoursAgo(1),
    decidedAt: null,
    decidedByUserId: null,
    review: {
      kind: "work",
      revision: "w".repeat(64),
      context:
        "## Why this needs a human decision\nThe checkout change affects customer payments and needs a production decision.\n\nWhat happened: Acme reported a checkout error in their email.",
      plan: "Investigate the checkout failure, prepare a fix in the Repository and run the existing Checks. Nothing will be published or sent to the customer.",
      source: {
        routineId: "routine-1",
        runId: "run-9",
        conversationId: null,
        mailThreadId: null,
        mailAccountId: null,
        mailHandoverId: null,
      },
    },
    routine: { id: "routine-1", name: "Review customer reports", slug: "review-customer-reports" },
    employee: { id: "alex", name: "Alex Rivera", slug: "alex" },
    ...changes,
  };
}

// ───────────────────────────── the API fixture ─────────────────────────────

type Write = { method: string; path: string; body: Record<string, unknown> };
type Fixture = {
  page: Page;
  rows: Decision[];
  reviews: Approval[];
  writes: Write[];
  /** Change a row the way a pickup session would, between polls. */
  update: (id: string, changes: Partial<Decision>) => void;
};
type Options = {
  role?: "owner" | "admin" | "member";
  path?: string;
  rows?: Decision[];
  reviews?: Approval[];
  width?: number;
  scheme?: "light" | "dark";
  stackEnabled?: boolean;
  /** Fail the next write whose path ends like this, inline. */
  failWrite?: { suffix: string; status: number; error: string };
  /** The pickup state a fresh answer starts in. */
  pickupOnDecide?: Decision["pickupStatus"];
  /** Rows the Member follows already (from an earlier visit). */
  following?: Array<{ kind: "decision" | "review"; id: string }>;
};

const browserErrors: string[] = [];
const unexpected: string[] = [];
const fixture = await startBrowserFixture("decisionStackRowsHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });

const SNOOZE_MS: Record<string, number> = {
  one_hour: 3_600_000,
  one_day: 86_400_000,
  two_days: 2 * 86_400_000,
  one_week: 7 * 86_400_000,
  one_month: 30 * 86_400_000,
};

function homeData(rows: Decision[], reviews: Approval[], canReview: boolean): HomeData {
  const pending = rows
    .filter(
      (row) =>
        row.status === "pending" &&
        (!row.snoozedUntil || Date.parse(row.snoozedUntil) <= NOW.getTime()),
    )
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.urgency] - { high: 0, normal: 1, low: 2 }[b.urgency] ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  const pendingReviews: HomeApproval[] = canReview
    ? reviews.filter((row) => row.status === "pending")
    : [];
  return {
    decisions: pending.slice(0, 5),
    pendingDecisionCount: pending.length,
    decisionApprovals: pendingReviews,
    pendingDecisionApprovalCount: pendingReviews.length,
    repositoryWork: [],
    repositoryWorkCount: 0,
    draftEmails: [],
    draftEmailCount: 0,
    draftEmailAccounts: [],
    starredEmailCount: 0,
    starredEmailAccounts: [],
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
    systemHealth: { status: "ok", issueCount: 0, checks: [] },
    counts: { employees: 2, projects: 1 },
  };
}

async function open(options: Options = {}): Promise<Fixture> {
  const role = options.role ?? "admin";
  const canReview = role !== "member";
  const rows = options.rows ?? [decision(), legacyDecision()];
  const reviews = options.reviews ?? [];
  const writes: Write[] = [];
  let failWrite = options.failWrite ?? null;
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 900 },
    colorScheme: options.scheme ?? "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("close", () => void context.close());
  await page.clock.setFixedTime(NOW);
  const following = options.following ?? [];
  await page.addInitScript(
    ({ following }) => {
      localStorage.setItem("genosyn.pushPromptDismissed", "1");
      if (!sessionStorage.getItem("rows-fixture")) {
        sessionStorage.setItem("rows-fixture", "1");
        localStorage.setItem(
          "genosyn.decisionFollowUps.v1:company:viewer",
          JSON.stringify(following),
        );
      }
    },
    { following },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const base = "/api/companies/company";
    if (method !== "GET") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      writes.push({ method, path: pathname, body });
      if (failWrite && pathname.endsWith(failWrite.suffix)) {
        const { status, error } = failWrite;
        failWrite = null;
        return route.fulfill({ status, json: { error } });
      }
      const act = pathname.match(/^\/api\/companies\/company\/decisions\/([^/]+)\/(\w+)$/);
      if (act && method === "POST") {
        const row = rows.find((entry) => entry.id === act[1]);
        if (!row) return route.fulfill({ status: 404, json: { error: "Not found" } });
        const now = new Date(NOW).toISOString();
        if (act[2] === "decide") {
          const option = row.options.find((entry) => entry.id === body.optionId);
          Object.assign(row, {
            status: "decided",
            chosenOptionId: body.optionId,
            chosenOptionLabel: option?.label ?? null,
            note: (body.note as string | undefined) ?? null,
            decidedAt: now,
            decidedByUserId: VIEWER.id,
            decidedBy: VIEWER,
            pickupStatus: options.pickupOnDecide ?? "running",
            pickupStartedAt: now,
          });
        } else if (act[2] === "dismiss") {
          Object.assign(row, {
            status: "cancelled",
            decidedAt: now,
            decidedByUserId: VIEWER.id,
            decidedBy: VIEWER,
          });
        } else if (act[2] === "snooze") {
          row.snoozedUntil = new Date(
            NOW.getTime() + SNOOZE_MS[String(body.duration)],
          ).toISOString();
        } else if (act[2] === "restore") {
          Object.assign(row, {
            status: "pending",
            decidedAt: null,
            decidedByUserId: null,
            decidedBy: null,
            note: null,
          });
        } else if (act[2] === "discussion") {
          return route.fulfill({
            json: {
              conversation: {
                id: `discussion-${row.id}`,
                employeeId: row.employee?.id ?? "alex",
                title: `Discuss: ${row.title}`,
                archivedAt: null,
                createdAt: now,
                updatedAt: now,
                lastMessageAt: null,
                lastModelId: null,
                discussedDecisionId: row.id,
              },
              messages: [],
            },
          });
        }
        return route.fulfill({ json: row });
      }
      const review = pathname.match(
        /^\/api\/companies\/company\/approvals\/([^/]+)\/(approve|reject)$/,
      );
      if (review && method === "POST") {
        const row = reviews.find((entry) => entry.id === review[1]);
        if (!row) return route.fulfill({ status: 404, json: { error: "Not found" } });
        assert.equal(
          body.reviewRevision,
          row.review?.revision,
          "each review sends its own revision",
        );
        const now = NOW.toISOString();
        if (review[2] === "reject") Object.assign(row, { status: "rejected", decidedAt: now });
        else if (row.kind === "mail_send")
          Object.assign(row, {
            status: "approved",
            decidedAt: now,
            mailDeliveryStatus: "sent",
            mailOutcome: { sentMessageId: "m1", providerMessageRef: "p1", sentAt: now },
          });
        else Object.assign(row, { status: "executing", decidedAt: now });
        return route.fulfill({ json: row });
      }
      unexpected.push(`${method} ${pathname}`);
      return route.fulfill({ status: 500, json: { error: `Unhandled ${method} ${pathname}` } });
    }
    if (pathname === `${base}/decision-stack/settings`) {
      return route.fulfill({
        json: {
          enabled: options.stackEnabled ?? true,
          instructions: "",
          usingDefaultInstructions: true,
          pendingDecisions: rows.filter((row) => row.status === "pending").length,
          canManage: role !== "member",
        },
      });
    }
    if (pathname === `${base}/decisions`) {
      const status = url.searchParams.get("status");
      const listed = rows.filter((row) =>
        status === "pending"
          ? row.status === "pending" &&
            (!row.snoozedUntil || Date.parse(row.snoozedUntil) <= NOW.getTime())
          : !status || row.status === status,
      );
      return route.fulfill({ json: listed });
    }
    const discussion = pathname.match(
      /^\/api\/companies\/company\/decisions\/([^/]+)\/discussion$/,
    );
    if (discussion) return route.fulfill({ json: { conversation: null, messages: [] } });
    const one = pathname.match(/^\/api\/companies\/company\/decisions\/([^/]+)$/);
    if (one) {
      const row = rows.find((entry) => entry.id === one[1]);
      return row
        ? route.fulfill({ json: row })
        : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (pathname === `${base}/approvals`) {
      if (!canReview) {
        unexpected.push(`member read ${pathname}`);
        return route.fulfill({ status: 403, json: { error: "admin company role required" } });
      }
      return route.fulfill({ json: reviews });
    }
    const approval = pathname.match(/^\/api\/companies\/company\/approvals\/([^/]+)$/);
    if (approval) {
      const row = reviews.find((entry) => entry.id === approval[1]);
      return row
        ? route.fulfill({ json: row })
        : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (pathname === `${base}/home`)
      return route.fulfill({ json: homeData(rows, reviews, canReview) });
    if (pathname === `${base}/employees` || pathname === `${base}/members`) {
      return route.fulfill({ json: [] });
    }
    if (pathname === `${base}/onboarding-status`) {
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
    }
    if (pathname === `${base}/work-timeline`) {
      return route.fulfill({
        json: {
          since: NOW.toISOString(),
          until: NOW.toISOString(),
          employeeId: null,
          entries: [],
          entryCount: 0,
          employeeSummaries: [],
        },
      });
    }
    unexpected.push(`GET ${pathname}`);
    return route.fulfill({ status: 404, json: { error: `Unhandled GET ${pathname}` } });
  });
  const start = options.path ?? "/c/acme/decisions";
  await page.goto(`${fixture.origin}/?role=${role}&path=${encodeURIComponent(start)}`);
  return {
    page,
    rows,
    reviews,
    writes,
    update: (id, changes) => {
      const row = rows.find((entry) => entry.id === id);
      assert.ok(row, `no fixture row ${id}`);
      Object.assign(row, changes);
    },
  };
}

// ───────────────────────────── helpers ─────────────────────────────

const row = (page: Page, id: string) => page.locator(`[id="decision-${id}"]`);
const reviewRow = (page: Page, id: string) => page.locator(`[id="review-${id}"]`);
const statusLine = (locator: Locator) => locator.locator("[data-status-line]");
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });

async function stackReady(page: Page) {
  await page.getByRole("heading", { name: "Decision stack", exact: true }).waitFor();
}

const FOLLOW_KEY = "genosyn.decisionFollowUps.v1:company:viewer";

/** What this browser remembers following, exactly as stored. */
async function followed(page: Page): Promise<unknown> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), FOLLOW_KEY);
}

/** Wait until the row is remembered as seen finished. */
async function seenStored(page: Page, key: string) {
  await page.waitForFunction(
    ({ storage, key }) =>
      (JSON.parse(localStorage.getItem(storage) ?? "[]") as Array<Record<string, unknown>>).some(
        (ref) => `${ref.kind}-${ref.id}` === key && ref.seen === true,
      ),
    { storage: FOLLOW_KEY, key },
  );
}

/** Pretend the tab went to the background, or came back, the way the browser reports it. */
async function setTabVisible(page: Page, visible: boolean) {
  // A string, not a function: the test runner's name helpers would not exist in the page.
  await page.evaluate(`(() => {
    const state = ${JSON.stringify(visible ? "visible" : "hidden")};
    Object.defineProperty(document, "visibilityState", { configurable: true, get() { return state; } });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
}

/** An answer this Member gave earlier, as the server returns it later. */
function answered(changes: Partial<Decision> = {}): Decision {
  return decision({
    status: "decided",
    chosenOptionId: "sign",
    chosenOptionLabel: "Sign at 10% off",
    decidedAt: hoursAgo(1),
    decidedByUserId: VIEWER.id,
    decidedBy: VIEWER,
    pickupStatus: "running",
    pickupStartedAt: hoursAgo(1),
    ...changes,
  });
}

/** The row has left the page — not merely re-rendered. */
async function gone(locator: Locator) {
  await locator.waitFor({ state: "detached" });
}

/** Shown to the eye: rendered at size and not one of the screen-reader-only spans. */
async function shown(locator: Locator): Promise<boolean> {
  return locator.evaluateAll((elements) =>
    elements.some((element) => {
      if (element.closest(".sr-only")) return false;
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1;
    }),
  );
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px`);
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(output, `decision-stack-rows-${name}.png`),
    fullPage: true,
  });
}

let passed = 0;
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

await fs.mkdir(output, { recursive: true });

try {
  console.log("Decision stack rows");

  await check(
    "a waiting Decision is one compact row: who asks, the question, one plain line, the recommendation and the answers",
    async () => {
      const { page } = await open({ rows: [decision()] });
      await stackReady(page);
      const card = row(page, ID.contract);
      await card.waitFor();
      await card.getByText("Alex Rivera", { exact: true }).waitFor();
      await card
        .getByRole("heading", { name: "Sign Acme's three-year renewal at 10% off?", exact: true })
        .waitFor();
      assert.equal(
        await card.locator("[data-decision-summary]").innerText(),
        "Acme will renew for three years if we take 10% off. That locks in $86k a year but cuts this year by $9.6k.",
      );
      assert.equal(
        await card.locator("[data-decision-recommendation]").innerText(),
        "Recommends: Sign it: three years of revenue is worth more than this year's discount.",
      );
      const answers = card.getByRole("radiogroup", { name: "Choose one answer" });
      assert.equal(await answers.getByRole("radio").count(), 3);
      await answers
        .getByRole("radio", { name: /^Sign at 10% off \(recommended\)/ })
        .waitFor({ state: "attached" });
      await answers
        .getByRole("radio", { name: /^Decline the deal \(destructive\)/ })
        .waitFor({ state: "attached" });
      // Everything else is behind Details, which starts closed.
      const details = button(card, "Details");
      assert.equal(await details.getAttribute("aria-expanded"), "false");
      for (const hidden of [
        "Why it needs you",
        "A three-year term at a discount is a commitment beyond my authority.",
        "Daily CRM Sync & Sales Update",
        "I send the signed terms today.",
      ]) {
        assert.equal(await shown(card.getByText(hidden, { exact: true })), false, hidden);
      }
      // No confirm until an answer is picked; nothing recorded by looking.
      assert.equal(await card.getByRole("button", { name: /^Confirm:/ }).count(), 0);
      const height = (await card.boundingBox())?.height ?? 0;
      assert.ok(height < 260, `the row is ${height}px tall`);
      for (const noise of [
        "Close removes this card",
        "What happened next",
        "What do you need to decide?",
        "Why this needs a human decision",
        "Nothing is recorded until you confirm",
      ]) {
        assert.equal(await page.getByText(noise).count(), 0, `"${noise}" is gone`);
      }
      await shot(page, "compact-desktop");
      await page.close();
    },
  );

  await check(
    "an older Decision reads its line from the first sentence of its reason and recommends its marked option",
    async () => {
      const { page } = await open({ rows: [legacyDecision()] });
      const card = row(page, ID.legacy);
      await card.waitFor();
      assert.equal(
        await card.locator("[data-decision-summary]").innerText(),
        "Bidding on UTA RFP UTA27 is a public-sector commercial commitment with a hard deadline (Oct 8 at 15:00 CT, about 36 hours out).",
      );
      assert.equal(
        await card.locator("[data-decision-recommendation]").innerText(),
        "Recommends: Pursue: register and bid",
      );
      await card.getByText("Urgent", { exact: true }).waitFor();
      // The rest of the reason and the body stay out of the row.
      assert.equal(await shown(card.getByText(/no verified buyer contact/)), false);
      assert.equal(await card.getByText(/^What I checked/).count(), 0);
      await page.close();
    },
  );

  await check(
    "Details opens everything once — why, background, choices and source — and closes",
    async () => {
      const { page, writes } = await open({ rows: [legacyDecision()] });
      const card = row(page, ID.legacy);
      await card.waitFor();
      const details = button(card, "Details");
      const controls = await details.getAttribute("aria-controls");
      assert.ok(controls);
      await details.click();
      const toggle = button(card, "Hide details");
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      const panel = page.locator(`[id="${controls}"]`);
      await panel.waitFor();
      await panel.getByRole("heading", { name: "Why it needs you", exact: true }).waitFor();
      await panel.getByText(/no verified buyer contact, the deal has no owner/).waitFor();
      await panel.getByRole("heading", { name: "Background", exact: true }).waitFor();
      await panel.getByRole("heading", { name: "What I checked", exact: true }).waitFor();
      await panel.getByRole("heading", { name: "The choices", exact: true }).waitFor();
      await panel
        .getByText("I register on BidNet and prepare the bid for an owner to sign.")
        .waitFor();
      await panel.getByRole("heading", { name: "Asked from", exact: true }).waitFor();
      const routine = panel.getByRole("link", { name: "Daily CRM Sync & Sales Update" });
      assert.equal(await routine.getAttribute("href"), "/c/acme/routines/alex/daily-crm-sync");
      assert.equal(
        await panel.getByRole("link", { name: "the run" }).getAttribute("href"),
        "/c/acme/routines/alex/daily-crm-sync?run=run-1",
      );
      await shot(page, "details-open");
      await toggle.click();
      await panel.waitFor({ state: "detached" });
      assert.equal(await button(card, "Details").getAttribute("aria-expanded"), "false");
      assert.deepEqual(writes, [], "reading details writes nothing");
      await page.close();
    },
  );

  await check(
    "answering is pick then confirm, with guidance, and collapses to one status line that follows the work",
    async () => {
      const fx = await open({ rows: [decision(), legacyDecision()] });
      const { page } = fx;
      const card = row(page, ID.contract);
      await card.waitFor();
      await card.getByText("Counter at 5%", { exact: true }).click();
      assert.equal(await card.getByRole("radio", { name: /^Counter at 5%/ }).isChecked(), true);
      // The picked answer explains itself before it is confirmed.
      await card.locator("p").filter({ hasText: "I propose 5% for three years." }).waitFor();
      assert.deepEqual(fx.writes, [], "picking an answer records nothing");
      await button(card, "Add guidance").click();
      await card
        .getByRole("textbox", { name: "Guidance for Alex Rivera (optional)" })
        .fill("Offer 5% only if they sign this week.");
      await button(card, "Confirm: Counter at 5%").click();
      const settledLine = statusLine(card);
      await settledLine.getByText("You chose “Counter at 5%”", { exact: true }).waitFor();
      assert.match(
        await settledLine.innerText(),
        /You chose “Counter at 5%” · Alex Rivera is on it/,
      );
      assert.deepEqual(fx.writes, [
        {
          method: "POST",
          path: `/api/companies/company/decisions/${ID.contract}/decide`,
          body: { optionId: "counter", note: "Offer 5% only if they sign this week." },
        },
      ]);
      // The answered row is now short: no answers, no Confirm, a Close.
      assert.equal(await card.getByRole("radio").count(), 0);
      await button(card, "Close decision").waitFor();
      // The session finishes: the report leads, the narration waits behind a toggle.
      fx.update(ID.contract, {
        pickupStatus: "done",
        pickupSummary: `${NARRATION}\n\nSent Acme the 5% counter-offer and set a follow-up for Friday.`,
        pickupReport: "Sent Acme the 5% counter-offer and set a follow-up for Friday.",
        pickupFinishedAt: NOW.toISOString(),
      });
      await settledLine
        .getByText("Sent Acme the 5% counter-offer and set a follow-up for Friday.")
        .waitFor({ timeout: 15_000 });
      assert.match(await settledLine.innerText(), /^Done · Sent Acme the 5% counter-offer/);
      assert.equal(await card.getByText(/cookie banner/).count(), 0, "no narration on the row");
      await button(card, "Details").click();
      await card.getByRole("heading", { name: "Answer", exact: true }).waitFor();
      await card.getByText("Guidance:", { exact: true }).waitFor();
      await card.getByRole("heading", { name: "What happened next", exact: true }).waitFor();
      await card
        .locator("[data-pickup-report]")
        .getByText(/5% counter-offer/)
        .waitFor();
      assert.equal(await shown(card.getByText(/cookie banner/)), false);
      await button(card, "Show the full log").click();
      await card.getByText(/dismiss the cookie banner/).waitFor();
      await shot(page, "answered-done");
      // Close takes it off; the next waiting question stays.
      await button(card, "Close decision").click();
      await gone(card);
      await row(page, ID.legacy).waitFor();
      await page.close();
    },
  );

  await check(
    "a finished answer needs no Close: two clicks to answer, it stays while read, and the next visit leaves it to History",
    async () => {
      const fx = await open({ rows: [decision(), legacyDecision()] });
      const { page } = fx;
      let clicks = 0;
      const card = row(page, ID.contract);
      await card.waitFor();
      await card.getByText("Sign at 10% off", { exact: true }).click();
      clicks += 1;
      await button(card, "Confirm: Sign at 10% off").click();
      clicks += 1;
      await statusLine(card)
        .getByText(/Alex Rivera is on it$/)
        .waitFor();
      // Followed while the work runs; nothing is marked seen yet.
      assert.deepEqual(await followed(page), [{ kind: "decision", id: ID.contract }]);
      fx.update(ID.contract, {
        pickupStatus: "done",
        pickupSummary: "Signed the renewal and sent Acme the countersigned copy.",
        pickupReport: "Signed the renewal and sent Acme the countersigned copy.",
        pickupFinishedAt: NOW.toISOString(),
      });
      await statusLine(card).getByText("Done", { exact: true }).waitFor({ timeout: 15_000 });
      await seenStored(page, `decision-${ID.contract}`);
      // Nothing disappears under the reader: the line stays for this visit,
      // with Close still there for anyone who wants it gone now.
      await page.waitForTimeout(500);
      assert.equal(await card.isVisible(), true);
      await button(card, "Close decision").waitFor();
      assert.deepEqual(await followed(page), [{ kind: "decision", id: ID.contract, seen: true }]);
      // The next visit leaves it behind without a Close.
      await page.reload();
      await stackReady(page);
      await row(page, ID.legacy).waitFor();
      assert.equal(await row(page, ID.contract).count(), 0);
      assert.deepEqual(await followed(page), [], "the follow list forgets it");
      assert.equal(clicks, 2, "answering took two clicks and nothing else");
      await page.getByRole("link", { name: "Decision history", exact: true }).click();
      await page.getByRole("heading", { name: "Decision history", exact: true }).waitFor();
      assert.match(
        await statusLine(row(page, ID.contract)).innerText(),
        /^Done · Signed the renewal and sent Acme the countersigned copy\.$/,
      );
      assert.deepEqual(
        fx.writes.map((write) => write.path),
        [`/api/companies/company/decisions/${ID.contract}/decide`],
        "leaving the stack writes nothing",
      );
      await page.close();
    },
  );

  await check(
    "work that finishes in a background tab is only marked seen once the tab is shown",
    async () => {
      const fx = await open({
        rows: [answered(), legacyDecision()],
        following: [{ kind: "decision", id: ID.contract }],
      });
      const { page } = fx;
      const card = row(page, ID.contract);
      await statusLine(card)
        .getByText(/Alex Rivera is on it$/)
        .waitFor();
      await setTabVisible(page, false);
      fx.update(ID.contract, {
        pickupStatus: "done",
        pickupReport: "Signed the renewal.",
        pickupSummary: "Signed the renewal.",
      });
      // A refresh still lands while hidden (the tab regains focus later).
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await statusLine(card).getByText("Done", { exact: true }).waitFor();
      await page.waitForTimeout(400);
      assert.deepEqual(
        await followed(page),
        [{ kind: "decision", id: ID.contract }],
        "nobody has seen it yet",
      );
      await setTabVisible(page, true);
      await seenStored(page, `decision-${ID.contract}`);
      await page.reload();
      await row(page, ID.legacy).waitFor();
      assert.equal(await row(page, ID.contract).count(), 0);
      await page.close();
    },
  );

  await check(
    "a row that finished while you were away shows once on Home, then the stack leaves it behind",
    async () => {
      const fx = await open({
        path: "/c/acme",
        rows: [
          answered({ pickupStatus: "done", pickupReport: "Signed the renewal." }),
          legacyDecision(),
        ],
        following: [{ kind: "decision", id: ID.contract }],
      });
      const { page } = fx;
      const section = page.locator("section", {
        has: page.getByRole("heading", { name: "Active decisions", exact: true }),
      });
      const card = row(page, ID.contract);
      assert.match(await statusLine(card).innerText(), /^Done · Signed the renewal\.$/);
      await section.getByText("1 following", { exact: false }).waitFor();
      await seenStored(page, `decision-${ID.contract}`);
      await section.getByRole("link", { name: /All decisions/ }).click();
      await stackReady(page);
      await row(page, ID.legacy).waitFor();
      assert.equal(await row(page, ID.contract).count(), 0, "seen on Home, gone from the stack");
      assert.equal(
        await page.getByRole("heading", { name: /following/ }).count(),
        0,
        "nothing left to follow",
      );
      await page.close();
    },
  );

  await check(
    "a row that couldn’t finish stays across visits until Close, then stays gone",
    async () => {
      const fx = await open({
        rows: [
          answered({
            pickupStatus: "failed",
            pickupSummary: "The e-signature service rejected the document. Nothing was signed.",
          }),
        ],
        following: [{ kind: "decision", id: ID.contract }],
      });
      const { page } = fx;
      const card = row(page, ID.contract);
      assert.match(
        await statusLine(card).innerText(),
        /^Couldn’t finish · The e-signature service rejected the document\.$/,
      );
      await page.waitForTimeout(400);
      assert.deepEqual(await followed(page), [{ kind: "decision", id: ID.contract }]);
      await page.reload();
      await statusLine(row(page, ID.contract)).getByText("Couldn’t finish").waitFor();
      const close = button(row(page, ID.contract), "Close decision");
      await close.focus();
      await page.keyboard.press("Enter");
      await gone(row(page, ID.contract));
      assert.deepEqual(await followed(page), []);
      await page.reload();
      await page.getByRole("heading", { name: "Decision stack is clear" }).waitFor();
      assert.equal(await row(page, ID.contract).count(), 0);
      await page.close();
    },
  );

  await check(
    "a sent email and approved work that finished leave on the next visit; a send that failed stays",
    async () => {
      const sentAt = hoursAgo(0.5);
      const fx = await open({
        rows: [],
        reviews: [
          mailReview(ID.mailA, 0, {
            status: "approved",
            decidedAt: sentAt,
            mailDeliveryStatus: "sent",
            mailOutcome: { sentMessageId: "m", providerMessageRef: "p", sentAt },
          }),
          mailReview(ID.mailB, 1, {
            status: "execution_failed",
            decidedAt: sentAt,
            mailDeliveryStatus: "not_sent",
            errorMessage: "The mailbox refused the message.",
          }),
          workReview({
            status: "approved",
            decidedAt: sentAt,
            outcomeSummary: "Fixed the discount validation; the Checks passed.",
            outcomeRunId: "run-7",
          }),
        ],
        following: [
          { kind: "review", id: ID.mailA },
          { kind: "review", id: ID.mailB },
          { kind: "review", id: ID.work },
        ],
      });
      const { page } = fx;
      await statusLine(reviewRow(page, ID.mailA)).getByText("Sent", { exact: true }).waitFor();
      await statusLine(reviewRow(page, ID.mailB)).getByText("Not sent", { exact: true }).waitFor();
      await statusLine(reviewRow(page, ID.work)).getByText("Done", { exact: true }).waitFor();
      await seenStored(page, `review-${ID.mailA}`);
      await seenStored(page, `review-${ID.work}`);
      await page.reload();
      await statusLine(reviewRow(page, ID.mailB)).getByText("Not sent", { exact: true }).waitFor();
      assert.equal(await reviewRow(page, ID.mailA).count(), 0);
      assert.equal(await reviewRow(page, ID.work).count(), 0);
      assert.deepEqual(await followed(page), [{ kind: "review", id: ID.mailB }]);
      assert.deepEqual(fx.writes, [], "nothing is sent or approved again");
      await page.close();
    },
  );

  await check(
    "Dismiss takes the row off in one click, moves focus on, and History can Undismiss it",
    async () => {
      const fx = await open({ rows: [legacyDecision(), decision()] });
      const { page } = fx;
      const first = row(page, ID.legacy);
      await first.waitFor();
      await button(first, "Dismiss").click();
      await gone(first);
      assert.deepEqual(
        fx.writes.map((write) => `${write.method} ${write.path}`),
        [`POST /api/companies/company/decisions/${ID.legacy}/dismiss`],
      );
      // No Close step, and focus lands on the next question.
      await page.waitForFunction(
        (id) => document.activeElement?.closest(`[id="decision-${id}"]`) !== null,
        ID.contract,
      );
      assert.equal(await page.getByRole("button", { name: "Close decision" }).count(), 0);
      await page
        .getByRole("status")
        .filter({ hasText: /dismissed\. It is in Decision history\./ })
        .waitFor({ state: "attached" });
      // History has it, with Undismiss.
      await page.getByRole("link", { name: "Decision history", exact: true }).click();
      await page.getByRole("heading", { name: "Decision history", exact: true }).waitFor();
      const dismissed = row(page, ID.legacy);
      await dismissed.waitFor();
      assert.match(await statusLine(dismissed).innerText(), /^Dismissed · By you$/);
      await button(dismissed, "Undismiss").click();
      await gone(dismissed);
      assert.equal(fx.writes.at(-1)?.path, `/api/companies/company/decisions/${ID.legacy}/restore`);
      await page.close();
    },
  );

  await check("a refused Dismiss keeps the row with the reason inline", async () => {
    const fx = await open({
      rows: [decision()],
      failWrite: { suffix: "/dismiss", status: 409, error: "Decision is already decided" },
    });
    const card = row(fx.page, ID.contract);
    await card.waitFor();
    await button(card, "Dismiss").click();
    await card.getByText("Decision is already decided", { exact: true }).waitFor();
    assert.equal(await card.isVisible(), true);
    await fx.page.close();
  });

  await check("Snooze takes the row off in one click for the chosen time", async () => {
    const fx = await open({ rows: [decision(), legacyDecision()] });
    const card = row(fx.page, ID.contract);
    await card.waitFor();
    await button(card, /^Snooze/).click();
    await fx.page.getByRole("menuitem", { name: "1 day" }).click();
    await gone(card);
    assert.deepEqual(fx.writes.at(-1), {
      method: "POST",
      path: `/api/companies/company/decisions/${ID.contract}/snooze`,
      body: { duration: "one_day" },
    });
    await row(fx.page, ID.legacy).waitFor();
    await fx.page.close();
  });

  await check("Discuss opens the decision's own thread inside its row", async () => {
    const fx = await open({ rows: [decision()] });
    const card = row(fx.page, ID.contract);
    await card.waitFor();
    const discuss = button(card, "Discuss");
    assert.equal(await discuss.getAttribute("aria-expanded"), "false");
    await discuss.click();
    await card.getByRole("heading", { name: "Discussion with Alex Rivera", exact: true }).waitFor();
    await card.getByRole("textbox", { name: "Message Alex Rivera" }).waitFor();
    assert.equal(await button(card, "Hide discussion").getAttribute("aria-expanded"), "true");
    assert.deepEqual(fx.writes, [], "opening a discussion sends nothing");
    await button(card, "Hide discussion").click();
    await card
      .getByRole("heading", { name: "Discussion with Alex Rivera" })
      .waitFor({ state: "detached" });
    await fx.page.close();
  });

  await check(
    "email reviews gather under one heading and each keeps its own Send now, Edit and Discard",
    async () => {
      const fx = await open({
        rows: [],
        reviews: [mailReview(ID.mailA, 0), mailReview(ID.mailB, 1), mailReview(ID.mailC, 2)],
      });
      const { page } = fx;
      const group = page.locator('[data-stack-group="mail"]');
      await group.getByText("3 emails to review", { exact: true }).waitFor();
      assert.equal(await group.locator("[data-stack-row]").count(), 3);
      const first = reviewRow(page, ID.mailA);
      await first.getByText("To priya@acme.example", { exact: false }).waitFor();
      await first
        .getByText("Re: Checkout error with annual-plan discount", { exact: false })
        .waitFor();
      assert.match(
        await first.locator("[data-mail-preview]").innerText(),
        /^Hi there, Thanks for writing in \(0\)/,
      );
      // The full email, its source and the work behind it are in Details.
      await button(first, "Details").click();
      await first.getByRole("heading", { name: "The reply", exact: true }).waitFor();
      await first.getByRole("link", { name: "Open original email" }).waitFor();
      await first.getByText(/exists only in Genosyn/).waitFor();
      await button(first, "Hide details").click();
      await shot(page, "mail-group");
      // Send now sends only that email, with its own revision.
      await button(first, "Send now").click();
      await statusLine(first).getByText("Sent", { exact: true }).waitFor();
      assert.match(await statusLine(first).innerText(), /^Sent · To priya@acme\.example$/);
      assert.deepEqual(
        fx.writes.map((write) => `${write.method} ${write.path}`),
        [`POST /api/companies/company/approvals/${ID.mailA}/approve`],
      );
      assert.equal(fx.reviews.filter((review) => review.status === "pending").length, 2);
      // Discard leaves in the same click; the next email takes focus.
      const second = reviewRow(page, ID.mailB);
      await button(second, "Discard").click();
      await gone(second);
      await page.waitForFunction(
        (id) => document.activeElement?.closest(`[id="review-${id}"]`) !== null,
        ID.mailC,
      );
      await group.getByText("2 emails · 1 to review", { exact: true }).waitFor();
      await button(first, "Close review").click();
      await gone(first);
      // One email left: no heading over a group of one.
      await reviewRow(page, ID.mailC).waitFor();
      assert.equal(await group.getByText(/emails/).count(), 0);
      await page.close();
    },
  );

  await check(
    "a work review is one row; Don’t do this leaves in one click and Approve follows the work",
    async () => {
      const fx = await open({
        rows: [],
        reviews: [
          workReview(),
          workReview({ id: ID.sent, title: "Refresh the pricing page copy" }),
        ],
      });
      const { page } = fx;
      const card = reviewRow(page, ID.work);
      await card.waitFor();
      await page
        .locator('[data-stack-group="work"]')
        .getByText("2 work plans to review", { exact: true })
        .waitFor();
      assert.match(
        await card.locator("[data-work-plan]").innerText(),
        /^Plan: Investigate the checkout failure, prepare a fix in the Repository and run the existing Checks\.$/,
      );
      await button(card, "Details").click();
      await card.getByRole("heading", { name: "The plan", exact: true }).waitFor();
      await card.getByText(/Approve & start authorizes only this plan/).waitFor();
      await card.getByRole("link", { name: "Open source Run" }).waitFor();
      await button(card, "Approve & start").click();
      await statusLine(card).getByText("Approved", { exact: true }).waitFor();
      assert.match(await statusLine(card).innerText(), /Alex Rivera is doing the work/);
      const other = reviewRow(page, ID.sent);
      await button(other, "Don’t do this").click();
      await gone(other);
      assert.deepEqual(
        fx.writes.map((write) => write.path),
        [
          `/api/companies/company/approvals/${ID.work}/approve`,
          `/api/companies/company/approvals/${ID.sent}/reject`,
        ],
      );
      await page.close();
    },
  );

  await check(
    "History shows every outcome as one status line, with Details and filters",
    async () => {
      const fx = await open({ path: "/c/acme/decisions/history", rows: historyRows() });
      const { page } = fx;
      await page.getByRole("heading", { name: "Decision history", exact: true }).waitFor();
      const lines: Record<string, RegExp> = {
        [ID.done]:
          /^Done · Registered OneUptime on BidNet Direct and saved the UTA27 solicitation to the deal\.$/,
        [ID.reported]:
          /^Done · Booked the webinar for Nov 12 and invited the 40 contacts on the list\.$/,
        [ID.failed]: /^Couldn’t finish · The billing portal rejected the card on file\.$/,
        [ID.skipped]:
          /^Answer saved · Jamie Mallers has no AI Model connected, so nothing could start now\.$/,
        [ID.dismissed]: /^Dismissed · By you$/,
        [ID.withdrawn]:
          /^Withdrawn · Jamie Mallers no longer needs an answer · The organizer cancelled the show\.$/,
        [ID.expired]: /^Expired · This expired under an earlier version/,
      };
      for (const [id, expected] of Object.entries(lines)) {
        const card = row(page, id);
        await card.waitFor();
        assert.match(await statusLine(card).innerText(), expected, id);
      }
      // Only a Member's dismissal can be undone.
      assert.equal(await button(row(page, ID.dismissed), "Undismiss").count(), 1);
      assert.equal(await button(row(page, ID.withdrawn), "Undismiss").count(), 0);
      // An older finished pickup: its last paragraph is the report; the log is one toggle away.
      const done = row(page, ID.done);
      await button(done, "Details").click();
      await done.getByRole("heading", { name: "Answer", exact: true }).waitFor();
      await done
        .getByText(/Pursue: register and bid/)
        .first()
        .waitFor();
      await done.getByText(/Took 1h 6m/).waitFor();
      assert.equal(await shown(done.getByText(/cookie banner/)), false);
      await button(done, "Show the full log").click();
      await done.getByText(/dismiss the cookie banner/).waitFor();
      // Filters still narrow by status.
      await page.getByRole("button", { name: "Dismissed", exact: true }).click();
      await row(page, ID.done).waitFor({ state: "detached" });
      await row(page, ID.dismissed).waitFor();
      await row(page, ID.withdrawn).waitFor();
      await page.getByRole("button", { name: "All", exact: true }).click();
      await shot(page, "history");
      assert.deepEqual(fx.writes, []);
      await page.close();
    },
  );

  await check("settled email and work reviews read as status lines in History", async () => {
    const sent = mailReview(ID.mailA, 0, {
      status: "approved",
      decidedAt: hoursAgo(1),
      mailDeliveryStatus: "sent",
      mailOutcome: { sentMessageId: "m", providerMessageRef: "p", sentAt: hoursAgo(1) },
    });
    const discarded = mailReview(ID.mailB, 1, { status: "rejected", decidedAt: hoursAgo(2) });
    const notSent = mailReview(ID.mailC, 2, {
      status: "execution_failed",
      decidedAt: hoursAgo(3),
      mailDeliveryStatus: "not_sent",
      errorMessage: "The mailbox refused the message. Nothing was delivered.",
    });
    const done = workReview({
      status: "approved",
      decidedAt: hoursAgo(4),
      outcomeSummary: "Fixed the discount validation and the Checks passed. Ready to release.",
      outcomeRunId: "run-77",
    });
    const fx = await open({
      path: "/c/acme/decisions/history",
      rows: [],
      reviews: [sent, discarded, notSent, done],
    });
    const { page } = fx;
    await page.getByText("Email and work reviews", { exact: true }).waitFor();
    assert.match(
      await statusLine(reviewRow(page, ID.mailA)).innerText(),
      /^Sent · To priya@acme\.example$/,
    );
    assert.match(
      await statusLine(reviewRow(page, ID.mailB)).innerText(),
      /^Discarded · Nothing was sent\.$/,
    );
    assert.match(
      await statusLine(reviewRow(page, ID.mailC)).innerText(),
      /^Not sent · The mailbox refused the message\.$/,
    );
    assert.match(
      await statusLine(reviewRow(page, ID.work)).innerText(),
      /^Done · Fixed the discount validation and the Checks passed\.$/,
    );
    const failed = reviewRow(page, ID.mailC);
    await button(failed, "Details").click();
    await failed.getByRole("heading", { name: "What went wrong", exact: true }).waitFor();
    await failed.getByText("The mailbox refused the message. Nothing was delivered.").waitFor();
    const work = reviewRow(page, ID.work);
    await button(work, "Details").click();
    await work.getByRole("link", { name: "Open AI work, Effects, and Checks" }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Close review" }).count(),
      0,
      "no Close in History",
    );
    await page.close();
  });

  await check("Home's Active decisions uses the same compact rows, Dismiss included", async () => {
    const fx = await open({
      path: "/c/acme",
      rows: [decision(), legacyDecision()],
      reviews: [mailReview(ID.mailA, 0)],
    });
    const { page } = fx;
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Active decisions", exact: true }),
    });
    await section.waitFor();
    await section.getByText("3 waiting", { exact: true }).waitFor();
    for (const noise of [
      "Close each card",
      "Cards stay here until you close them",
      "Follow the outcome here",
    ]) {
      assert.equal(await page.getByText(noise).count(), 0, noise);
    }
    const legacy = row(page, ID.legacy);
    await legacy.locator("[data-decision-summary]").waitFor();
    await reviewRow(page, ID.mailA).getByRole("button", { name: "Send now" }).waitFor();
    await shot(page, "home");
    await button(legacy, "Dismiss").click();
    await gone(legacy);
    await section.getByText("2 waiting", { exact: true }).waitFor();
    const contract = row(page, ID.contract);
    await contract.getByText("Sign at 10% off", { exact: true }).click();
    await button(contract, "Confirm: Sign at 10% off").click();
    await statusLine(contract).getByText("You chose “Sign at 10% off”", { exact: true }).waitFor();
    assert.deepEqual(
      fx.writes.map((write) => write.path),
      [
        `/api/companies/company/decisions/${ID.legacy}/dismiss`,
        `/api/companies/company/decisions/${ID.contract}/decide`,
      ],
    );
    await page.close();
  });

  await check(
    "a Member answers Decisions, never sees reviews, and reads someone else's assigned one",
    async () => {
      const assigned = decision({
        id: ID.assigned,
        title: "Approve the Q4 hiring plan?",
        assignee: { id: "someone-else", name: "Priya Shah" },
      });
      const fx = await open({
        role: "member",
        rows: [decision(), assigned],
        reviews: [workReview()],
      });
      const { page } = fx;
      await stackReady(page);
      await row(page, ID.contract).waitFor();
      const other = row(page, ID.assigned);
      await page.getByText("Assigned to other Members (1)", { exact: false }).waitFor();
      await other
        .getByText(/Assigned to Priya Shah\. Only they or an owner or admin can answer\./)
        .waitFor();
      for (const radio of await other.getByRole("radio").all()) {
        assert.equal(await radio.isDisabled(), true);
      }
      assert.equal(await button(other, "Dismiss").count(), 0);
      assert.equal(await button(other, /^Snooze/).count(), 0);
      await button(other, "Discuss").waitFor();
      await button(other, "Details").click();
      await other.getByRole("heading", { name: "Why it needs you" }).waitFor();
      assert.equal(await page.locator(`[id="review-${ID.work}"]`).count(), 0);
      assert.equal(unexpected.filter((entry) => entry.startsWith("member read")).length, 0);
      await page.close();
    },
  );

  await check(
    "deep links open a waiting row on the stack and a settled one in History",
    async () => {
      const waiting = await open({
        path: `/c/acme/decisions#decision-${ID.contract}`,
        rows: [legacyDecision(), decision()],
      });
      await row(waiting.page, ID.contract).waitFor();
      await waiting.page.waitForFunction((id) => {
        const element = document.getElementById(`decision-${id}`);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.top < window.innerHeight && box.bottom > 0;
      }, ID.contract);
      await waiting.page.close();
      const settledLink = await open({
        path: `/c/acme/decisions#decision-${ID.done}`,
        rows: [decision(), ...historyRows()],
      });
      await settledLink.page
        .getByTestId("location")
        .getByText(`/c/acme/decisions/history#decision-${ID.done}`)
        .waitFor();
      await row(settledLink.page, ID.done).waitFor();
      await settledLink.page.close();
      const review = await open({
        path: `/c/acme/decisions#review-${ID.mailB}`,
        rows: [],
        reviews: [mailReview(ID.mailA, 0), mailReview(ID.mailB, 1)],
      });
      await reviewRow(review.page, ID.mailB).waitFor();
      await review.page.close();
    },
  );

  await check(
    "keyboard: Details and Discuss are buttons, the answers a radio group, Confirm submits",
    async () => {
      const fx = await open({ rows: [decision()] });
      const { page } = fx;
      const card = row(page, ID.contract);
      await card.waitFor();
      await button(card, "Details").focus();
      await page.keyboard.press("Enter");
      assert.equal(await button(card, "Hide details").getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Enter");
      await card.getByRole("radio").first().focus();
      await page.keyboard.press("Space");
      assert.equal(await card.getByRole("radio", { name: /^Sign at 10% off/ }).isChecked(), true);
      await page.keyboard.press("ArrowRight");
      assert.equal(await card.getByRole("radio", { name: /^Counter at 5%/ }).isChecked(), true);
      await button(card, "Confirm: Counter at 5%").focus();
      await page.keyboard.press("Enter");
      await statusLine(card).getByText("You chose “Counter at 5%”").waitFor();
      assert.deepEqual(fx.writes.at(-1)?.body, { optionId: "counter" });
      await page.close();
    },
  );

  await check(
    "keyboard: Enter on the picked answer confirms it, without tabbing to Confirm",
    async () => {
      const fx = await open({ rows: [decision()] });
      const { page } = fx;
      const card = row(page, ID.contract);
      await card.waitFor();
      await card.getByRole("radio").first().focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await card.getByRole("radio", { name: /^Counter at 5%/ }).isChecked(), true);
      assert.deepEqual(fx.writes, [], "moving between answers records nothing");
      await page.keyboard.press("Enter");
      await statusLine(card).getByText("You chose “Counter at 5%”").waitFor();
      assert.deepEqual(fx.writes, [
        {
          method: "POST",
          path: `/api/companies/company/decisions/${ID.contract}/decide`,
          body: { optionId: "counter" },
        },
      ]);
      await page.close();
    },
  );

  await check("the Settings banner still says when new questions are off", async () => {
    const fx = await open({ stackEnabled: false, rows: [decision()] });
    await fx.page.getByText("The Decision stack is off", { exact: false }).waitFor();
    await row(fx.page, ID.contract).getByRole("radiogroup").waitFor();
    await fx.page.close();
  });

  await check("dark mode draws the rows on dark surfaces", async () => {
    const fx = await open({
      scheme: "dark",
      rows: [decision()],
      reviews: [mailReview(ID.mailA, 0), mailReview(ID.mailB, 1)],
    });
    const { page } = fx;
    await row(page, ID.contract).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.classList.contains("dark")),
      true,
    );
    const background = await page
      .locator("[data-stack-list]")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(background, "rgb(255, 255, 255)");
    await shot(page, "dark");
    await page.close();
  });

  await check(
    "phone width: every surface fits without sideways scrolling, Details open",
    async () => {
      const stack = await open({
        width: 375,
        rows: [legacyDecision(), decision()],
        reviews: [mailReview(ID.mailA, 0), mailReview(ID.mailB, 1), workReview()],
      });
      await row(stack.page, ID.legacy).waitFor();
      await button(row(stack.page, ID.legacy), "Details").click();
      await button(reviewRow(stack.page, ID.mailA), "Details").click();
      await row(stack.page, ID.contract).getByText("Sign at 10% off", { exact: true }).click();
      await noSidewaysScroll(stack.page, "the stack");
      await shot(stack.page, "phone-stack");
      await stack.page.close();
      const history = await open({
        width: 375,
        path: "/c/acme/decisions/history",
        rows: historyRows(),
      });
      await row(history.page, ID.done).waitFor();
      await button(row(history.page, ID.done), "Details").click();
      await button(row(history.page, ID.done), "Show the full log").click();
      await noSidewaysScroll(history.page, "History");
      await history.page.close();
      const home = await open({
        width: 375,
        path: "/c/acme",
        rows: [legacyDecision(), decision()],
      });
      await row(home.page, ID.legacy).waitFor();
      await button(row(home.page, ID.legacy), "Details").click();
      await noSidewaysScroll(home.page, "Home");
      await shot(home.page, "phone-home");
      await home.page.close();
    },
  );

  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join("\n")}`);
  assert.deepEqual(unexpected, [], `unexpected requests: ${unexpected.join("\n")}`);
} finally {
  await browser.close();
  await fixture.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`Failed: ${failures.join("; ")}`);
  process.exit(1);
}
