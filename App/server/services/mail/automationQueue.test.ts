import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  MailAutomationBusyError,
  enqueueInboundAutomation,
  runMailAutomationQueuePass,
  waitForMailAutomation,
} from "./automationQueue.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_automation_queue_test";
const INTERRUPTED_AFTER_MS = 12 * 60 * 60 * 1_000 + 60_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createAccount(suffix: string = randomUUID()): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection-${suffix}`,
    address: `${suffix}@example.com`,
    status: "active",
  });
}

async function createMessage(account: MailAccount, suffix: string): Promise<MailMessage> {
  return insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: `thread-${suffix}`,
    gmailMessageId: `gmail-message-${suffix}`,
    gmailThreadId: `gmail-thread-${suffix}`,
    fromEmail: "sender@example.com",
    toEmails: account.address,
    subject: `Subject ${suffix}`,
  });
}

async function delivery(gmailMessageId: string): Promise<MailInboundAutomation> {
  return AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({ gmailMessageId });
}

describe("inbound mail automation queue", () => {
  test("concurrent duplicate enqueues launch exactly one set of effects", async () => {
    const account = await createAccount("duplicate");
    const message = await createMessage(account, "duplicate");
    let effects = 0;
    const options = {
      runEffects: async (
        _account: MailAccount,
        _message: MailMessage,
        _assertRunnable: () => Promise<void>,
        beforeEffect: () => Promise<void>,
      ) => {
        await beforeEffect();
        effects += 1;
      },
    };

    await Promise.all(Array.from({ length: 20 }, () => enqueueInboundAutomation(message, options)));
    await waitForMailAutomation(account.id);

    const rows = await AppDataSource.getRepository(MailInboundAutomation).find({
      where: { accountId: account.id, gmailMessageId: message.gmailMessageId },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "succeeded");
    assert.ok(rows[0].finishedAt);
    assert.equal(effects, 1);
  });

  test("keeps a second same-account delivery queued until the active one finishes", async () => {
    const account = await createAccount("serialized");
    const first = await createMessage(account, "serialized-first");
    const second = await createMessage(account, "serialized-second");
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const effects: string[] = [];
    const options = {
      runEffects: async (
        _account: MailAccount,
        message: MailMessage,
        _assertRunnable: () => Promise<void>,
        beforeEffect: () => Promise<void>,
      ) => {
        await beforeEffect();
        effects.push(message.id);
        if (message.id === first.id) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
    };

    await enqueueInboundAutomation(first, options);
    await firstStarted.promise;
    await enqueueInboundAutomation(second, options);

    const firstDelivery = await delivery(first.gmailMessageId);
    const secondDelivery = await delivery(second.gmailMessageId);
    assert.equal(firstDelivery.status, "running");
    assert.equal(secondDelivery.status, "queued");
    assert.deepEqual(effects, [first.id]);

    releaseFirst.resolve();
    await waitForMailAutomation(account.id);
    await runMailAutomationQueuePass(options);
    await waitForMailAutomation(account.id);

    assert.equal((await delivery(first.gmailMessageId)).status, "succeeded");
    assert.equal((await delivery(second.gmailMessageId)).status, "succeeded");
    assert.deepEqual(effects, [first.id, second.id]);
  });

  test("fails a queued delivery when its mailbox was disconnected", async () => {
    const missingAccountId = randomUUID();
    const message = AppDataSource.getRepository(MailMessage).create({
      id: randomUUID(),
      companyId: COMPANY_ID,
      accountId: missingAccountId,
      gmailMessageId: "gmail-message-disconnected",
    });
    let effects = 0;

    await enqueueInboundAutomation(message, {
      runEffects: async () => {
        effects += 1;
      },
    });
    await waitForMailAutomation(missingAccountId);

    const row = await delivery(message.gmailMessageId);
    assert.equal(row.status, "failed");
    assert.match(row.errorMessage, /mailbox was disconnected/i);
    assert.ok(row.finishedAt);
    assert.equal(effects, 0);
  });

  test("fails a claimed delivery when its mirrored message disappeared", async () => {
    const account = await createAccount("missing-message");
    const message = AppDataSource.getRepository(MailMessage).create({
      id: randomUUID(),
      companyId: account.companyId,
      accountId: account.id,
      gmailMessageId: "gmail-message-missing",
    });
    let effects = 0;

    await enqueueInboundAutomation(message, {
      runEffects: async () => {
        effects += 1;
      },
    });
    await waitForMailAutomation(account.id);

    const row = await delivery(message.gmailMessageId);
    assert.equal(row.status, "failed");
    assert.match(row.errorMessage, /inbound message no longer exists/i);
    assert.ok(row.startedAt);
    assert.ok(row.finishedAt);
    assert.equal(effects, 0);
  });

  test("recovers null and strictly stale running timestamps at the exact boundary", async () => {
    const now = new Date("2026-08-14T12:00:00.500Z");
    const staleBoundary = new Date(now.getTime() - INTERRUPTED_AFTER_MS);
    const account = await createAccount("stale-boundary");
    const common = {
      companyId: account.companyId,
      accountId: account.id,
      status: "running" as const,
      finishedAt: null,
      errorMessage: "",
    };
    const missingTimestamp = await insert(MailInboundAutomation, {
      ...common,
      messageId: randomUUID(),
      gmailMessageId: "gmail-message-no-start",
      startedAt: null,
    });
    const exactlyAtBoundary = await insert(MailInboundAutomation, {
      ...common,
      messageId: randomUUID(),
      gmailMessageId: "gmail-message-at-boundary",
      startedAt: staleBoundary,
    });
    const strictlyStale = await insert(MailInboundAutomation, {
      ...common,
      messageId: randomUUID(),
      gmailMessageId: "gmail-message-strictly-stale",
      startedAt: new Date(staleBoundary.getTime() - 1),
    });

    await runMailAutomationQueuePass({ now: () => now });

    const repo = AppDataSource.getRepository(MailInboundAutomation);
    const noStart = await repo.findOneByOrFail({ id: missingTimestamp.id });
    const boundary = await repo.findOneByOrFail({ id: exactlyAtBoundary.id });
    const stale = await repo.findOneByOrFail({ id: strictlyStale.id });
    assert.equal(noStart.status, "failed");
    assert.equal(noStart.finishedAt?.toISOString(), now.toISOString());
    assert.match(noStart.errorMessage, /app stopped/i);
    assert.equal(boundary.status, "running");
    assert.equal(boundary.finishedAt, null);
    assert.equal(stale.status, "failed");
    assert.equal(stale.finishedAt?.toISOString(), now.toISOString());
    assert.match(stale.errorMessage, /app stopped/i);
  });

  test("reports a busy active effect and resolves after that effect is released", async () => {
    const account = await createAccount("busy");
    const message = await createMessage(account, "busy");
    const started = deferred();
    const release = deferred();

    await enqueueInboundAutomation(message, {
      runEffects: async (_account, _message, _assertRunnable, beforeEffect) => {
        await beforeEffect();
        started.resolve();
        await release.promise;
      },
    });
    await started.promise;

    await assert.rejects(
      () => waitForMailAutomation(account.id, 0),
      (error: unknown) => {
        assert.ok(error instanceof MailAutomationBusyError);
        assert.match(error.message, /still finishing an inbound automation/i);
        return true;
      },
    );
    assert.equal((await delivery(message.gmailMessageId)).status, "running");

    release.resolve();
    await waitForMailAutomation(account.id, 1_000);
    assert.equal((await delivery(message.gmailMessageId)).status, "succeeded");
  });
});
