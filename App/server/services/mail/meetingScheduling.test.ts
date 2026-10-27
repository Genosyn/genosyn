import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { CompanyPolicy } from "../../db/entities/CompanyPolicy.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Suppression } from "../../db/entities/Suppression.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import { encryptConnectionConfig } from "../integrations.js";
import { parseAnalysisActions } from "./analysis.js";
import {
  MeetingSchedulingError,
  SCHEDULING_SETUP_HINT,
  calendarAvailability,
  inviteList,
  listSchedulingCalendars,
  meetLinkOf,
  scheduleMeeting,
  type MeetingSchedulingDependencies,
  type ScheduleMeetingInput,
} from "./meetingScheduling.js";
import { mailReviewTimeline } from "./reviewTimeline.js";

/**
 * Scheduling a meeting from an email, against a fake Google Calendar.
 *
 * What reaches Google is the contract that matters — the wall time and zone
 * (daylight saving included), the Meet request, whether invitations go out,
 * the guest list — so every request is recorded and its URL and body are
 * asserted. Equally pinned: a guest the company must not email stops the
 * whole thing before Google hears of it, and calendars a consent cannot write
 * to are never offered.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const SELF = "owner@oneuptime.example";
const WRITE_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar";
const READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly";
const NOW = new Date("2026-10-20T08:00:00Z");

let companyId: string;
let connection: IntegrationConnection;
let account: MailAccount;

async function googleConnection(scope = WRITE_SCOPE, email = SELF): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId,
    provider: "google",
    label: "Google",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      { accessToken: "live-token", expiresAt: Date.now() + 3_600_000, email, scope },
      companyId,
    ),
    accountHint: email,
    status: "connected",
    statusMessage: "",
  });
}

async function calendar(
  values: Partial<CalendarAccount> & Pick<CalendarAccount, "connectionId">,
): Promise<CalendarAccount> {
  return insert(CalendarAccount, {
    companyId,
    calendarId: "primary",
    address: SELF,
    displayName: SELF,
    timeZone: "Europe/Berlin",
    status: "active",
    ...values,
  });
}

beforeEach(async () => {
  companyId = testCompanyId();
  connection = await googleConnection();
  account = await insert(MailAccount, {
    companyId,
    connectionId: connection.id,
    provider: "gmail",
    address: SELF,
    status: "active",
  });
});

type Recorded = { method: string; url: URL; headers: Record<string, string>; body: unknown };

/** A Google Calendar that answers from a script and records every request. */
function fakeGoogle(answer: (request: Recorded, index: number) => Response | Promise<Response>): {
  calls: Recorded[];
  sleeps: number[];
  dependencies: MeetingSchedulingDependencies;
} {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(request);
    return answer(request, calls.length - 1);
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    dependencies: {
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
    },
  };
}

function created(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: "evt_123",
    htmlLink: "https://www.google.com/calendar/event?eid=evt_123",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    status: "confirmed",
    start: { dateTime: "2026-11-03T15:00:00+01:00", timeZone: "Europe/Berlin" },
    end: { dateTime: "2026-11-03T15:45:00+01:00", timeZone: "Europe/Berlin" },
    summary: "Status page rollout",
    attendees: [{ email: "felix@assense.example" }],
    ...overrides,
  });
}

function input(overrides: Partial<ScheduleMeetingInput> = {}): ScheduleMeetingInput {
  return {
    calendarId: "mailbox",
    title: "Status page rollout",
    description: "Walk through the plan.",
    start: "2026-11-03T15:00",
    timeZone: "Europe/Berlin",
    durationMinutes: 45,
    attendees: [
      { email: "Felix@Assense.example", name: "Felix Menzel" },
      { email: "anna@assense.example" },
    ],
    addMeet: true,
    sendInvites: true,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<MeetingSchedulingError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MeetingSchedulingError, String(error));
    return error;
  }
  assert.fail("expected a MeetingSchedulingError");
}

describe("calendars a mailbox can schedule on", () => {
  test("offers the mailbox's own Google calendar when its consent can write events", async () => {
    assert.deepEqual(await listSchedulingCalendars(account), {
      calendars: [{ id: "mailbox", label: SELF, address: SELF, timeZone: "", isDefault: true }],
      setupHint: null,
    });
  });

  test("offers nothing, with the way to fix it, when no consent can write events", async () => {
    await AppDataSource.getRepository(IntegrationConnection).update(
      { id: connection.id },
      {
        encryptedConfig: encryptConnectionConfig(
          { accessToken: "t", expiresAt: Date.now() + 3_600_000, email: SELF, scope: READ_SCOPE },
          companyId,
        ),
      },
    );
    const readOnly = await googleConnection(READ_SCOPE, "team@oneuptime.example");
    await calendar({ connectionId: readOnly.id, address: "team@oneuptime.example" });
    assert.deepEqual(await listSchedulingCalendars(account), {
      calendars: [],
      setupHint: SCHEDULING_SETUP_HINT,
    });
  });

  test("an IMAP mailbox offers only calendars connected under Meetings", async () => {
    const imap = await insert(MailAccount, {
      companyId,
      connectionId: `connection_${randomUUID()}`,
      provider: "imap",
      address: "ops@oneuptime.example",
      status: "active",
    });
    assert.equal((await listSchedulingCalendars(imap)).calendars.length, 0);
    const team = await googleConnection(WRITE_SCOPE, "team@oneuptime.example");
    const shared = await calendar({
      connectionId: team.id,
      calendarId: "sales@group.calendar.google.com",
      address: "team@oneuptime.example",
      displayName: "Sales calls",
      timeZone: "America/New_York",
    });
    assert.deepEqual((await listSchedulingCalendars(imap)).calendars, [
      {
        id: `calendar:${shared.id}`,
        label: "Sales calls",
        address: "team@oneuptime.example",
        timeZone: "America/New_York",
        isDefault: true,
      },
    ]);
  });

  test("lists a calendar Meetings already mirrors once, as that calendar, and defaults to it", async () => {
    const mirrored = await calendar({ connectionId: connection.id });
    const team = await googleConnection(WRITE_SCOPE, "team@oneuptime.example");
    const other = await calendar({
      connectionId: team.id,
      address: "team@oneuptime.example",
      displayName: "Team",
    });
    const { calendars } = await listSchedulingCalendars(account);
    assert.deepEqual(
      calendars.map((entry) => [entry.id, entry.isDefault, entry.timeZone]),
      [
        [`calendar:${mirrored.id}`, true, "Europe/Berlin"],
        [`calendar:${other.id}`, false, "Europe/Berlin"],
      ],
    );
  });

  test("never offers a paused or broken calendar, or one whose connection is gone", async () => {
    await calendar({ connectionId: connection.id, status: "paused" });
    await calendar({
      connectionId: connection.id,
      calendarId: "x@group.calendar.google.com",
      status: "error",
    });
    await calendar({ connectionId: `connection_${randomUUID()}`, calendarId: "gone" });
    assert.deepEqual(
      (await listSchedulingCalendars(account)).calendars.map((entry) => entry.id),
      ["mailbox"],
    );
  });

  test("ignores a zone the runtime does not know", async () => {
    const team = await googleConnection(WRITE_SCOPE, "team@oneuptime.example");
    await calendar({
      connectionId: team.id,
      address: "team@oneuptime.example",
      timeZone: "Nowhere/Land",
    });
    const { calendars } = await listSchedulingCalendars(account);
    assert.equal(calendars.find((entry) => entry.id !== "mailbox")?.timeZone, "");
  });
});

describe("the guest list", () => {
  test("drops the organizer and the mailbox, and invites each person once", () => {
    assert.deepEqual(
      inviteList(
        [
          { email: "Felix@Assense.example" },
          { email: "felix@assense.example", name: " Felix  Menzel " },
          { email: SELF },
          { email: "team@oneuptime.example" },
          { email: "anna@assense.example", name: "Anna" },
        ],
        ["team@oneuptime.example", SELF],
      ),
      [
        { email: "felix@assense.example", name: "Felix Menzel" },
        { email: "anna@assense.example", name: "Anna" },
      ],
    );
  });

  test("refuses an entry that is not an address", () => {
    assert.throws(
      () => inviteList([{ email: "felix at assense" }], []),
      /“felix at assense” isn't a valid email address\./,
    );
  });
});

describe("creating the meeting", () => {
  test("asks Google for the event in the agreed wall time and zone, with Meet and invitations", async () => {
    const google = fakeGoogle(() => created());
    const meeting = await scheduleMeeting(
      account,
      input(),
      { userId: "user-1" },
      {
        ...google.dependencies,
        accessToken: async () => "token-abc",
      },
    );

    assert.equal(google.calls.length, 1);
    const [call] = google.calls;
    assert.equal(call.method, "POST");
    assert.equal(
      call.url.origin + call.url.pathname,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    assert.equal(call.url.searchParams.get("conferenceDataVersion"), "1");
    assert.equal(call.url.searchParams.get("sendUpdates"), "all");
    assert.equal(call.headers.Authorization, "Bearer token-abc");
    assert.equal(call.headers["Content-Type"], "application/json");
    const body = call.body as {
      conferenceData: {
        createRequest: { requestId: string; conferenceSolutionKey: { type: string } };
      };
    } & Record<string, unknown>;
    assert.match(body.conferenceData.createRequest.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body, {
      summary: "Status page rollout",
      description: "Walk through the plan.",
      start: { dateTime: "2026-11-03T15:00:00", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-11-03T15:45:00", timeZone: "Europe/Berlin" },
      attendees: [
        { email: "felix@assense.example", displayName: "Felix Menzel" },
        { email: "anna@assense.example" },
      ],
      conferenceData: {
        createRequest: {
          requestId: body.conferenceData.createRequest.requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    });

    assert.deepEqual(meeting, {
      eventId: "evt_123",
      calendarId: "mailbox",
      htmlLink: "https://www.google.com/calendar/event?eid=evt_123",
      meetLink: "https://meet.google.com/abc-defg-hij",
      title: "Status page rollout",
      start: "2026-11-03T14:00:00.000Z",
      end: "2026-11-03T14:45:00.000Z",
      timeZone: "Europe/Berlin",
      attendees: ["felix@assense.example", "anna@assense.example"],
      invitesSent: true,
    });
  });

  test("keeps real elapsed time across the autumn clock change", async () => {
    const google = fakeGoogle(() => created());
    const meeting = await scheduleMeeting(
      account,
      input({ start: "2026-10-25T01:30", durationMinutes: 120 }),
      { userId: null },
      { ...google.dependencies, accessToken: async () => "t" },
    );
    const body = google.calls[0].body as { start: unknown; end: unknown };
    assert.deepEqual(body.start, { dateTime: "2026-10-25T01:30:00", timeZone: "Europe/Berlin" });
    // Two real hours after 01:30 CEST is 02:30 CET: clocks went back at 03:00.
    assert.deepEqual(body.end, { dateTime: "2026-10-25T02:30:00", timeZone: "Europe/Berlin" });
    assert.equal(meeting.start, "2026-10-24T23:30:00.000Z");
    assert.equal(meeting.end, "2026-10-25T01:30:00.000Z");
  });

  test("sends a time inside the spring-forward gap as the wall time it lands on", async () => {
    const google = fakeGoogle(() => created());
    await scheduleMeeting(
      account,
      input({ start: "2027-03-28T02:30", timeZone: "Europe/Berlin", durationMinutes: 30 }),
      { userId: null },
      {
        ...google.dependencies,
        now: () => new Date("2027-03-01T00:00:00Z"),
        accessToken: async () => "t",
      },
    );
    const body = google.calls[0].body as { start: { dateTime: string } };
    assert.notEqual(body.start.dateTime, "2027-03-28T02:30:00");
    assert.match(body.start.dateTime, /^2027-03-28T0[13]:30:00$/);
  });

  test("books without Meet or invitations when asked to", async () => {
    const google = fakeGoogle(() => created({ hangoutLink: undefined }));
    const meeting = await scheduleMeeting(
      account,
      input({ addMeet: false, sendInvites: false, description: "" }),
      { userId: null },
      { ...google.dependencies, accessToken: async () => "t" },
    );
    const [call] = google.calls;
    assert.equal(call.url.searchParams.get("sendUpdates"), "none");
    assert.equal("conferenceData" in (call.body as object), false);
    assert.equal("description" in (call.body as object), false);
    assert.equal(meeting.meetLink, null);
    assert.equal(meeting.invitesSent, false);
  });

  test("reads the Meet link from conferenceData's video entry point", () => {
    assert.equal(
      meetLinkOf({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1-555" },
            { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
          ],
        },
      }),
      "https://meet.google.com/xyz-abcd-efg",
    );
    assert.equal(meetLinkOf({}), null);
  });

  test("waits for a Meet link Google is still creating", async () => {
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    const google = fakeGoogle((request, index) => {
      if (index === 0) return created({ hangoutLink: undefined, ...pending });
      assert.equal(request.method, "GET");
      assert.equal(request.url.pathname, "/calendar/v3/calendars/primary/events/evt_123");
      assert.equal(request.url.searchParams.get("conferenceDataVersion"), "1");
      return index === 1
        ? created({ hangoutLink: undefined, ...pending })
        : created({ hangoutLink: "https://meet.google.com/ready-now-yes" });
    });
    const meeting = await scheduleMeeting(
      account,
      input(),
      { userId: null },
      {
        ...google.dependencies,
        accessToken: async () => "t",
      },
    );
    assert.equal(meeting.meetLink, "https://meet.google.com/ready-now-yes");
    assert.equal(google.calls.length, 3);
    assert.deepEqual(google.sleeps, [700, 1400]);
  });

  test("gives up on a link that never comes, without failing the meeting", async () => {
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    const google = fakeGoogle(() => created({ hangoutLink: undefined, ...pending }));
    const meeting = await scheduleMeeting(
      account,
      input(),
      { userId: null },
      {
        ...google.dependencies,
        accessToken: async () => "t",
      },
    );
    assert.equal(meeting.meetLink, null);
    assert.equal(meeting.eventId, "evt_123");
    assert.equal(google.calls.length, 4);
  });

  test("a failed re-read costs only the link", async () => {
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    const google = fakeGoogle((_request, index) =>
      index === 0
        ? created({ hangoutLink: undefined, ...pending })
        : new Response("upstream", { status: 503 }),
    );
    const meeting = await scheduleMeeting(
      account,
      input(),
      { userId: null },
      {
        ...google.dependencies,
        accessToken: async () => "t",
      },
    );
    assert.equal(meeting.meetLink, null);
    assert.equal(google.calls.length, 2);
  });

  test("uses the mailbox connection's own token when nothing overrides it", async () => {
    const google = fakeGoogle(() => created());
    await scheduleMeeting(account, input(), { userId: null }, google.dependencies);
    assert.equal(google.calls[0].headers.Authorization, "Bearer live-token");
  });

  test("books on a calendar connected under Meetings, and mirrors the event into its agenda", async () => {
    const team = await googleConnection(WRITE_SCOPE, "team@oneuptime.example");
    const shared = await calendar({
      connectionId: team.id,
      calendarId: "sales@group.calendar.google.com",
      address: "team@oneuptime.example",
      displayName: "Sales calls",
    });
    const google = fakeGoogle(() => created());
    const meeting = await scheduleMeeting(
      account,
      input({
        calendarId: `calendar:${shared.id}`,
        attendees: [{ email: "felix@assense.example" }, { email: "team@oneuptime.example" }],
      }),
      { userId: null },
      google.dependencies,
    );
    assert.equal(
      google.calls[0].url.pathname,
      "/calendar/v3/calendars/sales%40group.calendar.google.com/events",
    );
    assert.equal(google.calls[0].headers.Authorization, "Bearer live-token");
    // The calendar's own account is the organizer, so it is not a guest.
    assert.deepEqual(meeting.attendees, ["felix@assense.example"]);
    const mirrored = await AppDataSource.getRepository(CalendarEvent).findOneByOrFail({
      accountId: shared.id,
      externalId: "evt_123",
    });
    assert.equal(mirrored.conferenceUrl, "https://meet.google.com/abc-defg-hij");
    assert.equal(mirrored.startAt.toISOString(), "2026-11-03T14:00:00.000Z");
  });

  test("refuses times that have passed, are not real, or are years away — before Google hears of them", async () => {
    const google = fakeGoogle(() => created());
    const deps = { ...google.dependencies, accessToken: async () => "t" };
    const cases: Array<[Partial<ScheduleMeetingInput>, RegExp]> = [
      [{ start: "2026-10-20T09:59" }, /That time has already passed/],
      [{ start: "2026-02-30T10:00" }, /isn't a real date and time/],
      [{ start: "2029-01-01T10:00" }, /more than two years away/],
      [{ timeZone: "Mars/Base" }, /Pick a time zone/],
      [{ durationMinutes: 2 }, /between 5 minutes and 12 hours/],
      [{ durationMinutes: 721 }, /between 5 minutes and 12 hours/],
      [{ title: "   " }, /Give the meeting a title/],
      [{ attendees: [{ email: SELF }] }, /Add at least one person to invite/],
      [{ calendarId: "calendar:nope" }, /can't be used for scheduling/],
    ];
    for (const [overrides, message] of cases) {
      const error = await failure(
        scheduleMeeting(account, input(overrides), { userId: null }, deps),
      );
      assert.match(error.message, message, JSON.stringify(overrides));
    }
    assert.equal(google.calls.length, 0);
    assert.equal(
      (
        await failure(
          scheduleMeeting(account, input({ calendarId: "calendar:nope" }), { userId: null }, deps),
        )
      ).status,
      404,
    );
  });

  test("a guest on the do-not-email list stops the whole meeting, before Google is asked", async () => {
    await insert(Suppression, {
      companyId,
      email: "anna@assense.example",
      reason: "unsubscribe",
      source: "test",
      notes: "",
    });
    const google = fakeGoogle(() => created());
    const error = await failure(
      scheduleMeeting(
        account,
        input(),
        { userId: null },
        { ...google.dependencies, accessToken: async () => "t" },
      ),
    );
    assert.equal(error.status, 400);
    assert.equal(error.message, "anna@assense.example is on this company's do-not-email list");
    assert.equal(google.calls.length, 0);
  });

  test("a guest at a domain a Policy blocks stops it too", async () => {
    await insert(CompanyPolicy, {
      companyId,
      title: "No competitors",
      body: "",
      blockedRecipientDomains: "assense.example",
      forbiddenTools: "",
      enabled: true,
    });
    const google = fakeGoogle(() => created());
    const error = await failure(
      scheduleMeeting(
        account,
        input(),
        { userId: null },
        { ...google.dependencies, accessToken: async () => "t" },
      ),
    );
    assert.match(error.message, /blocked by the company policy "No competitors"/);
    assert.equal(google.calls.length, 0);
  });

  test("says what Google said when it refuses", async () => {
    const cases: Array<[Response, RegExp]> = [
      [
        Response.json(
          { error: { message: "You need to have writer access to this calendar." } },
          { status: 403 },
        ),
        /^Google Calendar refused: You need to have writer access to this calendar\.$/,
      ],
      [new Response("", { status: 401 }), /Reconnect the Google account/],
      [new Response("", { status: 404 }), /couldn't find that calendar/],
      [
        Response.json({ error: { message: "Backend Error" } }, { status: 500 }),
        /^Google Calendar: Backend Error$/,
      ],
    ];
    for (const [response, message] of cases) {
      const google = fakeGoogle(() => response);
      const error = await failure(
        scheduleMeeting(
          account,
          input(),
          { userId: null },
          { ...google.dependencies, accessToken: async () => "t" },
        ),
      );
      assert.match(error.message, message);
      assert.equal(error.status, 400);
    }
    const unreachable = fakeGoogle(() => {
      throw new TypeError("fetch failed");
    });
    assert.match(
      (
        await failure(
          scheduleMeeting(
            account,
            input(),
            { userId: null },
            {
              ...unreachable.dependencies,
              accessToken: async () => "t",
            },
          ),
        )
      ).message,
      /^Couldn't reach Google Calendar: fetch failed$/,
    );
  });

  test("a token that cannot be refreshed is reported, not thrown raw", async () => {
    const google = fakeGoogle(() => created());
    const error = await failure(
      scheduleMeeting(
        account,
        input(),
        { userId: null },
        {
          ...google.dependencies,
          accessToken: async () => {
            throw new Error("This Google connection was authorized without the Calendar scope.");
          },
        },
      ),
    );
    assert.match(error.message, /without the Calendar scope/);
    assert.equal(google.calls.length, 0);
  });

  test("records who scheduled it on the thread's timeline, and spends the AI button that proposed it", async () => {
    const thread = await insert(MailThread, {
      companyId,
      accountId: account.id,
      gmailThreadId: `gmail_thread_${randomUUID()}`,
      subject: "Status page rollout",
    });
    const inbound = await insert(MailMessage, {
      companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: `gmail_${randomUUID()}`,
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "felix@assense.example",
      toEmails: SELF,
      subject: "Status page rollout",
      bodyText: "Tuesday 3pm CET?",
      sentAt: new Date("2026-10-19T10:00:00Z"),
    });
    const analysis = await insert(MailInboundAnalysis, {
      companyId,
      accountId: account.id,
      threadId: thread.id,
      messageId: inbound.id,
      status: "succeeded",
      category: "scheduling",
      summary: "Felix wants a call.",
      actionsJson: JSON.stringify([
        { id: "0", kind: "schedule_meeting", label: "Schedule the call", attendees: [] },
      ]),
    });
    const google = fakeGoogle(() => created());
    await scheduleMeeting(
      account,
      input({ threadId: thread.id, analysisAction: { analysisId: analysis.id, actionId: "0" } }),
      { userId: "user-7" },
      { ...google.dependencies, accessToken: async () => "t" },
    );

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "mail.meeting.schedule",
    });
    assert.equal(audit.actorUserId, "user-7");
    assert.equal(audit.targetType, "mail_thread");
    assert.equal(audit.targetId, thread.id);
    const metadata = JSON.parse(audit.metadataJson) as Record<string, unknown>;
    assert.equal(metadata.mailThreadId, thread.id);
    assert.equal(metadata.eventId, "evt_123");
    assert.equal(metadata.attendeeCount, 2);
    assert.equal(metadata.meetLink, true);

    const timeline = await mailReviewTimeline({
      account,
      thread,
      messages: [inbound],
      analyses: [analysis],
      handovers: [],
      canReadFinance: false,
      canReviewApprovals: false,
    });
    const scheduled = timeline.events.find((event) => event.title === "Meeting scheduled");
    assert.ok(scheduled, JSON.stringify(timeline.events));
    assert.equal(scheduled.kind, "action");
    assert.match(
      scheduled.description ?? "",
      /Tue, Nov 3, 3:00\s*–\s*3:45\s*PM GMT\+1 · 2 invited · Google Meet/,
    );

    const [button] = parseAnalysisActions(
      (await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({ id: analysis.id }))
        .actionsJson,
    );
    assert.ok(button.executedAt);
  });

  test("refuses a thread from another mailbox", async () => {
    const otherAccount = await insert(MailAccount, {
      companyId,
      connectionId: `connection_${randomUUID()}`,
      provider: "imap",
      address: "ops@oneuptime.example",
      status: "active",
    });
    const foreign = await insert(MailThread, {
      companyId,
      accountId: otherAccount.id,
      gmailThreadId: `gmail_thread_${randomUUID()}`,
      subject: "Elsewhere",
    });
    const google = fakeGoogle(() => created());
    const error = await failure(
      scheduleMeeting(
        account,
        input({ threadId: foreign.id }),
        { userId: null },
        {
          ...google.dependencies,
          accessToken: async () => "t",
        },
      ),
    );
    assert.equal(error.status, 404);
    assert.equal(google.calls.length, 0);
  });
});

describe("the organizer's busy time", () => {
  test("asks Google's free/busy for the slot and returns the busy intervals", async () => {
    const google = fakeGoogle(() =>
      Response.json({
        calendars: {
          primary: {
            busy: [
              { start: "2026-11-03T13:30:00Z", end: "2026-11-03T14:15:00Z" },
              { start: "garbage", end: "2026-11-03T15:00:00Z" },
              { start: "2026-11-03T15:00:00Z", end: "2026-11-03T14:00:00Z" },
            ],
          },
        },
      }),
    );
    const result = await calendarAvailability(
      account,
      {
        calendarId: "mailbox",
        start: new Date("2026-11-03T13:00:00Z"),
        end: new Date("2026-11-03T16:00:00Z"),
      },
      { ...google.dependencies, accessToken: async () => "t" },
    );
    assert.deepEqual(result, {
      busy: [{ start: "2026-11-03T13:30:00.000Z", end: "2026-11-03T14:15:00.000Z" }],
    });
    const [call] = google.calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/calendar/v3/freeBusy");
    assert.deepEqual(call.body, {
      timeMin: "2026-11-03T13:00:00.000Z",
      timeMax: "2026-11-03T16:00:00.000Z",
      items: [{ id: "primary" }],
    });
  });

  test("reports a calendar Google would not share", async () => {
    const google = fakeGoogle(() =>
      Response.json({
        calendars: { primary: { errors: [{ domain: "global", reason: "notFound" }] } },
      }),
    );
    const error = await failure(
      calendarAvailability(
        account,
        { calendarId: "mailbox", start: NOW, end: new Date(NOW.getTime() + 3_600_000) },
        { ...google.dependencies, accessToken: async () => "t" },
      ),
    );
    assert.match(error.message, /couldn't share this calendar's availability \(notFound\)/);
  });
});
