import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Tldr } from "../db/entities/Tldr.js";
import { TldrQuestion } from "../db/entities/TldrQuestion.js";
import { TldrQuestionMessage } from "../db/entities/TldrQuestionMessage.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { tldrsRouter } from "./tldrs.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    next();
  });
  app.use("/api/companies/:cid", tldrsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "tldr-route-owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "tldr-route-member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "tldr-route-acme", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "tldr-route-other",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey-route",
    role: "Chief of staff",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: {
      connection: "close",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function readyTldr(companyId = company.id): Promise<Tldr> {
  const now = new Date("2026-08-20T12:00:00.000Z");
  return insert(Tldr, {
    companyId,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeSlug: employee.slug,
    employeeRole: employee.role,
    employeeAvatarKey: null,
    status: "ready",
    triggerKind: "schedule",
    periodStart: new Date(now.getTime() - 4 * 60 * 60_000),
    periodEnd: now,
    title: "Morning update",
    summary: "One useful sentence.",
    body: "## Done\n\nImportant work shipped.",
    sourceStatsJson: JSON.stringify({
      journalEntries: 1,
      routineRuns: 2,
      channelMessages: 3,
      channels: 1,
    }),
    errorMessage: "",
    finishedAt: now,
  });
}

describe("TLDR route contract and authorization", () => {
  test("lets an admin configure and synchronously reports an empty generation window", async () => {
    const saved = await call<{
      enabled: boolean;
      cadence: string;
      employeeId: string | null;
      lastCoveredAt: string | null;
      lastAttemptAt: string | null;
    }>("PUT", "/tldrs/settings", {
      enabled: false,
      cadence: "eight_hours",
      employeeId: employee.id,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.cadence, "eight_hours");
    assert.equal(saved.body.employeeId, employee.id);
    assert.ok(Object.hasOwn(saved.body, "lastCoveredAt"));
    assert.ok(Object.hasOwn(saved.body, "lastAttemptAt"));

    const generated = await call<{ status: string }>("POST", "/tldrs/generate", {});
    assert.equal(generated.status, 200);
    assert.deepEqual(generated.body, { status: "empty" });
  });

  test("returns the list envelope and keeps dismissal private to one Member", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;
    const list = await call<{
      items: Array<{ id: string; dismissed: boolean; sourceStats: Record<string, number> }>;
      total: number;
      unreadCount: number;
    }>("GET", "/tldrs");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.unreadCount, 1);
    assert.equal(list.body.items[0].id, tldr.id);
    assert.equal(list.body.items[0].dismissed, false);
    assert.deepEqual(Object.keys(list.body.items[0].sourceStats).sort(), [
      "channelMessages",
      "channels",
      "journalEntries",
      "routineRuns",
    ]);

    const dismissed = await call<{ id: string; dismissed: boolean }>(
      "POST",
      `/tldrs/${tldr.id}/dismiss`,
      {},
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.dismissed, true);
    const again = await call("POST", `/tldrs/${tldr.id}/dismiss`, {});
    assert.equal(again.status, 200);
    assert.equal((await call<{ unreadCount: number }>("GET", "/tldrs")).body.unreadCount, 0);

    actingUserId = owner.id;
    assert.equal((await call<{ unreadCount: number }>("GET", "/tldrs")).body.unreadCount, 1);
  });

  test("allows Member reads and dismissals but reserves settings and generation for admins", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;
    const defaults = await call<{ enabled: boolean; cadence: string; employeeId: string | null }>(
      "GET",
      "/tldrs/settings",
    );
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.enabled, true);
    assert.equal(defaults.body.cadence, "daily");
    assert.equal(defaults.body.employeeId, null);
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          enabled: false,
          cadence: "daily",
          employeeId: employee.id,
        })
      ).status,
      403,
    );
    assert.equal((await call("POST", "/tldrs/generate", {})).status, 403);
    assert.equal((await call("POST", `/tldrs/${tldr.id}/dismiss`, {})).status, 200);
    actingUserId = owner.id;
    assert.equal(
      (await call("POST", `/tldrs/${tldr.id}/dismiss`, {}, otherCompany.id)).status,
      404,
    );
  });

  test("rejects unknown cadence and extra body fields at the zod boundary", async () => {
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          enabled: false,
          cadence: "hourly",
          employeeId: employee.id,
        })
      ).status,
      400,
    );
    assert.equal((await call("POST", "/tldrs/generate", { surprise: true })).status, 400);
  });
});

/**
 * Read a whole SSE response into its `(event, data)` pairs.
 *
 * These endpoints answer errors as events rather than status codes, because by
 * the time anything can go wrong the headers are already flushed — so a test
 * that asserted on `response.status` would pass while the human saw nothing.
 */
async function stream(
  path: string,
  body: unknown,
  companyId = company.id,
): Promise<{ status: number; events: Array<[string, Record<string, unknown>]> }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method: "POST",
    headers: { connection: "close", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events: Array<[string, Record<string, unknown>]> = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    const name = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (!name) continue;
    events.push([name, data ? (JSON.parse(data) as Record<string, unknown>) : {}]);
  }
  return { status: response.status, events };
}

describe("TLDR question cards", () => {
  test("any Member can ask, and the turn is persisted before the model runs", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;

    const asked = await stream(`/tldrs/${tldr.id}/questions`, {
      prompt: "What can be improved?",
    });
    assert.equal(asked.status, 200);
    assert.deepEqual(
      asked.events.map(([name]) => name),
      ["question", "working", "assistant", "done"],
    );

    const card = await AppDataSource.getRepository(TldrQuestion).findOneByOrFail({
      tldrId: tldr.id,
    });
    assert.equal(card.prompt, "What can be improved?");
    assert.equal(card.createdByUserId, member.id);

    // No AI Model is connected in this harness, so the turn finalizes with an
    // honest explanation rather than a spinner nobody will ever close.
    const rows = await AppDataSource.getRepository(TldrQuestionMessage).find({
      where: { questionId: card.id },
      order: { createdAt: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, "error");
    assert.match(rows[1].content, /needs a connected active AI Model/);
    assert.equal(
      await AppDataSource.getRepository(TldrQuestionMessage).countBy({ status: "working" }),
      0,
    );

    const listed = await call<{
      questions: Array<{ id: string; prompt: string; messages: unknown[] }>;
      canAsk: boolean;
      canDelegateAutomation: boolean;
    }>("GET", `/tldrs/${tldr.id}/questions`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.questions.length, 1);
    assert.equal(listed.body.canAsk, true);
    // A plain Member cannot delegate the tools that change company automation.
    assert.equal(listed.body.canDelegateAutomation, false);
    // The seeded prompt row is the card header, not a line of the thread.
    assert.equal(listed.body.questions[0].messages.length, 1);
  });

  test("reports a missing briefing as a stream event, not an HTTP status", async () => {
    const tldr = await readyTldr(otherCompany.id);

    const asked = await stream(`/tldrs/${tldr.id}/questions`, { prompt: "What can be improved?" });
    assert.equal(asked.status, 200);
    assert.deepEqual(
      asked.events.map(([name]) => name),
      ["error", "done"],
    );
    assert.match(String(asked.events[0][1].message), /TLDR not found/);
  });

  test("the asker can remove their own card and another Member cannot", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;
    await stream(`/tldrs/${tldr.id}/questions`, { prompt: "What should we stop doing?" });
    const card = await AppDataSource.getRepository(TldrQuestion).findOneByOrFail({
      tldrId: tldr.id,
    });

    actingUserId = owner.id;
    // An owner may clear anyone's card; a plain Member may not.
    const secondMember = await insert(User, {
      email: "tldr-route-second@example.test",
      name: "Second",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: secondMember.id, role: "member" });
    actingUserId = secondMember.id;
    assert.equal((await call("DELETE", `/tldrs/${tldr.id}/questions/${card.id}`)).status, 400);

    actingUserId = owner.id;
    assert.equal((await call("DELETE", `/tldrs/${tldr.id}/questions/${card.id}`)).status, 200);
    assert.equal(await AppDataSource.getRepository(TldrQuestion).count(), 0);
    assert.equal(await AppDataSource.getRepository(TldrQuestionMessage).count(), 0);
  });

  test("rejects an over-length question and an extra body field at the zod boundary", async () => {
    const tldr = await readyTldr();
    assert.equal(
      (await call("POST", `/tldrs/${tldr.id}/questions`, { prompt: "x".repeat(501) })).status,
      400,
    );
    assert.equal(
      (await call("POST", `/tldrs/${tldr.id}/questions`, { prompt: "Fine", surprise: true }))
        .status,
      400,
    );
    assert.equal((await call("POST", `/tldrs/${tldr.id}/questions`, { prompt: "" })).status, 400);
  });

  test("reports the question count on the list so the page can label Discuss", async () => {
    const tldr = await readyTldr();
    await stream(`/tldrs/${tldr.id}/questions`, { prompt: "What can be improved?" });

    const list = await call<{ items: Array<{ id: string; questionCount: number }> }>(
      "GET",
      "/tldrs",
    );
    assert.equal(list.body.items[0].questionCount, 1);
  });
});
