import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { AppDataSource } from "../../../db/datasource.js";
import { AIEmployee } from "../../../db/entities/AIEmployee.js";
import { Routine } from "../../../db/entities/Routine.js";
import { Run } from "../../../db/entities/Run.js";
import { EmployeeConnectionGrant } from "../../../db/entities/EmployeeConnectionGrant.js";
import { Channel } from "../../../db/entities/Channel.js";
import { Conversation } from "../../../db/entities/Conversation.js";
import { Membership } from "../../../db/entities/Membership.js";
import { McpServer } from "../../../db/entities/McpServer.js";
import { User } from "../../../db/entities/User.js";
import { ParallelWorkerResult } from "../../../db/entities/ParallelWorkerResult.js";
import {
  initTestDb,
  resetTestDb,
  closeTestDb,
  insert,
  testCompanyId,
  testId,
} from "../../../test/dbHarness.js";
import { issueMcpToken, revokeMcpToken } from "../../mcpTokens.js";
import { captureRecoveryGrants, resolveRecoveryScope } from "../workRecoveryScope.js";
import { createDurableParallelResultStore } from "./durableWorkerResults.js";
import {
  createParallelDelegationTool,
  createParallelWorkResultTool,
} from "./parallelDelegation.js";

let companyId: string;
let employee: AIEmployee;
let routine: Routine;
let parent: Run;
const tokens: string[] = [];
before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, { companyId, name: "Ada", slug: "ada", role: "Analyst" });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Research",
    slug: "research",
    cronExpr: "0 9 * * *",
    body: "Read evidence",
  });
  parent = await insert(Run, { routineId: routine.id, startedAt: new Date(), status: "running" });
});
after(async () => {
  tokens.forEach(revokeMcpToken);
  await closeTestDb();
});
async function storeFor(run: Run) {
  const token = issueMcpToken(employee.id, companyId, {
    authority: "employee",
    runId: run.id,
    routineId: run.routineId,
  });
  tokens.push(token);
  const scope = await resolveRecoveryScope(token);
  assert.ok(scope);
  return { token, store: createDurableParallelResultStore(token, scope) };
}
const brief = { label: "Evidence", instruction: "Read the requested evidence once" };

test("a completed worker survives parent timeout and a recreated retry store without rerunning", async () => {
  const first = await storeFor(parent);
  const resultId = await first.store.reserve(brief.label, brief);
  assert.ok(resultId);
  await first.store.finish(resultId, {
    status: "completed",
    output: "completed independent evidence",
  });
  revokeMcpToken(first.token);
  await AppDataSource.getRepository(Run).update(parent.id, {
    status: "error",
    errorKind: "timeout",
  });
  const retry = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    triggerKind: "retry",
    parentRunId: parent.id,
  });
  const next = await storeFor(retry);
  assert.equal((await next.store.read(resultId, 0, 100))?.text, "completed independent evidence");
  let calls = 0;
  const tool = createParallelDelegationTool({
    budget: { remaining: 12 },
    resultStore: next.store,
    runBrief: async () => {
      calls++;
      return { status: "completed", output: "duplicate" };
    },
  });
  assert.match((await tool.run({ tasks: [brief] })).content, /completed independent evidence/);
  assert.equal(calls, 0);
  assert.equal(await AppDataSource.getRepository(ParallelWorkerResult).count(), 1);
});

test("completed evidence can be saved after the parent token has been revoked", async () => {
  const first = await storeFor(parent);
  const id = await first.store.reserve(brief.label, brief);
  assert.ok(id);
  revokeMcpToken(first.token);
  await first.store.finish(id, {
    status: "completed",
    output: "finished before cancellation settled",
  });
  const next = await storeFor(parent);
  assert.equal((await next.store.read(id, 0, 100))?.text, "finished before cancellation settled");
});

test("duplicates in one batch and later in the same turn never execute twice or overwrite the winner", async () => {
  const { store } = await storeFor(parent);
  let calls = 0;
  const tool = createParallelDelegationTool({
    budget: { remaining: 12 },
    resultStore: store,
    runBrief: async () => {
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      return { status: "completed", output: "one effect only" };
    },
  });
  await tool.run({ tasks: [brief, brief] });
  await tool.run({ tasks: [brief] });
  assert.equal(calls, 1);
  const [row] = await AppDataSource.getRepository(ParallelWorkerResult).find();
  assert.equal(row.status, "completed");
  assert.equal(row.output, "one effect only");
});

test("an aborted duplicate that never starts cannot overwrite completed evidence", async () => {
  const { store } = await storeFor(parent);
  const controller = new AbortController();
  let calls = 0;
  const tool = createParallelDelegationTool({
    budget: { remaining: 12 },
    resultStore: store,
    signal: controller.signal,
    runBrief: async () => {
      calls++;
      controller.abort();
      return { status: "completed", output: "completed before abort" };
    },
  });
  await tool.run({ tasks: [brief, brief], maxConcurrency: 1 });
  assert.equal(calls, 1);
  const [row] = await AppDataSource.getRepository(ParallelWorkerResult).find();
  assert.equal(row.status, "completed");
  assert.equal(row.output, "completed before abort");
});

test("another occurrence, employee, company or broken lineage cannot recover a known result", async () => {
  const first = await storeFor(parent);
  const id = await first.store.reserve(brief.label, brief);
  assert.ok(id);
  await first.store.finish(id, { status: "completed", output: "private evidence" });
  const unrelated = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    triggerKind: "schedule",
    parentRunId: parent.id,
  });
  const other = await storeFor(unrelated);
  assert.equal(await other.store.read(id, 0, 100), null);
  for (const identity of [
    { employeeId: testId("other"), companyId },
    { employeeId: employee.id, companyId: testId("other-company") },
  ]) {
    const token = issueMcpToken(identity.employeeId, identity.companyId, {
      authority: "employee",
      runId: parent.id,
      routineId: routine.id,
    });
    tokens.push(token);
    assert.equal(await resolveRecoveryScope(token), null);
  }
  const broken = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "running",
    triggerKind: "retry",
    parentRunId: testId("missing"),
  });
  await assert.rejects(storeFor(broken), /lineage could not be verified/);
});

test("original and newly observed Grants are required when recovering persisted output", async () => {
  const original = await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: testId("original"),
  });
  const { store } = await storeFor(parent);
  const id = await store.reserve(brief.label, brief);
  assert.ok(id);
  const added = await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: testId("added"),
  });
  await store.captureGrants!(id, await captureRecoveryGrants(companyId, employee.id));
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete(added.id);
  await store.finish(id, { status: "completed", output: "evidence from the temporary Grant" });
  assert.equal(await store.read(id, 0, 100), null);
  assert.deepEqual(await store.list(), []);
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete(original.id);
  assert.equal(await store.read(id, 0, 100), null);
});

test("a public Channel becoming private withholds saved evidence without a membership Grant", async () => {
  const channel = await insert(Channel, {
    companyId,
    kind: "public",
    name: "Planning",
    slug: "planning",
  });
  const { store } = await storeFor(parent);
  const id = await store.reserve(brief.label, brief);
  assert.ok(id);
  await store.finish(id, { status: "completed", output: "Channel evidence" });
  assert.equal((await store.read(id, 0, 100))?.text, "Channel evidence");
  await AppDataSource.getRepository(Channel).update(channel.id, { kind: "private" });
  assert.equal(await store.read(id, 0, 100), null);
});

test("conversation recovery remains private to its requester and live administrative authority", async () => {
  const user = await insert(User, {
    email: "admin@example.test",
    passwordHash: "unused",
    name: "Admin",
  });
  const membership = await insert(Membership, { userId: user.id, companyId, role: "admin" });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: user.id,
  });
  const issue = (conversationId: string, requesterUserId = user.id) => {
    const token = issueMcpToken(employee.id, companyId, {
      authority: "member",
      conversationId,
      requesterUserId,
      requesterSessionVersion: user.sessionVersion,
    });
    tokens.push(token);
    return token;
  };
  const token = issue(conversation.id);
  const scope = await resolveRecoveryScope(token);
  assert.ok(scope);
  const store = createDurableParallelResultStore(token, scope);
  const id = await store.reserve(brief.label, brief);
  assert.ok(id);
  await store.finish(id, { status: "completed", output: "Member-private evidence" });
  const secondToken = issue(conversation.id);
  const same = await resolveRecoveryScope(secondToken);
  assert.ok(same);
  assert.equal(
    (await createDurableParallelResultStore(secondToken, same).read(id, 0, 100))?.text,
    "Member-private evidence",
  );
  const other = await insert(Conversation, { employeeId: employee.id, ownerUserId: user.id });
  const otherToken = issue(other.id);
  const otherScope = await resolveRecoveryScope(otherToken);
  assert.ok(otherScope);
  assert.equal(
    await createDurableParallelResultStore(otherToken, otherScope).read(id, 0, 100),
    null,
  );
  assert.equal(await resolveRecoveryScope(issue(conversation.id, testId("other-member"))), null);
  await AppDataSource.getRepository(User).update(user.id, {
    sessionVersion: user.sessionVersion + 1,
  });
  assert.equal(await store.read(id, 0, 100), null);
  await AppDataSource.getRepository(User).update(user.id, { sessionVersion: user.sessionVersion });
  await AppDataSource.getRepository(Membership).update(membership.id, { role: "member" });
  assert.equal(await store.read(id, 0, 100), null);
});

test("durable listings expose continuation offsets across parent turns", async () => {
  for (let turn = 0; turn < 2; turn++) {
    const { store } = await storeFor(parent);
    for (let index = 0; index < 8; index++) {
      const item = { label: `${turn}-${index}`, instruction: `Evidence ${turn}-${index}` };
      const id = await store.reserve(item.label, item);
      assert.ok(id);
      await store.finish(id, { status: "completed", output: item.instruction });
    }
  }
  const { store } = await storeFor(parent);
  const reader = createParallelWorkResultTool(store);
  const first = JSON.parse((await reader.run({})).content);
  assert.equal(first.results.length, 12);
  assert.equal(first.coverage.total, 16);
  assert.equal(first.coverage.nextOffset, 12);
  const second = JSON.parse((await reader.run({ offset: first.coverage.nextOffset })).content);
  assert.equal(second.results.length, 4);
  assert.equal(second.coverage.nextOffset, null);
  assert.equal(new Set([...first.results, ...second.results].map((row) => row.resultId)).size, 16);
});

test("disabling or reconfiguring an employee MCP source withholds its former worker evidence", async () => {
  const source = await insert(McpServer, {
    employeeId: employee.id,
    name: "Evidence source",
    transport: "http",
    url: "https://example.test/mcp",
    enabled: true,
    envJson: '{"TOKEN":"must-not-be-persisted"}',
  });
  const { store } = await storeFor(parent);
  const id = await store.reserve(brief.label, brief);
  assert.ok(id);
  await store.finish(id, { status: "completed", output: "Evidence from a configured MCP server" });
  const saved = await AppDataSource.getRepository(ParallelWorkerResult).findOneByOrFail({ id });
  assert.doesNotMatch(saved.grantsJson, /must-not-be-persisted|example.test/);
  assert.equal((await store.read(id, 0, 100))?.status, "completed");
  await AppDataSource.getRepository(McpServer).update(source.id, {
    url: "https://other.example.test/mcp",
  });
  assert.equal(await store.read(id, 0, 100), null);
  await AppDataSource.getRepository(McpServer).update(source.id, {
    url: source.url,
    enabled: false,
  });
  assert.equal(await store.read(id, 0, 100), null);
});
