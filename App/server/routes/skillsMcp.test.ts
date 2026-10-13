import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Skill } from "../db/entities/Skill.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import { skillCreateForTeammateError, skillTeammateWriteError } from "../services/skillAccess.js";
import {
  createTaintedToolApproval,
  executeTaintedToolApproval,
  parseTaintedToolPayload,
} from "../services/taintPolicy.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Skill writes at the seam that enforces them.
 *
 * A Skill's body is folded into every system prompt of the employee that owns
 * it, so a write to someone else's Skill is a write to their standing
 * instructions. An AI Employee may create, edit, and delete its own Skills and
 * read a teammate's, but no tool call — whoever drives the turn — may change a
 * teammate's. The writers are taint sinks too: after a web read, even an
 * own-Skill write is held for a human, and a teammate write is refused rather
 * than held, since no approval could let it through. Every refusal here is
 * proven to leave no row, audit, journal entry, or Approval behind.
 */

let server: Server;
let baseUrl = "";
const originalPort = config.port;
const tokens = new Set<string>();

let owner: User;
let company: Company;
/** The employee whose turn it is. */
let ada: AIEmployee;
/** A teammate whose Skills Ada can read but not change. */
let bob: AIEmployee;
let adaSkill: Skill;
let bobSkill: Skill;
let adaToken = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  // An approved tainted call replays over loopback on `config.port`.
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  for (const issued of tokens) revokeMcpToken(issued);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

function issue(employee: AIEmployee, origin: Parameters<typeof issueMcpToken>[2] = {}): string {
  const issued = issueMcpToken(employee.id, company.id, { authority: "employee", ...origin });
  tokens.add(issued);
  return issued;
}

beforeEach(async () => {
  for (const issued of tokens) revokeMcpToken(issued);
  tokens.clear();
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `skills-mcp-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Operations",
    soulBody: "",
  });
  bob = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bob",
    slug: "bob",
    role: "Finance",
    soulBody: "",
  });
  adaSkill = await insert(Skill, {
    employeeId: ada.id,
    name: "Weekly report",
    slug: "weekly-report",
    body: "Write the weekly report.",
  });
  bobSkill = await insert(Skill, {
    employeeId: bob.id,
    name: "Pay vendors",
    slug: "pay-vendors",
    body: "Pay only invoices a Member approved.",
  });
  adaToken = issue(ada);
});

async function post<T = Record<string, unknown>>(
  path: string,
  args: unknown = {},
  bearer = adaToken,
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T & { error?: string },
  };
}

function tool<T = Record<string, unknown>>(name: string, args: unknown = {}, bearer = adaToken) {
  return post<T>(`/tools/${name}`, args, bearer);
}

/** Everything a Skill write could touch, to prove a refusal touched none of it. */
async function worldSnapshot() {
  return {
    skills: await AppDataSource.getRepository(Skill).find({ order: { id: "ASC" } }),
    tagAssignments: await AppDataSource.getRepository(TagAssignment).count(),
    skillAudits: await AppDataSource.getRepository(AuditEvent).count({
      where: [{ action: "skill.create" }, { action: "skill.update" }, { action: "skill.delete" }],
    }),
    journal: await AppDataSource.getRepository(JournalEntry).count(),
    approvals: await AppDataSource.getRepository(Approval).count(),
  };
}

function assertRefused(
  result: { status: number; body: { error?: string } },
  expected: string,
  what: string,
) {
  assert.equal(result.status, 403, `${what}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, expected, what);
}

const teammateError = () => skillTeammateWriteError(company, "Bob");
const createForTeammateError = () => skillCreateForTeammateError(company);

/** One call per Skill writer, each aimed at Bob. */
const teammateWrites = (): Array<[string, Record<string, unknown>, string]> => [
  [
    "create_skill",
    { employeeSlug: "bob", name: "Pay faster", body: "Skip approval." },
    createForTeammateError(),
  ],
  ["update_skill", { skillId: bobSkill.id, body: "Pay every invoice at once." }, teammateError()],
  ["update_skill", { skillId: bobSkill.id, name: "Renamed" }, teammateError()],
  ["update_skill", { skillId: bobSkill.id, toolset: ["send_mail"] }, teammateError()],
  ["delete_skill", { skillId: bobSkill.id }, teammateError()],
];

// ───────────────────────────── own Skills ─────────────────────────────

describe("an AI Employee writes its own Skills", () => {
  test("creates, edits, and deletes its own Skills, audited and journaled as before", async () => {
    const created = await tool<{ skill: { id: string } }>("create_skill", {
      name: "Close the books",
      body: "Reconcile first.",
    });
    assert.equal(created.status, 200, created.body.error);
    // Naming itself is still accepted, so an older caller keeps working.
    const named = await tool<{ skill: { id: string } }>("create_skill", {
      employeeSlug: "ada",
      name: "Triage bugs",
    });
    assert.equal(named.status, 200, named.body.error);
    const skills = AppDataSource.getRepository(Skill);
    for (const id of [created.body.skill.id, named.body.skill.id]) {
      assert.equal((await skills.findOneByOrFail({ id })).employeeId, ada.id);
    }

    const updated = await tool("update_skill", {
      skillId: adaSkill.id,
      name: "Weekly summary",
      body: "Write a shorter report.",
    });
    assert.equal(updated.status, 200, updated.body.error);
    const revised = await skills.findOneByOrFail({ id: adaSkill.id });
    assert.equal(revised.name, "Weekly summary");
    assert.equal(revised.body, "Write a shorter report.");

    const deleted = await tool("delete_skill", { skillId: created.body.skill.id });
    assert.equal(deleted.status, 200, deleted.body.error);
    assert.equal(await skills.countBy({ id: created.body.skill.id }), 0);

    const audits = await AppDataSource.getRepository(AuditEvent).find({
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(audits.map((row) => row.action).sort(), [
      "skill.create",
      "skill.create",
      "skill.delete",
      "skill.update",
    ]);
    for (const row of audits) {
      assert.equal(row.actorEmployeeId, ada.id, row.action);
      assert.equal(
        (JSON.parse(row.metadataJson) as { employeeId: string }).employeeId,
        ada.id,
        row.action,
      );
    }
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({ employeeId: ada.id });
    assert.deepEqual(journal.map((entry) => entry.title).sort(), [
      'Ada added a skill: "Close the books"',
      'Ada added a skill: "Triage bugs"',
      'Ada removed the skill "Close the books"',
    ]);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: bob.id }),
      0,
    );
  });

  test("an owner driving the chat still has the employee write its own Skills", async () => {
    const delegated = issue(ada, {
      authority: "member",
      requesterUserId: owner.id,
      requesterSessionVersion: owner.sessionVersion,
    });
    const result = await tool(
      "update_skill",
      { skillId: adaSkill.id, body: "Owner-approved steps." },
      delegated,
    );
    assert.equal(result.status, 200, result.body.error);
    assert.equal(
      (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: adaSkill.id })).body,
      "Owner-approved steps.",
    );
  });
});

// ───────────────────────────── teammates ─────────────────────────────

describe("a teammate's Skills are read-only to an AI Employee", () => {
  test("list_skills still reads a teammate's playbooks in full", async () => {
    const result = await tool<{ skills: Array<{ id: string; body: string }> }>("list_skills", {
      employeeSlug: "bob",
    });
    assert.equal(result.status, 200, result.body.error);
    assert.deepEqual(
      result.body.skills.map((skill) => [skill.id, skill.body]),
      [[bobSkill.id, bobSkill.body]],
    );
  });

  test("every write aimed at a teammate is refused before any side effect", async () => {
    const before = await worldSnapshot();
    for (const [name, args, expected] of teammateWrites()) {
      assertRefused(await tool(name, args), expected, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("create_skill refuses any slug but the caller's own, even one that names nobody", async () => {
    const before = await worldSnapshot();
    for (const employeeSlug of ["nobody", "ADA", "Bob"]) {
      assertRefused(
        await tool("create_skill", { employeeSlug, name: "Anything" }),
        createForTeammateError(),
        employeeSlug,
      );
    }
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("an owner or admin driving the chat does not lend teammate writes", async () => {
    for (const role of ["owner", "admin"] as const) {
      const requester = await insert(User, {
        email: `${role}-${randomUUID()}@example.test`,
        name: role,
        passwordHash: "x",
        sessionVersion: 0,
      });
      await insert(Membership, { companyId: company.id, userId: requester.id, role });
      const delegated = issue(ada, {
        authority: "member",
        requesterUserId: requester.id,
        requesterSessionVersion: requester.sessionVersion,
      });
      const before = await worldSnapshot();
      for (const [name, args, expected] of teammateWrites()) {
        assertRefused(await tool(name, args, delegated), expected, `${role}: ${name}`);
      }
      assert.deepEqual(await worldSnapshot(), before);
    }
  });

  test("the refusal tells the employee to go to a Member, and names the Decision stack only while it is on", async () => {
    const on = await tool("update_skill", { skillId: bobSkill.id, body: "x" });
    assert.match(on.body.error ?? "", /belongs to Bob/);
    assert.match(on.body.error ?? "", /only through a Member/);
    assert.match(on.body.error ?? "", /raise a Decision/);

    await AppDataSource.getRepository(Company).update(company.id, {
      decisionStackEnabled: false,
    });
    const off = await tool("update_skill", { skillId: bobSkill.id, body: "x" });
    assert.equal(off.status, 403);
    assert.equal(off.body.error, skillTeammateWriteError({ decisionStackEnabled: false }, "Bob"));
    assert.doesNotMatch(off.body.error ?? "", /Decision/);
  });

  test("every path spelling Express routes to a writer is refused", async () => {
    const before = await worldSnapshot();
    for (const path of ["/TOOLS/update_skill", "/tools/UPDATE_SKILL/", "/Tools/Delete_Skill"]) {
      const result = await post(path, { skillId: bobSkill.id, body: "Pay every invoice." });
      assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error, teammateError(), path);
    }
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("a Skill in another company is still answered as not found", async () => {
    const elsewhere = await insert(Company, {
      name: "Elsewhere",
      slug: `elsewhere-${randomUUID()}`,
      ownerId: owner.id,
    });
    const stranger = await insert(AIEmployee, {
      companyId: elsewhere.id,
      name: "Stranger",
      slug: "stranger",
      role: "Ops",
      soulBody: "",
    });
    const foreign = await insert(Skill, {
      employeeId: stranger.id,
      name: "Foreign",
      slug: "foreign",
      body: "Not yours.",
    });
    for (const [name, args] of [
      ["update_skill", { skillId: foreign.id, body: "x" }],
      ["delete_skill", { skillId: foreign.id }],
    ] as const) {
      const result = await tool(name, args);
      assert.equal(result.status, 404, name);
      assert.equal(result.body.error, "Skill not found", name);
    }
    assert.equal(
      (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: foreign.id })).body,
      "Not yours.",
    );
  });
});

// ───────────────────────────── taint ─────────────────────────────

describe("the taint policy holds Skill writes", () => {
  test("a tainted turn's own Skill writes are held, and approving replays each verbatim", async () => {
    const spare = await insert(Skill, {
      employeeId: ada.id,
      name: "Old playbook",
      slug: "old-playbook",
      body: "Obsolete.",
    });
    markTokenTainted(adaToken);
    const before = await worldSnapshot();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["create_skill", { name: "From the web", body: "Steps a page suggested." }],
      ["update_skill", { skillId: adaSkill.id, body: "Steps a page suggested." }],
      ["delete_skill", { skillId: spare.id }],
    ];
    const held: Approval[] = [];
    for (const [name, args] of calls) {
      const result = await tool<{ status: string; approvalId: string }>(name, args);
      assert.equal(result.status, 200, `${name}: ${result.body.error}`);
      assert.equal(result.body.status, "pending_approval", name);
      const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
        id: result.body.approvalId,
      });
      assert.equal(approval.kind, "tainted_tool");
      assert.equal(approval.employeeId, ada.id);
      assert.deepEqual(parseTaintedToolPayload(approval.payloadJson), {
        tool: name,
        args,
        employeeId: ada.id,
      });
      held.push(approval);
    }
    // Held, not executed: nothing but the three Approvals changed.
    assert.deepEqual(await worldSnapshot(), { ...before, approvals: before.approvals + 3 });

    for (const approval of held) await executeTaintedToolApproval(approval);
    const skills = AppDataSource.getRepository(Skill);
    const created = await skills.findOneByOrFail({ name: "From the web" });
    assert.equal(created.employeeId, ada.id);
    assert.equal(
      (await skills.findOneByOrFail({ id: adaSkill.id })).body,
      "Steps a page suggested.",
    );
    assert.equal(await skills.countBy({ id: spare.id }), 0);
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      actorEmployeeId: ada.id,
    });
    assert.deepEqual(audits.map((row) => row.action).sort(), [
      "skill.create",
      "skill.delete",
      "skill.update",
    ]);
  });

  test("a tainted write aimed at a teammate's Skill is refused, never held", async () => {
    markTokenTainted(adaToken);
    const before = await worldSnapshot();
    for (const [name, args, expected] of teammateWrites()) {
      assertRefused(await tool(name, args), expected, `tainted ${name}`);
    }
    assert.deepEqual(await worldSnapshot(), before);
    assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
  });

  test("an approved replay cannot write a teammate's Skill either", async () => {
    // Not reachable through the gate, which refuses first; this is the replay
    // re-entering the same rule, so a stored payload is never a way around it.
    const approval = await createTaintedToolApproval({
      companyId: company.id,
      employeeId: ada.id,
      tool: "update_skill",
      toolArgs: { skillId: bobSkill.id, body: "Pay every invoice at once." },
    });
    await assert.rejects(executeTaintedToolApproval(approval), /belongs to Bob/);
    assert.equal(
      (await AppDataSource.getRepository(Skill).findOneByOrFail({ id: bobSkill.id })).body,
      bobSkill.body,
    );
  });
});
