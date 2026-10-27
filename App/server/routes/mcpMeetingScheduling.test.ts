import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * An AI Employee books the meeting an email asks for, as Mail's Schedule
 * meeting does — on the calendars it may use, with invitations treated as the
 * email they are.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SELF = "ops@acme.example";
const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar";
const originalFetch = globalThis.fetch;

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let account: MailAccount;
let grant: EmployeeMailAccountGrant;
let googleCalls: Array<{ method: string; url: URL; body: Record<string, unknown> | null }> = [];

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  googleCalls = [];
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
    soulBody: "",
  });
  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
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
        scope: CALENDAR_SCOPE,
        email: SELF,
      },
      company.id,
    ),
    accountHint: SELF,
    status: "connected",
    statusMessage: "",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: connection.id,
    provider: "gmail",
    address: SELF,
    status: "active",
  });
  grant = await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "send",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(CALENDAR_API)) return originalFetch(input as RequestInfo, init);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const recorded = { method: (init?.method ?? "GET").toUpperCase(), url: new URL(url), body };
    googleCalls.push(recorded);
    return recorded.url.pathname.endsWith("/freeBusy")
      ? Response.json({
          calendars: {
            primary: { busy: [{ start: "2030-01-07T09:00:00Z", end: "2030-01-07T10:00:00Z" }] },
          },
        })
      : Response.json({
          id: "evt_ai",
          htmlLink: "https://www.google.com/calendar/event?eid=evt_ai",
          hangoutLink: "https://meet.google.com/aai-meet-ing",
          start: (body as { start?: unknown } | null)?.start,
          end: (body as { end?: unknown } | null)?.end,
        });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function callTool(name: string, body: Record<string, unknown> = {}) {
  const response = await originalFetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

function nextWeek(): string {
  const date = new Date(Date.now() + 7 * 86_400_000);
  return `${date.toISOString().slice(0, 10)}T15:00`;
}

const booking = () => ({
  calendarId: "mailbox",
  title: "Globex × Acme: onboarding",
  start: nextWeek(),
  timeZone: "Europe/Berlin",
  durationMinutes: 30,
  attendees: [{ email: "buyer@globex.example", name: "Grace" }],
});

test("the mailbox's calendar is offered, its busy time read, and a meeting booked as the employee", async () => {
  const calendars = await callTool("list_scheduling_calendars");
  assert.equal(calendars.status, 200, calendars.body.error);
  assert.deepEqual(
    (calendars.body.calendars as Array<{ id: string }>).map((calendar) => calendar.id),
    ["mailbox"],
  );

  const busy = await callTool("check_calendar_availability", {
    calendarId: "mailbox",
    start: "2030-01-07T08:00:00Z",
    end: "2030-01-07T18:00:00Z",
  });
  assert.equal(busy.status, 200, busy.body.error);
  assert.deepEqual(busy.body.busy, [
    { start: "2030-01-07T09:00:00.000Z", end: "2030-01-07T10:00:00.000Z" },
  ]);

  const booked = await callTool("schedule_meeting", booking());
  assert.equal(booked.status, 200, booked.body.error);
  const meeting = booked.body.meeting as { meetLink: string | null; invitesSent: boolean };
  assert.equal(meeting.meetLink, "https://meet.google.com/aai-meet-ing");
  assert.equal(meeting.invitesSent, true);
  const created = googleCalls.find((call) => call.method === "POST" && call.url.pathname.endsWith("/events"));
  assert.equal(created?.url.searchParams.get("sendUpdates"), "all");

  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    companyId: company.id,
    action: "mail.meeting.schedule",
  });
  assert.equal(audit.actorEmployeeId, employee.id, "the audit names the employee, not the system");
});

test("booking is delivery: it needs Send, and a company calendar needs its own Grant", async () => {
  grant.accessLevel = "draft";
  await AppDataSource.getRepository(EmployeeMailAccountGrant).save(grant);
  const draftOnly = await callTool("schedule_meeting", booking());
  assert.equal(draftOnly.status, 403);
  assert.equal((await callTool("list_scheduling_calendars")).status, 200);

  grant.accessLevel = "send";
  await AppDataSource.getRepository(EmployeeMailAccountGrant).save(grant);
  const otherCalendar = await callTool("schedule_meeting", {
    ...booking(),
    calendarId: `calendar:${randomUUID()}`,
  });
  assert.equal(otherCalendar.status, 403);
  assert.equal(googleCalls.length, 0);
});

test("a review-only turn cannot book, because the invitation is an email", async () => {
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    mailDeliveryMode: "review",
  });
  const held = await callTool("schedule_meeting", booking());
  assert.equal(held.status, 403);
  assert.equal(googleCalls.length, 0);
});
