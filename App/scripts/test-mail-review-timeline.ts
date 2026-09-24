/**
 * Real Chrome coverage for Inbox review badges and the production conversation
 * timeline. HTTP fixtures are local and deterministic; unexpected calls fail.
 * Run with tsx scripts/test-mail-review-timeline.ts [case name substring].
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import type {
  MailAnalysis,
  MailMessage,
  MailReviewEvent,
  MailReviewSummary,
  MailReviewTimelineData,
  MailThread,
} from "../client/lib/mail";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const base = "/api/companies/company/mail";
const employee = { id: "ada", name: "Ada Ledger", slug: "ada-ledger", avatarKey: null };
const timestamp = (minute: number) => new Date(Date.UTC(2026, 8, 24, 10, minute)).toISOString();
const statuses: MailReviewSummary["status"][] = [
  "not_reviewed",
  "queued",
  "reviewing",
  "reviewed",
  "needs_attention",
];
const labels = ["Not reviewed", "AI queued", "AI reviewing", "AI reviewed", "Needs attention"];
const subjects = [
  "A new partnership enquiry",
  "Help with our latest invoice",
  "Could you send a revised quote?",
  "Quote for two site surveys",
  "A question about your delivery dates",
];

function review(status: MailReviewSummary["status"], messageId = "inbound"): MailReviewSummary {
  return {
    status,
    latestMessageId: messageId,
    employee: status === "not_reviewed" || status === "queued" ? null : employee,
    updatedAt: status === "not_reviewed" ? null : timestamp(2),
  };
}

function row(status: MailReviewSummary["status"], index: number): MailThread {
  return {
    id: status,
    gmailThreadId: `remote-${status}`,
    accountId: "account",
    subject: subjects[index],
    snippet: "Thanks for your help. Please let us know the next steps.",
    participants: ["Nadia Okafor", "Alex Chen", "Priya Sharma", "Nadia Okafor", "Charlie Davis"][
      index
    ],
    labelIds: ["INBOX"],
    unread: false,
    messageCount: index === 3 ? 3 : 1,
    hasAttachments: index === 3,
    lastMessageAt: timestamp(index),
    aiReview: review(status),
  };
}

function event(
  kind: MailReviewEvent["kind"],
  minute: number,
  changes: Partial<MailReviewEvent> = {},
): MailReviewEvent {
  return {
    id: `event-${kind}-${minute}`,
    kind,
    occurredAt: timestamp(minute),
    title: {
      received: "Email received",
      review_started: "Started reviewing this email",
      review_completed: "Email reviewed",
      review_failed: "Email review needs attention",
      handover_queued: "Work queued",
      handover_started: "Started working on this email",
      handover_completed: "Email work completed",
      handover_failed: "Email work needs attention",
      decision: "Decision added to the stack",
      quote: "Quote created",
      draft: "Email draft created",
      sent: "Email sent",
      approval: "Reply prepared for review",
      action: "Contact updated",
    }[kind],
    description: null,
    employee: kind === "received" ? null : employee,
    href: null,
    status: "complete",
    ...changes,
  };
}

function completeTimeline(): MailReviewTimelineData {
  return {
    truncated: false,
    events: [
      event("received", 0, { description: "From Nadia Okafor · nadia@customer.example" }),
      event("review_started", 1),
      event("review_completed", 2, {
        description: "The customer requested pricing for two site surveys.",
      }),
      event("decision", 3, {
        description: "Offer a three-year price guarantee?",
        href: "/decisions#decision-decision-1",
      }),
      event("quote", 4, {
        description: "Draft quote · Northwind customer",
        href: "/finance/estimates/edraft-quote",
      }),
      event("draft", 5, {
        title: "Reply prepared for review",
        description: "An exact reply is waiting for review before sending.",
        href: "/decisions#review-approval-1",
        status: "pending",
      }),
    ],
  };
}

function message(thread: MailThread): MailMessage {
  return {
    id: "inbound",
    threadId: thread.id,
    gmailMessageId: `provider-message-${thread.id}`,
    isDraft: false,
    fromName: "Nadia Okafor",
    fromEmail: "nadia@customer.example",
    toEmails: "support@northwind.example",
    ccEmails: "",
    bccEmails: "",
    subject: thread.subject,
    snippet: "Please quote for two site surveys.",
    bodyText:
      "Hi Ada,\n\nCould you send us a quote for two site surveys and a written report?\n\nThanks,\nNadia",
    bodyHtml: "",
    labelIds: ["INBOX"],
    sentAt: timestamp(0),
    createdAt: timestamp(0),
    createdByUserId: null,
    createdByEmployeeId: null,
    createdByRoutineId: null,
    createdByRunId: null,
    attachments: [],
  };
}

type State = {
  threads: MailThread[];
  timelines: Record<string, MailReviewTimelineData>;
  analyses: MailAnalysis[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
  detailError: boolean;
  allowStar: boolean;
  allowAnalyze: boolean;
  detailDelay: ReturnType<typeof deferred> | null;
  actionDelay: ReturnType<typeof deferred> | null;
};
type Surface = {
  initialRoute?: string;
  surface?: "mail" | "component";
  review?: MailReviewSummary;
  timeline?: MailReviewTimelineData | null;
  error?: string;
  navigationControls?: boolean;
};
function deferred() {
  let requested!: () => void;
  let release!: () => void;
  return {
    arrived: new Promise<void>((resolve) => {
      requested = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    requested: () => requested(),
    release: () => release(),
  };
}
function fixture(): State {
  return {
    threads: statuses.map(row),
    timelines: Object.fromEntries(
      statuses.map((status) => [
        status,
        status === "reviewed"
          ? completeTimeline()
          : {
              truncated: false,
              events: [
                event("received", 0),
                ...(status === "reviewing"
                  ? [event("review_started", 1, { status: "running" })]
                  : status === "needs_attention"
                    ? [event("review_failed", 2, { status: "failed" })]
                    : []),
              ],
            },
      ]),
    ),
    analyses: [],
    calls: [],
    detailError: false,
    allowStar: false,
    allowAnalyze: false,
    detailDelay: null,
    actionDelay: null,
  };
}

const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-mail-review-timeline"),
  plugins: [
    {
      name: "mail-review-timeline-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__mail_review_timeline", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__mail_review_timeline",
            '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
              `<script type="module" src="/@fs${root}/scripts/mailReviewTimelineHarness.tsx"></script></html>`,
          );
          response.setHeader("content-type", "text/html");
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
const cases: Array<{
  name: string;
  run: (page: Page, state: State) => Promise<void>;
  setup?: (state: State) => void;
  surface?: Surface;
  width?: number;
  dark?: boolean;
}> = [];
const timeline = (page: Page) => page.getByRole("region", { name: "AI work timeline" });
const badge = (page: Page, status: string) => page.locator(`[data-review-status="${status}"]`);
const threadRoute = (id = "reviewed") => `/c/northwind/mail/t/${id}`;
const refresh = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("mail-review-refresh")));
const writes = (state: State) => state.calls.filter((call) => call.method !== "GET");
function add(
  name: string,
  run: (page: Page, state: State) => Promise<void>,
  options: Omit<(typeof cases)[number], "name" | "run"> = {},
) {
  cases.push({ name, run, ...options });
}

add(
  "Inbox shows all five review states as compact accessible words independent of unread",
  async (page, state) => {
    for (let index = 0; index < statuses.length; index++) {
      const item = badge(page, statuses[index]);
      assert.equal(await item.innerText(), labels[index]);
      assert.ok((await item.getAttribute("aria-label"))?.startsWith(`${labels[index]}.`));
      assert.ok(await item.getAttribute("title"));
      assert.ok(await item.isVisible());
    }
    assert.deepEqual(writes(state), []);
    await page.screenshot({
      path: path.join(output, "mail-review-inbox-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
  },
);

add(
  "opening a reviewed email shows the actual work in order above the original message",
  async (page) => {
    await page.getByRole("link", { name: /Quote for two site surveys/ }).click();
    await timeline(page).getByText("Reply prepared for review", { exact: true }).waitFor();
    assert.deepEqual(
      await timeline(page)
        .locator("[data-timeline-kind]")
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-kind"))),
      ["received", "review_started", "review_completed", "decision", "quote", "draft"],
    );
    assert.equal(await timeline(page).getByText("Ada Ledger", { exact: true }).count(), 5);
    assert.equal(await timeline(page).locator("time[datetime]").count(), 6);
    assert.ok(
      await page
        .getByText("Could you send us a quote for two site surveys and a written report?", {
          exact: false,
        })
        .isVisible(),
    );
    const timelineBox = await timeline(page).boundingBox();
    const bodyBox = await page
      .getByText("Could you send us a quote for two site surveys and a written report?", {
        exact: false,
      })
      .boundingBox();
    assert.ok(timelineBox && bodyBox && timelineBox.y < bodyBox.y);
    await page.screenshot({
      path: path.join(output, "mail-review-timeline-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
  },
);

add(
  "open conversation refresh transitions reviewing to reviewed and adds proved effects",
  async (page, state) => {
    await badge(page, "reviewing").waitFor();
    state.threads.find((thread) => thread.id === "reviewing")!.aiReview = review("reviewed");
    state.timelines.reviewing = completeTimeline();
    await refresh(page);
    await badge(page, "reviewed").waitFor();
    assert.equal(await badge(page, "reviewing").count(), 0);
    await timeline(page).getByText("Quote created", { exact: true }).waitFor();
    assert.equal(await timeline(page).locator("[data-timeline-kind]").count(), 6);
    assert.deepEqual(writes(state), []);
  },
  { surface: { initialRoute: threadRoute("reviewing") } },
);

add(
  "Inbox refresh resets only the conversation that received a new message",
  async (page, state) => {
    await badge(page, "reviewed").waitFor();
    state.threads.find((thread) => thread.id === "reviewed")!.aiReview = review(
      "not_reviewed",
      "new-reply",
    );
    await refresh(page);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-review-status="not_reviewed"]').length === 2,
    );
    assert.equal(await badge(page, "reviewed").count(), 0);
    assert.equal(await badge(page, "reviewing").count(), 1);
    assert.deepEqual(writes(state), []);
  },
);

for (const [kind, title, href] of [
  ["quote", "Quote created", "/c/northwind/finance/estimates/edraft-quote"],
  ["decision", "Decision added to the stack", "/c/northwind/decisions#decision-decision-1"],
  ["draft", "Reply prepared for review", "/c/northwind/decisions#review-approval-1"],
] as const) {
  add(
    `${kind} action opens its precise company-scoped destination using keyboard`,
    async (page) => {
      const link = timeline(page).getByRole("link", { name: title, exact: true });
      assert.equal(await link.getAttribute("href"), href);
      await link.focus();
      await page.keyboard.press("Enter");
      await page.getByLabel("Opened destination").waitFor();
      assert.equal(await page.getByLabel("Opened destination").innerText(), href);
    },
    { surface: { initialRoute: threadRoute() } },
  );
}

add(
  "long timelines expand and collapse without reordering or duplicating events",
  async (page) => {
    assert.equal(await timeline(page).locator("[data-timeline-kind]").count(), 6);
    const earlier = timeline(page).getByRole("button", { name: "Show 3 earlier events" });
    assert.equal(await earlier.getAttribute("aria-expanded"), "false");
    await earlier.click();
    assert.equal(await timeline(page).locator("[data-timeline-kind]").count(), 9);
    const times = await timeline(page)
      .locator("time")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
    assert.deepEqual(times, [...times].sort());
    const recent = timeline(page).getByRole("button", { name: "Show recent events" });
    assert.equal(await recent.getAttribute("aria-expanded"), "true");
    await recent.click();
    assert.equal(await timeline(page).locator("[data-timeline-kind]").count(), 6);
  },
  {
    surface: { initialRoute: threadRoute() },
    setup(state) {
      state.timelines.reviewed.events.push(event("draft", 6), event("sent", 7), event("action", 8));
    },
  },
);

add(
  "failed refresh preserves recorded history and an explicit retry clears its inline error",
  async (page, state) => {
    await timeline(page).getByText("Quote created", { exact: true }).waitFor();
    state.detailError = true;
    await refresh(page);
    const error = page.getByRole("main").getByRole("alert");
    await error.waitFor();
    assert.ok((await error.innerText()).includes("Mail history temporarily unavailable"));
    assert.ok(await timeline(page).getByText("Quote created", { exact: true }).isVisible());
    state.detailError = false;
    await page.getByRole("main").getByRole("button", { name: "Try again", exact: true }).click();
    await error.waitFor({ state: "hidden" });
    await timeline(page).getByText("Quote created", { exact: true }).waitFor();
    assert.equal(await error.count(), 0);
  },
  { surface: { initialRoute: threadRoute() } },
);

add(
  "retrying failed analysis refreshes its badge and timeline without a socket notification",
  async (page, state) => {
    await badge(page, "needs_attention").waitFor();
    await page.getByRole("main").getByRole("button", { name: "Try again", exact: true }).click();
    await badge(page, "reviewed").waitFor();
    await timeline(page).getByText("Quote created", { exact: true }).waitFor();
    assert.equal(await badge(page, "needs_attention").count(), 0);
    assert.deepEqual(
      writes(state).map((call) => call.path),
      [`${base}/messages/inbound/analyze`],
    );
  },
  {
    surface: { initialRoute: threadRoute("needs_attention") },
    setup(state) {
      state.allowAnalyze = true;
      state.analyses = [
        {
          id: "failed-analysis",
          threadId: "needs_attention",
          messageId: "inbound",
          status: "failed",
          employeeId: "ada",
          modelId: null,
          category: "",
          summary: "",
          actions: [],
          errorMessage: "Could not review this email. Please try again.",
          createdAt: timestamp(1),
          finishedAt: timestamp(2),
        },
      ];
    },
  },
);

add(
  "ordinary mailbox actions preserve review status when their response omits its projection",
  async (page, state) => {
    await badge(page, "reviewed").waitFor();
    await page.getByRole("main").getByRole("button", { name: "Star", exact: true }).click();
    await page.getByRole("main").getByRole("button", { name: "Unstar", exact: true }).waitFor();
    assert.equal(await badge(page, "reviewed").count(), 1);
    assert.equal(await badge(page, "unavailable").count(), 0);
    assert.deepEqual(
      writes(state).map((call) => call.body),
      [{ action: "star" }],
    );
  },
  {
    surface: { initialRoute: threadRoute() },
    setup(state) {
      state.allowStar = true;
    },
  },
);

add(
  "starring an Inbox row preserves its review badge and does not open the conversation",
  async (page, state) => {
    const item = page.locator('[data-thread-idx="3"]');
    await item.getByRole("button", { name: "Star", exact: true }).click();
    await item.getByRole("button", { name: "Unstar", exact: true }).waitFor();
    assert.equal(await item.locator('[data-review-status="reviewed"]').count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Inbox", exact: true }).count(), 1);
    assert.equal(await timeline(page).count(), 0);
    assert.deepEqual(
      writes(state).map((call) => call.body),
      [{ action: "star" }],
    );
  },
  {
    setup(state) {
      state.allowStar = true;
    },
  },
);

add(
  "a delayed refresh cannot replace a newly opened email with the old timeline",
  async (page, state) => {
    await badge(page, "reviewed").waitFor();
    const delayed = deferred();
    state.detailDelay = delayed;
    await refresh(page);
    await delayed.arrived;
    state.detailDelay = null;
    await page.getByRole("link", { name: "Open unreviewed email", exact: true }).click();
    await badge(page, "not_reviewed").waitFor();
    const oldResponse = page.waitForResponse((response) =>
      response.url().endsWith("/threads/reviewed"),
    );
    delayed.release();
    await oldResponse;
    await page.waitForTimeout(100);
    assert.equal(await badge(page, "reviewed").count(), 0);
    assert.equal(await timeline(page).getByText("Quote created", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: subjects[0], exact: true }).count(), 1);
  },
  { surface: { initialRoute: threadRoute(), navigationControls: true } },
);

add(
  "a delayed mailbox action cannot overwrite the next email or its review state",
  async (page, state) => {
    await badge(page, "reviewed").waitFor();
    const delayed = deferred();
    state.actionDelay = delayed;
    await page.getByRole("main").getByRole("button", { name: "Star", exact: true }).click();
    await delayed.arrived;
    await page.getByRole("link", { name: "Open unreviewed email", exact: true }).click();
    await badge(page, "not_reviewed").waitFor();
    const oldResponse = page.waitForResponse((response) =>
      response.url().endsWith("/threads/reviewed/actions"),
    );
    delayed.release();
    await oldResponse;
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole("heading", { name: subjects[0], exact: true }).count(), 1);
    assert.equal(await badge(page, "reviewed").count(), 0);
    assert.equal(
      await page.getByRole("main").getByRole("button", { name: "Star", exact: true }).count(),
      1,
    );
  },
  {
    surface: { initialRoute: threadRoute(), navigationControls: true },
    setup(state) {
      state.allowStar = true;
    },
  },
);

add(
  "a new reply never displays the previous inbound analysis as its current summary",
  async (page) => {
    await badge(page, "not_reviewed").waitFor();
    assert.equal(
      await page.getByText("Summary of an older message only", { exact: true }).count(),
      0,
    );
    assert.ok(
      await timeline(page)
        .getByText("The latest incoming email has not been reviewed by an AI Employee.", {
          exact: true,
        })
        .isVisible(),
    );
  },
  {
    surface: { initialRoute: threadRoute("not_reviewed") },
    setup(state) {
      state.threads[0].aiReview = review("not_reviewed", "latest-message");
      state.analyses = [
        {
          id: "older-analysis",
          threadId: "not_reviewed",
          messageId: "inbound",
          status: "succeeded",
          employeeId: "ada",
          modelId: null,
          category: "quote_request",
          summary: "Summary of an older message only",
          actions: [],
          errorMessage: "",
          createdAt: timestamp(1),
          finishedAt: timestamp(2),
        },
      ];
    },
  },
);

add(
  "loading and missing status stay honest and accessible",
  async (page) => {
    const loading = timeline(page).getByRole("status");
    await loading.waitFor();
    assert.match(await loading.innerText(), /Loading the timeline/);
    assert.equal(await badge(page, "unavailable").innerText(), "Review unavailable");
    assert.equal(await badge(page, "reviewed").count(), 0);
  },
  { surface: { surface: "component", timeline: null } },
);

add(
  "empty timeline and retry display inline without a toast",
  async (page) => {
    await timeline(page).getByRole("alert").waitFor();
    await timeline(page).getByRole("button", { name: "Try again" }).click();
    await timeline(page)
      .getByText("No activity has been recorded for this conversation yet.", { exact: true })
      .waitFor();
    assert.equal(await timeline(page).getByRole("alert").count(), 0);
  },
  {
    surface: {
      surface: "component",
      review: review("not_reviewed"),
      error: "Timeline unavailable",
      timeline: null,
    },
  },
);

add(
  "untrusted text stays text and malformed destinations never become links",
  async (page) => {
    const panel = timeline(page);
    assert.equal(await panel.getByRole("link").count(), 0);
    assert.equal(await panel.locator("img,script").count(), 0);
    assert.ok((await panel.innerText()).includes('<img src=x onerror="window.hacked=true">'));
    assert.equal(
      await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked),
      undefined,
    );
  },
  {
    surface: {
      surface: "component",
      review: review("reviewed"),
      timeline: {
        truncated: false,
        events: [
          "https://attacker.example",
          "//attacker.example",
          "/../another-company",
          "/%2e%2e/another-company",
          "javascript:alert(1)",
        ].map((href, index) =>
          event("quote", index, {
            href,
            title: '<img src=x onerror="window.hacked=true">',
            description: "<script>window.hacked=true</script>",
          }),
        ),
      },
    },
  },
);

add(
  "bounded timeline states explicitly that earlier recorded activity is omitted",
  async (page) => {
    await timeline(page)
      .getByText("Showing the most recent recorded activity.", { exact: false })
      .waitFor();
  },
  {
    surface: {
      surface: "component",
      review: review("reviewed"),
      timeline: { ...completeTimeline(), truncated: true },
    },
  },
);

for (const width of [390, 320]) {
  add(
    `mobile ${width}px Inbox keeps long subjects and all review badges within the viewport`,
    async (page) => {
      for (const status of statuses) {
        const box = await badge(page, status).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${status} must fit ${width}px`);
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.ok(await page.locator("html.dark").count());
      await page.screenshot({
        path: path.join(output, `mail-review-inbox-mobile-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    },
    {
      width,
      dark: true,
      setup(state) {
        state.threads.forEach((thread) => {
          thread.subject +=
            " — extremely detailed international customer request that must remain readable";
        });
      },
    },
  );
}

add(
  "mobile dark timeline wraps long employee names, links and descriptions without overflow",
  async (page) => {
    const panel = timeline(page);
    await panel.getByText("Quote created", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({
      path: path.join(output, "mail-review-timeline-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
  },
  {
    width: 390,
    dark: true,
    surface: { initialRoute: threadRoute() },
    setup(state) {
      for (const entry of state.timelines.reviewed.events) {
        if (entry.employee)
          entry.employee = {
            ...employee,
            name: "Alexandria-Marguerite Customer Partnerships and International Sales",
          };
        if (entry.description)
          entry.description += " " + "VeryLongCustomerReferenceWithoutSpaces".repeat(4);
      }
    },
  },
);

const filter = process.argv.slice(2).join(" ").toLowerCase();
let passed = 0;
try {
  await fs.mkdir(output, { recursive: true });
  const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No browser cases match ${JSON.stringify(filter)}`);
  for (const item of selected) {
    const state = fixture();
    item.setup?.(state);
    const errors: string[] = [];
    const unexpected: string[] = [];
    const context = await browser.newContext({
      viewport: { width: item.width ?? 1440, height: item.width ? 844 : 1000 },
      colorScheme: item.dark ? "dark" : "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript((surface) => {
      (window as unknown as { __mailReviewFixture: Surface }).__mailReviewFixture = surface;
    }, item.surface ?? {});
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(`External request: ${request.url()}`);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const method = request.method();
      const call: State["calls"][number] = { method, path: url.pathname };
      state.calls.push(call);
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (method === "GET" && url.pathname === `${base}/accounts/account/threads`)
        return json({ threads: state.threads, nextBefore: null });
      if (method === "GET" && url.pathname === `${base}/accounts/account/saved-searches`)
        return json({ savedSearches: [] });
      if (method === "GET" && url.pathname === `${base}/accounts/account/assistant`)
        return json({ messages: [], roster: [], modelId: null });
      if (
        method === "POST" &&
        url.pathname === `${base}/messages/inbound/analyze` &&
        state.allowAnalyze
      ) {
        call.body = request.postDataJSON();
        const thread = state.threads.find((thread) => thread.id === "needs_attention")!;
        thread.aiReview = review("reviewed");
        state.timelines.needs_attention = completeTimeline();
        state.analyses[0] = {
          ...state.analyses[0],
          status: "succeeded",
          summary: "The customer asks about delivery dates.",
          errorMessage: "",
        };
        return json({ analysis: state.analyses[0] });
      }
      const match = url.pathname.match(/^\/api\/companies\/company\/mail\/threads\/([^/]+)$/);
      if (method === "GET" && match) {
        if (state.detailError) return json({ error: "Mail history temporarily unavailable" }, 503);
        const thread = state.threads.find((thread) => thread.id === match[1]);
        if (!thread) return json({ error: "Thread not found" }, 404);
        if (state.detailDelay) {
          const delay = state.detailDelay;
          delay.requested();
          await delay.wait;
        }
        return json({
          thread,
          account: { id: "account", address: "support@northwind.example" },
          messages: [message(thread)],
          handovers: [],
          analyses: state.analyses,
          reviewTimeline: state.timelines[thread.id],
        });
      }
      if (
        method === "POST" &&
        url.pathname === `${base}/threads/reviewed/actions` &&
        state.allowStar
      ) {
        call.body = request.postDataJSON();
        assert.deepEqual(call.body, { action: "star" });
        const thread = state.threads.find((thread) => thread.id === "reviewed")!;
        thread.labelIds.push("STARRED");
        const { aiReview: _review, ...projection } = thread;
        if (state.actionDelay) {
          const delay = state.actionDelay;
          delay.requested();
          await delay.wait;
        }
        return json({ thread: projection });
      }
      unexpected.push(`${method} ${url.pathname}`);
      return json({ error: "Unexpected fixture request" }, 500);
    });
    console.log(`RUN ${item.name}`);
    try {
      await page.goto(`${origin}/__mail_review_timeline`, { waitUntil: "commit" });
      if (item.surface?.surface === "component" || item.surface?.initialRoute) {
        await timeline(page).waitFor({ timeout: 60_000 });
      } else {
        await page
          .getByRole("heading", { name: "Inbox", exact: true })
          .waitFor({ timeout: 60_000 });
        await badge(page, "not_reviewed").waitFor();
      }
      await item.run(page, state);
      assert.deepEqual(errors, [], "Production components must not throw in the browser");
      assert.deepEqual(unexpected, [], "Every request must be expected and local");
      console.log(`PASS ${item.name}`);
      passed++;
    } catch (error) {
      await page
        .screenshot({
          path: path.join(output, "mail-review-timeline-failure.png"),
          fullPage: true,
          animations: "disabled",
        })
        .catch(() => {});
      console.error(`FAIL ${item.name}`);
      if (unexpected.length) console.error(unexpected);
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} mail review timeline browser cases passed.`);
} finally {
  await browser.close();
  await server.close();
}
