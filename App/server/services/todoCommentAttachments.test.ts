import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, beforeEach, after, describe, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { initTestDb, resetTestDb, closeTestDb, insert } from "../test/dbHarness.js";
import { recordAttachmentBytes } from "./uploads.js";
import {
  createTodoDiscussionComment,
  composeTodoMentionContext,
  todoCommentAttachments,
  todoDiscussionHistory,
  resolveTodoCommentAttachment,
} from "./todoCommentAttachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);
let company: Company;
let member: User;
let dataDir: string;
const originalDataDir = config.dataDir;
before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-todo-attachments-"));
  (config as { dataDir: string }).dataDir = dataDir;
});
after(async () => {
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, { email: "member@example.test", name: "Member", passwordHash: "x" });
  company = await insert(Company, { slug: "todo-company", name: "Company", ownerId: member.id });
});

function upload(overrides: Partial<Parameters<typeof recordAttachmentBytes>[0]> = {}) {
  return recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    uploadedByUserId: member.id,
    filename: "screenshot.png",
    mimeType: "image/png",
    bytes: png,
    ...overrides,
  });
}
function create(attachmentIds: string[], body = "", mentionEmployeeId: string | null = null) {
  return createTodoDiscussionComment({
    companyId: company.id,
    todoId: "todo",
    userId: member.id,
    body,
    attachmentIds,
    mentionEmployeeId,
  });
}
function readThread() {
  return AppDataSource.getRepository(TodoComment).find({
    where: { todoId: "todo" },
    order: { createdAt: "ASC" },
  });
}

describe("Todo discussion attachments", () => {
  test("persists an image-only comment, pending reply and safe metadata together", async () => {
    const attachment = await upload();
    const { human, pending } = await create([attachment.id], "", "employee");
    assert.equal(human.body, "");
    assert.equal(pending?.pending, true);
    assert.equal(pending?.authorEmployeeId, "employee");
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: attachment.id }))
        .messageId,
      human.id,
    );
    assert.deepEqual((await todoCommentAttachments(company.id, [human.id])).get(human.id), [
      {
        id: attachment.id,
        filename: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: png.length,
        isImage: true,
      },
    ]);
  });

  test("does not start an employee for an ordinary image comment", async () => {
    const attachment = await upload();
    const result = await create([attachment.id]);
    assert.equal(result.pending, null);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 1);
  });

  for (const invalid of ["company", "member", "missing", "bound", "ai"] as const) {
    test(`refuses ${invalid} attachments and rolls back comment, reply and valid claims`, async () => {
      const valid = await upload();
      const attachment = await upload({
        ...(invalid === "company" ? { companyId: "another-company" } : {}),
        ...(invalid === "member" ? { uploadedByUserId: "another-member" } : {}),
        ...(invalid === "ai" ? { uploadedByUserId: null } : {}),
      });
      if (invalid === "bound")
        await AppDataSource.getRepository(Attachment).update(
          { id: attachment.id },
          { messageId: "existing-comment" },
        );
      await assert.rejects(
        create(
          [valid.id, invalid === "missing" ? "missing" : attachment.id],
          "Review these",
          "employee",
        ),
        /attachments are unavailable/,
      );
      assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
      assert.equal(
        (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: valid.id })).messageId,
        null,
      );
    });
  }

  test("validates emptiness, duplicate IDs, count and unauthenticated upload claims", async () => {
    const attachment = await upload();
    await assert.rejects(create([], " \n"), /comment or attach/);
    await assert.rejects(create([attachment.id, attachment.id]), /different files/);
    await assert.rejects(create(Array(11).fill(attachment.id)), /at most 10/);
    await assert.rejects(
      createTodoDiscussionComment({
        companyId: company.id,
        todoId: "todo",
        userId: null,
        body: "",
        attachmentIds: [attachment.id],
      }),
      /different files/,
    );
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });

  test("simultaneous submissions can claim each upload only once", async () => {
    const attachment = await upload();
    const results = await Promise.allSettled([create([attachment.id]), create([attachment.id])]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 1);
  });

  test("freezes current images and history at the accepting Member comment", async () => {
    const firstImage = await upload({ filename: "earlier.png" });
    const first = await create([firstImage.id], "Earlier reference");
    await insert(TodoComment, {
      todoId: "todo",
      authorEmployeeId: "employee",
      authorUserId: null,
      body: "I reviewed it",
      pending: false,
    });
    const image = await upload();
    const text = await upload({
      filename: "spec.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("Button must say Save"),
    });
    const current = await create([image.id, text.id], "", "employee");
    const laterImage = await upload({ filename: "later.png" });
    await create([laterImage.id], "Later request must stay out");
    const turn = await composeTodoMentionContext({
      companyId: company.id,
      comments: await readThread(),
      triggerCommentId: current.human.id,
      requesterUserId: member.id,
      employeeId: "employee",
    });
    assert.ok(turn);
    assert.match(turn.message, /screenshot\.png/);
    assert.match(turn.message, /Button must say Save/);
    assert.equal(turn.images?.length, 1);
    assert.equal(turn.images?.[0].data, png.toString("base64"));
    assert.match(turn.images?.[0].sourceLabel ?? "", new RegExp(image.id));
    assert.equal(turn.history.length, 2);
    assert.equal(turn.history[0].role, "user");
    assert.match(turn.history[0].content, /Earlier reference/);
    assert.match(turn.history[0].images?.[0].sourceLabel ?? "", new RegExp(firstImage.id));
    assert.equal(turn.history[1].role, "assistant");
    assert.equal(turn.history[1].content, "I reviewed it");
    assert.equal(JSON.stringify(turn).includes(laterImage.id), false);
    assert.ok(first.human.id);
  });

  test("a missing or different-Member trigger cannot supply image inputs", async () => {
    const image = await upload();
    const current = await create([image.id]);
    for (const [triggerCommentId, requesterUserId] of [
      ["missing", member.id],
      [current.human.id, "another-member"],
    ]) {
      assert.equal(
        await composeTodoMentionContext({
          companyId: company.id,
          comments: await readThread(),
          triggerCommentId,
          requesterUserId,
          employeeId: "employee",
        }),
        null,
      );
    }
  });

  test("assignment and review replay comment images and exclude pending placeholders", async () => {
    const image = await upload();
    const { pending } = await create([image.id], "Review this", "employee");
    const history = await todoDiscussionHistory(company.id, "todo", "employee", pending!.id);
    assert.equal(history.length, 1);
    assert.match(history[0].content, new RegExp(image.id));
    assert.equal(history[0].images?.[0].data, png.toString("base64"));
  });

  test("foreign-company metadata and image bytes are never hydrated", async () => {
    const { human } = await create([], "Hello");
    const image = await upload({ companyId: "another-company" });
    await AppDataSource.getRepository(Attachment).update({ id: image.id }, { messageId: human.id });
    assert.equal((await todoCommentAttachments(company.id, [human.id])).size, 0);
    const history = await todoDiscussionHistory(company.id, "todo", "employee", "pending");
    assert.deepEqual(history, [{ role: "user", content: "Hello" }]);
  });

  test("download resolution allows own drafts and images bound to this Todo only", async () => {
    const image = await upload();
    assert.ok(await resolveTodoCommentAttachment(company.id, "todo", member.id, image.id));
    assert.equal(
      await resolveTodoCommentAttachment(company.id, "todo", "other-member", image.id),
      null,
    );
    const { human } = await create([image.id]);
    assert.ok(await resolveTodoCommentAttachment(company.id, "todo", "other-member", image.id));
    assert.equal(
      await resolveTodoCommentAttachment(company.id, "other-todo", member.id, image.id),
      null,
    );
    await AppDataSource.getRepository(TodoComment).delete({ id: human.id });
    assert.equal(await resolveTodoCommentAttachment(company.id, "todo", member.id, image.id), null);
  });

  test("missing image bytes leave an honest text reference without breaking the AI context", async () => {
    const image = await upload();
    const { human } = await create([image.id]);
    fs.rmSync(path.join(dataDir, "companies", company.slug, "attachments", image.storageKey));
    const turn = await composeTodoMentionContext({
      companyId: company.id,
      comments: await readThread(),
      triggerCommentId: human.id,
      requesterUserId: member.id,
      employeeId: "employee",
    });
    assert.match(turn?.message ?? "", /File missing/);
    assert.equal(turn?.images, undefined);
  });
});
