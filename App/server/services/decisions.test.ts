import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../test/dbHarness.js";
import {
  cancelDecision,
  canDecide,
  createDecision,
  decideDecision,
  listDecisions,
  listPendingDecisions,
  normalizeDecisionOptions,
  parseDecisionOptions,
} from "./decisions.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

/** A company with one employee and one owner, wired well enough to notify. */
async function scenario(): Promise<{
  companyId: string;
  employeeId: string;
  ownerId: string;
  memberId: string;
}> {
  const companyId = testCompanyId();
  const owner = await insert(User, {
    email: `owner-${companyId}@example.test`,
    passwordHash: "x",
    name: "Ada Owner",
  });
  const member = await insert(User, {
    email: `member-${companyId}@example.test`,
    passwordHash: "x",
    name: "Mo Member",
  });
  await insert(Company, {
    id: companyId,
    name: "Acme",
    slug: `acme-${companyId.slice(3, 11)}`,
    ownerId: owner.id,
  });
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Rey",
    slug: `rey-${companyId.slice(3, 11)}`,
    role: "Support",
    soulBody: "",
  });
  await insert(Membership, { companyId, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId, userId: member.id, role: "member" });
  return { companyId, employeeId: employee.id, ownerId: owner.id, memberId: member.id };
}

async function stack(companyId: string, employeeId: string, overrides: Partial<Decision> = {}) {
  const { decision } = await createDecision({
    companyId,
    employeeId,
    title: "Send the pricing reply to Acme?",
    body: "Hi there — here is the quote you asked for.",
    options: [
      { label: "Send it", tone: "primary" },
      { label: "Hold for now" },
    ],
    ...overrides,
  });
  return decision;
}

describe("decision options", () => {
  test("labels become stable ids, and duplicates never collide", () => {
    const options = normalizeDecisionOptions([
      { label: "Send it" },
      { label: "Send it" },
      { label: "Hold" },
    ]);
    assert.deepEqual(
      options.map((o) => o.id),
      ["send-it", "send-it-2", "hold"],
    );
  });

  test("blank labels are dropped and the list is capped at six", () => {
    const options = normalizeDecisionOptions([
      { label: "   " },
      ...Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i}` })),
    ]);
    assert.equal(options.length, 6);
    assert.equal(options[0].label, "Option 0");
  });

  test("credential material in an option label is redacted before storage", () => {
    const [option] = normalizeDecisionOptions([
      { label: "Use Authorization: Bearer sk-live-123" },
    ]);
    assert.ok(!option.label.includes("sk-live-123"), option.label);
  });

  test("a corrupt options blob yields no buttons rather than throwing", () => {
    assert.deepEqual(parseDecisionOptions("not json"), []);
    assert.deepEqual(parseDecisionOptions('{"not":"an array"}'), []);
  });
});

describe("raising a decision", () => {
  test("scrubs the title and body, and pages the owners", async () => {
    const { companyId, employeeId, ownerId, memberId } = await scenario();
    const { decision } = await createDecision({
      companyId,
      employeeId,
      title: "Post this with token=hunter2?",
      body: "The draft says api_key: abcdef123456",
      options: [{ label: "Post it" }],
    });

    assert.ok(!decision.title.includes("hunter2"), decision.title);
    assert.ok(!decision.body.includes("abcdef123456"), decision.body);

    const notifications = await AppDataSource.getRepository(Notification).find({
      where: { companyId },
    });
    // Owners and admins are paged; a plain member is not, though they may still
    // answer it from the stack.
    assert.deepEqual(
      notifications.map((n) => n.userId),
      [ownerId],
    );
    assert.equal(notifications[0].kind, "decision_pending");
    assert.equal(notifications[0].entityId, decision.id);
    assert.notEqual(notifications[0].userId, memberId);
  });

  test("an assignee is paged instead of the owners", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    await createDecision({
      companyId,
      employeeId,
      title: "Which vendor?",
      options: [{ label: "Vendor A" }, { label: "Vendor B" }],
      assigneeUserId: memberId,
    });
    const notifications = await AppDataSource.getRepository(Notification).find({
      where: { companyId },
    });
    assert.deepEqual(
      notifications.map((n) => n.userId),
      [memberId],
    );
  });

  test("refuses a decision with no answerable option", async () => {
    const { companyId, employeeId } = await scenario();
    await assert.rejects(
      () =>
        createDecision({
          companyId,
          employeeId,
          title: "What now?",
          options: [{ label: "  " }],
        }),
      /at least one option/,
    );
  });
});

describe("answering a decision", () => {
  test("records the chosen option and journals it for the employee", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId);

    const result = await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: ownerId,
      role: "owner",
      optionId: "send-it",
      note: "Drop the discount line.",
    });

    assert.equal(result.outcome, "decided");
    assert.equal(result.outcome === "decided" && result.decision.chosenOptionId, "send-it");
    assert.equal(result.outcome === "decided" && result.decision.chosenOptionLabel, "Send it");
    assert.equal(result.outcome === "decided" && result.decision.note, "Drop the discount line.");

    // The employee learns the answer through its journal, which is injected
    // into its next prompt — that is the whole delivery mechanism.
    const entries = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId },
    });
    assert.equal(entries.length, 1);
    assert.match(entries[0].title, /Ada Owner decided .*: Send it/);
    assert.match(entries[0].body, /Drop the discount line\./);
  });

  test("an ordinary member can answer an unassigned decision", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const decision = await stack(companyId, employeeId);
    const result = await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: memberId,
      role: "member",
      optionId: "hold-for-now",
    });
    assert.equal(result.outcome, "decided");
  });

  test("an assigned decision is refused to another member but open to an admin", async () => {
    const { companyId, employeeId, memberId, ownerId } = await scenario();
    const other = await insert(User, {
      email: `other-${companyId}@example.test`,
      passwordHash: "x",
      name: "Other",
    });
    const decision = await stack(companyId, employeeId, {});
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      { assigneeUserId: memberId },
    );
    const assigned = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;

    assert.equal(canDecide(assigned, other.id, "member"), false);
    assert.equal(canDecide(assigned, memberId, "member"), true);
    // An owner can still unblock the employee when the assignee is away.
    assert.equal(canDecide(assigned, ownerId, "owner"), true);

    const refused = await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: other.id,
      role: "member",
      optionId: "send-it",
    });
    assert.equal(refused.outcome, "forbidden");
  });

  test("an option the employee never offered is refused", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId);
    const result = await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: ownerId,
      role: "owner",
      optionId: "wire-the-money",
    });
    assert.equal(result.outcome, "unknown_option");
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.status, "pending");
  });

  test("twenty concurrent answers produce exactly one decision", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        decideDecision({
          companyId,
          decisionId: decision.id,
          userId: ownerId,
          role: "owner",
          optionId: i % 2 === 0 ? "send-it" : "hold-for-now",
        }),
      ),
    );

    assert.equal(results.filter((r) => r.outcome === "decided").length, 1);
    assert.equal(results.filter((r) => r.outcome === "conflict").length, 19);
    const journal = await AppDataSource.getRepository(JournalEntry).find({ where: { employeeId } });
    assert.equal(journal.length, 1, "the employee must be told once, not twenty times");
  });

  test("a decision from another company is invisible", async () => {
    const a = await scenario();
    const b = await scenario();
    const decision = await stack(a.companyId, a.employeeId);
    const result = await decideDecision({
      companyId: b.companyId,
      decisionId: decision.id,
      userId: b.ownerId,
      role: "owner",
      optionId: "send-it",
    });
    assert.equal(result.outcome, "not_found");
  });

  test("a lapsed deadline expires the row instead of answering it", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const result = await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: ownerId,
      role: "owner",
      optionId: "send-it",
    });
    assert.equal(result.outcome, "conflict");
    assert.equal(result.outcome === "conflict" && result.decision.status, "expired");
  });
});

describe("retracting a decision", () => {
  test("an employee can cancel its own question but not another's", async () => {
    const { companyId, employeeId } = await scenario();
    const other = await insert(AIEmployee, {
      companyId,
      name: "Kay",
      slug: `kay-${companyId.slice(3, 11)}`,
      role: "Ops",
      soulBody: "",
    });
    const decision = await stack(companyId, employeeId);

    const wrong = await cancelDecision({
      companyId,
      decisionId: decision.id,
      employeeId: other.id,
    });
    assert.equal(wrong.outcome, "not_found");

    const right = await cancelDecision({ companyId, decisionId: decision.id, employeeId });
    assert.equal(right.outcome, "cancelled");
    // An employee retracting its own question does not journal at itself.
    const journal = await AppDataSource.getRepository(JournalEntry).find({ where: { employeeId } });
    assert.equal(journal.length, 0);
  });

  test("a human dismissal tells the employee nobody chose", async () => {
    const { companyId, employeeId, ownerId } = await scenario();
    const decision = await stack(companyId, employeeId);
    const result = await cancelDecision({
      companyId,
      decisionId: decision.id,
      userId: ownerId,
      reason: "We already sent it manually.",
    });
    assert.equal(result.outcome, "cancelled");
    const journal = await AppDataSource.getRepository(JournalEntry).find({ where: { employeeId } });
    assert.equal(journal.length, 1);
    assert.match(journal[0].title, /dismissed the decision/);
  });
});

describe("the stack itself", () => {
  test("orders by urgency, then by how long it has waited", async () => {
    const { companyId, employeeId } = await scenario();
    const normal = await stack(companyId, employeeId, { title: "Normal one" });
    const urgent = await stack(companyId, employeeId, { title: "Urgent one", urgency: "high" });
    const low = await stack(companyId, employeeId, { title: "Low one", urgency: "low" });
    // Force a deterministic age order; CreateDateColumn resolution can tie.
    const repo = AppDataSource.getRepository(Decision);
    await repo.update({ id: normal.id }, { createdAt: new Date(Date.now() - 30_000) });
    await repo.update({ id: urgent.id }, { createdAt: new Date(Date.now() - 10_000) });
    await repo.update({ id: low.id }, { createdAt: new Date(Date.now() - 20_000) });

    const { decisions, total } = await listPendingDecisions({ companyId, limit: 10 });
    assert.equal(total, 3);
    assert.deepEqual(
      decisions.map((d) => d.title),
      ["Urgent one", "Normal one", "Low one"],
    );
    assert.equal(decisions[0].employee?.name, "Rey");
  });

  test("a lapsed deadline drops the row off the stack on the next read", async () => {
    const { companyId, employeeId } = await scenario();
    await stack(companyId, employeeId, { title: "Still live" });
    await stack(companyId, employeeId, {
      title: "Long gone",
      expiresAt: new Date(Date.now() - 1_000),
    });

    const { decisions, total } = await listPendingDecisions({ companyId, limit: 10 });
    assert.equal(total, 1);
    assert.deepEqual(
      decisions.map((d) => d.title),
      ["Still live"],
    );
  });

  test("the count reports the whole stack even when the slice is smaller", async () => {
    const { companyId, employeeId } = await scenario();
    for (let i = 0; i < 7; i += 1) {
      await stack(companyId, employeeId, { title: `Question ${i}` });
    }
    const { decisions, total } = await listPendingDecisions({ companyId, limit: 5 });
    assert.equal(decisions.length, 5);
    assert.equal(total, 7);
  });

  test("one company's stack never contains another's", async () => {
    const a = await scenario();
    const b = await scenario();
    await stack(a.companyId, a.employeeId, { title: "Theirs" });
    const { decisions, total } = await listPendingDecisions({ companyId: b.companyId, limit: 10 });
    assert.equal(total, 0);
    assert.deepEqual(decisions, []);
  });
});

/**
 * Provenance — "where did this come from?".
 *
 * The stack renders a link per row, so what matters is that the resolved
 * `source` names the right surface and degrades honestly when the thing it
 * points at has been deleted. A row that silently claims to be a chat because
 * its routine is gone would be worse than one that admits the routine is gone.
 */
describe("decision provenance", () => {
  test("a routine-raised row resolves the routine, its run, and the employee slug", async () => {
    const { companyId, employeeId } = await scenario();
    const routine = await insert(Routine, {
      employeeId,
      name: "Nightly outreach",
      slug: "nightly-outreach",
      cronExpr: "0 2 * * *",
      body: "",
    });
    const run = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "completed",
      triggerKind: "schedule",
    });
    await stack(companyId, employeeId, { routineId: routine.id, runId: run.id });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "routine");
    assert.equal(dto.source.routine?.name, "Nightly outreach");
    assert.equal(dto.source.routine?.slug, "nightly-outreach");
    assert.ok(dto.source.routine?.employeeSlug, "the link needs the routine owner's slug");
    assert.equal(dto.source.run?.id, run.id);
    assert.equal(dto.source.run?.triggerKind, "schedule");
  });

  test("a mail-raised row resolves the thread it is about", async () => {
    const { companyId, employeeId } = await scenario();
    const thread = await insert(MailThread, {
      companyId,
      accountId: "acct-1",
      gmailThreadId: `g-${companyId.slice(0, 8)}`,
      subject: "Pricing for Acme",
      lastMessageAt: new Date(),
    });
    await stack(companyId, employeeId, { mailThreadId: thread.id });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "mail");
    assert.equal(dto.source.mailThread?.subject, "Pricing for Acme");
    assert.equal(dto.source.mailThread?.id, thread.id);
  });

  test("a chat-raised row resolves the conversation", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const conversation = await insert(Conversation, {
      employeeId,
      ownerUserId: memberId,
      title: "Acme renewal",
      source: "web",
    });
    await stack(companyId, employeeId, { conversationId: conversation.id });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "chat");
    assert.equal(dto.source.conversation?.title, "Acme renewal");
  });

  test("a row with no recorded surface is `unknown`, not mislabelled", async () => {
    const { companyId, employeeId } = await scenario();
    await stack(companyId, employeeId);

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "unknown");
    assert.equal(dto.source.routine, null);
    assert.equal(dto.source.conversation, null);
  });

  test("a deleted routine still reads as a routine, with nothing to link to", async () => {
    const { companyId, employeeId } = await scenario();
    const routine = await insert(Routine, {
      employeeId,
      name: "Gone",
      slug: "gone",
      cronExpr: "0 2 * * *",
      body: "",
    });
    await stack(companyId, employeeId, { routineId: routine.id });
    await AppDataSource.getRepository(Routine).delete({ id: routine.id });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "routine");
    assert.equal(dto.source.routine, null);
  });

  test("a routine beats an email beats a chat when a row carries more than one", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const routine = await insert(Routine, {
      employeeId,
      name: "Sweep",
      slug: "sweep",
      cronExpr: "0 2 * * *",
      body: "",
    });
    const conversation = await insert(Conversation, {
      employeeId,
      ownerUserId: memberId,
      title: "Chat",
      source: "web",
    });
    const thread = await insert(MailThread, {
      companyId,
      accountId: "acct-2",
      gmailThreadId: `gg-${companyId.slice(0, 8)}`,
      subject: "Thread",
      lastMessageAt: new Date(),
    });
    await stack(companyId, employeeId, {
      routineId: routine.id,
      conversationId: conversation.id,
      mailThreadId: thread.id,
    });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.source.kind, "routine");
    // The other two are still resolved — the row links to all of them.
    assert.equal(dto.source.mailThread?.subject, "Thread");
    assert.equal(dto.source.conversation?.title, "Chat");
  });

  test("who answered is resolved for display, not left as a bare id", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const decision = await stack(companyId, employeeId);
    await decideDecision({
      companyId,
      decisionId: decision.id,
      userId: memberId,
      role: "member",
      optionId: "send-it",
    });

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.decidedBy?.id, memberId);
    assert.equal(dto.decidedBy?.name, "Mo Member");
  });

  test("hydrating a mixed stack issues no per-row lookups it cannot batch", async () => {
    const { companyId, employeeId } = await scenario();
    const routine = await insert(Routine, {
      employeeId,
      name: "Sweep",
      slug: "sweep-many",
      cronExpr: "0 2 * * *",
      body: "",
    });
    for (let i = 0; i < 12; i += 1) {
      await stack(companyId, employeeId, {
        title: `Question ${i}`,
        ...(i % 2 === 0 ? { routineId: routine.id } : {}),
      });
    }
    const rows = await listDecisions({ companyId });
    assert.equal(rows.length, 12);
    assert.equal(rows.filter((r) => r.source.kind === "routine").length, 6);
    assert.equal(rows.filter((r) => r.source.kind === "unknown").length, 6);
  });
});

/**
 * The read-path sweep for pickups that died with their process. A row stuck on
 * `running` renders a spinner nobody can clear, so the rule is: once a session
 * has been quiet longer than the chat seam's own hard timeout, it is dead.
 */
describe("stale pickup reconciliation", () => {
  async function decidedRow(companyId: string, employeeId: string, userId: string) {
    const decision = await stack(companyId, employeeId);
    await decideDecision({
      companyId,
      decisionId: decision.id,
      userId,
      role: "member",
      optionId: "send-it",
    });
    return decision;
  }

  test("a pickup abandoned by a crash is failed, with an explanation", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const decision = await decidedRow(companyId, employeeId, memberId);
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      {
        pickupStatus: "running",
        pickupStartedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      },
    );

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.pickupStatus, "failed");
    assert.match(dto.pickupSummary ?? "", /journal/);
    assert.ok(dto.pickupFinishedAt);
  });

  test("a session still inside its budget is left alone", async () => {
    const { companyId, employeeId, memberId } = await scenario();
    const decision = await decidedRow(companyId, employeeId, memberId);
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      { pickupStatus: "running", pickupStartedAt: new Date(Date.now() - 60_000) },
    );

    const [dto] = await listDecisions({ companyId });
    assert.equal(dto.pickupStatus, "running");
  });

  test("the sweep never reaches another company's rows", async () => {
    const a = await scenario();
    const b = await scenario();
    const decision = await decidedRow(a.companyId, a.employeeId, a.memberId);
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      {
        pickupStatus: "running",
        pickupStartedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      },
    );

    await listDecisions({ companyId: b.companyId });
    const row = await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
    assert.equal(row.pickupStatus, "running");
  });
});
