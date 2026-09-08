import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
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
  test("runs once as the employee, retaining draft ceiling even with a Send Grant", async () => {
    const { handover, thread } = await fixture();
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
      assert.equal(options?.mailDeliveryMode, "draft");
      assert.equal(options?.mailThreadId, thread.id);
      assert.match(prompt, /draft estimate/);
      return {
        status: "ok",
        reply: "Prepared estimate and draft reply.",
        attachmentIds: [],
        sidecars: {},
      };
    };
    await runHandover(handover.id, runChat);
    await runHandover(handover.id, runChat);
    assert.equal(calls, 1);
    assert.equal((await reload(handover.id)).status, "completed");
  });

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
