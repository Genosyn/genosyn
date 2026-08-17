import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { ChatResult, chatWithEmployee } from "./chat.js";
import { createDecision, decideDecision } from "./decisions.js";
import { kickoffDecision } from "./decisionKickoff.js";

/**
 * Pickup — the work session that runs the moment a human answers.
 *
 * The invariants worth pinning down are the ones that decide whether a human
 * can trust the button: exactly one session per answer however many callers
 * race it, a terminal state whatever the session does (including throwing), and
 * a brief that actually carries the answer and the context the employee needs
 * to resume. The degradation paths matter just as much — an install with no
 * model connected must record *why* nothing started rather than looking broken.
 */

before(initTestDb);
after(closeTestDb);

let company: Company;
let employee: AIEmployee;
let member: User;

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, {
    email: "member@example.com",
    name: "Mia",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Nova",
    slug: "nova",
    role: "Operations",
  });
});

/** An employee with a brain — without one, every pickup degrades to `skipped`. */
async function giveModel(): Promise<void> {
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
}

async function stackAndAnswer(
  overrides: Partial<Parameters<typeof createDecision>[0]> = {},
): Promise<Decision> {
  const { decision } = await createDecision({
    companyId: company.id,
    employeeId: employee.id,
    title: "Send the pricing reply?",
    body: "## Draft\n\nHello **Acme**,",
    options: [{ label: "Send it", tone: "primary", detail: "Goes out as written" }, { label: "Hold" }],
    ...overrides,
  });
  const outcome = await decideDecision({
    companyId: company.id,
    decisionId: decision.id,
    userId: member.id,
    role: "member",
    optionId: "send-it",
    note: "Trim the last line.",
  });
  assert.equal(outcome.outcome, "decided");
  return (await AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id }))!;
}

function fakeChat(
  result: Partial<ChatResult> & { status: ChatResult["status"] },
  onCall?: (message: string) => void,
): typeof chatWithEmployee {
  return (async (_companyId, _employeeId, message) => {
    onCall?.(message);
    return {
      reply: "",
      attachmentIds: [],
      sidecars: {},
      ...result,
    } as ChatResult;
  }) as typeof chatWithEmployee;
}

async function reload(id: string): Promise<Decision> {
  return AppDataSource.getRepository(Decision).findOneByOrFail({ id });
}

describe("decision pickup", () => {
  test("a session runs and its report lands on the row", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "Sent it to Acme." }),
    });

    const row = await reload(decision.id);
    assert.equal(row.pickupStatus, "done");
    assert.equal(row.pickupSummary, "Sent it to Acme.");
    assert.ok(row.pickupStartedAt, "the start time is recorded");
    assert.ok(row.pickupFinishedAt, "the finish time is recorded");
  });

  test("the brief carries the question, the choice, the note and the context", async () => {
    await giveModel();
    let brief = "";
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "done" }, (message) => {
        brief = message;
      }),
    });

    assert.match(brief, /Send the pricing reply\?/);
    assert.match(brief, /Send it/);
    assert.match(brief, /Goes out as written/);
    assert.match(brief, /Trim the last line\./);
    assert.match(brief, /Hello \*\*Acme\*\*/, "the stacked context is replayed");
    assert.match(brief, /Mia/, "the employee is told who answered");
  });

  test("a routine-raised decision tells the employee which routine to resume", async () => {
    await giveModel();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Nightly outreach",
      slug: "nightly-outreach",
      cronExpr: "0 2 * * *",
      body: "",
    });
    let brief = "";
    const decision = await stackAndAnswer({ routineId: routine.id, runId: "run-1" });
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "done" }, (message) => {
        brief = message;
      }),
    });

    assert.match(brief, /Nightly outreach/);
    assert.match(brief, /run-1/);
  });

  test("a mail-raised decision hands back the thread id the mail tools take", async () => {
    await giveModel();
    const thread = await insert(MailThread, {
      companyId: company.id,
      accountId: "acct-1",
      gmailThreadId: "g-1",
      subject: "Pricing for Acme",
      lastMessageAt: new Date(),
    });
    let brief = "";
    const decision = await stackAndAnswer({ mailThreadId: thread.id });
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "done" }, (message) => {
        brief = message;
      }),
    });

    assert.match(brief, /Pricing for Acme/);
    assert.match(brief, new RegExp(thread.id));
    assert.match(brief, /threadId/);
  });

  test("a chat-raised decision names the conversation", async () => {
    await giveModel();
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: member.id,
      title: "Acme renewal",
      source: "web",
    });
    let brief = "";
    const decision = await stackAndAnswer({ conversationId: conversation.id });
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "done" }, (message) => {
        brief = message;
      }),
    });

    assert.match(brief, /Acme renewal/);
  });

  test("two callers racing the same answer start exactly one session", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    let calls = 0;
    const chat = fakeChat({ status: "ok", reply: "once" }, () => {
      calls += 1;
    });
    await Promise.all([
      kickoffDecision({
        companyId: company.id,
        decisionId: decision.id,
        requesterUserId: member.id,
        requesterSessionVersion: 0,
        runChat: chat,
      }),
      kickoffDecision({
        companyId: company.id,
        decisionId: decision.id,
        requesterUserId: member.id,
        requesterSessionVersion: 0,
        runChat: chat,
      }),
    ]);

    assert.equal(calls, 1);
    assert.equal((await reload(decision.id)).pickupStatus, "done");
  });

  test("a second kickoff after the first finished does not re-run the work", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    let calls = 0;
    const chat = fakeChat({ status: "ok", reply: "once" }, () => {
      calls += 1;
    });
    const run = () =>
      kickoffDecision({
        companyId: company.id,
        decisionId: decision.id,
        requesterUserId: member.id,
        requesterSessionVersion: 0,
        runChat: chat,
      });
    await run();
    await run();

    assert.equal(calls, 1);
  });

  test("a session that throws still lands the row in a terminal state", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: (() => Promise.reject(new Error("model exploded"))) as typeof chatWithEmployee,
    });

    const row = await reload(decision.id);
    assert.equal(row.pickupStatus, "failed");
    assert.match(row.pickupSummary ?? "", /model exploded/);
    assert.ok(row.pickupFinishedAt, "a failed pickup is finished, not left running");
  });

  test("a busy or skipped turn is recorded as failed, not silently dropped", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "busy", reply: "Nova is finishing another message." }),
    });

    const row = await reload(decision.id);
    assert.equal(row.pickupStatus, "failed");
    assert.match(row.pickupSummary ?? "", /finishing another message/);
  });

  test("no AI Model connected is skipped, and says the answer still reaches them", async () => {
    const decision = await stackAndAnswer();
    let calls = 0;
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "x" }, () => {
        calls += 1;
      }),
    });

    const row = await reload(decision.id);
    assert.equal(calls, 0);
    assert.equal(row.pickupStatus, "skipped");
    assert.match(row.pickupSummary ?? "", /no AI Model connected/i);
    assert.match(row.pickupSummary ?? "", /journal/);
  });

  test("an API-key answer is skipped rather than promoted to employee authority", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    let calls = 0;
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: null,
      runChat: fakeChat({ status: "ok", reply: "x" }, () => {
        calls += 1;
      }),
    });

    const row = await reload(decision.id);
    assert.equal(calls, 0);
    assert.equal(row.pickupStatus, "skipped");
    assert.match(row.pickupSummary ?? "", /API key/);
  });

  test("a deleted employee is skipped, not a crash", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await AppDataSource.getRepository(AIEmployee).delete({ id: employee.id });
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "x" }),
    });

    assert.equal((await reload(decision.id)).pickupStatus, "skipped");
  });

  test("a dismissed decision never starts a session", async () => {
    await giveModel();
    const { decision } = await createDecision({
      companyId: company.id,
      employeeId: employee.id,
      title: "Publish the post?",
      options: [{ label: "Publish" }],
    });
    let calls = 0;
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "x" }, () => {
        calls += 1;
      }),
    });

    assert.equal(calls, 0, "a pending row is not a decided one");
    assert.equal((await reload(decision.id)).pickupStatus, "none");
  });

  test("another company's id cannot start a session on this row", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    let calls = 0;
    await kickoffDecision({
      companyId: "some-other-company",
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "x" }, () => {
        calls += 1;
      }),
    });

    assert.equal(calls, 0);
    assert.equal((await reload(decision.id)).pickupStatus, "none");
  });

  test("the report is journalled so it also reaches the employee's next prompt", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "Sent it to Acme." }),
    });

    const entries = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: employee.id },
    });
    assert.ok(
      entries.some((e) => e.title.includes("Picked up the decision") && e.body.includes("Acme")),
      "the pickup report is on the journal",
    );
  });

  test("an enormous report is capped rather than stored whole", async () => {
    await giveModel();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
      runChat: fakeChat({ status: "ok", reply: "x".repeat(50_000) }),
    });

    const row = await reload(decision.id);
    assert.ok((row.pickupSummary ?? "").length <= 8_000);
  });
});
