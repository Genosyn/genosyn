import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { googleProvider } from "../integrations/providers/google.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
  invokeConnectionTool,
  refreshConnectionStatus,
} from "./integrations.js";
import { HANDLERS } from "./pipelines/handlers.js";

const companyId = "outbound-config-company";
const scope =
  "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email openid";
const messageBody = "Current request\nOn Monday, Pat wrote:\nRead this quoted context too.";
const toolArgs = {
  messageId: "synthetic-message",
  format: "text",
  includeQuoted: true,
  maxBodyChars: 16_000,
};
const originalFetch = globalThis.fetch;
let employee: AIEmployee;
let connection: IntegrationConnection;
let mailbox: MailAccount;
let dnsCalls: string[];
let fetchCalls: string[];

before(initTestDb);
after(closeTestDb);
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  await resetTestDb();
  dnsCalls = [];
  fetchCalls = [];
  mock.method(dns, "lookup", async (hostname: string) => {
    dnsCalls.push(hostname);
    throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetchCalls.push(url);
    assert.equal(
      url,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/synthetic-message?format=full",
    );
    return new Response(
      JSON.stringify({
        id: "synthetic-message",
        threadId: "synthetic-thread",
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from(messageBody).toString("base64url") },
        },
      }),
    );
  };
  employee = await insert(AIEmployee, {
    companyId,
    name: "Reader",
    slug: "reader",
    role: "Sales",
    soulBody: "",
  });
  const built = googleProvider.buildOauthConfig!({
    tokens: {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3_600_000,
      scope,
    },
    userInfo: { email: "synthetic@example.com" },
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    scopeGroups: ["mail"],
  });
  connection = await insert(IntegrationConnection, {
    companyId,
    provider: "google",
    label: "Synthetic Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(built.config, companyId),
    accountHint: built.accountHint,
    status: "connected",
    statusMessage: "",
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  mailbox = await insert(MailAccount, {
    companyId,
    connectionId: connection.id,
    address: "synthetic@example.com",
    createdByUserId: "synthetic-member",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: mailbox.id,
    accessLevel: "read",
  });
});

async function invoke(): Promise<unknown> {
  return invokeConnectionTool({
    employee,
    connectionId: connection.id,
    toolName: "gmail_get_message",
    toolArgs,
  });
}

async function changeConfig(patch: Record<string, unknown>): Promise<void> {
  connection.encryptedConfig = encryptConnectionConfig(
    { ...decryptConnectionConfig(connection), ...patch },
    companyId,
  );
  await AppDataSource.getRepository(IntegrationConnection).save(connection);
}

async function invokePipeline(): Promise<unknown> {
  const handler = HANDLERS["integration.invoke"];
  assert.ok(handler);
  const config = { connectionId: connection.id, toolName: "gmail_get_message", args: toolArgs };
  return handler({
    companyId,
    pipelineId: "synthetic-pipeline",
    pipelineName: "Read",
    runId: "synthetic-run",
    env: { trigger: { kind: "manual", payload: {} }, nodeOutputs: {} },
    log: () => {},
    config,
    node: { id: "read", type: "integration.invoke", x: 0, y: 0, config },
  });
}

test("quoted Gmail read reaches Gmail when DNS for OAuth scope identifiers is unavailable", async () => {
  const before = connection.encryptedConfig;
  const result = (await invoke()) as { bodyText: string; bodyCoverage: { complete: boolean } };
  assert.equal(result.bodyText, messageBody);
  assert.equal(result.bodyCoverage.complete, true);
  assert.deepEqual(dnsCalls, []);
  assert.equal(fetchCalls.length, 1);
  const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
    id: connection.id,
  });
  assert.equal(stored.encryptedConfig, before);
  assert.equal(decryptConnectionConfig(stored).scope, scope);
});

test("Connection status does not resolve URI-shaped OAuth scope metadata", async () => {
  const result = await refreshConnectionStatus(connection);
  assert.equal(result.status, "connected");
  assert.equal(result.statusMessage, "");
  assert.deepEqual(dnsCalls, []);
  assert.deepEqual(fetchCalls, []);
});

test("OAuth refresh still reaches its fixed token endpoint and preserves scopes", async () => {
  await changeConfig({ expiresAt: 0 });
  globalThis.fetch = async (input, init) => {
    fetchCalls.push(String(input));
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    assert.equal(init?.method, "POST");
    return new Response(
      JSON.stringify({ access_token: "renewed-synthetic-access", expires_in: 3600 }),
    );
  };
  const result = await refreshConnectionStatus(connection);
  assert.equal(result.status, "connected");
  assert.deepEqual(dnsCalls, []);
  assert.equal(fetchCalls.length, 1);
  assert.equal(decryptConnectionConfig(result).scope, scope);
  assert.equal(decryptConnectionConfig(result).accessToken, "renewed-synthetic-access");
});

test("Pipeline integration reads share the scope-aware preflight", async () => {
  const result = (await invokePipeline()) as { outputs: { result: { bodyText: string } } };
  assert.equal(result.outputs.result.bodyText, messageBody);
  assert.deepEqual(dnsCalls, []);
  assert.equal(fetchCalls.length, 1);
});

test("removing the Connection Grant still rejects before DNS or Gmail", async () => {
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
    employeeId: employee.id,
    connectionId: connection.id,
  });
  await assert.rejects(invoke(), /No grant/);
  assert.deepEqual(dnsCalls, []);
  assert.deepEqual(fetchCalls, []);
});

test("a different company still cannot use the Connection", async () => {
  employee.companyId = "other-company";
  await assert.rejects(invoke(), /different company/);
  assert.deepEqual(dnsCalls, []);
  assert.deepEqual(fetchCalls, []);
});

test("removing the mailbox Read Grant still rejects before Gmail", async () => {
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({
    employeeId: employee.id,
    accountId: mailbox.id,
  });
  await assert.rejects(invoke(), /No grant/);
  assert.deepEqual(dnsCalls, []);
  assert.deepEqual(fetchCalls, []);
});

test("scope metadata still governs Gmail authorization after network validation", async () => {
  await changeConfig({ scope: "https://www.googleapis.com/auth/drive" });
  await assert.rejects(invoke(), /Gmail|gmail/i);
  assert.deepEqual(dnsCalls, []);
  assert.deepEqual(fetchCalls, []);
});

for (const surface of ["employee", "status", "pipeline"]) {
  test(`${surface} still rejects an actual private endpoint alongside OAuth scopes`, async () => {
    await changeConfig({ customEndpoint: "http://127.0.0.1/private" });
    if (surface === "status") {
      const result = await refreshConnectionStatus(connection);
      assert.equal(result.status, "error");
      assert.match(result.statusMessage, /non-public/);
    } else {
      await assert.rejects(surface === "employee" ? invoke() : invokePipeline(), /non-public/);
    }
    assert.deepEqual(dnsCalls, []);
    assert.deepEqual(fetchCalls, []);
  });
}

test("a real custom endpoint still resolves and fails closed on transient DNS", async () => {
  await changeConfig({ customEndpoint: "https://endpoint.example.test/auth/scope" });
  await assert.rejects(invoke(), /getaddrinfo EAI_AGAIN endpoint\.example\.test/);
  assert.deepEqual(dnsCalls, ["endpoint.example.test"]);
  assert.deepEqual(fetchCalls, []);
});

test("a mixed public and private DNS answer still blocks the provider", async () => {
  await changeConfig({ baseUrl: "https://endpoint.example.test" });
  mock.method(dns, "lookup", async (hostname: string) => {
    dnsCalls.push(hostname);
    return [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
  });
  await assert.rejects(invoke(), /non-public/);
  assert.deepEqual(dnsCalls, ["endpoint.example.test"]);
  assert.deepEqual(fetchCalls, []);
});
