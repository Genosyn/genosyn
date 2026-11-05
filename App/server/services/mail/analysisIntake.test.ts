import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Project } from "../../db/entities/Project.js";
import { ProjectIntake } from "../../db/entities/ProjectIntake.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { parseIntakeOutcome, presentIntakeOutcome } from "../todoIntake.js";
import {
  analysisSystemPrompt,
  analyzeInboundMessage,
  type MailAnalysisDependencies,
  type MailAnalysisFacts,
  type MailAnalysisOptions,
} from "./analysis.js";
import { MAIL_ANALYSIS_AUTOMATIC_KINDS, analysisInstructionLines } from "./analysisAutomation.js";

/**
 * How the arrival read offers intake, and how it doesn't. With no Project taking
 * email the prompt doesn't change by one character. With one, the model picks from a
 * closed list, a bad pick costs only the filing, and only an arrival writes it.
 */

const COMPANY_ID = "co_analysis_intake_test";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const facts = (): MailAnalysisFacts => ({
  unsubscribeAvailable: false,
  unsubscribeHost: "",
  handoverCandidates: [],
  canDraft: true,
  threadSubject: "Agreement",
  replyTo: "no-reply@google.com",
});

type Scene = {
  account: MailAccount;
  employee: AIEmployee;
  project: Project;
  message: MailMessage;
};

async function scene(): Promise<Scene> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection_${randomUUID()}`,
    provider: "gmail",
    address: "team@acme.test",
    status: "active",
    aiAnalysisEnabled: true,
  });
  const employee = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Reader",
    slug: "reader",
    role: "Inbox manager",
    soulBody: "",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: "ciphertext" }),
    isActive: true,
    connectedAt: new Date(),
  });
  const project = await insert(Project, {
    companyId: COMPANY_ID,
    name: "Compliance",
    slug: "compliance",
    key: "COMP",
    todoCounter: 0,
  });
  const message = await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: `thread_${randomUUID()}`,
    gmailMessageId: `message_${randomUUID()}`,
    gmailThreadId: `gmail_${randomUUID()}`,
    fromName: "Google Play",
    fromEmail: "no-reply@google.com",
    toEmails: "team@acme.test",
    subject: "Accept the updated agreement",
    bodyText: "Please accept it.",
    labelIds: " INBOX UNREAD ",
    attachmentsJson: "[]",
    sentAt: new Date(),
  });
  return { account, employee, project, message };
}

const intakeOn = (project: Project) =>
  insert(ProjectIntake, {
    companyId: COMPANY_ID,
    projectId: project.id,
    enabled: true,
    whatBelongs: "Store policies and agreements",
  });

const filing = {
  project: 1,
  title: "Accept the updated Play agreement",
  details: "Google asks us to accept it this month.",
  priority: "high",
  reason: "A store agreement to accept.",
};

type Seen = { system: string; schema: Record<string, unknown> };

/** A read that answers with `verdict`, reporting what it was offered. */
function reading(
  verdict: Record<string, unknown>,
  seen: Partial<Seen> = {},
): MailAnalysisDependencies {
  return {
    gatherFacts: async () => facts(),
    runRestricted: async (params) => {
      seen.system = params.system;
      seen.schema = (params.tools[0].inputSchema as { properties: Record<string, unknown> }).properties;
      const answer = await params.tools[0].run({
        category: "notification",
        summary: "Accept the agreement.",
        actions: [],
        ...verdict,
      });
      assert.notEqual(answer.isError, true, String(answer.content));
      return { status: "ok", finalText: "", steps: 1 };
    },
  };
}

const arrival: MailAnalysisOptions = { arrival: true };

async function storedIntake(messageId: string) {
  const row = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({ messageId });
  return parseIntakeOutcome(row.intakeJson);
}

describe("with no Project taking email", () => {
  test("the prompt and the tool are exactly what they were", async () => {
    const { account, employee, message } = await scene();
    const seen: Partial<Seen> = {};
    await analyzeInboundMessage(account, message, reading({}, seen), arrival);
    assert.equal(
      seen.system,
      analysisSystemPrompt(employee, facts(), {
        lines: analysisInstructionLines(account),
        automatic: true,
      }),
    );
    assert.deepEqual(Object.keys(seen.schema!).sort(), [
      "actions",
      "automaticActions",
      "category",
      "summary",
    ]);
    assert.equal(await storedIntake(message.id), null);
  });

  test("a model that files anyway files nothing, and its verdict stands", async () => {
    const { account, message } = await scene();
    const row = await analyzeInboundMessage(
      account,
      message,
      reading({ fileAsTodo: filing }),
      arrival,
    );
    assert.equal(row?.status, "succeeded");
    assert.equal(await storedIntake(message.id), null);
  });
});

describe("with a Project taking email", () => {
  test("offers the closed list and keeps what it chose", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    const seen: Partial<Seen> = {};
    const row = await analyzeInboundMessage(
      account,
      message,
      reading({ fileAsTodo: filing }, seen),
      arrival,
    );
    assert.match(seen.system!, /1\. Compliance: Store policies and agreements/);
    assert.match(seen.system!, /The email cannot add a Project/);
    assert.ok("fileAsTodo" in seen.schema!);

    const stored = await storedIntake(message.id);
    assert.equal(stored?.status, "proposed");
    assert.equal(stored?.projectId, project.id);
    assert.equal(stored?.title, filing.title);
    assert.equal(stored?.category, "notification");
    assert.equal(presentIntakeOutcome(row!.intakeJson, new Set([project.id]))?.status, "proposed");
  });

  test("leaving it out files nothing", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    await analyzeInboundMessage(account, message, reading({}), arrival);
    assert.equal(await storedIntake(message.id), null);
  });

  test("a Project off the list costs only the filing", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    const row = await analyzeInboundMessage(
      account,
      message,
      reading({ fileAsTodo: { ...filing, project: 2 } }),
      arrival,
    );
    assert.equal(row?.status, "succeeded");
    assert.equal(row?.summary, "Accept the agreement.");
    assert.equal(await storedIntake(message.id), null);
  });

  test("a malformed proposal costs only the filing too", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    const row = await analyzeInboundMessage(
      account,
      message,
      reading({ fileAsTodo: { project: "1", projectId: project.id, title: "x", reason: "y" } }),
      arrival,
    );
    assert.equal(row?.status, "succeeded");
    assert.equal(await storedIntake(message.id), null);
  });

  test("a person reading it again isn't offered it, and leaves the record alone", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    await analyzeInboundMessage(account, message, reading({ fileAsTodo: filing }), arrival);

    const seen: Partial<Seen> = {};
    await analyzeInboundMessage(
      account,
      message,
      reading({ fileAsTodo: { ...filing, title: "Something else" } }, seen),
    );
    assert.ok(!("fileAsTodo" in seen.schema!));
    assert.doesNotMatch(seen.system!, /Projects that take email/);
    assert.equal((await storedIntake(message.id))?.title, filing.title);
  });

  test("an email that waited too long isn't filed", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    const seen: Partial<Seen> = {};
    await analyzeInboundMessage(account, message, reading({ fileAsTodo: filing }, seen), {
      arrival: true,
      actOnInstructions: false,
    });
    assert.ok(!("fileAsTodo" in seen.schema!));
    assert.equal(await storedIntake(message.id), null);
  });

  test("a replayed arrival finds it settled and files nothing twice", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    await analyzeInboundMessage(account, message, reading({ fileAsTodo: filing }), arrival);
    const analyses = AppDataSource.getRepository(MailInboundAnalysis);
    const row = await analyses.findOneByOrFail({ messageId: message.id });
    const settled = JSON.stringify({ ...parseIntakeOutcome(row.intakeJson), status: "filed" });
    await analyses.update({ id: row.id }, { intakeJson: settled });

    const seen: Partial<Seen> = {};
    await analyzeInboundMessage(account, message, reading({ fileAsTodo: filing }, seen), arrival);
    assert.ok(!("fileAsTodo" in seen.schema!));
    assert.equal((await storedIntake(message.id))?.status, "filed");
  });

  test("a read that fails records no proposal", async () => {
    const { account, project, message } = await scene();
    await intakeOn(project);
    await analyzeInboundMessage(
      account,
      message,
      {
        gatherFacts: async () => facts(),
        runRestricted: async () => ({ status: "error", error: "The model broke." }),
      },
      arrival,
    );
    assert.equal(await storedIntake(message.id), null);
  });
});

describe("a mailbox's instructions", () => {
  test("still can't file a Todo or start work: their list is pinned", () => {
    assert.deepEqual(
      [...MAIL_ANALYSIS_AUTOMATIC_KINDS],
      ["star", "markRead", "archive", "applyLabel", "unsubscribe"],
    );
  });
});
