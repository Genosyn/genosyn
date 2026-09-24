import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Standdown } from "../../db/entities/Standdown.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import type { chatWithEmployee } from "../chat.js";
import { refreshStanddowns } from "../standdowns.js";
import { mailReviewsForThreads } from "./reviewStatus.js";
import { runHandover } from "./handovers.js";

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
});
after(closeTestDb);

async function fixture(mode: MailHandover["mode"] = "work") {
  const employee = await insert(AIEmployee, {
    companyId: "company",
    name: "Morgan",
    slug: "morgan",
    role: "Support",
    soulBody: "Prepare company work.",
  });
  const account = await insert(MailAccount, {
    companyId: "company",
    connectionId: "connection",
    address: "team@example.com",
  });
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: "thread",
    subject: "Quote please",
  });
  await insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "message",
    gmailThreadId: "thread",
    fromEmail: "customer@example.com",
    bodyText: "Please quote our regular service.",
  });
  const instruction = "Use approved prices and prepare a quote.";
  const rule = await insert(MailRule, {
    companyId: "company",
    accountId: account.id,
    name: "Quote requests",
    actionsJson: JSON.stringify([
      { type: "handToEmployee", employeeId: employee.id, instruction, mode },
    ]),
  });
  const handover = await insert(MailHandover, {
    companyId: "company",
    employeeId: employee.id,
    accountId: account.id,
    threadId: thread.id,
    mode,
    instruction,
    sourceKind: "rule",
    ruleId: rule.id,
  });
  const grant = await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "send",
  });
  return { account, thread, employee, rule, handover, grant };
}
const reload = (id: string) => AppDataSource.getRepository(MailHandover).findOneByOrFail({ id });

describe("queued proactive mail work", () => {
  for (const mode of ["work", "draft", "reply", "triage"] as const) {
    test(`${mode} prepares once as the employee, retaining proactive and delivery ceilings even with a Send Grant`, async () => {
      const { handover, thread } = await fixture(mode);
      let calls = 0;
      const runChat: typeof chatWithEmployee = async (
        _company,
        _employee,
        prompt,
        _history,
        options,
      ) => {
        calls++;
        assert.equal(options?.toolAuthority, "employee");
        assert.equal(options?.mailDeliveryMode, mode === "triage" ? "triage" : "review");
        assert.equal(options?.proactiveReview, true);
        assert.equal(options?.mailHandoverId, handover.id);
        assert.equal(options?.mailThreadId, thread.id);
        assert.match(prompt, /Mode: PROACTIVE PREPARATION/);
        if (mode === "triage") {
          assert.match(prompt, /Apply the trusted filing instruction with update_mail_thread/);
          assert.match(prompt, /Do not ask approval for this ordinary filing/);
          assert.match(
            prompt,
            /Do not change labels, block a sender, unsubscribe, compose a reply, or send mail/,
          );
          assert.doesNotMatch(prompt, /request_work_review/);
        } else {
          assert.match(prompt, /complete permitted factual recordkeeping and Workstream updates/);
          assert.match(prompt, /request_mail_review/);
          assert.match(prompt, /without a separate approval to prepare it/);
          assert.match(
            prompt,
            /Use request_work_review only for consequential work outside this scope/,
          );
          assert.match(prompt, /Never send or create a Gmail or IMAP draft/);
        }
        assert.doesNotMatch(prompt, /create_mail_draft/);
        return {
          status: "ok",
          reply: "Completed the permitted preparation.",
          attachmentIds: [],
          sidecars: {},
        };
      };
      await runHandover(handover.id, runChat);
      await runHandover(handover.id, runChat);
      assert.equal(calls, 1);
      assert.equal((await reload(handover.id)).status, "completed");
    });
  }

  test("rechecks a revoked mailbox Grant before exposing any transcript", async () => {
    const { handover, grant } = await fixture();
    await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({ id: grant.id });
    await runHandover(handover.id, async () => {
      assert.fail("Must not start a model");
    });
    const row = await reload(handover.id);
    assert.equal(row.status, "failed");
    assert.match(row.errorMessage, /no access/);
  });

  test("triage requires a Draft Grant because it changes mailbox state", async () => {
    const { handover, grant } = await fixture("triage");
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { id: grant.id },
      { accessLevel: "read" },
    );
    await runHandover(handover.id, async () => {
      assert.fail("Read-only mail access must not start triage");
    });
    const row = await reload(handover.id);
    assert.equal(row.status, "failed");
    assert.match(row.errorMessage, /needs at least "draft"/);
  });

  test("rule edits, disabling and deleted employees invalidate queued work", async () => {
    const { handover, rule } = await fixture();
    await AppDataSource.getRepository(MailRule).update({ id: rule.id }, { enabled: false });
    await runHandover(handover.id, async () => {
      assert.fail("Must not start a model");
    });
    assert.match((await reload(handover.id)).errorMessage, /disabled, removed, or changed/);
  });

  test("paused mailboxes defer the same row and resume with the original ceiling", async () => {
    const { handover, account } = await fixture();
    await AppDataSource.getRepository(MailAccount).update({ id: account.id }, { status: "paused" });
    await runHandover(handover.id, async () => {
      assert.fail("Paused work must not start");
    });
    assert.equal((await reload(handover.id)).status, "pending");
    assert.equal((await reload(handover.id)).startedAt, null);
    await AppDataSource.getRepository(MailAccount).update({ id: account.id }, { status: "active" });
    await runHandover(handover.id, async () => ({
      status: "ok",
      reply: "Prepared.",
      attachmentIds: [],
      sidecars: {},
    }));
    assert.equal((await reload(handover.id)).status, "completed");
  });

  test("Standdowns defer work and cross-company rows fail before a model call", async () => {
    const { handover, employee } = await fixture();
    const stop = await insert(Standdown, {
      companyId: "company",
      scope: "employee",
      scopeId: employee.id,
      reason: "Stop",
      placedAt: new Date(),
    });
    await refreshStanddowns();
    await runHandover(handover.id, async () => {
      assert.fail("Stopped work must not start");
    });
    assert.equal((await reload(handover.id)).status, "pending");
    await AppDataSource.getRepository(Standdown).delete({ id: stop.id });
    await refreshStanddowns();
    await AppDataSource.getRepository(AIEmployee).update(
      { id: employee.id },
      { companyId: "another" },
    );
    await runHandover(handover.id, async () => {
      assert.fail("Foreign work must not start");
    });
    assert.equal((await reload(handover.id)).status, "failed");
  });
});

test("handover snapshot excludes customer replies that arrive while the AI Employee is working", async () => {
  const { handover, account, thread, employee } = await fixture();
  const original = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
    threadId: thread.id,
  });
  let newerId = "";
  await runHandover(handover.id, async () => {
    const started = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: account.companyId,
      action: "mail.handover.started",
      targetId: handover.id,
    });
    assert.equal(started.actorEmployeeId, employee.id);
    assert.deepEqual(JSON.parse(started.metadataJson), {
      latestInboundMessageId: original.id,
      mailThreadId: thread.id,
      mailHandoverId: handover.id,
    });
    const newer = await insert(MailMessage, {
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailThreadId: thread.gmailThreadId,
      gmailMessageId: "new-customer-reply",
      fromEmail: "customer@example.com",
      bodyText: "One more thing.",
      createdAt: new Date(),
      sentAt: new Date("2020-01-01T00:00:00Z"),
    });
    newerId = newer.id;
    return { status: "ok", reply: "Prepared the quote.", attachmentIds: [], sidecars: {} };
  });
  assert.equal((await reload(handover.id)).status, "completed");
  const summary = (await mailReviewsForThreads(account, [thread])).get(thread.id)!;
  assert.equal(summary.latestMessageId, newerId);
  assert.equal(summary.status, "not_reviewed");
});

test("handover snapshot includes the latest observed inbound despite an older Date and a full brief", async () => {
  const { handover, account, thread } = await fixture();
  await AppDataSource.getRepository(MailMessage).update(
    { threadId: thread.id },
    {
      createdAt: new Date("2025-01-01T00:00:00Z"),
      sentAt: new Date("2025-01-01T00:00:00Z"),
    },
  );
  for (let index = 0; index < 8; index++) {
    await insert(MailMessage, {
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailThreadId: thread.gmailThreadId,
      gmailMessageId: `historical-${index}`,
      fromEmail: "customer@example.com",
      bodyText: `Historical message ${index}. ${"x".repeat(6_000)}`,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      sentAt: new Date(Date.UTC(2027, 0, index + 1)),
    });
  }
  const latest = await insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailThreadId: thread.gmailThreadId,
    gmailMessageId: "latest-observed-old-date",
    fromEmail: "customer@example.com",
    bodyText: "Current request: quote the revised scope.",
    createdAt: new Date("2026-09-24T10:00:00Z"),
    sentAt: new Date("2020-01-01T00:00:00Z"),
  });
  await runHandover(handover.id, async (_company, _employee, prompt) => {
    const snapshotJson = prompt.split("Untrusted email snapshot (JSON):\n\n")[1].split("\n\n")[0];
    const snapshot = JSON.parse(snapshotJson) as {
      omittedMessages: number;
      messages: Array<{ messageId: string; body: string; sentAt: string }>;
    };
    assert.ok(
      snapshot.omittedMessages > 0,
      "Historical content should exhaust the transcript budget",
    );
    assert.equal(snapshot.messages.filter((message) => message.messageId === latest.id).length, 1);
    assert.equal(snapshot.messages.at(-1)?.messageId, latest.id);
    assert.equal(snapshot.messages.at(-1)?.body, latest.bodyText);
    const historicalDates = snapshot.messages
      .filter((message) => message.messageId !== latest.id)
      .map((message) => message.sentAt);
    assert.deepEqual(historicalDates, [...historicalDates].sort());
    const started = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: account.companyId,
      action: "mail.handover.started",
      targetId: handover.id,
    });
    assert.equal(JSON.parse(started.metadataJson).latestInboundMessageId, latest.id);
    return {
      status: "ok",
      reply: "Reviewed the current request.",
      attachmentIds: [],
      sidecars: {},
    };
  });
  const summary = (await mailReviewsForThreads(account, [thread])).get(thread.id)!;
  assert.equal(summary.latestMessageId, latest.id);
  assert.equal(summary.status, "reviewed");
});
