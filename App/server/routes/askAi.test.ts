import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AskAiMessage } from "../db/entities/AskAiMessage.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { companyDir } from "../services/paths.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { askAiRouter } from "./askAi.js";
import { routinesRouter } from "./routines.js";

/**
 * The HTTP surface of Ask AI, through the real mount so authorization runs.
 *
 * What it must guarantee: any Member may ask; a conversation is readable only
 * by the Member who started it; and the page context a request names is
 * checked against that Member's own access before anything is resolved.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let member: User;
let other: User;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  // Same order as `server/index.ts`: Ask AI ahead of the section routers.
  app.use("/api/companies/:cid", askAiRouter);
  app.use("/api/companies/:cid", routinesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function user(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function join(u: User, role: Role, financeAccess: FinanceAccess = "none") {
  await insert(Membership, { companyId: company.id, userId: u.id, role, financeAccess });
}

beforeEach(async () => {
  await resetTestDb();
  owner = await user("owner");
  member = await user("member");
  other = await user("other");
  company = await insert(Company, {
    name: "Ask AI Routes Co",
    slug: `ask-ai-routes-${randomUUID()}`,
    ownerId: owner.id,
  });
  await join(owner, "owner");
  await join(member, "member");
  await join(other, "member");
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "VP of Go to Market",
  });
  actingUserId = member.id;
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as T };
}

async function newConversation(): Promise<string> {
  const res = await call<{ conversation: { id: string } }>("POST", "/ask-ai/conversations", {});
  assert.equal(res.status, 201);
  return res.body.conversation.id;
}

const page = { path: "/c/acme", label: "Home" };

/** Send a turn and collect the SSE frames it writes. */
async function send(
  conversationId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: Array<[string, unknown]>; raw: string }> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/ask-ai/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page, refs: [], ...body }),
    },
  );
  const raw = await response.text();
  const events: Array<[string, unknown]> = [];
  for (const frame of raw.split("\n\n")) {
    const lines = frame.split("\n");
    const name = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (name) events.push([name, data ? JSON.parse(data) : null]);
  }
  return { status: response.status, events, raw };
}

describe("who may ask", () => {
  test("requires a signed-in Member of the company", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/ask-ai")).status, 401);

    const stranger = await user("stranger");
    actingUserId = stranger.id;
    assert.equal((await call("GET", "/ask-ai")).status, 403);
  });

  test("an ordinary Member can start a conversation and ask, and the answer streams back", async () => {
    const index = await call<{ conversations: unknown[]; roster: Array<{ slug: string }> }>(
      "GET",
      "/ask-ai",
    );
    assert.equal(index.status, 200);
    assert.deepEqual(
      index.body.roster.map((r) => r.slug),
      ["jamie"],
    );
    const id = await newConversation();

    const sent = await send(id, { message: "@jamie what is open today?" });

    assert.equal(sent.status, 200);
    assert.deepEqual(
      sent.events.map(([name]) => name),
      ["user", "targets", "working", "assistant", "done"],
    );
    const loaded = await call<{
      conversation: { title: string };
      messages: Array<{ role: string; status: string | null; content: string; turnId: string | null }>;
    }>("GET", `/ask-ai/conversations/${id}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.conversation.title, "what is open today?");
    assert.equal(loaded.body.messages.length, 2);
    // No AI Model is connected here, so the turn is honestly skipped.
    assert.equal(loaded.body.messages[1].status, "skipped");
    assert.match(loaded.body.messages[1].content, /no AI Model connected/i);
  });

  test("asking about a Routine needs no admin role, while editing it still does", async () => {
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Daily digest",
      slug: "daily-digest",
      cronExpr: "0 9 * * *",
    });
    const id = await newConversation();

    const sent = await send(id, {
      message: "why did it fail?",
      refs: [{ kind: "routine", id: routine.id }],
    });
    assert.equal(sent.status, 200);
    const targets = sent.events.find(([name]) => name === "targets")?.[1] as {
      employees: Array<{ slug: string }>;
    };
    assert.deepEqual(
      targets.employees.map((e) => e.slug),
      ["jamie"],
      "the routine's owner answers an untagged question about it",
    );
    assert.equal((await call("PATCH", `/routines/${routine.id}`, { name: "x" })).status, 403);
  });
});

describe("conversations are private", () => {
  test("another Member cannot list, read, ask in, delete, or stamp someone's conversation", async () => {
    const id = await newConversation();
    await send(id, { message: "@jamie hello" });
    const answer = await AppDataSource.getRepository(AskAiMessage).findOneByOrFail({
      conversationId: id,
      role: "assistant",
    });

    actingUserId = other.id;
    const listed = await call<{ conversations: Array<{ id: string }> }>("GET", "/ask-ai");
    assert.deepEqual(listed.body.conversations, []);
    assert.equal((await call("GET", `/ask-ai/conversations/${id}`)).status, 404);
    assert.equal((await send(id, { message: "@jamie me too" })).status, 404);
    assert.equal(
      (
        await call(
          "POST",
          `/ask-ai/conversations/${id}/messages/${answer.id}/suggestions/s1/executed`,
          {},
        )
      ).status,
      404,
    );
    assert.equal((await call("DELETE", `/ask-ai/conversations/${id}`)).status, 404);

    actingUserId = owner.id;
    assert.equal(
      (await call("GET", `/ask-ai/conversations/${id}`)).status,
      404,
      "not even an owner reads another Member's conversation",
    );

    actingUserId = member.id;
    assert.equal((await call("GET", `/ask-ai/conversations/${id}`)).status, 200);
  });

  test("a conversation id from another company is not found", async () => {
    const id = await newConversation();
    const elsewhere = await insert(Company, {
      name: "Elsewhere",
      slug: `elsewhere-${randomUUID()}`,
      ownerId: member.id,
    });
    await insert(Membership, { companyId: elsewhere.id, userId: member.id, role: "owner" });

    const res = await fetch(`${baseUrl}/api/companies/${elsewhere.id}/ask-ai/conversations/${id}`);
    assert.equal(res.status, 404);
  });

  test("deleting waits for owed answers, then removes the conversation", async () => {
    const id = await newConversation();
    await insert(AskAiMessage, {
      companyId: company.id,
      conversationId: id,
      role: "assistant",
      employeeId: employee.id,
      status: "working",
      createdAt: new Date(),
    });

    const refused = await call<{ error: string }>("DELETE", `/ask-ai/conversations/${id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Wait for the current reply/);

    await AppDataSource.getRepository(AskAiMessage).update({ conversationId: id }, { status: "ok" });
    assert.equal((await call("DELETE", `/ask-ai/conversations/${id}`)).status, 200);
    assert.equal((await call("GET", `/ask-ai/conversations/${id}`)).status, 404);
  });
});

describe("the request boundary", () => {
  test("rejects malformed turns before anything is written", async () => {
    const id = await newConversation();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["an empty message with no files", { message: "   " }],
      ["an unknown context kind", { message: "hi", refs: [{ kind: "approval", id: "x" }] }],
      ["an oversized ref id", { message: "hi", refs: [{ kind: "note", id: "x".repeat(400) }] }],
      [
        "too many refs",
        { message: "hi", refs: Array.from({ length: 9 }, (_, i) => ({ kind: "note", id: `n${i}` })) },
      ],
      ["too many addressees", { message: "hi", employeeIds: Array.from({ length: 6 }, randomUUID) }],
      ["a non-uuid addressee", { message: "hi", employeeIds: ["jamie"] }],
      ["a relative page path", { message: "hi", page: { path: "c/acme", label: null } }],
      ["an unknown field", { message: "hi", surprise: true }],
      ["a malformed attachment id", { message: "hi", attachmentIds: ["nope"] }],
    ];
    for (const [label, body] of bad) {
      const res = await send(id, body);
      assert.equal(res.status, 400, label);
    }
    assert.equal(await AppDataSource.getRepository(AskAiMessage).count(), 0);
    assert.equal((await call("GET", "/ask-ai/conversations/not-a-uuid")).status, 400);
  });

  test("the context preview follows the Member's own finance access", async () => {
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Acme Holdings",
      slug: "acme",
    });
    const refs = [{ kind: "customer", id: "acme" }];

    const asMember = await call<{ items: unknown[] }>("POST", "/ask-ai/context", { refs });
    assert.equal(asMember.status, 200);
    assert.deepEqual(asMember.body.items, [], "a Member without finance access sees nothing");

    actingUserId = owner.id;
    const asOwner = await call<{
      items: Array<{ kind: string; id: string; label: string }>;
      withheld: Record<string, string[]>;
    }>("POST", "/ask-ai/context", { refs });
    assert.deepEqual(
      asOwner.body.items.map((i) => [i.kind, i.id]),
      [["customer", customer.id]],
    );
    assert.deepEqual(
      asOwner.body.withheld,
      { [employee.id]: [`customer:${customer.id}`] },
      "Jamie holds no Finance Grant, and the preview says so",
    );

    assert.equal((await call("POST", "/ask-ai/context", { refs: [{ kind: "nope", id: "1" }] })).status, 400);
  });
});

describe("files", () => {
  async function stage(uploadedByUserId: string, messageId: string | null = null) {
    return insert(Attachment, {
      companyId: company.id,
      uploadedByUserId,
      messageId,
      filename: "clipboard.png",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: "missing-test-image.png",
    });
  }

  test("an image-only message is accepted and binds the Member's own upload", async () => {
    const id = await newConversation();
    const upload = await stage(member.id);

    const sent = await send(id, { message: "", attachmentIds: [upload.id] });

    assert.equal(sent.status, 200);
    assert.match(sent.raw, /clipboard\.png/);
    const row = await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: upload.id });
    assert.ok(row.messageId);
    const owner = await AppDataSource.getRepository(AskAiMessage).findOneByOrFail({
      id: row.messageId!,
    });
    assert.equal(owner.conversationId, id);
  });

  test("downloads are scoped to this conversation or the requester's own unsent upload", async () => {
    const write = (uploadedByUserId: string, filename: string) =>
      recordAttachmentBytes({
        companyId: company.id,
        companySlug: company.slug,
        filename,
        mimeType: "text/plain",
        bytes: Buffer.from(filename),
        uploadedByUserId,
      });
    try {
      const id = await newConversation();
      const mine = await write(member.id, "mine.txt");
      const theirs = await write(other.id, "theirs.txt");
      const boundHere = await write(member.id, "here.txt");
      const boundElsewhere = await write(member.id, "elsewhere.txt");
      const elsewhere = await newConversation();
      const here = await insert(AskAiMessage, {
        companyId: company.id,
        conversationId: id,
        role: "user",
        createdAt: new Date(),
      });
      const there = await insert(AskAiMessage, {
        companyId: company.id,
        conversationId: elsewhere,
        role: "user",
        createdAt: new Date(),
      });
      await AppDataSource.getRepository(Attachment).update({ id: boundHere.id }, { messageId: here.id });
      await AppDataSource.getRepository(Attachment).update(
        { id: boundElsewhere.id },
        { messageId: there.id },
      );
      const get = (attachmentId: string) =>
        fetch(`${baseUrl}/api/companies/${company.id}/ask-ai/conversations/${id}/attachments/${attachmentId}`);

      const own = await get(mine.id);
      assert.equal(own.status, 200);
      assert.equal(await own.text(), "mine.txt");
      assert.equal(own.headers.get("x-content-type-options"), "nosniff");
      assert.equal((await get(boundHere.id)).status, 200);
      assert.equal((await get(theirs.id)).status, 404, "someone else's unsent upload");
      assert.equal((await get(boundElsewhere.id)).status, 404, "a file bound to another conversation");
      assert.equal((await get(randomUUID())).status, 404);

      actingUserId = other.id;
      assert.equal((await get(boundHere.id)).status, 404, "another Member cannot read through it");
    } finally {
      fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
    }
  });
});
