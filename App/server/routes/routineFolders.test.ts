import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineFolder } from "../db/entities/RoutineFolder.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { errorHandler } from "../middleware/error.js";
import { registerResourceChangeSink } from "../services/resourceEvents.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { routineFoldersRouter } from "./routineFolders.js";
import { routinesRouter } from "./routines.js";

/**
 * The folder endpoints over real HTTP, including the authorization gates.
 *
 * `services/routineFolders.test.ts` covers the tree invariants; this covers the
 * boundary — that mutations are admin-only, that a member of another company
 * cannot reach these rows, and that `POST /routines/move` checks every id
 * before it writes any of them.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", routinesRouter);
  app.use("/api/companies/:cid", routineFoldersRouter);
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

async function member(email: string, role: Role, companyId: string): Promise<User> {
  const user = await insert(User, {
    email,
    name: email,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await member("owner@example.com", "owner" as Role, company.id);
  viewer = await member("viewer@example.com", "member" as Role, company.id);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function addRoutine(name: string, folderId: string | null = null): Promise<Routine> {
  return insert(Routine, {
    employeeId: employee.id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    cronExpr: "0 9 * * *",
    enabled: true,
    folderId,
    body: "",
  });
}

type FolderRow = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string;
  depth: number;
  routineCount: number;
  totalRoutineCount: number;
};
type TreeBody = { folders: FolderRow[]; unfiledCount: number; maxDepth: number };

describe("GET /routine-folders", () => {
  test("returns the flat tree, unfiled count, and the nesting limit", async () => {
    const finance = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    await call("POST", "/routine-folders", {
      name: "Month-end",
      parentId: finance.body.id,
    });
    await addRoutine("Loose end");

    const { status, body } = await call<TreeBody>("GET", "/routine-folders");
    assert.equal(status, 200);
    assert.equal(body.folders.length, 2);
    assert.equal(body.unfiledCount, 1);
    assert.equal(body.maxDepth, 5);
    assert.deepEqual(
      body.folders.map((f) => `${f.path}@${f.depth}`).sort(),
      ["Finance/Month-end@2", "Finance@1"],
    );
  });

  test("an ordinary member can read the tree", async () => {
    await call("POST", "/routine-folders", { name: "Finance" });
    actingUserId = viewer.id;
    const { status, body } = await call<TreeBody>("GET", "/routine-folders");
    assert.equal(status, 200);
    assert.equal(body.folders.length, 1);
  });
});

describe("folder mutations are admin-gated", () => {
  test("an ordinary member cannot create, patch, or delete", async () => {
    const created = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    actingUserId = viewer.id;

    assert.equal((await call("POST", "/routine-folders", { name: "Nope" })).status, 403);
    assert.equal(
      (await call("PATCH", `/routine-folders/${created.body.id}`, { name: "Nope" })).status,
      403,
    );
    assert.equal((await call("DELETE", `/routine-folders/${created.body.id}`)).status, 403);
  });
});

describe("path-case cannot slip past the admin gate", () => {
  test("an uppercased path is still refused for a non-admin", async () => {
    actingUserId = viewer.id;
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/ROUTINE-FOLDERS`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Sneaky" }),
      },
    );
    assert.notEqual(response.status, 200);
    const count = await AppDataSource.getRepository(RoutineFolder).count();
    assert.equal(count, 0, "no folder should exist after a refused create");
  });
});

describe("POST /routine-folders", () => {
  test("rejects a duplicate sibling name with a 400 rather than a 500", async () => {
    await call("POST", "/routine-folders", { name: "Finance" });
    const { status, body } = await call<{ error: string }>("POST", "/routine-folders", {
      name: "finance",
    });
    assert.equal(status, 400);
    assert.match(body.error, /already here/i);
  });

  test("rejects a non-uuid parent at the schema boundary", async () => {
    const { status } = await call("POST", "/routine-folders", {
      name: "Finance",
      parentId: "not-a-uuid",
    });
    assert.equal(status, 400);
  });
});

describe("PATCH /routine-folders/:fid", () => {
  test("moving a folder into its own descendant is a 400, not a corrupted tree", async () => {
    const root = await call<FolderRow>("POST", "/routine-folders", { name: "Root" });
    const child = await call<FolderRow>("POST", "/routine-folders", {
      name: "Child",
      parentId: root.body.id,
    });

    const { status } = await call("PATCH", `/routine-folders/${root.body.id}`, {
      parentId: child.body.id,
    });
    assert.equal(status, 400);

    const tree = await call<TreeBody>("GET", "/routine-folders");
    assert.equal(tree.body.folders.find((f) => f.id === root.body.id)?.parentId, null);
  });

  test("404s for a folder in another company", async () => {
    const otherFounder = await insert(User, {
      email: "other@example.com",
      name: "Other",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const otherCompany = await insert(Company, {
      name: "Globex",
      slug: "globex",
      ownerId: otherFounder.id,
    });
    const foreign = await insert(RoutineFolder, {
      companyId: otherCompany.id,
      name: "Theirs",
      slug: "theirs",
      parentId: null,
      sortOrder: 0,
    });

    const { status } = await call("PATCH", `/routine-folders/${foreign.id}`, { name: "Mine" });
    assert.equal(status, 404);
  });
});

describe("DELETE /routine-folders/:fid", () => {
  test("reports what it promoted and leaves the routines alive", async () => {
    const root = await call<FolderRow>("POST", "/routine-folders", { name: "Root" });
    const child = await call<FolderRow>("POST", "/routine-folders", {
      name: "Child",
      parentId: root.body.id,
    });
    await call<FolderRow>("POST", "/routine-folders", {
      name: "Grandchild",
      parentId: child.body.id,
    });
    const routine = await addRoutine("Weekly report", child.body.id);

    const { status, body } = await call<{
      movedRoutines: number;
      movedFolders: number;
      promotedTo: string | null;
    }>("DELETE", `/routine-folders/${child.body.id}`);

    assert.equal(status, 200);
    assert.deepEqual(
      { r: body.movedRoutines, f: body.movedFolders, to: body.promotedTo },
      { r: 1, f: 1, to: root.body.id },
    );
    const reloaded = await AppDataSource.getRepository(Routine).findOneBy({ id: routine.id });
    assert.equal(reloaded?.folderId, root.body.id);
  });
});

describe("POST /routines/move", () => {
  test("files a batch and reports the count", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const a = await addRoutine("Alpha");
    const b = await addRoutine("Beta");

    const { status, body } = await call<{ moved: number }>("POST", "/routines/move", {
      routineIds: [a.id, b.id],
      folderId: folder.body.id,
    });
    assert.equal(status, 200);
    assert.equal(body.moved, 2);

    const tree = await call<TreeBody>("GET", "/routine-folders");
    assert.equal(tree.body.folders[0].routineCount, 2);
    assert.equal(tree.body.unfiledCount, 0);
  });

  test("moves only folderId, leaving scheduler columns alone", async () => {
    // Saving loaded entities would write back every column that differs at save
    // time, so a `nextRunAt` the cron heartbeat advanced between the read and
    // the write would be reverted — a routine re-firing because it was filed.
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const routine = await addRoutine("Alpha");
    const repo = AppDataSource.getRepository(Routine);

    // Stand in for the heartbeat: advance the schedule after the row exists.
    const advanced = new Date("2030-01-01T09:00:00.000Z");
    await repo.update({ id: routine.id }, { nextRunAt: advanced });

    await call("POST", "/routines/move", {
      routineIds: [routine.id],
      folderId: folder.body.id,
    });

    const reloaded = await repo.findOneByOrFail({ id: routine.id });
    assert.equal(reloaded.folderId, folder.body.id);
    assert.equal(
      reloaded.nextRunAt?.toISOString(),
      advanced.toISOString(),
      "the move must not roll back the scheduler's own column",
    );
  });

  test("null unfiles the batch", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const a = await addRoutine("Alpha", folder.body.id);

    const { status } = await call("POST", "/routines/move", {
      routineIds: [a.id],
      folderId: null,
    });
    assert.equal(status, 200);
    const tree = await call<TreeBody>("GET", "/routine-folders");
    assert.equal(tree.body.unfiledCount, 1);
  });

  test("one foreign routine fails the whole batch without moving any of it", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const mine = await addRoutine("Alpha");
    const stranger = await insert(AIEmployee, {
      companyId: "co_somebody_else",
      name: "Grace",
      slug: "grace",
      role: "Analyst",
      soulBody: "",
    });
    const theirs = await insert(Routine, {
      employeeId: stranger.id,
      name: "Theirs",
      slug: "theirs",
      cronExpr: "0 9 * * *",
      enabled: true,
      folderId: null,
      body: "",
    });

    const { status } = await call("POST", "/routines/move", {
      routineIds: [mine.id, theirs.id],
      folderId: folder.body.id,
    });
    assert.equal(status, 404);

    // The one routine that *was* in scope must not have moved.
    const reloaded = await AppDataSource.getRepository(Routine).findOneBy({ id: mine.id });
    assert.equal(reloaded?.folderId, null);
  });

  test("rejects a folder from another company", async () => {
    const foreign = await insert(RoutineFolder, {
      companyId: "co_somebody_else",
      name: "Theirs",
      slug: "theirs",
      parentId: null,
      sortOrder: 0,
    });
    const mine = await addRoutine("Alpha");

    const { status } = await call("POST", "/routines/move", {
      routineIds: [mine.id],
      folderId: foreign.id,
    });
    assert.equal(status, 400);
  });

  test("is admin-gated like the rest of the routine surface", async () => {
    const mine = await addRoutine("Alpha");
    actingUserId = viewer.id;
    const { status } = await call("POST", "/routines/move", {
      routineIds: [mine.id],
      folderId: null,
    });
    assert.equal(status, 403);
  });
});

describe("live sync", () => {
  /**
   * A regression guard with a specific past in mind. Both bulk paths used to
   * write through `Repository.update()` by criteria, which broadcasts only the
   * partial it was handed — `{ folderId }`, with no `employeeId` — so the
   * subscriber could not hop to the company and no other open browser ever
   * refetched. The rows moved; the app just didn't say so.
   */
  test("a bulk move announces a routine change to the company", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const routine = await addRoutine("Alpha");
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((companyId, kind) => events.push({ companyId, kind }));

    await call("POST", "/routines/move", {
      routineIds: [routine.id],
      folderId: folder.body.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      events.some((e) => e.companyId === company.id && e.kind === "routine"),
      `expected a routine change for ${company.id}, saw ${JSON.stringify(events)}`,
    );
  });

  test("deleting an EMPTY folder still announces itself", async () => {
    // The case with nothing to re-file: if only the promoted rows broadcast,
    // an empty folder disappears from the database and stays in every other
    // Member's sidebar.
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Empty" });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((companyId, kind) => events.push({ companyId, kind }));

    const { status } = await call("DELETE", `/routine-folders/${folder.body.id}`);
    assert.equal(status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      events.some((e) => e.companyId === company.id && e.kind === "routine"),
      `expected a change frame for ${company.id}, saw ${JSON.stringify(events)}`,
    );
  });

  test("deleting a folder announces the routines it re-filed", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    await addRoutine("Alpha", folder.body.id);
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((companyId, kind) => events.push({ companyId, kind }));

    await call("DELETE", `/routine-folders/${folder.body.id}`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      events.some((e) => e.companyId === company.id && e.kind === "routine"),
      `expected a routine change for ${company.id}, saw ${JSON.stringify(events)}`,
    );
  });
});

describe("routine create and patch accept a folder", () => {
  test("POST /employees/:eid/routines files the new routine", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const { status, body } = await call<{ id: string; folderId: string | null }>(
      "POST",
      `/employees/${employee.id}/routines`,
      { name: "Daily cash", cronExpr: "0 9 * * *", folderId: folder.body.id },
    );
    assert.equal(status, 200);
    assert.equal(body.folderId, folder.body.id);
  });

  test("POST rejects a folder from another company", async () => {
    const foreign = await insert(RoutineFolder, {
      companyId: "co_somebody_else",
      name: "Theirs",
      slug: "theirs",
      parentId: null,
      sortOrder: 0,
    });
    const { status } = await call("POST", `/employees/${employee.id}/routines`, {
      name: "Daily cash",
      cronExpr: "0 9 * * *",
      folderId: foreign.id,
    });
    assert.equal(status, 400);
  });

  test("PATCH /routines/:rid re-files and unfiles", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const routine = await addRoutine("Alpha");

    const filed = await call<{ folderId: string | null }>("PATCH", `/routines/${routine.id}`, {
      folderId: folder.body.id,
    });
    assert.equal(filed.body.folderId, folder.body.id);

    const unfiled = await call<{ folderId: string | null }>("PATCH", `/routines/${routine.id}`, {
      folderId: null,
    });
    assert.equal(unfiled.body.folderId, null);
  });

  test("PATCH leaves the folder alone when the field is omitted", async () => {
    const folder = await call<FolderRow>("POST", "/routine-folders", { name: "Finance" });
    const routine = await addRoutine("Alpha", folder.body.id);

    const patched = await call<{ folderId: string | null }>("PATCH", `/routines/${routine.id}`, {
      name: "Alpha renamed",
    });
    assert.equal(patched.body.folderId, folder.body.id);
  });
});
