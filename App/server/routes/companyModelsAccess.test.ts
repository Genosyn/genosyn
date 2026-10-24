import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import type { Company } from "../db/entities/Company.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel } from "../test/modelFixtures.js";

/**
 * Who can choose an AI Employee's brain, end to end through `createApp()`:
 * owners and admins from a signed-in browser, and nobody else — not an API
 * key, so not the CLI or the Genosyn MCP server, and no AI Employee tool. The
 * API reference documents every company model route, cookie-only.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let employee: AIEmployee;
let model: AIModel;

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
  });
  model = await insert(AIModel, {
    companyId: company.id,
    provider: "openai",
    model: "gpt-5.5",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: "v2.cipher", apiKeyPreview: "sk-…0001" }),
    connectedAt: new Date(),
  });
});

async function request(
  method: string,
  path: string,
  auth: { token?: string; cookie?: string },
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: {
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.cookie ? { cookie: auth.cookie, origin: baseUrl } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

test("an API key — the CLI's or an MCP client's — can neither read nor change AI Models", async () => {
  const { token } = await mintTestApiKey(owner.id, company.id);
  const attempts: Array<[string, string, unknown?]> = [
    ["GET", "/models"],
    ["GET", `/models/${model.id}`],
    ["POST", `/models/${model.id}/attach`, { employeeIds: [employee.id] }],
    ["POST", `/models/${model.id}/detach`, { employeeIds: [employee.id] }],
    ["DELETE", `/models/${model.id}?detach=true`],
    ["GET", `/employees/${employee.id}/models`],
    ["POST", `/employees/${employee.id}/models/attach`, { modelId: model.id }],
    ["DELETE", `/employees/${employee.id}/models/${model.id}`],
  ];
  for (const [method, path, body] of attempts) {
    const result = await request(method, path, { token }, body);
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.match(String(result.body.error), /browser session/, `${method} ${path}`);
  }
  assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 0);
  assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: model.id }));
});

test("an owner's browser session lists, attaches and detaches", async () => {
  const cookie = await sessionCookieFor(owner);
  const listed = await request("GET", "/models", { cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    (listed.body as Array<{ id: string }>).map((entry) => entry.id),
    [model.id],
  );
  const attached = await request(
    "POST",
    `/models/${model.id}/attach`,
    { cookie },
    { employeeIds: [employee.id] },
  );
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.equal(await AppDataSource.getRepository(EmployeeModel).countBy({ employeeId: employee.id }), 1);
  const detached = await request("DELETE", `/employees/${employee.id}/models/${model.id}`, {
    cookie,
  });
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: model.id }));
});

test("a Member's session reads an employee's models but not the company's", async () => {
  await attachExistingModel({ employeeId: employee.id, modelId: model.id, isActive: true });
  const user = await insert(User, {
    email: `member-${randomUUID()}@example.test`,
    name: "Member",
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
  const cookie = await sessionCookieFor(user);
  assert.equal((await request("GET", "/models", { cookie })).status, 403);
  const own = await request("GET", `/employees/${employee.id}/models`, { cookie });
  assert.equal(own.status, 200);
  assert.deepEqual(
    (own.body as Array<{ id: string }>).map((entry) => entry.id),
    [model.id],
  );
});

test("the API reference documents the company model routes as cookie-only", () => {
  const document = buildOpenApiDocument(app) as unknown as {
    paths: Record<string, Record<string, { security?: unknown; tags?: string[] }>>;
  };
  const expected: Array<[string, string]> = [
    ["get", "/api/companies/{cid}/models"],
    ["post", "/api/companies/{cid}/models/connect"],
    ["post", "/api/companies/{cid}/models/{id}/attach"],
    ["post", "/api/companies/{cid}/models/{id}/detach"],
    ["post", "/api/companies/{cid}/models/{id}/merge"],
    ["delete", "/api/companies/{cid}/models/{id}"],
    ["post", "/api/companies/{cid}/models/{id}/test"],
    ["post", "/api/companies/{cid}/employees/{eid}/models/attach"],
    ["delete", "/api/companies/{cid}/employees/{eid}/models/{id}"],
  ];
  for (const [method, path] of expected) {
    const operation = document.paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path} is documented`);
    assert.deepEqual(operation.security, [{ cookieAuth: [] }], `${method} ${path}`);
    assert.deepEqual(operation.tags, ["AI Models"], `${method} ${path}`);
  }
  // Copying a model between employees is gone; attaching took its place.
  assert.equal(document.paths["/api/companies/{cid}/employees/{eid}/models/reuse"], undefined);
  assert.equal(document.paths["/api/companies/{cid}/employees/{eid}/models/reusable"], undefined);
});

test("no AI Employee tool attaches, detaches, switches or removes an AI Model", () => {
  const offending = STATIC_TOOLS.filter((tool) =>
    /(attach|detach|activate|assign|switch|remove|delete|set|merge|connect).*model|model.*(attach|detach|activate|assign|switch|remove|delete|set|merge|connect)/i.test(
      tool.name,
    ),
  ).map((tool) => tool.name);
  assert.deepEqual(offending, []);
});
