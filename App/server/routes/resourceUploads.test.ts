import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Resource } from "../db/entities/Resource.js";
import { ResourceFolder } from "../db/entities/ResourceFolder.js";
import { Tag } from "../db/entities/Tag.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { companyDir } from "../services/paths.js";
import { normalizeTagName } from "../services/tags.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { resourcesRouter } from "./resources.js";

/**
 * An upload to Resources is on disk before the route reads a single field, so
 * every way the route turns one down has to delete it — before it answers.
 * Deleting after the 400 left a moment in which the client could still see
 * the file, which is how `resourceFolders.test.ts` flaked on CI, and refusing
 * a bad tag id deleted nothing at all. Deletes are slowed down here, so a
 * route that answers first is caught every time rather than once in a while.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let other: Company;

const realUnlink = fs.promises.unlink;

before(async () => {
  await initTestDb();
  fs.promises.unlink = (async (...args: Parameters<typeof realUnlink>) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return realUnlink(...args);
  }) as typeof realUnlink;
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", resourcesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  fs.promises.unlink = realUnlink;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: owner.id });
  other = await insert(Company, { name: "Other", slug: `other-${randomUUID()}`, ownerId: owner.id });
  for (const c of [company, other]) {
    await insert(Membership, { companyId: c.id, userId: owner.id, role: "owner" as Role });
  }
  actingUserId = owner.id;
});

afterEach(async () => {
  for (const c of [company, other]) {
    if (c?.slug) await fs.promises.rm(companyDir(c.slug), { recursive: true, force: true });
  }
});

type Uploaded = { id?: string; folderId?: string | null; tags?: Array<{ id: string }>; error?: string };

/** The uploaded files the company keeps on disk. */
function filesOnDisk(): string[] {
  const dir = `${companyDir(company.slug)}/resources`;
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function upload(fields: Record<string, string> = {}): Promise<{ status: number; body: Uploaded }> {
  const form = new FormData();
  form.append("file", new Blob(["# Onboarding\n\nStep one."], { type: "text/markdown" }), "onboarding.md");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/resources/upload`, {
    method: "POST",
    body: form,
  });
  return { status: response.status, body: (await response.json()) as Uploaded };
}

function tagOf(companyId: string, name: string): Promise<Tag> {
  return insert(Tag, { companyId, name, normalizedName: normalizeTagName(name), color: null });
}

test("every refusal deletes the upload before it answers", async () => {
  const theirFolder = await insert(ResourceFolder, {
    companyId: other.id,
    name: "Theirs",
    slug: "theirs",
    parentId: null,
  });
  const theirTag = await tagOf(other.id, "Design");
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["a malformed folder id", { folderId: "not-a-uuid" }, /^Invalid folder id$/],
    ["a folder that doesn't exist", { folderId: randomUUID() }, /does not belong to this company/],
    ["another company's folder", { folderId: theirFolder.id }, /does not belong to this company/],
    ["tag ids that aren't JSON", { tagIds: "[design" }, /^Invalid tag ids$/],
    ["tag ids that aren't ids", { tagIds: JSON.stringify(["design"]) }, /^Invalid tag ids$/],
    ["a tag that doesn't exist", { tagIds: JSON.stringify([randomUUID()]) }, /do not belong to this company/],
    ["another company's tag", { tagIds: JSON.stringify([theirTag.id]) }, /do not belong to this company/],
  ];
  for (const [what, fields, message] of cases) {
    const refused = await upload(fields);
    assert.equal(refused.status, 400, what);
    assert.match(refused.body.error ?? "", message, what);
    assert.deepEqual(filesOnDisk(), [], `${what} left its file behind`);
  }
  assert.equal(await AppDataSource.getRepository(Resource).countBy({ companyId: company.id }), 0);
});

test("an accepted upload keeps its file, filed and tagged as asked", async () => {
  const folder = await insert(ResourceFolder, {
    companyId: company.id,
    name: "Playbooks",
    slug: "playbooks",
    parentId: null,
  });
  const tag = await tagOf(company.id, "Onboarding");

  const accepted = await upload({ folderId: folder.id, tagIds: JSON.stringify([tag.id]) });
  assert.equal(accepted.status, 201, accepted.body.error);
  assert.equal(accepted.body.folderId, folder.id);
  assert.deepEqual(
    accepted.body.tags?.map((t) => t.id),
    [tag.id],
  );
  const row = await AppDataSource.getRepository(Resource).findOneByOrFail({ id: accepted.body.id });
  assert.deepEqual(filesOnDisk(), [row.storageKey]);
});

test("an upload whose row can't be saved takes its file with it", async () => {
  const repo = AppDataSource.getRepository(Resource);
  const save = repo.save;
  repo.save = (async () => {
    throw new Error("the database went away");
  }) as typeof repo.save;
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const failed = await upload();
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error, "Internal server error");
  } finally {
    repo.save = save;
    console.error = quiet;
  }
  assert.deepEqual(filesOnDisk(), []);
});
