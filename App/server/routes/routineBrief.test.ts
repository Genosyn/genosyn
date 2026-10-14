import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { routineTemplate } from "../services/files.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { MAX_ROUTINE_BRIEF_LENGTH } from "../../shared/routineBrief.js";
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
/** A brief read of a Routine that is switched on, as every one here starts. */
const readBack = (content: string) => ({ status: 200, body: { content, awaitingBrief: false } });
const savedOk = { status: 200, body: { ok: true, enabled: true } };

test("a brief read returns the exact saved content without employee metadata", async () => {
  assert.deepEqual(await call(), readBack(originalBody));
});

for (const content of ["", "# Revised brief\n\nRead café records 🧭, then report coverage.\n"]) {
  test(`an authorized ${content ? "Unicode" : "empty"} brief save reads back exactly`, async () => {
    assert.deepEqual(await call("PUT", { content, name: "Must not rename the Routine" }), savedOk);
    assert.deepEqual(await call(), readBack(content));
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
    assert.deepEqual(await call(), readBack(originalBody));
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
    assert.deepEqual(await call(), readBack(originalBody));
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
  assert.deepEqual(await call(), readBack(originalBody));
  assert.deepEqual(await call("PUT", { content: "Recovered save" }), savedOk);
  assert.deepEqual(await call(), readBack("Recovered save"));
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

describe("a Routine created without its brief", () => {
  async function send(method: "POST" | "PATCH", path: string, body: unknown) {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { id: string; enabled: boolean; nextRunAt: string | null };
  }
  const create = () =>
    send("POST", `/employees/${employee.id}/routines`, {
      name: "Weekly digest",
      cronExpr: "0 9 * * 1-5",
    });
  const row = (id: string) => AppDataSource.getRepository(Routine).findOneByOrFail({ id });
  const updateAudits = () =>
    AppDataSource.getRepository(AuditEvent).findBy({ action: "routine.update" });
  const keptPaused = { status: 200, body: { ok: true, enabled: false } };

  test("starts paused with nothing scheduled, and its brief read says it is waiting", async () => {
    const created = await create();
    assert.equal(created.enabled, false);
    assert.equal(created.nextRunAt, null);
    const read = await call("GET", undefined, created.id);
    assert.equal(read.body.awaitingBrief, true);
    assert.match(String(read.body.content), /^# Weekly digest\n/);
  });

  test("its first brief switches it on and schedules it, and later saves leave the switch alone", async () => {
    const created = await create();
    assert.deepEqual(
      await call("PUT", { content: "Post the digest to #general." }, created.id),
      savedOk,
    );
    const saved = await row(created.id);
    assert.equal(saved.enabled, true);
    assert.ok(saved.nextRunAt, "the save scheduled its next Run");
    assert.equal((await call("GET", undefined, created.id)).body.awaitingBrief, false);
    const audits = await updateAudits();
    assert.equal(audits.length, 1);
    assert.deepEqual(JSON.parse(audits[0].metadataJson), { fields: ["body", "enabled"] });

    await send("PATCH", `/routines/${created.id}`, { enabled: false });
    assert.deepEqual(
      await call("PUT", { content: "Post it to #ops instead." }, created.id),
      keptPaused,
    );
    assert.equal((await row(created.id)).enabled, false);
  });

  test("renaming or rescheduling it first does not count as writing its brief", async () => {
    const created = await create();
    await send("PATCH", `/routines/${created.id}`, {
      name: "Monday digest",
      cronExpr: "0 8 * * 1",
    });
    assert.equal((await call("GET", undefined, created.id)).body.awaitingBrief, true);
    assert.deepEqual(await call("PUT", { content: "Summarize last week." }, created.id), savedOk);
    assert.equal((await row(created.id)).enabled, true);
  });

  test("a blank brief or the untouched outline leaves it paused and still waiting", async () => {
    const created = await create();
    const outline = String((await call("GET", undefined, created.id)).body.content);
    for (const content of ["", "  \n", outline]) {
      assert.deepEqual(await call("PUT", { content }, created.id), keptPaused);
      assert.equal((await call("GET", undefined, created.id)).body.awaitingBrief, true);
    }
    assert.equal((await row(created.id)).nextRunAt, null);
    const audits = await updateAudits();
    assert.equal(audits.length, 3);
    for (const audit of audits) {
      assert.deepEqual(
        JSON.parse(audit.metadataJson),
        { fields: ["body"] },
        "no save switched it on",
      );
    }
  });

  test("a Routine paused with its brief written is not switched on by a save", async () => {
    await AppDataSource.getRepository(Routine).update({ id: routine.id }, { enabled: false });
    assert.deepEqual(await call(), {
      status: 200,
      body: { content: originalBody, awaitingBrief: false },
    });
    assert.deepEqual(await call("PUT", { content: "Revised brief" }), keptPaused);
    assert.equal((await savedRoutine()).enabled, false);
  });
});

describe("a Routine created with its brief", () => {
  type Created = { id: string; enabled: boolean; nextRunAt: string | null; body: string };
  async function create(body: Record<string, unknown>) {
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/routines`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Weekly digest", cronExpr: "0 9 * * 1-5", ...body }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return { status: response.status, body: (await response.json()) as Created };
  }
  const row = (id: string) => AppDataSource.getRepository(Routine).findOneByOrFail({ id });
  const routineCount = () => AppDataSource.getRepository(Routine).count();
  const brief = "Post a digest of the week's merged pull requests to #engineering.\n";

  test("starts on with that brief as its body and its next Run scheduled", async () => {
    const created = await create({ brief });
    assert.equal(created.status, 200);
    assert.equal(created.body.enabled, true);
    assert.equal(created.body.body, brief);
    assert.ok(created.body.nextRunAt, "the create scheduled its next Run");
    const saved = await row(created.body.id);
    assert.equal(saved.enabled, true);
    assert.equal(saved.body, brief);
    assert.ok(saved.nextRunAt);
    assert.deepEqual(await call("GET", undefined, saved.id), {
      status: 200,
      body: { content: brief, awaitingBrief: false },
    });
  });

  test("a blank brief, or the starter outline untouched, counts as no brief", async () => {
    const outline = routineTemplate("Digest outline", "0 9 * * 1-5");
    const cases: Array<[name: string, brief: string, body: string]> = [
      ["Digest empty", "", routineTemplate("Digest empty", "0 9 * * 1-5")],
      ["Digest spaces", "  \n\t", routineTemplate("Digest spaces", "0 9 * * 1-5")],
      ["Digest outline", outline, outline],
    ];
    for (const [name, sent, body] of cases) {
      const created = await create({ name, brief: sent });
      assert.equal(created.status, 200, name);
      assert.equal(created.body.enabled, false, name);
      assert.equal(created.body.nextRunAt, null, name);
      assert.equal((await row(created.body.id)).body, body, name);
    }
  });

  test("accepts a brief of exactly the longest length and refuses one character more", async () => {
    const longest = "x".repeat(MAX_ROUTINE_BRIEF_LENGTH);
    const accepted = await create({ name: "Longest", brief: longest });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.enabled, true);
    assert.equal((await row(accepted.body.id)).body, longest);

    const before = await routineCount();
    const refused = await create({ name: "Too long", brief: `${longest}x` });
    assert.equal(refused.status, 400);
    assert.equal(await routineCount(), before, "a refused create leaves no Routine behind");
  });

  test("refuses a brief that is not text", async () => {
    for (const bad of [5, null, ["Post the digest."], { text: "Post the digest." }]) {
      assert.equal((await create({ brief: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal(await routineCount(), 1, "only the Routine every test starts with");
  });
});
