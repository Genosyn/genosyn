import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import {
  DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
  MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH,
} from "../../../shared/mailAnalysisInstructions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { analysisInstructionLines, effectiveAnalysisInstructions } from "./analysisAutomation.js";
import {
  MailAnalysisSettingsError,
  parseAnalysisInstructions,
  readMailAnalysisSettings,
  updateMailAnalysisSettings,
} from "./analysisSettings.js";

/**
 * The AI analysis card's service: what "default" means, what can be stored,
 * and that one PATCH is all-or-nothing and touches only its own columns.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_analysis_settings_test";

async function mailbox(overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection_${randomUUID()}`,
    address: "owner@example.com",
    status: "active",
    ...overrides,
  });
}

async function employee(name = "Jamie Mallers"): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId: COMPANY_ID,
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`,
    role: "Inbox manager",
  });
}

async function reload(account: MailAccount): Promise<MailAccount> {
  return AppDataSource.getRepository(MailAccount).findOneByOrFail({ id: account.id });
}

async function settingsAudits(): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { action: "mail.analysis.settings" },
    order: { createdAt: "ASC" },
  });
}

describe("which instructions a mailbox follows", () => {
  test("a mailbox nobody customised follows the default", () => {
    const account = Object.assign(new MailAccount(), { aiAnalysisInstructions: null });
    assert.equal(effectiveAnalysisInstructions(account), DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
    assert.deepEqual(analysisInstructionLines(account), [
      "Unsubscribe me automatically from marketing emails.",
      "Star emails that need my response and look important.",
    ]);
  });

  test("an emptied box is a deliberate choice of none, not the default", () => {
    const account = Object.assign(new MailAccount(), { aiAnalysisInstructions: "" });
    assert.equal(effectiveAnalysisInstructions(account), "");
    assert.deepEqual(analysisInstructionLines(account), []);
  });

  test("the mailbox's own text wins, split into its lines", () => {
    const account = Object.assign(new MailAccount(), {
      aiAnalysisInstructions: "- Star mail from Ana\n\n- Archive receipts",
    });
    assert.deepEqual(analysisInstructionLines(account), ["Star mail from Ana", "Archive receipts"]);
  });

  test("a new mailbox row starts on the default", async () => {
    const account = await mailbox();
    assert.equal((await reload(account)).aiAnalysisInstructions, null);
  });
});

describe("what the box may store", () => {
  test("null and the default typed out both mean the default", () => {
    assert.equal(parseAnalysisInstructions(null), null);
    assert.equal(parseAnalysisInstructions(DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS), null);
    assert.equal(
      parseAnalysisInstructions(`\n${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS.replace("\n", "  \r\n")}\n\n`),
      null,
    );
  });

  test("stores the person's own text in its normalized shape", () => {
    assert.equal(
      parseAnalysisInstructions("Star mail from Ana.  \r\nArchive receipts.\r\n"),
      "Star mail from Ana.\nArchive receipts.",
    );
  });

  test("an edited default is the person's own text", () => {
    const edited = `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}\nArchive receipts.`;
    assert.equal(parseAnalysisInstructions(edited), edited);
  });

  test("stores an empty or blank box as no instructions", () => {
    assert.equal(parseAnalysisInstructions(""), "");
    assert.equal(parseAnalysisInstructions("  \n \t\n"), "");
  });

  test("refuses, in a sentence, what cannot be stored", () => {
    assert.throws(
      () => parseAnalysisInstructions("a".repeat(MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH + 1)),
      (error: unknown) =>
        error instanceof MailAnalysisSettingsError &&
        error.message === "Keep the instructions under 4,000 characters.",
    );
    assert.throws(
      () =>
        parseAnalysisInstructions(Array.from({ length: 31 }, (_, i) => `Rule ${i}`).join("\n")),
      /Keep it to 30 instructions or fewer/,
    );
    assert.throws(
      () => parseAnalysisInstructions("Star\u0000 replies"),
      /can only contain printable characters/,
    );
  });
});

describe("reading the card", () => {
  test("shows the default text and says it is the default on a fresh mailbox", async () => {
    const account = await mailbox();
    const settings = await readMailAnalysisSettings(account);
    assert.equal(settings.enabled, true);
    assert.equal(settings.instructions, DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
    assert.equal(settings.usingDefaultInstructions, true);
    assert.equal(settings.employeeId, null);
    assert.equal(settings.modelId, null);
    assert.deepEqual(settings.roster, []);
    assert.equal(settings.resolved, null);
  });

  test("shows the mailbox's own text, and an emptied box as empty", async () => {
    const custom = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });
    const customSettings = await readMailAnalysisSettings(custom);
    assert.equal(customSettings.instructions, "Star mail from Ana.");
    assert.equal(customSettings.usingDefaultInstructions, false);

    const none = await mailbox({
      connectionId: `connection_${randomUUID()}`,
      aiAnalysisInstructions: "",
    });
    const noneSettings = await readMailAnalysisSettings(none);
    assert.equal(noneSettings.instructions, "");
    assert.equal(noneSettings.usingDefaultInstructions, false);
  });

  test("still names who would read the next email", async () => {
    const account = await mailbox();
    const reader = await employee();
    await insert(EmployeeMailAccountGrant, {
      employeeId: reader.id,
      accountId: account.id,
      accessLevel: "draft",
    });
    const model = await insert(AIModel, {
      employeeId: reader.id,
      provider: "openai",
      model: "gpt-test",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify({ apiKeyEncrypted: "test-ciphertext" }),
      connectedAt: new Date(),
    });
    const settings = await readMailAnalysisSettings(account);
    assert.deepEqual(settings.resolved, {
      employeeId: reader.id,
      employeeName: "Jamie Mallers",
      modelId: model.id,
      modelLabel: "gpt-test",
      accessLevel: "draft",
    });
  });
});

describe("saving the card", () => {
  test("saves the person's instructions and reports them back", async () => {
    const account = await mailbox();
    const result = await updateMailAnalysisSettings(
      account,
      { instructions: "Star mail from Ana.  \r\nArchive receipts." },
      "user_1",
    );
    assert.equal(result.instructions, "Star mail from Ana.\nArchive receipts.");
    assert.equal(result.usingDefaultInstructions, false);
    assert.equal(result.account.id, account.id);
    assert.equal(
      (await reload(account)).aiAnalysisInstructions,
      "Star mail from Ana.\nArchive receipts.",
    );

    const [audit] = await settingsAudits();
    assert.equal(audit.actorUserId, "user_1");
    assert.equal(audit.targetId, account.id);
    const metadata = JSON.parse(audit.metadataJson) as Record<string, unknown>;
    assert.equal(metadata.instructionsDefault, false);
    assert.equal(metadata.instructions, "Star mail from Ana.\nArchive receipts.");
  });

  test("restoring the default writes null back and shows the default again", async () => {
    const account = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });
    const result = await updateMailAnalysisSettings(account, { instructions: null }, "user_1");
    assert.equal(result.instructions, DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
    assert.equal(result.usingDefaultInstructions, true);
    assert.equal((await reload(account)).aiAnalysisInstructions, null);
    const metadata = JSON.parse((await settingsAudits())[0].metadataJson) as Record<string, unknown>;
    assert.equal(metadata.instructionsDefault, true);
    assert.equal(metadata.instructions, DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS);
  });

  test("saving the default word for word keeps the mailbox on the default", async () => {
    const account = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });
    const result = await updateMailAnalysisSettings(
      account,
      { instructions: `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}\n` },
      null,
    );
    assert.equal(result.usingDefaultInstructions, true);
    assert.equal((await reload(account)).aiAnalysisInstructions, null);
  });

  test("clearing the box stores no instructions rather than the default", async () => {
    const account = await mailbox();
    const result = await updateMailAnalysisSettings(account, { instructions: "   " }, null);
    assert.equal(result.instructions, "");
    assert.equal(result.usingDefaultInstructions, false);
    assert.equal((await reload(account)).aiAnalysisInstructions, "");
  });

  test("a refused part refuses the whole request, so nothing half-changes", async () => {
    const account = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });

    await assert.rejects(
      updateMailAnalysisSettings(
        account,
        { enabled: false, instructions: "x".repeat(MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH + 1) },
        null,
      ),
      MailAnalysisSettingsError,
    );
    const ungranted = await employee("Zoe Filer");
    await assert.rejects(
      updateMailAnalysisSettings(
        account,
        { employeeId: ungranted.id, instructions: "Archive everything." },
        null,
      ),
      /Zoe Filer has no access to owner@example\.com/,
    );
    await assert.rejects(
      updateMailAnalysisSettings(
        account,
        { employeeId: randomUUID(), instructions: "Archive everything." },
        null,
      ),
      /Unknown AI Employee/,
    );

    const after = await reload(account);
    assert.equal(after.aiAnalysisEnabled, true);
    assert.equal(after.aiAnalysisInstructions, "Star mail from Ana.");
    assert.equal(after.aiAnalysisEmployeeId, null);
    assert.equal((await settingsAudits()).length, 0, "a refused request records nothing");
  });

  test("changing the toggle leaves the instructions, and the audit, alone", async () => {
    const account = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });
    const result = await updateMailAnalysisSettings(account, { enabled: false }, null);
    assert.equal(result.account.aiAnalysisEnabled, false);
    assert.equal(result.instructions, "Star mail from Ana.");
    assert.equal((await reload(account)).aiAnalysisInstructions, "Star mail from Ana.");
    const metadata = JSON.parse((await settingsAudits())[0].metadataJson) as Record<string, unknown>;
    assert.equal(metadata.enabled, false);
    assert.equal("instructions" in metadata, false);
  });

  test("writes only its own columns, so a sync pass saving the row keeps its cursor", async () => {
    const account = await mailbox({ historyId: "1000", syncCursor: "cursor-a" });
    // Loaded before a sync pass advanced the same row.
    const stale = await reload(account);
    await AppDataSource.getRepository(MailAccount).update(
      { id: account.id },
      { historyId: "2000", syncCursor: "cursor-b", status: "error", statusMessage: "flaky" },
    );

    await updateMailAnalysisSettings(stale, { instructions: "Archive receipts." }, null);

    const after = await reload(account);
    assert.equal(after.aiAnalysisInstructions, "Archive receipts.");
    assert.equal(after.historyId, "2000");
    assert.equal(after.syncCursor, "cursor-b");
    assert.equal(after.status, "error");
    assert.equal(after.statusMessage, "flaky");
  });

  test("never writes another company's mailbox, even handed a row with its id", async () => {
    const account = await mailbox({ aiAnalysisInstructions: "Star mail from Ana." });
    const forged = Object.assign(new MailAccount(), { ...account, companyId: "co_someone_else" });
    await assert.rejects(
      updateMailAnalysisSettings(forged, { instructions: "Archive everything." }, null),
    );
    assert.equal((await reload(account)).aiAnalysisInstructions, "Star mail from Ana.");
  });
});
