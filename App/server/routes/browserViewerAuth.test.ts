import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { WebSocket } from "ws";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { errorHandler } from "../middleware/error.js";
import { hashApiToken } from "../middleware/auth.js";
import { attachRealtime, mintBrowserViewerWsToken, mintWsToken } from "../services/realtime.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { browserSessionsRouter } from "./browserSessions.js";
import { browserRpcRouter } from "./browserRpc.js";

let server: Server;
let baseUrl = "";
let wsBaseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;
let browserSession: BrowserSession;

before(async () => {
  await initTestDb();
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid/employees/:eid/browser-sessions", browserSessionsRouter);
  app.use("/api/internal/mcp/browser-sessions/:id", browserRpcRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  attachRealtime(server);
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  [owner, member] = await Promise.all([
    insert(User, {
      email: `viewer-owner-${randomUUID()}@example.com`,
      name: "Viewer Owner",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: `viewer-member-${randomUUID()}@example.com`,
      name: "Viewer Member",
      passwordHash: "x",
      sessionVersion: 0,
    }),
  ]);
  company = await insert(Company, {
    name: "Browser Viewer Company",
    slug: `browser-viewer-${randomUUID()}`,
    ownerId: owner.id,
  });
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" }),
    insert(Membership, { companyId: company.id, userId: member.id, role: "member" }),
  ]);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Browser Employee",
    slug: `browser-employee-${randomUUID()}`,
    role: "Operations",
    browserEnabled: true,
  });
  browserSession = await insert(BrowserSession, {
    companyId: company.id,
    employeeId: employee.id,
    conversationId: null,
    runId: null,
    mcpToken: crypto.randomBytes(32).toString("hex"),
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "pending",
    closeReason: null,
    pageUrl: "https://example.com",
    pageTitle: "Example",
    viewportWidth: 1280,
    viewportHeight: 800,
    startedAt: null,
    closedAt: null,
  });
  actingUserId = owner.id;
});

function viewerPath(token: string): string {
  return `${wsBaseUrl}/api/companies/${company.id}/employees/${employee.id}/browser-sessions/${browserSession.id}/ws?token=${encodeURIComponent(token)}`;
}

async function websocketStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    ws.once("open", () => {
      finish(101);
      ws.close();
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode ?? 0);
    });
    ws.once("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("Browser viewer authorization", () => {
  test("requires a logged-in admin and rejects general API keys", async () => {
    const listPath = `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/browser-sessions`;

    actingUserId = member.id;
    assert.equal((await fetch(listPath)).status, 403);

    const tokenBody = crypto.randomBytes(32).toString("base64url");
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Browser viewer key",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
    });
    actingUserId = null;
    assert.equal(
      (
        await fetch(listPath, {
          headers: { authorization: `Bearer gen_${tokenBody}` },
        })
      ).status,
      403,
    );

    actingUserId = owner.id;
    assert.equal((await fetch(listPath)).status, 200);
  });

  test("accepts only an exact admin viewer token at the WebSocket upgrade", async () => {
    const genericWorkspaceToken = await mintWsToken(owner.id, company.id);
    assert.equal(await websocketStatus(viewerPath(genericWorkspaceToken)), 403);

    const forgedMemberViewerToken = await mintBrowserViewerWsToken(
      member.id,
      company.id,
      employee.id,
      browserSession.id,
    );
    assert.equal(await websocketStatus(viewerPath(forgedMemberViewerToken)), 403);

    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/browser-sessions/${browserSession.id}/ws-token`,
      { method: "POST" },
    );
    assert.equal(response.status, 200);
    const { token } = (await response.json()) as { token: string };
    assert.equal(await websocketStatus(viewerPath(token)), 101);
  });

  test("disconnects a live viewer as soon as its company role changes", async () => {
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/browser-sessions/${browserSession.id}/ws-token`,
      { method: "POST" },
    );
    const { token } = (await response.json()) as { token: string };
    const ws = await openWebSocket(viewerPath(token));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });

    const membership = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId: company.id,
      userId: owner.id,
    });
    membership.role = "member";
    await AppDataSource.getRepository(Membership).save(membership);

    const result = await closed;
    assert.equal(result.code, 1008);
    assert.match(result.reason, /access changed/i);
  });

  test("rejects an active session immediately after Browser access is disabled", async () => {
    employee.browserEnabled = false;
    await AppDataSource.getRepository(AIEmployee).save(employee);
    const response = await fetch(
      `${baseUrl}/api/internal/mcp/browser-sessions/${browserSession.id}/snapshot`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${browserSession.mcpToken}` },
      },
    );
    assert.equal(response.status, 403);
    assert.match(JSON.stringify(await response.json()), /Browser access is disabled/);
    assert.equal(
      (
        await AppDataSource.getRepository(BrowserSession).findOneByOrFail({
          id: browserSession.id,
        })
      ).status,
      "closed",
    );
  });

  test("rejects standalone Vault TOTP fills at the authoritative RPC boundary", async () => {
    employee.browserApprovalRequired = true;
    await AppDataSource.getRepository(AIEmployee).save(employee);
    const response = await fetch(
      `${baseUrl}/api/internal/mcp/browser-sessions/${browserSession.id}/vault/fill`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${browserSession.mcpToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          selector: "aria-ref=e8",
          itemId: randomUUID(),
          field: "totp",
        }),
      },
    );
    assert.equal(response.status, 409);
    assert.match(JSON.stringify(await response.json()), /browser_submit_with_vault_totp/);
  });
});
