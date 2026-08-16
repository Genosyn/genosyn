import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailChatMessage } from "../../db/entities/MailChatMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { WorkloadLease } from "../../db/entities/WorkloadLease.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import type { ChatResult } from "../chat.js";
import { EmployeeWorkloadBusyError } from "../workloadLeases.js";
import {
  finalizeInterruptedAssistantTurns,
  runAssistantTurn,
  type AssistantTurnCallbacks,
} from "./assistant.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_assistant_test";

type Recorded = {
  callbacks: AssistantTurnCallbacks;
  working: MailChatMessage["id"][];
  assistant: { id: string; status: string | null; content: string }[];
};

function recorder(): Recorded {
  const working: string[] = [];
  const assistant: { id: string; status: string | null; content: string }[] = [];
  return {
    working,
    assistant,
    callbacks: {
      onUser: () => {},
      onTarget: () => {},
      onWorking: (msg) => working.push(msg.id),
      onChunk: () => {},
      onAssistant: (msg) =>
        assistant.push({ id: msg.id, status: msg.status, content: msg.content }),
    },
  };
}

function chatResult(reply: string, status: ChatResult["status"] = "ok"): ChatResult {
  return { status, reply, attachmentIds: [], sidecars: {} } as ChatResult;
}

async function fixture(): Promise<{ account: MailAccount; employee: AIEmployee; threadId: string }> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: testId("connection"),
    address: "team@example.com",
  });
  const employee = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "Support",
  });
  await insert(EmployeeMailAccountGrant, {
    accountId: account.id,
    employeeId: employee.id,
    accessLevel: "draft",
  });
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: testId("gmail-thread"),
    subject: "Vendor forms",
  });
  return { account, employee, threadId: thread.id };
}

function messages(): Promise<MailChatMessage[]> {
  return AppDataSource.getRepository(MailChatMessage).find({ order: { createdAt: "ASC" } });
}

describe("per-email assistant turns", () => {
  test("persists an in-flight row before the model runs and finalizes it in place", async () => {
    const { account, employee, threadId } = await fixture();
    const rec = recorder();
    let observedDuringRun: MailChatMessage[] = [];

    await runAssistantTurn({
      account,
      message: "@jamie summarize this",
      threadId,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => {
        observedDuringRun = await messages();
        return chatResult("Here is the summary.");
      },
    });

    const inFlight = observedDuringRun.find((m) => m.role === "assistant");
    assert.ok(inFlight, "an assistant row exists while the model is still running");
    assert.equal(inFlight.status, "working");
    assert.equal(inFlight.employeeId, employee.id);
    assert.deepEqual(rec.working, [inFlight.id]);

    const finalRows = await messages();
    const assistantRows = finalRows.filter((m) => m.role === "assistant");
    assert.equal(assistantRows.length, 1, "the working row is updated, not duplicated");
    assert.equal(assistantRows[0].id, inFlight.id);
    assert.equal(assistantRows[0].status, "ok");
    assert.equal(assistantRows[0].content, "Here is the summary.");
    assert.deepEqual(
      rec.assistant.map((m) => m.id),
      [inFlight.id],
    );
  });

  test("a failing turn finalizes its row instead of leaving the question unanswered", async () => {
    const { account, threadId } = await fixture();
    const rec = recorder();

    await runAssistantTurn({
      account,
      message: "@jamie draft a reply",
      threadId,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => {
        throw new Error("model endpoint unreachable");
      },
    });

    const assistantRows = (await messages()).filter((m) => m.role === "assistant");
    assert.equal(assistantRows.length, 1);
    assert.equal(assistantRows[0].status, "error");
    assert.match(assistantRows[0].content, /model endpoint unreachable/);
    assert.equal(rec.assistant.length, 1);
  });

  test("a busy employee is waited for rather than handed back to the human", async () => {
    const { account, threadId } = await fixture();
    const rec = recorder();
    let attempts = 0;

    await runAssistantTurn({
      account,
      message: "@jamie triage this",
      threadId,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => {
        attempts += 1;
        if (attempts === 1) throw new EmployeeWorkloadBusyError();
        return chatResult("Triaged.");
      },
      // Keep the test fast: the production delay is ten seconds.
      busyRetryDelayMs: 1,
    });

    assert.equal(attempts, 2, "the turn retried once the slot freed up");
    const assistantRows = (await messages()).filter((m) => m.role === "assistant");
    assert.equal(assistantRows[0].status, "ok");
    assert.equal(assistantRows[0].content, "Triaged.");
  });

  test("an employee that stays busy ends as skipped, not as a silent failure", async () => {
    const { account, threadId } = await fixture();
    const rec = recorder();

    await runAssistantTurn({
      account,
      message: "@jamie triage this",
      threadId,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => {
        throw new EmployeeWorkloadBusyError();
      },
      busyRetryDelayMs: 1,
      busyMaxWaitMs: 5,
    });

    const assistantRows = (await messages()).filter((m) => m.role === "assistant");
    assert.equal(assistantRows.length, 1);
    assert.equal(assistantRows[0].status, "skipped");
    assert.match(assistantRows[0].content, /Jamie Mallers was busy with another message/);
  });

  test("an interrupted row is not replayed to the model as speech", async () => {
    const { account, employee, threadId } = await fixture();
    await insert(MailChatMessage, {
      companyId: COMPANY_ID,
      accountId: account.id,
      threadId,
      role: "user",
      content: "earlier question",
    });
    await insert(MailChatMessage, {
      companyId: COMPANY_ID,
      accountId: account.id,
      threadId,
      role: "assistant",
      employeeId: employee.id,
      content: "",
      status: "working",
    });
    const rec = recorder();
    let replayed: { role: string; content: string }[] = [];

    await runAssistantTurn({
      account,
      message: "@jamie any update?",
      threadId,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, _prompt, history) => {
        replayed = history;
        return chatResult("No update yet.");
      },
    });

    assert.deepEqual(
      replayed.map((turn) => turn.content),
      ["earlier question"],
    );
  });
});

describe("interrupted turn recovery", () => {
  test("closes rows left working by a dead process and frees their capacity lease", async () => {
    const { account, employee, threadId } = await fixture();
    const stranded = await insert(MailChatMessage, {
      companyId: COMPANY_ID,
      accountId: account.id,
      threadId,
      role: "assistant",
      employeeId: employee.id,
      content: "",
      status: "working",
    });
    await insert(WorkloadLease, {
      companyId: COMPANY_ID,
      employeeId: employee.id,
      kind: "chat",
      ownerKey: stranded.id,
      expiresAt: new Date(Date.now() + 6 * 60 * 60_000),
    });

    const closed = await finalizeInterruptedAssistantTurns();

    assert.equal(closed, 1);
    const row = await AppDataSource.getRepository(MailChatMessage).findOneByOrFail({
      id: stranded.id,
    });
    assert.equal(row.status, "error");
    assert.match(row.content, /restarted/i);
    assert.equal(await AppDataSource.getRepository(WorkloadLease).count(), 0);
  });

  test("leaves finished conversations alone", async () => {
    const { account, employee, threadId } = await fixture();
    await insert(MailChatMessage, {
      companyId: COMPANY_ID,
      accountId: account.id,
      threadId,
      role: "assistant",
      employeeId: employee.id,
      content: "Done.",
      status: "ok",
    });

    assert.equal(await finalizeInterruptedAssistantTurns(), 0);
    const rows = await messages();
    assert.equal(rows[0].status, "ok");
    assert.equal(rows[0].content, "Done.");
  });
});
