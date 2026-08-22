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
import {
  TldrQuestionAction,
  type TldrActionKind,
} from "../db/entities/TldrQuestionAction.js";
import { TldrQuestionMessage } from "../db/entities/TldrQuestionMessage.js";
import { TldrStandingQuestion } from "../db/entities/TldrStandingQuestion.js";
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

describe("standing questions on TLDR settings", () => {
  test("an admin saves the list with the schedule and reads it back", async () => {
    const saved = await call<{ questions: Array<{ id: string; prompt: string; enabled: boolean }> }>(
      "PUT",
      "/tldrs/settings",
      {
        enabled: false,
        cadence: "daily",
        employeeId: employee.id,
        questions: [
          { prompt: "What should we stop doing?", enabled: true },
          { prompt: "What needs a decision from me?", enabled: false },
        ],
      },
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(
      saved.body.questions.map((q) => [q.prompt, q.enabled]),
      [
        ["What should we stop doing?", true],
        ["What needs a decision from me?", false],
      ],
    );

    const fetched = await call<{ questions: Array<{ id: string; prompt: string }> }>(
      "GET",
      "/tldrs/settings",
    );
    assert.deepEqual(
      fetched.body.questions.map((q) => q.prompt),
      ["What should we stop doing?", "What needs a decision from me?"],
    );
  });

  test("omitting the field leaves an existing list alone", async () => {
    await call("PUT", "/tldrs/settings", {
      enabled: false,
      cadence: "daily",
      employeeId: employee.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    // An older client saving only a cadence must not wipe questions it has
    // never heard of.
    const saved = await call<{ questions: unknown[]; cadence: string }>("PUT", "/tldrs/settings", {
      enabled: false,
      cadence: "weekly",
      employeeId: employee.id,
    });
    assert.equal(saved.body.cadence, "weekly");
    assert.equal(saved.body.questions.length, 1);
  });

  test("rejects an over-long question, too many of them, and an unknown field", async () => {
    const base = { enabled: false, cadence: "daily", employeeId: employee.id };
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          ...base,
          questions: [{ prompt: "x".repeat(501), enabled: true }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          ...base,
          questions: Array.from({ length: 9 }, (_, index) => ({
            prompt: `Question ${index}`,
            enabled: true,
          })),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          ...base,
          questions: [{ prompt: "Fine", enabled: true, surprise: true }],
        })
      ).status,
      400,
    );
    assert.equal(await AppDataSource.getRepository(TldrStandingQuestion).count(), 0);
  });

  test("a plain Member may read the list but not change it", async () => {
    await call("PUT", "/tldrs/settings", {
      enabled: false,
      cadence: "daily",
      employeeId: employee.id,
      questions: [{ prompt: "What should we stop doing?", enabled: true }],
    });
    actingUserId = member.id;
    const read = await call<{ questions: unknown[] }>("GET", "/tldrs/settings");
    assert.equal(read.status, 200);
    assert.equal(read.body.questions.length, 1);
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          enabled: false,
          cadence: "daily",
          employeeId: employee.id,
          questions: [],
        })
      ).status,
      403,
    );
    assert.equal(await AppDataSource.getRepository(TldrStandingQuestion).count(), 1);
  });
});

describe("suggested actions on a card", () => {
  /** A card with one proposed button, without going through a model. */
  async function cardWithAction(kind: TldrActionKind = "todo"): Promise<{
    tldr: Tldr;
    question: TldrQuestion;
    action: TldrQuestionAction;
  }> {
    const tldr = await readyTldr();
    const question = await insert(TldrQuestion, {
      companyId: company.id,
      tldrId: tldr.id,
      employeeId: employee.id,
      prompt: "What should we stop doing?",
      origin: "standing",
      standingQuestionId: null,
      promptMessageId: null,
      createdByUserId: null,
    });
    const message = await insert(TldrQuestionMessage, {
      companyId: company.id,
      tldrId: tldr.id,
      questionId: question.id,
      role: "assistant",
      employeeId: employee.id,
      modelId: null,
      content: "Stop the nightly scrape.",
      status: "ok",
      actionsJson: "",
      actionId: null,
      createdByUserId: null,
    });
    const action = await insert(TldrQuestionAction, {
      companyId: company.id,
      tldrId: tldr.id,
      questionId: question.id,
      messageId: message.id,
      kind,
      label: "Pause it",
      intent: "Pause the Nightly Scrape Routine.",
      position: 0,
      status: "proposed",
      runMessageId: null,
      completedByUserId: null,
    });
    return { tldr, question, action };
  }

  test("the card list carries each button and whether this Member may press it", async () => {
    const { tldr, action } = await cardWithAction("routine");
    actingUserId = member.id;
    const listed = await call<{
      questions: Array<{
        origin: string;
        suggestedActions: Array<{ id: string; label: string; intent: string; runnable: boolean }>;
      }>;
    }>("GET", `/tldrs/${tldr.id}/questions`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.questions[0].origin, "standing");
    assert.deepEqual(listed.body.questions[0].suggestedActions, [
      {
        id: action.id,
        questionId: action.questionId,
        messageId: action.messageId,
        kind: "routine",
        label: "Pause it",
        intent: "Pause the Nightly Scrape Routine.",
        status: "proposed",
        runMessageId: null,
        completedByUserId: null,
        runnable: false,
        createdAt: action.createdAt.toISOString(),
      },
    ]);
  });

  test("a plain Member is refused a Routine button at the route, not only in the UI", async () => {
    const { tldr, question, action } = await cardWithAction("routine");
    actingUserId = member.id;
    const pressed = await stream(
      `/tldrs/${tldr.id}/questions/${question.id}/actions/${action.id}/run`,
      {},
    );
    assert.deepEqual(
      pressed.events.map(([name]) => name),
      ["error", "done"],
    );
    assert.match(String(pressed.events[0][1].message), /owner or admin/);
    const untouched = await AppDataSource.getRepository(TldrQuestionAction).findOneByOrFail({
      id: action.id,
    });
    assert.equal(untouched.status, "proposed", "a refused press must not claim the button");
  });

  test("a button already carried out refuses a second press", async () => {
    const { tldr, question, action } = await cardWithAction();
    await AppDataSource.getRepository(TldrQuestionAction).update(
      { id: action.id },
      { status: "done" },
    );
    const pressed = await stream(
      `/tldrs/${tldr.id}/questions/${question.id}/actions/${action.id}/run`,
      {},
    );
    assert.match(String(pressed.events[0][1].message), /already been carried out/);
  });

  test("a button on another company's briefing is not found", async () => {
    const { question, action } = await cardWithAction();
    const foreign = await readyTldr(otherCompany.id);
    const pressed = await stream(
      `/tldrs/${foreign.id}/questions/${question.id}/actions/${action.id}/run`,
      {},
      otherCompany.id,
    );
    assert.match(String(pressed.events[0][1].message), /not found/);
  });

  test("dismissing clears the button for the company without deleting the record", async () => {
    const { tldr, question, action } = await cardWithAction();
    actingUserId = member.id;
    const dismissed = await call(
      "DELETE",
      `/tldrs/${tldr.id}/questions/${question.id}/actions/${action.id}`,
    );
    assert.equal(dismissed.status, 200);
    const row = await AppDataSource.getRepository(TldrQuestionAction).findOneByOrFail({
      id: action.id,
    });
    assert.equal(row.status, "dismissed");

    const listed = await call<{ questions: Array<{ suggestedActions: unknown[] }> }>(
      "GET",
      `/tldrs/${tldr.id}/questions`,
    );
    // Still serialized — the client is what hides a dismissed suggestion, so a
    // reopened card can still say the employee suggested it.
    assert.equal(listed.body.questions[0].suggestedActions.length, 1);
  });

  test("rejects a non-uuid action id and an extra body field at the zod boundary", async () => {
    const { tldr, question, action } = await cardWithAction();
    assert.equal(
      (await call("DELETE", `/tldrs/${tldr.id}/questions/${question.id}/actions/not-a-uuid`))
        .status,
      400,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/tldrs/${tldr.id}/questions/${question.id}/actions/${action.id}/run`,
          { surprise: true },
        )
      ).status,
      400,
    );
  });
});
