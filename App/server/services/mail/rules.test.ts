import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import type { MailRuleAiDecision } from "./aiRuleEvaluator.js";
import {
  messageMatches,
  parseActions,
  parseConditions,
  runRulesForNewMessage,
  type MailRuleAction,
  type MailRuleConditions,
} from "./rules.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_rules_test";

async function mailboxFixture(): Promise<{
  account: MailAccount;
  thread: MailThread;
  message: MailMessage;
}> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: "connection_mail_rules_test",
    address: "owner@example.com",
    status: "active",
  });
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: "gmail_thread_rules_test",
    subject: "Quarterly newsletter",
  });
  const message = await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "gmail_message_rules_test",
    gmailThreadId: thread.gmailThreadId,
    fromName: "Acme Updates",
    fromEmail: "news@acme.example",
    toEmails: "Owner <owner@example.com>",
    ccEmails: "team@example.com",
    subject: "Quarterly newsletter",
    bodyText: "Save 20% on the annual plan. This is a marketing newsletter.",
    attachmentsJson: JSON.stringify([{ filename: "offer.pdf" }]),
    labelIds: " INBOX UNREAD ",
    sentAt: new Date("2026-08-14T09:00:00Z"),
  });
  return { account, thread, message };
}

async function createRule(
  account: MailAccount,
  input: {
    name: string;
    position?: number;
    conditions?: MailRuleConditions;
    actions?: MailRuleAction[];
    enabled?: boolean;
  },
): Promise<MailRule> {
  return insert(MailRule, {
    companyId: COMPANY_ID,
    accountId: account.id,
    name: input.name,
    position: input.position ?? 0,
    enabled: input.enabled ?? true,
    conditionsJson: JSON.stringify(input.conditions ?? {}),
    actionsJson: JSON.stringify(input.actions ?? []),
  });
}

describe("mail rule parsing and static matching", () => {
  test("malformed stored JSON fails safely", () => {
    assert.deepEqual(parseConditions("{broken"), {});
    assert.deepEqual(parseActions("{broken"), []);
    assert.deepEqual(parseActions("{}"), []);
  });

  test("all filled static fields are case-insensitive AND conditions", async () => {
    const { message } = await mailboxFixture();
    assert.equal(
      messageMatches(
        {
          from: "ACME",
          to: "TEAM@EXAMPLE",
          subjectContains: "NEWSLETTER",
          bodyContains: "annual plan",
          hasAttachment: true,
        },
        message,
      ),
      true,
    );
    assert.equal(messageMatches({ from: "acme", subjectContains: "receipt" }, message), false);
  });

  test("body matching is bounded and malformed attachment metadata is not a match", async () => {
    const { message } = await mailboxFixture();
    message.bodyText = `${"x".repeat(100_001)}hidden-marker`;
    assert.equal(messageMatches({ bodyContains: "hidden-marker" }, message), false);
    message.attachmentsJson = "not-json";
    assert.equal(messageMatches({ hasAttachment: true }, message), false);
    message.attachmentsJson = "[]";
    assert.equal(messageMatches({ hasAttachment: true }, message), false);
  });

  test("the AI condition is deliberately ignored by the deterministic prefilter", async () => {
    const { message } = await mailboxFixture();
    assert.equal(
      messageMatches(
        {
          ai: { employeeId: "employee", instruction: "Wanted marketing mail" },
        },
        message,
      ),
      true,
    );
  });
});

describe("AI rule execution", () => {
  test("never evaluates a message that belongs to another mailbox", async () => {
    const { account } = await mailboxFixture();
    await createRule(account, {
      name: "Mailbox-scoped AI",
      conditions: { ai: { employeeId: "employee", instruction: "Marketing" } },
    });
    const otherAccount = await insert(MailAccount, {
      companyId: COMPANY_ID,
      connectionId: "connection_other_mail_rules_test",
      address: "other@example.com",
      status: "active",
    });
    const otherThread = await insert(MailThread, {
      companyId: COMPANY_ID,
      accountId: otherAccount.id,
      gmailThreadId: "gmail_thread_other_rules_test",
      subject: "Other mailbox newsletter",
    });
    const otherMessage = await insert(MailMessage, {
      companyId: COMPANY_ID,
      accountId: otherAccount.id,
      threadId: otherThread.id,
      gmailMessageId: "gmail_message_other_rules_test",
      gmailThreadId: otherThread.gmailThreadId,
      fromEmail: "news@example.com",
      toEmails: otherAccount.address,
      subject: "Other mailbox newsletter",
      bodyText: "Marketing",
    });
    let aiCalls = 0;

    await runRulesForNewMessage(
      account,
      otherMessage.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => {
          aiCalls += 1;
          return { matches: true, reason: "must not run" };
        },
      },
    );

    assert.equal(aiCalls, 0);
  });

  test("a static miss does not spend an AI call or mark an effect", async () => {
    const { account, message } = await mailboxFixture();
    const rule = await createRule(account, {
      name: "Wrong sender",
      conditions: {
        from: "different.example",
        ai: { employeeId: "employee", instruction: "Marketing" },
      },
    });
    let aiCalls = 0;
    let effects = 0;
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {
        effects += 1;
      },
      {
        evaluateAi: async () => {
          aiCalls += 1;
          return { matches: true, reason: "marketing" };
        },
      },
    );
    assert.equal(aiCalls, 0);
    assert.equal(effects, 0);
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id })).matchCount,
      0,
    );
  });

  test("AI false leaves actions and positive-match counters untouched", async () => {
    const { account, message } = await mailboxFixture();
    const rule = await createRule(account, {
      name: "Marketing only",
      conditions: { ai: { employeeId: "employee", instruction: "Unwanted marketing" } },
      actions: [{ type: "unsubscribe" }],
    });
    let unsubscribeCalls = 0;
    let effects = 0;
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {
        effects += 1;
      },
      {
        evaluateAi: async () => ({ matches: false, reason: "This is a requested receipt." }),
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          return { host: "example.com", status: 204 };
        },
      },
    );
    const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id });
    assert.equal(effects, 1, "the paid model call is an external effect");
    assert.equal(saved.matchCount, 0);
    assert.equal(saved.lastMatchedAt, null);
    assert.equal(unsubscribeCalls, 0);
  });

  test("AI true records the final match, reason, and acts on the triggering message", async () => {
    const { account, message } = await mailboxFixture();
    const rule = await createRule(account, {
      name: "Unwanted newsletter",
      conditions: { ai: { employeeId: "employee", instruction: "Unwanted marketing" } },
      actions: [{ type: "unsubscribe" }],
    });
    const receivedMessages: MailMessage[] = [];
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => ({ matches: true, reason: "Promotional discount newsletter." }),
        unsubscribe: async (_account, triggeringMessage) => {
          receivedMessages.push(triggeringMessage);
          return { host: "lists.acme.example", status: 204 };
        },
      },
    );

    const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id });
    assert.equal(saved.matchCount, 1);
    assert.ok(saved.lastMatchedAt);
    assert.equal(receivedMessages.length, 1);
    assert.equal(receivedMessages[0].id, message.id);
    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { targetId: rule.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      audits.map((event) => event.action),
      ["mail.rule.match", "mail.rule.unsubscribe"],
    );
    assert.match(audits[0].metadataJson, /Promotional discount newsletter/);
    assert.doesNotMatch(audits[1].metadataJson, /https:\/\//);
    assert.match(audits[1].metadataJson, /lists\.acme\.example/);
  });

  test("an AI error fails closed, is audited, and does not block later rules", async () => {
    const { account, message } = await mailboxFixture();
    const aiRule = await createRule(account, {
      name: "AI rule",
      position: 0,
      conditions: { ai: { employeeId: "employee", instruction: "Marketing" } },
    });
    const staticRule = await createRule(account, {
      name: "Static fallback",
      position: 1,
      conditions: { subjectContains: "newsletter" },
    });
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => {
          throw new Error("model unavailable");
        },
      },
    );
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: aiRule.id })).matchCount,
      0,
    );
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: staticRule.id }))
        .matchCount,
      1,
    );
    const failure = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      targetId: aiRule.id,
      action: "mail.rule.ai_error",
    });
    assert.match(failure.metadataJson, /model unavailable/);
  });

  test("AI candidates are evaluated in rule position order", async () => {
    const { account, message } = await mailboxFixture();
    await createRule(account, {
      name: "Second",
      position: 20,
      conditions: { ai: { employeeId: "employee-second", instruction: "Marketing" } },
    });
    await createRule(account, {
      name: "First",
      position: 10,
      conditions: { ai: { employeeId: "employee-first", instruction: "Marketing" } },
    });
    const seen: string[] = [];
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async (_account, _message, condition) => {
          seen.push(condition.employeeId);
          return { matches: false, reason: "No" };
        },
      },
    );
    assert.deepEqual(seen, ["employee-first", "employee-second"]);
  });

  test("an edit or disable during AI evaluation invalidates the stale decision", async () => {
    const { account, message } = await mailboxFixture();
    const rule = await createRule(account, {
      name: "Unwanted marketing",
      conditions: { ai: { employeeId: "employee", instruction: "Marketing" } },
      actions: [{ type: "unsubscribe" }],
    });
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    let finishEvaluation!: (decision: MailRuleAiDecision) => void;
    const decision = new Promise<MailRuleAiDecision>((resolve) => {
      finishEvaluation = resolve;
    });
    let unsubscribeCalls = 0;

    const running = runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => {
          evaluationStarted();
          return decision;
        },
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          return { host: "lists.example", status: 204 };
        },
      },
    );
    await started;
    await AppDataSource.getRepository(MailRule).update(
      { id: rule.id },
      {
        enabled: false,
        actionsJson: JSON.stringify([{ type: "archive" }]),
      },
    );
    finishEvaluation({ matches: true, reason: "Marketing" });
    await running;

    const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id });
    assert.equal(unsubscribeCalls, 0);
    assert.equal(saved.enabled, false);
    assert.deepEqual(parseActions(saved.actionsJson), [{ type: "archive" }]);
    assert.equal(saved.matchCount, 0);
  });

  test("deleting a rule during AI evaluation never recreates or executes it", async () => {
    const { account, message } = await mailboxFixture();
    const rule = await createRule(account, {
      name: "Delete while deciding",
      conditions: { ai: { employeeId: "employee", instruction: "Marketing" } },
      actions: [{ type: "unsubscribe" }],
    });
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    let finishEvaluation!: (decision: MailRuleAiDecision) => void;
    const decision = new Promise<MailRuleAiDecision>((resolve) => {
      finishEvaluation = resolve;
    });
    let unsubscribeCalls = 0;

    const running = runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => {
          evaluationStarted();
          return decision;
        },
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          return { host: "lists.example", status: 204 };
        },
      },
    );
    await started;
    await AppDataSource.getRepository(MailRule).delete({ id: rule.id });
    finishEvaluation({ matches: true, reason: "Marketing" });
    await running;

    assert.equal(unsubscribeCalls, 0);
    assert.equal(await AppDataSource.getRepository(MailRule).findOneBy({ id: rule.id }), null);
  });

  test("a later rule edited while an earlier AI rule waits is skipped", async () => {
    const { account, message } = await mailboxFixture();
    await createRule(account, {
      name: "Slow first rule",
      position: 0,
      conditions: { ai: { employeeId: "employee", instruction: "Marketing" } },
    });
    const later = await createRule(account, {
      name: "Later static rule",
      position: 1,
      conditions: { subjectContains: "newsletter" },
      actions: [{ type: "unsubscribe" }],
    });
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    let finishEvaluation!: (decision: MailRuleAiDecision) => void;
    const decision = new Promise<MailRuleAiDecision>((resolve) => {
      finishEvaluation = resolve;
    });
    let unsubscribeCalls = 0;

    const running = runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        evaluateAi: async () => {
          evaluationStarted();
          return decision;
        },
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          return { host: "lists.example", status: 204 };
        },
      },
    );
    await started;
    await AppDataSource.getRepository(MailRule).update(
      { id: later.id },
      { actionsJson: JSON.stringify([{ type: "archive" }]) },
    );
    finishEvaluation({ matches: false, reason: "Not marketing" });
    await running;

    const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: later.id });
    assert.equal(unsubscribeCalls, 0);
    assert.deepEqual(parseActions(saved.actionsJson), [{ type: "archive" }]);
    assert.equal(saved.matchCount, 0);
  });
});

describe("unsubscribe action isolation", () => {
  test("two matching rules make at most one irreversible unsubscribe attempt", async () => {
    const { account, message } = await mailboxFixture();
    const first = await createRule(account, {
      name: "First",
      position: 0,
      conditions: { from: "acme" },
      actions: [{ type: "unsubscribe" }],
    });
    const second = await createRule(account, {
      name: "Second",
      position: 1,
      conditions: { subjectContains: "newsletter" },
      actions: [{ type: "unsubscribe" }],
    });
    let calls = 0;
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        unsubscribe: async () => {
          calls += 1;
          return { host: "lists.acme.example", status: 200 };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: first.id })).matchCount,
      1,
    );
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: second.id })).matchCount,
      1,
    );
  });

  test("a failed unsubscribe is audited without blocking a later rule", async () => {
    const { account, message } = await mailboxFixture();
    const unsubscribeRule = await createRule(account, {
      name: "Unsafe sender",
      position: 0,
      conditions: { from: "acme" },
      actions: [{ type: "unsubscribe" }],
    });
    const laterRule = await createRule(account, {
      name: "Later rule",
      position: 1,
      conditions: { subjectContains: "newsletter" },
    });
    await runRulesForNewMessage(
      account,
      message.id,
      () => {},
      () => {},
      {
        unsubscribe: async () => {
          throw new Error("No safe one-click method");
        },
      },
    );
    assert.equal(
      (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: laterRule.id }))
        .matchCount,
      1,
    );
    const failure = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      targetId: unsubscribeRule.id,
      action: "mail.rule.action_error",
    });
    assert.match(failure.metadataJson, /No safe one-click method/);
  });
});
