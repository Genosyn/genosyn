import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Suppression } from "../db/entities/Suppression.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { mailRouter } from "./mail.js";
import { mailMeetingsRouter } from "./mailMeetings.js";

/**
 * Scheduling a meeting from an email, at the HTTP boundary.
 *
 * The router is mounted the way the product mounts it, beside `mailRouter`,
 * with real authentication and company membership; Google Calendar is stubbed
 * at `fetch` and the model at the agent runtime. Pinned here: who may call
 * each route, what each refuses and in which words, what Google is asked for
 * (wall time and zone, daylight saving included, Meet, invitations, guests),
 * that a guest on the do-not-email list stops everything before Google hears
 * of it, and that the scheduled meeting lands on the thread's timeline.
 */

type CalendarsBody = {
  calendars: Array<{
    id: string;
    label: string;
    address: string;
    timeZone: string;
    isDefault: boolean;
  }>;
  setupHint: string | null;
};
type ProposalBody = {
  proposal: {
    title: string;
    attendees: Array<{ email: string; name: string }>;
    start: string | null;
    timeZone: string;
    durationMinutes: number;
    description: string;
    evidence: string | null;
    alternatives: Array<{ start: string; timeZone: string; evidence: string | null }>;
    confidence: string;
  };
  source: "ai" | "basic";
  employee: { id: string; name: string } | null;
  note: string | null;
};
type MeetingBody = {
  meeting: {
    eventId: string;
    calendarId: string;
    htmlLink: string;
    meetLink: string | null;
    title: string;
    start: string;
    end: string;
    timeZone: string;
    attendees: string[];
    invitesSent: boolean;
  };
};
type ApiError = { error?: string; issues?: Array<{ path?: Array<string | number> }> };
type GoogleCall = { method: string; url: URL; body: Record<string, unknown> | null; auth: string };

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SELF = "nawaz@oneuptime.example";
const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let thread: MailThread;
let googleCalls: GoogleCall[] = [];
let googleAnswer: (call: GoogleCall) => Response = () => new Response("", { status: 500 });

const originalFetch = globalThis.fetch;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", mailRouter);
  app.use("/api/companies/:cid", mailMeetingsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function user(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function member(role: Role, into: Company = company): Promise<User> {
  const person = await user(role);
  await insert(Membership, { companyId: into.id, userId: person.id, role });
  return person;
}

async function googleConnection(into: Company, scope: string, email = SELF) {
  return insert(IntegrationConnection, {
    companyId: into.id,
    provider: "google",
    label: "Google",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "client",
        clientSecret: "secret",
        accessToken: "calendar-token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope,
        email,
      },
      into.id,
    ),
    accountHint: email,
    status: "connected",
    statusMessage: "",
  });
}

let minute = 0;
async function message(fields: Partial<MailMessage>): Promise<MailMessage> {
  minute += 1;
  const suffix = randomUUID();
  return insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `gmail_${suffix}`,
    gmailThreadId: thread.gmailThreadId,
    labelIds: " INBOX ",
    subject: "Re: Status page rollout",
    sentAt: new Date(Date.now() - 60 * 60_000 + minute * 1_000),
    ...fields,
  });
}

/** A local wall time `days` from now, at 15:00. */
function future(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.toISOString().slice(0, 10)}T15:00`;
}

beforeEach(async () => {
  await resetTestDb();
  googleCalls = [];
  const owner = await user("owner");
  company = await insert(Company, {
    name: "OneUptime",
    slug: `oneuptime-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  // Scheduling is ordinary use of the inbox: a plain Member does all of it.
  actingUserId = (await member("member")).id;
  const connection = await googleConnection(company, CALENDAR_SCOPE);
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: connection.id,
    provider: "gmail",
    address: SELF,
    status: "active",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: `gmail_thread_${randomUUID()}`,
    subject: "Re: Status page rollout",
  });
  await message({
    fromName: "Felix Menzel",
    fromEmail: "felix.menzel@assense.example",
    toEmails: `Nawaz <${SELF}>`,
    ccEmails: "support@oneuptime.example",
    bodyText: "Could we do Tuesday at 3pm CET? 45 minutes should do.",
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(CALENDAR_API)) return originalFetch(input as RequestInfo, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const recorded: GoogleCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(url),
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: headers.Authorization ?? "",
    };
    googleCalls.push(recorded);
    return googleAnswer(recorded);
  }) as typeof fetch;
  googleAnswer = (recorded) =>
    recorded.url.pathname.endsWith("/freeBusy")
      ? Response.json({ calendars: { primary: { busy: [] } } })
      : Response.json({
          id: "evt_route",
          htmlLink: "https://www.google.com/calendar/event?eid=evt_route",
          hangoutLink: "https://meet.google.com/rou-tete-sts",
          start: (recorded.body as { start?: unknown } | null)?.start,
          end: (recorded.body as { end?: unknown } | null)?.end,
        });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await originalFetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: "mailbox",
    title: "Assense × OneUptime: status page rollout",
    description: "Walk through the rollout.",
    start: future(7),
    timeZone: "Europe/Berlin",
    durationMinutes: 45,
    attendees: [{ email: "felix.menzel@assense.example", name: "Felix Menzel" }],
    threadId: thread.id,
    ...overrides,
  };
}

// ───────────────────────────── calendars ─────────────────────────────

describe("GET /mail/accounts/:aid/scheduling-calendars", () => {
  test("lists the mailbox's own calendar as the default, without calling Google", async () => {
    const res = await call<CalendarsBody>(
      "GET",
      `/mail/accounts/${account.id}/scheduling-calendars`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      calendars: [{ id: "mailbox", label: SELF, address: SELF, timeZone: "", isDefault: true }],
      setupHint: null,
    });
    assert.equal(googleCalls.length, 0);
  });

  test("says how to connect one when there is nothing to schedule on", async () => {
    await AppDataSource.getRepository(IntegrationConnection).update(
      { id: account.connectionId },
      {
        encryptedConfig: encryptConnectionConfig(
          {
            accessToken: "t",
            expiresAt: Date.now() + 3_600_000,
            email: SELF,
            scope: "https://www.googleapis.com/auth/gmail.modify",
          },
          company.id,
        ),
      },
    );
    const res = await call<CalendarsBody>(
      "GET",
      `/mail/accounts/${account.id}/scheduling-calendars`,
    );
    assert.deepEqual(res.body.calendars, []);
    assert.match(res.body.setupHint ?? "", /Meetings → Calendars/);
  });

  test("404s another company's mailbox and 400s an id that is not one", async () => {
    assert.equal(
      (await call<ApiError>("GET", `/mail/accounts/${randomUUID()}/scheduling-calendars`)).status,
      404,
    );
    assert.equal(
      (await call<ApiError>("GET", "/mail/accounts/not-a-uuid/scheduling-calendars")).status,
      400,
    );
  });

  test("is for signed-in Members of the company only", async () => {
    actingUserId = null;
    assert.equal(
      (await call<ApiError>("GET", `/mail/accounts/${account.id}/scheduling-calendars`)).status,
      401,
    );
    const owner = await user("stranger");
    const other = await insert(Company, {
      name: "Other",
      slug: `other-${randomUUID()}`,
      ownerId: owner.id,
    });
    actingUserId = (await member("owner", other)).id;
    assert.equal(
      (await call<ApiError>("GET", `/mail/accounts/${account.id}/scheduling-calendars`)).status,
      403,
    );
  });
});

// ───────────────────────────── proposal ─────────────────────────────

describe("POST /mail/threads/:tid/meeting-proposal", () => {
  test("without an AI Employee on the mailbox, opens on the thread's people and no time", async () => {
    const res = await call<ProposalBody>("POST", `/mail/threads/${thread.id}/meeting-proposal`, {
      timeZone: "America/New_York",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "basic");
    assert.equal(res.body.employee, null);
    assert.match(res.body.note ?? "", /No AI Employee can read this mailbox yet/);
    assert.deepEqual(res.body.proposal, {
      title: "Status page rollout",
      attendees: [
        { email: "felix.menzel@assense.example", name: "Felix Menzel" },
        { email: "support@oneuptime.example", name: "" },
      ],
      start: null,
      timeZone: "America/New_York",
      durationMinutes: 30,
      description: "",
      evidence: null,
      alternatives: [],
      confidence: "none",
    });
  });

  test("with one, returns its reading of the thread, held to the thread", async (t: TestContext) => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Ada Scheduler",
      slug: `ada-${randomUUID()}`,
      role: "Executive assistant",
      soulBody: "",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });
    await insertEmployeeModel({
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-test",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify({ apiKeyEncrypted: "test-ciphertext" }),
      connectedAt: new Date(),
    });
    const start = future(7);
    const seenTools: string[][] = [];
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      seenTools.push(params.registry.resident.map((tool) => tool.name));
      await params.registry.resolve("submit_meeting_proposal")!.run({
        title: "Status page rollout call",
        attendees: ["felix.menzel@assense.example", "eve@evil.example"],
        start,
        timeZone: "Europe/Berlin",
        durationMinutes: 45,
        agenda: "Rollout plan",
        evidence: "Could we do Tuesday at 3pm CET?",
        confidence: "proposed",
        alternatives: [],
      });
      return { finalText: "", steps: 1, stopReason: "end_turn" };
    });

    const res = await call<ProposalBody>("POST", `/mail/threads/${thread.id}/meeting-proposal`, {
      timeZone: "America/New_York",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.source, "ai", res.body.note ?? "");
    assert.deepEqual(res.body.employee, { id: employee.id, name: "Ada Scheduler" });
    assert.deepEqual(seenTools, [["submit_meeting_proposal"]]);
    assert.deepEqual(res.body.proposal.attendees, [
      { email: "felix.menzel@assense.example", name: "Felix Menzel" },
    ]);
    assert.equal(res.body.proposal.start, start);
    assert.equal(res.body.proposal.timeZone, "Europe/Berlin");
    assert.equal(res.body.proposal.evidence, "Could we do Tuesday at 3pm CET?");
    assert.equal(res.body.proposal.confidence, "proposed");
  });

  test("404s an unknown thread and refuses a body it does not know", async () => {
    assert.equal(
      (await call<ApiError>("POST", `/mail/threads/${randomUUID()}/meeting-proposal`, {})).status,
      404,
    );
    assert.equal(
      (await call<ApiError>("POST", `/mail/threads/${thread.id}/meeting-proposal`, { prompt: "x" }))
        .status,
      400,
    );
  });
});

// ───────────────────────────── availability ─────────────────────────────

describe("POST /mail/accounts/:aid/meetings/availability", () => {
  test("returns the organizer's busy time from Google", async () => {
    googleAnswer = () =>
      Response.json({
        calendars: {
          primary: { busy: [{ start: "2026-11-03T14:00:00Z", end: "2026-11-03T15:00:00Z" }] },
        },
      });
    const res = await call<{ busy: Array<{ start: string; end: string }> }>(
      "POST",
      `/mail/accounts/${account.id}/meetings/availability`,
      { calendarId: "mailbox", start: "2026-11-03T13:00:00Z", end: "2026-11-03T17:00:00Z" },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.busy, [
      { start: "2026-11-03T14:00:00.000Z", end: "2026-11-03T15:00:00.000Z" },
    ]);
    assert.equal(googleCalls[0].url.pathname, "/calendar/v3/freeBusy");
    assert.equal(googleCalls[0].auth, "Bearer calendar-token");
  });

  test("refuses a window that ends first or spans more than a day", async () => {
    for (const body of [
      { calendarId: "mailbox", start: "2026-11-03T13:00:00Z", end: "2026-11-03T13:00:00Z" },
      { calendarId: "mailbox", start: "2026-11-03T13:00:00Z", end: "2026-11-04T13:00:01Z" },
      { calendarId: "mailbox", start: "tomorrow", end: "2026-11-04T13:00:00Z" },
      { calendarId: "", start: "2026-11-03T13:00:00Z", end: "2026-11-03T14:00:00Z" },
    ]) {
      const res = await call<ApiError>(
        "POST",
        `/mail/accounts/${account.id}/meetings/availability`,
        body,
      );
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(googleCalls.length, 0);
  });

  test("404s a calendar this mailbox cannot use, and passes Google's refusal on as a 400", async () => {
    const unknown = await call<ApiError>(
      "POST",
      `/mail/accounts/${account.id}/meetings/availability`,
      {
        calendarId: `calendar:${randomUUID()}`,
        start: "2026-11-03T13:00:00Z",
        end: "2026-11-03T14:00:00Z",
      },
    );
    assert.equal(unknown.status, 404);
    googleAnswer = () =>
      Response.json({ error: { message: "Rate Limit Exceeded" } }, { status: 429 });
    const limited = await call<ApiError>(
      "POST",
      `/mail/accounts/${account.id}/meetings/availability`,
      {
        calendarId: "mailbox",
        start: "2026-11-03T13:00:00Z",
        end: "2026-11-03T14:00:00Z",
      },
    );
    assert.equal(limited.status, 400);
    assert.equal(limited.body.error, "Google Calendar: Rate Limit Exceeded");
  });
});

// ───────────────────────────── create ─────────────────────────────

describe("POST /mail/accounts/:aid/meetings", () => {
  test("creates the event with a Meet link and invitations, and answers 201 with it", async () => {
    const res = await call<MeetingBody>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule(),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(googleCalls.length, 1);
    const [created] = googleCalls;
    assert.equal(created.method, "POST");
    assert.equal(created.url.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(created.url.searchParams.get("conferenceDataVersion"), "1");
    assert.equal(created.url.searchParams.get("sendUpdates"), "all");
    assert.equal(created.auth, "Bearer calendar-token");
    const body = created.body as {
      summary: string;
      description: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      attendees: unknown[];
      conferenceData: { createRequest: { conferenceSolutionKey: { type: string } } };
    };
    assert.equal(body.summary, "Assense × OneUptime: status page rollout");
    assert.equal(body.description, "Walk through the rollout.");
    assert.deepEqual(body.start, { dateTime: `${future(7)}:00`, timeZone: "Europe/Berlin" });
    assert.deepEqual(body.end, {
      dateTime: `${future(7).slice(0, 11)}15:45:00`,
      timeZone: "Europe/Berlin",
    });
    assert.deepEqual(body.attendees, [
      { email: "felix.menzel@assense.example", displayName: "Felix Menzel" },
    ]);
    assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");

    assert.equal(res.body.meeting.eventId, "evt_route");
    assert.equal(res.body.meeting.calendarId, "mailbox");
    assert.equal(res.body.meeting.meetLink, "https://meet.google.com/rou-tete-sts");
    assert.equal(res.body.meeting.htmlLink, "https://www.google.com/calendar/event?eid=evt_route");
    assert.deepEqual(res.body.meeting.attendees, ["felix.menzel@assense.example"]);
    assert.equal(res.body.meeting.invitesSent, true);
    assert.equal(res.body.meeting.timeZone, "Europe/Berlin");
    assert.equal(
      new Date(res.body.meeting.end).getTime() - new Date(res.body.meeting.start).getTime(),
      45 * 60_000,
    );
  });

  test("books in New York time across the November clock change exactly as asked", async () => {
    const year = new Date().getUTCFullYear() + 1;
    const res = await call<MeetingBody>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule({
        // US clocks fall back on the first Sunday of November at 02:00.
        start: `${year}-11-0${firstSundayOfNovember(year)}T00:30`,
        timeZone: "America/New_York",
        durationMinutes: 120,
        addMeet: false,
        sendInvites: false,
      }),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const body = googleCalls[0].body as { start: { dateTime: string }; end: { dateTime: string } };
    const day = `${year}-11-0${firstSundayOfNovember(year)}`;
    assert.equal(body.start.dateTime, `${day}T00:30:00`);
    // Two real hours after 00:30 EDT is 01:30 EST.
    assert.equal(body.end.dateTime, `${day}T01:30:00`);
    assert.equal(googleCalls[0].url.searchParams.get("sendUpdates"), "none");
    assert.equal("conferenceData" in (googleCalls[0].body ?? {}), false);
    assert.equal(res.body.meeting.invitesSent, false);
  });

  test("a guest on the do-not-email list stops the meeting before Google hears of it", async () => {
    await insert(Suppression, {
      companyId: company.id,
      email: "support@oneuptime.example",
      reason: "manual",
      source: "test",
      notes: "",
    });
    const res = await call<ApiError>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule({
        attendees: [
          { email: "felix.menzel@assense.example" },
          { email: "Support@OneUptime.example" },
        ],
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(
      res.body.error,
      "support@oneuptime.example is on this company's do-not-email list",
    );
    assert.equal(googleCalls.length, 0);
  });

  test("refuses a time that has passed", async () => {
    const res = await call<ApiError>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule({ start: "2020-01-01T10:00" }),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "That time has already passed");
    assert.equal(googleCalls.length, 0);
  });

  test("validates every field before anything else", async () => {
    const cases: Array<Record<string, unknown>> = [
      { attendees: [] },
      { attendees: [{ email: "not an address" }] },
      {
        attendees: Array.from({ length: 101 }, (_, index) => ({ email: `p${index}@acme.example` })),
      },
      { attendees: [{ email: "a@acme.example", role: "chair" }] },
      { timeZone: "Mars/Base" },
      { timeZone: "+01:00" },
      { start: "2026-11-03 15:00" },
      { start: "next Tuesday" },
      { durationMinutes: 4 },
      { durationMinutes: 721 },
      { durationMinutes: 30.5 },
      { title: "   " },
      { title: "t".repeat(301) },
      { description: "d".repeat(8_001) },
      { threadId: "nope" },
      { analysisAction: { analysisId: "nope", actionId: "0" } },
      { addMeet: "yes" },
      { organizer: "someone@else.example" },
    ];
    for (const overrides of cases) {
      const res = await call<ApiError>(
        "POST",
        `/mail/accounts/${account.id}/meetings`,
        schedule(overrides),
      );
      assert.equal(res.status, 400, JSON.stringify(overrides).slice(0, 80));
      assert.equal(res.body.error, "ValidationError", JSON.stringify(overrides).slice(0, 80));
    }
    assert.equal(googleCalls.length, 0);
  });

  test("404s a mailbox, calendar or thread that is not this one's", async () => {
    assert.equal(
      (await call<ApiError>("POST", `/mail/accounts/${randomUUID()}/meetings`, schedule())).status,
      404,
    );
    assert.equal(
      (
        await call<ApiError>(
          "POST",
          `/mail/accounts/${account.id}/meetings`,
          schedule({ calendarId: "calendar:nope" }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call<ApiError>(
          "POST",
          `/mail/accounts/${account.id}/meetings`,
          schedule({ threadId: randomUUID() }),
        )
      ).status,
      404,
    );
    assert.equal(googleCalls.length, 0);
  });

  test("passes Google's refusal on in its own words", async () => {
    googleAnswer = () =>
      Response.json(
        { error: { message: "You need to have writer access to this calendar." } },
        { status: 403 },
      );
    const res = await call<ApiError>("POST", `/mail/accounts/${account.id}/meetings`, schedule());
    assert.equal(res.status, 400);
    assert.equal(
      res.body.error,
      "Google Calendar refused: You need to have writer access to this calendar.",
    );
  });

  test("books on a calendar connected under Meetings when asked", async () => {
    const team = await googleConnection(company, CALENDAR_SCOPE, "team@oneuptime.example");
    const shared = await insert(CalendarAccount, {
      companyId: company.id,
      connectionId: team.id,
      calendarId: "sales@group.calendar.google.com",
      address: "team@oneuptime.example",
      displayName: "Sales calls",
      timeZone: "Europe/Berlin",
      status: "active",
    });
    const res = await call<MeetingBody>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule({ calendarId: `calendar:${shared.id}` }),
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(
      googleCalls[0].url.pathname,
      "/calendar/v3/calendars/sales%40group.calendar.google.com/events",
    );
    assert.equal(res.body.meeting.calendarId, `calendar:${shared.id}`);
  });

  test("shows up on the thread's timeline, attributed to the Member", async () => {
    const res = await call<MeetingBody>(
      "POST",
      `/mail/accounts/${account.id}/meetings`,
      schedule(),
    );
    assert.equal(res.status, 201);
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "mail.meeting.schedule",
    });
    assert.equal(audit.actorUserId, actingUserId);

    const view = await call<{
      reviewTimeline: {
        events: Array<{ title: string; kind: string; description: string | null }>;
      };
    }>("GET", `/mail/threads/${thread.id}`);
    assert.equal(view.status, 200);
    const scheduled = view.body.reviewTimeline.events.find(
      (event) => event.title === "Meeting scheduled",
    );
    assert.ok(scheduled, JSON.stringify(view.body.reviewTimeline.events));
    assert.equal(scheduled.kind, "action");
    assert.match(scheduled.description ?? "", /1 invited · Google Meet$/);
  });
});

function firstSundayOfNovember(year: number): number {
  for (let day = 1; day <= 7; day += 1) {
    if (new Date(Date.UTC(year, 10, day)).getUTCDay() === 0) return day;
  }
  return 1;
}
