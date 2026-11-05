import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { browserRecordingFile } from "../services/paths.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { todoPickupsRouter } from "./todoPickups.js";

/**
 * A recording shows the whole screen, sign-in pages included. So who gets one is the
 * point here: owners and admins for Genosyn's own browser, and for everyone else only
 * that a recording exists.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let member: User;
let project: Project;
let todo: Todo;
let session: BrowserSession;
let pickup: TodoPickup;

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
  app.use("/api/companies/:cid", todoPickupsRouter);
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

async function addMember(email: string, role: Role) {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@recordings.test",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await addMember("owner@recordings.test", "owner");
  member = await addMember("member@recordings.test", "member");
  const ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Compliance",
    soulBody: "",
  });
  project = await insert(Project, {
    companyId: company.id,
    name: "Compliance",
    slug: "compliance",
    key: "COMP",
    todoCounter: 1,
  });
  todo = await insert(Todo, {
    projectId: project.id,
    number: 1,
    title: "Accept the agreement",
    status: "done",
    priority: "none",
    assigneeEmployeeId: ada.id,
  });
  pickup = await insert(TodoPickup, {
    companyId: company.id,
    todoId: todo.id,
    employeeId: ada.id,
    trigger: "assigned",
    status: "done",
    authority: "employee",
    acceptedAt: new Date(),
  });
  session = await insert(BrowserSession, {
    companyId: company.id,
    employeeId: ada.id,
    todoId: todo.id,
    todoPickupId: pickup.id,
    mcpToken: "token",
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "closed",
    pageUrl: "",
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  // A finished video on disk, as the recorder leaves one.
  const file = browserRecordingFile(company.id, todo.id, session.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "video-bytes");
  await fs.writeFile(
    path.join(path.dirname(file), `${session.id}.json`),
    JSON.stringify({
      id: session.id,
      status: "ready",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      mimeType: "video/mp4",
      sizeBytes: 11,
      filename: `${session.id}.mp4`,
    }),
  );
});

type Listing = {
  recordings: Array<{ id: string; status: string; pickupId: string }>;
  withheldPickupIds: string[];
};

async function get(userId: string | null, suffix = "", headers: Record<string, string> = {}) {
  actingUserId = userId;
  return fetch(`${baseUrl}/api/companies/${company.id}/todos/${todo.id}/browser-recordings${suffix}`, {
    headers,
  });
}

describe("a Todo's browser recordings", () => {
  test("an owner gets the recording, and the video", async () => {
    const list = (await (await get(owner.id)).json()) as Listing;
    assert.equal(list.recordings[0].id, session.id);
    assert.equal(list.recordings[0].pickupId, pickup.id);
    assert.equal(list.recordings[0].status, "ready");
    assert.deepEqual(list.withheldPickupIds, []);

    const video = await get(owner.id, `/${session.id}`);
    assert.equal(video.status, 200);
    assert.equal(await video.text(), "video-bytes");
    assert.match(video.headers.get("cache-control") ?? "", /no-store/);
  });

  test("a plain Member learns one exists, and can't fetch it", async () => {
    const list = (await (await get(member.id)).json()) as Listing;
    assert.deepEqual(list.recordings, []);
    assert.deepEqual(list.withheldPickupIds, [pickup.id]);
    assert.equal((await get(member.id, `/${session.id}`)).status, 404);
    assert.equal((await get(member.id, `/${session.id}/live`)).status, 404);
  });

  test("a Member who can't open the Project learns nothing", async () => {
    await AppDataSource.getRepository(Project).update({ id: project.id }, { accessMode: "restricted" });
    assert.ok([403, 404].includes((await get(member.id)).status));
  });

  test("an API key gets nothing, even an owner's", async () => {
    const body = "R".repeat(43);
    await insert(ApiKey, {
      userId: owner.id,
      companyId: company.id,
      name: "automation",
      prefix: body.slice(0, 8),
      tokenHash: hashApiToken(body),
    });
    const key = { authorization: `Bearer gen_${body}` };
    assert.equal((await get(null, "", key)).status, 403);
    assert.equal((await get(null, `/${session.id}`, key)).status, 403);
  });

  test("a session on another Todo isn't reachable through this one", async () => {
    const other = await insert(Todo, {
      projectId: project.id,
      number: 2,
      title: "Another",
      status: "todo",
      priority: "none",
    });
    await AppDataSource.getRepository(BrowserSession).update({ id: session.id }, { todoId: other.id });
    assert.equal((await get(owner.id, `/${session.id}`)).status, 404);
  });
});
