/**
 * Real Chrome coverage for the Meetings agenda: an event opens in place to
 * everyone on the invite — address, reply, and their Contact when they are
 * one — and "Email attendees" writes to all of them, only to who is coming,
 * or only to who hasn't replied, from the company's mailbox, with
 * attachments, without leaving the page. Also: one attendee from their row,
 * the From picker, no mailbox connected, a link straight to an event, search,
 * and phone width. Only the API is a fixture.
 * Run with `npm run test:meetings-agenda`.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { MailAccount, MailMessage } from "../client/lib/mail";
import type { CalendarAccount, CalendarEvent } from "../client/lib/meetings";
import {
  API,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Meetings — the agenda, attendees and emailing them");

// ───────────────────────────── fixtures ─────────────────────────────

const ME_ADDRESS = "morgan@acme.example";

const CALENDAR: CalendarAccount = {
  id: "cal",
  connectionId: "conn",
  calendarId: "primary",
  address: ME_ADDRESS,
  displayName: "Morgan",
  timeZone: "America/New_York",
  status: "active",
  statusMessage: "",
  syncState: "succeeded",
  lastSyncAt: hoursAgo(0.2),
  syncStartedAt: hoursAgo(0.2),
  syncFinishedAt: hoursAgo(0.2),
  windowDays: 30,
  autoRecord: "off",
  notetakerEmployeeId: null,
  createdAt: hoursAgo(500),
};

function mailbox(id: string, address: string): MailAccount {
  return {
    id,
    connectionId: `conn-${id}`,
    provider: "gmail",
    address,
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
}

const MAILBOX = mailbox("mailbox", ME_ADDRESS);
const SALES = mailbox("sales", "sales@acme.example");

const attendee = (
  email: string,
  responseStatus: string,
  extra: Partial<CalendarEvent["attendees"][number]> = {},
) => ({
  email,
  displayName: "",
  responseStatus,
  organizer: false,
  optional: false,
  contactId: null,
  contactName: "",
  ...extra,
});

// Fixed at 09:00 UTC on Friday 9 October 2026, which is 05:00 in New York.
const REVIEW: CalendarEvent = {
  id: "evt-review",
  accountId: CALENDAR.id,
  summary: "Quarterly review with Northwind",
  description: "<p>Agenda:</p><ul><li>Renewal</li><li>Roadmap</li></ul>",
  location: "",
  startAt: "2026-10-09T15:00:00.000Z",
  endAt: "2026-10-09T16:00:00.000Z",
  allDay: false,
  status: "confirmed",
  organizerEmail: ME_ADDRESS,
  organizerName: "Morgan Lee",
  attendees: [
    attendee(ME_ADDRESS, "accepted", { organizer: true, displayName: "Morgan Lee" }),
    attendee("sam@northwind.test", "accepted", {
      contactId: "contact-sam",
      contactName: "Sam Rivera",
    }),
    attendee("priya@northwind.test", "declined", { displayName: "Priya Shah" }),
    attendee("lee@northwind.test", "needsAction"),
    attendee("kim@northwind.test", "tentative", { displayName: "Kim Park", optional: true }),
  ],
  conferenceProvider: "meet",
  conferenceUrl: "https://meet.google.com/abc-defg-hij",
  htmlLink: "https://calendar.google.com/calendar/event?eid=review",
  recurring: false,
  meeting: { id: "meeting-review", status: "scheduled" },
};

const FOCUS: CalendarEvent = {
  ...REVIEW,
  id: "evt-focus",
  summary: "Focus time",
  description: "",
  startAt: "2026-10-09T18:00:00.000Z",
  endAt: "2026-10-09T19:00:00.000Z",
  attendees: [],
  conferenceProvider: "none",
  conferenceUrl: "",
  htmlLink: "",
  meeting: null,
};

const NEXT_WEEK: CalendarEvent = {
  ...REVIEW,
  id: "evt-kickoff",
  summary: "Kickoff with Contoso",
  description: "",
  startAt: "2026-10-20T14:00:00.000Z",
  endAt: "2026-10-20T14:30:00.000Z",
  attendees: [attendee("ana@contoso.test", "accepted", { displayName: "Ana Ortiz" })],
  meeting: null,
};

type Store = { mailboxes: MailAccount[]; uploads: number };

function sentMessage(body: Record<string, unknown>): MailMessage {
  return {
    id: "m-sent",
    threadId: "t-sent",
    gmailMessageId: "gm-sent",
    isDraft: false,
    fromName: "",
    fromEmail: ME_ADDRESS,
    toEmails: String(body.to ?? ""),
    ccEmails: String(body.cc ?? ""),
    bccEmails: String(body.bcc ?? ""),
    subject: String(body.subject ?? ""),
    snippet: "",
    bodyText: String(body.bodyText ?? ""),
    bodyHtml: "",
    labelIds: ["SENT"],
    sentAt: hoursAgo(0),
    createdAt: hoursAgo(0),
    createdByUserId: "viewer",
    createdByEmployeeId: null,
    createdByRoutineId: null,
    createdByRunId: null,
    attachments: [],
  };
}

function routes(s: Store): ApiRoute[] {
  const mail = `${API}/mail`;
  return [
    [
      "GET",
      `${API}/meetings/events`,
      ({ url }) => {
        const from = new Date(url.searchParams.get("from") ?? 0).getTime();
        const to = new Date(url.searchParams.get("to") ?? 0).getTime();
        return {
          events: [REVIEW, FOCUS, NEXT_WEEK].filter(
            (event) =>
              new Date(event.startAt).getTime() < to && new Date(event.endAt).getTime() > from,
          ),
        };
      },
    ],
    ["GET", `${API}/meetings/calendars`, () => ({ calendars: [CALENDAR] })],
    ["GET", `${mail}/accounts`, () => ({ accounts: s.mailboxes })],
    ["POST", /\/mail\/accounts\/[^/]+\/recipient-check$/, () => ({ blocked: [] })],
    ["GET", /\/mail\/accounts\/[^/]+\/recipient-suggestions$/, () => ({ suggestions: [] })],
    [
      "POST",
      /\/mail\/accounts\/[^/]+\/outbox-attachments$/,
      () => {
        s.uploads += 1;
        return {
          attachment: {
            id: `att-${s.uploads}`,
            filename: "renewal-terms.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        };
      },
    ],
    ["POST", /\/mail\/accounts\/[^/]+\/send$/, ({ body }) => ({ message: sentMessage(body) })],
  ];
}

const store = (mailboxes: MailAccount[] = [MAILBOX]): Store => ({ mailboxes, uploads: 0 });

async function openAgenda(
  s: Store,
  extra: { path?: string; touch?: boolean; storage?: Record<string, string> } = {},
) {
  const view = await app.open({
    path: extra.path ?? "/c/acme/meetings",
    routes: routes(s),
    locale: "en-US",
    timezoneId: "America/New_York",
    touch: extra.touch,
    storage: extra.storage,
  });
  await view.page.getByRole("heading", { name: "Agenda", exact: true }).waitFor();
  return view;
}

const eventRow = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(title) }).first();
const attendees = (page: Page) => page.getByRole("region", { name: "Attendees" });
const chip = (page: Page, email: string) => page.locator(`[data-recipient="${email}"]`);
const dialog = (page: Page) => page.getByRole("dialog");

// ───────────────────────────── checks ─────────────────────────────

await app.check(
  "a row says who is invited and how they answered, before it is opened",
  async () => {
    const { page } = await openAgenda(store());
    const row = eventRow(page, "Quarterly review with Northwind");
    await row.waitFor();
    const text = (await row.textContent()) ?? "";
    assert.match(text, /11:00 AM/);
    assert.match(text, /1h/);
    assert.match(text, /5 invited/);
    assert.match(text, /2 accepted/);
    assert.match(text, /1 maybe/);
    assert.match(text, /1 awaiting reply/);
    assert.match(text, /1 declined/);
    assert.match(text, /Notetaker on/);
    assert.equal(await row.getAttribute("aria-expanded"), "false");
    await page.close();
  },
);

await app.check("open an event: every address, every reply, Contacts linked", async () => {
  const view = await openAgenda(store());
  const { page } = view;
  await view.click(eventRow(page, "Quarterly review with Northwind"));
  await view.landedOn("/c/acme/meetings?event=evt-review");
  const list = attendees(page);
  await list.waitFor();
  for (const address of [
    ME_ADDRESS,
    "sam@northwind.test",
    "priya@northwind.test",
    "lee@northwind.test",
    "kim@northwind.test",
  ]) {
    assert.ok(await list.getByText(address, { exact: true }).isVisible(), `${address} is listed`);
  }
  const text = (await list.textContent()) ?? "";
  for (const reply of [
    "Accepted",
    "Declined",
    "Awaiting reply",
    "Maybe",
    "Organizer",
    "Optional",
  ]) {
    assert.ok(text.includes(reply), `${reply} is shown`);
  }
  // Sam is a Contact: their name is the way to their page.
  assert.equal(
    await list.getByRole("link", { name: "Sam Rivera" }).getAttribute("href"),
    "/c/acme/revenue/contacts/contact-sam",
  );
  // The invite's HTML notes read as text.
  assert.ok(await page.getByText("• Renewal").isVisible());
  // Where to go from here.
  assert.equal(
    await page.getByRole("link", { name: "Open meeting" }).getAttribute("href"),
    "/c/acme/meetings/meeting-review",
  );
  // Filtering by reply.
  await view.click(list.getByRole("button", { name: /^Declined/ }));
  assert.ok(await list.getByText("priya@northwind.test").isVisible());
  assert.equal(await list.getByText("sam@northwind.test").count(), 0);
  await page.close();
});

await app.check(
  "Email attendees: everyone but you, the meeting underneath, a file attached, sent",
  async () => {
    const s = store();
    const view = await openAgenda(s);
    const { page } = view;
    await view.click(eventRow(page, "Quarterly review with Northwind"));
    await view.click(attendees(page).getByRole("button", { name: "Email attendees", exact: true }));
    const compose = dialog(page);
    await compose.getByRole("heading", { name: /New message/ }).waitFor();
    for (const address of [
      "sam@northwind.test",
      "priya@northwind.test",
      "lee@northwind.test",
      "kim@northwind.test",
    ]) {
      assert.ok(await chip(page, address).isVisible(), `${address} is a recipient`);
    }
    assert.equal(await chip(page, ME_ADDRESS).count(), 0, "the calendar's own address is left out");
    assert.equal(
      await compose.getByLabel("Subject").inputValue(),
      "Quarterly review with Northwind",
    );
    const body = await compose.getByLabel("Message").inputValue();
    assert.match(body, /^Hi all,/);
    assert.match(body, /Fri, Oct 9 · 11:00 AM – 12:00 PM/);
    assert.match(body, /Join: https:\/\/meet\.google\.com\/abc-defg-hij/);

    await compose.locator('input[type="file"]').setInputFiles({
      name: "renewal-terms.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 terms"),
    });
    await compose.getByText("renewal-terms.pdf").waitFor();
    await compose.getByLabel("Message").fill("Hi all,\n\nTerms attached ahead of today.");
    await view.click(compose.getByRole("button", { name: "Send", exact: true }));

    const sent = await view.waitForWrite((w) => w.path.endsWith("/mail/accounts/mailbox/send"));
    assert.deepEqual(
      String(sent.body.to)
        .split(",")
        .map((part) => part.trim())
        .sort(),
      ["kim@northwind.test", "lee@northwind.test", "priya@northwind.test", "sam@northwind.test"],
    );
    assert.deepEqual(sent.body.attachmentIds, ["att-1"]);
    assert.equal(sent.body.subject, "Quarterly review with Northwind");
    assert.equal(sent.body.bodyText, "Hi all,\n\nTerms attached ahead of today.");

    // Nothing on the page changed, so the send says so — with the way to the thread.
    await page.getByText("Email sent to 4 people.").waitFor();
    assert.equal(
      await page.getByRole("link", { name: "Open in Email" }).getAttribute("href"),
      "/c/acme/mail/t/t-sent",
    );
    assert.equal(await dialog(page).count(), 0);
    await page.close();
  },
);

await app.check("write only to who hasn't replied, or only to who is coming", async () => {
  const view = await openAgenda(store(), { path: "/c/acme/meetings?event=evt-review" });
  const { page } = view;
  await attendees(page).waitFor();
  await view.click(page.getByRole("button", { name: "Choose who to email" }));
  await view.click(page.getByRole("menuitem", { name: /Who hasn’t replied/ }));
  await dialog(page)
    .getByRole("heading", { name: /New message/ })
    .waitFor();
  assert.ok(await chip(page, "lee@northwind.test").isVisible());
  assert.equal(await chip(page, "sam@northwind.test").count(), 0);
  assert.equal(await chip(page, "priya@northwind.test").count(), 0);
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });

  await view.click(page.getByRole("button", { name: "Choose who to email" }));
  await view.click(page.getByRole("menuitem", { name: /Who accepted or said maybe/ }));
  await dialog(page)
    .getByRole("heading", { name: /New message/ })
    .waitFor();
  assert.ok(await chip(page, "sam@northwind.test").isVisible());
  assert.ok(await chip(page, "kim@northwind.test").isVisible());
  assert.equal(await chip(page, "lee@northwind.test").count(), 0);
  assert.equal(await chip(page, "priya@northwind.test").count(), 0);
  await page.close();
});

await app.check("email one attendee from their row, greeted by name", async () => {
  const view = await openAgenda(store(), { path: "/c/acme/meetings?event=evt-review" });
  const { page } = view;
  await view.click(attendees(page).getByRole("button", { name: "Email Priya Shah" }));
  const compose = dialog(page);
  await compose.getByRole("heading", { name: /New message/ }).waitFor();
  assert.ok(await chip(page, "priya@northwind.test").isVisible());
  assert.equal(await chip(page, "sam@northwind.test").count(), 0);
  assert.match(await compose.getByLabel("Message").inputValue(), /^Hi Priya,/);
  await page.close();
});

await app.check(
  "the row's own Email button writes to everyone without opening the row",
  async () => {
    const view = await openAgenda(store());
    const { page } = view;
    await view.click(
      page.getByRole("button", {
        name: "Email everyone invited to Quarterly review with Northwind",
      }),
    );
    await dialog(page)
      .getByRole("heading", { name: /New message/ })
      .waitFor();
    assert.ok(await chip(page, "lee@northwind.test").isVisible());
    assert.equal(view.clicks(), 1);
    // An event with nobody else on it offers no one to write to.
    assert.equal(
      await page.getByRole("button", { name: "Email everyone invited to Focus time" }).count(),
      0,
    );
    await page.close();
  },
);

await app.check("with two mailboxes, the one last used sends, and From can change it", async () => {
  const s = store([MAILBOX, SALES]);
  const view = await openAgenda(s, {
    path: "/c/acme/meetings?event=evt-review",
    storage: { "genosyn.mail.account.company": "sales" },
  });
  const { page } = view;
  await view.click(attendees(page).getByRole("button", { name: "Email attendees", exact: true }));
  const from = dialog(page).getByRole("combobox", { name: "From", exact: true });
  await from.waitFor();
  // The cursor is in the message, ready to write; the picker stays shut.
  await waitForFocus(dialog(page).getByLabel("Message"), "the message has focus");
  assert.equal(await from.getAttribute("aria-expanded"), "false");
  assert.equal(await from.inputValue(), SALES.address);
  await view.click(from);
  await view.click(page.getByRole("option", { name: ME_ADDRESS, exact: true }));
  assert.equal(await from.inputValue(), ME_ADDRESS);
  // Switching sender keeps what was already written.
  assert.ok(await chip(page, "sam@northwind.test").isVisible());
  await view.click(dialog(page).getByRole("button", { name: "Send", exact: true }));
  await view.waitForWrite((w) => w.path.endsWith("/mail/accounts/mailbox/send"));
  await page.close();
});

await app.check(
  "no mailbox connected: connect one, or hand the message to the mail app",
  async () => {
    const view = await openAgenda(store([]), { path: "/c/acme/meetings?event=evt-review" });
    const { page } = view;
    await view.click(attendees(page).getByRole("button", { name: "Email attendees", exact: true }));
    const box = dialog(page);
    await box.getByText("Connect a mailbox to send email from Genosyn").waitFor();
    const mailto =
      (await box.getByRole("link", { name: "Use my mail app" }).getAttribute("href")) ?? "";
    assert.match(
      mailto,
      /^mailto:sam@northwind\.test,priya@northwind\.test,lee@northwind\.test,kim@northwind\.test\?/,
    );
    assert.match(mailto, /subject=Quarterly%20review%20with%20Northwind/);
    assert.equal(
      await box.getByRole("link", { name: "Connect a mailbox" }).getAttribute("href"),
      "/c/acme/mail",
    );
    await page.close();
  },
);

await app.check("a link to an event opens its week with the event open", async () => {
  const view = await openAgenda(store(), {
    path: "/c/acme/meetings?date=2026-10-19&event=evt-kickoff",
  });
  const { page } = view;
  await attendees(page).getByText("ana@contoso.test", { exact: true }).waitFor();
  assert.equal(await eventRow(page, "Kickoff with Contoso").getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByText("Quarterly review with Northwind").count(), 0);
  // Back to this week.
  await view.click(page.getByRole("button", { name: "Today", exact: true }));
  await view.landedOn("/c/acme/meetings");
  await eventRow(page, "Quarterly review with Northwind").waitFor();
  await page.close();
});

await app.check("search finds an event by the people on it", async () => {
  const { page } = await openAgenda(store());
  await eventRow(page, "Focus time").waitFor();
  await page.getByLabel("Search the agenda").fill("priya");
  await page.getByRole("button", { name: /Focus time/ }).waitFor({ state: "detached" });
  assert.ok(await eventRow(page, "Quarterly review with Northwind").isVisible());
  await page.getByLabel("Search the agenda").fill("nobody-matches");
  await page.getByText("No events match").waitFor();
  await page.getByRole("button", { name: "Clear search" }).click();
  await eventRow(page, "Focus time").waitFor();
  await page.close();
});

await app.check("phone width: an open event and its composer fit", async () => {
  const view = await openAgenda(store(), {
    path: "/c/acme/meetings?event=evt-review",
    touch: true,
  });
  const { page } = view;
  await attendees(page).waitFor();
  await noSidewaysScroll(page, "the agenda with an event open");
  await app.shot(page, "meetings-agenda-phone");
  await view.click(attendees(page).getByRole("button", { name: "Email attendees", exact: true }));
  await dialog(page)
    .getByRole("heading", { name: /New message/ })
    .waitFor();
  await noSidewaysScroll(page, "the composer over the agenda");
  await page.close();
});

await app.check("desktop screenshot of an open event", async () => {
  const { page } = await openAgenda(store(), { path: "/c/acme/meetings?event=evt-review" });
  await attendees(page).waitFor();
  await app.shot(page, "meetings-agenda-desktop");
  await page.close();
});

await app.finish();
