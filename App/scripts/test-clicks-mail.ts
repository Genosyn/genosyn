/**
 * Real Chrome coverage for the shorter Email flows, on the real App: Archive,
 * Trash and Mark unread in an open thread return to the list it came from
 * (its folder or search intact, the keyboard cursor on the same row or the
 * next one) instead of leaving a Back click; a thread marked unread stays
 * unread; Back from a link-opened thread goes to the Inbox; the mail keys
 * work inside a thread (e # s u r a); the AI analysis card's Archive returns
 * too; Hand to AI starts on an employee who can draft; and Edit from the
 * Drafts queue lands in that draft's editor. Each flow counts its clicks.
 * Run with `npm run test:clicks-mail`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type {
  MailAccount,
  MailAnalysis,
  MailDraft,
  MailGrant,
  MailMessage,
  MailThread,
} from "../client/lib/mail";
import {
  API,
  ME,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Fewer clicks — Email");

// ───────────────────────────── fixtures ─────────────────────────────

const ACCOUNT: MailAccount = {
  id: "mailbox",
  connectionId: "conn",
  provider: "gmail",
  address: "support@acme.example",
  senderName: "",
  status: "active",
  statusMessage: "",
  lastSyncAt: hoursAgo(0.1),
  syncState: "succeeded",
  syncAttemptId: null,
  syncStartedAt: hoursAgo(0.1),
  syncFinishedAt: hoursAgo(0.1),
  backfilledAt: hoursAgo(100),
  backfilledCount: 40,
  aiAnalysisEnabled: true,
  aiAnalysisEmployeeId: null,
  aiAnalysisModelId: null,
  createdAt: hoursAgo(500),
};

function thread(id: string, subject: string, hours: number, changes: Partial<MailThread> = {}) {
  const row: MailThread = {
    id,
    gmailThreadId: `g-${id}`,
    accountId: ACCOUNT.id,
    subject,
    snippet: `About ${subject}`,
    participants: "Priya Shah",
    labelIds: ["INBOX"],
    unread: false,
    messageCount: 1,
    hasAttachments: false,
    lastMessageAt: hoursAgo(hours),
    ...changes,
  };
  return row;
}

function message(t: MailThread, changes: Partial<MailMessage> = {}): MailMessage {
  return {
    id: `${t.id}-m1`,
    threadId: t.id,
    gmailMessageId: `gm-${t.id}`,
    isDraft: false,
    fromName: "Priya Shah",
    fromEmail: "priya@customer.example",
    toEmails: ACCOUNT.address,
    ccEmails: "",
    bccEmails: "",
    subject: t.subject,
    snippet: t.snippet,
    bodyText: `Hello, a question about ${t.subject}.`,
    bodyHtml: "",
    labelIds: t.labelIds,
    sentAt: t.lastMessageAt,
    createdAt: t.lastMessageAt,
    createdByUserId: null,
    createdByEmployeeId: null,
    createdByRoutineId: null,
    createdByRunId: null,
    attachments: [],
    ...changes,
  };
}

type Store = {
  threads: MailThread[];
  drafts: Map<string, MailMessage>;
  analyses: Map<string, MailAnalysis[]>;
  grants: MailGrant[];
};

function store(): Store {
  return {
    threads: [
      thread("t-renewal", "Acme renewal", 1),
      thread("t-invoice", "Invoice 1042 overdue", 2, { unread: true }),
      thread("t-launch", "Launch date", 3),
      thread("t-acme-api", "Acme API limits", 4),
      thread("t-hiring", "Hiring plan", 5),
    ],
    drafts: new Map(),
    analyses: new Map(),
    grants: [],
  };
}

function inView(t: MailThread, view: string): boolean {
  if (view === "trash") return t.labelIds.includes("TRASH");
  if (t.labelIds.includes("TRASH")) return false;
  if (view === "starred") return t.labelIds.includes("STARRED");
  if (view === "all") return true;
  return t.labelIds.includes("INBOX");
}

function apply(t: MailThread, action: string) {
  const without = (label: string) => t.labelIds.filter((id) => id !== label);
  if (action === "archive") t.labelIds = without("INBOX");
  else if (action === "moveToInbox") t.labelIds = [...without("INBOX"), "INBOX"];
  else if (action === "trash") t.labelIds = [...without("INBOX"), "TRASH"];
  else if (action === "untrash") t.labelIds = [...without("TRASH"), "INBOX"];
  else if (action === "star") t.labelIds = [...without("STARRED"), "STARRED"];
  else if (action === "unstar") t.labelIds = without("STARRED");
  else if (action === "markRead") t.unread = false;
  else if (action === "markUnread") t.unread = true;
}

function mailRoutes(s: Store): ApiRoute[] {
  const mail = `${API}/mail`;
  return [
    ["GET", `${mail}/accounts`, () => ({ accounts: [ACCOUNT] })],
    [
      "GET",
      `${mail}/accounts/mailbox/labels`,
      () => ({
        labels: [],
        counts: {
          inboxUnread: s.threads.filter((t) => t.unread && inView(t, "inbox")).length,
          drafts: s.drafts.size,
          starred: 0,
        },
      }),
    ],
    [
      "GET",
      `${mail}/accounts/mailbox/threads`,
      ({ url }) => {
        const view = url.searchParams.get("view") ?? "inbox";
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return {
          threads: s.threads
            .filter((t) => inView(t, view))
            .filter((t) => !q || t.subject.toLowerCase().includes(q)),
          nextBefore: null,
        };
      },
    ],
    ["GET", `${mail}/accounts/mailbox/saved-searches`, () => ({ savedSearches: [] })],
    ["GET", `${mail}/accounts/mailbox/grants`, () => ({ direct: s.grants })],
    [
      "GET",
      /^\/api\/companies\/company\/mail\/threads\/([^/]+)\/reply-recipients$/,
      () => ({ to: "priya@customer.example", cc: "" }),
    ],
    [
      "GET",
      /^\/api\/companies\/company\/mail\/threads\/([^/]+)$/,
      ({ match }) => {
        const t = s.threads.find((row) => row.id === match[1])!;
        const draft = s.drafts.get(t.id);
        return {
          thread: t,
          account: { id: ACCOUNT.id, address: ACCOUNT.address },
          messages: [message(t), ...(draft ? [draft] : [])],
          handovers: [],
          analyses: s.analyses.get(t.id) ?? [],
          reviewTimeline: { events: [], truncated: false },
        };
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/mail\/threads\/([^/]+)\/actions$/,
      ({ match, body }) => {
        const t = s.threads.find((row) => row.id === match[1])!;
        apply(t, String(body.action));
        return { thread: t };
      },
    ],
    [
      "POST",
      /^\/api\/companies\/company\/mail\/analyses\/([^/]+)\/actions\/([^/]+)$/,
      ({ match }) => {
        for (const [threadId, list] of s.analyses) {
          const analysis = list.find((row) => row.id === match[1]);
          if (!analysis) continue;
          const action = analysis.actions.find((row) => row.id === decodeURIComponent(match[2]))!;
          action.executedAt = hoursAgo(0);
          const t = s.threads.find((row) => row.id === threadId)!;
          if (action.action) apply(t, action.action);
          return { analysis, navigateTo: null, message: "" };
        }
        throw new Error("no such analysis");
      },
    ],
    ["GET", `${API}/employees`, () => []],
  ];
}

const listRow = (page: Page, subject: string) =>
  page.locator("li[data-thread-idx]").filter({ hasText: subject });
const cursorRow = (page: Page) => page.locator('li[data-cursor="true"]');
const threadHeading = (page: Page, subject: string) =>
  page.getByRole("heading", { name: subject, exact: true });

async function inboxReady(page: Page) {
  await listRow(page, "Acme renewal").waitFor();
}

// ───────────────────────────── checks ─────────────────────────────

await app.check(
  "Archive in an open thread returns to the Inbox — two clicks, no Back",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/mail", routes: mailRoutes(s) });
    const { page } = view;
    await inboxReady(page);
    await view.click(listRow(page, "Launch date").getByRole("link").first());
    await threadHeading(page, "Launch date").waitFor();
    await view.click(page.getByRole("button", { name: "Archive", exact: true }));
    await view.landedOn("/c/acme/mail");
    await inboxReady(page);
    await listRow(page, "Launch date").waitFor({ state: "detached" });
    assert.equal(view.clicks(), 2, "open + Archive; the list is where Archive leaves you");
    assert.deepEqual(
      view.writes.map((w) => `${w.path.split("/").slice(-2).join("/")} ${w.body.action}`),
      ["t-launch/actions archive"],
    );
    await page.close();
  },
);

await app.check(
  "Trash from a thread opened from a search returns to that search, not the Inbox",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/mail?q=acme", routes: mailRoutes(s) });
    const { page } = view;
    await listRow(page, "Acme API limits").waitFor();
    assert.equal(await listRow(page, "Launch date").count(), 0, "the search narrows the list");
    await view.click(listRow(page, "Acme API limits").getByRole("link").first());
    await threadHeading(page, "Acme API limits").waitFor();
    await view.click(page.getByRole("button", { name: "Move to trash", exact: true }));
    await view.landedOn("/c/acme/mail?q=acme");
    await listRow(page, "Acme renewal").waitFor();
    assert.equal(await listRow(page, "Acme API limits").count(), 0);
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check("Mark unread returns to the list and the thread stays unread", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/mail", routes: mailRoutes(s) });
  const { page } = view;
  await inboxReady(page);
  await view.click(listRow(page, "Invoice 1042 overdue").getByRole("link").first());
  await threadHeading(page, "Invoice 1042 overdue").waitFor();
  // Opening it marks it read, like every mail client.
  await view.click(page.getByRole("button", { name: "Mark unread", exact: true }));
  await view.landedOn("/c/acme/mail");
  await inboxReady(page);
  await page.waitForTimeout(500);
  const actions = view.writes.map((w) => w.body.action);
  assert.deepEqual(actions, ["markRead", "markUnread"], "nothing marks it read again");
  assert.equal(s.threads.find((t) => t.id === "t-invoice")?.unread, true);
  assert.equal(view.clicks(), 2);
  await page.close();
});

await app.check("Back from a thread opened by a link goes to the Inbox", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/mail/t/t-hiring", routes: mailRoutes(s) });
  const { page } = view;
  await threadHeading(page, "Hiring plan").waitFor();
  await view.click(page.getByRole("button", { name: "Back", exact: true }));
  await view.landedOn("/c/acme/mail");
  await inboxReady(page);
  await page.close();
});

await app.check(
  "keyboard: open with Enter, e archives and returns with the cursor on the next row",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/mail", routes: mailRoutes(s) });
    const { page } = view;
    await inboxReady(page);
    for (let i = 0; i < 2; i += 1) await page.keyboard.press("j");
    await cursorRow(page).filter({ hasText: "Launch date" }).waitFor();
    await page.keyboard.press("Enter");
    await threadHeading(page, "Launch date").waitFor();
    await page.keyboard.press("e");
    await view.landedOn("/c/acme/mail");
    await listRow(page, "Launch date").waitFor({ state: "detached" });
    // The row that took its place, not the top of the list.
    await cursorRow(page).filter({ hasText: "Acme API limits" }).waitFor();
    // Back again without acting: the cursor stays on the same thread.
    await page.keyboard.press("Enter");
    await threadHeading(page, "Acme API limits").waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await cursorRow(page).filter({ hasText: "Acme API limits" }).waitFor();
    assert.equal(view.clicks(), 0, "a keyboard triage needs no clicks at all");
    await page.close();
  },
);

await app.check("keyboard in a thread: s stars, # trashes, u marks unread", async () => {
  const s = store();
  const view = await app.open({ path: "/c/acme/mail/t/t-renewal", routes: mailRoutes(s) });
  const { page } = view;
  await threadHeading(page, "Acme renewal").waitFor();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "Unstar", exact: true }).first().waitFor();
  await page.keyboard.press("#");
  await view.landedOn("/c/acme/mail");
  const second = await app.open({ path: "/c/acme/mail/t/t-hiring", routes: mailRoutes(s) });
  await threadHeading(second.page, "Hiring plan").waitFor();
  await second.page.keyboard.press("u");
  await second.landedOn("/c/acme/mail");
  assert.deepEqual(
    [...view.writes, ...second.writes].map((w) => `${w.path.split("/").at(-2)} ${w.body.action}`),
    ["t-renewal star", "t-renewal trash", "t-hiring markUnread"],
  );
  await page.close();
  await second.page.close();
});

await app.check(
  "keyboard in a thread: r and a open the reply box with the cursor in it",
  async () => {
    const s = store();
    const view = await app.open({ path: "/c/acme/mail/t/t-renewal", routes: mailRoutes(s) });
    const { page } = view;
    await threadHeading(page, "Acme renewal").waitFor();
    await page.keyboard.press("r");
    const reply = page.getByPlaceholder("Write your reply…");
    await waitForFocus(reply, "r opens the reply box focused");
    assert.equal(await reply.inputValue(), "", "the r itself is not typed into the reply");
    await page.getByText("to priya@customer.example").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.keyboard.press("a");
    await waitForFocus(reply, "a opens reply-all focused");
    await page.getByRole("button", { name: "Reply only to sender", exact: true }).waitFor();
    // Typing in the reply never triggers the thread's keys.
    await page.keyboard.type("es#u");
    assert.equal(await reply.inputValue(), "es#u");
    assert.deepEqual(view.writes, []);
    await page.close();
  },
);

await app.check("the analysis card's Archive also returns to the list", async () => {
  const s = store();
  // The card shows the analysis of the newest inbound message.
  s.threads.find((row) => row.id === "t-launch")!.aiReview = {
    status: "reviewed",
    latestMessageId: "t-launch-m1",
    employee: null,
    updatedAt: hoursAgo(3),
  };
  s.analyses.set("t-launch", [
    {
      id: "analysis-1",
      threadId: "t-launch",
      messageId: "t-launch-m1",
      status: "succeeded",
      employeeId: null,
      modelId: null,
      category: "fyi",
      summary: "A reminder about the launch date. Nothing to do.",
      actions: [{ id: "archive-it", kind: "thread_action", label: "Archive", action: "archive" }],
      automaticActions: [],
      errorMessage: "",
      createdAt: hoursAgo(3),
      finishedAt: hoursAgo(3),
    },
  ]);
  const view = await app.open({ path: "/c/acme/mail", routes: mailRoutes(s) });
  const { page } = view;
  await inboxReady(page);
  await view.click(listRow(page, "Launch date").getByRole("link").first());
  await page.getByText("A reminder about the launch date. Nothing to do.").waitFor();
  await view.click(page.getByRole("button", { name: /^Archive/ }).last());
  await view.landedOn("/c/acme/mail");
  await listRow(page, "Launch date").waitFor({ state: "detached" });
  assert.equal(view.clicks(), 2);
  await page.close();
});

await app.check("Hand to AI starts on an employee who can draft, not a read-only one", async () => {
  const s = store();
  const grant = (id: string, name: string, accessLevel: MailGrant["accessLevel"]): MailGrant => ({
    id: `grant-${id}`,
    employeeId: id,
    accessLevel,
    createdAt: hoursAgo(10),
    employee: { id, name, slug: id, role: "Support", avatarKey: null },
  });
  // Oldest first, as the server lists them: the reader for AI analysis only reads.
  s.grants = [grant("reader", "Riley Reader", "read"), grant("sam", "Sam Okafor", "draft")];
  const view = await app.open({ path: "/c/acme/mail/t/t-renewal", routes: mailRoutes(s) });
  const { page } = view;
  await threadHeading(page, "Acme renewal").waitFor();
  await view.click(page.getByRole("button", { name: /Hand to AI/ }));
  const dialog = page.getByRole("dialog");
  const picker = dialog.locator("select").first();
  await page.waitForFunction(
    (select) => (select as HTMLSelectElement | null)?.value === "sam",
    await picker.elementHandle(),
  );
  const handOver = dialog.getByRole("button", { name: /^Hand over/ });
  await handOver.waitFor();
  assert.equal(await handOver.isDisabled(), false, "ready to hand over without re-picking");
  await page.close();
});

await app.check(
  "Edit from the Drafts queue opens that draft's editor, cursor in the message",
  async () => {
    const s = store();
    const t = s.threads.find((row) => row.id === "t-renewal")!;
    s.drafts.set(
      t.id,
      message(t, {
        id: "draft-1",
        isDraft: true,
        fromName: ME.name,
        fromEmail: ACCOUNT.address,
        toEmails: "priya@customer.example",
        subject: "Re: Acme renewal",
        bodyText: "Hi Priya, here are the renewal terms.",
        labelIds: ["DRAFT"],
        createdByUserId: ME.id,
      }),
    );
    const queued: MailDraft = {
      id: "draft-1",
      threadId: t.id,
      subject: "Re: Acme renewal",
      toEmails: "priya@customer.example",
      ccEmails: "",
      snippet: "Hi Priya, here are the renewal terms.",
      bodyPreview: "Hi Priya, here are the renewal terms.",
      hasAttachments: false,
      missingRecipient: false,
      queuedForSend: false,
      createdAt: hoursAgo(1),
      author: { kind: "member", member: { id: ME.id, name: ME.name, avatarKey: null } },
    };
    const routes: ApiRoute[] = [
      [
        "GET",
        `${API}/mail/accounts/mailbox/drafts`,
        () => ({
          drafts: [queued],
          nextOffset: null,
          facets: { employees: [], routines: [] },
          totals: { total: 1, sendable: 1, missingRecipient: 0, queued: 0 },
        }),
      ],
      ["GET", `${API}/mail/accounts/mailbox/drafts/send-queue`, () => ({ batch: null })],
      ...mailRoutes(s),
    ];
    const view = await app.open({ path: "/c/acme/mail?view=drafts", routes });
    const { page } = view;
    // Row actions appear on hover (or keyboard focus), as in the thread list.
    await page.locator("li", { hasText: "Re: Acme renewal" }).first().hover();
    await view.click(page.getByRole("button", { name: "Open for review", exact: true }).first());
    const drawer = page.getByRole("dialog");
    await view.click(drawer.getByRole("link", { name: /Edit/ }));
    await view.landedOn("/c/acme/mail/t/t-renewal");
    const body = page.getByLabel("Message", { exact: true });
    await waitForFocus(body, "the draft's editor is open with the cursor in it");
    assert.equal(await body.inputValue(), "Hi Priya, here are the renewal terms.");
    assert.equal(view.clicks(), 2, "Open for review, Edit: no second Edit click");
    await page.close();
  },
);

await app.check("phone width: the thread header's actions fit", async () => {
  const s = store();
  const view = await app.open({
    path: "/c/acme/mail/t/t-renewal",
    routes: mailRoutes(s),
    touch: true,
  });
  await threadHeading(view.page, "Acme renewal").waitFor();
  await noSidewaysScroll(view.page, "thread on a phone");
  await view.page.close();
});

await app.finish();
