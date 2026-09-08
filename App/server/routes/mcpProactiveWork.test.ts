import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Initiative } from "../db/entities/Initiative.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { TOOL_DOMAINS, TOOL_KEYWORDS } from "../services/agent/tools/toolIndex.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { memberToolPolicy } from "../services/memberToolAuthority.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type Origin = NonNullable<Parameters<typeof issueMcpToken>[2]>;
let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let owner: User;
let token: string;
const tokens = new Set<string>();

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp/tools`;
});
after(async () => {
  for (const value of tokens) revokeMcpToken(value);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});
beforeEach(async () => {
  for (const value of tokens) revokeMcpToken(value);
  tokens.clear();
  await resetTestDb();
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  company = await insert(Company, { name: "Proactive", slug: randomUUID(), ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    role: "Operations",
    slug: randomUUID(),
  });
  token = mint();
});
function mint(origin: Origin = {}) {
  const value = issueMcpToken(employee.id, company.id, { authority: "employee", ...origin });
  tokens.add(value);
  return value;
}
async function request(name: string, body: unknown = {}, bearer: string | null = token) {
  const response = await fetch(`${baseUrl}/${name}`, {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function proposal(overrides: Partial<Initiative> = {}) {
  return insert(Initiative, {
    companyId: company.id,
    employeeId: employee.id,
    title: "Check unresolved commitments",
    evidence: "Two missed commitments: source-a, source-b",
    proposal: "A weekly review will reduce missed commitments.",
    routineSpecJson: JSON.stringify({
      name: "Review commitments",
      cronExpr: "0 9 * * 1",
      body: "Inspect sources and act on due commitments.",
    }),
    ...overrides,
  });
}

test("new readers are granular, discoverable, classified and outside the resident budget", () => {
  for (const name of ["get_proactive_work", "list_initiatives", "get_initiative"]) {
    const tool = STATIC_TOOLS.find((entry) => entry.name === name);
    assert.equal(tool?.readOnly, true, name);
    assert.ok(
      Object.values(TOOL_DOMAINS).some((domain) => domain.tools.includes(name)),
      name,
    );
    assert.ok(TOOL_KEYWORDS[name]?.length, name);
    assert.ok(!(RESIDENT_GENOSYN_TOOLS as readonly string[]).includes(name), name);
    assert.ok(memberToolPolicy(name), name);
  }
});

for (const area of ["commitments", "commercial", "knowledge"]) {
  test(`${area} snapshot uses the authenticated employee and remains bounded`, async () => {
    const before = await AppDataSource.getRepository(Routine).count();
    const result = await request("get_proactive_work", { area });
    assert.equal(result.status, 200);
    assert.equal(result.body.area, area);
    assert.ok(result.body.sections);
    assert.ok(JSON.stringify(result.body, null, 2).length <= 7_500);
    assert.equal(await AppDataSource.getRepository(Routine).count(), before);
    assert.equal(await AppDataSource.getRepository(Initiative).count(), 0);
  });
}

test("strict reader schemas reject missing areas, forged scope, malformed IDs and invalid pagination", async () => {
  for (const [name, body] of [
    ["get_proactive_work", {}],
    ["get_proactive_work", { area: "everything" }],
    ["get_proactive_work", { area: "commercial", employeeId: randomUUID() }],
    ["list_initiatives", { companyId: randomUUID() }],
    ["list_initiatives", { offset: -1 }],
    ["list_initiatives", { offset: 10_001 }],
    ["list_initiatives", { status: "all" }],
    ["get_initiative", { initiativeId: "unknown" }],
  ] as const)
    assert.equal((await request(name, body)).status, 400, name);
});

test("company history includes other employees but cannot read another company's proposal", async () => {
  const other = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam",
    role: "Sales",
    slug: randomUUID(),
  });
  const shared = await proposal({
    employeeId: other.id,
    status: "declined",
    reviewNote: "Covered by the existing Routine. Do not duplicate it.",
  });
  const foreign = await proposal({ companyId: randomUUID(), title: "Foreign secret" });
  const listing = await request("list_initiatives", { status: "declined" });
  assert.deepEqual(
    listing.body.items.map((item: { id: string }) => item.id),
    [shared.id],
  );
  assert.match(listing.body.items[0].reviewNoteExcerpt, /Do not duplicate/);
  assert.deepEqual((await request("list_initiatives", { mine: true })).body.items, []);
  const detail = await request("get_initiative", { initiativeId: shared.id });
  assert.equal(detail.status, 200);
  assert.equal(
    detail.body.initiative.routineSpec.body,
    "Inspect sources and act on due commitments.",
  );
  assert.equal((await request("get_initiative", { initiativeId: foreign.id })).status, 404);
});

test("Member delegation requires an admin for combined work evidence and checks live membership", async () => {
  const member = await insert(User, {
    email: "member@example.test",
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
  });
  assert.equal(
    (await request("get_proactive_work", { area: "commercial" }, delegated)).status,
    403,
  );
  assert.equal((await request("list_initiatives", {}, delegated)).status, 200);
  const admin = mint({
    authority: "member",
    requesterUserId: owner.id,
    requesterSessionVersion: owner.sessionVersion,
  });
  assert.equal((await request("get_proactive_work", { area: "commercial" }, admin)).status, 200);
  await AppDataSource.getRepository(Membership).delete(membership.id);
  assert.equal((await request("list_initiatives", {}, delegated)).status, 403);
});

test("unauthenticated and untrusted turns cannot inspect proactive evidence or proposal history", async () => {
  assert.equal((await request("get_proactive_work", { area: "commitments" }, null)).status, 401);
  const untrusted = mint({ authority: "untrusted" });
  for (const name of ["get_proactive_work", "list_initiatives", "get_initiative"])
    assert.equal(
      (await request(name, name === "get_proactive_work" ? { area: "knowledge" } : {}, untrusted))
        .status,
      403,
    );
});

test("daily draft authority can inspect and propose standing work without creating a live Routine", async () => {
  const draft = mint({ mailDeliveryMode: "draft" });
  assert.equal((await request("get_proactive_work", { area: "commercial" }, draft)).status, 200);
  const result = await request(
    "propose_initiative",
    {
      title: "Prevent missing project reviews",
      evidence: "Todos abc and def both waited past their review deadlines.",
      proposal: "A weekly queue review with a clear owner will catch these waits.",
      routine: {
        name: "Review project waits",
        cronExpr: "0 9 * * 1",
        body: "Read due reviews and follow current Project membership.",
        acceptanceCriteria: "Every due review has a verified next step.",
      },
    },
    draft,
  );
  assert.equal(result.status, 200);
  assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
  assert.equal(await AppDataSource.getRepository(Initiative).countBy({ status: "pending" }), 1);
  assert.equal((await request("send_mail", {}, draft)).status, 403);
  assert.equal((await request("create_routine", {}, draft)).status, 403);
});

test("suggestion-only self-review does not gain business readers or new standing work", async () => {
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Improve my work",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  const run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    startedAt: new Date(),
  });
  const review = mint({ routineId: routine.id, runId: run.id, selfReviewOnly: true });
  for (const name of [
    "get_proactive_work",
    "list_initiatives",
    "get_initiative",
    "propose_initiative",
  ])
    assert.equal((await request(name, { area: "commercial" }, review)).status, 403, name);
});

async function sharedRoutine() {
  const colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jordan",
    role: "Finance",
    slug: randomUUID(),
  });
  const routine = await insert(Routine, {
    employeeId: colleague.id,
    name: "Review records",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
    body: "Read records and summarize missing context.",
  });
  const receipt = await insert(RoutineChatMessage, {
    companyId: company.id,
    employeeId: employee.id,
    routineId: routine.id,
    role: "assistant",
    status: "ok",
    content: "I helped clarify the original evidence.",
  });
  const evidence = await insert(Run, {
    routineId: routine.id,
    status: "completed",
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 60_000),
  });
  return { colleague, routine, receipt, evidence };
}

test("an exact participating Routine brief is readable and can be proposed without changing the live document", async () => {
  const { routine, evidence } = await sharedRoutine();
  const detail = await request("get_participating_routine", { routineId: routine.id });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ownerName, "Jordan");
  assert.equal(detail.body.body, routine.body);
  assert.ok(detail.body.bodyHash);
  assert.ok(JSON.stringify(detail.body, null, 2).length <= 7_500);
  const input = {
    kind: "routine_body",
    target: routine.id,
    proposedBody: "Read the original records and cite missing fields explicitly.",
    rationale: "The recorded contribution and finished Run show missing field names.",
    evidenceRunIds: [evidence.id],
  };
  assert.equal((await request("propose_revision", { ...input, target: routine.name })).status, 404);
  assert.equal((await request("propose_revision", { ...input, target: routine.slug })).status, 404);
  assert.equal(
    (await request("propose_revision", { ...input, kind: "routine_criteria" })).status,
    404,
  );
  const staged = await request("propose_revision", input);
  assert.equal(staged.status, 200);
  assert.match(staged.body.proposal.targetLabel, /Jordan/);
  assert.equal(
    (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).body,
    routine.body,
  );
  assert.equal(
    (await request("get_participating_routine", { routineId: routine.id })).body.pendingRevisionId,
    staged.body.proposal.id,
  );
});

test("shared readers enforce live participation and reject forged ownership or chunk parameters", async () => {
  const { routine, receipt } = await sharedRoutine();
  for (const body of [
    { routineId: routine.id, employeeId: randomUUID() },
    { routineId: routine.id, companyId: randomUUID() },
    { routineId: routine.id, bodyOffset: -1 },
  ])
    assert.equal((await request("get_participating_routine", body)).status, 400);
  await AppDataSource.getRepository(RoutineChatMessage).delete(receipt.id);
  assert.equal((await request("get_participating_routine", { routineId: routine.id })).status, 404);
  assert.equal(
    (
      await request("propose_revision", {
        kind: "routine_body",
        target: routine.id,
        proposedBody: "No longer eligible",
        rationale: "History was removed",
      })
    ).status,
    404,
  );
});

test("weekly review reads participating evidence and stages one shared suggestion within its narrow scope", async () => {
  const { routine: shared, evidence } = await sharedRoutine();
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Improve my work",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  const run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    startedAt: new Date(),
  });
  const review = mint({ routineId: routine.id, runId: run.id, selfReviewOnly: true });
  assert.equal(
    (await request("get_participating_routine", { routineId: shared.id }, review)).status,
    200,
  );
  const packet = await request("get_own_work_review", {}, review);
  assert.equal(packet.status, 200);
  assert.equal(packet.body.participatingRoutines.items[0].routineId, shared.id);
  const staged = await request(
    "propose_revision",
    {
      kind: "routine_body",
      target: shared.id,
      proposedBody: "Read source records, name missing fields, and verify coverage.",
      rationale: "Improve the process I helped with using its recorded result.",
      evidenceRunIds: [evidence.id],
    },
    review,
  );
  assert.equal(staged.status, 200);
  assert.equal(
    (
      await request(
        "propose_revision",
        { kind: "soul", proposedBody: "Second suggestion", rationale: "Another idea" },
        review,
      )
    ).status,
    400,
  );
});
