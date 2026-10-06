import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Handoff } from "../db/entities/Handoff.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Team } from "../db/entities/Team.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { loadGenosynTools } from "../services/agent/tools/genosyn.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * What an AI Employee can do and is told about handing work on and finding its
 * teammates, now that reporting lines are gone.
 *
 * `create_handoff` used to take `toManager: true` and walk the sender's
 * reporting line. A handoff now always names its receiver, and the old
 * shortcut is refused by name — an employee whose Soul or Skill still says
 * "hand it to your manager" gets an error it can act on, not a silent drop.
 * Teams stay: `list_teams` still answers "who's on revenue?".
 */

let server: Server;
let baseUrl: string;
let token: string;
const originalPort = config.port;
let company: Company;
let jamie: AIEmployee;
let kim: AIEmployee;
let lead: AIEmployee;
let stranger: AIEmployee;
let operations: Team;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  // The agent's own tools dispatch to the loopback internal API on config.port.
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  operations = await insert(Team, {
    companyId: company.id,
    name: "Operations",
    slug: "operations",
    description: "Keeps the lights on.",
  });
  const legacy = await insert(Team, {
    companyId: company.id,
    name: "Legacy",
    slug: "legacy",
    archivedAt: new Date(),
  });
  jamie = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Analyst",
    soulBody: "",
    teamId: operations.id,
  });
  kim = await insert(AIEmployee, {
    companyId: company.id,
    name: "Kim",
    slug: "kim",
    role: "Bookkeeper",
    soulBody: "",
    teamId: operations.id,
  });
  lead = await insert(AIEmployee, {
    companyId: company.id,
    name: "Lead",
    slug: "lead",
    role: "Head of Ops",
    soulBody: "",
    teamId: legacy.id,
  });
  const elsewhere = await insert(Company, {
    name: "Elsewhere",
    slug: "elsewhere",
    ownerId: owner.id,
  });
  const theirTeam = await insert(Team, {
    companyId: elsewhere.id,
    name: "Their team",
    slug: "their-team",
  });
  stranger = await insert(AIEmployee, {
    companyId: elsewhere.id,
    name: "Zed",
    slug: "zed",
    role: "Spy",
    soulBody: "",
    teamId: theirTeam.id,
  });
  token = issueMcpToken(jamie.id, company.id, { authority: "employee" });
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type Issue = { code: string; keys?: string[]; path: Array<string | number>; message: string };
type Refusal = { error: string; issues?: Issue[] };

const handoffCount = () => AppDataSource.getRepository(Handoff).count();

describe("create_handoff", () => {
  test("hands work to a teammate named by slug, and records the trail", async () => {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await tool<{ handoff: Record<string, unknown> }>("create_handoff", {
      toEmployee: "kim",
      title: "Reconcile the March statements",
      body: "Bank feed vs ledger.",
      dueAt,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.handoff.fromEmployeeId, jamie.id);
    assert.equal(created.body.handoff.toEmployeeId, kim.id);
    assert.equal(created.body.handoff.status, "pending");
    assert.equal(created.body.handoff.dueAt, dueAt);
    const [row] = await AppDataSource.getRepository(Handoff).find();
    assert.equal(row.toEmployeeId, kim.id);
    assert.equal(row.companyId, company.id);
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "handoff.create",
    });
    assert.equal(audit.actorEmployeeId, jamie.id);
    assert.equal(audit.targetId, row.id);
    const journals = await AppDataSource.getRepository(JournalEntry).find();
    assert.deepEqual(new Set(journals.map((j) => j.employeeId)), new Set([jamie.id, kim.id]));
  });

  test("accepts the receiver's id as well as its slug", async () => {
    const created = await tool<{ handoff: { toEmployeeId: string } }>("create_handoff", {
      toEmployee: lead.id,
      title: "Approve the vendor list",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.handoff.toEmployeeId, lead.id);
  });

  for (const [label, args] of [
    ["alone", { toManager: true, title: "Escalate the outage" }],
    ["beside a receiver", { toManager: true, toEmployee: "kim", title: "Escalate the outage" }],
    ["even when false", { toManager: false, toEmployee: "kim", title: "Escalate the outage" }],
  ] as const) {
    test(`refuses the removed toManager shortcut ${label}, by name, and writes nothing`, async () => {
      const refused = await tool<Refusal>("create_handoff", args);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error, "ValidationError");
      assert.ok(
        refused.body.issues?.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys?.includes("toManager"),
        ),
        JSON.stringify(refused.body),
      );
      assert.equal(await handoffCount(), 0);
      assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
    });
  }

  test("a handoff must name its receiver", async () => {
    for (const args of [{ title: "Somebody do this" }, { toEmployee: "", title: "Somebody" }]) {
      const refused = await tool<Refusal>("create_handoff", args);
      assert.equal(refused.status, 400, JSON.stringify(args));
      assert.ok(
        refused.body.issues?.some((issue) => issue.path[0] === "toEmployee"),
        JSON.stringify(refused.body),
      );
    }
    assert.equal(await handoffCount(), 0);
  });

  test("an unknown receiver, yourself, or another company's employee is refused", async () => {
    const unknown = await tool<Refusal>("create_handoff", { toEmployee: "nobody", title: "x" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "Employee not found");
    const self = await tool<Refusal>("create_handoff", { toEmployee: "jamie", title: "x" });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, "Cannot hand off to yourself");
    for (const ref of [stranger.id, stranger.slug]) {
      const foreign = await tool<Refusal>("create_handoff", { toEmployee: ref, title: "x" });
      assert.equal(foreign.status, 404, ref);
    }
    assert.equal(await handoffCount(), 0);
  });

  test("the employee's own tool reports toManager with the arguments it does take", async () => {
    const { tools } = await loadGenosynTools(token);
    const createHandoff = tools.find((candidate) => candidate.name === "create_handoff");
    assert.ok(createHandoff, "create_handoff is still an employee tool");
    const result = await createHandoff.run({ toManager: true, title: "Escalate the outage" });
    assert.equal(result.isError, true);
    assert.match(result.content, /toManager/);
    assert.match(
      result.content,
      /Accepted arguments: toEmployee \(required\), title \(required\), body, dueAt\./,
      "the error names the argument to use instead",
    );
    assert.equal(await handoffCount(), 0);

    const retried = await createHandoff.run({ toEmployee: "kim", title: "Escalate the outage" });
    assert.notEqual(retried.isError, true);
    assert.equal(await handoffCount(), 1);
  });
});

describe("what the manifest tells an AI Employee", () => {
  test("create_handoff takes a named receiver and nothing about a manager", () => {
    const definition = STATIC_TOOLS.find((entry) => entry.name === "create_handoff");
    assert.ok(definition);
    assert.deepEqual(Object.keys(definition.inputSchema.properties ?? {}).sort(), [
      "body",
      "dueAt",
      "title",
      "toEmployee",
    ]);
    assert.deepEqual(definition.inputSchema.required, ["toEmployee", "title"]);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.doesNotMatch(definition.description, /manager|reporting line|reportsTo/i);
  });

  test("list_teams describes Teams without an org chart", () => {
    const definition = STATIC_TOOLS.find((entry) => entry.name === "list_teams");
    assert.ok(definition);
    assert.doesNotMatch(definition.description, /org chart|reporting/i);
    assert.match(definition.description, /team/i);
  });

  test("no tool anywhere offers or mentions a reporting line", () => {
    const offenders = STATIC_TOOLS.filter((entry) =>
      /toManager|reportsTo|reporting line|org chart|your manager/i.test(JSON.stringify(entry)),
    ).map((entry) => entry.name);
    assert.deepEqual(offenders, []);
  });
});

describe("finding teammates", () => {
  test("list_teams returns this company's live teams and their members, and nothing else", async () => {
    const listed = await tool<{
      teams: Array<{
        id: string;
        slug: string;
        name: string;
        description: string;
        members: Array<Record<string, unknown>>;
      }>;
    }>("list_teams", {});
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.teams.map((team) => team.slug),
      ["operations"],
      "an archived team and another company's team are left out",
    );
    const [team] = listed.body.teams;
    assert.equal(team.id, operations.id);
    assert.equal(team.description, "Keeps the lights on.");
    assert.deepEqual(team.members, [
      { id: jamie.id, slug: "jamie", name: "Jamie", role: "Analyst" },
      { id: kim.id, slug: "kim", name: "Kim", role: "Bookkeeper" },
    ]);
  });

  test("list_teams takes no arguments", async () => {
    const refused = await tool<Refusal>("list_teams", { includeArchived: true });
    assert.equal(refused.status, 400);
  });

  test("get_self and list_employees describe people without a reporting line", async () => {
    const self = await tool<{ employee: Record<string, unknown> }>("get_self", {});
    assert.equal(self.status, 200);
    assert.deepEqual(Object.keys(self.body.employee).sort(), ["id", "name", "role", "slug"]);
    const roster = await tool<{ employees: Array<Record<string, unknown>> }>("list_employees", {});
    assert.deepEqual(roster.body.employees.map((employee) => employee.slug).sort(), [
      "jamie",
      "kim",
      "lead",
    ]);
    for (const employee of roster.body.employees) {
      assert.deepEqual(Object.keys(employee).sort(), ["id", "name", "role", "slug"]);
    }
  });
});

test("propose_revision tells the employee who was paged — owners and admins, no manager", async () => {
  const proposed = await tool<{ note: string; proposal: { id: string } }>("propose_revision", {
    kind: "soul",
    proposedBody: "Reconcile every statement before the close.",
    rationale: "Two closes slipped because statements were reconciled late.",
  });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.match(proposed.body.note, /owners and admins have been notified/);
  assert.doesNotMatch(proposed.body.note, /manager/i);
});
