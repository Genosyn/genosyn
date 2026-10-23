import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import type { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Setting a Routine's priority, end to end through `createApp()` with real API
 * keys: who may change it (whoever may edit the Routine's settings — owners and
 * admins), what the routes accept, how it is scoped to the company, and that a
 * change reaches the queue the Running page and an employee's day show. AI
 * Employees can read a Routine's priority and cannot change it.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let ownerToken = "";
let employee: AIEmployee;
let routine: Routine;

beforeEach(async () => {
  await resetTestDb();
  const owner = await createMemberOfNewCompany("owner");
  company = owner.company;
  ownerToken = (await mintTestApiKey(owner.user.id, company.id)).token;
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "VP of Go to Market",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily CRM Sync",
    slug: "daily-crm-sync",
    cronExpr: "0 9 * * *",
    body: "Sync the CRM.",
  });
});

async function keyFor(role: Role, companyId = company.id): Promise<string> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: role,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId, userId: user.id, role });
  return (await mintTestApiKey(user.id, companyId)).token;
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & Record<string, never> }> {
  const response = await fetch(`${baseUrl}/api/companies/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const patchPriority = (priority: unknown, token = ownerToken, id = routine.id, cid = company.id) =>
  api("PATCH", `${cid}/routines/${id}`, token, { priority });
const stored = async () =>
  (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).priority;

describe("reading a Routine's priority", () => {
  test("every Routine reads Normal until someone changes it, on every Routine read", async () => {
    const list = await api("GET", `${company.id}/routines`, ownerToken);
    assert.equal(list.status, 200);
    assert.equal((list.body as unknown as Array<{ priority: string }>)[0].priority, "normal");
    const one = await api("GET", `${company.id}/routines/${routine.id}`, ownerToken);
    assert.equal(one.body.priority, "normal");
    const theirs = await api("GET", `${company.id}/employees/${employee.id}/routines`, ownerToken);
    assert.equal((theirs.body as unknown as Array<{ priority: string }>)[0].priority, "normal");
  });

  test("an ordinary Member can see it, like the rest of a Routine", async () => {
    await AppDataSource.getRepository(Routine).update(routine.id, { priority: "high" });
    const member = await keyFor("member");
    assert.equal((await api("GET", `${company.id}/routines/${routine.id}`, member)).body.priority, "high");
  });
});

describe("changing a Routine's priority", () => {
  test("an owner or an admin marks it High and back, and the change is audited", async () => {
    const changed = await patchPriority("high");
    assert.equal(changed.status, 200);
    assert.equal(changed.body.priority, "high");
    assert.equal(await stored(), "high");

    const admin = await keyFor("admin");
    assert.equal((await patchPriority("normal", admin)).status, 200);
    assert.equal(await stored(), "normal");

    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { action: "routine.update", targetId: routine.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      audits.map((audit) => (JSON.parse(audit.metadataJson) as { changes: unknown }).changes),
      [{ priority: "high" }, { priority: "normal" }],
    );
  });

  test("changing only the priority leaves every other setting as it was", async () => {
    const before = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    await patchPriority("high");
    const after = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(after.priority, "high");
    assert.deepEqual({ ...after, priority: before.priority }, { ...before });
  });

  test("a Member cannot change it, and nothing is written", async () => {
    const member = await keyFor("member");
    const refused = await patchPriority("high", member);
    assert.equal(refused.status, 403);
    assert.equal(await stored(), "normal");
  });

  for (const value of ["urgent", "HIGH", "", null, 1, true, ["high"]]) {
    test(`a priority of ${JSON.stringify(value)} is a 400 and nothing is written`, async () => {
      const refused = await patchPriority(value);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error, "ValidationError");
      assert.equal(await stored(), "normal");
    });
  }

  test("a Routine of another company is not found, and another company's address is refused", async () => {
    const other = await createMemberOfNewCompany("owner");
    const stranger = await insert(AIEmployee, {
      companyId: other.company.id,
      name: "Robin",
      slug: "robin",
      role: "Ops",
    });
    const theirs = await insert(Routine, {
      employeeId: stranger.id,
      name: "Theirs",
      slug: "theirs",
      cronExpr: "0 9 * * *",
      body: "",
    });
    assert.equal((await patchPriority("high", ownerToken, theirs.id)).status, 404);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: theirs.id })).priority,
      "normal",
    );
    // A key is a credential for its own company only: anywhere else it is none.
    assert.equal(
      (await patchPriority("high", ownerToken, theirs.id, other.company.id)).status,
      401,
    );
    // And a Member of the company cannot reach in from it either.
    const outsider = await keyFor("member", other.company.id);
    assert.equal((await patchPriority("high", outsider, theirs.id, other.company.id)).status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: theirs.id })).priority,
      "normal",
    );
    assert.equal((await patchPriority("high", ownerToken, randomUUID())).status, 404);
  });

  test("without a key nothing changes", async () => {
    assert.equal((await patchPriority("high", "")).status, 401);
    assert.equal(await stored(), "normal");
  });

  test("a new Routine can be created High, and is Normal when nobody says", async () => {
    const high = await api("POST", `${company.id}/employees/${employee.id}/routines`, ownerToken, {
      name: "Stripe Qualification",
      cronExpr: "0 10 * * *",
      brief: "Qualify new customers.",
      priority: "high",
    });
    assert.equal(high.status, 200, JSON.stringify(high.body));
    assert.equal(high.body.priority, "high");
    const plain = await api("POST", `${company.id}/employees/${employee.id}/routines`, ownerToken, {
      name: "Reddit Help",
      cronExpr: "0 11 * * *",
    });
    assert.equal(plain.body.priority, "normal");
    const refused = await api("POST", `${company.id}/employees/${employee.id}/routines`, ownerToken, {
      name: "Bad",
      cronExpr: "0 11 * * *",
      priority: "asap",
    });
    assert.equal(refused.status, 400);
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ name: "Bad" }), 0);
  });
});

describe("a changed priority reaches the queue people see", () => {
  async function waiting(target: Routine, hoursAgo: number) {
    const createdAt = new Date(Date.now() - hoursAgo * 60 * 60_000);
    return insert(Run, {
      routineId: target.id,
      employeeId: target.employeeId,
      status: "queued",
      triggerKind: "schedule",
      startedAt: createdAt,
      createdAt,
    });
  }

  test("the Running page and the employee's day both put it next up", async () => {
    const nostr = await insert(Routine, {
      employeeId: employee.id,
      name: "Daily Nostr Helpful Replies",
      slug: "daily-nostr-helpful-replies",
      cronExpr: "0 9 * * *",
      body: "",
    });
    const older = await waiting(nostr, 17);
    const crm = await waiting(routine, 1);
    const day = new URLSearchParams({
      from: new Date(Date.now() - 12 * 60 * 60_000).toISOString(),
      to: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
    });
    const member = await keyFor("member");
    const activity = async () =>
      (await api("GET", `${company.id}/routines/activity?${day}`, member)).body as unknown as {
        queued: Array<{ id: string; position: number | null; priority: string }>;
      };
    const workQueue = async () =>
      (await api("GET", `${company.id}/employees/${employee.id}/work-queue`, member))
        .body as unknown as { pending: Array<{ runId: string; position: number | null; priority: string }> };

    assert.deepEqual(
      (await activity()).queued.map((run) => [run.id, run.position, run.priority]),
      [
        [older.id, 1, "normal"],
        [crm.id, 2, "normal"],
      ],
    );
    assert.equal((await patchPriority("high")).status, 200);
    assert.deepEqual(
      (await activity()).queued.map((run) => [run.id, run.position, run.priority]),
      [
        [crm.id, 1, "high"],
        [older.id, 2, "normal"],
      ],
    );
    assert.deepEqual(
      (await workQueue()).pending.map((item) => [item.runId, item.position, item.priority]),
      [
        [crm.id, 1, "high"],
        [older.id, 2, "normal"],
      ],
    );
  });
});

describe("the API reference, and so the CLI and the MCP server, carry the field", () => {
  type Schema = {
    enum?: unknown[];
    properties?: Record<string, Schema>;
    allOf?: Schema[];
    nullable?: boolean;
    type?: string;
  };
  const document = buildOpenApiDocument(createApp()) as unknown as {
    paths: Record<
      string,
      Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>
    >;
    components: { schemas: Record<string, Schema> };
  };
  const bodyOf = (path: string, method: string) =>
    document.paths[path]?.[method]?.requestBody?.content["application/json"].schema;
  /** A schema's own properties, including those an `allOf` extension adds. */
  const propertiesOf = (schema: Schema | undefined): Record<string, Schema> =>
    Object.assign({}, schema?.properties, ...(schema?.allOf ?? []).map((part) => part.properties));

  test("PATCH and create take priority as normal or high", () => {
    for (const [path, method] of [
      ["/api/companies/{cid}/routines/{rid}", "patch"],
      ["/api/companies/{cid}/employees/{eid}/routines", "post"],
    ] as const) {
      const schema = bodyOf(path, method);
      assert.ok(schema, `${method} ${path} documents its body`);
      assert.deepEqual(schema.properties?.priority?.enum, ["normal", "high"], `${method} ${path}`);
    }
  });

  test("Routine reads, the Running page's queue and an employee's queue describe it", () => {
    const schemas = document.components.schemas;
    for (const name of ["RoutineListItem", "RoutineDetail", "Routine", "RoutineActivityQueuedRun"]) {
      assert.deepEqual(propertiesOf(schemas[name]).priority?.enum, ["normal", "high"], name);
    }
    const position = propertiesOf(schemas.RoutineActivityQueuedRun).position;
    assert.equal(position?.type, "integer");
    assert.equal(position?.nullable, true);
    const workQueue = (
      document.paths["/api/companies/{cid}/employees/{eid}/work-queue"] as unknown as {
        get: {
          responses: Record<string, { content: Record<string, { schema: Schema }> }>;
        };
      }
    ).get.responses["200"].content["application/json"].schema;
    const item = (propertiesOf(workQueue).pending as Schema & { items?: Schema }).items;
    assert.equal(propertiesOf(item).position?.type, "integer");
    assert.equal(propertiesOf(item).position?.nullable, true);
    assert.deepEqual(propertiesOf(item).priority?.enum, ["normal", "high"]);
  });
});

describe("AI Employees", () => {
  let mcp: Server;
  let mcpBase = "";
  let token = "";

  before(async () => {
    const internal = express();
    internal.use(express.json());
    internal.use("/internal/mcp", mcpInternalRouter);
    internal.use(errorHandler);
    await new Promise<void>((resolve) => {
      mcp = internal.listen(0, "127.0.0.1", resolve);
    });
    mcpBase = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (token) revokeMcpToken(token);
    mcp.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      mcp.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function tool(name: string, args: unknown) {
    if (token) revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const response = await fetch(`${mcpBase}/internal/mcp/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test("see their Routine's priority", async () => {
    await AppDataSource.getRepository(Routine).update(routine.id, { priority: "high" });
    const one = await tool("get_routine", { routineId: routine.id });
    assert.equal(one.status, 200);
    assert.equal((one.body.routine as { priority: string }).priority, "high");
    const list = await tool("list_routines", {});
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.routines as Array<{ id: string; priority: string }>).map((row) => row.priority),
      ["high"],
    );
  });

  test("cannot move their own work up the queue", async () => {
    const refused = await tool("update_routine", { routineId: routine.id, priority: "high" });
    assert.equal(refused.status, 400);
    assert.equal(await stored(), "normal");
    // Nothing else in the same call is applied either.
    const mixed = await tool("update_routine", {
      routineId: routine.id,
      name: "Renamed",
      priority: "high",
    });
    assert.equal(mixed.status, 400);
    const after = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(after.name, "Daily CRM Sync");
    assert.equal(after.priority, "normal");
  });
});
