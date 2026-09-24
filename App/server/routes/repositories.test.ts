import assert from "node:assert/strict";
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
