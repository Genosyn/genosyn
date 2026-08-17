import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The agent-facing half of the Decision Stack: an employee raising a question,
 * reading the answer back, and retracting one that stopped mattering.
 *
 * This is the path the whole feature exists for — a Routine has no interlocutor,
 * so `request_decision` is the only way for it to stop instead of guessing.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let owner: User;
let member: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  member = await insert(User, {
    email: "mo@example.test",
    name: "Mo Member",
    passwordHash: "x",
    handle: "mo",
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `decisions-mcp-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("decision tools are published", () => {
  test("all three appear in the manifest an MCP client reads", () => {
    const names = new Set(STATIC_TOOLS.map((t) => t.name));
    for (const name of ["request_decision", "list_decisions", "cancel_decision"]) {
      assert.ok(names.has(name), `${name} is missing from the manifest`);
    }
  });
});

describe("request_decision", () => {
  test("stacks the question, journals it, and tells the model to stop", async () => {
    const response = await tool<{ decisionId: string; options: Array<{ id: string }>; note: string }>(
      "request_decision",
      {
        title: "Send the pricing reply to Acme?",
        body: "Hi Dana — here is the quote.",
        options: [
          { label: "Send it", tone: "primary" },
          { label: "Hold for now" },
        ],
        urgency: "high",
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.options.map((o) => o.id),
      ["send-it", "hold-for-now"],
    );
    assert.match(response.body.note, /Stop this line of work/);

    const row = (await AppDataSource.getRepository(Decision).findOneBy({
      id: response.body.decisionId,
    }))!;
    assert.equal(row.companyId, company.id);
    assert.equal(row.employeeId, employee.id);
    assert.equal(row.status, "pending");
    assert.equal(row.urgency, "high");

    const journal = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: employee.id },
    });
    assert.equal(journal.length, 1);
    assert.match(journal[0].title, /Asked for a decision/);
  });

  test("resolves an assignee by handle", async () => {
    const response = await tool<{ decisionId: string }>("request_decision", {
      title: "Which vendor?",
      options: [{ label: "A" }, { label: "B" }],
      assignee: "@mo",
    });
    assert.equal(response.status, 200);
    const row = (await AppDataSource.getRepository(Decision).findOneBy({
      id: response.body.decisionId,
    }))!;
    assert.equal(row.assigneeUserId, member.id);
  });

  test("refuses an assignee who is not a Member rather than silently dropping it", async () => {
    const stranger = await insert(User, {
      email: "stranger@elsewhere.test",
      name: "Stranger",
      passwordHash: "x",
      handle: "stranger",
    });
    assert.ok(stranger.id);
    const response = await tool<{ error: string }>("request_decision", {
      title: "Which vendor?",
      options: [{ label: "A" }],
      assignee: "@stranger",
    });
    assert.equal(response.status, 404);
    assert.match(response.body.error, /No Member matches/);
    assert.equal(await AppDataSource.getRepository(Decision).count(), 0);
  });

  test("rejects more options than a human should be asked to weigh", async () => {
    const response = await tool("request_decision", {
      title: "Pick one",
      options: Array.from({ length: 7 }, (_, i) => ({ label: `Option ${i}` })),
    });
    assert.equal(response.status, 400);
  });

  test("turns expiresInHours into a real deadline", async () => {
    const before = Date.now();
    const response = await tool<{ decisionId: string }>("request_decision", {
      title: "Ship the changelog today?",
      options: [{ label: "Ship" }],
      expiresInHours: 6,
    });
    const row = (await AppDataSource.getRepository(Decision).findOneBy({
      id: response.body.decisionId,
    }))!;
    assert.ok(row.expiresAt, "expected a deadline");
    const delta = row.expiresAt!.getTime() - before;
    assert.ok(delta > 5.5 * 3600_000 && delta < 6.5 * 3600_000, `deadline was ${delta}ms out`);
  });
});

describe("list_decisions", () => {
  test("reads back the option a human picked, and only this employee's rows", async () => {
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Kay",
      slug: "kay",
      role: "Ops",
      soulBody: "",
    });
    const mine = await tool<{ decisionId: string }>("request_decision", {
      title: "Mine",
      options: [{ label: "Yes" }, { label: "No" }],
    });
    const theirToken = issueMcpToken(other.id, company.id, { authority: "employee" });
    await fetch(`${baseUrl}/internal/mcp/tools/request_decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${theirToken}` },
      body: JSON.stringify({ title: "Theirs", options: [{ label: "Yes" }] }),
    });
    revokeMcpToken(theirToken);

    await AppDataSource.getRepository(Decision).update(
      { id: mine.body.decisionId },
      {
        status: "decided",
        chosenOptionId: "yes",
        chosenOptionLabel: "Yes",
        note: "Go ahead.",
        decidedByUserId: owner.id,
        decidedAt: new Date(),
      },
    );

    const listed = await tool<{
      decisions: Array<{ title: string; status: string; chosenOptionLabel: string; note: string }>;
    }>("list_decisions", {});
    assert.deepEqual(
      listed.body.decisions.map((d) => d.title),
      ["Mine"],
    );
    assert.equal(listed.body.decisions[0].status, "decided");
    assert.equal(listed.body.decisions[0].chosenOptionLabel, "Yes");
    assert.equal(listed.body.decisions[0].note, "Go ahead.");
  });

  test("sweeps a lapsed deadline to expired on read", async () => {
    const raised = await tool<{ decisionId: string }>("request_decision", {
      title: "Moot by now",
      options: [{ label: "Yes" }],
    });
    await AppDataSource.getRepository(Decision).update(
      { id: raised.body.decisionId },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    const listed = await tool<{ decisions: Array<{ status: string }> }>("list_decisions", {});
    assert.equal(listed.body.decisions[0].status, "expired");
  });
});

describe("cancel_decision", () => {
  test("retracts the employee's own pending question", async () => {
    const raised = await tool<{ decisionId: string }>("request_decision", {
      title: "Never mind",
      options: [{ label: "Yes" }],
    });
    const cancelled = await tool<{ status: string }>("cancel_decision", {
      decisionId: raised.body.decisionId,
      reason: "Found it myself.",
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
  });

  test("cannot retract another employee's question", async () => {
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Kay",
      slug: "kay",
      role: "Ops",
      soulBody: "",
    });
    const theirToken = issueMcpToken(other.id, company.id, { authority: "employee" });
    const theirs = await fetch(`${baseUrl}/internal/mcp/tools/request_decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${theirToken}` },
      body: JSON.stringify({ title: "Theirs", options: [{ label: "Yes" }] }),
    });
    const { decisionId } = (await theirs.json()) as { decisionId: string };
    revokeMcpToken(theirToken);

    const response = await tool<{ error: string }>("cancel_decision", { decisionId });
    assert.equal(response.status, 404);
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decisionId }))!;
    assert.equal(row.status, "pending");
  });
});

/**
 * Provenance capture. The token the runner (or a chat surface) minted is the
 * only thing that knows where a tool call came from, so these tests pin the
 * hand-off: what is on the token has to end up on the row, or the stack has
 * nothing to link to.
 */
describe("request_decision records where the employee was working", () => {
  async function withToken(
    origin: Parameters<typeof issueMcpToken>[2],
    title: string,
  ): Promise<Decision> {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee", ...origin });
    const response = await tool<{ decisionId: string }>("request_decision", {
      title,
      options: [{ label: "Yes" }],
    });
    assert.equal(response.status, 200);
    return (await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: response.body.decisionId,
    }))!;
  }

  test("a routine run stamps the routine and the run", async () => {
    const row = await withToken(
      { routineId: "routine-1", runId: "run-1" },
      "Stop mid-routine?",
    );
    assert.equal(row.routineId, "routine-1");
    assert.equal(row.runId, "run-1");
    assert.equal(row.conversationId, null);
    assert.equal(row.mailThreadId, null);
  });

  test("a chat turn stamps the conversation", async () => {
    const row = await withToken({ conversationId: "conv-1" }, "Ask mid-chat?");
    assert.equal(row.conversationId, "conv-1");
    assert.equal(row.routineId, null);
  });

  test("a per-email turn stamps the mail thread", async () => {
    const row = await withToken({ mailThreadId: "thread-1" }, "Reply to this?");
    assert.equal(row.mailThreadId, "thread-1");
    assert.equal(row.routineId, null);
  });

  test("a surface with no context leaves every provenance column null", async () => {
    const row = await withToken({}, "Just asking");
    assert.equal(row.routineId, null);
    assert.equal(row.runId, null);
    assert.equal(row.conversationId, null);
    assert.equal(row.mailThreadId, null);
  });

  test("the model is told it will be restarted with the answer", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const response = await tool<{ note: string }>("request_decision", {
      title: "Send it?",
      options: [{ label: "Yes" }],
    });
    assert.match(response.body.note, /started again in a fresh session/);
  });
});
