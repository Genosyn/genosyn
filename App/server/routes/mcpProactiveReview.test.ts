import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Decision } from "../db/entities/Decision.js";
import { DecisionPolicy } from "../db/entities/DecisionPolicy.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { McpServer } from "../db/entities/McpServer.js";
import { Membership } from "../db/entities/Membership.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { errorHandler } from "../middleware/error.js";
import { gatherEmployeeTools } from "../services/agent/tools/index.js";
import { kickoffDecision } from "../services/decisionKickoff.js";
import { decideDecision } from "../services/decisions.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { PROACTIVE_REVIEW_TOOLS } from "../services/proactive/workReviewPolicy.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type Origin = NonNullable<Parameters<typeof issueMcpToken>[2]>;
const testConfig = config as unknown as { port: number };
const originalPort = config.port;
const originalAllowlist = [...config.security.outboundPrivateHostAllowlist];
let server: Server;
let baseUrl: string;
let token: string;
const tokens = new Set<string>();
let company: Company;
let owner: User;
let employee: AIEmployee;
let routine: Routine;
let run: Run;
let configuredMcpRequests = 0;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.post("/configured-mcp", (_req, res) => {
    configuredMcpRequests += 1;
    res.status(500).json({ error: "Review must not reach configured MCP servers." });
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  testConfig.port = (server.address() as AddressInfo).port;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${testConfig.port}/api/internal/mcp`;
});

after(async () => {
  for (const value of tokens) revokeMcpToken(value);
  testConfig.port = originalPort;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...originalAllowlist);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await closeTestDb();
});

beforeEach(async () => {
  for (const value of tokens) revokeMcpToken(value);
  tokens.clear();
  configuredMcpRequests = 0;
  await resetTestDb();
  owner = await insert(User, {
    email: "proactive-owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, {
    name: "Review first",
    slug: randomUUID(),
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    role: "Customer support",
    slug: randomUUID(),
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review customer requests",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    body: "Read new requests and propose useful work.",
  });
  run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    triggerKind: "event",
  });
  token = mint();
});

function mint(origin: Origin = {}): string {
  const value = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    proactiveReview: true,
    runId: run.id,
    routineId: routine.id,
    ...origin,
  });
  tokens.add(value);
  return value;
}

async function request<T = Record<string, unknown>>(
  path: string,
  args: unknown = {},
  bearer: string | null = token,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const tool = <T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
  bearer: string | null = token,
) => request<T>(`/tools/${name}`, args, bearer);

async function assertNoWorkStarted(): Promise<void> {
  assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 0);
  assert.equal(await AppDataSource.getRepository(EmployeeWakeup).count(), 0);
  assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
  assert.equal(await AppDataSource.getRepository(Contact).count(), 0);
  assert.equal(await AppDataSource.getRepository(Workstream).count(), 0);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).body,
    routine.body,
  );
}

test("proactive review rejects edits, code work, delivery and deferred work before their handlers", async () => {
  for (const name of [
    "start_repository_work_session",
    "continue_repository_work_session",
    "open_repository_work_session_pull_request",
    "repository_write_file",
    "repository_run_command",
    "create_mail_draft",
    "update_mail_draft",
    "send_mail",
    "mail_unsubscribe",
    "mail_block_sender",
    "create_contact",
    "update_contact",
    "create_estimate",
    "create_note",
    "update_routine",
    "create_workstream",
    "update_workstream",
    "schedule_wakeup",
    "handoff",
    "delegate_parallel_work",
    "run_pipeline",
    "propose_initiative",
    "decide_decision",
    "cancel_decision",
    "bash",
    "write_file",
    "call_tool",
    "alias_send_mail",
    "google_send_message",
    "future_unknown_tool",
  ]) {
    const result = await tool<{ error: string }>(name, { proactiveReview: false });
    assert.equal(result.status, 403, `${name} reached validation or its handler`);
    assert.match(result.body.error, /approval/i);
  }
  assert.equal(
    (await tool("update_routine", { routineId: routine.id, body: "Act without review" })).status,
    403,
  );
  await assertNoWorkStarted();
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
});

test("proactive review exposes no Integration tools and rejects alternate invocation paths", async () => {
  const listing = await request("/integrations/_list");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body, { tools: [] });
  for (const path of [
    "/integrations/invoke",
    "/integrations/google_send_mail",
    "/integrations/_list/invoke",
    "/tools/create_contact/extra",
    "/tools/request_decision/invoke",
  ]) {
    const result = await request(path, {
      connectionId: randomUUID(),
      toolName: "send_message",
      args: {},
    });
    assert.equal(result.status, 403, path);
  }
  await assertNoWorkStarted();
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("the review can read evidence while token authentication remains required", async () => {
  assert.equal((await tool("get_self")).status, 200);
  assert.equal((await tool("list_decisions")).status, 200);
  assert.equal((await tool("get_self", {}, null)).status, 401);
  assert.equal((await tool("get_self", {}, mint({ authority: "untrusted" }))).status, 403);
  await assertNoWorkStarted();
});

test("the model registry cannot widen a proactive token with local tools, Skills or a broader scope", async () => {
  await AppDataSource.getRepository(AIEmployee).update(employee.id, { browserEnabled: true });
  await insert(McpServer, {
    employeeId: employee.id,
    name: "external-work",
    transport: "http",
    url: `http://127.0.0.1:${testConfig.port}/configured-mcp`,
    enabled: true,
  });
  let localCalls = 0;
  const gathered = await gatherEmployeeTools({
    employeeId: employee.id,
    genosynToken: token,
    cwd: "/unused-proactive-review-workspace",
    toolEnv: {},
    bashTimeoutMs: 1_000,
    allowPrivilegedToolSources: true,
    toolScope: { genosynTools: ["send_mail", "start_repository_work_session"], surfaceOnly: false },
    skillToolset: [
      "send_mail",
      "create_mail_draft",
      "start_repository_work_session",
      "send_direct",
    ],
    localTools: [
      {
        name: "send_direct",
        description: "A wider surface must not add this tool to a review.",
        inputSchema: {},
        readOnly: true,
        run: async () => {
          localCalls += 1;
          return { content: "unexpected work" };
        },
      },
    ],
  });
  try {
    const names = [...gathered.registry.all.keys()];
    assert.ok(gathered.registry.resident.some((entry) => entry.name === "request_work_review"));
    assert.ok(
      names.every(
        (name) =>
          (PROACTIVE_REVIEW_TOOLS as readonly string[]).includes(name) ||
          name === "find_tools" ||
          name === "call_tool",
      ),
    );
    assert.equal(gathered.browser.enabled, false);
    assert.equal(configuredMcpRequests, 0);
    assert.equal(await AppDataSource.getRepository(BrowserSession).count(), 0);
    assert.ok(gathered.registry.searchable.length > 0, "Read-only discovery should still work");
    const dispatch = gathered.registry.resolve("call_tool");
    assert.ok(dispatch, "Read-only discovery needs a dispatcher");
    for (const name of [
      "create_mail_draft",
      "send_mail",
      "start_repository_work_session",
      "schedule_wakeup",
      "send_direct",
      "delegate_parallel_work",
      "bash",
      "read_file",
      "browser_navigate",
      "mail",
      "external-work_send_message",
    ]) {
      assert.equal(gathered.registry.resolve(name), undefined, name);
      const result = await dispatch.run({ name, args_json: "{}" });
      assert.equal(result.isError, true, `${name} escaped deferred dispatch`);
    }
    assert.equal(localCalls, 0);
    const evidence = await gathered.registry.resolve("get_self")!.run({});
    assert.equal(evidence.isError, false);
    await assertNoWorkStarted();
  } finally {
    await gathered.close();
  }
});

test("a complete plan queues one pending work Approval without performing the proposed work", async () => {
  const args = {
    title: "Investigate Acme's checkout bug",
    context:
      "Acme reported checkout failing after yesterday's release; confirm impact before changing it.",
    plan: "Inspect the granted Repository, reproduce the reported failure, prepare a focused fix and relevant tests, then leave the branch for Member review. Draft a customer update without sending it.",
  };
  for (const invalid of [
    { ...args, title: "   " },
    { ...args, plan: "" },
    { ...args, origin: { routineId: randomUUID(), proactiveReview: false } },
    { ...args, employeeId: randomUUID() },
  ]) {
    assert.equal((await tool("request_work_review", invalid)).status, 400);
  }
  assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
  const created = await tool<{ approvalId: string; status: string }>(
    "request_work_review",
    args,
    mint({ mailDeliveryMode: "draft" }),
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.status, "pending");
  const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
    id: created.body.approvalId,
  });
  assert.equal(approval.companyId, company.id);
  assert.equal(approval.employeeId, employee.id);
  assert.equal(approval.kind, "proactive_work");
  assert.equal(approval.status, "pending");
  assert.equal(approval.decidedByUserId, null);
  assert.equal(approval.resultJson, null);
  assert.equal(approval.title, args.title);
  const payload = JSON.parse(approval.payloadJson!) as {
    context: string;
    plan: string;
    origin: { routineId: string; runId: string; mailDeliveryMode: string };
  };
  assert.equal(payload.context, args.context);
  assert.equal(payload.plan, args.plan);
  assert.equal(payload.origin.routineId, routine.id);
  assert.equal(payload.origin.runId, run.id);
  assert.equal(payload.origin.mailDeliveryMode, "draft");
  const listed = await tool<Array<{ id: string; status: string }>>("list_work_reviews");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((review) => [review.id, review.status]),
    [[approval.id, "pending"]],
  );
  await assertNoWorkStarted();
});

test("review submission cannot be invoked from an ordinary employee turn or a review-only self assessment", async () => {
  const args = {
    title: "Send a customer update",
    context: "A customer is waiting for an update.",
    plan: "Read the evidence and prepare a reply.",
  };
  const ordinary = mint({ proactiveReview: false });
  assert.equal((await tool("request_work_review", args, ordinary)).status, 403);
  const selfReview = mint({ selfReviewOnly: true });
  assert.equal((await tool("request_work_review", args, selfReview)).status, 403);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
  await assertNoWorkStarted();
});

test("a review Decision stays human-only and answering it cannot start a pickup session", async () => {
  const decider = await insert(AIEmployee, {
    companyId: company.id,
    name: "Manager",
    role: "Manager",
    slug: randomUUID(),
  });
  await insert(DecisionPolicy, {
    companyId: company.id,
    askingEmployeeId: employee.id,
    deciderKind: "employee",
    deciderEmployeeId: decider.id,
    enabled: true,
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  const args = {
    title: "Confirm Acme's support deadline",
    body: "Acme asks when to expect a response. Which date did we promise?",
    options: [
      { label: "Use the date in my note", detail: "Add the date and its source in the note." },
      { label: "No date was promised" },
    ],
  };
  assert.equal(
    (await tool("request_decision", { ...args, automaticContinuation: true })).status,
    400,
  );
  const created = await tool<{ decisionId: string; options: Array<{ id: string }> }>(
    "request_decision",
    args,
  );
  assert.equal(created.status, 200);
  const beforeAnswer = await AppDataSource.getRepository(Decision).findOneByOrFail({
    id: created.body.decisionId,
  });
  assert.equal(beforeAnswer.status, "pending");
  assert.equal(beforeAnswer.pickupStatus, "skipped");
  assert.equal(beforeAnswer.routedToEmployeeId, null);
  assert.equal(beforeAnswer.runId, run.id);
  const answered = await decideDecision({
    companyId: company.id,
    decisionId: beforeAnswer.id,
    userId: owner.id,
    role: "owner",
    optionId: created.body.options[0].id,
    note: "18 September, agreed in the signed support contract.",
  });
  assert.equal(answered.outcome, "decided");
  let pickupCalls = 0;
  await kickoffDecision({
    companyId: company.id,
    decisionId: beforeAnswer.id,
    requesterUserId: owner.id,
    requesterSessionVersion: owner.sessionVersion,
    runChat: async () => {
      pickupCalls += 1;
      throw new Error("A review answer must not start work");
    },
  });
  const afterAnswer = await AppDataSource.getRepository(Decision).findOneByOrFail({
    id: beforeAnswer.id,
  });
  assert.equal(pickupCalls, 0);
  assert.equal(afterAnswer.pickupStatus, "skipped");
  assert.equal(afterAnswer.pickupStartedAt, null);
  assert.equal(afterAnswer.note, "18 September, agreed in the signed support contract.");
  await assertNoWorkStarted();
});
