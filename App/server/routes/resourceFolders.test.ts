import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Resource } from "../db/entities/Resource.js";
import { ResourceFolder } from "../db/entities/ResourceFolder.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { companyDir } from "../services/paths.js";
import { RESOURCE_FOLDER_MAX_DEPTH } from "../services/resourceFolders.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { resourceFoldersRouter } from "./resourceFolders.js";
import { resourcesRouter } from "./resources.js";

/**
 * The Resources library as files and folders, over HTTP: the folder tree
 * (create, rename, move, delete), filing Resources into it from every way one
 * is added or edited, and the rules that keep the tree navigable — no cycles,
 * a depth cap, no two same-named siblings, and a delete that never takes what
 * was filed inside it.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let other: Company;
let member: User;

before(async () => {
  await initTestDb();
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
  app.use("/api/companies/:cid", resourceFoldersRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
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
  member = await insert(User, {
    email: `member-${randomUUID()}@example.com`,
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: owner.id,
  });
  other = await insert(Company, {
    name: "Other",
    slug: `other-${randomUUID()}`,
    ownerId: owner.id,
  });
  for (const c of [company, other]) {
    await insert(Membership, { companyId: c.id, userId: owner.id, role: "owner" as Role });
  }
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  // Any Member files the library, exactly as any Member edits the Resources in it.
  actingUserId = member.id;
});

afterEach(async () => {
  for (const c of [company, other]) {
    if (c?.slug) await fs.promises.rm(companyDir(c.slug), { recursive: true, force: true });
  }
});

type Folder = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string;
  depth: number;
  resourceCount: number;
  totalResourceCount: number;
  error?: string;
};
type Tree = { folders: Folder[]; unfiledCount: number; maxDepth: number };
type Hydrated = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  folderId: string | null;
  folderPath: string | null;
  error?: string;
};

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T & { error?: string } };
}

async function makeFolder(name: string, parentId: string | null = null): Promise<Folder> {
  const created = await call<Folder>("POST", "/resource-folders", { name, parentId });
  assert.equal(created.status, 201, created.body.error);
  return created.body;
}

async function tree(companyId = company.id): Promise<Tree> {
  const response = await call<Tree>("GET", "/resource-folders", undefined, companyId);
  assert.equal(response.status, 200);
  return response.body;
}

let counter = 0;
async function seedResource(folderId: string | null = null, companyId = company.id) {
  counter += 1;
  return insert(Resource, {
    companyId,
    title: `Guide ${counter}`,
    slug: `guide-${counter}`,
    sourceKind: "text",
    summary: "",
    bodyText: "Body",
    tags: "",
    bytes: 4,
    status: "ready",
    errorMessage: "",
    createdById: null,
    createdByEmployeeId: null,
    folderId,
  });
}

async function storedFolderId(resourceId: string): Promise<string | null> {
  return (await AppDataSource.getRepository(Resource).findOneByOrFail({ id: resourceId })).folderId;
}

describe("the folder tree", () => {
  test("starts empty, with everything unfiled", async () => {
    await seedResource();
    assert.deepEqual(await tree(), {
      folders: [],
      unfiledCount: 1,
      maxDepth: RESOURCE_FOLDER_MAX_DEPTH,
    });
  });

  test("nests folders and reports each one's path, depth, and counts", async () => {
    const research = await makeFolder("Research");
    const competitors = await makeFolder("Competitors", research.id);
    const pricing = await makeFolder("Pricing", competitors.id);
    await seedResource(research.id);
    await seedResource(competitors.id);
    await seedResource(competitors.id);
    await seedResource(pricing.id);
    await seedResource(null);

    const { folders, unfiledCount } = await tree();
    const byName = new Map(folders.map((f) => [f.name, f]));
    assert.equal(unfiledCount, 1);
    assert.deepEqual(
      ["Research", "Competitors", "Pricing"].map((name) => {
        const f = byName.get(name)!;
        return [f.path, f.depth, f.resourceCount, f.totalResourceCount];
      }),
      [
        ["Research", 1, 1, 4],
        ["Research/Competitors", 2, 2, 3],
        ["Research/Competitors/Pricing", 3, 1, 1],
      ],
    );
  });

  test("strips path separators from names, so a name can never read as two folders", async () => {
    const folder = await makeFolder("  Ops /  Support  ");
    assert.equal(folder.name, "Ops Support");
    assert.equal(folder.slug, "ops-support");
  });

  test("refuses a blank name, a duplicate sibling in any case, and a nesting past the cap", async () => {
    const top = await makeFolder("Research");
    assert.equal((await call("POST", "/resource-folders", { name: " / " })).status, 400);
    const dup = await call<Folder>("POST", "/resource-folders", { name: "research" });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error ?? "", /already here/);
    // The same name under a different parent is a different place.
    await makeFolder("Research", top.id);

    let parent = top;
    for (let depth = 2; depth <= RESOURCE_FOLDER_MAX_DEPTH; depth += 1) {
      parent = await makeFolder(`Level ${depth}`, parent.id);
    }
    const tooDeep = await call<Folder>("POST", "/resource-folders", {
      name: "One too many",
      parentId: parent.id,
    });
    assert.equal(tooDeep.status, 400);
    assert.match(tooDeep.body.error ?? "", /nest 5 levels/);
  });

  test("gives every folder a company-unique slug that never takes the Unfiled view's", async () => {
    const research = await makeFolder("Research");
    const nested = await makeFolder("Research", research.id);
    const unfiled = await makeFolder("Unfiled");
    assert.equal(research.slug, "research");
    assert.equal(nested.slug, "research-2");
    assert.notEqual(unfiled.slug, "unfiled");
  });

  test("renames without moving the address, and moves within the tree", async () => {
    const research = await makeFolder("Research");
    const archive = await makeFolder("Archive");
    const renamed = await call<Folder>("PATCH", `/resource-folders/${research.id}`, {
      name: "Market research",
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Market research");
    assert.equal(renamed.body.slug, "research", "a bookmarked ?folder= keeps working");

    const moved = await call<Folder>("PATCH", `/resource-folders/${research.id}`, {
      parentId: archive.id,
    });
    assert.equal(moved.status, 200);
    const after = (await tree()).folders.find((f) => f.id === research.id)!;
    assert.equal(after.path, "Archive/Market research");

    const backToTop = await call<Folder>("PATCH", `/resource-folders/${research.id}`, {
      parentId: null,
    });
    assert.equal(backToTop.status, 200);
    assert.equal(backToTop.body.parentId, null);
  });

  test("refuses a move that would make a cycle or overflow the depth cap", async () => {
    const a = await makeFolder("A");
    const b = await makeFolder("B", a.id);
    const c = await makeFolder("C", b.id);
    for (const parentId of [a.id, b.id, c.id]) {
      const refused = await call<Folder>("PATCH", `/resource-folders/${a.id}`, { parentId });
      assert.equal(refused.status, 400, `moving A under ${parentId}`);
      assert.match(refused.body.error ?? "", /inside itself/);
    }
    // A three-deep chain under a three-deep chain would be six levels.
    const x = await makeFolder("X");
    const y = await makeFolder("Y", x.id);
    const z = await makeFolder("Z", y.id);
    const overflow = await call<Folder>("PATCH", `/resource-folders/${a.id}`, { parentId: z.id });
    assert.equal(overflow.status, 400);
    assert.match(overflow.body.error ?? "", /nest 5 levels/);
    assert.equal((await tree()).folders.find((f) => f.id === a.id)?.parentId, null);
  });

  test("refuses a move or rename onto a same-named sibling", async () => {
    const research = await makeFolder("Research");
    const inbox = await makeFolder("Inbox");
    await makeFolder("Notes", research.id);
    const notes = await makeFolder("Notes", inbox.id);
    const clash = await call<Folder>("PATCH", `/resource-folders/${notes.id}`, {
      parentId: research.id,
    });
    assert.equal(clash.status, 400);
    const renameClash = await call<Folder>("PATCH", `/resource-folders/${inbox.id}`, {
      name: "RESEARCH",
    });
    assert.equal(renameClash.status, 400);
  });

  test("deleting a folder moves its Resources and subfolders up, and deletes nothing filed", async () => {
    const research = await makeFolder("Research");
    const competitors = await makeFolder("Competitors", research.id);
    const pricing = await makeFolder("Pricing", competitors.id);
    // A sibling already named like the promoted child: the newcomer is suffixed.
    await makeFolder("Pricing", research.id);
    const filed = await seedResource(competitors.id);
    const deeper = await seedResource(pricing.id);

    const removed = await call<{
      ok: boolean;
      movedResources: number;
      movedFolders: number;
      promotedTo: string | null;
    }>("DELETE", `/resource-folders/${competitors.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(
      [removed.body.movedResources, removed.body.movedFolders, removed.body.promotedTo],
      [1, 1, research.id],
    );
    assert.equal(await storedFolderId(filed.id), research.id);
    assert.equal(await storedFolderId(deeper.id), pricing.id);
    const promoted = (await tree()).folders.find((f) => f.id === pricing.id)!;
    assert.equal(promoted.parentId, research.id);
    assert.equal(promoted.name, "Pricing (2)");
    assert.equal(await AppDataSource.getRepository(Resource).count(), 2);

    // A top-level folder's Resources land in Unfiled.
    await call("DELETE", `/resource-folders/${research.id}`);
    assert.equal(await storedFolderId(filed.id), null);
    assert.equal((await tree()).unfiledCount, 1);
  });

  test("keeps each company's tree to itself", async () => {
    const mine = await makeFolder("Research");
    actingUserId = company.ownerId;
    const theirs = await call<Folder>(
      "POST",
      "/resource-folders",
      { name: "Research" },
      other.id,
    );
    assert.equal(theirs.status, 201);
    assert.deepEqual(
      (await tree(other.id)).folders.map((f) => f.id),
      [theirs.body.id],
    );
    // Another company's folder id is not found here, for an edit or a delete.
    assert.equal(
      (await call("PATCH", `/resource-folders/${mine.id}`, { name: "x" }, other.id)).status,
      404,
    );
    assert.equal((await call("DELETE", `/resource-folders/${mine.id}`, undefined, other.id)).status, 404);
    // Nor can a folder be nested under another company's folder.
    const crossParent = await call<Folder>(
      "POST",
      "/resource-folders",
      { name: "Sneaky", parentId: mine.id },
      other.id,
    );
    assert.equal(crossParent.status, 400);
  });

  test("records every change to the tree in the audit log", async () => {
    const research = await makeFolder("Research");
    await call("PATCH", `/resource-folders/${research.id}`, { name: "Reading" });
    await call("DELETE", `/resource-folders/${research.id}`);
    const actions = (
      await AppDataSource.getRepository(AuditEvent).find({
        where: { companyId: company.id, targetId: research.id },
        order: { createdAt: "ASC" },
      })
    ).map((row) => [row.action, row.actorUserId]);
    assert.deepEqual(actions, [
      ["resource.folder.create", member.id],
      ["resource.folder.update", member.id],
      ["resource.folder.delete", member.id],
    ]);
  });

  test("validates ids and bodies at the boundary", async () => {
    assert.equal((await call("POST", "/resource-folders", { name: "x", parentId: "nope" })).status, 400);
    assert.equal((await call("POST", "/resource-folders", { name: "x", extra: 1 })).status, 400);
    assert.equal((await call("PATCH", "/resource-folders/not-a-uuid", { name: "x" })).status, 400);
    const folder = await makeFolder("Research");
    assert.equal((await call("PATCH", `/resource-folders/${folder.id}`, {})).status, 400);
    assert.equal(
      (await call("PATCH", `/resource-folders/${randomUUID()}`, { name: "Ghost" })).status,
      404,
    );
  });

  test("is closed to someone outside the company", async () => {
    const outsider = await insert(User, {
      email: `outsider-${randomUUID()}@example.com`,
      name: "Outsider",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    assert.equal((await call("GET", "/resource-folders")).status, 403);
    assert.equal((await call("POST", "/resource-folders", { name: "Mine" })).status, 403);
    assert.equal(await AppDataSource.getRepository(ResourceFolder).count(), 0);
  });
});

describe("filing Resources", () => {
  test("files a pasted Markdown Resource where it is created and says where", async () => {
    const research = await makeFolder("Research");
    const competitors = await makeFolder("Competitors", research.id);
    const created = await call<Hydrated>("POST", "/resources", {
      sourceKind: "text",
      title: "Battlecard",
      body: "# Acme vs. Initech\n\n**Acme** wins on [price](https://example.com).\n\n- Fast\n- Cheap",
      folderId: competitors.id,
    });
    assert.equal(created.status, 201, created.body.error);
    assert.equal(created.body.folderId, competitors.id);
    assert.equal(created.body.folderPath, "Research/Competitors");
    // The preview is read without the Markdown syntax.
    assert.equal(created.body.summary, "Acme vs. Initech Acme wins on price. Fast Cheap");

    const listed = await call<Hydrated[]>("GET", "/resources");
    assert.equal(listed.body[0].folderPath, "Research/Competitors");
    const detail = await call<Hydrated>("GET", `/resources/${created.body.slug}`);
    assert.equal(detail.body.folderPath, "Research/Competitors");
  });

  test("leaves a Resource unfiled when no folder is named", async () => {
    const created = await call<Hydrated>("POST", "/resources", {
      sourceKind: "text",
      title: "Loose note",
      body: "Body",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.folderId, null);
    assert.equal(created.body.folderPath, null);
  });

  test("refuses another company's folder, or one that does not exist, and creates nothing", async () => {
    actingUserId = company.ownerId;
    const theirs = await call<Folder>("POST", "/resource-folders", { name: "Theirs" }, other.id);
    for (const folderId of [theirs.body.id, randomUUID()]) {
      const refused = await call<Hydrated>("POST", "/resources", {
        sourceKind: "text",
        title: "Misfiled",
        body: "Body",
        folderId,
      });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error ?? "", /does not belong to this company/);
    }
    assert.equal(await AppDataSource.getRepository(Resource).countBy({ companyId: company.id }), 0);
  });

  test("files an upload where it is dropped, and refuses a bad folder without keeping the bytes", async () => {
    const playbooks = await makeFolder("Playbooks");
    const upload = async (folderId: string | null) => {
      const form = new FormData();
      form.append("file", new Blob(["# Onboarding\n\nStep one."], { type: "text/markdown" }), "onboarding.md");
      if (folderId !== null) form.append("folderId", folderId);
      const response = await fetch(`${baseUrl}/api/companies/${company.id}/resources/upload`, {
        method: "POST",
        body: form,
      });
      return { status: response.status, body: (await response.json()) as Hydrated };
    };

    const filed = await upload(playbooks.id);
    assert.equal(filed.status, 201, filed.body.error);
    assert.equal(filed.body.folderId, playbooks.id);
    assert.equal(filed.body.folderPath, "Playbooks");
    // An uploaded .md file is a text Resource, so its preview reads as text too.
    assert.equal(filed.body.summary, "Onboarding Step one.");

    const resourcesDir = `${companyDir(company.slug)}/resources`;
    const filesBefore = fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir).length : 0;
    for (const bad of ["not-a-uuid", randomUUID()]) {
      const refused = await upload(bad);
      assert.equal(refused.status, 400);
    }
    const filesAfter = fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir).length : 0;
    assert.equal(filesAfter, filesBefore, "a refused upload leaves no file behind");
    assert.equal(await AppDataSource.getRepository(Resource).countBy({ companyId: company.id }), 1);
  });

  test("moves a Resource between folders and back to Unfiled", async () => {
    const research = await makeFolder("Research");
    const archive = await makeFolder("Archive");
    const resource = await seedResource(research.id);

    const moved = await call<Hydrated>("PATCH", `/resources/${resource.slug}`, {
      folderId: archive.id,
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.folderPath, "Archive");
    assert.equal(await storedFolderId(resource.id), archive.id);

    const unfiled = await call<Hydrated>("PATCH", `/resources/${resource.slug}`, { folderId: null });
    assert.equal(unfiled.status, 200);
    assert.equal(unfiled.body.folderPath, null);
    assert.equal(await storedFolderId(resource.id), null);

    // Leaving folderId out leaves the folder alone.
    await call("PATCH", `/resources/${resource.slug}`, { folderId: archive.id });
    await call("PATCH", `/resources/${resource.slug}`, { title: "Renamed" });
    assert.equal(await storedFolderId(resource.id), archive.id);

    const audit = await AppDataSource.getRepository(AuditEvent).findOneBy({
      companyId: company.id,
      action: "resource.update",
      targetId: resource.id,
    });
    assert.ok(audit, "a move is recorded like any other edit");
  });

  test("refuses to move a Resource into another company's folder", async () => {
    actingUserId = company.ownerId;
    const theirs = await call<Folder>("POST", "/resource-folders", { name: "Theirs" }, other.id);
    const resource = await seedResource(null);
    const refused = await call<Hydrated>("PATCH", `/resources/${resource.slug}`, {
      folderId: theirs.body.id,
    });
    assert.equal(refused.status, 400);
    assert.equal(await storedFolderId(resource.id), null);
  });

  test("regenerates a Markdown body's preview as plain text when the body is edited", async () => {
    const created = await call<Hydrated>("POST", "/resources", {
      sourceKind: "text",
      title: "Notes",
      body: "First draft",
    });
    const edited = await call<Hydrated>("PATCH", `/resources/${created.body.slug}`, {
      body: "## Update\n\nShipped `v2` with *care*.",
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.summary, "Update Shipped v2 with care.");
  });
});
