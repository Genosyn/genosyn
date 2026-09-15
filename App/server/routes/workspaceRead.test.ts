import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel, type ChannelKind } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { workspaceRouter } from "./workspace.js";

/**
 * The Home unread-messages card and the full Workspace both clear a channel
 * through the same real route. These tests pin the boundary around that write:
 * the URL company, signed-in Member, channel visibility and per-Member marker
 * must all agree before `lastReadAt` moves.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

let company: Company;
let otherCompany: Company;
let reader: User;
let teammate: User;
let outsider: User;
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
  app.use("/api/companies/:cid/workspace", workspaceRouter);
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

beforeEach(async () => {
  await resetTestDb();

  reader = await insert(User, {
    email: "reader@example.test",
    name: "Reader",
    passwordHash: "x",
    sessionVersion: 0,
  });
  teammate = await insert(User, {
    email: "teammate@example.test",
    name: "Teammate",
    passwordHash: "x",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });

  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: reader.id,
  });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "other",
    ownerId: outsider.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: reader.id,
    role: "owner" as Role,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: teammate.id,
    role: "member" as Role,
  });
  await insert(Membership, {
    companyId: otherCompany.id,
    userId: outsider.id,
    role: "owner" as Role,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  actingUserId = reader.id;
});

type ApiResult = { status: number; body: unknown };

async function call(companyId: string, method: "GET" | "POST", path: string): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/workspace${path}`, {
    method,
    headers: { connection: "close" },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createChannel(
  kind: ChannelKind,
  options: { companyId?: string; name?: string } = {},
): Promise<Channel> {
  const name = options.name ?? `${kind}-${testId("channel")}`;
  return insert(Channel, {
    companyId: options.companyId ?? company.id,
    kind,
    name: kind === "dm" ? null : name,
    slug: kind === "dm" ? null : name,
    topic: "",
    webhookToken: null,
    createdByUserId: null,
    archivedAt: null,
    lastMessageAt: null,
  });
}

async function addUser(
  channel: Channel,
  user: User,
  lastReadAt: Date | null,
): Promise<ChannelMember> {
  return insert(ChannelMember, {
    channelId: channel.id,
    memberKind: "user",
    userId: user.id,
    employeeId: null,
    lastReadAt,
  });
}

type MessageAuthor =
  | { kind: "user"; user: User }
  | { kind: "ai"; employee: AIEmployee }
  | { kind: "system"; name: string };

async function addMessage(
  channel: Channel,
  author: MessageAuthor,
  createdAt: Date,
): Promise<ChannelMessage> {
  const message = await insert(ChannelMessage, {
    channelId: channel.id,
    authorKind: author.kind,
    authorUserId: author.kind === "user" ? author.user.id : null,
    authorEmployeeId: author.kind === "ai" ? author.employee.id : null,
    authorName: author.kind === "system" ? author.name : null,
    content: `${author.kind} message`,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt,
  });
  await AppDataSource.getRepository(Channel).update(
    { id: channel.id },
    { lastMessageAt: createdAt },
  );
  return message;
}

type ChannelResponse = {
  id: string;
  unreadCount: number;
  lastReadAt: string | null;
};

async function channelAs(user: User, target: Channel): Promise<ChannelResponse> {
  actingUserId = user.id;
  const result = await call(target.companyId, "GET", `/channels/${target.id}`);
  assert.equal(result.status, 200);
  const body = result.body as ChannelResponse;
  return {
    id: body.id,
    unreadCount: body.unreadCount,
    lastReadAt: body.lastReadAt,
  };
}

async function memberFor(target: Channel, user: User): Promise<ChannelMember | null> {
  return AppDataSource.getRepository(ChannelMember).findOneBy({
    channelId: target.id,
    userId: user.id,
  });
}

describe("POST /channels/:channelId/read", () => {
  test("requires authentication and does not create a public-channel marker", async () => {
    const target = await createChannel("public");
    actingUserId = null;

    const result = await call(company.id, "POST", `/channels/${target.id}/read`);

    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "Unauthorized" });
    assert.equal(await memberFor(target, reader), null);
  });

  test("requires Membership in the company named by the URL", async () => {
    const target = await createChannel("public");
    actingUserId = outsider.id;

    const result = await call(company.id, "POST", `/channels/${target.id}/read`);

    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "Forbidden" });
    assert.equal(await memberFor(target, outsider), null);
  });

  test("does not expose or mutate a channel belonging to another company", async () => {
    const foreign = await createChannel("public", { companyId: otherCompany.id });
    const foreignMarker = new Date("2026-01-03T10:00:00.000Z");
    await addUser(foreign, outsider, foreignMarker);

    const result = await call(company.id, "POST", `/channels/${foreign.id}/read`);

    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "Channel not found" });
    assert.equal(await memberFor(foreign, reader), null);
    assert.equal(
      (await memberFor(foreign, outsider))?.lastReadAt?.toISOString(),
      foreignMarker.toISOString(),
    );
  });

  test("makes a missing channel indistinguishable from a foreign one", async () => {
    const foreign = await createChannel("public", { companyId: otherCompany.id });

    const foreignResult = await call(company.id, "POST", `/channels/${foreign.id}/read`);
    const missingResult = await call(
      company.id,
      "POST",
      "/channels/00000000-0000-4000-8000-000000000000/read",
    );

    assert.equal(foreignResult.status, 404);
    assert.equal(missingResult.status, 404);
    assert.deepEqual(foreignResult.body, missingResult.body);
  });

  test("refuses private channels and DMs unless the caller is a channel member", async () => {
    for (const kind of ["private", "dm"] as const) {
      const target = await createChannel(kind);
      await addUser(target, teammate, null);

      const result = await call(company.id, "POST", `/channels/${target.id}/read`);

      assert.equal(result.status, 404, kind);
      assert.deepEqual(result.body, { error: "Channel not found" });
      assert.equal(await memberFor(target, reader), null);
    }
  });

  test("creates the caller's first public-channel marker and clears every current non-self message", async () => {
    const target = await createChannel("public");
    const start = new Date("2026-01-01T10:00:00.000Z");
    await addMessage(target, { kind: "user", user: reader }, start);
    await addMessage(target, { kind: "user", user: teammate }, new Date(start.getTime() + 1_000));
    await addMessage(target, { kind: "ai", employee }, new Date(start.getTime() + 2_000));
    await addMessage(
      target,
      { kind: "system", name: "Buildkite" },
      new Date(start.getTime() + 3_000),
    );

    assert.deepEqual(await channelAs(reader, target), {
      id: target.id,
      unreadCount: 3,
      lastReadAt: null,
    });
    const before = Date.now();

    const result = await call(company.id, "POST", `/channels/${target.id}/read`);

    const after = Date.now();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    const marker = await memberFor(target, reader);
    assert.ok(marker);
    assert.equal(marker.memberKind, "user");
    assert.equal(marker.employeeId, null);
    const markedAt = marker.lastReadAt;
    assert.ok(markedAt);
    assert.ok(markedAt.getTime() >= before);
    assert.ok(markedAt.getTime() <= after);
    assert.deepEqual(await channelAs(reader, target), {
      id: target.id,
      unreadCount: 0,
      lastReadAt: markedAt.toISOString(),
    });

    // The marker is a boundary, not a permanent dismissal: later messages by
    // somebody else become unread, while a later message by the reader does not.
    await addMessage(target, { kind: "user", user: reader }, new Date(markedAt.getTime() + 1_000));
    await addMessage(target, { kind: "ai", employee }, new Date(markedAt.getTime() + 2_000));
    assert.equal((await channelAs(reader, target)).unreadCount, 1);
  });

  test("updates existing private-channel and DM markers without touching another member", async () => {
    for (const kind of ["private", "dm"] as const) {
      const target = await createChannel(kind);
      const oldReaderMarker = new Date("2026-01-01T08:00:00.000Z");
      const teammateMarker = new Date("2026-01-01T09:00:00.000Z");
      await addUser(target, reader, oldReaderMarker);
      await addUser(target, teammate, teammateMarker);
      await addMessage(target, { kind: "ai", employee }, new Date("2026-01-01T10:00:00.000Z"));
      assert.equal((await channelAs(reader, target)).unreadCount, 1, kind);

      const result = await call(company.id, "POST", `/channels/${target.id}/read`);

      assert.equal(result.status, 200, kind);
      assert.deepEqual(result.body, { ok: true });
      const readerAfter = await memberFor(target, reader);
      const readerMarkedAt = readerAfter?.lastReadAt;
      assert.ok(readerMarkedAt);
      assert.ok(readerMarkedAt.getTime() > oldReaderMarker.getTime());
      assert.equal(
        (await memberFor(target, teammate))?.lastReadAt?.toISOString(),
        teammateMarker.toISOString(),
      );
      assert.equal((await channelAs(reader, target)).unreadCount, 0, kind);
    }
  });

  test("clears only the authenticated Member's unread count", async () => {
    const target = await createChannel("private");
    const oldMarker = new Date("2026-01-01T08:00:00.000Z");
    await addUser(target, reader, oldMarker);
    await addUser(target, teammate, oldMarker);
    await addMessage(target, { kind: "ai", employee }, new Date("2026-01-01T10:00:00.000Z"));
    assert.equal((await channelAs(reader, target)).unreadCount, 1);
    assert.equal((await channelAs(teammate, target)).unreadCount, 1);

    actingUserId = reader.id;
    const result = await call(company.id, "POST", `/channels/${target.id}/read`);

    assert.equal(result.status, 200);
    assert.equal((await channelAs(reader, target)).unreadCount, 0);
    assert.equal((await channelAs(teammate, target)).unreadCount, 1);
    assert.equal(
      (await memberFor(target, teammate))?.lastReadAt?.toISOString(),
      oldMarker.toISOString(),
    );
  });

  test("is sequentially idempotent and never creates a duplicate public membership", async () => {
    const target = await createChannel("public");
    await addMessage(
      target,
      { kind: "user", user: teammate },
      new Date("2026-01-01T10:00:00.000Z"),
    );

    const first = await call(company.id, "POST", `/channels/${target.id}/read`);
    const firstMarker = await memberFor(target, reader);
    const second = await call(company.id, "POST", `/channels/${target.id}/read`);
    const secondMarker = await memberFor(target, reader);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.deepEqual(second.body, { ok: true });
    const firstMarkedAt = firstMarker?.lastReadAt;
    const secondMarkedAt = secondMarker?.lastReadAt;
    assert.ok(firstMarkedAt);
    assert.ok(secondMarkedAt);
    assert.ok(secondMarkedAt.getTime() >= firstMarkedAt.getTime());
    assert.equal(
      await AppDataSource.getRepository(ChannelMember).count({
        where: { channelId: target.id, userId: reader.id },
      }),
      1,
    );
    assert.equal((await channelAs(reader, target)).unreadCount, 0);
  });
});
