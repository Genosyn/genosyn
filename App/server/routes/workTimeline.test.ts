import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { AppDataSource } from "../db/datasource.js";
import type { WorkEntry } from "../services/employeeWorkTimeline.js";
import { auditRouter } from "./audit.js";
import { workTimelineRouter } from "./workTimeline.js";

/**
 * Route-level contract for the work timeline.
 *
 * Two things are worth pinning here rather than at the service. The first is
 * the query boundary: every parameter is coerced from a string, so a schema
 * that silently accepts `hours=999` is the difference between "a glance at
 * today" and "the whole history through a route that is not the audit log".
 *
 * The second is the entitlement asymmetry, which is the whole reason this
 * endpoint exists separately at all. `GET /audit` is admin-gated and behind a
 * paid feature; this is neither, and the test that proves it sits next to the
 * test that proves the audit log still is.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", workTimelineRouter);
  app.use("/api/companies/:cid", auditRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.test", "Owner");
  member = await createUser("member@example.test", "Member");
  outsider = await createUser("outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Rival", slug: "rival", ownerId: outsider.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
  actingUserId = member.id;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type TimelineBody = {
  since: string;
  until: string;
  employeeId: string | null;
  entries: {
    id: string;
    kind: string;
    at: string;
    title: string;
    detail: string;
    active: boolean;
    subject: string;
    source: WorkEntry["source"];
    analysis?: WorkEntry["analysis"];
    run: {
      summary: string | null;
      outcomeVerdict: string | null;
      checksVerdict: string | null;
    } | null;
  }[];
  entryCount: number;
  employeeSummaries: {
    employeeId: string;
    entryCount: number;
    latest: { id: string; active: boolean } | null;
    current: { id: string; active: boolean } | null;
    waiting: { id: string; active: boolean } | null;
  }[];
};

async function seedRun(overrides: Partial<Run> = {}): Promise<Run> {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
  });
  return insert(Run, {
    routineId: routine.id,
    status: "completed",
    logContent: "",
    triggerKind: "schedule",
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    exitCode: 0,
    ...overrides,
  });
}

async function seedEmailAnalysis(sourceCompanyId = company.id) {
  const account = await insert(MailAccount, {
    companyId: sourceCompanyId,
    connectionId: "timeline-mail-connection",
    address: "support@example.test",
  });
  const thread = await insert(MailThread, {
    companyId: sourceCompanyId,
    accountId: account.id,
    gmailThreadId: "timeline-thread",
    subject: "Thread subject",
    participants: "Ada <ada@example.test>",
  });
  const message = await insert(MailMessage, {
    companyId: sourceCompanyId,
    accountId: account.id,
    threadId: thread.id,
    gmailThreadId: thread.gmailThreadId,
    gmailMessageId: "timeline-message",
    subject: "Estimate for the September rollout",
    fromName: "Ada",
    fromEmail: "ada@example.test",
    bodyText: "PRIVATE_FULL_EMAIL_BODY",
  });
  const startedAt = new Date(Date.now() - 120_000);
  const finishedAt = new Date(startedAt.getTime() + 30_000);
  const analysis = await insert(MailInboundAnalysis, {
    companyId: sourceCompanyId,
    accountId: account.id,
    threadId: thread.id,
    messageId: message.id,
    employeeId: employee.id,
    status: "succeeded",
    category: "quote_request",
    summary: "A newer verdict must not replace the recorded one.",
    actionsJson: JSON.stringify([{ kind: "draft_reply", bodyText: "PRIVATE_ACTION_BODY" }]),
    finishedAt,
    updatedAt: finishedAt,
  });
  const event = await insert(AuditEvent, {
    companyId: company.id,
    actorKind: "ai",
    actorEmployeeId: employee.id,
    action: "mail.analysis.completed",
    targetType: "mail_inbound_analysis",
    targetId: analysis.id,
    targetLabel: "Do not trust a raw audit label token=label-secret",
    createdAt: finishedAt,
    metadataJson: JSON.stringify({
      messageId: message.id,
      mailThreadId: thread.id,
      accountId: account.id,
      attemptStartedAt: startedAt.toISOString(),
      privatePayload: "PRIVATE_AUDIT_PAYLOAD",
      analysisSnapshot: {
        version: 1,
        status: "completed",
        durationMs: 30_000,
        category: "quote_request",
        summary: "Ada requested an estimate. token=summary-secret",
        suggestedActions: ["Prepare an estimate"],
        bodyText: "PRIVATE_SNAPSHOT_BODY",
      },
    }),
  });
  return { account, thread, message, analysis, event };
}

describe("email analysis timeline response", () => {
  test("ordinary Members receive the recorded review and email link without raw payloads", async () => {
    const { account, thread, event } = await seedEmailAnalysis();
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(status, 200);
    const entry = body.entries.find((entry) => entry.id === `effect:${event.id}`)!;
    assert.equal(entry.subject, "Estimate for the September rollout");
    assert.equal(entry.source?.kind, "mail_thread");
    assert.equal(entry.source?.id, thread.id);
    assert.equal(entry.source?.accountId, account.id);
    assert.equal(entry.analysis?.status, "completed");
    assert.equal(entry.analysis?.category, "quote_request");
    assert.equal(entry.analysis?.resultAvailable, true);
    assert.equal(entry.analysis?.durationMs, 30_000);
    assert.match(entry.analysis?.summary ?? "", /Ada requested an estimate/);
    assert.match(entry.analysis?.summary ?? "", /redacted/);
    assert.deepEqual(entry.analysis?.suggestedActions, ["Prepare an estimate"]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /PRIVATE_|summary-secret|label-secret|newer verdict|metadataJson|actionsJson|bodyText/,
    );
    assert.equal((await call("GET", "/audit")).status, 403);
  });

  test("a non-Member cannot access an enriched review", async () => {
    await seedEmailAnalysis();
    actingUserId = outsider.id;
    const { status, body } = await call("GET", "/work-timeline");
    assert.equal(status, 403);
    assert.doesNotMatch(JSON.stringify(body), /Ada|September|support@example|PRIVATE_/);
  });

  test("an audit reference into another company exposes no email or result details", async () => {
    const { event } = await seedEmailAnalysis(otherCompany.id);
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(status, 200);
    const entry = body.entries.find((entry) => entry.id === `effect:${event.id}`)!;
    assert.equal(entry.source, null);
    assert.equal(entry.subject, "");
    assert.equal(entry.analysis?.resultAvailable, false);
    assert.doesNotMatch(
      JSON.stringify(body),
      /Ada|September|example\.test|PRIVATE_|summary-secret|label-secret|newer verdict/,
    );
  });

  test("deleting the source message removes the preview and source link", async () => {
    const { message, event } = await seedEmailAnalysis();
    await AppDataSource.getRepository(MailMessage).delete(message.id);
    const { body } = await call<TimelineBody>("GET", "/work-timeline");
    const entry = body.entries.find((entry) => entry.id === `effect:${event.id}`)!;
    assert.equal(entry.source, null);
    assert.equal(entry.subject, "");
    assert.equal(entry.analysis?.resultAvailable, false);
    assert.doesNotMatch(JSON.stringify(body), /Ada|September|example\.test|PRIVATE_|label-secret/);
  });
});

describe("work timeline authorization", () => {
  test("an unauthenticated caller is rejected", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/work-timeline")).status, 401);
  });

  test("a non-member of the company is rejected", async () => {
    actingUserId = outsider.id;
    assert.equal((await call("GET", "/work-timeline")).status, 403);
  });

  test("a member of another company cannot read this one", async () => {
    assert.equal((await call("GET", "/work-timeline", otherCompany.id)).status, 403);
  });

  test("an ordinary member reads it, while the audit log still refuses them", async () => {
    // The asymmetry is the point. Browsing the company's whole history is an
    // admin tool behind a paid feature; seeing what your own AI employees did
    // today is the minimum needed to trust them, and is neither.
    await seedRun();
    const timeline = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.entryCount, 1);

    assert.equal((await call("GET", "/audit")).status, 403);
  });
});

describe("work timeline responses", () => {
  test("ordinary Members receive the concise outcome, not the source transcript", async () => {
    await seedRun({
      logContent:
        "[tool:connection_call] ok — private-tool-payload\nSaved 6 Contacts. Drafted 4 messages. Details follow.[tokens] in=80 out=30",
    });
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(status, 200);
    assert.equal(body.entries[0].run?.summary, "Saved 6 Contacts. Drafted 4 messages.");
    assert.doesNotMatch(
      JSON.stringify(body),
      /private-tool-payload|connection_call|Details follow|logContent/,
    );
  });
  test("the API scrubs formatted credentials in historical outcomes", async () => {
    await seedRun({ logContent: "Saved the report using **password**: hidden-value." });
    const { body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.match(body.entries[0].run?.summary ?? "", /redacted/);
    assert.doesNotMatch(JSON.stringify(body), /hidden-value/);
  });
  test("missing and unfinished reports have a nullable summary", async () => {
    await seedRun({ status: "running", logContent: "Everything is complete." });
    const { body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(body.entries[0].run?.summary, null);
  });
  test("explicit verification failures stay independent of the outcome text", async () => {
    await seedRun({
      logContent: "Prepared the report.",
      outcomeVerdict: "off_goal",
      checksVerdict: "failed",
    });
    const { body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(body.entries[0].run?.summary, "Prepared the report.");
    assert.equal(body.entries[0].run?.outcomeVerdict, "off_goal");
    assert.equal(body.entries[0].run?.checksVerdict, "failed");
  });
  test("returns the documented shape with the default 24-hour window", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline");
    assert.equal(status, 200);
    assert.equal(body.employeeId, null);
    assert.equal(body.entryCount, 1);
    assert.equal(body.entries[0].kind, "run");
    assert.equal(body.entries[0].active, false);
    assert.deepEqual(body.employeeSummaries, [
      {
        employeeId: employee.id,
        entryCount: 1,
        latest: {
          id: body.entries[0].id,
          kind: "run",
          at: body.entries[0].at,
          title: "Ran Nightly digest",
          detail: "",
          active: false,
        },
        current: null,
        waiting: null,
      },
    ]);
    assert.equal(
      new Date(body.until).getTime() - new Date(body.since).getTime(),
      24 * 60 * 60 * 1000,
    );
  });

  test("honours hours and limit together", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>("GET", "/work-timeline?hours=48&limit=5");
    assert.equal(status, 200);
    assert.equal(
      new Date(body.until).getTime() - new Date(body.since).getTime(),
      48 * 60 * 60 * 1000,
    );
    assert.ok(body.entries.length <= 5);
  });

  test("narrows to one employee and echoes the id back", async () => {
    await seedRun();
    const { status, body } = await call<TimelineBody>(
      "GET",
      `/work-timeline?employeeId=${employee.id}`,
    );
    assert.equal(status, 200);
    assert.equal(body.employeeId, employee.id);
    assert.equal(body.entryCount, 1);
    assert.deepEqual(
      body.employeeSummaries.map((row) => row.employeeId),
      [employee.id],
    );
  });

  test("accepts a local calendar day and returns only its work", async () => {
    const until = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
    const saved = await seedRun({ startedAt: since });
    await insert(Run, { ...saved, id: undefined, startedAt: until });
    const query = new URLSearchParams({
      employeeId: employee.id,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    const { status, body } = await call<TimelineBody>("GET", `/work-timeline?${query}`);
    assert.equal(status, 200);
    assert.equal(body.since, since.toISOString());
    assert.equal(body.until, until.toISOString());
    assert.equal(body.entryCount, 1);
    assert.equal(body.entries[0].at, since.toISOString());
  });
});

describe("work timeline query validation", () => {
  const rejected = [
    "?hours=0",
    "?hours=169",
    "?hours=notanumber",
    "?limit=0",
    "?limit=201",
    "?employeeId=not-a-uuid",
    // `.strict()` — an unknown parameter is a caller bug, not something to
    // silently ignore.
    "?bogus=1",
  ];
  for (const query of rejected) {
    test(`rejects ${query}`, async () => {
      const { status, body } = await call<{ error: string }>("GET", `/work-timeline${query}`);
      assert.equal(status, 400);
      assert.equal(body.error, "ValidationError");
    });
  }

  test("accepts the boundary values on either end", async () => {
    assert.equal((await call("GET", "/work-timeline?hours=1&limit=1")).status, 200);
    assert.equal((await call("GET", "/work-timeline?hours=168&limit=200")).status, 200);
  });

  test("accepts 23- and 25-hour days across daylight saving changes", async () => {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const hours of [23, 25]) {
      const query = new URLSearchParams({
        employeeId: employee.id,
        since: since.toISOString().replace("Z", "+00:00"),
        until: new Date(since.getTime() + hours * 60 * 60 * 1000).toISOString(),
      });
      const { status, body } = await call<TimelineBody>("GET", `/work-timeline?${query}`);
      assert.equal(status, 200);
      assert.equal(Date.parse(body.until) - Date.parse(body.since), hours * 60 * 60 * 1000);
    }
  });

  test("rejects incomplete, unscoped and unbounded calendar windows", async () => {
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const date = (offset: number) => new Date(now + offset * hour).toISOString();
    const valid = { employeeId: employee.id, since: date(-48), until: date(-24) };
    const rejected: Record<string, string>[] = [
      { employeeId: employee.id, since: valid.since },
      { employeeId: employee.id, until: valid.until },
      { since: valid.since, until: valid.until },
      { ...valid, since: "yesterday" },
      { ...valid, until: "tomorrow" },
      { ...valid, until: valid.since },
      { ...valid, until: date(-49) },
      { ...valid, until: date(-22) },
      { ...valid, since: date(-170), until: date(-146) },
      { ...valid, since: date(1), until: date(25) },
      { ...valid, since: date(-1), until: date(26) },
    ];
    for (const params of rejected) {
      const query = new URLSearchParams(params);
      const { status } = await call("GET", `/work-timeline?${query}`);
      assert.equal(status, 400, query.toString());
    }
  });
});
