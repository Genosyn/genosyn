import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import {
  EmployeeMailAccountGrant,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Standdown } from "../../db/entities/Standdown.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { FakeMailbox } from "../../test/fakeMailbox.js";
import { refreshStanddowns } from "../standdowns.js";
import {
  MAIL_ANALYSIS_AUTO_REASON_CHARS,
  MAIL_ANALYSIS_AUTO_STALE_MS,
  MAIL_ANALYSIS_MAX_AUTOMATIC_ACTIONS,
  MailAutomaticActionError,
  applyAutomaticAnalysisActions,
  autoActionSettled,
  autoActionUndoable,
  isSystemLabelName,
  namedInInstruction,
  parseAutoActions,
  presentAutoActions,
  undoAutomaticAnalysisAction,
  unsubscribedByInstructions,
  verifyAutomaticActions,
  type AutomaticVerificationContext,
  type MailAnalysisAutoAction,
  type MailAnalysisAutoProposal,
} from "./analysisAutomation.js";
import { columnToLabelIds, labelIdsToColumn } from "./store.js";

/**
 * The mailbox's written instructions, carried out — the half of AI analysis
 * that acts on its own. Everything here runs against the real services over
 * an in-memory database and a {@link FakeMailbox}, so each test can say both
 * what the mail server was asked to do and what the email now records.
 */

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
});
after(closeTestDb);

const COMPANY_ID = "co_mail_instructions_test";
const SELF = "owner@example.com";
const UNSUBSCRIBE_LINE = "Unsubscribe me automatically from marketing emails.";
const STAR_LINE = "Star emails that need my response and look important.";
const ARCHIVE_LINE = "Archive shipping notifications.";
const READ_LINE = "Mark newsletters as read.";
const LABEL_LINE = "Label newsletters as Reading List.";
const INSTRUCTIONS = [UNSUBSCRIBE_LINE, STAR_LINE, ARCHIVE_LINE, READ_LINE, LABEL_LINE].join("\n");

// ───────────────────────────── fixtures ─────────────────────────────

type Scenario = {
  account: MailAccount;
  mailbox: FakeMailbox;
  reader: AIEmployee;
  thread: MailThread;
  message: MailMessage;
  analysis: MailInboundAnalysis;
  unsubscribes: MailMessage[];
  dependencies: {
    mailbox: (account: MailAccount) => Promise<FakeMailbox>;
    unsubscribe: (account: MailAccount, message: MailMessage) => Promise<{ host: string; status: number }>;
  };
};

function step(
  action: MailAnalysisAutoAction["action"],
  overrides: Partial<MailAnalysisAutoAction> = {},
): MailAnalysisAutoAction {
  const instruction =
    action === "unsubscribe"
      ? UNSUBSCRIBE_LINE
      : action === "star"
        ? STAR_LINE
        : action === "archive"
          ? ARCHIVE_LINE
          : action === "markRead"
            ? READ_LINE
            : LABEL_LINE;
  return {
    id: `auto-${action}`,
    action,
    ...(action === "applyLabel" ? { labelName: "Reading List" } : {}),
    instruction,
    reason: `Because of ${action}.`,
    status: "pending",
    ...(action === "unsubscribe" ? { targetHost: "lists.shop.example" } : {}),
    ...overrides,
  };
}

async function scenario(
  options: {
    steps?: MailAnalysisAutoAction[];
    instructions?: string | null;
    accessLevel?: MailAccessLevel | null;
    account?: Partial<MailAccount>;
    message?: Partial<MailMessage>;
    arrival?: boolean;
    unsubscribe?: () => Promise<{ host: string; status: number }>;
  } = {},
): Promise<Scenario> {
  const mailbox = new FakeMailbox();
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection_${randomUUID()}`,
    address: SELF,
    status: "active",
    aiAnalysisEnabled: true,
    aiAnalysisInstructions: options.instructions === undefined ? INSTRUCTIONS : options.instructions,
    ...options.account,
  });
  const reader = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Jamie Mallers",
    slug: `jamie-${randomUUID()}`,
    role: "Inbox manager",
  });
  if (options.accessLevel !== null) {
    await insert(EmployeeMailAccountGrant, {
      employeeId: reader.id,
      accountId: account.id,
      accessLevel: options.accessLevel ?? "draft",
    });
  }
  const suffix = randomUUID();
  const threadRef = `thread-${suffix}`;
  const messageRef = `message-${suffix}`;
  const labels = ["INBOX", "UNREAD"];
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: threadRef,
    subject: "Spring sale — 40% off",
    labelIds: labelIdsToColumn(labels),
    unread: true,
    messageCount: 1,
  });
  const message = await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: messageRef,
    gmailThreadId: threadRef,
    fromName: "Shop",
    fromEmail: "news@shop.example",
    toEmails: SELF,
    subject: "Spring sale — 40% off",
    bodyText: "Everything is 40% off this weekend.",
    labelIds: labelIdsToColumn(labels),
    sentAt: new Date("2026-10-01T09:00:00Z"),
    ...options.message,
  });
  mailbox.seed({ ref: messageRef, threadRef, labelIds: [...labels] });
  if (options.arrival !== false) {
    await insert(MailInboundAutomation, {
      companyId: COMPANY_ID,
      accountId: account.id,
      messageId: message.id,
      gmailMessageId: messageRef,
      status: "running",
    });
  }
  const analysis = await insert(MailInboundAnalysis, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    messageId: message.id,
    status: "succeeded",
    employeeId: reader.id,
    category: "marketing",
    summary: "A weekend sale.",
    actionsJson: "[]",
    autoActionsJson: JSON.stringify(options.steps ?? []),
    errorMessage: "",
    finishedAt: new Date(),
  });
  const unsubscribes: MailMessage[] = [];
  return {
    account,
    mailbox,
    reader,
    thread,
    message,
    analysis,
    unsubscribes,
    dependencies: {
      mailbox: async () => mailbox,
      unsubscribe: async (_account, unsubscribed) => {
        unsubscribes.push(unsubscribed);
        return options.unsubscribe
          ? options.unsubscribe()
          : { host: "lists.shop.example", status: 200 };
      },
    },
  };
}

async function stored(analysis: MailInboundAnalysis): Promise<MailAnalysisAutoAction[]> {
  const row = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
    id: analysis.id,
  });
  return parseAutoActions(row.autoActionsJson);
}

function byId(steps: MailAnalysisAutoAction[]): Record<string, MailAnalysisAutoAction> {
  return Object.fromEntries(steps.map((entry) => [entry.id, entry]));
}

async function audits(action?: string): Promise<AuditEvent[]> {
  const rows = await AppDataSource.getRepository(AuditEvent).find({ order: { createdAt: "ASC" } });
  return action ? rows.filter((row) => row.action === action) : rows;
}

function metadata(row: AuditEvent): Record<string, unknown> {
  return JSON.parse(row.metadataJson) as Record<string, unknown>;
}

async function labelsOf(message: MailMessage): Promise<string[]> {
  const row = await AppDataSource.getRepository(MailMessage).findOneByOrFail({ id: message.id });
  return columnToLabelIds(row.labelIds);
}

function mailboxMethods(mailbox: FakeMailbox): string[] {
  // Reads are how actions refresh the mirror; the writes are what matter here.
  return mailbox.calls
    .map((call) => call.method)
    .filter((method) => method !== "readThreadState" && method !== "getMessageHeaders");
}

function context(overrides: Partial<AutomaticVerificationContext> = {}): AutomaticVerificationContext {
  return {
    instructions: INSTRUCTIONS.split("\n"),
    unsubscribeAvailable: true,
    unsubscribeHost: "lists.shop.example",
    provider: "gmail",
    category: "marketing",
    ...overrides,
  };
}

function proposal(overrides: Partial<MailAnalysisAutoProposal> = {}): MailAnalysisAutoProposal {
  return { instruction: 2, action: "star", reason: "Asks for a reply by Friday.", ...overrides };
}

// ───────────────────────────── verification ─────────────────────────────

describe("checking what the model proposed", () => {
  test("keeps an allowed step pending and names the owner's own instruction", () => {
    const [starred] = verifyAutomaticActions([proposal()], context());
    assert.deepEqual(starred, {
      id: "auto-0",
      action: "star",
      instruction: STAR_LINE,
      reason: "Asks for a reply by Friday.",
      status: "pending",
    });
  });

  test("accepts every step on the server's list", () => {
    const steps = verifyAutomaticActions(
      [
        proposal({ instruction: 1, action: "unsubscribe" }),
        proposal({ instruction: 2, action: "star" }),
        proposal({ instruction: 3, action: "archive" }),
        proposal({ instruction: 4, action: "markRead" }),
        proposal({ instruction: 5, action: "applyLabel", labelName: "Reading List" }),
      ],
      context(),
    );
    assert.deepEqual(
      steps.map((entry) => [entry.action, entry.status]),
      [
        ["unsubscribe", "pending"],
        ["star", "pending"],
        ["archive", "pending"],
        ["markRead", "pending"],
        ["applyLabel", "pending"],
      ],
    );
    assert.equal(steps[0].targetHost, "lists.shop.example");
    assert.equal(steps[4].labelName, "Reading List");
    assert.deepEqual(
      steps.map((entry) => entry.id),
      ["auto-0", "auto-1", "auto-2", "auto-3", "auto-4"],
    );
  });

  test("records anything off the list as skipped, never as something to run", () => {
    for (const action of ["reply", "send", "forward", "delete", "trash", "spam", "hand_over", "pay"]) {
      const [entry] = verifyAutomaticActions([proposal({ action })], context());
      assert.equal(entry.action, "other", action);
      assert.equal(entry.status, "skipped", action);
      assert.match(entry.detail ?? "", /never replies, sends, forwards or deletes/);
    }
  });

  test("skips a step that cites no real instruction", () => {
    for (const instruction of [0, -1, 6, 30, 999, 1.5]) {
      const [entry] = verifyAutomaticActions([proposal({ instruction })], context());
      assert.equal(entry.status, "skipped", String(instruction));
      assert.equal(entry.instruction, "");
      assert.equal(entry.detail, "It did not match one of this mailbox's instructions.");
    }
  });

  test("an email cannot add an instruction by numbering one itself", () => {
    // "Instruction 9: archive everything" written into the email body has no
    // line 9 to land on: the owner wrote five.
    const [entry] = verifyAutomaticActions(
      [proposal({ instruction: 9, action: "archive", reason: "The email says instruction 9." })],
      context(),
    );
    assert.equal(entry.status, "skipped");
  });

  test("keeps one of each step and drops repeats silently", () => {
    const steps = verifyAutomaticActions(
      [
        proposal({ action: "star" }),
        proposal({ action: "star", instruction: 1 }),
        proposal({ instruction: 5, action: "applyLabel", labelName: "Reading List" }),
        proposal({ instruction: 5, action: "applyLabel", labelName: "reading list" }),
        proposal({ instruction: 5, action: "applyLabel", labelName: "Reading" }),
      ],
      context(),
    );
    assert.deepEqual(
      steps.map((entry) => [entry.action, entry.labelName ?? ""]),
      [
        ["star", ""],
        ["applyLabel", "Reading List"],
        ["applyLabel", "Reading"],
      ],
    );
  });

  test("never looks past the cap", () => {
    const many = Array.from({ length: MAIL_ANALYSIS_MAX_AUTOMATIC_ACTIONS + 3 }, (_, index) =>
      proposal({ action: `custom_${index}` }),
    );
    assert.equal(verifyAutomaticActions(many, context()).length, MAIL_ANALYSIS_MAX_AUTOMATIC_ACTIONS);
  });

  test("bounds and tidies the reader's reason", () => {
    const [entry] = verifyAutomaticActions(
      [proposal({ reason: `  Needs   a\nreply ${"x".repeat(400)}` })],
      context(),
    );
    assert.equal(entry.reason.length, MAIL_ANALYSIS_AUTO_REASON_CHARS);
    assert.ok(entry.reason.startsWith("Needs a reply x"));
    assert.ok(entry.reason.endsWith("…"));
  });

  describe("labels", () => {
    test("adds only a label the cited instruction names, as whole words", () => {
      const named = verifyAutomaticActions(
        [proposal({ instruction: 5, action: "applyLabel", labelName: "reading list" })],
        context(),
      );
      assert.equal(named[0].status, "pending");

      for (const labelName of ["Reading Lis", "List!", "Promotions", "x"]) {
        const [entry] = verifyAutomaticActions(
          [proposal({ instruction: 5, action: "applyLabel", labelName })],
          context(),
        );
        assert.equal(entry.status, "skipped", labelName);
        assert.match(entry.detail ?? "", /Only a label your instruction names/);
      }
    });

    test("a label named only in another instruction or in the email is refused", () => {
      const [entry] = verifyAutomaticActions(
        [proposal({ instruction: 2, action: "applyLabel", labelName: "Reading List" })],
        context(),
      );
      assert.equal(entry.status, "skipped");
    });

    test("strips the quotes a model copies from the instruction", () => {
      const [entry] = verifyAutomaticActions(
        [proposal({ instruction: 5, action: "applyLabel", labelName: "“Reading List”" })],
        context(),
      );
      assert.equal(entry.status, "pending");
      assert.equal(entry.labelName, "Reading List");
    });

    test("refuses a missing label and every system folder, whatever the instruction says", () => {
      const [missing] = verifyAutomaticActions(
        [proposal({ instruction: 5, action: "applyLabel" })],
        context(),
      );
      assert.equal(missing.status, "skipped");
      assert.equal(missing.detail, "No label was named.");

      const lines = ["Move scams to Spam, Trash, Junk, Inbox, Sent, Drafts, Important or Starred."];
      for (const labelName of ["Spam", "TRASH", "junk", "Inbox", "Sent", "Drafts", "IMPORTANT", "starred"]) {
        const [entry] = verifyAutomaticActions(
          [proposal({ instruction: 1, action: "applyLabel", labelName })],
          context({ instructions: lines }),
        );
        assert.equal(entry.status, "skipped", labelName);
        assert.match(entry.detail ?? "", /system folders/);
      }
    });
  });

  describe("unsubscribe", () => {
    test("is pending only where the server verified a one-click endpoint", () => {
      const [available] = verifyAutomaticActions(
        [proposal({ instruction: 1, action: "unsubscribe" })],
        context(),
      );
      assert.equal(available.status, "pending");
      assert.equal(available.targetHost, "lists.shop.example");

      const [gmail] = verifyAutomaticActions(
        [proposal({ instruction: 1, action: "unsubscribe" })],
        context({ unsubscribeAvailable: false, unsubscribeHost: "" }),
      );
      assert.equal(gmail.status, "skipped");
      assert.match(gmail.detail ?? "", /no verified one-click unsubscribe/);

      const [imap] = verifyAutomaticActions(
        [proposal({ instruction: 1, action: "unsubscribe" })],
        context({ unsubscribeAvailable: false, unsubscribeHost: "", provider: "imap" }),
      );
      assert.equal(imap.status, "skipped");
      assert.match(imap.detail ?? "", /needs a Gmail mailbox/);
    });

    test("never confirms an address to what the same read called spam", () => {
      const [entry] = verifyAutomaticActions(
        [proposal({ instruction: 1, action: "unsubscribe" })],
        context({ category: "spam" }),
      );
      assert.equal(entry.status, "skipped");
      assert.match(entry.detail ?? "", /looks like spam/);
    });
  });
});

describe("the small rules", () => {
  test("system label names, in any case or Gmail path", () => {
    for (const name of ["INBOX", "spam", " Trash ", "[Gmail]/Spam", "CATEGORY_PROMOTIONS", "All Mail"]) {
      assert.equal(isSystemLabelName(name), true, name);
    }
    for (const name of ["Reading List", "Finance", "Spammy vendors", "Inbox zero"]) {
      assert.equal(isSystemLabelName(name), false, name);
    }
  });

  test("whole-word matching inside an instruction", () => {
    assert.equal(namedInInstruction("File invoices under Finance/Invoices.", "Finance/Invoices"), true);
    assert.equal(namedInInstruction("File invoices under Finance.", "finance"), true);
    assert.equal(namedInInstruction("File invoices under Finance.", "Fin"), false);
    assert.equal(namedInInstruction("File invoices under Finance.", "..."), false);
    assert.equal(namedInInstruction("Etiqueta como Facturación.", "facturación"), true);
    assert.equal(namedInInstruction("Label it (urgent)", "(urgent)"), true);
  });

  test("which steps count as having touched the mailbox", () => {
    assert.equal(autoActionSettled({ status: "pending" }), false);
    assert.equal(autoActionSettled({ status: "skipped" }), false);
    for (const status of ["running", "done", "failed", "undone"] as const) {
      assert.equal(autoActionSettled({ status }), true, status);
    }
  });

  test("which steps a Member can undo", () => {
    assert.equal(autoActionUndoable(step("star", { status: "done" })), true);
    assert.equal(autoActionUndoable(step("applyLabel", { status: "done" })), true);
    assert.equal(autoActionUndoable(step("unsubscribe", { status: "done" })), false);
    assert.equal(autoActionUndoable(step("star", { status: "pending" })), false);
    assert.equal(autoActionUndoable(step("star", { status: "undone" })), false);
    assert.equal(autoActionUndoable(step("star", { status: "failed" })), false);
  });
});

describe("reading the record back", () => {
  test("treats malformed, non-array, and shapeless JSON as no steps", () => {
    for (const raw of [null, undefined, "", "not json", "{}", "42", '"[]"']) {
      assert.deepEqual(parseAutoActions(raw as string), [], String(raw));
    }
  });

  test("drops entries with an unknown step or status, keeps the rest", () => {
    const parsed = parseAutoActions(
      JSON.stringify([
        { id: "a", action: "star", instruction: "x", reason: "y", status: "done", appliedAt: "t" },
        { id: "b", action: "detonate", instruction: "x", reason: "y", status: "done" },
        { id: "c", action: "star", instruction: "x", reason: "y", status: "exploded" },
        { action: "star", status: "done" },
        null,
        "star",
        { id: "d", action: "other", status: "skipped", detail: 7 },
      ]),
    );
    assert.deepEqual(parsed, [
      { id: "a", action: "star", instruction: "x", reason: "y", status: "done", appliedAt: "t" },
      { id: "d", action: "other", instruction: "", reason: "", status: "skipped" },
    ]);
  });

  test("shows a step left pending or running long after its read as interrupted", () => {
    const steps = [
      step("star", { id: "a", status: "pending" }),
      step("archive", { id: "b", status: "running" }),
      step("markRead", { id: "c", status: "done" }),
    ];
    const now = new Date("2026-10-09T12:00:00Z");
    const fresh = presentAutoActions(steps, new Date(now.getTime() - 5_000), now);
    assert.deepEqual(fresh, steps, "a read that just finished is still running its steps");

    const stale = presentAutoActions(
      steps,
      new Date(now.getTime() - MAIL_ANALYSIS_AUTO_STALE_MS - 1),
      now,
    );
    assert.equal(stale[0].status, "skipped");
    assert.equal(stale[0].detail, "Genosyn stopped before this could run.");
    assert.equal(stale[1].status, "failed");
    assert.match(stale[1].detail ?? "", /stopped while this was running/);
    assert.deepEqual(stale[2], steps[2]);
    assert.equal(presentAutoActions([steps[0]], null, now)[0].status, "skipped");
  });
});

// ───────────────────────────── carrying the steps out ─────────────────────────────

describe("carrying out the steps", () => {
  test("runs every pending step on this thread, records it, and audits it as the reader", async () => {
    const s = await scenario({
      steps: [
        step("unsubscribe"),
        step("star"),
        step("markRead"),
        step("applyLabel"),
        step("archive"),
      ],
    });
    const result = await applyAutomaticAnalysisActions(
      s.account,
      s.message,
      s.analysis.id,
      undefined,
      s.dependencies,
    );

    assert.deepEqual(
      result.map((entry) => [entry.action, entry.status]),
      [
        ["unsubscribe", "done"],
        ["star", "done"],
        ["markRead", "done"],
        ["applyLabel", "done"],
        ["archive", "done"],
      ],
    );
    for (const entry of result) assert.match(entry.appliedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result[0].detail, "via lists.shop.example");
    assert.equal(result[0].targetHost, "lists.shop.example");

    // The mail server was asked for exactly these changes, on this thread.
    const threadRef = s.thread.gmailThreadId;
    assert.deepEqual(mailboxMethods(s.mailbox), [
      "setFlagged",
      "setRead",
      "createLabel",
      "applyLabel",
      "archive",
    ]);
    for (const call of s.mailbox.calls.filter((c) => c.method !== "createLabel")) {
      assert.equal(call.args[0], threadRef, `${call.method} acted on this thread only`);
    }
    assert.deepEqual(s.unsubscribes.map((m) => m.id), [s.message.id]);

    // The mirror reflects it, so the thread shows it.
    const labels = await labelsOf(s.message);
    assert.ok(labels.includes("STARRED"));
    assert.ok(!labels.includes("UNREAD"));
    assert.ok(!labels.includes("INBOX"));
    assert.ok(labels.some((label) => label.startsWith("label-reading-list")));

    // One audit row per step, attributed to the reading employee, on the thread.
    const rows = await audits("mail.analysis.automatic");
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.actorEmployeeId, s.reader.id);
      assert.equal(row.actorKind, "ai");
      assert.equal(row.targetType, "mail_inbound_analysis");
      assert.equal(row.targetId, s.analysis.id);
      assert.equal(row.targetLabel, "Spring sale — 40% off");
      const meta = metadata(row);
      assert.equal(meta.mailThreadId, s.thread.id);
      assert.equal(meta.messageId, s.message.id);
      assert.equal(meta.accountId, s.account.id);
    }
    const unsubscribed = metadata(rows[0]);
    assert.equal(unsubscribed.action, "unsubscribe");
    assert.equal(unsubscribed.instruction, UNSUBSCRIBE_LINE);
    assert.equal(unsubscribed.reason, "Because of unsubscribe.");
    assert.equal(unsubscribed.endpointHost, "lists.shop.example");
    assert.equal(unsubscribed.endpointStatus, 200);
    assert.equal(metadata(rows[3]).labelName, "Reading List");
  });

  test("is idempotent: a replay finds nothing left to run", async () => {
    const s = await scenario({ steps: [step("star"), step("unsubscribe")] });
    await applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies);
    const callsAfterFirst = s.mailbox.calls.length;

    const again = await applyAutomaticAnalysisActions(
      s.account,
      s.message,
      s.analysis.id,
      undefined,
      s.dependencies,
    );
    assert.deepEqual(
      again.map((entry) => entry.status),
      ["done", "done"],
    );
    assert.equal(s.mailbox.calls.length, callsAfterFirst);
    assert.equal(s.unsubscribes.length, 1, "an unsubscribe request is never sent twice");
    assert.equal((await audits("mail.analysis.automatic")).length, 2);
  });

  test("two callers at once still run each step exactly once", async () => {
    const s = await scenario({ steps: [step("star"), step("archive"), step("unsubscribe")] });
    await Promise.all([
      applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies),
      applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies),
    ]);
    const writes = mailboxMethods(s.mailbox);
    assert.equal(writes.filter((method) => method === "setFlagged").length, 1);
    assert.equal(writes.filter((method) => method === "archive").length, 1);
    assert.equal(s.unsubscribes.length, 1);
    assert.deepEqual(
      (await stored(s.analysis)).map((entry) => entry.status),
      ["done", "done", "done"],
    );
    assert.equal((await audits("mail.analysis.automatic")).length, 3);
  });

  test("does nothing, and asks the mailbox nothing, when no step is pending", async () => {
    const s = await scenario({
      steps: [step("star", { status: "skipped", detail: "x" }), step("archive", { status: "done" })],
    });
    const result = await applyAutomaticAnalysisActions(
      s.account,
      s.message,
      s.analysis.id,
      undefined,
      s.dependencies,
    );
    assert.equal(result.length, 2);
    assert.equal(s.mailbox.calls.length, 0);
    assert.equal((await audits()).length, 0);
  });

  test("leaves a failed read alone", async () => {
    const s = await scenario({ steps: [step("star")] });
    await AppDataSource.getRepository(MailInboundAnalysis).update(
      { id: s.analysis.id },
      { status: "failed" },
    );
    await applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies);
    assert.equal(s.mailbox.calls.length, 0);
    assert.equal((await stored(s.analysis))[0].status, "pending");
  });

  test("refuses steps that belong to another email or mailbox", async () => {
    const s = await scenario({ steps: [step("star")] });
    const other = await scenario({ steps: [step("star")] });
    await assert.rejects(
      applyAutomaticAnalysisActions(s.account, other.message, s.analysis.id, undefined, s.dependencies),
      MailAutomaticActionError,
    );
    await assert.rejects(
      applyAutomaticAnalysisActions(other.account, s.message, s.analysis.id, undefined, s.dependencies),
      MailAutomaticActionError,
    );
    assert.equal(s.mailbox.calls.length + other.mailbox.calls.length, 0);
  });

  describe("failures cost only their own step", () => {
    test("a mail server refusal marks that step failed, audits it, and the rest still run", async () => {
      const s = await scenario({ steps: [step("star"), step("archive")] });
      s.mailbox.failNext.setFlagged = new Error("Gmail said no to the star");

      const result = byId(
        await applyAutomaticAnalysisActions(
          s.account,
          s.message,
          s.analysis.id,
          undefined,
          s.dependencies,
        ),
      );
      assert.equal(result["auto-star"].status, "failed");
      assert.equal(result["auto-star"].detail, "Gmail said no to the star");
      assert.equal(result["auto-archive"].status, "done");

      const [failed] = await audits("mail.analysis.automatic_failed");
      assert.equal(failed.actorEmployeeId, s.reader.id);
      assert.equal(metadata(failed).error, "Gmail said no to the star");
      assert.equal(metadata(failed).mailThreadId, s.thread.id);
      assert.equal((await audits("mail.analysis.automatic")).length, 1);
    });

    test("an unsubscribe endpoint that refuses is recorded as failed", async () => {
      const s = await scenario({
        steps: [step("unsubscribe")],
        unsubscribe: async () => {
          throw new Error("The one-click unsubscribe endpoint returned HTTP 500.");
        },
      });
      const [entry] = await applyAutomaticAnalysisActions(
        s.account,
        s.message,
        s.analysis.id,
        undefined,
        s.dependencies,
      );
      assert.equal(entry.status, "failed");
      assert.match(entry.detail ?? "", /HTTP 500/);
    });

    test("a label the mailbox owns as a system folder fails at the moment it would apply", async () => {
      const s = await scenario({ steps: [step("applyLabel")] });
      await insert(MailLabel, {
        companyId: COMPANY_ID,
        accountId: s.account.id,
        gmailLabelId: "SYS_READING",
        name: "Reading List",
        labelType: "system",
      });
      const [entry] = await applyAutomaticAnalysisActions(
        s.account,
        s.message,
        s.analysis.id,
        undefined,
        s.dependencies,
      );
      assert.equal(entry.status, "failed");
      assert.match(entry.detail ?? "", /System folders/);
      assert.equal(mailboxMethods(s.mailbox).includes("applyLabel"), false);
    });
  });

  describe("the live checks before anything runs", () => {
    async function skippedWith(
      options: Parameters<typeof scenario>[0],
      prepare: (s: Scenario) => Promise<void> = async () => {},
    ): Promise<{ s: Scenario; result: MailAnalysisAutoAction[] }> {
      const s = await scenario({ steps: [step("star"), step("unsubscribe")], ...options });
      await prepare(s);
      const result = await applyAutomaticAnalysisActions(
        s.account,
        s.message,
        s.analysis.id,
        undefined,
        s.dependencies,
      );
      assert.equal(s.mailbox.calls.length, 0, "nothing reached the mail server");
      assert.equal(s.unsubscribes.length, 0, "no unsubscribe request was sent");
      assert.equal((await audits("mail.analysis.automatic")).length, 0);
      assert.deepEqual(
        result.map((entry) => entry.status),
        ["skipped", "skipped"],
      );
      return { s, result };
    }

    test("AI analysis turned off since the read", async () => {
      const { result } = await skippedWith({ account: { aiAnalysisEnabled: false } });
      assert.equal(result[0].detail, "AI analysis was turned off before this ran.");
    });

    test("the mailbox paused since the read", async () => {
      const { result } = await skippedWith({ account: { status: "paused" } });
      assert.match(result[0].detail ?? "", /paused or disconnected/);
    });

    test("the instructions cleared since the read", async () => {
      const { result } = await skippedWith({ instructions: "" });
      assert.equal(result[0].detail, "The mailbox's instructions were cleared before this ran.");
    });

    test("a company Standdown", async () => {
      const { result } = await skippedWith({}, async () => {
        await insert(Standdown, {
          companyId: COMPANY_ID,
          scope: "company",
          scopeId: null,
          reason: "Quarterly audit",
          placedAt: new Date(),
        });
        await refreshStanddowns();
      });
      assert.equal(result[0].detail, "AI work is stood down: Quarterly audit");
    });

    test("a Standdown on the reading employee", async () => {
      const { result } = await skippedWith({}, async (s) => {
        await insert(Standdown, {
          companyId: COMPANY_ID,
          scope: "employee",
          scopeId: s.reader.id,
          reason: "Retraining",
          placedAt: new Date(),
        });
        await refreshStanddowns();
      });
      assert.equal(result[0].detail, "AI work is stood down: Retraining");
    });

    test("a reader on Read access", async () => {
      const { result } = await skippedWith({ accessLevel: "read" });
      assert.match(result[0].detail ?? "", /needs Draft access to this mailbox to act on its own/);
    });

    test("a reader whose Grant was removed", async () => {
      const { result } = await skippedWith({ accessLevel: null });
      assert.match(result[0].detail ?? "", /needs Draft access/);
    });

    test("a reader that left the company", async () => {
      const { result } = await skippedWith({}, async (s) => {
        await AppDataSource.getRepository(AIEmployee).update(
          { id: s.reader.id },
          { companyId: "co_elsewhere" },
        );
      });
      assert.equal(result[0].detail, "The AI Employee that read this email is no longer here.");
    });

    test("an email filed in Spam or Trash since", async () => {
      for (const label of ["SPAM", "TRASH"]) {
        await resetTestDb();
        const { result } = await skippedWith({ message: { labelIds: ` INBOX ${label} ` } });
        assert.equal(result[0].detail, "This email is in Spam or Trash.", label);
      }
    });

    test("imported history, which never got an arrival record", async () => {
      const { result } = await skippedWith({ arrival: false });
      assert.equal(result[0].detail, "Only newly arrived email is acted on automatically.");
    });

    test("an arrival record that belongs to a different message", async () => {
      const { result } = await skippedWith({}, async (s) => {
        await AppDataSource.getRepository(MailInboundAutomation).update(
          { accountId: s.account.id, gmailMessageId: s.message.gmailMessageId },
          { messageId: randomUUID() },
        );
      });
      assert.match(result[0].detail ?? "", /Only newly arrived email/);
    });

    for (const [name, message] of [
      ["a draft", { gmailDraftId: "draft-1" }],
      ["a draft by label", { labelIds: " DRAFT " }],
      ["mail the mailbox sent", { labelIds: " SENT " }],
      ["mail from the mailbox's own address", { fromEmail: SELF.toUpperCase() }],
      ["mail a Member wrote in Genosyn", { createdByUserId: "user_1" }],
      ["mail an AI Employee wrote", { createdByEmployeeId: "employee_1" }],
    ] as const) {
      test(name, async () => {
        const { result } = await skippedWith({ message });
        assert.match(result[0].detail ?? "", /Only newly arrived email/);
      });
    }

    test("an instruction rewritten since the read skips only the steps that relied on it", async () => {
      const s = await scenario({
        steps: [step("star"), step("archive")],
        instructions: [STAR_LINE.replace("important", "urgent"), ARCHIVE_LINE].join("\n"),
      });
      const result = byId(
        await applyAutomaticAnalysisActions(
          s.account,
          s.message,
          s.analysis.id,
          undefined,
          s.dependencies,
        ),
      );
      assert.equal(result["auto-star"].status, "skipped");
      assert.equal(result["auto-star"].detail, "Your instructions changed before this ran.");
      assert.equal(result["auto-archive"].status, "done");
      assert.deepEqual(mailboxMethods(s.mailbox), ["archive"]);
    });

    test("a reader with Send access still acts, and another employee's Standdown does not stop it", async () => {
      const s = await scenario({ steps: [step("star")], accessLevel: "send" });
      await insert(Standdown, {
        companyId: COMPANY_ID,
        scope: "employee",
        scopeId: randomUUID(),
        reason: "Someone else",
        placedAt: new Date(),
      });
      await refreshStanddowns();
      const [entry] = await applyAutomaticAnalysisActions(
        s.account,
        s.message,
        s.analysis.id,
        undefined,
        s.dependencies,
      );
      assert.equal(entry.status, "done");
    });
  });

  describe("the inbound queue's fences", () => {
    test("a mailbox paused before the first step leaves every step skipped and stops the chain", async () => {
      const s = await scenario({ steps: [step("star"), step("archive")] });
      const paused = new Error("paused");
      await assert.rejects(
        applyAutomaticAnalysisActions(
          s.account,
          s.message,
          s.analysis.id,
          {
            assertRunnable: async () => {
              throw paused;
            },
            beforeEffect: async () => {},
          },
          s.dependencies,
        ),
        (error) => error === paused,
      );
      assert.equal(s.mailbox.calls.length, 0);
      assert.deepEqual(
        (await stored(s.analysis)).map((entry) => [entry.status, entry.detail]),
        [
          ["skipped", "The mailbox was paused or disconnected before this ran."],
          ["skipped", "The mailbox was paused or disconnected before this ran."],
        ],
      );
    });

    test("a pause between steps keeps what ran and skips the rest", async () => {
      const s = await scenario({ steps: [step("star"), step("archive"), step("markRead")] });
      let effects = 0;
      const paused = new Error("paused mid-way");
      await assert.rejects(
        applyAutomaticAnalysisActions(
          s.account,
          s.message,
          s.analysis.id,
          {
            assertRunnable: async () => {},
            beforeEffect: async () => {
              effects += 1;
              if (effects === 2) throw paused;
            },
          },
          s.dependencies,
        ),
        (error) => error === paused,
      );
      assert.deepEqual(mailboxMethods(s.mailbox), ["setFlagged"]);
      assert.deepEqual(
        (await stored(s.analysis)).map((entry) => entry.status),
        ["done", "skipped", "skipped"],
      );
    });

    test("every step is announced to the queue before it touches the mailbox", async () => {
      const s = await scenario({ steps: [step("star"), step("archive")] });
      const order: string[] = [];
      const original = s.mailbox.setFlagged.bind(s.mailbox);
      s.mailbox.setFlagged = async (...args) => {
        order.push("mailbox:star");
        return original(...args);
      };
      const archive = s.mailbox.archive.bind(s.mailbox);
      s.mailbox.archive = async (...args) => {
        order.push("mailbox:archive");
        return archive(...args);
      };
      await applyAutomaticAnalysisActions(
        s.account,
        s.message,
        s.analysis.id,
        {
          assertRunnable: async () => {
            order.push("assertRunnable");
          },
          beforeEffect: async () => {
            order.push("beforeEffect");
          },
        },
        s.dependencies,
      );
      assert.deepEqual(order, [
        "assertRunnable",
        "beforeEffect",
        "mailbox:star",
        "beforeEffect",
        "mailbox:archive",
      ]);
    });

    test("a Standdown placed while one step runs stops the steps after it", async () => {
      const s = await scenario({ steps: [step("star"), step("archive")] });
      const original = s.mailbox.setFlagged.bind(s.mailbox);
      s.mailbox.setFlagged = async (...args) => {
        await insert(Standdown, {
          companyId: COMPANY_ID,
          scope: "company",
          scopeId: null,
          reason: "Stop everything",
          placedAt: new Date(),
        });
        await refreshStanddowns();
        return original(...args);
      };
      const result = byId(
        await applyAutomaticAnalysisActions(
          s.account,
          s.message,
          s.analysis.id,
          undefined,
          s.dependencies,
        ),
      );
      assert.equal(result["auto-star"].status, "done");
      assert.equal(result["auto-archive"].status, "skipped");
      assert.equal(result["auto-archive"].detail, "AI work is stood down: Stop everything");
      assert.equal(mailboxMethods(s.mailbox).includes("archive"), false);
    });
  });
});

// ───────────────────────────── undo ─────────────────────────────

describe("undoing a step", () => {
  const cases = [
    { action: "star", call: "setFlagged", args: [false], message: "Unstarred" },
    { action: "markRead", call: "setRead", args: [false], message: "Marked unread" },
    { action: "archive", call: "moveToInbox", args: [], message: "Moved back to the inbox" },
  ] as const;

  for (const entry of cases) {
    test(`takes back ${entry.action} with the Member's authority`, async () => {
      const s = await scenario({ steps: [step(entry.action)] });
      await applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies);
      s.mailbox.calls.length = 0;

      const analysis = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
        id: s.analysis.id,
      });
      const undone = await undoAutomaticAnalysisAction(
        s.account,
        analysis,
        `auto-${entry.action}`,
        { userId: "member_1" },
        s.dependencies,
      );
      assert.equal(undone.message, entry.message);
      const writes = s.mailbox.calls.filter((call) => call.method === entry.call);
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].args, [s.thread.gmailThreadId, ...entry.args]);

      const [record] = parseAutoActions(undone.analysis.autoActionsJson);
      assert.equal(record.status, "undone");
      assert.match(record.undoneAt ?? "", /^\d{4}-/);
      const [audit] = await audits("mail.analysis.automatic_undo");
      assert.equal(audit.actorUserId, "member_1");
      assert.equal(audit.actorEmployeeId, null);
      assert.equal(metadata(audit).action, entry.action);
      assert.equal(metadata(audit).mailThreadId, s.thread.id);
    });
  }

  test("removes the label it added", async () => {
    const s = await scenario({ steps: [step("applyLabel")] });
    await applyAutomaticAnalysisActions(s.account, s.message, s.analysis.id, undefined, s.dependencies);
    assert.ok((await labelsOf(s.message)).includes("label-reading-list"));

    const analysis = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
      id: s.analysis.id,
    });
    const undone = await undoAutomaticAnalysisAction(
      s.account,
      analysis,
      "auto-applyLabel",
      { userId: "member_1" },
      s.dependencies,
    );
    assert.equal(undone.message, "Label removed");
    assert.ok(!(await labelsOf(s.message)).includes("label-reading-list"));
  });

  test("refuses an unsubscribe, which cannot be taken back", async () => {
    const s = await scenario({ steps: [step("unsubscribe", { status: "done" })] });
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-unsubscribe", { userId: "m" }, s.dependencies),
      /An unsubscribe can't be undone from Genosyn/,
    );
    assert.equal(s.mailbox.calls.length, 0);
  });

  test("refuses a step that never ran, one already undone, and one that is not there", async () => {
    const s = await scenario({
      steps: [
        step("star", { status: "skipped", detail: "x" }),
        step("archive", { status: "undone" }),
        step("markRead", { status: "failed", detail: "y" }),
        step("applyLabel", { status: "pending" }),
      ],
    });
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-star", { userId: "m" }, s.dependencies),
      /Only a step that was carried out can be undone/,
    );
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-archive", { userId: "m" }, s.dependencies),
      /already undone/,
    );
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-markRead", { userId: "m" }, s.dependencies),
      /Only a step that was carried out/,
    );
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-applyLabel", { userId: "m" }, s.dependencies),
      /Only a step that was carried out/,
    );
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-9", { userId: "m" }, s.dependencies),
      /not on this email/,
    );
    assert.equal(s.mailbox.calls.length, 0);
  });

  test("refuses another mailbox's email", async () => {
    const s = await scenario({ steps: [step("star", { status: "done" })] });
    const other = await scenario();
    await assert.rejects(
      undoAutomaticAnalysisAction(other.account, s.analysis, "auto-star", { userId: "m" }, s.dependencies),
      MailAutomaticActionError,
    );
  });

  test("a mail server that refuses the reversal leaves the step undoable", async () => {
    const s = await scenario({ steps: [step("star", { status: "done" })] });
    s.mailbox.failNext.setFlagged = new Error("Gmail is down");
    await assert.rejects(
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-star", { userId: "m" }, s.dependencies),
      /Gmail is down/,
    );
    assert.equal((await stored(s.analysis))[0].status, "done");
    assert.equal((await audits("mail.analysis.automatic_undo")).length, 0);

    const retried = await undoAutomaticAnalysisAction(
      s.account,
      s.analysis,
      "auto-star",
      { userId: "m" },
      s.dependencies,
    );
    assert.equal(parseAutoActions(retried.analysis.autoActionsJson)[0].status, "undone");
  });

  test("two presses at once undo it once", async () => {
    const s = await scenario({ steps: [step("star", { status: "done" })] });
    const results = await Promise.allSettled([
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-star", { userId: "m" }, s.dependencies),
      undoAutomaticAnalysisAction(s.account, s.analysis, "auto-star", { userId: "m" }, s.dependencies),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(s.mailbox.calls.filter((call) => call.method === "setFlagged").length, 1);
    assert.equal((await audits("mail.analysis.automatic_undo")).length, 1);
  });
});

// ───────────────────────────── the cross-automation guard ─────────────────────────────

describe("whether the instructions already unsubscribed", () => {
  test("only a sent or in-flight unsubscribe counts", async () => {
    assert.equal(await unsubscribedByInstructions(randomUUID()), false);
    for (const [status, expected] of [
      ["done", true],
      ["running", true],
      ["pending", false],
      ["skipped", false],
      ["failed", false],
    ] as const) {
      await resetTestDb();
      const s = await scenario({ steps: [step("unsubscribe", { status }), step("star", { status: "done" })] });
      assert.equal(await unsubscribedByInstructions(s.message.id), expected, status);
    }
  });
});
