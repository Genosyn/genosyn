import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, mock, test } from "node:test";
import express from "express";
import { UpdateQueryBuilder } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { gatherEmployeeTools, RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { REPOSITORY_SESSION_TOOLS } from "../services/repositoryWorkSessions.js";
import { issueDelegatedMcpToken, issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { markCurrentRunFailed, RunFailureReportError } from "../services/runFailureReport.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl: string;
let owner: User;
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let run: Run;
let token: string;
const tokens = new Set<string>();
const originalPort = config.port;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  for (const issued of tokens) revokeMcpToken(issued);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  mock.restoreAll();
  for (const issued of tokens) revokeMcpToken(issued);
  tokens.clear();
  await resetTestDb();
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review invoices",
    slug: "review-invoices",
    cronExpr: "0 9 * * *",
    body: "Reconcile the invoices.",
  });
  run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    finishedAt: null,
    failureReason: null,
    checksVerdict: "passed",
    outcomeVerdict: "achieved",
  });
  token = issue();
});

function issue(origin: Parameters<typeof issueMcpToken>[2] = {}): string {
  const issued = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
    ...origin,
  });
  tokens.add(issued);
  return issued;
}

async function tool(name: string, args: unknown = {}, bearer = token) {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("reports only its own Run, preserving the runner and independent grading", async () => {
  const sibling = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    finishedAt: null,
  });
  const check = await insert(RunCheckResult, {
    runId: run.id,
    companyId: company.id,
    name: "Evidence exists",
    kind: "effect",
    required: true,
    passed: true,
  });
  const response = await tool("mark_run_failed", {
    reason: "  Two invoices remain unreconciled.  ",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.failureReason, "Two invoices remain unreconciled.");
  const fresh = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
  assert.equal(fresh.failureReason, "Two invoices remain unreconciled.");
  assert.equal(fresh.status, "running");
  assert.equal(fresh.finishedAt, null);
  assert.equal(fresh.checksVerdict, "passed");
  assert.equal(fresh.outcomeVerdict, "achieved");
  assert.equal(
    (await AppDataSource.getRepository(RunCheckResult).findOneByOrFail({ id: check.id })).passed,
    true,
  );
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: sibling.id })).failureReason,
    null,
  );
});

test("requires a bounded reason and cannot accept a Run id or success mutation", async () => {
  for (const args of [
    {},
    { reason: "  \n\t" },
    { reason: "x".repeat(2001) },
    { reason: "Incomplete", runId: randomUUID() },
    { reason: "Incomplete", status: "completed" },
  ]) {
    assert.equal((await tool("mark_run_failed", args)).status, 400);
  }
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).failureReason,
    null,
  );
});

test("the first report wins concurrent calls and identical retries are idempotent", async () => {
  const results = await Promise.all([
    tool("mark_run_failed", { reason: "Missing invoices" }),
    tool("mark_run_failed", { reason: "Missing statements" }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const fresh = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
  assert.equal((await tool("mark_run_failed", { reason: ` ${fresh.failureReason} ` })).status, 200);
  assert.equal((await tool("mark_run_failed", { reason: "Changed my mind" })).status, 409);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).failureReason,
    fresh.failureReason,
  );
});

test("chat, external, Member, repository and delegated tokens cannot report a Routine failure", async () => {
  const child = issueDelegatedMcpToken(token);
  tokens.add(child);
  const denied = [
    issue({ runId: undefined, routineId: undefined }),
    issue({ runId: undefined }),
    issue({ routineId: undefined }),
    issue({ conversationId: randomUUID() }),
    issue({ repositoryWorkSessionId: randomUUID() }),
    issue({ authority: "untrusted" }),
    issue({
      authority: "member",
      requesterUserId: owner.id,
      requesterSessionVersion: owner.sessionVersion,
      runId: undefined,
      routineId: undefined,
    }),
    child,
  ];
  for (const deniedToken of denied) {
    assert.equal(
      (await tool("mark_run_failed", { reason: "Incomplete" }, deniedToken)).status,
      403,
    );
  }
  revokeMcpToken(token);
  assert.equal((await tool("mark_run_failed", { reason: "Incomplete" })).status, 401);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).failureReason,
    null,
  );
});

test("approved delivery Runs retain failure reporting and the Member is rechecked on every call", async () => {
  const approved = issue({
    authority: "member",
    requesterUserId: owner.id,
    requesterSessionVersion: owner.sessionVersion,
  });
  assert.equal(
    (await tool("mark_run_failed", { reason: "Approved work remains unfinished" }, approved))
      .status,
    200,
  );
  await AppDataSource.getRepository(Membership).delete({ companyId: company.id, userId: owner.id });
  assert.equal(
    (await tool("mark_run_failed", { reason: "Approved work remains unfinished" }, approved))
      .status,
    403,
  );
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  const staleSession = issue({
    authority: "member",
    requesterUserId: owner.id,
    requesterSessionVersion: owner.sessionVersion,
  });
  await AppDataSource.getRepository(User).update(owner.id, {
    sessionVersion: owner.sessionVersion + 1,
  });
  assert.equal(
    (await tool("mark_run_failed", { reason: "Approved work remains unfinished" }, staleSession))
      .status,
    403,
  );
});

test("ownership is checked live and another employee or company cannot supply Run provenance", async () => {
  const colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Robin",
    slug: "robin",
    role: "Ops",
    soulBody: "",
  });
  const colleagueToken = issueMcpToken(colleague.id, company.id, {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
  });
  tokens.add(colleagueToken);
  assert.equal(
    (await tool("mark_run_failed", { reason: "Incomplete" }, colleagueToken)).status,
    404,
  );
  assert.equal(
    (await tool("mark_run_failed", { reason: "Incomplete" }, issue({ routineId: randomUUID() })))
      .status,
    404,
  );
  await AppDataSource.getRepository(Routine).update(routine.id, { employeeId: colleague.id });
  assert.equal((await tool("mark_run_failed", { reason: "Incomplete" })).status, 404);
  await AppDataSource.getRepository(Routine).update(routine.id, { employeeId: employee.id });
  const foreignCompany = await insert(Company, {
    name: "Foreign",
    slug: "foreign",
    ownerId: owner.id,
  });
  const foreignEmployee = await insert(AIEmployee, {
    companyId: foreignCompany.id,
    name: "Foreign",
    slug: "foreign",
    role: "Ops",
    soulBody: "",
  });
  const foreignToken = issueMcpToken(foreignEmployee.id, foreignCompany.id, {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
  });
  tokens.add(foreignToken);
  assert.equal((await tool("mark_run_failed", { reason: "Incomplete" }, foreignToken)).status, 404);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).failureReason,
    null,
  );
});

test("terminal Runs and a running row with a finish timestamp reject reports", async () => {
  const runs = AppDataSource.getRepository(Run);
  for (const status of [
    "completed",
    "reviewed",
    "failed",
    "error",
    "timeout",
    "interrupted",
    "skipped",
  ] as const) {
    await runs.update(run.id, { status, finishedAt: new Date() });
    assert.equal((await tool("mark_run_failed", { reason: "Incomplete" })).status, 409, status);
  }
  await runs.update(run.id, { status: "running", finishedAt: new Date() });
  assert.equal((await tool("mark_run_failed", { reason: "Incomplete" })).status, 409);
  assert.equal((await runs.findOneByOrFail({ id: run.id })).failureReason, null);
});

test("completion or reassignment racing the write wins without changing its row", async () => {
  const execute = UpdateQueryBuilder.prototype.execute;
  for (const change of ["complete", "reassign"] as const) {
    await AppDataSource.getRepository(Run).update(run.id, { status: "running", finishedAt: null });
    const intercepted = mock.method(
      UpdateQueryBuilder.prototype,
      "execute",
      async function (this: UpdateQueryBuilder<Run>) {
        intercepted.mock.restore();
        if (change === "complete") {
          await AppDataSource.getRepository(Run).update(run.id, {
            status: "completed",
            finishedAt: new Date(),
          });
        } else {
          await AppDataSource.getRepository(Routine).update(routine.id, {
            employeeId: randomUUID(),
          });
        }
        return execute.call(this);
      },
    );
    await assert.rejects(
      markCurrentRunFailed(token, "Incomplete"),
      (error: unknown) =>
        error instanceof RunFailureReportError &&
        error.status === (change === "complete" ? 409 : 404),
    );
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).failureReason,
      null,
    );
  }
});

test("review scopes can report their own failure without gaining broader writes", async () => {
  await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
  for (const scope of [{ selfReviewOnly: true }, { proactiveReview: true }]) {
    const scopedToken = issue(scope);
    assert.equal(
      (await tool("mark_run_failed", { reason: "Review evidence unavailable" }, scopedToken))
        .status,
      200,
    );
    assert.equal(
      (await tool("update_routine", { routineId: routine.id, name: "Changed" }, scopedToken))
        .status,
      403,
    );
  }
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).name,
    routine.name,
  );
});

test("failure reporting is deferred and restricted before discovery, including scoped turns", async () => {
  const spec = STATIC_TOOLS.find((entry) => entry.name === "mark_run_failed")!;
  assert.ok(spec);
  assert.notEqual(spec.readOnly, true);
  assert.equal(RESIDENT_GENOSYN_TOOLS.includes(spec.name), false);
  assert.deepEqual(spec.inputSchema.required, ["reason"]);
  const child = issueDelegatedMcpToken(token);
  tokens.add(child);
  for (const [issued, expected, surface] of [
    [token, "deferred", undefined],
    [issue({ proactiveReview: true }), "deferred", undefined],
    [issue({ selfReviewOnly: true }), "resident", undefined],
    [issue({ runId: undefined, routineId: undefined }), undefined, undefined],
    [child, undefined, undefined],
    [
      issue({ repositoryWorkSessionId: randomUUID() }),
      undefined,
      { genosynTools: [...REPOSITORY_SESSION_TOOLS], surfaceOnly: true },
    ],
  ] as const) {
    const gathered = await gatherEmployeeTools({
      employeeId: employee.id,
      genosynToken: issued,
      cwd: "/unused-failure-test",
      toolEnv: {},
      bashTimeoutMs: 1000,
      allowPrivilegedToolSources: false,
      toolScope: surface ? { ...surface, genosynTools: [...surface.genosynTools] } : undefined,
    });
    try {
      assert.equal(gathered.registry.visibility(spec.name), expected);
      assert.equal(!!gathered.registry.resolve(spec.name), expected !== undefined);
      assert.equal(
        gathered.registry.searchable.some((entry) => entry.name === spec.name),
        expected === "deferred",
      );
    } finally {
      await gathered.close();
    }
  }
});

test("Run readers include Error and expose the employee's failure separately from grading", async () => {
  await AppDataSource.getRepository(Run).update(run.id, {
    status: "error",
    errorKind: "timeout",
    failureReason: "Source data unavailable",
    finishedAt: new Date(),
  });
  const listed = await tool("list_runs");
  assert.equal(listed.status, 200);
  const row = (listed.body.runs as Array<Record<string, unknown>>)[0];
  assert.equal(row.status, "error");
  assert.equal(row.errorKind, "timeout");
  assert.equal(row.failureReason, "Source data unavailable");
  const reported = await tool("get_run_report", { runId: run.id });
  assert.equal(reported.status, 200);
  assert.equal(
    (reported.body.run as Record<string, unknown>).failureReason,
    "Source data unavailable",
  );
  assert.equal((reported.body.run as Record<string, unknown>).outcomeVerdict, "achieved");
});
