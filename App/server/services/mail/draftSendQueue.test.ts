import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  DraftSendAlreadyRunningError,
  MAX_SEND_DELAY_MS,
  MIN_SEND_DELAY_MS,
  activeDraftQueueIds,
  createDraftSendBatch,
  processDraftSendBatch,
  randomSendDelayMs,
} from "./draftSendQueue.js";
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
    connectionId: "connection_draft_send_queue_test",
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

  test("processes one draft per due time and schedules the next from completion", async () => {
    const { account, drafts } = await createDrafts(2);
    const createdAt = new Date("2026-07-29T10:00:00.000Z");
    const batch = await createDraftSendBatch(
      account,
      drafts.map((draft) => draft.id),
      null,
      { now: () => createdAt, delayMs: () => MIN_SEND_DELAY_MS },
    );
    assert.equal(batch.nextSendAt, "2026-07-29T10:01:00.000Z");
    assert.deepEqual(
      [...(await activeDraftQueueIds(account.id))].sort(),
      drafts.map((draft) => draft.id).sort(),
    );
    const list = await listDrafts(account, { filter: {}, offset: 0, limit: 100 });
    assert.deepEqual(list.totals, {
      total: 2,
      sendable: 0,
      missingRecipient: 0,
      queued: 2,
    });
    assert.ok(list.drafts.every((draft) => draft.queuedForSend));
    const preview = await previewDraftSend(account, { ids: drafts.map((draft) => draft.id) });
    assert.equal(preview.sendable, 0);
    assert.equal(preview.alreadyQueued, 2);

    await assert.rejects(
      () =>
        createDraftSendBatch(
          account,
          drafts.map((draft) => draft.id),
          null,
        ),
      DraftSendAlreadyRunningError,
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
    assert.equal(sentIds.length, 1);

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
    assert.equal(sentIds.length, 2);
  });
});
