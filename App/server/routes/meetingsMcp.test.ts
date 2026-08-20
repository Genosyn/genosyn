import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../db/entities/CalendarEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeCalendarGrant } from "../db/entities/EmployeeCalendarGrant.js";
import { Meeting } from "../db/entities/Meeting.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  registerMeetingRecorder,
  shutdownMeetingNotetakers,
  type MeetingRecorder,
} from "../services/meetings/recorder.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;

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
  registerMeetingRecorder(null);
  await resetTestDb();
  company = await insert(Company, {
    name: "Meeting Tools Co",
    slug: `meeting-tools-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Nova",
    slug: "nova",
    role: "Account executive",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

afterEach(async () => {
  await shutdownMeetingNotetakers("MCP meeting test cleanup", 1_000);
  registerMeetingRecorder(null);
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function calendarMeeting(accessLevel: "read" | "record"): Promise<Meeting> {
  const account = await insert(CalendarAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    calendarId: "primary",
    address: "sales@example.test",
    displayName: "Sales calendar",
    status: "active",
    notetakerEmployeeId: employee.id,
  });
  const now = Date.now();
  const event = await insert(CalendarEvent, {
    companyId: company.id,
    accountId: account.id,
    externalId: randomUUID(),
    iCalUid: `${randomUUID()}@example.test`,
    summary: "Renewal call",
    startAt: new Date(now - 60_000),
    endAt: new Date(now + 30 * 60_000),
    status: "confirmed",
    attendeesJson: "[]",
    conferenceProvider: "meet",
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
  });
  await insert(EmployeeCalendarGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel,
  });
  return insert(Meeting, {
    companyId: company.id,
    calendarEventId: event.id,
    accountId: account.id,
    title: event.summary,
    scheduledStartAt: event.startAt,
    scheduledEndAt: event.endAt,
    conferenceProvider: "meet",
    conferenceUrl: event.conferenceUrl,
    status: "scheduled",
    notetakerEmployeeId: employee.id,
  });
}

function installWaitingRecorder(): {
  started: Promise<void>;
  callCount: () => number;
} {
  let calls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const join: MeetingRecorder["join"] = async ({ signal }) => {
    calls += 1;
    markStarted();
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("Notetaker stopped"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  registerMeetingRecorder({
    id: "notetaker",
    canJoin: (url) => url === "https://meet.google.com/abc-defg-hij",
    join,
  });
  return { started, callCount: () => calls };
}

describe("start_notetaker", () => {
  test("denies a read-only Calendar Grant before claiming the meeting", async () => {
    const fake = installWaitingRecorder();
    const meeting = await calendarMeeting("read");

    const response = await tool<{ error: string }>("start_notetaker", {
      meetingId: meeting.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /need record access/i);
    assert.equal(fake.callCount(), 0);
    const untouched = await AppDataSource.getRepository(Meeting).findOneByOrFail({
      id: meeting.id,
    });
    assert.equal(untouched.status, "scheduled");
  });

  test("accepts a Record Grant and returns while the notetaker is joining", async () => {
    const fake = installWaitingRecorder();
    const meeting = await calendarMeeting("record");

    const response = await tool<{
      meeting: { id: string; status: string };
      note: string;
    }>("start_notetaker", { meetingId: meeting.id });

    assert.equal(response.status, 200);
    assert.equal(response.body.meeting.id, meeting.id);
    assert.equal(response.body.meeting.status, "joining");
    assert.match(response.body.note, /joining in the background/i);
    assert.match(response.body.note, /admit/i);
    await fake.started;
    assert.equal(fake.callCount(), 1);
    const claimed = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(claimed.status, "joining");
  });

  test("keeps ad-hoc assignments and tenants isolated", async () => {
    const fake = installWaitingRecorder();
    const otherEmployee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Rey",
      slug: "rey",
      role: "Sales manager",
      soulBody: "",
    });
    const adHoc = await insert(Meeting, {
      companyId: company.id,
      title: "Private founder call",
      conferenceProvider: "meet",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      status: "scheduled",
      notetakerEmployeeId: otherEmployee.id,
    });

    const assignedElsewhere = await tool<{ error: string }>("start_notetaker", {
      meetingId: adHoc.id,
    });
    assert.equal(assignedElsewhere.status, 403);
    assert.match(assignedElsewhere.body.error, /assigned as this meeting's notetaker/i);

    const otherCompany = await insert(Company, {
      name: "Other Co",
      slug: `other-meetings-${randomUUID()}`,
      ownerId: "owner-2",
    });
    const crossTenant = await insert(Meeting, {
      companyId: otherCompany.id,
      title: "Other company call",
      conferenceProvider: "meet",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      status: "scheduled",
      notetakerEmployeeId: employee.id,
    });
    const hidden = await tool<{ error: string }>("start_notetaker", {
      meetingId: crossTenant.id,
    });
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error, "Meeting not found");
    assert.equal(fake.callCount(), 0);
  });
});
