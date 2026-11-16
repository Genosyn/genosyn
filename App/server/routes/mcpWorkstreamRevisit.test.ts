import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { proactiveId } from "../services/proactive/ids.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * An AI Employee plans when its Workstreams next need a look through the same
 * two tools it already keeps them with — including inside a Proactive starter's
 * preparation scope, which is where Follow through on open work runs and the
 * only place its next start can come from.
 */

type Origin = NonNullable<Parameters<typeof issueMcpToken>[2]>;
let server: Server;
let baseUrl: string;
const tokens = new Set<string>();
let company: Company;
let employee: AIEmployee;
let starter: Routine;
let starterRun: Run;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp`;
});

after(async () => {
  for (const value of tokens) revokeMcpToken(value);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  for (const value of tokens) revokeMcpToken(value);
  tokens.clear();
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, { name: "Revisit Co", slug: randomUUID(), ownerId: owner.id });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    role: "Operations",
    slug: randomUUID(),
    soulBody: "",
  });
  starter = await insert(Routine, {
    id: proactiveId(company.id, employee.id, "work-followthrough", null),
    employeeId: employee.id,
    name: "Follow through on open work",
    slug: randomUUID(),
    cronExpr: "*/30 * * * *",
    body: "Resume due Workstreams.",
    mailDeliveryMode: "draft",
    runCondition: "workstream_due",
  });
  starterRun = await insert(Run, {
    routineId: starter.id,
    employeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
});

function mint(origin: Origin = {}): string {
  const value = issueMcpToken(employee.id, company.id, { authority: "employee", ...origin });
  tokens.add(value);
  return value;
}

/** The token Follow through on open work's own Run holds: preparation only. */
const starterToken = () =>
  mint({
    runId: starterRun.id,
    routineId: starter.id,
    mailDeliveryMode: "draft",
    proactiveReview: true,
  });

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown,
  bearer: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type WorkstreamBody = { workstream: { id: string; revisitAt: string | null }; note: string };
const row = (id: string) => AppDataSource.getRepository(Workstream).findOneByOrFail({ id });

test("both tools publish revisitAt as an optional, nullable time", () => {
  for (const name of ["create_workstream", "update_workstream"]) {
    const spec = STATIC_TOOLS.find((entry) => entry.name === name)!;
    const property = spec.inputSchema.properties.revisitAt as {
      type: string[];
      description: string;
    };
    assert.deepEqual(property.type, ["string", "null"], name);
    assert.match(property.description, /ISO 8601/, name);
    assert.match(property.description, /Follow through on open work starts only/, name);
    assert.equal(spec.inputSchema.required?.includes("revisitAt") ?? false, false, name);
  }
});

test("an employee opens work with a revisit and is told what it planned", async () => {
  const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const created = await tool<WorkstreamBody>(
    "create_workstream",
    { title: "Watch the invoice fix", revisitAt: at },
    mint(),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.workstream.revisitAt, at);
  assert.match(created.body.note, new RegExp(`Next revisit ${at.replace(/\./g, "\\.")}`));
  assert.deepEqual((await row(created.body.workstream.id)).revisitAt, new Date(at));

  const unplanned = await tool<WorkstreamBody>(
    "create_workstream",
    { title: "Wait for the customer" },
    mint(),
  );
  assert.equal(unplanned.status, 200);
  assert.equal(unplanned.body.workstream.revisitAt, null);
  assert.match(unplanned.body.note, /No revisit is planned/);
});

test("Follow through on open work can plan, move and clear revisits in its preparation scope", async () => {
  const work = await insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Check the Work session",
    revisitAt: new Date(Date.now() - 60_000),
  });
  const token = starterToken();
  const due = new Date(Date.now() - 1_000).toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();

  const planned = await tool<WorkstreamBody>(
    "update_workstream",
    { workstreamId: work.id, stateDoc: "Session still running.", revisitAt: later },
    token,
  );
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(planned.body.workstream.revisitAt, later);
  assert.match(planned.body.note, /Next revisit/);
  assert.equal((await row(work.id)).lastRunId, starterRun.id);

  const soonest = await tool<WorkstreamBody>(
    "update_workstream",
    { workstreamId: work.id, revisitAt: due },
    token,
  );
  assert.equal(soonest.status, 200);
  assert.match(soonest.body.note, /\(due now\)/);
  assert.equal((await row(work.id)).stateDoc, "Session still running.", "planning alone keeps it");

  const waiting = await tool<WorkstreamBody>(
    "update_workstream",
    { workstreamId: work.id, revisitAt: null },
    token,
  );
  assert.equal(waiting.status, 200);
  assert.equal((await row(work.id)).revisitAt, null);
  assert.match(waiting.body.note, /No revisit is planned/);

  const opened = await tool<WorkstreamBody>(
    "create_workstream",
    { title: "New follow-up", revisitAt: later },
    token,
  );
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.workstream.revisitAt, later);
});

test("a revisit that is not a time, or too far away, is refused and writes nothing", async () => {
  const work = await insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Work",
    stateDoc: "Before",
  });
  for (const revisitAt of ["next Tuesday", "", "2099-01-01T00:00:00Z"]) {
    const refused = await tool<{ error: string }>(
      "update_workstream",
      { workstreamId: work.id, stateDoc: "After", revisitAt },
      mint(),
    );
    assert.equal(refused.status, 400, revisitAt);
    assert.match(refused.body.error, /revisitAt/, revisitAt);
    const created = await tool<{ error: string }>(
      "create_workstream",
      { title: "Never made", revisitAt },
      mint(),
    );
    assert.equal(created.status, 400, revisitAt);
  }
  const unchanged = await row(work.id);
  assert.equal(unchanged.stateDoc, "Before");
  assert.equal(unchanged.revisitAt, null);
  assert.equal(await AppDataSource.getRepository(Workstream).countBy({ title: "Never made" }), 0);
  const wrongType = await tool(
    "update_workstream",
    { workstreamId: work.id, revisitAt: 5 },
    mint(),
  );
  assert.equal(wrongType.status, 400);
});

test("review tracking is never followed up, so its writes say nothing about revisits", async () => {
  const review = await insert(Routine, {
    id: proactiveId(company.id, employee.id, "improve-own-work", null),
    employeeId: employee.id,
    name: "Improve my work",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  const reviewRun = await insert(Run, {
    routineId: review.id,
    employeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
  const token = mint({ selfReviewOnly: true, runId: reviewRun.id, routineId: review.id });
  const created = await tool<WorkstreamBody>("create_workstream", { title: "My review" }, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.note, "Workstream opened.");
});
