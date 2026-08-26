import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { routineAssistantRouter } from "./routineAssistant.js";
import { routinesRouter } from "./routines.js";

/**
 * The HTTP surface for Ask AI on a Routine, exercised through the real mount
 * so the authorization actually runs.
 *
 * The invariant this file exists for: `routinesRouter` gates every non-GET
 * under `/routines` behind the admin role, because editing a routine is
 * company configuration. Asking a question about one is not, and the assistant
 * router is mounted ahead of it so an ordinary Member can. Mount both here, in
 * production order, or the test proves nothing about production.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;
let routine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  // Same order as `server/index.ts`.
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use("/api/companies/:cid", routineAssistantRouter);
  app.use("/api/companies/:cid", routinesRouter);
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
  owner = await insert(User, {
    email: `routine-owner-${randomUUID()}@example.com`,
    name: "Routine Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: `routine-member-${randomUUID()}@example.com`,
    name: "Ordinary Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Routine Assistant Co",
    slug: `routine-assistant-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "VP of Go to Market",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily Reddit Community Help",
    slug: "daily-reddit-community-help",
    cronExpr: "0 11 * * *",
    body: "Answer questions in r/genosyn every morning.",
  });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Send a turn and collect the SSE frames it writes. */
async function sendTurn(message: string): Promise<{ status: number; events: [string, unknown][] }> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/routines/${routine.id}/assistant/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    },
  );
  const text = await response.text();
  const events: [string, unknown][] = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    const name = lines
      .find((l) => l.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .find((l) => l.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (name) events.push([name, data ? JSON.parse(data) : null]);
  }
  return { status: response.status, events };
}

describe("who may ask", () => {
  test("an ordinary Member can read the panel and send a turn", async () => {
    actingUserId = member.id;

    const bootstrap = await call<{ roster: { slug: string; ownsRoutine: boolean }[] }>(
      "GET",
      `/routines/${routine.id}/assistant`,
    );
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(
      bootstrap.body.roster.map((r) => [r.slug, r.ownsRoutine]),
      [["jamie", true]],
    );

    const sent = await sendTurn("What does this routine do?");
    assert.equal(sent.status, 200);
    assert.deepEqual(
      sent.events.map(([name]) => name),
      ["user", "target", "working", "assistant", "done"],
    );
  });

  test("the same Member still cannot edit the routine", async () => {
    actingUserId = member.id;

    const res = await call("PATCH", `/routines/${routine.id}`, { name: "Renamed by a member" });

    assert.equal(res.status, 403, "the admin gate on routine mutations is untouched");
  });

  test("requires a signed-in Member", async () => {
    actingUserId = null;

    const res = await call("GET", `/routines/${routine.id}/assistant`);

    assert.equal(res.status, 401);
  });

  test("a routine outside this company is not found", async () => {
    const otherOwner = await insert(User, {
      email: `other-${randomUUID()}@example.com`,
      name: "Other Owner",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const otherCompany = await insert(Company, {
      name: "Elsewhere",
      slug: `elsewhere-${randomUUID()}`,
      ownerId: otherOwner.id,
    });
    const otherEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Someone Else",
      slug: "someone-else",
      role: "Ops",
    });
    const foreign = await insert(Routine, {
      employeeId: otherEmployee.id,
      name: "Their routine",
      slug: "their-routine",
      cronExpr: "0 9 * * *",
    });

    const res = await call("GET", `/routines/${foreign.id}/assistant`);

    assert.equal(res.status, 404);
  });
});

describe("the conversation", () => {
  test("a turn persists both rows and reads back on the next load", async () => {
    await sendTurn("Why did last night's run fail?");

    const res = await call<{
      messages: { role: string; content: string; status: string | null }[];
    }>("GET", `/routines/${routine.id}/assistant`);

    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 2);
    assert.equal(res.body.messages[0].role, "user");
    assert.equal(res.body.messages[0].content, "Why did last night's run fail?");
    assert.equal(res.body.messages[1].role, "assistant");
    // No AI Model is connected in this fixture, so the turn is honestly
    // skipped rather than pretending to answer.
    assert.equal(res.body.messages[1].status, "skipped");
    assert.match(res.body.messages[1].content, /no AI Model connected/i);
  });

  test("clearing removes only this routine's conversation", async () => {
    const sibling = await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly report",
      slug: "weekly-report",
      cronExpr: "0 9 * * 1",
    });
    await insert(RoutineChatMessage, {
      companyId: company.id,
      routineId: sibling.id,
      role: "user",
      content: "keep me",
    });
    await sendTurn("delete me");

    const res = await call("DELETE", `/routines/${routine.id}/assistant/messages`);

    assert.equal(res.status, 200);
    const left = await AppDataSource.getRepository(RoutineChatMessage).find();
    assert.deepEqual(
      left.map((m) => m.content),
      ["keep me"],
    );
  });

  test("rejects an empty message before anything is persisted", async () => {
    const res = await call("POST", `/routines/${routine.id}/assistant/messages`, { message: "" });

    assert.equal(res.status, 400);
    assert.equal(await AppDataSource.getRepository(RoutineChatMessage).count(), 0);
  });
});

describe("deleting the routine", () => {
  test("takes its conversation with it", async () => {
    await sendTurn("what is this?");
    assert.ok((await AppDataSource.getRepository(RoutineChatMessage).count()) > 0);

    const res = await call("DELETE", `/routines/${routine.id}`);

    assert.equal(res.status, 200);
    assert.equal(await AppDataSource.getRepository(RoutineChatMessage).count(), 0);
  });

  test("deleting the owning employee takes it too", async () => {
    // The routine dies with its employee, and nothing can reach a
    // conversation whose routine is gone — the panel resolves a routine
    // first — so leaving the rows behind strands transcript text for good.
    await sendTurn("what is this?");
    assert.ok((await AppDataSource.getRepository(RoutineChatMessage).count()) > 0);

    const res = await call("DELETE", `/employees/${employee.id}`);

    assert.equal(res.status, 200);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
    assert.equal(await AppDataSource.getRepository(RoutineChatMessage).count(), 0);
  });
});
