import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunLesson } from "../db/entities/RunLesson.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  getEmployeeWorkTimeline,
  WORK_EFFECT_CAP,
  WorkEntry,
  WorkEntryKind,
} from "./employeeWorkTimeline.js";

/**
 * The work timeline is assembled from seven tables at read time, three of
 * which carry no `companyId` of their own, and it deliberately reads
 * `audit_events` on a path that is neither admin-gated nor behind the
 * `auditLog` entitlement. That combination is exactly where a cross-tenant
 * leak or a quietly-widened disclosure would hide, so most of what follows
 * pins scoping and visibility rather than shape.
 *
 * The rest pins the two things that are easy to "fix" wrongly later: this is a
 * record and not a queue (a dismissed failure still happened), and every one of
 * the six non-audit sources is here because audit provably misses it — delete
 * one and its test goes red rather than the surface going quietly thin.
 */

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const HOUR = 60 * 60 * 1000;

let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;
let other: AIEmployee;
let routine: Routine;

beforeEach(async () => {
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  member = await insert(User, { email: "member@example.test", name: "Member", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
  other = await insert(AIEmployee, {
    companyId: company.id,
    name: "Kaz",
    slug: "kaz",
    role: "Finance",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
    body: "",
  });
});

/** The timeline as the ordinary Member sees it, unless told otherwise. */
async function timeline(overrides: Partial<Parameters<typeof getEmployeeWorkTimeline>[0]> = {}) {
  return getEmployeeWorkTimeline({
    companyId: company.id,
    userId: member.id,
    role: "member",
    ...overrides,
  });
}

function kinds(entries: WorkEntry[]): WorkEntryKind[] {
  return entries.map((e) => e.kind);
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

async function run(overrides: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    routineId: routine.id,
    status: "completed",
    logContent: "",
    triggerKind: "schedule",
    startedAt: ago(2 * HOUR),
    exitCode: 0,
    ...overrides,
  });
}

async function conversation(overrides: Partial<Conversation> = {}): Promise<Conversation> {
  return insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: member.id,
    title: "Invoice chase",
    source: "web",
    ...overrides,
  });
}

async function assistantMessage(
  conversationId: string,
  overrides: Partial<ConversationMessage> = {},
): Promise<ConversationMessage> {
  return insert(ConversationMessage, {
    conversationId,
    role: "assistant",
    content: "on it",
    createdAt: ago(HOUR),
    ...overrides,
  });
}

async function auditRow(overrides: Partial<AuditEvent> = {}): Promise<AuditEvent> {
  return insert(AuditEvent, {
    companyId: company.id,
    actorKind: "ai",
    actorUserId: null,
    actorEmployeeId: employee.id,
    action: "invoice.create",
    targetType: "invoice",
    targetId: testId("invoice"),
    targetLabel: "INV-1001",
    metadataJson: "",
    createdAt: ago(HOUR),
    ...overrides,
  });
}

async function approval(overrides: Partial<Approval> = {}): Promise<Approval> {
  return insert(Approval, {
    companyId: company.id,
    kind: "browser_action",
    routineId: routine.id,
    employeeId: employee.id,
    title: "Submit the form",
    summary: "Send reviewed data",
    payloadJson: "{}",
    status: "pending",
    requestedAt: ago(HOUR),
    decidedAt: null,
    decidedByUserId: null,
    ...overrides,
  });
}

// ─────────────────────────── the window ──────────────────────────────────

describe("work timeline window", () => {
  test("includes work inside the window and excludes work outside it", async () => {
    await run({ startedAt: ago(2 * HOUR) });
    await run({ startedAt: ago(26 * HOUR) });

    const result = await timeline();
    assert.equal(result.entryCount, 1);
    assert.equal(result.entries[0].kind, "run");
  });

  test("honours a wider window rather than hard-coding 24 hours", async () => {
    await run({ startedAt: ago(26 * HOUR) });

    assert.equal((await timeline()).entryCount, 0);
    assert.equal((await timeline({ hours: 168 })).entryCount, 1);
  });

  test("reports the window it actually used", async () => {
    const result = await timeline({ hours: 48 });
    const span = new Date(result.until).getTime() - new Date(result.since).getTime();
    assert.equal(span, 48 * HOUR);
  });

  test("keeps an old running Run out of recent history but marks the employee as working now", async () => {
    const oldRun = await run({
      startedAt: ago(30 * HOUR),
      status: "running",
      finishedAt: null,
      exitCode: null,
    });
    const result = await timeline();
    const summary = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(result.entryCount, 0);
    assert.equal(summary.current?.id, `run:${oldRun.id}`);
    assert.equal(summary.current?.active, true);
  });

  test("marks an old durable Chat turn as current without moving it into recent history", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id, {
      status: "working",
      createdAt: ago(30 * HOUR),
      updatedAt: ago(30 * HOUR),
      progressLabel: "Still reconciling",
      progressPercent: 80,
    });
    const result = await timeline();
    const summary = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(result.entryCount, 0);
    assert.equal(summary.current?.id, `chat:${conv.id}`);
    assert.equal(summary.current?.detail, "Still reconciling · 80%");
  });

  test("marks old Repository work as current without moving it into recent history", async () => {
    const session = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: testId("repo"),
      employeeId: employee.id,
      title: "Long migration",
      instruction: "move the records",
      status: "running",
    });
    const turn = await insert(RepositoryWorkSessionTurn, {
      companyId: company.id,
      sessionId: session.id,
      ordinal: 1,
      instruction: "move the records",
      status: "running",
      finishedAt: null,
      createdAt: ago(30 * HOUR),
    });
    const result = await timeline();
    const summary = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(result.entryCount, 0);
    assert.equal(summary.current?.id, `work_session:${turn.id}`);
  });

  test("keeps an old unresolved Approval visible as waiting without changing recent history", async () => {
    const pending = await approval({ requestedAt: ago(30 * HOUR) });
    const result = await timeline();
    const summary = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(result.entryCount, 0);
    assert.equal(summary.waiting?.id, `approval:${pending.id}`);
    assert.equal(summary.waiting?.title, "Approval required: Submit the form");
  });
});

// ───────────────────────── company scoping ───────────────────────────────

describe("work timeline company scoping", () => {
  test("never shows a run belonging to another company's employee", async () => {
    // `runs` has no companyId — the only thing keeping this out is the hop
    // through routines.employeeId to ai_employees.companyId.
    const otherOwner = await insert(User, {
      email: "rival@example.test",
      name: "Rival",
      passwordHash: "x",
    });
    const rival = await insert(Company, { name: "Rival", slug: "rival", ownerId: otherOwner.id });
    const rivalEmployee = await insert(AIEmployee, {
      companyId: rival.id,
      name: "Spy",
      slug: "spy",
      role: "Ops",
      soulBody: "",
    });
    const rivalRoutine = await insert(Routine, {
      employeeId: rivalEmployee.id,
      name: "Rival nightly",
      slug: "rival-nightly",
      cronExpr: "0 3 * * *",
      body: "",
    });
    await insert(Run, {
      routineId: rivalRoutine.id,
      status: "completed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: ago(HOUR),
      exitCode: 0,
    });

    const result = await timeline();
    assert.equal(result.entryCount, 0);
  });

  test("never shows an assistant message from another company's conversation", async () => {
    const otherOwner = await insert(User, {
      email: "rival2@example.test",
      name: "Rival",
      passwordHash: "x",
    });
    const rival = await insert(Company, { name: "Rival", slug: "rival2", ownerId: otherOwner.id });
    const rivalEmployee = await insert(AIEmployee, {
      companyId: rival.id,
      name: "Spy",
      slug: "spy",
      role: "Ops",
      soulBody: "",
    });
    const conv = await insert(Conversation, {
      employeeId: rivalEmployee.id,
      ownerUserId: otherOwner.id,
      title: "Rival strategy",
      source: "web",
    });
    await assistantMessage(conv.id);

    const result = await timeline();
    assert.equal(result.entryCount, 0);
  });

  test("never shows an audit row from another company, even with a matching actor", async () => {
    await auditRow({ companyId: "co_somewhere_else", targetLabel: "Not yours" });
    assert.equal((await timeline()).entryCount, 0);
  });
});

// ───────────────────── one test per unioned source ───────────────────────

describe("work timeline sources", () => {
  test("a scheduled run appears even though it writes no audit row", async () => {
    // This is the whole reason `runs` is unioned onto the audit spine.
    await run({ triggerKind: "schedule" });
    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["run"]);
    assert.equal(result.entries[0].title, "Ran Nightly digest");
    assert.equal(result.entries[0].run?.routineId, routine.id);
  });

  test("marks only a running Run as live, even when terminal rows have no finish timestamp", async () => {
    const statuses = [
      "running",
      "completed",
      "failed",
      "skipped",
      "timeout",
      "interrupted",
    ] as const;
    const expected = new Map<string, boolean>();
    for (const [index, status] of statuses.entries()) {
      const row = await run({
        status,
        startedAt: ago((index + 1) * 10 * 60 * 1000),
        finishedAt: null,
        exitCode: status === "completed" ? 0 : null,
      });
      expected.set(`run:${row.id}`, status === "running");
    }
    const result = await timeline();
    for (const entry of result.entries)
      assert.equal(entry.active, expected.get(entry.id), entry.id);
  });

  test("collapses many replies in one conversation into a single entry", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id, { createdAt: ago(3 * HOUR) });
    await assistantMessage(conv.id, { createdAt: ago(2 * HOUR) });
    await assistantMessage(conv.id, { createdAt: ago(HOUR) });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["chat"]);
    assert.equal(result.entries[0].detail, "3 replies");
    assert.equal(result.entries[0].title, "Replied in Invoice chase");
  });

  test("marks a durable chat turn as current work and carries its safe progress", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id, {
      status: "working",
      progressPercent: 40,
      progressLabel: "Researching the customer",
    });

    const result = await timeline();
    const entry = result.entries[0];
    assert.equal(entry.kind, "chat");
    assert.equal(entry.active, true);
    assert.equal(entry.endedAt, null);
    assert.equal(entry.title, "Working on Invoice chase");
    assert.equal(entry.detail, "Researching the customer · 40%");
    assert.equal(
      result.employeeSummaries.find((row) => row.employeeId === employee.id)?.current?.id,
      entry.id,
    );
  });

  test("does not disclose another Member's live conversation or progress", async () => {
    const conv = await conversation({
      ownerUserId: owner.id,
      title: "Confidential acquisition",
    });
    await assistantMessage(conv.id, {
      status: "working",
      progressPercent: 70,
      progressLabel: "Reading the confidential offer",
    });

    const asMember = await timeline();
    assert.equal(asMember.entries[0].active, true);
    assert.equal(asMember.entries[0].title, "Working on a private conversation");
    assert.equal(asMember.entries[0].detail, "Working on a reply");
    assert.ok(!JSON.stringify(asMember.employeeSummaries).includes("confidential"));

    const asOwner = await timeline({ userId: owner.id, role: "owner" });
    assert.equal(asOwner.entries[0].title, "Working on Confidential acquisition");
    assert.equal(asOwner.entries[0].detail, "Reading the confidential offer · 70%");
  });

  test("marks a finished conversation as recent rather than live", async () => {
    const conv = await conversation();
    const finishedAt = ago(5 * 60 * 1000);
    await assistantMessage(conv.id, {
      status: "ok",
      createdAt: ago(3 * HOUR),
      updatedAt: finishedAt,
    });
    const entry = (await timeline()).entries[0];
    assert.equal(entry.active, false);
    assert.ok(entry.endedAt);
    assert.equal(entry.at, finishedAt.toISOString());
  });

  test("says 'reply' in the singular for one turn", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id);
    assert.equal((await timeline()).entries[0].detail, "1 reply");
  });

  test("gives two conversations two entries", async () => {
    const a = await conversation({ title: "First" });
    const b = await conversation({ title: "Second" });
    await assistantMessage(a.id);
    await assistantMessage(b.id);
    assert.equal((await timeline()).entryCount, 2);
  });

  test("ignores the human half of a conversation", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id, { role: "user", content: "please chase this" });
    assert.equal((await timeline()).entryCount, 0);
  });

  test("names the surface for a conversation that came in from outside", async () => {
    const conv = await conversation({ source: "telegram", externalKey: "42" });
    await assistantMessage(conv.id);
    assert.equal((await timeline()).entries[0].detail, "1 reply · telegram");
  });

  test("an action that requires Approval appears as work waiting on the system gate", async () => {
    await approval();
    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["approval"]);
    assert.equal(result.entries[0].title, "Approval required: Submit the form");
    assert.equal(result.entries[0].detail, "pending");
  });

  test("a decided Approval remains recent work but is no longer waiting", async () => {
    await approval({ status: "approved", decidedAt: ago(30 * 60 * 1000) });
    const result = await timeline();
    const summary = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(summary.entryCount, 1);
    assert.equal(summary.waiting, null);
    assert.equal(summary.current, null);
  });

  test("a fired wakeup appears; a pending or cancelled one does not", async () => {
    await insert(EmployeeWakeup, {
      companyId: company.id,
      employeeId: employee.id,
      at: ago(2 * HOUR),
      brief: "check the invoice",
      status: "fired",
      firedAt: ago(HOUR),
    });
    await insert(EmployeeWakeup, {
      companyId: company.id,
      employeeId: employee.id,
      at: ago(HOUR),
      brief: "later",
      status: "pending",
      firedAt: null,
    });
    await insert(EmployeeWakeup, {
      companyId: company.id,
      employeeId: employee.id,
      at: ago(HOUR),
      brief: "never mind",
      status: "cancelled",
      firedAt: null,
    });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["wakeup"]);
  });

  test("a lesson taken from a run appears", async () => {
    const r = await run();
    await insert(RunLesson, {
      companyId: company.id,
      employeeId: employee.id,
      routineId: routine.id,
      runId: r.id,
      cause: "The export timed out",
      advice: "Page the export next time",
    });

    const result = await timeline();
    assert.ok(kinds(result.entries).includes("lesson"));
    const lesson = result.entries.find((e) => e.kind === "lesson")!;
    assert.match(lesson.title, /The export timed out/);
    assert.equal(lesson.detail, "Page the export next time");
  });

  test("a finished repository turn carries its diff stats", async () => {
    const session = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: testId("repo"),
      employeeId: employee.id,
      title: "Fix the webhook retry",
      instruction: "retry on 5xx",
      status: "ready",
    });
    await insert(RepositoryWorkSessionTurn, {
      companyId: company.id,
      sessionId: session.id,
      ordinal: 1,
      instruction: "retry on 5xx",
      status: "ok",
      filesChanged: 3,
      insertions: 40,
      deletions: 4,
      finishedAt: ago(HOUR),
    });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["work_session"]);
    assert.equal(result.entries[0].title, "Worked in Fix the webhook retry");
    assert.equal(result.entries[0].detail, "3 files · +40 · −4");
  });

  test("a still-running repository turn windows on when it started", async () => {
    const session = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: testId("repo"),
      employeeId: employee.id,
      title: "Long refactor",
      instruction: "split the module",
      status: "running",
    });
    await insert(RepositoryWorkSessionTurn, {
      companyId: company.id,
      sessionId: session.id,
      ordinal: 1,
      instruction: "split the module",
      status: "running",
      finishedAt: null,
      createdAt: ago(2 * HOUR),
    });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["work_session"]);
    assert.equal(result.entries[0].detail, "in progress");
    assert.equal(result.entries[0].active, true);
    assert.equal(
      result.employeeSummaries.find((row) => row.employeeId === employee.id)?.current?.id,
      result.entries[0].id,
    );
  });
});

// ─────────────────────────── the ledger ──────────────────────────────────

describe("work timeline effects", () => {
  test("an audit row from inside a run nests under that run", async () => {
    const r = await run({ startedAt: ago(3 * HOUR) });
    await auditRow({ runId: r.id, targetLabel: "INV-2001" });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["run"]);
    assert.equal(result.entries[0].effectCount, 1);
    assert.equal(result.entries[0].effects[0].targetLabel, "INV-2001");
  });

  test("an audit row from inside a chat nests under that conversation", async () => {
    const conv = await conversation();
    await assistantMessage(conv.id, { createdAt: ago(2 * HOUR) });
    await auditRow({ conversationId: conv.id, targetLabel: "INV-3001" });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["chat"]);
    assert.equal(result.entries[0].effectCount, 1);
  });

  test("an audit row with no run and no conversation stands on its own", async () => {
    await auditRow({ targetLabel: "INV-4001" });
    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["effect"]);
    assert.equal(result.entries[0].title, "INV-4001");
    assert.equal(result.entries[0].detail, "invoice.create");
  });

  test("a row whose run fell outside the window still surfaces rather than vanishing", async () => {
    const old = await run({ startedAt: ago(40 * HOUR) });
    await auditRow({ runId: old.id, targetLabel: "INV-5001" });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["effect"]);
    assert.equal(result.entries[0].title, "INV-5001");
  });

  test("effects read oldest first inside an entry while entries read newest first", async () => {
    const r = await run({ startedAt: ago(5 * HOUR) });
    await auditRow({ runId: r.id, targetLabel: "first", createdAt: ago(4 * HOUR) });
    await auditRow({ runId: r.id, targetLabel: "second", createdAt: ago(3 * HOUR) });
    await auditRow({ runId: r.id, targetLabel: "third", createdAt: ago(2 * HOUR) });

    const result = await timeline();
    assert.deepEqual(
      result.entries[0].effects.map((e) => e.targetLabel),
      ["first", "second", "third"],
    );
  });

  test("caps the effects it renders while reporting the true total", async () => {
    const r = await run({ startedAt: ago(6 * HOUR) });
    const total = WORK_EFFECT_CAP + 4;
    for (let i = 0; i < total; i++) {
      await auditRow({
        runId: r.id,
        targetLabel: `row ${i}`,
        createdAt: new Date(Date.now() - 5 * HOUR + i * 1000),
      });
    }

    const result = await timeline();
    assert.equal(result.entries[0].effects.length, WORK_EFFECT_CAP);
    assert.equal(result.entries[0].effectCount, total);
  });
});

// ──────────────────── ordering, limits, the filter ───────────────────────

describe("work timeline ordering and limits", () => {
  test("orders mixed kinds strictly newest first", async () => {
    await run({ startedAt: ago(3 * HOUR) });
    const conv = await conversation();
    const chatAt = ago(2 * HOUR);
    await assistantMessage(conv.id, { createdAt: chatAt, updatedAt: chatAt });
    await approval({ requestedAt: ago(HOUR) });

    const result = await timeline();
    assert.deepEqual(kinds(result.entries), ["approval", "chat", "run"]);
  });

  test("slices from the newest end and still reports the true total", async () => {
    for (let i = 1; i <= 5; i++) await run({ startedAt: ago(i * HOUR) });

    const result = await timeline({ limit: 2 });
    assert.equal(result.entries.length, 2);
    assert.equal(result.entryCount, 5);
    const [newest, next] = result.entries;
    assert.ok(newest.at > next.at, `${newest.at} should be newer than ${next.at}`);
  });

  test("rolls up every employee before the visible timeline is sliced", async () => {
    const quiet = await insert(AIEmployee, {
      companyId: company.id,
      name: "Mina",
      slug: "mina",
      role: "Research",
      soulBody: "",
    });
    const otherRoutine = await insert(Routine, {
      employeeId: other.id,
      name: "Ledger close",
      slug: "ledger-close",
      cronExpr: "0 4 * * *",
      body: "",
    });
    const activeRun = await insert(Run, {
      routineId: otherRoutine.id,
      status: "running",
      logContent: "",
      triggerKind: "schedule",
      startedAt: ago(3 * HOUR),
      exitCode: null,
      finishedAt: null,
    });
    const pending = await approval({ requestedAt: ago(2 * HOUR) });
    const latest = await run({ startedAt: ago(HOUR) });

    const result = await timeline({ limit: 1 });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, `run:${latest.id}`);
    assert.equal(result.employeeSummaries.length, 3);

    const reyActivity = result.employeeSummaries.find((row) => row.employeeId === employee.id)!;
    assert.equal(reyActivity.entryCount, 2);
    assert.equal(reyActivity.latest?.id, `run:${latest.id}`);
    assert.equal(reyActivity.waiting?.id, `approval:${pending.id}`);
    assert.equal(reyActivity.current, null);

    const kazActivity = result.employeeSummaries.find((row) => row.employeeId === other.id)!;
    assert.equal(kazActivity.current?.id, `run:${activeRun.id}`);
    assert.equal(kazActivity.current?.active, true);

    assert.deepEqual(
      result.employeeSummaries.find((row) => row.employeeId === quiet.id),
      {
        employeeId: quiet.id,
        entryCount: 0,
        latest: null,
        current: null,
        waiting: null,
      },
    );
  });

  test("narrows to one employee across every source", async () => {
    const otherRoutine = await insert(Routine, {
      employeeId: other.id,
      name: "Ledger close",
      slug: "ledger-close",
      cronExpr: "0 4 * * *",
      body: "",
    });
    await insert(Run, {
      routineId: otherRoutine.id,
      status: "completed",
      logContent: "",
      triggerKind: "schedule",
      startedAt: ago(HOUR),
      exitCode: 0,
    });
    await auditRow({ actorEmployeeId: other.id, targetLabel: "Kaz wrote this" });
    await run();

    const all = await timeline();
    assert.equal(all.entryCount, 3);

    const mine = await timeline({ employeeId: employee.id });
    assert.deepEqual(kinds(mine.entries), ["run"]);
    assert.equal(mine.employeeId, employee.id);
    assert.deepEqual(
      mine.employeeSummaries.map((row) => row.employeeId),
      [employee.id],
    );
  });

  test("an employee id from another company narrows to nothing rather than 404ing", async () => {
    const otherOwner = await insert(User, {
      email: "rival3@example.test",
      name: "Rival",
      passwordHash: "x",
    });
    const rival = await insert(Company, { name: "Rival", slug: "rival3", ownerId: otherOwner.id });
    const rivalEmployee = await insert(AIEmployee, {
      companyId: rival.id,
      name: "Spy",
      slug: "spy",
      role: "Ops",
      soulBody: "",
    });
    await run();

    const result = await timeline({ employeeId: rivalEmployee.id });
    assert.equal(result.entryCount, 0);
    assert.equal(result.employeeId, rivalEmployee.id);
  });

  test("echoes a null employee for the whole roster", async () => {
    assert.equal((await timeline()).employeeId, null);
  });

  test("a company with no AI employees returns an empty timeline", async () => {
    const otherOwner = await insert(User, {
      email: "quiet@example.test",
      name: "Quiet",
      passwordHash: "x",
    });
    const quiet = await insert(Company, { name: "Quiet", slug: "quiet", ownerId: otherOwner.id });
    const result = await getEmployeeWorkTimeline({
      companyId: quiet.id,
      userId: otherOwner.id,
      role: "owner",
    });
    assert.deepEqual(result.entries, []);
    assert.equal(result.entryCount, 0);
  });
});

// ─────────────────────────── visibility ──────────────────────────────────

describe("work timeline visibility", () => {
  test("redacts credential material out of approval copy for every role", async () => {
    await approval({
      title: "Replay POST with Authorization: Bearer sk-live-abc123",
      summary: "token=hunter2 was in the query string",
    });
    for (const [user, role] of [
      [owner, "owner"],
      [member, "member"],
    ] as const) {
      const result = await timeline({ userId: user.id, role });
      assert.equal(result.entryCount, 1);
      assert.ok(!result.entries[0].title.includes("sk-live-abc123"), result.entries[0].title);
    }
  });

  test("redacts credential material out of a ledger row's label", async () => {
    await auditRow({ targetLabel: "GET /export?api_key=sk-live-zzz" });
    const result = await timeline();
    assert.ok(!result.entries[0].title.includes("sk-live-zzz"), result.entries[0].title);
  });

  test("redacts a run's outcome note", async () => {
    await run({
      outcomeVerdict: "achieved",
      outcomeNote: "signed in with password=hunter2 and finished",
      outcomeCheckedAt: ago(HOUR),
    });
    const note = (await timeline()).entries[0].run?.outcomeNote ?? "";
    assert.ok(!note.includes("hunter2"), note);
  });

  test("hides Vault capture approvals from a Member, as the approvals inbox does", async () => {
    await approval({
      title: "Save the login for shop.example.test",
      payloadJson: JSON.stringify({ action: "vault_capture" }),
    });
    await approval({ title: "Ordinary submit", payloadJson: JSON.stringify({ action: "submit" }) });

    const asMember = await timeline();
    assert.equal(asMember.entryCount, 1);
    assert.match(asMember.entries[0].title, /Ordinary submit/);

    const asOwner = await timeline({ userId: owner.id, role: "owner" });
    assert.equal(asOwner.entryCount, 2);
  });

  test("hides vault ledger rows from a Member and shows them to an admin", async () => {
    await auditRow({ action: "vault.item.use", targetType: "vault_item", targetLabel: "AWS root" });

    const asMember = await timeline();
    assert.equal(asMember.entryCount, 0);
    assert.ok(asMember.employeeSummaries.every((row) => row.entryCount === 0));
    assert.equal((await timeline({ userId: owner.id, role: "owner" })).entryCount, 1);
  });

  test("hides a todo label from a Member shut out of its restricted project", async () => {
    const project = await insert(Project, {
      companyId: company.id,
      name: "Board",
      slug: "board",
      key: "BRD",
      accessMode: "restricted",
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Renegotiate the lease",
      status: "todo",
      priority: "none",
    });
    await auditRow({ targetType: "todo", targetId: todo.id, targetLabel: todo.title });

    assert.equal((await timeline()).entryCount, 0);
    assert.equal((await timeline({ userId: owner.id, role: "owner" })).entryCount, 1);

    // …and it comes back the moment the Member is actually on the project.
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "user",
      userId: member.id,
      accessLevel: "read",
    });
    assert.equal((await timeline()).entryCount, 1);
  });

  test("shows a todo label from an open project to an ordinary Member", async () => {
    const project = await insert(Project, {
      companyId: company.id,
      name: "Board",
      slug: "board",
      key: "BRD",
      accessMode: "open",
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Order the coffee",
      status: "todo",
      priority: "none",
    });
    await auditRow({ targetType: "todo", targetId: todo.id, targetLabel: todo.title });

    assert.equal((await timeline()).entries[0].title, "Order the coffee");
  });

  test("never names another Member's conversation", async () => {
    // A transcript is private to the Member who requested it. The work is still
    // reported — its subject is not.
    const conv = await conversation({ ownerUserId: owner.id, title: "Salary review for Dana" });
    await assistantMessage(conv.id);

    const asMember = await timeline();
    assert.deepEqual(kinds(asMember.entries), ["chat"]);
    assert.ok(!asMember.entries[0].title.includes("Dana"), asMember.entries[0].title);
    assert.equal(asMember.entries[0].title, "Replied in a private conversation");

    const asOwner = await timeline({ userId: owner.id, role: "owner" });
    assert.equal(asOwner.entries[0].title, "Replied in Salary review for Dana");
  });
});

// ─────────────────── a record, not a queue; verdicts ─────────────────────

describe("work timeline is a record, not a queue", () => {
  test("still shows a failure a Member has already dismissed", async () => {
    // Home's failed-routines panel drops these on purpose. This one must not:
    // acknowledging a failure does not un-happen it.
    await run({ status: "failed", exitCode: 1, dismissedAt: ago(30 * 60 * 1000) });
    assert.deepEqual(kinds((await timeline()).entries), ["run"]);
  });

  test("still shows a failure with a retry already queued", async () => {
    await run({ status: "failed", exitCode: 1, retryAt: new Date(Date.now() + HOUR) });
    assert.deepEqual(kinds((await timeline()).entries), ["run"]);
  });

  test("shows completed runs, not only broken ones", async () => {
    await run({ status: "completed", exitCode: 0 });
    assert.deepEqual(kinds((await timeline()).entries), ["run"]);
  });

  test("carries an unverified verdict through as unverified", async () => {
    // `unverified` is the absence of a judgement and `unclear` is a judgement.
    // Collapsing them is how a provider outage earns credit for a clean run.
    await run({ outcomeVerdict: "unverified", outcomeCheckedAt: ago(HOUR) });
    assert.equal((await timeline()).entries[0].run?.outcomeVerdict, "unverified");
  });

  test("carries a not_run checks verdict through rather than nulling it", async () => {
    await run({ checksVerdict: "not_run" });
    assert.equal((await timeline()).entries[0].run?.checksVerdict, "not_run");
  });

  test("reports a retry attempt and a non-schedule trigger in the detail line", async () => {
    await run({ triggerKind: "manual", attempt: 2 });
    assert.equal((await timeline()).entries[0].detail, "manual trigger · attempt 2");
  });
});
