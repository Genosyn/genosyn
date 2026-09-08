import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Skill } from "../db/entities/Skill.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "../services/agent/tools/toolIndex.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { proactiveId } from "../services/proactive/ids.js";
import { WORK_REVIEW_PACKET_MAX_CHARS } from "../services/proactive/reviewPacketBudget.js";
import type { getOwnWorkReview } from "../services/proactive/workReview.js";
import { workSummaryLogLine } from "../services/runWorkSummary.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type Origin = NonNullable<Parameters<typeof issueMcpToken>[2]>;
type Review = Awaited<ReturnType<typeof getOwnWorkReview>>;
let server: Server;
let baseUrl: string;
let token: string;
const tokens = new Set<string>();
let company: Company;
let owner: User;
let employee: AIEmployee;
let reviewRoutine: Routine;
let businessRoutine: Routine;
let reviewRun: Run;
let evidence: Run;
let skill: Skill;

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
  owner = await insert(User, {
    email: "review-owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, {
    name: "Review Company",
    slug: randomUUID(),
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    role: "Operations",
    slug: randomUUID(),
    soulBody: "Keep the original Soul and its authority.",
  });
  reviewRoutine = await insert(Routine, {
    id: proactiveId(company.id, employee.id, "improve-own-work", null),
    employeeId: employee.id,
    name: "Improve own work",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    selfReviewOnly: true,
  });
  businessRoutine = await insert(Routine, {
    employeeId: employee.id,
    name: "Weekly report",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    body: "Write the report.",
    acceptanceCriteria: "Include accurate comparisons.",
  });
  reviewRun = await insert(Run, {
    routineId: reviewRoutine.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
  evidence = await insert(Run, {
    routineId: businessRoutine.id,
    status: "completed",
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 60_000),
    outcomeVerdict: "unverified",
    logContent: workSummaryLogLine("Prepared the report."),
  });
  skill = await insert(Skill, {
    employeeId: employee.id,
    name: "Prepare reports",
    slug: randomUUID(),
    body: "The original playbook.",
  });
  token = mint();
});

function mint(origin: Origin = {}, employeeId = employee.id, companyId = company.id): string {
  const value = issueMcpToken(employeeId, companyId, {
    authority: "employee",
    selfReviewOnly: true,
    runId: reviewRun.id,
    routineId: reviewRoutine.id,
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
const ownTracking = (values: Partial<Workstream> = {}) =>
  insert(Workstream, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Private review tracking",
    routineId: reviewRoutine.id,
    stateDoc: "PRIVATE-REVIEW-STATE",
    ...values,
  });
const proposal = (values: Record<string, unknown> = {}) => ({
  kind: "soul",
  proposedBody:
    "Keep the original Soul and its authority. Compare report figures before publishing.",
  rationale: "The report needs a consistent comparison step.",
  evidenceRunIds: [evidence.id],
  ...values,
});

test("the own-work evidence tool is strict, published and deferred in discovery", async () => {
  const manifest = await request<{ tools: Array<{ name: string }> }>("/manifest");
  assert.equal(manifest.status, 200);
  assert.ok(manifest.body.tools.some((entry) => entry.name === "get_own_work_review"));
  const definition = STATIC_TOOLS.find((entry) => entry.name === "get_own_work_review")!;
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.inputSchema.properties, {});
  assert.equal(
    (RESIDENT_GENOSYN_TOOLS as readonly string[]).includes("get_own_work_review"),
    false,
  );
  assert.ok(
    Object.values(TOOL_DOMAINS).some((domain) => domain.tools.includes("get_own_work_review")),
  );
  assert.ok(TOOL_KEYWORDS.get_own_work_review.length > 0);
  for (const args of [
    { employeeId: randomUUID() },
    { companyId: randomUUID() },
    { now: "2026-01-01" },
    { limit: 999 },
  ]) {
    assert.equal((await tool("get_own_work_review", args)).status, 400);
  }
});

test("a busy history reaches the model as complete bounded JSON with human feedback retained", async () => {
  for (let index = 0; index < 20; index++) {
    await insert(Run, {
      routineId: businessRoutine.id,
      status: "completed",
      startedAt: new Date(Date.now() - 120_000 - index * 1_000),
      finishedAt: new Date(Date.now() - 60_000 - index * 1_000),
      outcomeNote: "Check actual records before claiming success. ".repeat(20),
      logContent: workSummaryLogLine("Report comparisons and their limits. ".repeat(20)),
    });
  }
  const feedback = "Keep the original authority and address the missing comparison.";
  const decided = await insert(RevisionProposal, {
    companyId: company.id,
    employeeId: employee.id,
    kind: "soul",
    status: "rejected",
    decidedAt: new Date(),
    reviewNote: feedback,
    proposedBody: "Compare before publishing.",
  });
  const result = await tool<Review>("get_own_work_review");
  assert.equal(result.status, 200);
  assert.ok(JSON.stringify(result.body, null, 2).length <= WORK_REVIEW_PACKET_MAX_CHARS);
  assert.equal(result.body.runs.truncated, true);
  assert.ok(result.body.runs.items.length > 0);
  assert.equal(result.body.revisions.decided.items[0].id, decided.id);
  assert.equal(result.body.revisions.decided.items[0].reviewNote, feedback);
  assert.equal(await AppDataSource.getRepository(Run).count(), 22);
});

test("the callback returns only the authenticated employee's packet and no private chat transcript", async () => {
  const other = await insert(AIEmployee, {
    companyId: company.id,
    name: "Other",
    role: "Private",
    slug: randomUUID(),
  });
  const routine = await insert(Routine, {
    employeeId: other.id,
    name: "PRIVATE-FOREIGN-ROUTINE",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  await insert(Run, {
    routineId: routine.id,
    status: "completed",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 1_000),
    logContent: workSummaryLogLine("PRIVATE-FOREIGN-REPORT"),
  });
  const conversation = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: owner.id,
    title: "PRIVATE-CHAT-TITLE",
  });
  await insert(ConversationMessage, {
    conversationId: conversation.id,
    role: "assistant",
    status: "ok",
    content: "PRIVATE-CHAT-TRANSCRIPT",
  });
  const result = await tool<Review>("get_own_work_review");
  assert.equal(result.status, 200);
  assert.equal(result.body.employeeId, employee.id);
  assert.deepEqual(
    result.body.runs.items.map((run) => run.id),
    [evidence.id],
  );
  assert.equal(result.body.runs.items[0].outcomeVerdict, "unverified");
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE-FOREIGN|PRIVATE-CHAT/);
  assert.equal((await tool("get_own_work_review", {}, null)).status, 401);
  const untrusted = mint({ authority: "untrusted", selfReviewOnly: false });
  assert.equal((await tool("get_own_work_review", {}, untrusted)).status, 403);
  const wrongCompany = mint({}, employee.id, randomUUID());
  assert.equal((await tool("get_own_work_review", {}, wrongCompany)).status, 401);
});

test("interactive Member delegation for the packet remains admin-only and follows live membership", async () => {
  const member = await insert(User, {
    email: "member-review@example.test",
    name: "Member",
    passwordHash: "x",
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: member.id,
    role: "member",
  });
  const delegated = mint({
    authority: "member",
    requesterUserId: member.id,
    requesterSessionVersion: member.sessionVersion,
    selfReviewOnly: false,
    runId: undefined,
    routineId: undefined,
  });
  assert.equal((await tool("get_own_work_review", {}, delegated)).status, 403);
  await AppDataSource.getRepository(Membership).update(membership.id, { role: "admin" });
  assert.equal((await tool("get_own_work_review", {}, delegated)).status, 200);
  await AppDataSource.getRepository(Membership).delete(membership.id);
  assert.equal((await tool("get_own_work_review", {}, delegated)).status, 403);
});

test("direct writers, delegation, deferred action channels and aliases are denied before their handlers", async () => {
  for (const name of [
    "update_skill",
    "update_routine",
    "send_mail",
    "create_mail_draft",
    "delegate_parallel_work",
    "handoff",
    "schedule_wakeup",
    "run_pipeline",
    "propose_initiative",
    "request_decision",
    "bash",
    "write_file",
    "call_tool",
    "alias_send_mail",
    "google_send_message",
  ]) {
    const result = await tool<{ error: string }>(name, {});
    assert.equal(result.status, 403, `${name} reached validation or its handler`);
    assert.match(result.body.error, /review/i);
  }
  assert.equal(
    (await tool("update_skill", { skillId: skill.id, body: "Unauthorized replacement" })).status,
    403,
  );
  assert.equal(
    (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id })).body,
    skill.body,
  );
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
});

test("review Integration discovery is empty and every Integration invocation path is refused", async () => {
  const listing = await request("/integrations/_list");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body, { tools: [] });
  for (const path of [
    "/integrations/invoke",
    "/integrations/google_send_mail",
    "/integrations/_list/invoke",
  ]) {
    assert.equal((await request(path, {})).status, 403, path);
  }
  assert.equal(
    (
      await request("/integrations/invoke", {
        connectionId: randomUUID(),
        toolName: "send_message",
        args: {},
      })
    ).status,
    403,
  );
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("missing, malformed, mismatched and absent Run provenance fails closed for allowed callbacks", async () => {
  for (const origin of [
    { runId: undefined },
    { routineId: undefined },
    { runId: "invalid" },
    { routineId: "invalid" },
    { runId: randomUUID() },
    { routineId: randomUUID() },
    { routineId: businessRoutine.id },
  ]) {
    const invalid = mint(origin);
    assert.equal(
      (await tool("get_own_work_review", {}, invalid)).status,
      403,
      JSON.stringify(origin),
    );
    assert.equal(
      (await tool("create_workstream", { title: "Should not exist" }, invalid)).status,
      403,
    );
  }
  assert.equal(await AppDataSource.getRepository(Workstream).count(), 0);
});

test("finishing the Run or removing its review policy invalidates the already issued token", async () => {
  for (const update of [{ status: "completed" as const }, { finishedAt: new Date() }]) {
    await AppDataSource.getRepository(Run).update(reviewRun.id, update);
    assert.equal((await tool("get_own_work_review")).status, 403);
    assert.equal((await tool("propose_revision", proposal())).status, 403);
    await AppDataSource.getRepository(Run).update(reviewRun.id, {
      status: "running",
      finishedAt: null,
    });
  }
  await AppDataSource.getRepository(Routine).update(reviewRoutine.id, { selfReviewOnly: false });
  assert.equal((await tool("get_own_work_review")).status, 403);
  assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
});

test("a review creates its bound tracking record and can update it without copying private state to Journals", async () => {
  const created = await tool<{ workstream: Workstream }>("create_workstream", {
    title: "Review progress",
    stateDoc: "PRIVATE-INITIAL-STATE",
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.workstream.routineId, reviewRoutine.id);
  const updated = await tool<{ workstream: Workstream }>("update_workstream", {
    workstreamId: created.body.workstream.id,
    stateDoc: "PRIVATE-UPDATED-STATE",
    status: "done",
  });
  assert.equal(updated.status, 200);
  const stored = await AppDataSource.getRepository(Workstream).findOneByOrFail({
    id: created.body.workstream.id,
  });
  assert.equal(stored.routineId, reviewRoutine.id);
  assert.equal(stored.stateDoc, "PRIVATE-UPDATED-STATE");
  assert.equal(stored.lastRunId, reviewRun.id);
  assert.equal(stored.status, "done");
  const entries = await AppDataSource.getRepository(JournalEntry).findBy({
    employeeId: employee.id,
  });
  assert.equal(entries.length, 2);
  assert.doesNotMatch(
    JSON.stringify(entries.map((entry) => ({ title: entry.title, body: entry.body }))),
    /PRIVATE-/,
  );
});

test("review tracking cannot bind to business work or modify unbound, unrelated or foreign records", async () => {
  assert.equal(
    (await tool("create_workstream", { title: "Other work", routineId: businessRoutine.id }))
      .status,
    400,
  );
  assert.equal(await AppDataSource.getRepository(Workstream).count(), 0);
  for (const values of [
    { routineId: null },
    { routineId: businessRoutine.id },
    { employeeId: randomUUID() },
    { companyId: randomUUID() },
  ]) {
    const workstream = await ownTracking(values);
    const result = await tool("update_workstream", {
      workstreamId: workstream.id,
      stateDoc: "Unauthorized replacement",
    });
    assert.equal(result.status, 400);
    assert.equal(
      (await AppDataSource.getRepository(Workstream).findOneByOrFail({ id: workstream.id }))
        .stateDoc,
      "PRIVATE-REVIEW-STATE",
    );
  }
  assert.equal(
    (await tool("update_workstream", { workstreamId: randomUUID(), stateDoc: "Unknown" })).status,
    400,
  );
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
});

test("nonreview employee turns cannot read or write review tracking, while delegated admin access remains", async () => {
  const reviewState = await ownTracking();
  const businessState = await ownTracking({
    routineId: businessRoutine.id,
    title: "Business progress",
    stateDoc: "Business state",
  });
  const ordinary = mint({ selfReviewOnly: false, runId: undefined, routineId: undefined });
  const listed = await tool<{ workstreams: Workstream[] }>(
    "list_workstreams",
    { all: true },
    ordinary,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.workstreams.map((row) => row.id),
    [businessState.id],
  );
  assert.equal(
    (
      await tool(
        "update_workstream",
        { workstreamId: reviewState.id, stateDoc: "Business writer" },
        ordinary,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await tool(
        "update_workstream",
        { workstreamId: businessState.id, stateDoc: "Updated business state" },
        ordinary,
      )
    ).status,
    200,
  );
  const delegated = mint({
    authority: "member",
    requesterUserId: owner.id,
    requesterSessionVersion: owner.sessionVersion,
    selfReviewOnly: false,
    runId: undefined,
    routineId: undefined,
  });
  const administrative = await tool<{ workstreams: Workstream[] }>(
    "list_workstreams",
    { all: true },
    delegated,
  );
  assert.equal(administrative.status, 200);
  assert.ok(administrative.body.workstreams.some((row) => row.id === reviewState.id));
  assert.equal(
    (await AppDataSource.getRepository(Workstream).findOneByOrFail({ id: reviewState.id }))
      .stateDoc,
    "PRIVATE-REVIEW-STATE",
  );
});

test("one proposal is staged with trusted review provenance while the Soul and Skill stay unchanged", async () => {
  const created = await tool<{ proposal: { id: string } }>("propose_revision", proposal());
  assert.equal(created.status, 200);
  const row = await AppDataSource.getRepository(RevisionProposal).findOneByOrFail({
    id: created.body.proposal.id,
  });
  assert.equal(row.status, "pending");
  assert.equal(row.reviewRunId, reviewRun.id);
  assert.equal(row.baseBody, employee.soulBody);
  assert.equal(
    (await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: employee.id })).soulBody,
    employee.soulBody,
  );
  const second = await tool<{ error: string }>(
    "propose_revision",
    proposal({ kind: "skill", target: skill.id, proposedBody: "A revised playbook." }),
  );
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already created a proposal/);
  assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id })).body,
    skill.body,
  );
});

test("criteria changes and client-supplied review provenance cannot use the proposal allowance", async () => {
  assert.equal(
    (
      await tool(
        "propose_revision",
        proposal({ kind: "routine_criteria", target: businessRoutine.id, proposedBody: "" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await tool("propose_revision", proposal({ reviewRunId: randomUUID() }))).status,
    400,
  );
  assert.equal(await AppDataSource.getRepository(RevisionProposal).count(), 0);
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: businessRoutine.id }))
      .acceptanceCriteria,
    businessRoutine.acceptanceCriteria,
  );
  assert.equal((await tool("propose_revision", proposal())).status, 200);
});

test("concurrent proposal callbacks cannot spend a review Run's allowance twice", async () => {
  const results = await Promise.all([
    tool("propose_revision", proposal()),
    tool(
      "propose_revision",
      proposal({ kind: "skill", target: skill.id, proposedBody: "A revised playbook." }),
    ),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal(
    await AppDataSource.getRepository(RevisionProposal).countBy({ reviewRunId: reviewRun.id }),
    1,
  );
  assert.equal(
    (await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: employee.id })).soulBody,
    employee.soulBody,
  );
  assert.equal(
    (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id })).body,
    skill.body,
  );
});
