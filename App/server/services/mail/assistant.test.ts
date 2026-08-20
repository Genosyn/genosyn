import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { Attachment } from "../../db/entities/Attachment.js";
import { Company } from "../../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailChatMessage } from "../../db/entities/MailChatMessage.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { WorkloadLease } from "../../db/entities/WorkloadLease.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import type { ChatResult } from "../chat.js";
import { companyDir } from "../paths.js";
import { recordAttachmentBytes } from "../uploads.js";
import { EmployeeWorkloadBusyError } from "../workloadLeases.js";
import {
  assistantRoster,
  finalizeInterruptedAssistantTurns,
  lastAssistantModelId,
  runAssistantTurn,
  serializeAssistantMessage,
  type AssistantTurnCallbacks,
} from "./assistant.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_assistant_test";

type SerializedMessage = ReturnType<typeof serializeAssistantMessage>;

type Recorded = {
  callbacks: AssistantTurnCallbacks;
  working: MailChatMessage["id"][];
  assistant: { id: string; status: string | null; content: string }[];
  /** Full serialized payloads, for the fields the panel renders. */
  userMessages: SerializedMessage[];
  assistantMessages: SerializedMessage[];
};

function recorder(): Recorded {
  const working: string[] = [];
  const assistant: { id: string; status: string | null; content: string }[] = [];
  const userMessages: SerializedMessage[] = [];
  const assistantMessages: SerializedMessage[] = [];
  return {
    working,
    assistant,
    userMessages,
    assistantMessages,
    callbacks: {
      onUser: (msg) => userMessages.push(msg),
      onTarget: () => {},
      onWorking: (msg) => working.push(msg.id),
      onChunk: () => {},
      onAssistant: (msg) => {
        assistant.push({ id: msg.id, status: msg.status, content: msg.content });
        assistantMessages.push(msg);
      },
    },
  };
}

function chatResult(
  reply: string,
  status: ChatResult["status"] = "ok",
  attachmentIds: string[] = [],
): ChatResult {
  return { status, reply, attachmentIds, sidecars: {} } as ChatResult;
}

async function fixture(): Promise<{
  account: MailAccount;
  employee: AIEmployee;
  threadId: string;
}> {
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
  test("closes rows left working by a dead process and frees their reply lease", async () => {
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

// ───────────────────────────── attachments ─────────────────────────────

/**
 * A fixture with a real Company row: attachments are written under the
 * company's directory, so these tests need one on disk as well as in the DB.
 */
async function companyFixture(): Promise<{
  company: Company;
  account: MailAccount;
  employee: AIEmployee;
  thread: MailThread;
}> {
  const company = await insert(Company, {
    name: "Attachment Chat Co",
    slug: `attachment-chat-${randomUUID()}`,
    ownerId: "owner-1",
  });
  const account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: testId("connection"),
    address: "ap@example.com",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
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
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: testId("gmail-thread"),
    subject: "Syniti New Supplier Form US",
  });
  return { company, account, employee, thread };
}

function cleanUp(company: Company): void {
  fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
}

async function stageFile(company: Company, filename: string, body: string): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    filename,
    mimeType: filename.endsWith(".pdf") ? "application/pdf" : "text/plain",
    bytes: Buffer.from(body),
    uploadedByUserId: null,
  });
}

describe("files on an email's AI chat", () => {
  test("a file the employee produced lands on its reply, not just on disk", async () => {
    const { company, account, employee, thread } = await companyFixture();
    const produced = await stageFile(company, "FIF_2026-filled.pdf", "%PDF filled");
    const rec = recorder();

    await runAssistantTurn({
      account,
      message: "@jamie fill in the supplier form",
      threadId: thread.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => chatResult("Filled it in — draft attached.", "ok", [produced.id]),
    });

    const reply = rec.assistantMessages.at(-1);
    assert.ok(reply);
    assert.deepEqual(
      reply.attachments.map((a) => a.filename),
      ["FIF_2026-filled.pdf"],
      "the panel is told about the file in the same payload as the reply",
    );
    const bound = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: produced.id,
    });
    assert.equal(bound.messageId, reply.id, "the file belongs to the reply it was produced for");
    assert.equal(reply.employeeId, employee.id);
    cleanUp(company);
  });

  test("a teammate's upload is bound to their turn and inlined for the employee", async () => {
    const { company, account, thread } = await companyFixture();
    const upload = await stageFile(company, "w9.txt", "Taxpayer name: HackerBay, Inc.");
    const rec = recorder();
    let prompt = "";

    await runAssistantTurn({
      account,
      message: "@jamie here is our W-9",
      threadId: thread.id,
      attachmentIds: [upload.id],
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, text) => {
        prompt = text;
        return chatResult("Got it.");
      },
    });

    const userRow = rec.userMessages.at(-1);
    assert.ok(userRow);
    assert.deepEqual(
      userRow.attachments.map((a) => a.filename),
      ["w9.txt"],
    );
    assert.match(prompt, /\[Attachment id=/, "the employee is handed a usable attachment id");
    assert.match(prompt, new RegExp(upload.id));
    assert.match(prompt, /Taxpayer name: HackerBay, Inc\./, "readable files are inlined as text");
    cleanUp(company);
  });

  test("an attachment id from another company is ignored rather than bound", async () => {
    const { company, account, thread } = await companyFixture();
    const other = await insert(Company, {
      name: "Other Co",
      slug: `other-co-${randomUUID()}`,
      ownerId: "owner-2",
    });
    const foreign = await stageFile(other, "secret.txt", "not yours");
    const rec = recorder();

    await runAssistantTurn({
      account,
      message: "@jamie look at this",
      threadId: thread.id,
      attachmentIds: [foreign.id],
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => chatResult("Nothing attached."),
    });

    const stillUnbound = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: foreign.id,
    });
    assert.equal(stillUnbound.messageId, null);
    assert.deepEqual(rec.userMessages.at(-1)?.attachments, []);
    cleanUp(company);
    cleanUp(other);
  });

  test("the thread context names each attachment and how to open it", async () => {
    const { company, account, thread } = await companyFixture();
    await insert(MailMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: "gmail-1",
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "accountspayable@syniti.com",
      subject: "Supplier onboarding",
      bodyText: "Please complete the attached form.",
      sentAt: new Date(),
      attachmentsJson: JSON.stringify([
        {
          partId: "1.1",
          attachmentId: "gmail-att",
          filename: "FIF_2026.pdf",
          mimeType: "application/pdf",
          size: 4096,
        },
      ]),
    });
    const rec = recorder();
    let prompt = "";

    await runAssistantTurn({
      account,
      message: "@jamie can you complete this form?",
      threadId: thread.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, text) => {
        prompt = text;
        return chatResult("On it.");
      },
    });

    assert.match(prompt, /read_mail_attachment/, "the context says which tool opens the file");
    assert.match(prompt, /index 0 "FIF_2026\.pdf"/);
    cleanUp(company);
  });

  test("the briefing tells the employee to open files itself rather than ask for a re-upload", async () => {
    const { company, account, thread } = await companyFixture();
    const rec = recorder();
    let system = "";

    await runAssistantTurn({
      account,
      message: "@jamie any updates?",
      threadId: thread.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, _prompt, _history, _onChunk, options) => {
        system = options?.extraSystem ?? "";
        return chatResult("No update yet.");
      },
    });

    assert.match(system, /read_mail_attachment/);
    assert.match(system, /Never ask the teammate to download and re-upload/);
    assert.match(system, /download_web_file/, "finding a form online is part of the job");
    cleanUp(company);
  });

  test("the panel's toolset carries the attachment and PDF tools", async () => {
    const { company, account, thread } = await companyFixture();
    const rec = recorder();
    let toolset: string[] = [];

    await runAssistantTurn({
      account,
      message: "@jamie fill the form",
      threadId: thread.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, _prompt, _history, _onChunk, options) => {
        toolset = options?.extraToolset ?? [];
        return chatResult("Done.");
      },
    });

    for (const tool of ["read_mail_attachment", "read_pdf_fields", "fill_pdf_form"]) {
      assert.ok(toolset.includes(tool), `${tool} is loaded without a discovery round-trip`);
    }
    cleanUp(company);
  });
});

// ───────────────────────────── model selection ─────────────────────────────

async function connectedModel(
  employeeId: string,
  model: string,
  isActive = false,
): Promise<AIModel> {
  return insert(AIModel, {
    employeeId,
    provider: "anthropic",
    model,
    authMode: "apikey",
    isActive,
    configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-key" }),
    connectedAt: new Date(),
  });
}

describe("choosing the model for an email's chat", () => {
  test("runs the turn on the picked model and records it on the row", async () => {
    const { company, account, employee, thread } = await companyFixture();
    await connectedModel(employee.id, "claude-active", true);
    const picked = await connectedModel(employee.id, "claude-picked");
    const rec = recorder();
    let usedModelId: string | null | undefined;

    await runAssistantTurn({
      account,
      message: "@jamie summarize this",
      threadId: thread.id,
      modelId: picked.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, _prompt, _history, _onChunk, options) => {
        usedModelId = options?.modelId;
        return chatResult("Summary.");
      },
    });

    assert.equal(usedModelId, picked.id);
    const row = (await messages()).find((m) => m.role === "assistant");
    assert.equal(row?.modelId, picked.id);
    assert.equal(rec.assistantMessages.at(-1)?.modelId, picked.id);
    cleanUp(company);
  });

  test("no pick inherits the employee's active model, resolved at acceptance", async () => {
    const { company, account, employee, thread } = await companyFixture();
    const active = await connectedModel(employee.id, "claude-active", true);
    await connectedModel(employee.id, "claude-other");
    const rec = recorder();

    await runAssistantTurn({
      account,
      message: "@jamie summarize this",
      threadId: thread.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async () => chatResult("Summary."),
    });

    const row = (await messages()).find((m) => m.role === "assistant");
    assert.equal(row?.modelId, active.id);
    cleanUp(company);
  });

  test("a model belonging to another employee falls back, and the row says which ran", async () => {
    const { company, account, employee, thread } = await companyFixture();
    const active = await connectedModel(employee.id, "claude-active", true);
    const stranger = await insert(AIEmployee, {
      companyId: company.id,
      name: "Someone Else",
      slug: "someone-else",
      role: "Ops",
    });
    const foreign = await connectedModel(stranger.id, "claude-foreign", true);
    const rec = recorder();
    let usedModelId: string | null | undefined;

    await runAssistantTurn({
      account,
      message: "@jamie summarize this",
      threadId: thread.id,
      modelId: foreign.id,
      userId: null,
      callbacks: rec.callbacks,
      runChat: async (_companyId, _employeeId, _prompt, _history, _onChunk, options) => {
        usedModelId = options?.modelId;
        return chatResult("Summary.");
      },
    });

    assert.equal(usedModelId, active.id, "falls back to the employee's own active model");
    const row = (await messages()).find((m) => m.role === "assistant");
    assert.equal(row?.modelId, active.id, "the row records the brain that actually answered");
    cleanUp(company);
  });

  test("the conversation resumes on the model its last answered turn used", async () => {
    const { company, account, employee, thread } = await companyFixture();
    await connectedModel(employee.id, "claude-active", true);
    const picked = await connectedModel(employee.id, "claude-picked");
    await insert(MailChatMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      role: "assistant",
      employeeId: employee.id,
      modelId: picked.id,
      content: "Earlier answer.",
      status: "ok",
    });

    assert.equal(await lastAssistantModelId(account.id, thread.id, employee.id), picked.id);
    cleanUp(company);
  });

  test("a deleted model is not offered back to the conversation", async () => {
    const { company, account, employee, thread } = await companyFixture();
    await connectedModel(employee.id, "claude-active", true);
    await insert(MailChatMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      role: "assistant",
      employeeId: employee.id,
      modelId: randomUUID(),
      content: "Answered on a model that no longer exists.",
      status: "ok",
    });

    assert.equal(await lastAssistantModelId(account.id, thread.id, employee.id), null);
    cleanUp(company);
  });

  test("the roster offers only connected models, active one first", async () => {
    const { company, account, employee } = await companyFixture();
    await connectedModel(employee.id, "claude-secondary");
    await connectedModel(employee.id, "claude-active", true);
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-unconfigured",
      authMode: "apikey",
      isActive: false,
      configJson: "{}",
    });

    const roster = await assistantRoster(company.id, account.id);
    const entry = roster.find((r) => r.id === employee.id);

    assert.ok(entry);
    assert.equal(entry.hasModel, true);
    assert.deepEqual(
      entry.models.map((m) => m.model),
      ["claude-active", "claude-secondary"],
      "an unconnected model cannot answer, so it is not offered",
    );
    cleanUp(company);
  });

  test("an employee with no connected model is taggable but offers no picker", async () => {
    const { company, account, employee } = await companyFixture();
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-unconfigured",
      authMode: "apikey",
      isActive: true,
      configJson: "{}",
    });

    const entry = (await assistantRoster(company.id, account.id)).find((r) => r.id === employee.id);

    assert.ok(entry);
    assert.equal(entry.hasModel, true, "a row exists, so the chat seam has something to resolve");
    assert.deepEqual(entry.models, [], "but nothing connected is offered as a choice");
    cleanUp(company);
  });
});
