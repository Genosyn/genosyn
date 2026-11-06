import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { InputRequest } from "../db/entities/InputRequest.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  awaitPersonAtPage,
  openPageInputRequest,
  settleInputRequestPingsForTests,
} from "../services/inputRequests.js";
import { stopRoutineQueue } from "../services/routineQueue.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import type { InputRequestView } from "../../shared/inputRequests.js";
import { inputRequestsRouter } from "./inputRequests.js";

/**
 * The person's side of an Input request. A code comes in here and must never come
 * back out, and only whoever was asked, or an owner or admin, may send one.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  stopRoutineQueue();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", inputRequestsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await settleInputRequestPingsForTests();
  await resetTestDb();
});

after(async () => {
  await settleInputRequestPingsForTests();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function person(email: string, role: Role, companyId: string): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

async function fixture() {
  const founder = await insert(User, {
    email: "founder@acme.test",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  await insert(Membership, { companyId: company.id, userId: founder.id, role: "owner" });
  const valeria = await person("valeria@acme.test", "member", company.id);
  const bystander = await person("bystander@acme.test", "member", company.id);
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Mira",
    slug: "mira",
    role: "Finance",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "File VAT",
    slug: "file-vat",
    cronExpr: "0 9 1 * *",
    timeoutSec: 3600,
    body: "File it.",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    continuationDeadlineAt: new Date(Date.now() + 3_600_000),
  });
  const request = await openPageInputRequest({
    companyId: company.id,
    employeeId: employee.id,
    kind: "code",
    title: "FreeAgent sign-in code",
    named: valeria.email,
    work: { runId: run.id, routineId: routine.id, browserSessionId: "s1" },
    pageUrl: "https://login.freeagent.test/2fa",
  });
  return { founder, company, valeria, bystander, employee, routine, run, request };
}

async function call(
  method: "GET" | "POST",
  path: string,
  as: User,
  companyId: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  actingUserId = as.id;
  const res = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not every failure is JSON.
  }
  return { status: res.status, json, text, headers: res.headers };
}

describe("reading", () => {
  test("whoever was asked sees it, and nobody else's list mentions it", async () => {
    const f = await fixture();
    const theirs = await call("GET", "/input-requests", f.valeria, f.company.id);
    assert.equal(theirs.status, 200);
    const [view] = theirs.json as InputRequestView[];
    assert.equal(view.id, f.request.id);
    assert.equal(view.canAnswer, true);
    assert.equal(view.pageOrigin, "https://login.freeagent.test");
    assert.equal(view.work.label, "File VAT");

    const none = await call("GET", "/input-requests", f.bystander, f.company.id);
    assert.deepEqual(none.json, []);
    const direct = await call("GET", `/input-requests/${f.request.id}`, f.bystander, f.company.id);
    assert.equal(direct.status, 404);

    const owners = await call("GET", "/input-requests", f.founder, f.company.id);
    assert.equal((owners.json as InputRequestView[]).length, 1);
  });

  test("a list narrows to one piece of work", async () => {
    const f = await fixture();
    const other = await call(
      "GET",
      "/input-requests?runId=00000000-0000-4000-8000-000000000000",
      f.valeria,
      f.company.id,
    );
    assert.deepEqual(other.json, []);
    const own = await call("GET", `/input-requests?runId=${f.run.id}`, f.valeria, f.company.id);
    assert.equal((own.json as InputRequestView[]).length, 1);
  });

  test("another company's request doesn't exist", async () => {
    const f = await fixture();
    const elsewhere = await insert(Company, {
      name: "Other",
      slug: "other",
      ownerId: f.founder.id,
    });
    await insert(Membership, { companyId: elsewhere.id, userId: f.founder.id, role: "owner" });
    const asked = await call("GET", `/input-requests/${f.request.id}`, f.founder, elsewhere.id);
    assert.equal(asked.status, 404);
  });
});

describe("answering", () => {
  test("a code goes in and never comes back out of any response", async () => {
    const f = await fixture();
    const code = "483921";
    const answered = await call(
      "POST",
      `/input-requests/${f.request.id}/answer`,
      f.valeria,
      f.company.id,
      { value: code },
    );
    assert.equal(answered.status, 200, answered.text);
    assert.ok(!answered.text.includes(code));
    assert.match(answered.headers.get("cache-control") ?? "", /no-store/);
    const read = await call("GET", `/input-requests/${f.request.id}`, f.valeria, f.company.id);
    assert.ok(!read.text.includes(code));
    assert.ok(!read.text.includes("encryptedAnswer"));

    const taken = await awaitPersonAtPage({ requestId: f.request.id, companyId: f.company.id });
    assert.equal(taken.outcome === "code" && taken.code, code);
    const after = await call("GET", `/input-requests/${f.request.id}`, f.valeria, f.company.id);
    assert.equal((after.json as InputRequestView).status, "submitted");
    assert.ok(!after.text.includes(code));
  });

  test("anyone else can't, and the reply doesn't say whether it exists", async () => {
    const f = await fixture();
    const refused = await call(
      "POST",
      `/input-requests/${f.request.id}/answer`,
      f.bystander,
      f.company.id,
      { value: "123456" },
    );
    assert.equal(refused.status, 404);
    const row = await AppDataSource.getRepository(InputRequest).findOneByOrFail({
      id: f.request.id,
    });
    assert.equal(row.encryptedAnswer, null);
  });

  test("a code for a page that stopped waiting is refused in plain words", async () => {
    const f = await fixture();
    await AppDataSource.getRepository(InputRequest).update(
      { id: f.request.id },
      { askingUntil: new Date(Date.now() - 1_000) },
    );
    const refused = await call(
      "POST",
      `/input-requests/${f.request.id}/answer`,
      f.valeria,
      f.company.id,
      { value: "123456" },
    );
    assert.equal(refused.status, 409);
    assert.match(refused.text, /Press I'm ready first/);
    assert.ok(!refused.text.includes("123456"));
  });

  test("I'm ready and I can't answer as a person would read them", async () => {
    const f = await fixture();
    await AppDataSource.getRepository(InputRequest).update(
      { id: f.request.id },
      { status: "waiting", askingUntil: null },
    );
    const ready = await call(
      "POST",
      `/input-requests/${f.request.id}/ready`,
      f.valeria,
      f.company.id,
      {},
    );
    assert.equal(ready.status, 200, ready.text);
    assert.equal((ready.json as InputRequestView).status, "ready");

    const declined = await call(
      "POST",
      `/input-requests/${f.request.id}/decline`,
      f.valeria,
      f.company.id,
      { note: "Away until Monday" },
    );
    assert.equal(declined.status, 200);
    assert.equal((declined.json as InputRequestView).status, "declined");
    const again = await call(
      "POST",
      `/input-requests/${f.request.id}/ready`,
      f.valeria,
      f.company.id,
      {},
    );
    assert.equal(again.status, 409);
    assert.match(again.text, /already said they can't/);
  });

  test("a body with anything it doesn't expect is refused", async () => {
    const f = await fixture();
    const refused = await call(
      "POST",
      `/input-requests/${f.request.id}/answer`,
      f.valeria,
      f.company.id,
      { value: "1", somethingElse: true },
    );
    assert.equal(refused.status, 400);
  });
});
