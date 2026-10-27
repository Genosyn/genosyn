/**
 * Real Chrome coverage for writing email on the real App: To, Cc and Bcc as
 * editable chips in every composer (a reply, a forward, a saved draft, a new
 * message), recipients on the do-not-email list flagged before sending and
 * removed in one click, the mailbox's address book while typing, a forward
 * that keeps the original's attachments, an unsent reply that survives
 * leaving the thread, quoted history folded in a message, and scheduling a
 * meeting from an email — the AI's reading of the thread, the time zone, the
 * Meet link, the invitation, and the details going into the reply.
 * Only the API is a fixture. Run with `npm run test:mail-compose`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { MailAccount, MailAnalysis, MailMessage, MailThread } from "../client/lib/mail";
import type { MeetingProposalResult, ScheduledMeeting } from "../client/lib/mailMeetings";
import {
  API,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Email — composing, recipients and scheduling");

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

const FELIX = "felix.menzel@assense.com";
const DANA = "dana@assense.com";
const BLOCKED = "support@oneuptime.com";

const THREAD: MailThread = {
  id: "t-status",
  gmailThreadId: "g-status",
  accountId: ACCOUNT.id,
  subject: "Status page not updating",
  snippet: "The status page still shows the old incident.",
  participants: "Felix Menzel",
  labelIds: ["INBOX"],
  unread: false,
  messageCount: 1,
  hasAttachments: true,
  lastMessageAt: hoursAgo(2),
};

function inbound(changes: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m-felix",
    threadId: THREAD.id,
    gmailMessageId: "gm-felix",
    isDraft: false,
    fromName: "Felix Menzel",
    fromEmail: FELIX,
    toEmails: `Acme Support <${ACCOUNT.address}>`,
    ccEmails: `${BLOCKED}, Dana Lee <${DANA}>`,
    bccEmails: "",
    subject: THREAD.subject,
    snippet: THREAD.snippet,
    bodyText:
      "Hi,\nthe status page still shows the old incident.\nCan we go through it on a call? Tuesday at 3pm CET works for me.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Acme Support <support@acme.example> wrote:\n> This should be released.\n> Can you please check if you still face this.",
    bodyHtml: "",
    labelIds: ["INBOX"],
    sentAt: hoursAgo(2),
    createdAt: hoursAgo(2),
    createdByUserId: null,
    createdByEmployeeId: null,
    createdByRoutineId: null,
    createdByRunId: null,
    attachments: [
      { index: 0, filename: "incident.png", mimeType: "image/png", size: 52_000 },
      { index: 1, filename: "timeline.pdf", mimeType: "application/pdf", size: 120_000 },
    ],
    ...changes,
  };
}

const PROPOSAL: MeetingProposalResult = {
  proposal: {
    title: "Status page review",
    attendees: [{ email: FELIX, name: "Felix Menzel" }],
    start: "2026-10-13T15:00",
    timeZone: "Europe/Berlin",
    durationMinutes: 30,
    description: "Walk through the stale incident on the status page.",
    evidence: "Tuesday at 3pm CET works for me.",
    alternatives: [{ start: "2026-10-15T10:00", timeZone: "Europe/Berlin", evidence: null }],
    confidence: "agreed",
  },
  source: "ai",
  employee: { id: "sam", name: "Sam Okafor" },
  note: null,
};

type Store = {
  thread: MailThread;
  messages: MailMessage[];
  analyses: MailAnalysis[];
  blocked: Map<string, string>;
  addressBook: Array<{ email: string; name: string; count: number; lastAt: string | null }>;
  calendars: Array<{
    id: string;
    label: string;
    address: string;
    timeZone: string;
    isDefault: boolean;
  }>;
  busy: Array<{ start: string; end: string }>;
  proposalRequests: number;
};

function store(): Store {
  return {
    thread: { ...THREAD },
    messages: [inbound()],
    analyses: [],
    blocked: new Map([[BLOCKED, "Unsubscribed"]]),
    addressBook: [
      { email: "ana@northwind.example", name: "Ana Ruiz", count: 3, lastAt: hoursAgo(30) },
      { email: "ops@acme.example", name: "", count: 9, lastAt: hoursAgo(5) },
    ],
    calendars: [
      {
        id: "mailbox",
        label: ACCOUNT.address,
        address: ACCOUNT.address,
        timeZone: "Europe/Berlin",
        isDefault: true,
      },
    ],
    busy: [],
    proposalRequests: 0,
  };
}

function split(header: unknown): string[] {
  return String(header ?? "")
    .split(",")
    .map((entry) => (/<([^>]+)>/.exec(entry)?.[1] ?? entry).trim().toLowerCase())
    .filter(Boolean);
}

function routes(s: Store): ApiRoute[] {
  const mail = `${API}/mail`;
  return [
    ["GET", `${mail}/accounts`, () => ({ accounts: [ACCOUNT] })],
    [
      "GET",
      `${mail}/accounts/mailbox/labels`,
      () => ({ labels: [], counts: { inboxUnread: 0, drafts: 0, starred: 0 } }),
    ],
    ["GET", `${mail}/accounts/mailbox/threads`, () => ({ threads: [THREAD], nextBefore: null })],
    ["GET", `${mail}/accounts/mailbox/saved-searches`, () => ({ savedSearches: [] })],
    ["GET", `${mail}/accounts/mailbox/grants`, () => ({ direct: [] })],
    [
      "GET",
      `${mail}/threads/${THREAD.id}`,
      () => ({
        thread: s.thread,
        account: { id: ACCOUNT.id, address: ACCOUNT.address },
        messages: s.messages,
        handovers: [],
        analyses: s.analyses,
        reviewTimeline: { events: [], truncated: false },
      }),
    ],
    ["POST", `${mail}/threads/${THREAD.id}/actions`, () => ({ thread: s.thread })],
    [
      "POST",
      `${mail}/accounts/mailbox/recipient-check`,
      ({ body }) => ({
        blocked: [...split(body.to), ...split(body.cc), ...split(body.bcc)]
          .filter((email) => s.blocked.has(email))
          .map((email) => ({ email, reason: "suppressed", detail: s.blocked.get(email) })),
      }),
    ],
    [
      "GET",
      `${mail}/accounts/mailbox/recipient-suggestions`,
      ({ url }) => {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return {
          suggestions: s.addressBook.filter(
            (row) => row.email.startsWith(q) || row.name.toLowerCase().startsWith(q),
          ),
        };
      },
    ],
    [
      "POST",
      `${mail}/accounts/mailbox/send`,
      ({ body }) => ({ message: inbound({ id: "m-sent", bodyText: String(body.bodyText) }) }),
    ],
    [
      "POST",
      `${mail}/accounts/mailbox/drafts`,
      ({ body }) => ({
        message: inbound({ id: "m-draft", isDraft: true, bodyText: String(body.bodyText) }),
      }),
    ],
    [
      "PATCH",
      /^\/api\/companies\/company\/mail\/drafts\/([^/]+)$/,
      ({ body, match }) => {
        const draft = s.messages.find((row) => row.id === match[1])!;
        Object.assign(draft, {
          toEmails: String(body.to ?? ""),
          ccEmails: String(body.cc ?? ""),
          bccEmails: String(body.bcc ?? ""),
          bodyText: String(body.bodyText ?? draft.bodyText),
        });
        return { message: draft };
      },
    ],
    [
      "GET",
      `${mail}/accounts/mailbox/scheduling-calendars`,
      () => ({
        calendars: s.calendars,
        setupHint:
          s.calendars.length === 0
            ? "Connect a Google calendar under Meetings → Calendars, or reconnect this mailbox's Google account with Calendar access."
            : null,
      }),
    ],
    [
      "POST",
      `${mail}/threads/${THREAD.id}/meeting-proposal`,
      () => {
        s.proposalRequests += 1;
        return PROPOSAL;
      },
    ],
    ["POST", `${mail}/accounts/mailbox/meetings/availability`, () => ({ busy: s.busy })],
    [
      "POST",
      `${mail}/accounts/mailbox/meetings`,
      ({ body }): { meeting: ScheduledMeeting } => ({
        meeting: {
          eventId: "evt-1",
          calendarId: String(body.calendarId),
          htmlLink: "https://calendar.google.com/calendar/event?eid=evt-1",
          meetLink: body.addMeet ? "https://meet.google.com/abc-defg-hij" : null,
          title: String(body.title),
          // 15:00 Europe/Berlin on 2026-10-13 is 13:00 UTC.
          start: "2026-10-13T13:00:00.000Z",
          end: "2026-10-13T13:30:00.000Z",
          timeZone: String(body.timeZone),
          attendees: (body.attendees as Array<{ email: string }>).map((row) => row.email),
          invitesSent: Boolean(body.sendInvites),
        },
      }),
    ],
    ["GET", `${API}/employees`, () => []],
  ];
}

const chip = (page: Page, email: string) => page.locator(`[data-recipient="${email}"]`);
const field = (page: Page, name: "To" | "Cc" | "Bcc") =>
  page.getByRole("combobox", { name: `${name} recipients`, exact: true });
const replyBox = (page: Page) => page.getByRole("textbox", { name: "Your message", exact: true });
const nonReads = (writes: Array<{ path: string }>) =>
  writes.filter((w) => !w.path.endsWith("/recipient-check") && !w.path.endsWith("/availability"));

async function openThread(
  s: Store,
  extra: { touch?: boolean; storage?: Record<string, string> } = {},
) {
  const view = await app.open({
    path: `/c/acme/mail/t/${THREAD.id}`,
    routes: routes(s),
    locale: "en-US",
    timezoneId: "America/New_York",
    ...extra,
  });
  await view.page.getByRole("heading", { name: THREAD.subject, exact: true }).waitFor();
  return view;
}

// ───────────────────────────── recipients ─────────────────────────────

await app.check(
  "Reply all: everyone is a chip, the do-not-email Cc is flagged and removed in one click",
  async () => {
    const s = store();
    const view = await openThread(s);
    const { page } = view;
    await page.keyboard.press("a");
    await waitForFocus(replyBox(page), "a opens Reply all with the cursor in the message");
    await chip(page, FELIX).getByText("Felix Menzel").waitFor();
    await chip(page, DANA).getByText("Dana Lee").waitFor();
    // The mailbox never copies itself.
    assert.equal(await chip(page, ACCOUNT.address).count(), 0);
    // The blocked address turns red and says why before anyone presses Send.
    await page.locator(`[data-recipient="${BLOCKED}"][data-flagged="true"]`).waitFor();
    const alert = page.getByRole("alert").filter({ hasText: BLOCKED });
    await alert.getByText("Unsubscribed").waitFor();
    await page.waitForTimeout(400); // let the dialog finish fading in
    await app.shot(page, "mail-compose-reply-all-flagged");
    await view.click(alert.getByRole("button", { name: "Remove", exact: true }));
    await chip(page, BLOCKED).waitFor({ state: "detached" });
    await alert.waitFor({ state: "detached" });

    await replyBox(page).fill("Thanks Felix — this is fixed now.");
    await page.keyboard.press("ControlOrMeta+Enter");
    const sent = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/send"));
    assert.equal(sent.body.to, `Felix Menzel <${FELIX}>`);
    assert.equal(sent.body.cc, `Dana Lee <${DANA}>`);
    assert.equal(sent.body.bcc, undefined);
    assert.equal(sent.body.threadId, THREAD.id);
    assert.equal(sent.body.subject, `Re: ${THREAD.subject}`);
    const text = String(sent.body.bodyText);
    assert.match(
      text,
      /^Thanks Felix — this is fixed now\.\n\nOn .* Felix Menzel <felix\.menzel@assense\.com> wrote:\n> Hi,\n/,
    );
    assert.equal(view.clicks(), 1, "one click to take the blocked address off; ⌘↵ sends");
    await replyBox(page).waitFor({ state: "detached" });
    await page.close();
  },
);

await app.check("add from the address book, type a Cc, move someone to Bcc", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  await page.keyboard.press("r");
  await waitForFocus(replyBox(page));
  // Bcc stays folded until asked for.
  assert.equal(await field(page, "Bcc").count(), 0);
  await view.click(page.getByRole("button", { name: "Add Bcc recipients", exact: true }));
  await waitForFocus(field(page, "Bcc"));
  await page.keyboard.type("ana");
  await page.getByRole("option", { name: /Ana Ruiz/ }).waitFor();
  await page.keyboard.press("Enter");
  await chip(page, "ana@northwind.example").getByText("Ana Ruiz").waitFor();

  await view.click(page.getByRole("button", { name: "Add Cc recipients", exact: true }));
  await waitForFocus(field(page, "Cc"));
  await page.keyboard.type("ops@acme.example, ");
  await chip(page, "ops@acme.example").waitFor();

  // Adding Felix to Bcc takes him off To: nobody is on an email twice.
  await field(page, "Bcc").fill(`${FELIX} `);
  await page.locator(`[data-recipient="${FELIX}"]`).first().waitFor();
  assert.equal(await chip(page, FELIX).count(), 1);
  await field(page, "To").fill("dana@assense.com ");
  await replyBox(page).fill("Looping in the team.");
  await view.click(page.getByRole("button", { name: /^Send/ }));
  const sent = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/send"));
  assert.equal(sent.body.to, DANA);
  assert.equal(sent.body.cc, "ops@acme.example");
  assert.equal(sent.body.bcc, `Ana Ruiz <ana@northwind.example>, ${FELIX}`);
  await page.close();
});

await app.check("an invalid recipient keeps the reply open and says what to fix", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  await page.keyboard.press("r");
  await waitForFocus(replyBox(page));
  await field(page, "To").fill("felix at assense");
  await replyBox(page).fill("Hello");
  await page.getByRole("button", { name: /^Send/ }).click();
  await page
    .getByText("“felix at assense” isn’t a valid email address. Fix or remove it.")
    .waitFor();
  assert.deepEqual(nonReads(view.writes), [], "nothing was sent");
  await page.close();
});

// ───────────────────────────── forward / drafts / new message ─────────────────────────────

await app.check("Forward keeps the original's attachments, each removable", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Forward", exact: true }).first());
  await waitForFocus(field(page, "To"), "a forward starts in To");
  assert.equal(
    await page.getByRole("textbox", { name: "Subject", exact: true }).inputValue(),
    `Fwd: ${THREAD.subject}`,
  );
  const composer = page.getByRole("group", { name: "Forward", exact: true });
  await composer.getByText("incident.png").waitFor();
  await composer.getByText("timeline.pdf").waitFor();
  await view.click(
    composer.getByRole("button", { name: "Don’t forward incident.png", exact: true }),
  );
  await composer.getByText("incident.png").waitFor({ state: "detached" });
  // Removing the file keeps the cursor where it was, inside the composer.
  assert.equal(
    await composer.evaluate((node) => node.contains(document.activeElement)),
    true,
    "focus stays in the composer",
  );
  // And with focus on one of the composer's own buttons, a letter never
  // fires a thread shortcut (e would archive the conversation).
  await composer.getByRole("button", { name: "Save draft", exact: true }).focus();
  await page.keyboard.press("e");
  await page.keyboard.press("s");
  assert.deepEqual(nonReads(view.writes), [], "no archive, no star");
  await field(page, "To").click();
  await page.keyboard.type("ops@acme.example");
  // Tab finishes the address (the open suggestion list sits over the message).
  await page.keyboard.press("Tab");
  await chip(page, "ops@acme.example").waitFor();
  // The note goes above the forwarded block, where the box leaves room for it.
  await replyBox(page).focus();
  await replyBox(page).evaluate((box) => (box as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.keyboard.type("FYI — see the timeline.");
  await view.click(page.getByRole("button", { name: /^Send/ }));
  const sent = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/send"));
  assert.equal(sent.body.to, "ops@acme.example");
  assert.deepEqual(sent.body.forwardFrom, { messageId: "m-felix", attachmentIndexes: [1] });
  assert.match(String(sent.body.bodyText), /^FYI — see the timeline\./);
  assert.match(
    String(sent.body.bodyText),
    /---------- Forwarded message ----------\nFrom: Felix Menzel/,
  );
  await page.close();
});

await app.check("an unsent reply survives leaving the thread, and can be resumed", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  await page.keyboard.press("r");
  await replyBox(page).fill("Half-written answer");
  // Closing keeps it, offered back at once.
  await page.getByRole("button", { name: "Close the reply", exact: true }).click();
  await page.getByText(/Unsent reply: Half-written answer/).waitFor();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  assert.equal(await replyBox(page).inputValue(), "Half-written answer");
  // And leaving the conversation keeps it too.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await view.landedOn("/c/acme/mail");
  await page
    .getByRole("link", { name: /Status page not updating/ })
    .first()
    .click();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await page.getByText(/Unsent reply: Half-written answer/).waitFor();
  await resume.click();
  assert.equal(await replyBox(page).inputValue(), "Half-written answer");
  await page.getByRole("button", { name: /^Discard/ }).click();
  await replyBox(page).waitFor({ state: "detached" });
  await page.getByText(/Unsent reply/).waitFor({ state: "detached" });
  assert.deepEqual(nonReads(view.writes), []);
  await page.close();
});

await app.check(
  "what you wrote survives switching Reply, Reply all and Forward, and a fresh r",
  async () => {
    const s = store();
    const view = await openThread(s);
    const { page } = view;
    await page.keyboard.press("r");
    await replyBox(page).fill("Looking into it now.");
    // Forward from the message itself: the words come along above the forwarded block.
    await page.getByRole("button", { name: "Forward", exact: true }).first().click();
    await page.getByRole("group", { name: "Forward", exact: true }).waitFor();
    assert.match(
      await replyBox(page).inputValue(),
      /^Looking into it now\.\n\n---------- Forwarded message/,
    );
    // And back to Reply all from the menu: still there, without the forwarded block.
    await page.getByRole("button", { name: "Forward — change", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reply all" }).click();
    await chip(page, DANA).waitFor();
    assert.equal(await replyBox(page).inputValue(), "Looking into it now.");
    // Close it, then start again with r: the unsent words are picked up, not wiped.
    await page.getByRole("button", { name: "Close the reply", exact: true }).click();
    await page.getByText(/Unsent reply all: Looking into it now\./).waitFor();
    await page.keyboard.press("r");
    await waitForFocus(replyBox(page));
    assert.equal(await replyBox(page).inputValue(), "Looking into it now.");
    await page.waitForTimeout(600);
    await page.reload();
    await page.getByRole("heading", { name: THREAD.subject, exact: true }).waitFor();
    await page.getByText(/Unsent reply: Looking into it now\./).waitFor();
    await page.close();
  },
);

await app.check("the page itself never scrolls behind the composer or the scheduler", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  const pageScrolls = () =>
    page.evaluate(() => document.scrollingElement!.scrollHeight > innerHeight + 1);
  await page.keyboard.press("a");
  await waitForFocus(replyBox(page));
  assert.equal(await pageScrolls(), false, "only the thread scrolls, not the shell");
  await page.getByRole("button", { name: "Schedule meeting", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Schedule a meeting" })
    .getByText("Read by Sam Okafor")
    .waitFor();
  assert.equal(await pageScrolls(), false);
  assert.equal(await page.evaluate(() => document.scrollingElement!.scrollTop), 0);
  await page.close();
});

await app.check("a saved draft's To, Cc and Bcc are all editable", async () => {
  const s = store();
  s.messages.push(
    inbound({
      id: "m-draft-1",
      isDraft: true,
      fromName: "",
      fromEmail: ACCOUNT.address,
      toEmails: FELIX,
      ccEmails: DANA,
      bodyText: "Draft answer",
      labelIds: ["DRAFT"],
      attachments: [],
    }),
  );
  const view = await openThread(s);
  const { page } = view;
  const main = page.getByRole("main");
  await view.click(main.getByRole("button", { name: "Edit", exact: true }));
  await main.getByRole("button", { name: `Remove ${DANA}`, exact: true }).click();
  await main.getByRole("button", { name: "Add Bcc recipients", exact: true }).click();
  await main
    .getByRole("combobox", { name: "Bcc recipients", exact: true })
    .fill("audit@acme.example");
  await main.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await view.waitForWrite((w) => w.method === "PATCH");
  assert.equal(saved.body.to, FELIX);
  assert.equal(saved.body.cc, "");
  assert.equal(saved.body.bcc, "audit@acme.example");
  await page.close();
});

await app.check("New message: chips for To and Bcc, ⌘↵ sends", async () => {
  const s = store();
  const view = await app.open({
    path: "/c/acme/mail",
    routes: routes(s),
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  const { page } = view;
  await page
    .getByRole("link", { name: /Status page not updating/ })
    .first()
    .waitFor();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog");
  await waitForFocus(dialog.getByRole("combobox", { name: "To recipients", exact: true }));
  await page.keyboard.type("ana");
  await page.getByRole("option", { name: /Ana Ruiz/ }).click();
  await dialog.getByRole("button", { name: "Add Bcc recipients", exact: true }).click();
  await waitForFocus(dialog.getByRole("combobox", { name: "Bcc recipients", exact: true }));
  await page.keyboard.type(`${BLOCKED} `);
  await dialog.locator(`[data-recipient="${BLOCKED}"][data-flagged="true"]`).waitFor();
  await dialog.getByLabel("Subject", { exact: true }).fill("Quarterly check-in");
  await dialog.getByLabel("Message", { exact: true }).fill("Hi Ana, shall we catch up?");
  await page.keyboard.press("ControlOrMeta+Enter");
  await dialog.getByText("Remove the recipients who can’t be emailed first.").waitFor();
  assert.deepEqual(nonReads(view.writes), [], "the blocked Bcc stopped the send");
  await dialog.getByRole("button", { name: `Remove ${BLOCKED}`, exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  const sent = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/send"));
  assert.equal(sent.body.to, "Ana Ruiz <ana@northwind.example>");
  assert.equal(sent.body.bcc, undefined);
  assert.equal(sent.body.subject, "Quarterly check-in");
  await page.close();
});

await app.check("quoted history is folded under a message until asked for", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  const main = page.getByRole("main");
  await main.getByText("Tuesday at 3pm CET works for me.", { exact: false }).waitFor();
  assert.equal(await main.getByText("This should be released.", { exact: false }).count(), 0);
  await main.getByRole("button", { name: "Show quoted history" }).click();
  await main.getByText("> This should be released.", { exact: false }).waitFor();
  await page.close();
});

// ───────────────────────────── scheduling ─────────────────────────────

await app.check(
  "Schedule: the AI's agreed time, zone and guest; the invite goes out with Meet; details go into the reply",
  async () => {
    const s = store();
    const view = await openThread(s);
    const { page } = view;
    await view.click(page.getByRole("button", { name: /^Schedule/ }).first());
    const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
    await dialog.getByText("Read by Sam Okafor").waitFor();
    await dialog.getByText("“Tuesday at 3pm CET works for me.”").waitFor();
    assert.equal(
      await dialog.getByLabel("Title", { exact: true }).inputValue(),
      "Status page review",
    );
    assert.equal(await dialog.getByLabel("Date", { exact: true }).inputValue(), "2026-10-13");
    assert.equal(await dialog.getByLabel("Start time", { exact: true }).inputValue(), "15:00");
    // The searchable selects show labels: the zone by city and its name that day.
    assert.match(
      await dialog.getByLabel("Time zone", { exact: true }).inputValue(),
      /^Berlin \((CEST|GMT\+2)\)$/,
    );
    assert.equal(await dialog.getByLabel("Duration", { exact: true }).inputValue(), "30 min");
    // And the slot in the reader's own zone, New York.
    await dialog.getByText(/9:00\s*–\s*9:30\s*AM (EDT|GMT-4) for you/).waitFor();
    await dialog.locator(`[data-recipient="${FELIX}"]`).waitFor();
    assert.equal(
      await dialog
        .getByRole("checkbox", { name: "Add a Google Meet link", exact: true })
        .isChecked(),
      true,
    );
    await dialog
      .getByText(/Tue, Oct 13, 3:00\s*–\s*3:30\s*PM/)
      .first()
      .waitFor();
    await page.waitForTimeout(400); // let the dialog finish fading in
    await app.shot(page, "mail-compose-schedule-meeting");
    await view.click(dialog.getByRole("button", { name: /Send invite/ }));
    const scheduled = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/meetings"));
    assert.deepEqual(scheduled.body, {
      calendarId: "mailbox",
      title: "Status page review",
      description: "Walk through the stale incident on the status page.",
      start: "2026-10-13T15:00",
      timeZone: "Europe/Berlin",
      durationMinutes: 30,
      attendees: [{ email: FELIX, name: "Felix Menzel" }],
      addMeet: true,
      sendInvites: true,
      threadId: THREAD.id,
    });
    const done = page.getByRole("dialog", { name: "Invite sent" });
    await done.getByRole("link", { name: "meet.google.com/abc-defg-hij" }).waitFor();
    await page.waitForTimeout(400); // let the dialog finish fading in
    await app.shot(page, "mail-compose-invite-sent");
    await view.click(done.getByRole("button", { name: "Add details to reply", exact: true }));
    await replyBox(page).waitFor();
    await page.waitForTimeout(400); // let the dialog finish fading in
    await app.shot(page, "mail-compose-invite-in-reply");
    const text = await replyBox(page).inputValue();
    assert.match(
      text,
      /^I've sent a calendar invite for Tue, Oct 13, 3:00\s*–\s*3:30\s*PM (GMT\+2|CEST)\.\nGoogle Meet: https:\/\/meet\.google\.com\/abc-defg-hij$/,
    );
    // Reply all, so everyone on the thread hears about it.
    await chip(page, FELIX).waitFor();
    assert.equal(view.clicks(), 3, "Schedule, Send invite, Add details to reply");
    assert.equal(s.proposalRequests, 1);
    await page.close();
  },
);

await app.check("Schedule: an alternative time from the thread is one click", async () => {
  const s = store();
  const view = await openThread(s);
  const { page } = view;
  await page
    .getByRole("button", { name: /^Schedule/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
  await dialog.getByText("Also mentioned:").waitFor();
  await dialog.getByRole("button", { name: /Thu, Oct 15, 10:00/ }).click();
  assert.equal(await dialog.getByLabel("Date", { exact: true }).inputValue(), "2026-10-15");
  assert.equal(await dialog.getByLabel("Start time", { exact: true }).inputValue(), "10:00");
  await page.close();
});

await app.check(
  "Schedule: a busy slot is called out, and a do-not-email guest blocks the invite",
  async () => {
    const s = store();
    s.busy = [{ start: "2026-10-13T12:45:00.000Z", end: "2026-10-13T13:15:00.000Z" }];
    const view = await openThread(s);
    const { page } = view;
    await page
      .getByRole("button", { name: /^Schedule/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
    await dialog.getByText("Read by Sam Okafor").waitFor();
    await dialog.getByText(/already has something at this time/).waitFor();
    const guests = dialog.getByRole("combobox", { name: "Guests", exact: true });
    await guests.fill(`${BLOCKED} `);
    await dialog.locator(`[data-recipient="${BLOCKED}"][data-flagged="true"]`).waitFor();
    await dialog.getByRole("button", { name: /Send invite/ }).click();
    await dialog.getByText("Remove the guests who can’t be emailed first.").first().waitFor();
    assert.equal(
      view.writes.filter((w) => w.path.endsWith("/accounts/mailbox/meetings")).length,
      0,
      "nothing was scheduled",
    );
    await page.close();
  },
);

await app.check("Schedule with no calendar connected says where to connect one", async () => {
  const s = store();
  s.calendars = [];
  const view = await openThread(s);
  const { page } = view;
  await page
    .getByRole("button", { name: /^Schedule/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
  await dialog.getByText("No calendar to schedule on yet").waitFor();
  await dialog.getByRole("link", { name: "Open Meetings → Calendars" }).click();
  await view.landedOn("/c/acme/meetings/calendars");
  await page.close();
});

await app.check(
  "the AI analysis's Schedule button opens the scheduler filled in, without asking the AI again",
  async () => {
    const s = store();
    s.analyses = [
      {
        id: "analysis-1",
        threadId: THREAD.id,
        messageId: "m-felix",
        status: "succeeded",
        employeeId: "sam",
        modelId: null,
        category: "scheduling",
        summary: "Felix wants a call about the stale status page; Tuesday 3pm CET works for him.",
        actions: [
          {
            id: "0",
            kind: "schedule_meeting",
            label: "Schedule the call",
            title: "Status page call",
            start: "2026-10-13T15:00",
            timeZone: "Europe/Berlin",
            durationMinutes: 45,
            attendees: [FELIX],
            targetTo: FELIX,
          },
        ],
        automaticActions: [],
        errorMessage: "",
        createdAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
      },
    ];
    // The card shows the analysis of the newest inbound message.
    s.thread.aiReview = {
      status: "reviewed",
      latestMessageId: "m-felix",
      employee: null,
      updatedAt: hoursAgo(2),
    };
    const view = await openThread(s);
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Schedule the call/ }));
    const dialog = page.getByRole("dialog", { name: "Schedule a meeting" });
    assert.equal(
      await dialog.getByLabel("Title", { exact: true }).inputValue(),
      "Status page call",
    );
    assert.equal(await dialog.getByLabel("Duration", { exact: true }).inputValue(), "45 min");
    await dialog.locator(`[data-recipient="${FELIX}"]`).waitFor();
    await view.click(dialog.getByRole("button", { name: /Send invite/ }));
    const scheduled = await view.waitForWrite((w) => w.path.endsWith("/accounts/mailbox/meetings"));
    assert.deepEqual(scheduled.body.analysisAction, { analysisId: "analysis-1", actionId: "0" });
    assert.equal(scheduled.body.durationMinutes, 45);
    assert.equal(s.proposalRequests, 0, "the analysis already read the email");
    await page.close();
  },
);

await app.check("phone width: the reply composer and the scheduler fit", async () => {
  const s = store();
  const view = await openThread(s, { touch: true });
  const { page } = view;
  await noSidewaysScroll(page, "thread on a phone");
  await page.getByRole("button", { name: "Reply all", exact: true }).last().click();
  await chip(page, FELIX).waitFor();
  await noSidewaysScroll(page, "reply all on a phone");
  await page.getByRole("button", { name: "Close the reply", exact: true }).click();
  await page
    .getByRole("button", { name: /^Schedule/ })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Schedule a meeting" })
    .getByText("Read by Sam Okafor")
    .waitFor();
  await noSidewaysScroll(page, "scheduler on a phone");
  await page.close();
});

await app.finish();
