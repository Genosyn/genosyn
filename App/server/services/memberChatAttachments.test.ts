import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { Attachment } from "../db/entities/Attachment.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  claimMemberChatAttachments,
  MemberChatAttachmentError,
  prepareMemberChatAttachmentContext,
  serializeChatAttachment,
  validateMemberChatAttachments,
} from "./memberChatAttachments.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);
const companyId = randomUUID();
const userId = randomUUID();
async function upload(values: Partial<Attachment> = {}) {
  return insert(Attachment, {
    companyId,
    uploadedByUserId: userId,
    messageId: null,
    filename: "clipboard.png",
    mimeType: "image/png",
    sizeBytes: 10,
    storageKey: `${randomUUID()}.png`,
    ...values,
  });
}

describe("Member attachment ownership and consumption", () => {
  test("an empty list requires no upload or Member", async () =>
    assert.deepEqual(await claimMemberChatAttachments(companyId, null, []), []));
  test("preserves the Member's attachment ordering", async () => {
    const first = await upload();
    const second = await upload();
    assert.deepEqual(
      (await validateMemberChatAttachments(companyId, userId, [second.id, first.id])).map(
        (row) => row.id,
      ),
      [second.id, first.id],
    );
  });
  test("claims every uploaded image on one message", async () => {
    const rows = await Promise.all([upload(), upload()]);
    const messageId = randomUUID();
    await claimMemberChatAttachments(
      companyId,
      userId,
      rows.map((row) => row.id),
      messageId,
    );
    assert.ok(
      (await AppDataSource.getRepository(Attachment).find()).every(
        (row) => row.messageId === messageId,
      ),
    );
  });
  test("cannot attach another Member's upload", async () => {
    const row = await upload({ uploadedByUserId: randomUUID() });
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id]),
      MemberChatAttachmentError,
    );
  });
  test("cannot attach an upload from another company", async () => {
    const row = await upload({ companyId: randomUUID() });
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id]),
      MemberChatAttachmentError,
    );
  });
  test("cannot attach an employee-produced file as an unsent Member upload", async () => {
    const row = await upload({ uploadedByUserId: null });
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id]),
      MemberChatAttachmentError,
    );
  });
  test("does not rebind files already on a message", async () => {
    const original = randomUUID();
    const row = await upload({ messageId: original });
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id]),
      MemberChatAttachmentError,
    );
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: row.id })).messageId,
      original,
    );
  });
  test("one unavailable file leaves all valid uploads staged", async () => {
    const row = await upload();
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id, randomUUID()]),
      MemberChatAttachmentError,
    );
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: row.id })).messageId,
      null,
    );
  });
  test("rejects duplicate IDs", async () => {
    const row = await upload();
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, userId, [row.id, row.id]),
      /different files/,
    );
  });
  test("requires a Member for uploaded inputs", async () => {
    const row = await upload();
    await assert.rejects(
      () => claimMemberChatAttachments(companyId, null, [row.id]),
      MemberChatAttachmentError,
    );
  });
  test("rejects batches exceeding ten attachments", async () => {
    await assert.rejects(
      () =>
        claimMemberChatAttachments(
          companyId,
          userId,
          Array.from({ length: 11 }, () => randomUUID()),
        ),
      /at most 10/,
    );
  });
  test("concurrent claims have one winner and preserve the winning message", async () => {
    const row = await upload();
    const ids = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      ids.map((messageId) => claimMemberChatAttachments(companyId, userId, [row.id], messageId)),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: row.id })).messageId,
      ids[winner],
    );
  });
  test("serializes image metadata without disclosing storage paths", async () => {
    const row = await upload();
    const summary = serializeChatAttachment(row);
    assert.deepEqual(
      Object.keys(summary).sort(),
      ["filename", "id", "isImage", "mimeType", "sizeBytes"].sort(),
    );
    assert.equal(summary.isImage, true);
    assert.equal(summary.sizeBytes, 10);
  });
});

describe("one-shot Base input retries", () => {
  test("holds files while building context and releases them for retry", async () => {
    const row = await upload();
    const context = await prepareMemberChatAttachmentContext({ companyId, userId, ids: [row.id] });
    assert.ok(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: row.id })).messageId,
    );
    await context.release();
    assert.equal((await validateMemberChatAttachments(companyId, userId, [row.id]))[0].id, row.id);
  });
  test("releasing a context twice does not affect another message's later claim", async () => {
    const row = await upload();
    const context = await prepareMemberChatAttachmentContext({ companyId, userId, ids: [row.id] });
    await context.release();
    const laterMessageId = randomUUID();
    await claimMemberChatAttachments(companyId, userId, [row.id], laterMessageId);
    await context.release();
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: row.id })).messageId,
      laterMessageId,
    );
  });
});
