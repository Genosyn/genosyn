import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { MAX_WAITING_DECISIONS_PER_EMPLOYEE } from "../services/decisionDuplicates.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { DECISION_RECOMMENDATION_MAX, DECISION_SUMMARY_MAX } from "../../shared/decisionSummary.js";
import { decisionsRouter } from "./decisions.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Fewer, plainer questions at the seam an AI Employee actually calls:
 * `request_decision` asks for a short summary and recommendation (validated
 * at the boundary, optional only for an older tool list), refuses a question
 * the employee already has waiting or one past the few it may hold — as a
 * tool result that says what to do instead, not an error — and the REST
 * routes the stack reads hand the new lines to every Member, company-scoped.
 */

let server: Server;
let baseUrl = "";
let token = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let owner: User;
let member: User;
let outsider: User;

const humanDecisionReason =
  "This commitment binds the company for three years and exceeds my delegated authority.";
const summary = "Acme will renew for three years if we take 10% off. It locks in $86k a year.";
const recommendation = "Sign it: three years of revenue is worth more than the discount.";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/internal/mcp", mcpInternalRouter);
  app.use("/api/companies/:cid", decisionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  owner = await insert(User, {
    email: "o@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "m@example.test",
    name: "Mo",
    passwordHash: "x",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "x@example.test",
    name: "X",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `intake-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Sales",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  actingUserId = member.id;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function tool<T = Record<string, unknown>>(args: unknown, as = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/request_decision`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function rest<T = Record<string, unknown>>(path: string, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

function ask(changes: Record<string, unknown> = {}) {
  return {
    title: "Sign Acme's three-year renewal?",
    summary,
    recommendation,
    humanDecisionReason,
    options: [{ label: "Sign it", tone: "primary" }, { label: "Counter at 5%" }],
    ...changes,
  };
}

const rows = () => AppDataSource.getRepository(Decision).find({ order: { createdAt: "ASC" } });

describe("the tool an employee reads", () => {
  const request = STATIC_TOOLS.find((entry) => entry.name === "request_decision");
  const properties = (request?.inputSchema.properties ?? {}) as Record<
    string,
    { type: string; maxLength?: number; description?: string }
  >;

  test("asks for the plain question, a summary and a recommendation", () => {
    assert.ok(request);
    for (const field of ["title", "summary", "recommendation", "options", "humanDecisionReason"]) {
      assert.ok(request.inputSchema.required?.includes(field), field);
    }
    assert.equal(properties.summary.maxLength, DECISION_SUMMARY_MAX);
    assert.equal(properties.recommendation.maxLength, DECISION_RECOMMENDATION_MAX);
    assert.match(properties.title.description ?? "", /question in plain words|Plain question/i);
    assert.match(properties.summary.description ?? "", /plain sentences/);
    assert.match(properties.recommendation.description ?? "", /pick and why/);
    assert.equal(request.inputSchema.required?.includes("body"), false, "details stay optional");
  });

  test("says to fold points into one question, and that repeats and a fourth are refused", () => {
    assert.ok(request);
    assert.match(request.description, /One combined question/);
    assert.match(request.description, /a repeat, or a 4th waiting, is refused/);
    assert.equal(MAX_WAITING_DECISIONS_PER_EMPLOYEE + 1, 4, "the description names the next one");
    assert.match(request.description, /busy non-expert owner/);
    assert.match(request.description, /never upkeep, research or wording/);
  });
});

describe("request_decision validates the short lines at the boundary", () => {
  test("stores them, collapsed onto one line, and the REST routes return them", async () => {
    const response = await tool<{ decisionId: string }>(
      ask({ summary: "  Acme will renew for three years\nif we take 10% off.  " }),
    );
    assert.equal(response.status, 200);
    const [row] = await rows();
    assert.equal(row.summary, "Acme will renew for three years if we take 10% off.");
    assert.equal(row.recommendation, recommendation);
    const listed = await rest<
      Array<{ id: string; summary: string; recommendation: string; pickupReport: null }>
    >("/decisions?status=pending");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].summary, "Acme will renew for three years if we take 10% off.");
    assert.equal(listed.body[0].recommendation, recommendation);
    assert.equal(listed.body[0].pickupReport, null);
    const one = await rest<{ summary: string }>(`/decisions/${response.body.decisionId}`);
    assert.equal(one.body.summary, "Acme will renew for three years if we take 10% off.");
  });

  for (const [label, changes, path, pattern] of [
    ["a summary too short to say anything", { summary: "Renewal" }, "summary", /plain sentences/],
    [
      "a summary longer than two sentences' room",
      { summary: "x ".repeat(120) },
      "summary",
      /under 200 characters/,
    ],
    [
      "a recommendation longer than one sentence",
      { recommendation: "y".repeat(161) },
      "recommendation",
      /under 160 characters/,
    ],
    ["an empty recommendation", { recommendation: "   " }, "recommendation", /one sentence/],
    ["a summary that is not text", { summary: 42 }, "summary", /string/i],
  ] as const) {
    test(`refuses ${label}, writing nothing`, async () => {
      const response = await tool<{
        error: string;
        issues: Array<{ path: string[]; message: string }>;
      }>(ask(changes));
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "ValidationError");
      assert.deepEqual(response.body.issues[0].path, [path]);
      assert.match(response.body.issues[0].message, pattern);
      assert.equal(await AppDataSource.getRepository(Decision).count(), 0);
      assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
      assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0);
    });
  }

  test("accepts a call from an older tool list without them, and still refuses unknown fields", async () => {
    const older = await tool<{ decisionId: string }>(
      ask({ summary: undefined, recommendation: undefined, title: "Renew the Initech plan?" }),
    );
    assert.equal(older.status, 200);
    const [row] = await rows();
    assert.equal(row.summary, null);
    assert.equal(row.recommendation, null);
    const unknown = await tool<{ error: string }>(
      ask({ title: "Hire an engineer?", headline: "x" }),
    );
    assert.equal(unknown.status, 400);
  });
});

describe("request_decision refuses a repeat or one too many, as a tool result", () => {
  test("a repeat points at the question already waiting and stacks nothing", async () => {
    const first = await tool<{ decisionId: string }>(ask());
    const repeat = await tool<Record<string, unknown>>(
      ask({
        title: "Sign the three-year renewal for Acme?",
        summary: "Acme asked again about the renewal.",
      }),
    );
    assert.equal(repeat.status, 200, "not an error: the question is already in front of people");
    assert.equal(repeat.body.decisionId, null);
    assert.equal(repeat.body.status, "already_waiting");
    assert.equal(repeat.body.stacked, false);
    assert.equal(repeat.body.existingDecisionId, first.body.decisionId);
    assert.equal(repeat.body.existingTitle, "Sign Acme's three-year renewal?");
    assert.equal(repeat.body.match, "same_question");
    assert.match(String(repeat.body.note), /You already asked this and it is still waiting/);
    assert.match(String(repeat.body.note), new RegExp(`\\(id ${first.body.decisionId}\\)`));
    assert.equal((await rows()).length, 1);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).count(),
      1,
      "no second journal note",
    );
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "decision.create" }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(Notification).countBy({ kind: "decision_pending" }),
      1,
    );
  });

  test("past the limit it lists what is waiting and says what to do instead", async () => {
    const titles = [
      "Sign Acme's three-year renewal?",
      "Hire a support engineer?",
      "Book the trade show booth?",
    ];
    for (const title of titles) assert.equal((await tool(ask({ title }))).status, 200);
    const refused = await tool<{
      decisionId: null;
      status: string;
      stacked: boolean;
      limit: number;
      waiting: Array<{ decisionId: string; title: string; askedAt: string }>;
      note: string;
    }>(ask({ title: "Raise list prices next quarter?" }));
    assert.equal(refused.status, 200);
    assert.equal(refused.body.status, "too_many_waiting");
    assert.equal(refused.body.stacked, false);
    assert.equal(refused.body.decisionId, null);
    assert.equal(refused.body.limit, MAX_WAITING_DECISIONS_PER_EMPLOYEE);
    assert.deepEqual(
      refused.body.waiting.map((entry) => entry.title),
      titles,
    );
    for (const entry of refused.body.waiting) assert.ok(!Number.isNaN(Date.parse(entry.askedAt)));
    assert.match(refused.body.note, /may hold at most 3 at once/);
    assert.match(refused.body.note, /cancel_decision/);
    assert.equal((await rows()).length, 3);
    // Retracting one with the existing tool makes room.
    const cancel = await fetch(`${baseUrl}/internal/mcp/tools/cancel_decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        decisionId: refused.body.waiting[2].decisionId,
        reason: "Folded in.",
      }),
    });
    assert.equal(cancel.status, 200);
    const retried = await tool<{ decisionId: string }>(
      ask({ title: "Raise list prices next quarter?" }),
    );
    assert.ok(retried.body.decisionId);
  });

  test("another employee or company never counts against this one", async () => {
    for (const title of [
      "One question for Kai?",
      "Two questions for Kai?",
      "Three questions for Kai?",
    ]) {
      await tool(ask({ title }));
    }
    const colleague = await insert(AIEmployee, {
      companyId: company.id,
      name: "Kai",
      slug: "kai",
      role: "Ops",
      soulBody: "",
    });
    const colleagueToken = issueMcpToken(colleague.id, company.id, { authority: "employee" });
    try {
      const own = await tool<{ decisionId: string }>(
        ask({ title: "One question for Kai?" }),
        colleagueToken,
      );
      assert.ok(own.body.decisionId, "Rey's questions are not Kai's");
    } finally {
      revokeMcpToken(colleagueToken);
    }
    const elsewhere = await insert(Company, {
      name: "Globex",
      slug: `globex-${randomUUID()}`,
      ownerId: owner.id,
    });
    const stranger = await insert(AIEmployee, {
      companyId: elsewhere.id,
      name: "Rey",
      slug: "rey",
      role: "Sales",
      soulBody: "",
    });
    const strangerToken = issueMcpToken(stranger.id, elsewhere.id, { authority: "employee" });
    try {
      const theirs = await tool<{ decisionId: string }>(
        ask({ title: "One question for Kai?" }),
        strangerToken,
      );
      assert.ok(theirs.body.decisionId, "another company's stack is its own");
    } finally {
      revokeMcpToken(strangerToken);
    }
  });

  test("a refusal is a tool result an employee reads, never a page for a person", async () => {
    await tool(ask());
    const before = await AppDataSource.getRepository(Notification).count();
    for (let attempt = 0; attempt < 3; attempt += 1) await tool(ask());
    assert.equal(await AppDataSource.getRepository(Notification).count(), before);
  });
});

describe("the REST routes the stack reads", () => {
  test("serve the new lines and the pickup report to any Member of the company only", async () => {
    const response = await tool<{ decisionId: string }>(ask());
    await AppDataSource.getRepository(Decision).update(
      { id: response.body.decisionId },
      {
        status: "decided",
        pickupStatus: "done",
        pickupSummary: "Step one.\n\nSigned and filed it.",
        pickupReport: "Signed and filed it.",
      },
    );
    const one = await rest<{ pickupReport: string; pickupSummary: string; summary: string }>(
      `/decisions/${response.body.decisionId}`,
    );
    assert.equal(one.status, 200);
    assert.equal(one.body.pickupReport, "Signed and filed it.");
    assert.equal(one.body.pickupSummary, "Step one.\n\nSigned and filed it.");
    actingUserId = outsider.id;
    assert.equal((await rest(`/decisions/${response.body.decisionId}`)).status, 403);
    actingUserId = null;
    assert.equal((await rest(`/decisions/${response.body.decisionId}`)).status, 401);
    actingUserId = owner.id;
    const elsewhere = await insert(Company, {
      name: "Globex",
      slug: `globex-${randomUUID()}`,
      ownerId: owner.id,
    });
    await insert(Membership, { companyId: elsewhere.id, userId: owner.id, role: "owner" });
    assert.equal((await rest(`/decisions/${response.body.decisionId}`, elsewhere.id)).status, 404);
  });
});
