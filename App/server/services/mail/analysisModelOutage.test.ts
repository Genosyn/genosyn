import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModelWait } from "../../db/entities/AIModelWait.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import {
  EmployeeMailAccountGrant,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { FakeMailbox } from "../../test/fakeMailbox.js";
import { modelUnavailability } from "../agent/modelOutage.js";
import type { runRestrictedEmployeeAgent } from "../agent/runEmployee.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  loadModelOutages,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "../modelAvailability.js";
import {
  resetModelWaitsForTests,
  setModelWaitHandlerForTests,
  settleModelWaitsForTests,
} from "../modelWaits.js";
import { liftStanddown, placeStanddown, refreshStanddowns, stopStanddowns } from "../standdowns.js";
import {
  MAIL_ARRIVAL_ACTS_WITHIN_MS,
  MailAnalysisModelUnavailable,
  MailAnalysisWaiting,
  analyzeInboundMessage,
  mailArrivalReadWait,
  resumeArrivalRead,
  type MailAnalysisFacts,
  type MailAnalysisOptions,
} from "./analysis.js";
import {
  applyAutomaticAnalysisActions,
  parseAutoActions,
  type MailAutomaticActionFences,
} from "./analysisAutomation.js";
import { enqueueInboundAutomation, waitForMailAutomation } from "./automationQueue.js";
import { summarizeMailReview } from "./reviewStatus.js";
import { runRulesForNewMessage } from "./rules.js";
import { labelIdsToColumn } from "./store.js";

/**
 * An email that arrives while the AI Model that reads the mailbox is
 * unavailable: the read waits — as the arrival it is — instead of failing,
 * the rules and Pipelines run as always, and once the model answers the read
 * runs once and the mailbox's instructions act then, under the Grant, the
 * Standdowns and the switches of that moment. Never a backfill, never a
 * re-read. The model and the mail server are stand-ins; the inbound queue, the
 * read, the step runner, the wait ledger and the breaker are real.
 */

before(initTestDb);
beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  await refreshStanddowns();
});
afterEach(() => {
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});
after(closeTestDb);

const COMPANY_ID = "co_mail_outage_test";

type World = {
  account: MailAccount;
  reader: AIEmployee;
  model: AIModel;
  thread: MailThread;
  message: MailMessage;
  mailbox: FakeMailbox;
  unsubscribes: string[];
  steps: string[];
  reads: Array<{ automatic: boolean }>;
};

async function world(
  options: { accessLevel?: MailAccessLevel; account?: Partial<MailAccount> } = {},
): Promise<World> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection_${randomUUID()}`,
    address: "owner@example.com",
    status: "active",
    aiAnalysisEnabled: true,
    ...options.account,
  });
  const reader = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Jamie Mallers",
    slug: `jamie-${randomUUID()}`,
    role: "Inbox manager",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: reader.id,
    accountId: account.id,
    accessLevel: options.accessLevel ?? "draft",
  });
  const model = await insertEmployeeModel({
    employeeId: reader.id,
    provider: "openai",
    model: "gpt-test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "test-ciphertext" }),
    connectedAt: new Date(),
  });
  const suffix = randomUUID();
  const labels = ["INBOX", "UNREAD"];
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: `thread-${suffix}`,
    subject: "Spring sale",
    labelIds: labelIdsToColumn(labels),
    unread: true,
    messageCount: 1,
  });
  const message = await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `message-${suffix}`,
    gmailThreadId: thread.gmailThreadId,
    fromName: "Shop",
    fromEmail: "news@shop.example",
    toEmails: account.address,
    subject: "Spring sale",
    bodyText: "Everything is 40% off.",
    labelIds: labelIdsToColumn(labels),
  });
  const mailbox = new FakeMailbox();
  mailbox.seed({ ref: message.gmailMessageId, threadRef: thread.gmailThreadId, labelIds: labels });
  return {
    account,
    reader,
    model,
    thread,
    message,
    mailbox,
    unsubscribes: [],
    steps: [],
    reads: [],
  };
}

const MARKETING = {
  category: "marketing",
  summary: "A shop newsletter.",
  actions: [{ kind: "thread_action", label: "Archive", action: "archive" }],
  automaticActions: [
    { instruction: 1, action: "unsubscribe", reason: "A store newsletter." },
    { instruction: 2, action: "star", reason: "It asks for a reply about an order." },
  ],
};

type Turn = "ok" | "unavailable";

/** The model and the facts, stood in. The facts follow the reader's real Grant. */
function readDependencies(w: World, turn: () => Turn = () => "ok") {
  return {
    gatherFacts: async (
      _account: MailAccount,
      _message: MailMessage,
      reader: { accessLevel: MailAccessLevel },
    ): Promise<MailAnalysisFacts> => ({
      unsubscribeAvailable: true,
      unsubscribeHost: "lists.shop.example",
      handoverCandidates: [],
      canDraft: reader.accessLevel !== "read",
      threadSubject: "Spring sale",
      replyTo: "news@shop.example",
    }),
    runRestricted: (async (params) => {
      const automatic = /carry it out by listing the step in `automaticActions`/.test(params.system);
      w.reads.push({ automatic });
      if (turn() === "unavailable") {
        return {
          status: "error",
          error: "The AI Model answered with a server error (HTTP 529).",
          unavailable: modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
        };
      }
      await params.tools[0].run(automatic ? MARKETING : { ...MARKETING, automaticActions: undefined });
      return { status: "ok", finalText: "", steps: 1 };
    }) as typeof runRestrictedEmployeeAgent,
  };
}

function applyInstructions(w: World) {
  return async (
    account: MailAccount,
    message: MailMessage,
    analysisId: string,
    fences?: MailAutomaticActionFences,
  ) => {
    w.steps.push("instructions");
    return applyAutomaticAnalysisActions(account, message, analysisId, fences, {
      mailbox: async () => w.mailbox,
      unsubscribe: async (_account, unsubscribed) => {
        w.unsubscribes.push(unsubscribed.id);
        return { host: "lists.shop.example", status: 200 };
      },
    });
  };
}

/** The inbound queue's effects with the model, the mail server and the sender stood in. */
function effects(w: World, turn?: () => Turn) {
  const read = readDependencies(w, turn);
  return {
    reconcileDefaults: async () => {},
    analyzeInbound: async (
      account: MailAccount,
      message: MailMessage,
      _dependencies?: unknown,
      options?: MailAnalysisOptions,
    ) => {
      w.steps.push(options?.arrival ? "read:arrival" : "read:manual");
      return analyzeInboundMessage(account, message, read, options);
    },
    applyInstructions: applyInstructions(w),
    applyRules: async (
      account: MailAccount,
      messageId: string,
      assertWritable?: () => void | Promise<void>,
      beforeEffect?: () => void | Promise<void>,
    ) => {
      w.steps.push("rules");
      await runRulesForNewMessage(account, messageId, assertWritable, beforeEffect, {
        unsubscribe: async () => {
          w.unsubscribes.push(`rule:${messageId}`);
          return { host: "lists.shop.example", status: 200 };
        },
      });
    },
    dispatchReceived: async () => {
      w.steps.push("pipelines");
    },
  };
}

/** The wait ledger resumes arrival reads through the same stand-ins. */
function resumeThroughStandIns(w: World, turn?: () => Turn): void {
  setModelWaitHandlerForTests("mail_arrival_read", {
    ...mailArrivalReadWait,
    resume: (wait) =>
      resumeArrivalRead(wait.targetId, {
        ...readDependencies(w, turn),
        applyInstructions: applyInstructions(w),
      }),
  });
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

async function arrive(w: World, turn?: () => Turn): Promise<void> {
  await enqueueInboundAutomation(w.message, { defaultEffects: effects(w, turn) });
  await waitForMailAutomation(w.account.id);
}

async function analysisOf(message: MailMessage): Promise<MailInboundAnalysis | null> {
  return AppDataSource.getRepository(MailInboundAnalysis).findOneBy({ messageId: message.id });
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

function stepStates(row: MailInboundAnalysis | null): Array<[string, string]> {
  return parseAutoActions(row?.autoActionsJson).map((step) => [step.action, step.status]);
}

describe("an email that arrives while its AI Model is unavailable", () => {
  test("waits as the arrival: no model call, nothing failed, and the rules and Pipelines still run", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);

    assert.deepEqual(w.steps, ["read:arrival", "instructions", "rules", "pipelines"]);
    assert.equal(w.reads.length, 0, "nothing is sent to a model that is down");
    const row = await analysisOf(w.message);
    assert.equal(row?.status, "waiting");
    assert.equal(row?.errorMessage, "", "never the model's error on the email");
    assert.equal(row?.autoActionsJson, "[]");
    assert.equal(row?.finishedAt, null);
    const [wait, ...more] = await waits();
    assert.equal(more.length, 0);
    assert.equal(wait.kind, "mail_arrival_read");
    assert.equal(wait.targetId, row?.id);
    assert.equal(wait.employeeId, w.reader.id);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "mail.analysis.failed" }),
      0,
    );
    const delivery = await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
      messageId: w.message.id,
    });
    assert.equal(delivery.status, "succeeded", "the arrival itself is not failed");
    assert.equal(w.mailbox.calls.length, 0);
  });

  test("is read once the model is back — once, as the arrival — and the instructions act then", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    resumeThroughStandIns(w);

    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 0, "still waiting while the model is down");

    await back(w.model);
    await settleModelWaitsForTests();
    assert.deepEqual(w.reads, [{ automatic: true }], "read once, allowed to act");
    const row = await analysisOf(w.message);
    assert.equal(row?.status, "succeeded");
    assert.equal(row?.summary, "A shop newsletter.");
    assert.deepEqual(stepStates(row), [
      ["unsubscribe", "done"],
      ["star", "done"],
    ]);
    assert.deepEqual(w.unsubscribes, [w.message.id]);
    assert.deepEqual(
      w.mailbox.calls.filter((call) => call.method === "setFlagged").map((call) => call.args),
      [[w.thread.gmailThreadId, true]],
    );
    assert.equal((await waits()).length, 0);

    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 1, "never read twice");
    assert.deepEqual(w.unsubscribes, [w.message.id], "never acted on twice");
  });

  test("an outage in the middle of the read waits too, and nothing is recorded as failed", async () => {
    const w = await world();
    let turns = 0;
    const turn = (): Turn => (++turns === 1 ? "unavailable" : "ok");
    await arrive(w, turn);
    const waiting = await analysisOf(w.message);
    assert.equal(waiting?.status, "waiting");
    assert.equal(waiting?.errorMessage, "");
    assert.equal((await waits()).length, 1);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "mail.analysis.failed" }),
      0,
    );

    resumeThroughStandIns(w, turn);
    await back(w.model);
    await settleModelWaitsForTests();
    const done = await analysisOf(w.message);
    assert.equal(done?.status, "succeeded");
    assert.deepEqual(stepStates(done), [
      ["unsubscribe", "done"],
      ["star", "done"],
    ]);
  });

  test("a Standdown placed during the outage: the email is read when the model is back, and nothing acts on its own", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    await placeStanddown({
      companyId: COMPANY_ID,
      scope: "employee",
      scopeId: w.reader.id,
      reason: "Inbox audit.",
    });
    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    const row = await analysisOf(w.message);
    assert.equal(row?.status, "succeeded");
    const steps = parseAutoActions(row?.autoActionsJson);
    assert.ok(steps.length > 0);
    assert.ok(
      steps.every((step) => step.status === "skipped" && /stood down/.test(step.detail ?? "")),
      "the Standdown of the moment decides, as on arrival",
    );
    assert.deepEqual(w.unsubscribes, []);
    assert.equal(w.mailbox.calls.length, 0);
  });

  test("a Standdown lifted while the model is still down starts nothing", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    const standdown = await placeStanddown({
      companyId: COMPANY_ID,
      scope: "employee",
      scopeId: w.reader.id,
      reason: "Brief pause.",
    });
    await liftStanddown({ standdown, userId: null });
    resumeThroughStandIns(w);
    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 0);
    assert.equal((await analysisOf(w.message))?.status, "waiting");
  });

  test("a Grant lowered while it waited: the instructions become buttons, and the mailbox is untouched", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { employeeId: w.reader.id, accountId: w.account.id },
      { accessLevel: "read" },
    );
    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    assert.deepEqual(w.reads, [{ automatic: false }]);
    const row = await analysisOf(w.message);
    assert.equal(row?.status, "succeeded");
    assert.equal(row?.autoActionsJson, "[]");
    assert.equal(w.mailbox.calls.length, 0);
    assert.deepEqual(w.unsubscribes, []);
  });

  test("an email that waited past the window is read, with its instructions offered as buttons only", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    const row = await analysisOf(w.message);
    await AppDataSource.getRepository(MailInboundAnalysis)
      .createQueryBuilder()
      .update()
      .set({ createdAt: new Date(Date.now() - MAIL_ARRIVAL_ACTS_WITHIN_MS - 60_000) })
      .where("id = :id", { id: row!.id })
      .execute();
    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    assert.deepEqual(w.reads, [{ automatic: false }], "never acting on old mail by itself");
    const done = await analysisOf(w.message);
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.autoActionsJson, "[]");
    assert.deepEqual(w.unsubscribes, []);
  });

  test("a paused mailbox keeps the arrival waiting, uncounted, until Resume", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    await AppDataSource.getRepository(MailAccount).update({ id: w.account.id }, { status: "paused" });
    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 0);
    assert.equal((await analysisOf(w.message))?.status, "waiting");
    const [wait] = await waits();
    assert.equal(wait.attempts, 0, "a pause is not an outage");

    await AppDataSource.getRepository(MailAccount).update({ id: w.account.id }, { status: "active" });
    await settleModelWaitsForTests(() => new Date(Date.now() + 61_000));
    assert.equal((await analysisOf(w.message))?.status, "succeeded");
    assert.deepEqual(w.unsubscribes, [w.message.id]);
  });

  test("analysis turned off while it waited: the email is never read", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    await AppDataSource.getRepository(MailAccount).update(
      { id: w.account.id },
      { aiAnalysisEnabled: false },
    );
    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 0);
    assert.equal(await analysisOf(w.message), null);
    assert.equal((await waits()).length, 0);
  });

  test("a rule that unsubscribed while the read waited is never repeated by the instructions", async () => {
    const w = await world();
    await insert(MailRule, {
      companyId: COMPANY_ID,
      accountId: w.account.id,
      name: "Unsubscribe from the shop",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({ from: "shop.example" }),
      actionsJson: JSON.stringify([{ type: "unsubscribe" }]),
    });
    down(w.model);
    await arrive(w);
    assert.deepEqual(w.unsubscribes, [`rule:${w.message.id}`], "the rule ran while the read waited");

    resumeThroughStandIns(w);
    await back(w.model);
    await settleModelWaitsForTests();
    const steps = parseAutoActions((await analysisOf(w.message))?.autoActionsJson);
    const unsubscribe = steps.find((step) => step.action === "unsubscribe");
    assert.equal(unsubscribe?.status, "skipped");
    assert.match(unsubscribe?.detail ?? "", /rule already unsubscribed/);
    assert.equal(steps.find((step) => step.action === "star")?.status, "done");
    assert.deepEqual(w.unsubscribes, [`rule:${w.message.id}`], "the sender is asked exactly once");
  });

  test("a restart during the outage: the arrival still waits after boot and is read when the model is back", async () => {
    const w = await world();
    down(w.model);
    await flushModelAvailabilityWrites();
    await arrive(w);
    // The process stops; the next one reads the open outage back from its row.
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    resumeThroughStandIns(w);
    await settleModelWaitsForTests();
    assert.equal(w.reads.length, 0, "still unavailable after the restart");
    await back(w.model);
    await settleModelWaitsForTests();
    assert.equal((await analysisOf(w.message))?.status, "succeeded");
    assert.deepEqual(w.unsubscribes, [w.message.id]);
  });
});

describe("a person reading an email again during an outage", () => {
  test("an arrival read that waits cannot be taken over by a re-read", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    await back(w.model);
    await assert.rejects(
      analyzeInboundMessage(w.account, w.message, readDependencies(w)),
      MailAnalysisWaiting,
    );
    assert.equal((await analysisOf(w.message))?.status, "waiting");
    assert.equal(w.reads.length, 0);
  });

  test("a re-read while the model is down is refused before the verdict on the email is touched", async () => {
    const w = await world();
    await arrive(w);
    const before = await analysisOf(w.message);
    assert.equal(before?.status, "succeeded");
    down(w.model);
    await assert.rejects(
      analyzeInboundMessage(w.account, w.message, readDependencies(w)),
      MailAnalysisModelUnavailable,
    );
    const after = await analysisOf(w.message);
    assert.equal(after?.status, "succeeded");
    assert.equal(after?.summary, before?.summary);
    assert.equal(after?.updatedAt.getTime(), before?.updatedAt.getTime());
  });

  test("a re-read the outage cuts short says so plainly, and never waits as an arrival", async () => {
    const w = await world();
    await arrive(w);
    const reread = await analyzeInboundMessage(
      w.account,
      w.message,
      readDependencies(w, () => "unavailable"),
    );
    assert.equal(reread?.status, "failed");
    assert.match(reread?.errorMessage ?? "", /AI Model became unavailable/);
    assert.doesNotMatch(reread?.errorMessage ?? "", /HTTP 529/);
    assert.equal((await waits()).length, 0);
  });
});

describe("what the thread shows", () => {
  test("an email waiting for its AI Model reads as queued for review, never as a problem", async () => {
    const w = await world();
    down(w.model);
    await arrive(w);
    const summary = summarizeMailReview({
      account: w.account,
      message: w.message,
      analyses: [(await analysisOf(w.message))!],
      handovers: [],
      employees: new Map([[w.reader.id, w.reader]]),
    });
    assert.equal(summary.status, "queued");
  });
});
