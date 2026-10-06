import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let administrator: User;
let member: User;
let outsider: User;
let company: Company;
let employee: AIEmployee;
let routine: Routine;
const originalBody = "# Daily review\n\nPreserve the captured scope. Café ☕\n";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", routinesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  [administrator, member, outsider] = await Promise.all(
    ["administrator", "member", "outsider"].map((name) =>
      insert(User, {
        name,
        email: `${name}@example.test`,
        passwordHash: "x",
        sessionVersion: 0,
      }),
    ),
  );
  company = await insert(Company, { name: "Brief Co", slug: "brief", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
    soulBody: "Private Soul",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily review",
    slug: "daily-review",
    cronExpr: "0 9 * * *",
    body: originalBody,
  });
  actingUserId = administrator.id;
});

async function call(
  method: "GET" | "PUT" = "GET",
  body: unknown = { content: "Updated brief" },
  id = routine.id,
) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/routines/${id}/readme`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const savedRoutine = () => AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
const storageFailure = () =>
  Object.assign(new Error("Synthetic storage failure"), {
    query: "UPDATE routines SET body = ? WHERE id = ?",
    parameters: ["private brief that must not be echoed", "synthetic-id"],
  });
const internalError = { status: 500, body: { error: "Internal server error" } };

test("a brief read returns the exact saved content without employee metadata", async () => {
  assert.deepEqual(await call(), { status: 200, body: { content: originalBody } });
});

for (const content of ["", "# Revised brief\n\nRead café records 🧭, then report coverage.\n"]) {
  test(`an authorized ${content ? "Unicode" : "empty"} brief save reads back exactly`, async () => {
    assert.deepEqual(await call("PUT", { content, name: "Must not rename the Routine" }), {
      status: 200,
      body: { ok: true },
    });
    assert.deepEqual(await call(), { status: 200, body: { content } });
    const saved = await savedRoutine();
    assert.equal(saved.body, content);
    assert.equal(saved.name, routine.name);
    assert.equal(saved.employeeId, employee.id);
  });
}

for (const method of ["GET", "PUT"] as const) {
  test(`${method}: rejected Routine lookup answers with an error and the next request recovers`, async (t) => {
    t.mock.method(console, "error", () => undefined);
    const repo = AppDataSource.getRepository(Routine);
    t.mock.method(
      repo,
      "findOneBy",
      async () => {
        throw storageFailure();
      },
      { times: 1 },
    );
    assert.deepEqual(await call(method), internalError);
    assert.equal((await savedRoutine()).body, originalBody);
    assert.deepEqual(await call(), { status: 200, body: { content: originalBody } });
  });

  test(`${method}: rejected employee ownership lookup is forwarded without saving or leaking the brief`, async (t) => {
    t.mock.method(console, "error", () => undefined);
    t.mock.method(
      AppDataSource.getRepository(AIEmployee),
      "findOneBy",
      async () => {
        throw storageFailure();
      },
      { times: 1 },
    );
    assert.deepEqual(await call(method), internalError);
    assert.equal((await savedRoutine()).body, originalBody);
    assert.deepEqual(await call(), { status: 200, body: { content: originalBody } });
  });
}

test("rejected brief save answers with an error, preserves the body, and permits a later save", async (t) => {
  t.mock.method(console, "error", () => undefined);
  t.mock.method(
    AppDataSource.getRepository(Routine),
    "save",
    async () => {
      throw storageFailure();
    },
    { times: 1 },
  );
  assert.deepEqual(await call("PUT"), internalError);
  assert.equal((await savedRoutine()).body, originalBody);
  assert.deepEqual(await call(), { status: 200, body: { content: originalBody } });
  assert.deepEqual(await call("PUT", { content: "Recovered save" }), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual(await call(), { status: 200, body: { content: "Recovered save" } });
});

test("a save cannot report success before persistence settles", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    AppDataSource.getRepository(Routine),
    "save",
    async () => {
      entered();
      await released;
      throw storageFailure();
    },
    { times: 1 },
  );
  let answered = false;
  const response = call("PUT").then((value) => {
    answered = true;
    return value;
  });
  try {
    await Promise.race([
      started,
      response.then(() => assert.fail("Save was answered before persistence began")),
    ]);
    assert.equal(answered, false);
    assert.equal((await savedRoutine()).body, originalBody);
  } finally {
    release();
  }
  assert.deepEqual(await response, internalError);
  assert.equal((await savedRoutine()).body, originalBody);
});

test("an ordinary company Member can read the brief but cannot replace it", async () => {
  actingUserId = member.id;
  assert.equal((await call()).status, 200);
  assert.equal((await call("PUT")).status, 403);
  assert.equal((await savedRoutine()).body, originalBody);
});

for (const identity of ["anonymous", "outsider"] as const) {
  test(`${identity} cannot read or replace a company brief`, async () => {
    actingUserId = identity === "anonymous" ? null : outsider.id;
    for (const method of ["GET", "PUT"] as const) {
      const response = await call(method);
      assert.equal(response.status, identity === "anonymous" ? 401 : 403);
      assert.equal(response.body.content, undefined);
    }
    assert.equal((await savedRoutine()).body, originalBody);
  });
}

for (const method of ["GET", "PUT"] as const) {
  test(`${method}: another company's Routine and a missing Routine both remain not found`, async () => {
    const otherEmployee = await insert(AIEmployee, {
      companyId: randomUUID(),
      name: "Other",
      slug: "other",
      role: "Operations",
    });
    const otherRoutine = await insert(Routine, {
      employeeId: otherEmployee.id,
      name: "Other review",
      slug: "other",
      cronExpr: "0 9 * * *",
      body: "Other company brief",
    });
    for (const id of [otherRoutine.id, randomUUID()]) {
      assert.deepEqual(await call(method, { content: "Must not save" }, id), {
        status: 404,
        body: { error: "Not found" },
      });
    }
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: otherRoutine.id })).body,
      "Other company brief",
    );
    assert.equal((await savedRoutine()).body, originalBody);
  });
}

test("invalid brief input is rejected before persistence", async (t) => {
  const save = t.mock.method(AppDataSource.getRepository(Routine), "save");
  for (const body of [{}, { content: null }, { content: 1 }, { content: ["text"] }])
    assert.equal((await call("PUT", body)).status, 400);
  assert.equal(save.mock.callCount(), 0);
  assert.equal((await savedRoutine()).body, originalBody);
});
