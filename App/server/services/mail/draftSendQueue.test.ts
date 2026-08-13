import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailDraftSendBatch } from "../../db/entities/MailDraftSendBatch.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import {
  DraftSendDisconnectBusyError,
  EXPECTED_SEND_DELAY_MS,
  MAX_QUEUED_DRAFT_IDS,
  MAX_SEND_DELAY_MS,
  MIN_SEND_DELAY_MS,
  activeDraftQueueIds,
  createDraftSendBatch,
  getLatestDraftSendBatch,
  processDraftSendBatch,
  randomSendDelayMs,
  recoverDraftSendBatches,
  withDraftSendDisconnectFence,
} from "./draftSendQueue.js";
import { disconnectMailAccount } from "./sync.js";
import { listDrafts, previewDraftSend } from "./drafts.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_draft_send_queue_test";

async function createDrafts(count: number): Promise<{
  account: MailAccount;
  drafts: MailMessage[];
}> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: testId("connection"),
    address: "sender@example.com",
  });
  const drafts: MailMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    drafts.push(
      await insert(MailMessage, {
        companyId: COMPANY_ID,
        accountId: account.id,
        threadId: `thread-${i}`,
        gmailMessageId: `gmail-message-${i}`,
        gmailThreadId: `gmail-thread-${i}`,
        gmailDraftId: `gmail-draft-${i}`,
        toEmails: `recipient-${i}@example.com`,
        subject: `Draft ${i}`,
      }),
    );
  }
  return { account, drafts };
}

describe("draft send pacing", () => {
  test("always chooses a delay in the inclusive one-to-two minute range", () => {
    assert.equal(
      randomSendDelayMs(() => 0),
      MIN_SEND_DELAY_MS,
    );
    assert.equal(
      randomSendDelayMs(() => 0.999999999),
      MAX_SEND_DELAY_MS,
    );
  });

  test("reports an approximate completion time for every remaining email", async () => {
    const { account, drafts } = await createDrafts(3);
    const now = new Date("2026-07-29T10:00:00.000Z");
    const result = await createDraftSendBatch(
      account,
      drafts.map((draft) => draft.id),
      null,
      { now: () => now, delayMs: () => MIN_SEND_DELAY_MS },
    );

    assert.equal(result.added, 3);
    assert.equal(result.batch.nextSendAt, "2026-07-29T10:01:00.000Z");
    assert.equal(
      result.batch.estimatedCompletionAt,
      new Date(now.getTime() + MIN_SEND_DELAY_MS + 2 * EXPECTED_SEND_DELAY_MS).toISOString(),
    );
  });

  test("hides active queue items from the review list, totals, and facets", async () => {
    const { account, drafts } = await createDrafts(3);
    await createDraftSendBatch(
      account,
      drafts.slice(0, 2).map((draft) => draft.id),
      null,
    );

    const list = await listDrafts(account, { filter: {}, offset: 0, limit: 100 });
    assert.deepEqual(
      list.drafts.map((draft) => draft.id),
      [drafts[2].id],
    );
    assert.deepEqual(list.totals, {
      total: 1,
      sendable: 1,
      missingRecipient: 0,
      queued: 2,
    });
    assert.deepEqual(
      list.facets.employees.map((facet) => facet.count),
      [1],
    );
    assert.deepEqual(
      list.facets.routines.map((facet) => facet.count),
      [1],
    );
  });

  test("appends new drafts to the active queue without resetting its next-send time", async () => {
    const { account, drafts } = await createDrafts(4);
    drafts[3].toEmails = "";
    await AppDataSource.getRepository(MailMessage).save(drafts[3]);
    const now = new Date("2026-07-29T10:00:00.000Z");
    const initial = await createDraftSendBatch(account, [drafts[0].id], "member-1", {
      now: () => now,
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    const appended = await createDraftSendBatch(
      account,
      [drafts[0].id, drafts[1].id, drafts[1].id, drafts[2].id, drafts[3].id],
      "member-2",
      { now: () => now, delayMs: () => MAX_SEND_DELAY_MS },
    );

    assert.equal(initial.batch.id, appended.batch.id);
    assert.equal(appended.added, 2);
    assert.equal(appended.batch.total, 3);
    assert.equal(appended.batch.remaining, 3);
    assert.equal(appended.batch.nextSendAt, initial.batch.nextSendAt);
    assert.deepEqual(
      appended.batch.queuedDraftIds,
      drafts.slice(0, 3).map((draft) => draft.id),
    );
  });

  test("keeps previews sendable while another batch is active", async () => {
    const { account, drafts } = await createDrafts(2);
    await createDraftSendBatch(account, [drafts[0].id], null);

    const preview = await previewDraftSend(account, { ids: drafts.map((draft) => draft.id) });
    assert.equal(preview.sendable, 1);
    assert.equal(preview.alreadyQueued, 1);
    assert.deepEqual(preview.sendableIds, [drafts[1].id]);
  });

  test("rejects an append when the active queue has reached its durable cap", async () => {
    const { account, drafts } = await createDrafts(2);
    const fullItems = Array.from({ length: MAX_QUEUED_DRAFT_IDS }, (_, index) => ({
      draftId: index === 0 ? drafts[0].id : `queued-${index}`,
      status: "queued",
      errorMessage: "",
    }));
    await insert(MailDraftSendBatch, {
      companyId: account.companyId,
      accountId: account.id,
      status: "running",
      total: fullItems.length,
      sent: 0,
      failed: 0,
      itemsJson: JSON.stringify(fullItems),
      nextSendAt: new Date(Date.now() + MIN_SEND_DELAY_MS),
      finishedAt: null,
      createdByUserId: null,
    });

    await assert.rejects(
      () => createDraftSendBatch(account, [drafts[1].id], null),
      /maximum of 2,000 emails/,
    );
  });

  test("processes one draft per due time and schedules the next from completion", async () => {
    const { account, drafts } = await createDrafts(2);
    const createdAt = new Date("2026-07-29T10:00:00.000Z");
    const created = await createDraftSendBatch(
      account,
      drafts.map((draft) => draft.id),
      null,
      { now: () => createdAt, delayMs: () => MIN_SEND_DELAY_MS },
    );
    const batch = created.batch;
    assert.deepEqual(
      [...(await activeDraftQueueIds(account.id))].sort(),
      drafts.map((draft) => draft.id).sort(),
    );

    const sentIds: string[] = [];
    const firstCompletedAt = new Date("2026-07-29T10:01:05.000Z");
    const first = await processDraftSendBatch(batch.id, {
      now: () => firstCompletedAt,
      delayMs: () => MAX_SEND_DELAY_MS,
      sendDraft: async (_account, draft) => {
        sentIds.push(draft.id);
        return draft;
      },
    });
    assert.equal(first?.sent, 1);
    assert.equal(first?.remaining, 1);
    assert.equal(first?.nextSendAt, "2026-07-29T10:03:05.000Z");
    assert.equal(first?.estimatedCompletionAt, "2026-07-29T10:03:05.000Z");

    await processDraftSendBatch(batch.id, {
      now: () => new Date("2026-07-29T10:02:59.000Z"),
      sendDraft: async (_account, draft) => {
        sentIds.push(draft.id);
        return draft;
      },
    });
    assert.equal(sentIds.length, 1);

    const completed = await processDraftSendBatch(batch.id, {
      now: () => new Date("2026-07-29T10:03:05.000Z"),
      sendDraft: async (_account, draft) => {
        sentIds.push(draft.id);
        return draft;
      },
    });
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.sent, 2);
    assert.equal(completed?.remaining, 0);
    assert.equal(completed?.nextSendAt, null);
    assert.equal(completed?.estimatedCompletionAt, null);
    assert.equal(sentIds.length, 2);
  });

  test("extends a partially processed batch and includes the addition in its ETA", async () => {
    const { account, drafts } = await createDrafts(3);
    const created = await createDraftSendBatch(
      account,
      drafts.slice(0, 2).map((draft) => draft.id),
      null,
      {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        delayMs: () => MIN_SEND_DELAY_MS,
      },
    );
    const firstCompletedAt = new Date("2026-07-29T10:01:00.000Z");
    await processDraftSendBatch(created.batch.id, {
      now: () => firstCompletedAt,
      delayMs: () => MAX_SEND_DELAY_MS,
      sendDraft: async (_account, draft) => draft,
    });

    const appended = await createDraftSendBatch(account, [drafts[2].id], null, {
      now: () => firstCompletedAt,
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    assert.equal(appended.added, 1);
    assert.equal(appended.batch.sent, 1);
    assert.equal(appended.batch.remaining, 2);
    assert.equal(appended.batch.nextSendAt, "2026-07-29T10:03:00.000Z");
    assert.equal(appended.batch.estimatedCompletionAt, "2026-07-29T10:04:30.000Z");
  });

  test("does not lose an append that arrives while an email is being sent", async () => {
    const { account, drafts } = await createDrafts(3);
    const queued = await createDraftSendBatch(
      account,
      drafts.slice(0, 2).map((draft) => draft.id),
      null,
      {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        delayMs: () => MIN_SEND_DELAY_MS,
      },
    );

    let markSendStarted = (): void => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let finishSend = (): void => undefined;
    const mayFinishSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const processing = processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
      sendDraft: async (_account, draft) => {
        markSendStarted();
        await mayFinishSend;
        return draft;
      },
    });
    await sendStarted;

    let appendSettled = false;
    const appending = createDraftSendBatch(account, [drafts[2].id], null, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
    }).then((result) => {
      appendSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(appendSettled, false);

    finishSend();
    await processing;
    const appended = await appending;
    assert.equal(appended.batch.sent, 1);
    assert.equal(appended.batch.total, 3);
    assert.equal(appended.batch.remaining, 2);
    assert.deepEqual(appended.batch.queuedDraftIds, [drafts[1].id, drafts[2].id]);
  });

  test("disconnect waits for an in-flight draft send before deleting every row", async () => {
    const { account, drafts } = await createDrafts(2);
    const queued = await createDraftSendBatch(
      account,
      drafts.map((draft) => draft.id),
      null,
      {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        delayMs: () => MIN_SEND_DELAY_MS,
      },
    );
    let markSendStarted = (): void => undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let finishSend = (): void => undefined;
    const mayFinishSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    let sends = 0;
    const processing = processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
      sendDraft: async (_account, draft) => {
        sends += 1;
        markSendStarted();
        await mayFinishSend;
        return draft;
      },
    });
    await sendStarted;

    let disconnectSettled = false;
    const disconnecting = disconnectMailAccount(account).then(() => {
      disconnectSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disconnectSettled, false);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 2);
    assert.equal(await AppDataSource.getRepository(MailDraftSendBatch).count(), 1);

    finishSend();
    await processing;
    await disconnecting;
    assert.equal(sends, 1);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailDraftSendBatch).count(), 0);
  });

  test("disconnect waits for queue creation that already entered", async () => {
    const { account, drafts } = await createDrafts(1);
    // Async functions execute through their first await immediately, so the
    // creator has registered its account promise before Disconnect raises its
    // fence. The disconnect must then delete the newly-created batch too.
    const creating = createDraftSendBatch(account, [drafts[0].id], null, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    const disconnecting = disconnectMailAccount(account);

    const created = await creating;
    assert.equal(created.added, 1);
    await disconnecting;
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailDraftSendBatch).count(), 0);
  });

  test("restart requeues only the interrupted item and preserves durable progress", async () => {
    const { account, drafts } = await createDrafts(3);
    const restartAt = new Date("2026-07-29T11:00:00.000Z");
    const batch = await insert(MailDraftSendBatch, {
      companyId: account.companyId,
      accountId: account.id,
      status: "running",
      total: 3,
      sent: 0,
      failed: 0,
      itemsJson: JSON.stringify([
        { draftId: drafts[0].id, status: "sent", errorMessage: "" },
        { draftId: drafts[1].id, status: "sending", errorMessage: "" },
        { draftId: drafts[2].id, status: "failed", errorMessage: "Invalid recipient" },
      ]),
      nextSendAt: new Date("2026-07-29T10:00:00.000Z"),
      finishedAt: null,
      createdByUserId: null,
    });

    await recoverDraftSendBatches({
      now: () => restartAt,
      delayMs: () => MIN_SEND_DELAY_MS,
    });

    const recovered = await AppDataSource.getRepository(MailDraftSendBatch).findOneByOrFail({
      id: batch.id,
    });
    assert.equal(recovered.status, "running");
    assert.equal(recovered.sent, 1);
    assert.equal(recovered.failed, 1);
    assert.equal(recovered.nextSendAt?.toISOString(), "2026-07-29T11:01:00.000Z");
    const recoveredView = await getLatestDraftSendBatch(account);
    assert.deepEqual(recoveredView?.queuedDraftIds, [drafts[1].id]);
    assert.deepEqual(recoveredView?.failures, [{ id: drafts[2].id, reason: "Invalid recipient" }]);

    const attempted: string[] = [];
    const completed = await processDraftSendBatch(batch.id, {
      now: () => new Date("2026-07-29T11:01:00.000Z"),
      sendDraft: async (_account, draft) => {
        attempted.push(draft.id);
        return draft;
      },
    });
    assert.deepEqual(attempted, [drafts[1].id]);
    assert.equal(completed?.status, "completed_with_errors");
    assert.equal(completed?.sent, 2);
    assert.equal(completed?.failed, 1);
  });

  test("restart closes an active batch whose items are already terminal", async () => {
    const { account, drafts } = await createDrafts(2);
    const restartAt = new Date("2026-07-29T11:00:00.000Z");
    const batch = await insert(MailDraftSendBatch, {
      companyId: account.companyId,
      accountId: account.id,
      status: "running",
      total: 2,
      sent: 0,
      failed: 0,
      itemsJson: JSON.stringify([
        { draftId: drafts[0].id, status: "sent", errorMessage: "" },
        { draftId: drafts[1].id, status: "failed", errorMessage: "Gmail refused the send" },
      ]),
      nextSendAt: new Date("2026-07-29T10:00:00.000Z"),
      finishedAt: null,
      createdByUserId: null,
    });

    await recoverDraftSendBatches({ now: () => restartAt });

    const recovered = await AppDataSource.getRepository(MailDraftSendBatch).findOneByOrFail({
      id: batch.id,
    });
    assert.equal(recovered.status, "completed_with_errors");
    assert.equal(recovered.sent, 1);
    assert.equal(recovered.failed, 1);
    assert.equal(recovered.nextSendAt, null);
    assert.equal(recovered.finishedAt?.toISOString(), restartAt.toISOString());
  });

  test("restart preserves a future cursor and delays a cursor that is missing", async () => {
    const first = await createDrafts(1);
    const second = await createDrafts(1);
    const restartAt = new Date("2026-07-29T11:00:00.000Z");
    const futureAt = new Date("2026-07-29T11:20:00.000Z");
    const future = await insert(MailDraftSendBatch, {
      companyId: first.account.companyId,
      accountId: first.account.id,
      status: "queued",
      total: 1,
      sent: 0,
      failed: 0,
      itemsJson: JSON.stringify([
        { draftId: first.drafts[0].id, status: "queued", errorMessage: "" },
      ]),
      nextSendAt: futureAt,
      finishedAt: null,
      createdByUserId: null,
    });
    const missing = await insert(MailDraftSendBatch, {
      companyId: second.account.companyId,
      accountId: second.account.id,
      status: "queued",
      total: 1,
      sent: 0,
      failed: 0,
      itemsJson: JSON.stringify([
        { draftId: second.drafts[0].id, status: "queued", errorMessage: "" },
      ]),
      nextSendAt: null,
      finishedAt: null,
      createdByUserId: null,
    });

    await recoverDraftSendBatches({
      now: () => restartAt,
      delayMs: () => MAX_SEND_DELAY_MS,
    });

    assert.equal(
      (
        await AppDataSource.getRepository(MailDraftSendBatch).findOneByOrFail({ id: future.id })
      ).nextSendAt?.toISOString(),
      futureAt.toISOString(),
    );
    assert.equal(
      (
        await AppDataSource.getRepository(MailDraftSendBatch).findOneByOrFail({ id: missing.id })
      ).nextSendAt?.toISOString(),
      "2026-07-29T11:02:00.000Z",
    );
  });

  test("two processors can never send the same due draft twice", async () => {
    const { account, drafts } = await createDrafts(1);
    const queued = await createDraftSendBatch(account, [drafts[0].id], null, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    let sends = 0;
    const first = processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      sendDraft: async (_account, draft) => {
        sends += 1;
        sendStarted();
        await sendGate;
        return draft;
      },
    });
    await started;

    const second = await processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      sendDraft: async (_account, draft) => {
        sends += 1;
        return draft;
      },
    });
    assert.equal(second, null);
    assert.equal(sends, 1);
    releaseSend();
    assert.equal((await first)?.status, "completed");
    assert.equal(sends, 1);
  });

  test("disconnect fence rejects creators and peers, then clears after callback failure", async () => {
    const { account, drafts } = await createDrafts(1);
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const fenced = withDraftSendDisconnectFence(account.id, async () => {
      callbackStarted();
      await callbackGate;
      throw new Error("delete transaction failed");
    });
    await started;

    await assert.rejects(
      createDraftSendBatch(account, [drafts[0].id], null),
      DraftSendDisconnectBusyError,
    );
    await assert.rejects(
      withDraftSendDisconnectFence(account.id, async () => undefined),
      DraftSendDisconnectBusyError,
    );
    releaseCallback();
    await assert.rejects(fenced, /delete transaction failed/);

    const queued = await createDraftSendBatch(account, [drafts[0].id], null);
    assert.equal(queued.added, 1);
  });

  test("a deleted account fails every remaining queue item without sending", async () => {
    const { account, drafts } = await createDrafts(2);
    const queued = await createDraftSendBatch(
      account,
      drafts.map((draft) => draft.id),
      null,
      {
        now: () => new Date("2026-07-29T10:00:00.000Z"),
        delayMs: () => MIN_SEND_DELAY_MS,
      },
    );
    await AppDataSource.getRepository(MailAccount).delete(account.id);
    let sends = 0;

    const finished = await processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      sendDraft: async (_account, draft) => {
        sends += 1;
        return draft;
      },
    });

    assert.equal(sends, 0);
    assert.equal(finished?.status, "completed_with_errors");
    assert.equal(finished?.failed, 2);
    assert.deepEqual(
      finished?.failures.map((failure) => failure.reason),
      ["The mailbox is no longer connected.", "The mailbox is no longer connected."],
    );
  });

  test("preserves failures for attention while allowing a new queue after completion", async () => {
    const { account, drafts } = await createDrafts(2);
    const first = await createDraftSendBatch(account, [drafts[0].id], null, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    const failed = await processDraftSendBatch(first.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      sendDraft: async () => {
        throw new Error("Mailbox refused this draft");
      },
    });
    assert.equal(failed?.status, "completed_with_errors");
    assert.deepEqual(failed?.failures, [
      { id: drafts[0].id, reason: "Mailbox refused this draft" },
    ]);
    assert.deepEqual([...(await activeDraftQueueIds(account.id))], []);

    const next = await createDraftSendBatch(account, [drafts[1].id], null);
    assert.notEqual(next.batch.id, first.batch.id);
    assert.equal(next.added, 1);
    assert.equal(next.batch.total, 1);
    assert.equal((await getLatestDraftSendBatch(account))?.id, next.batch.id);
    assert.equal((await getLatestDraftSendBatch(account))?.status, "queued");
  });

  test("returns the terminal batch once so the client can collect failures and dismiss progress", async () => {
    const { account, drafts } = await createDrafts(1);
    const queued = await createDraftSendBatch(account, [drafts[0].id], null, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
      delayMs: () => MIN_SEND_DELAY_MS,
    });
    await processDraftSendBatch(queued.batch.id, {
      now: () => new Date("2026-07-29T10:01:00.000Z"),
      sendDraft: async (_account, draft) => draft,
    });

    const latest = await getLatestDraftSendBatch(account);
    assert.equal(latest?.status, "completed");
    assert.equal(latest?.remaining, 0);
    assert.equal(latest?.estimatedCompletionAt, null);
  });
});
