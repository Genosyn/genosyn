import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { webhooksRouter } from "./webhooks.js";
import { workspaceRouter } from "./workspace.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let channel: Channel;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/companies/:cid/workspace", workspaceRouter);
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
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  channel = await insert(Channel, {
    companyId: company.id,
    kind: "public",
    name: "Deployments",
    slug: "deployments",
    topic: "",
    webhookToken: null,
    createdByUserId: owner.id,
    archivedAt: null,
    lastMessageAt: null,
  });
  await insert(ChannelMember, {
    channelId: channel.id,
    memberKind: "user",
    userId: owner.id,
    employeeId: null,
    lastReadAt: new Date(),
  });
});

async function workspaceCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/workspace${path}`, {
    method,
    headers:
      body === undefined
        ? { connection: "close" }
        : { connection: "close", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("channel incoming webhooks", () => {
  test("can be enabled in channel settings and accepts Slack JSON", async () => {
    const initial = await workspaceCall("GET", `/channels/${channel.id}/webhook`);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { enabled: false, url: null });

    const enabled = await workspaceCall("POST", `/channels/${channel.id}/webhook`, {
      enabled: true,
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);
    assert.equal(typeof enabled.body.url, "string");

    const webhookPath = new URL(String(enabled.body.url)).pathname;
    const delivered = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: { connection: "close", "content-type": "application/json" },
      body: JSON.stringify({
        username: "Buildkite",
        text: "Deploy <https://example.com/build/42|#42> completed.",
        channel: "#ignored",
      }),
    });
    assert.equal(delivered.status, 200);
    assert.equal(await delivered.text(), "ok");

    const message = await AppDataSource.getRepository(ChannelMessage).findOneBy({
      channelId: channel.id,
    });
    assert.equal(message?.authorKind, "system");
    assert.equal(message?.authorName, "Buildkite");
    assert.equal(message?.content, "Deploy [#42](https://example.com/build/42) completed.");

    const history = await workspaceCall("GET", `/channels/${channel.id}/messages`);
    assert.equal(history.status, 200);
    const messages = history.body as unknown as Array<{
      author: { name: string };
    }>;
    assert.equal(messages[0].author.name, "Buildkite");

    const auditActions = (
      await AppDataSource.getRepository(AuditEvent).findBy({ companyId: company.id })
    ).map((row) => row.action);
    assert.ok(auditActions.includes("channel.webhook.enable"));
    assert.ok(auditActions.includes("channel.message.webhook"));
  });

  test("accepts legacy form payloads and invalidates old URLs", async () => {
    const enabled = await workspaceCall("POST", `/channels/${channel.id}/webhook`, {
      enabled: true,
    });
    const webhookPath = new URL(String(enabled.body.url)).pathname;
    const form = new URLSearchParams({
      payload: JSON.stringify({
        username: "Alerts",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "CPU recovered" } }],
      }),
    });
    const delivered = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    assert.equal(delivered.status, 200);

    const rotated = await workspaceCall("POST", `/channels/${channel.id}/webhook`, {
      enabled: true,
      regenerate: true,
    });
    assert.notEqual(rotated.body.url, enabled.body.url);
    const stale = await fetch(`${baseUrl}${webhookPath}`, {
      method: "POST",
      headers: { connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ text: "stale" }),
    });
    assert.equal(stale.status, 404);

    const disabled = await workspaceCall("POST", `/channels/${channel.id}/webhook`, {
      enabled: false,
    });
    assert.deepEqual(disabled.body, { enabled: false, url: null });
    const currentPath = new URL(String(rotated.body.url)).pathname;
    const afterDisable = await fetch(`${baseUrl}${currentPath}`, {
      method: "POST",
      headers: { connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ text: "disabled" }),
    });
    assert.equal(afterDisable.status, 404);
  });

  test("does not expose webhook settings on direct messages", async () => {
    const dm = await insert(Channel, {
      companyId: company.id,
      kind: "dm",
      name: null,
      slug: null,
      topic: "",
      webhookToken: null,
      createdByUserId: actingUserId,
      archivedAt: null,
      lastMessageAt: null,
    });
    await insert(ChannelMember, {
      channelId: dm.id,
      memberKind: "user",
      userId: actingUserId,
      employeeId: null,
      lastReadAt: new Date(),
    });
    const response = await workspaceCall("GET", `/channels/${dm.id}/webhook`);
    assert.equal(response.status, 404);
  });
});
