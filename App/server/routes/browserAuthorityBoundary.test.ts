import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { apiKeysRouter } from "./apiKeys.js";
import { basesRouter } from "./bases.js";
import { browserSessionsRouter } from "./browserSessions.js";
import { repositoriesRouter } from "./repositories.js";
import { emailProvidersRouter } from "./emailProviders.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";
import { integrationsRouter } from "./integrations.js";
import { mailRouter } from "./mail.js";
import { mcpRouter } from "./mcp.js";
import { modelsRouter } from "./models.js";
import { projectsRouter } from "./projects.js";
import { secretsRouter } from "./secrets.js";
import { workspaceRouter } from "./workspace.js";

let server: Server;
let baseUrl: string;
let user: User;
let company: Company;
let employee: AIEmployee;
let bearer = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: 0, authenticatedAt: Date.now() }
      : {};
    next();
  });

  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  app.use("/api/companies/:cid/employees/:eid/mcp", mcpRouter);
  app.use("/api/companies/:cid/employees/:eid/browser-sessions", browserSessionsRouter);
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
  app.use("/api/companies/:cid/workspace", workspaceRouter);
  app.use("/api/companies/:cid/integrations", integrationsRouter);
  app.use("/api/companies/:cid/email/providers", emailProvidersRouter);
  app.use("/api/companies/:cid", basesRouter);
  app.use("/api/companies/:cid", projectsRouter);
  app.use("/api/companies/:cid", mailRouter);
  app.use("/api/companies/:cid", repositoriesRouter);
  app.use("/api/companies/:cid", secretsRouter);
  app.use("/api/companies/:cid", apiKeysRouter);
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
  user = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: user.id,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Analyst",
    slug: "analyst",
    role: "Analyst",
    soulBody: "",
  });
  const tokenBody = "B".repeat(43);
  await insert(ApiKey, {
    userId: user.id,
    companyId: company.id,
    name: "automation",
    prefix: tokenBody.slice(0, 8),
    tokenHash: hashApiToken(tokenBody),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  });
  bearer = `gen_${tokenBody}`;
});

async function call(
  method: string,
  path: string,
  options: { browser?: boolean; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.browser) headers["x-test-user"] = user.id;
  else headers.authorization = `Bearer ${bearer}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body:
      text && contentType.includes("application/json")
        ? (JSON.parse(text) as Record<string, unknown>)
        : { raw: text },
  };
}

describe("browser-only company control plane", () => {
  test("API keys cannot read or mutate credentials, execution backends, or their grants", async () => {
    const paths = [
      "/api-keys",
      "/secrets",
      "/repositories",
      "/integrations/connections",
      "/email/providers",
      `/employees/${employee.id}/models`,
      `/employees/${employee.id}/mcp`,
      `/employees/${employee.id}/browser-sessions`,
    ];
    for (const path of paths) {
      const response = await call("GET", path);
      assert.equal(response.status, 403, `GET ${path}`);
    }

    assert.equal((await call("GET", "/api-keys", { browser: true })).status, 200);
    assert.equal((await call("GET", "/secrets", { browser: true })).status, 200);
  });
});

describe("browser-only interactive Member authority", () => {
  test("API keys cannot launch any route that delegates a Member's authority to an AI Employee", async () => {
    const id = randomUUID();
    const requests = [
      {
        path: `/employees/${employee.id}/conversations/${id}/messages`,
        body: { message: "do this", attachmentIds: [], modelId: null },
      },
      { path: "/bases/missing/ai", body: { prompt: "change the base" } },
      { path: `/workspace/channels/${id}/messages`, body: { content: "@analyst help" } },
      {
        path: `/todos/${id}/comments`,
        body: { body: "please help", mentionEmployeeId: employee.id },
      },
      {
        path: "/projects/missing/todos",
        body: { title: "Run this", assigneeEmployeeId: employee.id },
      },
      {
        path: `/mail/accounts/${id}/assistant/messages`,
        body: { message: "summarize", threadId: id, employeeId: employee.id },
      },
      {
        path: `/mail/threads/${id}/handovers`,
        body: { employeeId: employee.id, instruction: "Handle this", mode: "draft" },
      },
      { path: `/mail/handovers/${id}/retry`, body: {} },
    ];
    for (const request of requests) {
      const response = await call("POST", request.path, { body: request.body });
      assert.equal(response.status, 403, `POST ${request.path}`);
    }
    const assignmentPatch = await call("PATCH", `/todos/${id}`, {
      body: { assigneeEmployeeId: employee.id },
    });
    assert.equal(assignmentPatch.status, 403, `PATCH /todos/${id}`);
  });

  test("API-key todo comments without an AI mention remain ordinary business-data automation", async () => {
    const response = await call("POST", `/todos/${randomUUID()}/comments`, {
      body: { body: "status note", mentionEmployeeId: null },
    });
    assert.equal(response.status, 404);
  });

  test("API-key todo writes without a new AI assignment remain business-data automation", async () => {
    const create = await call("POST", "/projects/missing/todos", {
      body: { title: "Create only", assigneeEmployeeId: null },
    });
    assert.equal(create.status, 404);

    const patch = await call("PATCH", `/todos/${randomUUID()}`, {
      body: { priority: "high" },
    });
    assert.equal(patch.status, 404);
  });
});
