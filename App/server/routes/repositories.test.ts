import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { encryptRepoSecret } from "../services/repositories.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { repositoriesRouter } from "./repositories.js";
import { repositoryContentRouter } from "./repositoryContent.js";

let server: Server;
let baseUrl: string;
let actingUserId: string;
let company: Company;
let member: User;
let repository: Repository;
let connection: IntegrationConnection;
const originalMultiTenant = config.security.multiTenant;
const originalDataDir = config.dataDir;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repository-settings-"));
  (config as { dataDir: string }).dataDir = dataDir;
  await initTestDb();
  (config.security as { multiTenant: boolean }).multiTenant = false;
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.session = {
      userId: actingUserId,
      sessionVersion: 1,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", repositoriesRouter);
  // Mounted after it, as in server/index.ts, so the record router's guards run
  // ahead of every editing and work-session request, exactly as in production.
  app.use("/api/companies/:cid", repositoryContentRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  (config.security as { multiTenant: boolean }).multiTenant = originalMultiTenant;
  (config as { dataDir: string }).dataDir = originalDataDir;
  await closeTestDb();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 1,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 1,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Product",
    slug: "product",
    origin: "remote",
    kind: "code",
    gitUrl: "git@github.com:acme/product.git",
    defaultBranch: "main",
    authMode: "ssh",
    encryptedSshKey: encryptRepoSecret("private-ssh-key", company.id),
  });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "github",
    label: "GitHub",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig(
      { apiKey: "github-token", login: "acme", repos: [] },
      company.id,
    ),
  });
  actingUserId = owner.id;
});

async function patch(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/repositories/${repository.slug}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("an admin can select and clear the PR Connection while preserving SSH transport and key", async () => {
  const selected = await patch({ authMode: "ssh", githubConnectionId: connection.id });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.githubConnectionId, connection.id);
  assert.equal(selected.body.authMode, "ssh");
  assert.equal(selected.body.hasSshKey, true);
  assert.equal(selected.body.encryptedSshKey, undefined);
  const saved = await AppDataSource.getRepository(Repository).findOneByOrFail({
    id: repository.id,
  });
  assert.equal(saved.encryptedSshKey, repository.encryptedSshKey);
  assert.equal(saved.gitUrl, repository.gitUrl);
  const cleared = await patch({ githubConnectionId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.githubConnectionId, null);
  assert.equal(cleared.body.hasSshKey, true);
});

test("ordinary Members cannot choose the credential used for delivery", async () => {
  actingUserId = member.id;
  assert.equal((await patch({ githubConnectionId: connection.id })).status, 403);
  const saved = await AppDataSource.getRepository(Repository).findOneByOrFail({
    id: repository.id,
  });
  assert.equal(saved.githubConnectionId, null);
});

test("a foreign or mismatched Connection is rejected without changing the stored pin", async () => {
  await AppDataSource.getRepository(IntegrationConnection).update(
    { id: connection.id },
    { companyId: "other-company" },
  );
  assert.equal((await patch({ githubConnectionId: connection.id })).status, 400);
  await AppDataSource.getRepository(IntegrationConnection).update(
    { id: connection.id },
    { companyId: company.id },
  );
  const changedRemote = await patch({
    gitUrl: "git@other.example:acme/product.git",
    githubConnectionId: connection.id,
  });
  assert.equal(changedRemote.status, 400);
  const saved = await AppDataSource.getRepository(Repository).findOneByOrFail({
    id: repository.id,
  });
  assert.equal(saved.githubConnectionId, null);
  assert.equal(saved.gitUrl, repository.gitUrl);
});

async function grantEmployee(accessLevel: "read" | "write", slug = "developer") {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: slug,
    slug,
    role: "Developer",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel,
  });
  return employee;
}

async function deliveryReadiness(): Promise<Map<string, boolean>> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/repositories/${repository.slug}/grants`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    direct: Array<{ employeeId: string; employee: { pullRequestReady: boolean } }>;
  };
  assert.ok(!JSON.stringify(body).includes("repository-personal-token"));
  return new Map(body.direct.map((grant) => [grant.employeeId, grant.employee.pullRequestReady]));
}

async function usePersonalToken(gitUrl = "https://github.com/acme/product.git") {
  await AppDataSource.getRepository(Repository).update(repository.id, {
    authMode: "https",
    gitUrl,
    encryptedToken: encryptRepoSecret("repository-personal-token", company.id),
    encryptedSshKey: null,
    githubConnectionId: null,
  });
}

test("PAT Settings can clear an obsolete Connection without replacing the saved token", async () => {
  await usePersonalToken();
  await AppDataSource.getRepository(Repository).update(repository.id, {
    githubConnectionId: connection.id,
  });
  await AppDataSource.getRepository(IntegrationConnection).delete(connection.id);
  const before = await AppDataSource.getRepository(Repository).findOneByOrFail({ id: repository.id });
  const result = await patch({
    name: "Renamed product",
    authMode: "https",
    gitUrl: before.gitUrl,
    githubConnectionId: null,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.hasToken, true);
  assert.equal(result.body.encryptedToken, undefined);
  const saved = await AppDataSource.getRepository(Repository).findOneByOrFail({ id: repository.id });
  assert.equal(saved.githubConnectionId, null);
  assert.equal(saved.encryptedToken, before.encryptedToken);
  assert.equal(saved.gitUrl, before.gitUrl);
});

test("delivery readiness recognizes a GitHub Repository token without a Connection", async () => {
  await usePersonalToken();
  await AppDataSource.getRepository(IntegrationConnection).delete(connection.id);
  const writer = await grantEmployee("write");
  const reader = await grantEmployee("read", "reviewer");
  const ready = await deliveryReadiness();
  assert.equal(ready.get(writer.id), true);
  assert.equal(ready.get(reader.id), false);
});

test("delivery readiness does not substitute a Connection for a missing Repository token", async () => {
  await usePersonalToken();
  const employee = await grantEmployee("write");
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  await AppDataSource.getRepository(Repository).update(repository.id, {
    encryptedToken: null,
    githubConnectionId: connection.id,
  });
  assert.equal((await deliveryReadiness()).get(employee.id), false);
  await usePersonalToken("https://unknown.example/acme/product.git");
  assert.equal((await deliveryReadiness()).get(employee.id), false);
});

test("delivery readiness uses configured Forgejo metadata with the Repository token", async () => {
  await usePersonalToken("https://forge.example/acme/product.git");
  await AppDataSource.getRepository(IntegrationConnection).update(connection.id, {
    provider: "forgejo",
    encryptedConfig: encryptConnectionConfig(
      { baseUrl: "https://forge.example", apiKey: "unused-connection-token", login: "acme" },
      company.id,
    ),
  });
  const employee = await grantEmployee("write");
  assert.equal((await deliveryReadiness()).get(employee.id), true);
  await AppDataSource.getRepository(IntegrationConnection).delete(connection.id);
  assert.equal((await deliveryReadiness()).get(employee.id), false);
});

test("delivery readiness requires the exact selected Connection for SSH", async () => {
  const employee = await grantEmployee("write");
  await AppDataSource.getRepository(Repository).update(repository.id, {
    githubConnectionId: connection.id,
  });
  const other = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "github",
    label: "Other GitHub",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ apiKey: "other-token" }, company.id),
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: other.id });
  assert.equal((await deliveryReadiness()).get(employee.id), false);
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  assert.equal((await deliveryReadiness()).get(employee.id), true);
  await AppDataSource.getRepository(Repository).update(repository.id, { githubConnectionId: null });
  assert.equal((await deliveryReadiness()).get(employee.id), false);
  await AppDataSource.getRepository(Repository).update(repository.id, {
    githubConnectionId: connection.id,
    encryptedSshKey: null,
  });
  assert.equal((await deliveryReadiness()).get(employee.id), false);
});

test("delivery readiness preserves a granted Connection used for Git and PRs", async () => {
  const employee = await grantEmployee("write");
  await AppDataSource.getRepository(Repository).update(repository.id, {
    authMode: "none",
    gitUrl: "https://github.com/acme/product.git",
    githubConnectionId: connection.id,
    encryptedSshKey: null,
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  assert.equal((await deliveryReadiness()).get(employee.id), true);
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete({ employeeId: employee.id });
  assert.equal((await deliveryReadiness()).get(employee.id), false);
});

// ─────────────── both routers, mounted as in server/index.ts ───────────────
//
// The record router comes first and its guards run for every request under
// `/repositories`, including the editing and AI work-session routes the content
// router serves behind it. Its admin gate once matched that whole subtree, so
// in production every Member's save, commit, and work session was refused,
// while repositoryContent.test.ts, which mounts the content router alone, passed.

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** A repository created inside Genosyn, so working in it needs no git host. */
async function localRepository(): Promise<Repository> {
  return insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
  });
}

test("an ordinary Member can save a file and commit it", async () => {
  const strategy = await localRepository();
  actingUserId = member.id;
  const workspace = `/repositories/${strategy.slug}/workspace`;
  const saved = await call("PUT", `${workspace}/file`, { path: "plan.md", content: "# Plan\n" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const committed = await call("POST", `${workspace}/commit`, { message: "Add the plan" });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.committed, true);
});

test("an ordinary Member's other edits and AI work sessions reach their routes", async () => {
  const strategy = await localRepository();
  actingUserId = member.id;
  const workspace = `/repositories/${strategy.slug}/workspace`;
  const session = `/repositories/${strategy.slug}/sessions/${randomUUID()}`;
  const writes: Array<[string, string]> = [
    ["POST", `${workspace}/refresh`],
    ["POST", `${workspace}/directory`],
    ["POST", `${workspace}/delete`],
    ["POST", `${workspace}/move`],
    ["POST", `${workspace}/discard`],
    ["POST", `${workspace}/branches`],
    ["POST", `${workspace}/checkout`],
    ["POST", `/repositories/${strategy.slug}/sessions`],
    ["POST", `/repositories/${strategy.slug}/session-attachments`],
    ["POST", `${session}/revise`],
    ["POST", `${session}/stop`],
    ["PATCH", session],
    ["POST", `${session}/publish`],
    ["POST", `${session}/archive`],
    ["POST", `${session}/discard`],
  ];
  // An empty body is refused by each route's own validation, or the session
  // is not found. Either answer means the request got past every guard.
  for (const [method, path] of writes) {
    const response = await call(method, path, {});
    assert.notEqual(response.status, 403, `${method} ${path}: ${JSON.stringify(response.body)}`);
  }
});

/**
 * Every write the record router serves, with its parameters filled in.
 *
 * Read from the router rather than listed by hand, so that a record route
 * added later is checked here even if nobody remembers to add it to the admin
 * gate's paths.
 */
function recordWrites(): Array<{ route: string; method: string; path: string }> {
  return repositoriesRouter.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const { path: pattern, stack } = layer.route;
    const path = pattern.replace(/:(\w+)/g, (_param, name: string) =>
      name === "slug" ? repository.slug : randomUUID(),
    );
    const methods = new Set(stack.map((handler) => handler.method.toUpperCase()));
    methods.delete("GET");
    return [...methods].map((method) => ({ route: `${method} ${pattern}`, method, path }));
  });
}

test("repository record changes stay owner/admin however the path is written", async () => {
  actingUserId = member.id;
  const writes = recordWrites();
  for (const route of [
    "POST /repositories",
    "PATCH /repositories/:slug",
    "POST /repositories/:slug/grants",
  ]) {
    assert.ok(writes.some((write) => write.route === route), `${route} is not on the router`);
  }
  for (const { method, path } of writes) {
    // Express routes case-insensitively and ignores a trailing slash, so each
    // spelling reaches the same handler and must meet the same gate.
    for (const spelling of [path, path.toUpperCase(), `${path}/`]) {
      const response = await call(method, spelling, {});
      assert.equal(response.status, 403, `${method} ${spelling}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error, "admin company role required", `${method} ${spelling}`);
    }
  }
});
