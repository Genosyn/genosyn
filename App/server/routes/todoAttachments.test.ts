import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { projectsRouter } from "./projects.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8YkAAAAASUVORK5CYII=",
  "base64",
);
const originalDataDir = config.dataDir;
let temporaryDataDir = "";
let server: Server;
let baseUrl = "";
let company: Company;
let project: Project;
let todo: Todo;
let writer: User;
let reader: User;
let excluded: User;
let employee: AIEmployee;

type AttachmentDto = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};
type CommentDto = {
  id: string;
  body: string;
  attachments: AttachmentDto[];
  author: { id: string } | null;
};

before(async () => {
  await initTestDb();
  temporaryDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-todo-attachment-routes-"));
  (config as { dataDir: string }).dataDir = temporaryDataDir;
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: unknown }).session = userId ? { userId, sessionVersion: 0 } : {};
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", projectsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(temporaryDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  writer = await insert(User, {
    name: "Writer",
    email: "todo-writer@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  reader = await insert(User, {
    name: "Reader",
    email: "todo-reader@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  excluded = await insert(User, {
    name: "Excluded Member",
    email: "todo-excluded@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Image Discussions",
    slug: `image-discussions-${randomUUID()}`,
    ownerId: writer.id,
  });
  for (const [user, role] of [
    [writer, "owner"],
    [reader, "member"],
    [excluded, "member"],
  ] as const) {
    await insert(Membership, { companyId: company.id, userId: user.id, role });
  }
  project = await insert(Project, {
    companyId: company.id,
    name: "Design",
    slug: "design",
    key: "DES",
    accessMode: "restricted",
    createdById: writer.id,
  });
  await insert(ProjectMember, {
    projectId: project.id,
    memberKind: "user",
    userId: writer.id,
    employeeId: null,
    accessLevel: "write",
  });
  await insert(ProjectMember, {
    projectId: project.id,
    memberKind: "user",
    userId: reader.id,
    employeeId: null,
    accessLevel: "read",
  });
  todo = await insert(Todo, {
    projectId: project.id,
    number: 1,
    title: "Review the pasted screenshot",
    createdById: writer.id,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Designer",
  });
});

async function stage(user = writer, scope = company): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: scope.id,
    companySlug: scope.slug,
    uploadedByUserId: user.id,
    filename: "clipboard.png",
    mimeType: "image/png",
    bytes: PNG,
  });
}

function request(
  method: string,
  suffix: string,
  body?: unknown,
  user: User | null = writer,
  companyId = company.id,
) {
  return fetch(`${baseUrl}/api/companies/${companyId}${suffix}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      connection: "close",
      ...(user ? { "x-test-user": user.id } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function post(body: unknown, user: User | null = writer) {
  return request("POST", `/todos/${todo.id}/comments`, body, user);
}

function download(attachmentId: string, user: User | null = writer, todoId = todo.id) {
  return request("GET", `/todos/${todoId}/comment-attachments/${attachmentId}`, undefined, user);
}

async function bind(image: Attachment): Promise<CommentDto> {
  const response = await post({ body: "", attachmentIds: [image.id] });
  assert.equal(response.status, 200);
  const comments = (await response.json()) as CommentDto[];
  return comments[0];
}

describe("Todo discussion image submissions", () => {
  test("persists an image-only comment and returns the same attachment after reload", async () => {
    const image = await stage();
    const posted = await bind(image);
    assert.equal(posted.body, "");
    assert.equal(posted.author?.id, writer.id);
    assert.deepEqual(posted.attachments, [
      {
        id: image.id,
        filename: "clipboard.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        isImage: true,
      },
    ]);
    const response = await request("GET", `/todos/${todo.id}/comments`);
    assert.equal(response.status, 200);
    const reloaded = (await response.json()) as CommentDto[];
    assert.deepEqual(reloaded[0].attachments, posted.attachments);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: image.id })).messageId,
      posted.id,
    );
  });

  test("accepts image-only payloads with the text field omitted", async () => {
    const image = await stage();
    const response = await post({ attachmentIds: [image.id] });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as CommentDto[])[0].body, "");
  });

  test("keeps text and image ordering together", async () => {
    const images = [await stage(), await stage()];
    const response = await post({
      body: "Compare these layouts",
      attachmentIds: images.map((image) => image.id),
    });
    assert.equal(response.status, 200);
    const [comment] = (await response.json()) as CommentDto[];
    assert.equal(comment.body, "Compare these layouts");
    assert.deepEqual(
      comment.attachments.map((image) => image.id),
      images.map((image) => image.id),
    );
  });

  test("rejects empty text without attachments", async () => {
    assert.equal((await post({ body: "   " })).status, 400);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });

  test("rejects malformed and oversized attachment lists before writing a comment", async () => {
    assert.equal((await post({ body: "Review", attachmentIds: ["bad-id"] })).status, 400);
    assert.equal(
      (await post({ attachmentIds: Array.from({ length: 11 }, () => randomUUID()) })).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });

  test("rejects duplicate IDs without claiming their image", async () => {
    const image = await stage();
    assert.equal((await post({ body: "Review", attachmentIds: [image.id, image.id] })).status, 400);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: image.id })).messageId,
      null,
    );
  });

  test("does not silently drop an unavailable attachment from a mixed list", async () => {
    const image = await stage();
    assert.equal(
      (await post({ body: "Review", attachmentIds: [image.id, randomUUID()] })).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: image.id })).messageId,
      null,
    );
  });

  test("does not move an already-posted image onto a second comment", async () => {
    const image = await stage();
    const original = await bind(image);
    assert.equal((await post({ body: "Again", attachmentIds: [image.id] })).status, 400);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 1);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: image.id })).messageId,
      original.id,
    );
  });
});

describe("Todo image and Project access", () => {
  test("requires the image uploader to be the submitting Member", async () => {
    const image = await stage(reader);
    assert.equal((await post({ attachmentIds: [image.id] })).status, 400);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });

  test("rejects an upload from another company before writing a comment", async () => {
    const other = await insert(Company, {
      name: "Other",
      slug: `other-${randomUUID()}`,
      ownerId: writer.id,
    });
    const image = await stage(writer, other);
    assert.equal((await post({ attachmentIds: [image.id] })).status, 400);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });

  test("a Project reader may see a posted image but cannot submit one", async () => {
    const postedImage = await stage();
    await bind(postedImage);
    assert.equal((await download(postedImage.id, reader)).status, 200);
    const ownImage = await stage(reader);
    assert.equal((await post({ attachmentIds: [ownImage.id] }, reader)).status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: ownImage.id }))
        .messageId,
      null,
    );
  });

  test("a company Member without Project access cannot read or post images", async () => {
    const image = await stage();
    await bind(image);
    assert.equal((await download(image.id, excluded)).status, 403);
    assert.equal(
      (await request("GET", `/todos/${todo.id}/comments`, undefined, excluded)).status,
      403,
    );
    const ownImage = await stage(excluded);
    assert.equal((await post({ attachmentIds: [ownImage.id] }, excluded)).status, 403);
  });

  test("revoking a Member's Project access immediately blocks their uploaded image", async () => {
    await AppDataSource.getRepository(ProjectMember).update(
      { projectId: project.id, userId: reader.id },
      { accessLevel: "write" },
    );
    const image = await stage(reader);
    assert.equal((await post({ attachmentIds: [image.id] }, reader)).status, 200);
    await AppDataSource.getRepository(ProjectMember).delete({
      projectId: project.id,
      userId: reader.id,
    });
    assert.equal((await download(image.id, reader)).status, 403);
  });

  test("an AI mention without Project access leaves the upload and transcript untouched", async () => {
    const image = await stage();
    const response = await post({ attachmentIds: [image.id], mentionEmployeeId: employee.id });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /doesn't have access/);
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
    assert.equal(
      (await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: image.id })).messageId,
      null,
    );
  });

  test("an AI mention from another company is rejected before a comment is created", async () => {
    const image = await stage();
    const otherEmployee = await insert(AIEmployee, {
      companyId: randomUUID(),
      name: "Other",
      slug: "other",
      role: "Designer",
    });
    assert.equal(
      (await post({ attachmentIds: [image.id], mentionEmployeeId: otherEmployee.id })).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(TodoComment).count(), 0);
  });
});

describe("scoped Todo image downloads", () => {
  test("serves the exact PNG bytes inline with content sniffing disabled", async () => {
    const image = await stage();
    await bind(image);
    const response = await download(image.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-type") ?? "", /image\/png/);
    assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });

  test("allows only the uploader to preview an unbound image", async () => {
    const image = await stage();
    assert.equal((await download(image.id)).status, 200);
    assert.equal((await download(image.id, reader)).status, 404);
  });

  test("a file on one Todo cannot be read through a different Todo", async () => {
    const image = await stage();
    await bind(image);
    const sibling = await insert(Todo, {
      projectId: project.id,
      number: 2,
      title: "Another discussion",
      createdById: writer.id,
    });
    assert.equal((await download(image.id, writer, sibling.id)).status, 404);
  });

  test("rejects missing and malformed image IDs", async () => {
    assert.equal((await download(randomUUID())).status, 404);
    assert.equal((await download("invalid")).status, 400);
  });

  test("does not expose image bytes while signed out", async () => {
    const image = await stage();
    await bind(image);
    assert.equal((await download(image.id, null)).status, 401);
  });
});
