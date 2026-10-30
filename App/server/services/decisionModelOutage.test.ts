import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModelWait } from "../db/entities/AIModelWait.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import { openCodeError } from "./agent/opencodeEvents.js";
import type { EmployeeAgentResult } from "./agent/runEmployee.js";
import { agentRuntime } from "./agent/runtime.js";
import { kickoffDecision } from "./decisionKickoff.js";
import {
  ROUTED_DECISION_FUSE_MS,
  kickoffRoutedDecision,
  sweepRoutedDecisions,
} from "./decisionRouting.js";
import { screenDecision } from "./decisionScreening.js";
import { createDecision, decideDecision } from "./decisions.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  loadModelOutages,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "./modelWaits.js";
import { liftStanddown, placeStanddown, refreshStanddowns, stopStanddowns } from "./standdowns.js";

/**
 * Decisions while an AI Model is unavailable. The work an answer starts (the
 * pickup) waits for the asker's model and starts by itself when it is back —
 * the same session, under the authority it was given, checked again then. An
 * AI decider whose model is down keeps the question it was routed, and nobody
 * is paged for an outage; the fuse still hands it to people if the wait
 * outlasts it. The intake screen fails open, as on any error. The runtime is
 * a stand-in; the services, the chat seam, the wait ledger and the breaker
 * are real.
 */

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];

before(initTestDb);
after(closeTestDb);

let company: Company;
let asker: AIEmployee;
let askerModel: AIModel;
let member: User;

beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  await refreshStanddowns();
  member = await insert(User, {
    email: "member@example.com",
    name: "Mia",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  asker = await insert(AIEmployee, {
    companyId: company.id,
    name: "Nova",
    slug: "nova",
    role: "Operations",
  });
  askerModel = await insertEmployeeModel({
    employeeId: asker.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
    isActive: true,
    connectedAt: new Date(),
  });
});
afterEach(() => {
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});

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

function overloadedError(): Error {
  return openCodeError({
    name: "APIError",
    data: {
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    },
  } as never);
}

function runtime(
  t: TestContext,
  answer: (call: number, params: RuntimeParams) => string | Error = () => "Sent the reply to Acme.",
): RuntimeParams[] {
  const calls: RuntimeParams[] = [];
  t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
    calls.push(params);
    const outcome = answer(calls.length, params);
    if (outcome instanceof Error) throw outcome;
    params.callbacks?.onText?.(outcome);
    return { finalText: outcome, steps: 1, stopReason: "end_turn" };
  });
  return calls;
}

async function stackAndAnswer(): Promise<Decision> {
  const { decision } = await createDecision({
    companyId: company.id,
    employeeId: asker.id,
    title: "Send the pricing reply?",
    body: "## Draft\n\nHello **Acme**,",
    options: [{ label: "Send it", tone: "primary" }, { label: "Hold" }],
  });
  const outcome = await decideDecision({
    companyId: company.id,
    decisionId: decision.id,
    userId: member.id,
    role: "member",
    optionId: "send-it",
    note: null,
  });
  assert.equal(outcome.outcome, "decided");
  return AppDataSource.getRepository(Decision).findOneByOrFail({ id: decision.id });
}

async function reload(id: string): Promise<Decision> {
  return AppDataSource.getRepository(Decision).findOneByOrFail({ id });
}

async function pickedUpJournal(): Promise<number> {
  const rows = await AppDataSource.getRepository(JournalEntry).findBy({ employeeId: asker.id });
  return rows.filter((row) => row.title.startsWith("Picked up")).length;
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

describe("the work an answer starts, while the asker's AI Model is unavailable", () => {
  test("waits — not failed, not journaled — and starts once the model is back, under the Member's authority", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    const decision = await stackAndAnswer();
    const outcome = await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    assert.equal(outcome, "waiting");
    assert.equal(calls.length, 0, "nothing is sent to a model that is down");
    const waiting = await reload(decision.id);
    assert.equal(waiting.pickupStatus, "waiting");
    assert.match(waiting.pickupSummary ?? "", /AI Model is unavailable/);
    assert.equal(waiting.pickupFinishedAt, null);
    assert.equal(await pickedUpJournal(), 0);
    const [wait] = await waits();
    assert.equal(wait.kind, "decision_pickup");
    assert.deepEqual(JSON.parse(wait.payloadJson), {
      authority: "member",
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });

    await settleModelWaitsForTests();
    assert.equal(calls.length, 0, "still down");

    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    const done = await reload(decision.id);
    assert.equal(done.pickupStatus, "done");
    assert.equal(done.pickupSummary, "Sent the reply to Acme.");
    assert.equal(await pickedUpJournal(), 1);
    assert.equal((await waits()).length, 0);

    await settleModelWaitsForTests();
    assert.equal(calls.length, 1, "started exactly once");
  });

  test("an outage in the middle of the session waits too, and starts again once the model is back", async (t) => {
    const calls = runtime(t, (call) => (call === 1 ? overloadedError() : "Sent it."));
    const decision = await stackAndAnswer();
    assert.equal(
      await kickoffDecision({
        companyId: company.id,
        decisionId: decision.id,
        requesterUserId: member.id,
        requesterSessionVersion: 0,
      }),
      "waiting",
    );
    assert.equal((await reload(decision.id)).pickupStatus, "waiting");
    assert.doesNotMatch((await reload(decision.id)).pickupSummary ?? "", /529|Overloaded/);
    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 2);
    assert.equal((await reload(decision.id)).pickupStatus, "done");
  });

  test("a password reset during the outage: the work never starts on the authority it no longer has", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    await AppDataSource.getRepository(User).update({ id: member.id }, { sessionVersion: 1 });
    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0, "the model is never asked");
    const row = await reload(decision.id);
    assert.equal(row.pickupStatus, "failed");
    assert.match(row.pickupSummary ?? "", /access changed/);
  });

  test("an AI decider's answer waits too, and its pickup runs under the asker's own authority", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    const decision = await stackAndAnswer();
    await kickoffDecision({ companyId: company.id, decisionId: decision.id, authority: "employee" });
    const [wait] = await waits();
    assert.equal(JSON.parse(wait.payloadJson).authority, "employee");
    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.equal((await reload(decision.id)).pickupStatus, "done");
  });

  test("a Standdown placed during the outage holds: the model is never asked, and the row says why", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    await placeStanddown({ companyId: company.id, scope: "company", reason: "Quarter close." });
    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    assert.match((await reload(decision.id)).pickupSummary ?? "", /stood down/);
  });

  test("lifting a Standdown while the model is still down starts nothing", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "company",
      reason: "Quarter close.",
    });
    await liftStanddown({ standdown, userId: null });
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    assert.equal((await reload(decision.id)).pickupStatus, "waiting");
  });

  test("a restart during the outage: the pickup still waits after boot and starts once when the model is back", async (t) => {
    const calls = runtime(t);
    down(askerModel);
    await flushModelAvailabilityWrites();
    const decision = await stackAndAnswer();
    await kickoffDecision({
      companyId: company.id,
      decisionId: decision.id,
      requesterUserId: member.id,
      requesterSessionVersion: 0,
    });
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    await back(askerModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.equal((await reload(decision.id)).pickupStatus, "done");
  });
});

describe("an AI decider whose AI Model is unavailable", () => {
  let decider: AIEmployee;
  let deciderModel: AIModel;

  beforeEach(async () => {
    decider = await insert(AIEmployee, {
      companyId: company.id,
      name: "Meredith",
      slug: "meredith",
      role: "Head of Ops",
    });
    deciderModel = await insertEmployeeModel({
      employeeId: decider.id,
      provider: "openai",
      model: "gpt-test",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
      connectedAt: new Date(),
    });
    await insert(DecisionPolicy, {
      companyId: company.id,
      askingEmployeeId: null,
      deciderKind: "employee",
      deciderEmployeeId: decider.id,
      sortOrder: 0,
      enabled: true,
    });
  });

  async function routed(): Promise<Decision> {
    const { decision } = await createDecision({
      companyId: company.id,
      employeeId: asker.id,
      title: "Approve the vendor swap?",
      options: [{ label: "Swap" }, { label: "Keep" }],
    });
    const row = await reload(decision.id);
    assert.equal(row.routedToEmployeeId, decider.id);
    return row;
  }

  test("keeps the question, pages nobody, and its session starts once the model is back", async (t) => {
    const calls = runtime(t, () => "Looked into it; deciding now.");
    down(deciderModel);
    const decision = await routed();
    assert.equal(
      await kickoffRoutedDecision({ companyId: company.id, decisionId: decision.id }),
      "waiting",
    );
    const waiting = await reload(decision.id);
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.routedToEmployeeId, decider.id, "never handed to people for an outage");
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0, "nobody is paged");
    assert.equal(calls.length, 0);

    await back(deciderModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.match(JSON.stringify(calls[0].messages), /Approve the vendor swap/);
    assert.equal((await waits()).length, 0);
  });

  test("a session the outage cut short keeps the question routed and waits", async (t) => {
    const calls = runtime(t, (call) => (call === 1 ? overloadedError() : "Deciding now."));
    const decision = await routed();
    assert.equal(
      await kickoffRoutedDecision({ companyId: company.id, decisionId: decision.id }),
      "waiting",
    );
    assert.equal((await reload(decision.id)).routedToEmployeeId, decider.id);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
    await back(deciderModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 2);
  });

  test("the fuse still hands the question to people when the outage outlasts it", async (t) => {
    const calls = runtime(t);
    down(deciderModel);
    const decision = await routed();
    await kickoffRoutedDecision({ companyId: company.id, decisionId: decision.id });
    await sweepRoutedDecisions(new Date(Date.now() + ROUTED_DECISION_FUSE_MS + 60_000));
    assert.equal((await reload(decision.id)).routedToEmployeeId, null);
    await back(deciderModel);
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0, "nothing waits once people have the question");
    assert.equal((await waits()).length, 0);
  });
});

describe("the intake screen while the AI Model is unavailable", () => {
  const question = {
    title: "Rename the Q3 folder?",
    humanDecisionReason: "Folder names are shared.",
    body: "",
    options: [
      { label: "Rename", detail: null },
      { label: "Keep", detail: null },
    ],
    urgency: "normal" as const,
  };

  test("fails open at once: the question goes through unchecked, and the model is never asked", async () => {
    down(askerModel);
    let ran = 0;
    const outcome = await screenDecision(
      { employee: asker, instructionsText: "Housekeeping never belongs on the stack.", question },
      {
        runScreen: async () => {
          ran += 1;
          return { belongsOnStack: false, reason: "Housekeeping.", instruction: 1 };
        },
      },
    );
    assert.equal(ran, 0);
    assert.equal(outcome.outcome, "unscreened");
    assert.equal(outcome.outcome === "unscreened" ? outcome.cause : null, "model_unavailable");
  });

  test("an outage in the middle of the check fails open too, never kept off", async () => {
    const outcome = await screenDecision(
      { employee: asker, instructionsText: "Housekeeping never belongs on the stack.", question },
      {
        runScreen: async (args) => {
          const { runDecisionScreen } = await import("./decisionScreening.js");
          return runDecisionScreen(args, {
            runRestricted: async (): Promise<EmployeeAgentResult> => ({
              status: "error",
              error: "The AI Model answered with a server error (HTTP 529).",
              unavailable: modelUnavailability("overloaded", { status: 529 }),
            }),
          });
        },
      },
    );
    assert.equal(outcome.outcome, "unscreened");
    assert.equal(outcome.outcome === "unscreened" ? outcome.cause : null, "model_unavailable");
    assert.doesNotMatch(outcome.outcome === "unscreened" ? outcome.detail : "", /529/);
  });
});
