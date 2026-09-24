import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, resetTestDb, insert } from "../../test/dbHarness.js";
import {
  isInboundReviewMessage,
  mailReviewsForThreads,
  summarizeMailReview,
} from "./reviewStatus.js";

after(closeTestDb);
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, seconds));
const account = Object.assign(new MailAccount(), {
  id: "mailbox",
  companyId: "company",
  address: "owner@example.com",
  aiAnalysisEnabled: true,
});
const employee = Object.assign(new AIEmployee(), {
  id: "employee",
  companyId: "company",
  name: "Ada",
  slug: "ada",
  avatarKey: null,
});
const employees = new Map([[employee.id, employee]]);
const message = Object.assign(new MailMessage(), {
  id: "message",
  companyId: account.companyId,
  accountId: account.id,
  threadId: "thread",
  fromEmail: "customer@example.com",
  gmailDraftId: "",
  labelIds: " INBOX ",
  createdByEmployeeId: null,
  createdByUserId: null,
  createdAt: at(10),
  sentAt: at(5),
});
function analysis(overrides: Partial<MailInboundAnalysis> = {}): MailInboundAnalysis {
  return Object.assign(
    new MailInboundAnalysis(),
    {
      id: "analysis",
      companyId: account.companyId,
      accountId: account.id,
      threadId: message.threadId,
      messageId: message.id,
      employeeId: employee.id,
      status: "succeeded",
      createdAt: at(11),
      updatedAt: at(12),
      finishedAt: at(12),
    },
    overrides,
  );
}
function handover(overrides: Partial<MailHandover> = {}): MailHandover {
  return Object.assign(
    new MailHandover(),
    {
      id: "handover",
      companyId: account.companyId,
      accountId: account.id,
      threadId: message.threadId,
      employeeId: employee.id,
      status: "completed",
      createdAt: at(11),
      startedAt: at(12),
      finishedAt: at(15),
    },
    overrides,
  );
}
const summary = (overrides: Partial<Parameters<typeof summarizeMailReview>[0]> = {}) =>
  summarizeMailReview({ account, message, employees, analyses: [], handovers: [], ...overrides });

test("no AI evidence is unreviewed even when rules completed successfully", () => {
  const automation = Object.assign(new MailInboundAutomation(), {
    companyId: account.companyId,
    accountId: account.id,
    messageId: message.id,
    status: "succeeded",
    createdAt: at(11),
  });
  assert.equal(summary({ automation }).status, "not_reviewed");
  assert.equal(summary({ message: null }).latestMessageId, null);
});

test("queue execution is only queued for AI, never reviewing or reviewed", () => {
  for (const status of ["queued", "running"] as const) {
    const automation = Object.assign(new MailInboundAutomation(), {
      companyId: account.companyId,
      accountId: account.id,
      messageId: message.id,
      status,
      createdAt: at(11),
    });
    assert.equal(summary({ automation }).status, "queued");
    assert.equal(
      summary({ automation, account: { ...account, aiAnalysisEnabled: false } }).status,
      "not_reviewed",
    );
  }
});

test("analysis status identifies running, completed and unsuccessful review", () => {
  for (const [status, expected] of [
    ["running", "reviewing"],
    ["succeeded", "reviewed"],
    ["failed", "needs_attention"],
  ] as const) {
    const result = summary({ analyses: [analysis({ status })] });
    assert.equal(result.status, expected);
    assert.equal(result.employee?.name, "Ada");
  }
});

test("historical review evidence is kept when AI analysis is switched off", () => {
  assert.equal(
    summary({ account: { ...account, aiAnalysisEnabled: false }, analyses: [analysis()] }).status,
    "reviewed",
  );
});

test("foreign company, mailbox, thread or message analysis cannot mark an email reviewed", () => {
  for (const field of ["companyId", "accountId", "threadId", "messageId"] as const) {
    assert.equal(
      summary({ analyses: [analysis({ [field]: "elsewhere" })] }).status,
      "not_reviewed",
    );
  }
});

test("a deleted or foreign employee does not hide the review or disclose its identity", () => {
  assert.equal(summary({ analyses: [analysis()], employees: new Map() }).employee, null);
  const foreign = new Map([[employee.id, { ...employee, companyId: "elsewhere" }]]);
  assert.equal(summary({ analyses: [analysis()], employees: foreign }).employee, null);
});

test("new arrivals reset completed and running handovers that predate the new email", () => {
  for (const status of ["completed", "running"] as const) {
    assert.equal(
      summary({ handovers: [handover({ status, startedAt: at(9), finishedAt: at(15) })] }).status,
      "not_reviewed",
    );
  }
  assert.equal(summary({ handovers: [handover({ startedAt: null })] }).status, "not_reviewed");
});

test("active review wins over a failed attempt and queued work wins over old success", () => {
  assert.equal(
    summary({
      analyses: [analysis({ status: "failed" })],
      handovers: [handover({ status: "running", finishedAt: null })],
    }).status,
    "reviewing",
  );
  assert.equal(
    summary({
      analyses: [analysis()],
      handovers: [handover({ status: "pending", startedAt: null, finishedAt: null })],
    }).status,
    "queued",
  );
});

test("the newest terminal review decides whether attention is needed", () => {
  assert.equal(
    summary({ analyses: [analysis()], handovers: [handover({ status: "failed" })] }).status,
    "needs_attention",
  );
  assert.equal(
    summary({ analyses: [analysis({ status: "failed" })], handovers: [handover()] }).status,
    "reviewed",
  );
});

test("drafts, sent mail and our own messages are excluded from inbound review", () => {
  for (const patch of [
    { labelIds: " SENT " },
    { labelIds: " DRAFT " },
    { gmailDraftId: "draft" },
    { createdByEmployeeId: employee.id },
    { createdByUserId: "member" },
    { fromEmail: " OWNER@EXAMPLE.COM " },
  ]) {
    assert.equal(isInboundReviewMessage({ ...message, ...patch }, account), false);
  }
});

async function databaseMailbox() {
  await resetTestDb();
  const mailbox = await insert(MailAccount, {
    companyId: randomUUID(),
    connectionId: randomUUID(),
    address: "owner@example.com",
    aiAnalysisEnabled: true,
  });
  const thread = await insert(MailThread, {
    companyId: mailbox.companyId,
    accountId: mailbox.id,
    gmailThreadId: randomUUID(),
  });
  return { mailbox, thread };
}
async function databaseMessage(
  mailbox: MailAccount,
  thread: MailThread,
  overrides: Partial<MailMessage> = {},
) {
  return insert(MailMessage, {
    companyId: mailbox.companyId,
    accountId: mailbox.id,
    threadId: thread.id,
    gmailThreadId: thread.gmailThreadId,
    gmailMessageId: randomUUID(),
    fromEmail: "customer@example.com",
    labelIds: " INBOX ",
    createdAt: at(10),
    sentAt: at(5),
    ...overrides,
  });
}

test("batched query selects a newly arrived email even when its Date header is older", async () => {
  const { mailbox, thread } = await databaseMailbox();
  const older = await databaseMessage(mailbox, thread);
  await insert(MailInboundAnalysis, {
    companyId: mailbox.companyId,
    accountId: mailbox.id,
    threadId: thread.id,
    messageId: older.id,
    status: "succeeded",
    finishedAt: at(12),
  });
  const latest = await databaseMessage(mailbox, thread, { createdAt: at(15), sentAt: at(1) });
  const result = (await mailReviewsForThreads(mailbox, [thread])).get(thread.id)!;
  assert.equal(result.latestMessageId, latest.id);
  assert.equal(result.status, "not_reviewed");
});

test("batched query excludes newer outgoing drafts and foreign rows", async () => {
  const { mailbox, thread } = await databaseMailbox();
  const incoming = await databaseMessage(mailbox, thread);
  await databaseMessage(mailbox, thread, { labelIds: " DRAFT ", createdAt: at(20) });
  await databaseMessage(mailbox, thread, { labelIds: " SENT ", createdAt: at(21) });
  await databaseMessage(mailbox, thread, { companyId: "elsewhere", createdAt: at(22) });
  const result = (await mailReviewsForThreads(mailbox, [thread])).get(thread.id)!;
  assert.equal(result.latestMessageId, incoming.id);
  assert.equal(
    (await mailReviewsForThreads({ ...mailbox, companyId: "elsewhere" }, [thread])).size,
    0,
  );
});

test("a page of conversations returns independent statuses without mixing evidence", async () => {
  const { mailbox, thread } = await databaseMailbox();
  const incoming = await databaseMessage(mailbox, thread);
  const second = await insert(MailThread, {
    companyId: mailbox.companyId,
    accountId: mailbox.id,
    gmailThreadId: randomUUID(),
  });
  await databaseMessage(mailbox, second);
  await insert(MailInboundAnalysis, {
    companyId: mailbox.companyId,
    accountId: mailbox.id,
    threadId: thread.id,
    messageId: incoming.id,
    status: "succeeded",
    finishedAt: at(12),
  });
  const result = await mailReviewsForThreads(mailbox, [thread, second]);
  assert.equal(result.get(thread.id)?.status, "reviewed");
  assert.equal(result.get(second.id)?.status, "not_reviewed");
});

test("exact handover snapshots win over timestamp coincidences", () => {
  assert.equal(
    summary({ handovers: [handover()], handoverMessages: new Map([["handover", "prior-message"]]) })
      .status,
    "not_reviewed",
  );
  assert.equal(
    summary({
      handovers: [handover({ startedAt: at(9) })],
      handoverMessages: new Map([["handover", message.id]]),
    }).status,
    "reviewed",
  );
});

test("retrying an old handover is queued for the current email", () => {
  assert.equal(
    summary({
      handovers: [
        handover({ status: "pending", createdAt: at(1), startedAt: null, finishedAt: null }),
      ],
    }).status,
    "queued",
  );
});

test("legacy handovers cannot mark a reply reviewed inside its ambiguous arrival second", () => {
  const duringArrivalSecond = new Date(message.createdAt.getTime() + 800);
  for (const status of ["running", "completed"] as const) {
    assert.equal(
      summary({ handovers: [handover({ status, startedAt: duringArrivalSecond })] }).status,
      "not_reviewed",
    );
  }
  assert.equal(summary({ handovers: [handover({ startedAt: at(11) })] }).status, "reviewed");
  assert.equal(
    summary({
      handovers: [handover({ startedAt: duringArrivalSecond })],
      handoverMessages: new Map([["handover", message.id]]),
    }).status,
    "reviewed",
  );
});
