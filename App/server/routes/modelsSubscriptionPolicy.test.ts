import { agentRuntime } from "../services/agent/runtime.js";
import { fakeCodexVerification } from "../test/modelVerification.js";
import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { CodexAppServer } from "../services/agent/codexAppServer.js";
import {
  CODEX_CONFIG_OVERRIDES,
  configWithSubscriptionAccessToken,
} from "../services/codexSubscription.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { modelsRouter } from "./models.js";

type ExecutionMode = "host" | "disabled";
type CodexStartOptions = Parameters<typeof CodexAppServer.start>[0];

type MutableConfig = {
  sessionSecret: string;
  security: {
    multiTenant: boolean;
    encryptionSecret: string;
  };
  agent: {
    codingTools: {
      enabled: boolean;
      executionMode: ExecutionMode;
    };
  };
};

type PublicModel = {
  id: string;
  provider: string;
  authMode: string;
  status: string;
  subscriptionAvailable: boolean;
  subscriptionUnavailableReason: string | null;
  subscriptionCredentialKind: string | null;
  subscriptionShellAvailable: boolean;
};

type ApiResponse<T = Record<string, unknown>> = {
  status: number;
  body: T;
};

const mutableConfig = config as unknown as MutableConfig;
const security = mutableConfig.security;
const codingTools = mutableConfig.agent.codingTools;
const originalSecurity = structuredClone(security);
const originalCodingTools = structuredClone(codingTools);
const originalSessionSecret = config.sessionSecret;

let server: Server;
let baseUrl: string;
let user: User;
let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: req.header("x-test-user"),
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(security, originalSecurity);
  Object.assign(codingTools, originalCodingTools);
  mutableConfig.sessionSecret = originalSessionSecret;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async (t) => {
  assert.ok("mock" in t, "beforeEach runs with a test context");
  t.mock.method(
    CodexAppServer,
    "start",
    async (options: Parameters<typeof CodexAppServer.start>[0]) =>
      fakeCodexVerification(options.cwd),
  );
  await resetTestDb();
  security.multiTenant = false;
  security.encryptionSecret = "models-subscription-policy-encryption-secret-2026";
  mutableConfig.sessionSecret = "models-subscription-policy-session-secret-2026";
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";

  user = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
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
    name: "Researcher",
    slug: `researcher-${randomUUID()}`,
    role: "Researcher",
    soulBody: "",
  });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}/models${path}`,
    {
      method,
      headers: {
        "x-test-user": user.id,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function insertSubscriptionModel(): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-5.4",
    authMode: "subscription",
    configJson: "{}",
    connectedAt: null,
    isActive: true,
    contextWindow: null,
    contextWindowSource: null,
  });
}

describe("verified subscription model edits", () => {
  async function connectedModel() {
    const model = await insertSubscriptionModel();
    model.configJson = configWithSubscriptionAccessToken(model, "existing-fixture-token");
    model.connectedAt = new Date("2026-01-01");
    return AppDataSource.getRepository(AIModel).save(model);
  }

  function edit(id: string, model: string) {
    return call("PUT", `/${id}`, { provider: "openai", authMode: "subscription", model });
  }

  test("blank UI choice resolves auto to the live default and verifies before saving", async (t) => {
    const previous = await connectedModel();
    let authRoot = "";
    let starts = 0;
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      starts++;
      authRoot = options.env.CODEX_HOME ?? "";
      assert.deepEqual(options.configOverrides, CODEX_CONFIG_OVERRIDES);
      assert.equal(options.env.CODEX_ACCESS_TOKEN, "existing-fixture-token");
      assert.notEqual(options.cwd, authRoot);
      assert.equal(
        (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id })).model,
        previous.model,
      );
      return fakeCodexVerification(options.cwd, { model: "gpt-workspace-current" });
    });
    const response = await edit(previous.id, "auto");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.model, "gpt-workspace-current");
    assert.equal(response.body.status, "connected");
    assert.equal(starts, 1);
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id });
    assert.equal(saved.configJson, previous.configJson);
    assert.ok(saved.connectedAt! > previous.connectedAt!);
    assert.equal(saved.isActive, true);
    await assert.rejects(fs.access(authRoot));
  });

  test("auto resolving to the current model preserves a concurrent context edit", async (t) => {
    const previous = await connectedModel();
    await AppDataSource.getRepository(AIModel).update(
      { id: previous.id },
      { contextWindow: 32_000, contextWindowSource: "manual" },
    );
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      await AppDataSource.getRepository(AIModel).update(
        { id: previous.id },
        { contextWindow: 64_000, contextWindowSource: "manual" },
      );
      return fakeCodexVerification(options.cwd, { model: previous.model });
    });
    const response = await edit(previous.id, "auto");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.model, previous.model);
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id });
    assert.equal(saved.contextWindow, 64_000);
    assert.equal(saved.contextWindowSource, "manual");
    assert.ok(saved.connectedAt! > previous.connectedAt!);
  });

  test("explicit model edits verify the requested ID and preserve a concurrently activated sibling", async (t) => {
    const previous = await connectedModel();
    const sibling = await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      authMode: "apikey",
      model: "sibling",
      configJson: "{}",
      isActive: false,
    });
    let requested = "";
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      await AppDataSource.getRepository(AIModel).update({ id: previous.id }, { isActive: false });
      await AppDataSource.getRepository(AIModel).update({ id: sibling.id }, { isActive: true });
      const server = fakeCodexVerification(options.cwd);
      const request = server.request.bind(server);
      t.mock.method(server, "request", async (...args: Parameters<CodexAppServer["request"]>) => {
        const [method, params, timeout] = args;
        if (method === "thread/start")
          requested = String((params as Record<string, unknown>).model);
        assert.notEqual(
          method,
          "model/list",
          "An explicit selection must not be replaced by discovery",
        );
        return request(method, params, timeout);
      });
      return server;
    });
    const response = await edit(previous.id, "gpt-my-choice");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(requested, "gpt-my-choice");
    assert.equal(response.body.model, "gpt-my-choice");
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id })).isActive,
      false,
    );
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: sibling.id })).isActive,
      true,
    );
  });

  test("a failed reply keeps the previous selected model and working credential", async (t) => {
    const previous = await connectedModel();
    let authRoot = "";
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      authRoot = options.env.CODEX_HOME ?? "";
      return fakeCodexVerification(options.cwd, { status: "failed" });
    });
    const response = await edit(previous.id, "not-available");
    assert.equal(response.status, 422);
    assert.match(String(response.body.error), /could not answer/);
    assert.deepEqual(
      await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id }),
      previous,
    );
    await assert.rejects(fs.access(authRoot));
  });

  test("the absent workspace default never replaces a working model with auto", async (t) => {
    const previous = await connectedModel();
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      const server = fakeCodexVerification(options.cwd);
      t.mock.method(server, "request", async () => ({ data: [], nextCursor: null }));
      return server;
    });
    const response = await edit(previous.id, "auto");
    assert.equal(response.status, 422);
    assert.match(String(response.body.error), /did not return a default/);
    assert.deepEqual(
      await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id }),
      previous,
    );
  });

  test("credential replacement during verification returns conflict without restoring the old token", async (t) => {
    const previous = await connectedModel();
    const replacement = configWithSubscriptionAccessToken(previous, "newer-fixture-token");
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      await AppDataSource.getRepository(AIModel).update(
        { id: previous.id },
        { configJson: replacement },
      );
      return fakeCodexVerification(options.cwd);
    });
    const response = await edit(previous.id, "auto");
    assert.equal(response.status, 409);
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id });
    assert.equal(saved.model, previous.model);
    assert.equal(saved.configJson, replacement);
  });

  test("managed-session refresh is preserved when a verified model edit is saved", async (t) => {
    const previous = await connectedModel();
    const auth = {
      auth_mode: "chatgpt",
      tokens: { id_token: "fixture-id", access_token: "old-access", refresh_token: "old-refresh" },
    };
    previous.configJson = JSON.stringify({
      codexAuthEncrypted: encryptSecret(JSON.stringify(auth)),
    });
    await AppDataSource.getRepository(AIModel).save(previous);
    t.mock.method(CodexAppServer, "start", async (options: CodexStartOptions) => {
      const authFile = path.join(options.env.CODEX_HOME!, "auth.json");
      assert.equal((await fs.stat(authFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await fs.readFile(authFile, "utf8")), auth);
      await fs.writeFile(
        authFile,
        JSON.stringify({
          ...auth,
          tokens: { ...auth.tokens, refresh_token: "fresh-refresh", access_token: "fresh-access" },
        }),
      );
      return fakeCodexVerification(options.cwd);
    });
    const response = await edit(previous.id, "gpt-explicit");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: previous.id });
    assert.equal(saved.model, "gpt-explicit");
    const refreshed = JSON.parse(decryptSecret(JSON.parse(saved.configJson).codexAuthEncrypted));
    assert.equal(refreshed.tokens.refresh_token, "fresh-refresh");
    assert.equal(refreshed.tokens.access_token, "fresh-access");
  });

  test("disconnected placeholders can choose an ID before sign-in without starting a runtime", async (t) => {
    const previous = await insertSubscriptionModel();
    let starts = 0;
    t.mock.method(CodexAppServer, "start", async () => {
      starts++;
      throw new Error("Unexpected runtime");
    });
    const response = await edit(previous.id, "auto");
    assert.equal(response.status, 200);
    assert.equal(response.body.model, "auto");
    assert.equal(response.body.status, "not_connected");
    assert.equal(starts, 0);
  });
});

describe("API model setup routes", () => {
  test("discovery is scoped, validates credentials, and never saves a model", async (t) => {
    const originalFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith(baseUrl)) return originalFetch(input, init);
        assert.equal(String(input), "https://api.openai.com/v1/models");
        return Response.json({ data: [{ id: "gpt-live", created: 100 }] });
      },
    );
    const invalid = await call("POST", "/discover", { provider: "openai", apiKey: "  " });
    assert.equal(invalid.status, 400);
    const result = await call("POST", "/discover", { provider: "openai", apiKey: "test-key" });
    assert.equal(result.status, 200);
    assert.equal(result.body.recommendedModel, "gpt-live");
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: user.id },
      { role: "member" },
    );
    assert.equal(
      (await call("POST", "/discover", { provider: "openai", apiKey: "test-key" })).status,
      403,
    );
    assert.equal(
      (await call("POST", "/connect", { provider: "openai", apiKey: "test-key" })).status,
      403,
    );
  });

  test("connect tests a real tool reply and returns a connected model without exposing credentials", async (t) => {
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      assert.equal(params.nativeCoding, false);
      await params.registry.resolve("connection_test")!.run({ ok: true });
      return { finalText: "OK", steps: 2, stopReason: "end_turn" };
    });
    const connected = await call("POST", "/connect", {
      provider: "openai",
      apiKey: "private-test-key",
      model: "gpt-explicit",
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.status, "connected");
    assert.equal(connected.body.model, "gpt-explicit");
    assert.doesNotMatch(JSON.stringify(connected.body), /private-test-key/);
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: String(connected.body.id),
    });
    assert.equal(decryptSecret(JSON.parse(saved.configJson).apiKeyEncrypted), "private-test-key");
  });

  test("failed verification returns an actionable error and saves no connected row", async (t) => {
    t.mock.method(agentRuntime, "run", async () => {
      throw Object.assign(new Error("secret-credential"), { status: 401 });
    });
    const response = await call("POST", "/connect", {
      provider: "openai",
      apiKey: "secret-credential",
      model: "gpt-explicit",
    });
    assert.equal(response.status, 422);
    assert.match(String(response.body.error), /rejected this credential/);
    assert.doesNotMatch(JSON.stringify(response.body), /secret-credential/);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);
  });
});

describe("OpenAI subscription policy routes", () => {
  test("stock disabled mode creates, lists, and connects a subscription model", async () => {
    const accessToken = `codex-test-${randomUUID()}-${randomUUID()}`;
    const created = await call<PublicModel>("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });

    assert.equal(created.status, 200);
    assert.equal(created.body.provider, "openai");
    assert.equal(created.body.authMode, "subscription");
    assert.equal(created.body.status, "not_connected");
    assert.equal(created.body.subscriptionAvailable, true);
    assert.equal(created.body.subscriptionUnavailableReason, null);
    assert.equal(created.body.subscriptionCredentialKind, null);
    assert.equal(created.body.subscriptionShellAvailable, false);

    const listedBefore = await call<PublicModel[]>("GET", "/");
    assert.equal(listedBefore.status, 200);
    assert.equal(listedBefore.body.length, 1);
    assert.deepEqual(
      {
        available: listedBefore.body[0].subscriptionAvailable,
        reason: listedBefore.body[0].subscriptionUnavailableReason,
        shell: listedBefore.body[0].subscriptionShellAvailable,
      },
      { available: true, reason: null, shell: false },
    );

    const connected = await call<PublicModel>(
      "POST",
      `/${created.body.id}/subscription/access-token`,
      { accessToken },
    );
    assert.equal(connected.status, 200);
    assert.equal(connected.body.status, "connected");
    assert.equal(connected.body.subscriptionAvailable, true);
    assert.equal(connected.body.subscriptionCredentialKind, "accessToken");
    assert.equal(connected.body.subscriptionShellAvailable, false);
    assert.equal(JSON.stringify(connected.body).includes(accessToken), false);

    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: created.body.id,
    });
    const storedConfig = JSON.parse(stored.configJson) as Record<string, unknown>;
    assert.equal(stored.configJson.includes(accessToken), false);
    assert.equal(storedConfig.codexAuthEncrypted, undefined);
    assert.equal(storedConfig.subscriptionCredentialKind, "accessToken");
    assert.equal(decryptSecret(String(storedConfig.codexAccessTokenEncrypted)), accessToken);
    assert.ok(stored.connectedAt instanceof Date);

    const listedAfter = await call<PublicModel[]>("GET", "/");
    assert.equal(listedAfter.status, 200);
    assert.equal(listedAfter.body[0].status, "connected");
    assert.equal(listedAfter.body[0].subscriptionCredentialKind, "accessToken");
    assert.equal(JSON.stringify(listedAfter.body).includes(accessToken), false);
  });

  test("stock disabled mode reaches the device-code sign-in runtime and cleans its temporary homes", async () => {
    const created = await call<PublicModel>("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });
    assert.equal(created.status, 200);

    const originalStart = CodexAppServer.start;
    const starts: Parameters<typeof CodexAppServer.start>[0][] = [];
    let closeCalls = 0;
    let sessionId: string | null = null;
    const fakeServer = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "account/login/start") {
          return {
            type: "chatgptDeviceCode",
            loginId: randomUUID(),
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
          } as T;
        }
        if (method === "account/login/cancel") return {} as T;
        throw new Error(`Unexpected fake Codex request: ${method}`);
      },
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      stderrSummary: () => "",
      close: async () => {
        closeCalls += 1;
      },
    };

    try {
      CodexAppServer.start = async (options) => {
        starts.push(options);
        return fakeServer as unknown as CodexAppServer;
      };

      const started = await call<{
        id: string;
        status: string;
        loginUrl: string;
        userCode: string;
        error: string | null;
      }>("POST", `/${created.body.id}/subscription/device`);
      assert.equal(started.status, 200);
      assert.equal(started.body.status, "running");
      assert.equal(started.body.loginUrl, "https://auth.openai.com/codex/device");
      assert.equal(started.body.userCode, "ABCD-EFGH");
      assert.equal(started.body.error, null);
      sessionId = started.body.id;

      const startedOptions = starts[0];
      assert.ok(startedOptions);
      const authRoot = startedOptions.env.CODEX_HOME;
      assert.ok(authRoot);
      assert.equal(startedOptions.env.HOME, authRoot);
      assert.equal(startedOptions.env.XDG_CONFIG_HOME, authRoot);
      assert.notEqual(startedOptions.cwd, authRoot);
      assert.equal((await fs.stat(authRoot)).isDirectory(), true);
      assert.equal((await fs.stat(startedOptions.cwd)).isDirectory(), true);

      const cancelled = await call<{ status: string }>(
        "DELETE",
        `/${created.body.id}/subscription/device/${sessionId}`,
      );
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, "cancelled");
      sessionId = null;
      assert.equal(closeCalls, 1);
      await assertMissing(authRoot);
      await assertMissing(startedOptions.cwd);
    } finally {
      if (sessionId) {
        await call("DELETE", `/${created.body.id}/subscription/device/${sessionId}`).catch(
          () => undefined,
        );
      }
      CodexAppServer.start = originalStart;
    }
  });

  test("completed device sign-in encrypts the managed session and removes plaintext files", async () => {
    const created = await call<PublicModel>("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });
    assert.equal(created.status, 200);

    const originalStart = CodexAppServer.start;
    const loginId = randomUUID();
    const managedAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `access-${randomUUID()}`,
        id_token: `identity-${randomUUID()}`,
        refresh_token: `refresh-${randomUUID()}`,
      },
    });
    const starts: Parameters<typeof CodexAppServer.start>[0][] = [];
    const codex = fakeCodexNotifications();
    let sessionId: string | null = null;
    let authRoot = "";
    let workspace = "";

    try {
      CodexAppServer.start = async (options) => {
        starts.push(options);
        const verification = fakeCodexVerification(options.cwd);
        return {
          request: async <T>(method: string, params?: unknown): Promise<T> => {
            if (method === "account/login/start") {
              return {
                type: "chatgptDeviceCode",
                loginId,
                verificationUrl: "https://auth.openai.com/codex/device",
                userCode: "WXYZ-1234",
              } as T;
            }
            if (method === "account/read") {
              return { account: { type: "chatgpt", email: "member@example.test" } } as T;
            }
            return verification.request<T>(method, params);
          },
          onNotification: codex.subscribe(verification),
          onExit: () => () => undefined,
          stderrSummary: () => "",
          close: async () => undefined,
        } as unknown as CodexAppServer;
      };

      const started = await call<{ id: string; status: string }>(
        "POST",
        `/${created.body.id}/subscription/device`,
      );
      assert.equal(started.status, 200);
      assert.equal(started.body.status, "running");
      sessionId = started.body.id;
      const startedOptions = starts[0];
      assert.ok(startedOptions);
      authRoot = startedOptions.env.CODEX_HOME ?? "";
      workspace = startedOptions.cwd;
      assert.ok(authRoot);

      await fs.writeFile(path.join(authRoot, "auth.json"), managedAuth, {
        encoding: "utf8",
        mode: 0o600,
      });
      codex.emit("account/login/completed", { loginId, success: true });
      codex.emit("account/updated", { authMode: "chatgpt", planType: "plus" });

      const completed = await waitForDeviceStatus(created.body.id, sessionId, "succeeded");
      assert.equal(completed.output, "ChatGPT subscription connected.");
      assert.equal(completed.error, null);
      await waitUntilMissing(authRoot);
      await waitUntilMissing(workspace);

      const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({
        id: created.body.id,
      });
      const storedConfig = JSON.parse(stored.configJson) as Record<string, unknown>;
      assert.equal(stored.configJson.includes(managedAuth), false);
      assert.equal(storedConfig.codexAccessTokenEncrypted, undefined);
      assert.equal(storedConfig.subscriptionCredentialKind, "chatgptSession");
      assert.equal(decryptSecret(String(storedConfig.codexAuthEncrypted)), managedAuth);
      assert.ok(stored.connectedAt instanceof Date);

      const listed = await call<PublicModel[]>("GET", "/");
      assert.equal(listed.status, 200);
      assert.equal(listed.body[0].status, "connected");
      assert.equal(listed.body[0].subscriptionCredentialKind, "chatgptSession");
      assert.equal(JSON.stringify(listed.body).includes(managedAuth), false);
      sessionId = null;
    } finally {
      if (sessionId) {
        await call("DELETE", `/${created.body.id}/subscription/device/${sessionId}`).catch(
          () => undefined,
        );
      }
      CodexAppServer.start = originalStart;
      if (authRoot) await fs.rm(authRoot, { recursive: true, force: true });
      if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("device sign-in confirms the account only once Codex announces the session it loaded", async () => {
    // Codex 0.146.0 reports the login complete before it loads the session it
    // just wrote into CODEX_HOME, and until then answers `account/read` with
    // the empty account it booted with (#59).
    const signIn = await runDeviceSignIn(
      (loaded) =>
        loaded
          ? {
              account: { type: "chatgpt", email: "member@example.test", planType: "plus" },
              requiresOpenaiAuth: true,
            }
          : { account: null, requiresOpenaiAuth: true },
      { authMode: "chatgpt", planType: "plus" },
      "succeeded",
    );

    assert.equal(signIn.beforeAnnouncement.status, "running");
    assert.equal(signIn.beforeAnnouncement.output, "Confirming the ChatGPT account…");
    assert.equal(signIn.readsBeforeAnnouncement, 0);
    assert.equal(signIn.status.output, "ChatGPT subscription connected.");
    assert.equal(signIn.status.error, null);
    assert.deepEqual(signIn.accountReads, [{ params: { refreshToken: false }, loaded: true }]);

    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: signIn.modelId,
    });
    const storedConfig = JSON.parse(stored.configJson) as Record<string, unknown>;
    assert.equal(stored.configJson.includes(signIn.managedAuth), false);
    assert.equal(storedConfig.subscriptionCredentialKind, "chatgptSession");
    assert.equal(decryptSecret(String(storedConfig.codexAuthEncrypted)), signIn.managedAuth);
    assert.ok(stored.connectedAt instanceof Date);
  });

  test("device sign-in stores no credential when Codex loads no ChatGPT account", async () => {
    const signIn = await runDeviceSignIn(
      () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
      { authMode: "apikey", planType: null },
      "failed",
    );

    assert.equal(signIn.readsBeforeAnnouncement, 0);
    assert.match(String(signIn.status.error), /did not confirm the managed ChatGPT account/);
    assert.equal(signIn.status.output, null);
    assert.deepEqual(signIn.accountReads, [{ params: { refreshToken: false }, loaded: true }]);

    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: signIn.modelId,
    });
    assert.equal(stored.configJson, "{}");
    assert.equal(stored.connectedAt, null);

    const listed = await call<PublicModel[]>("GET", "/");
    assert.equal(listed.body[0].status, "not_connected");
    assert.equal(listed.body[0].subscriptionCredentialKind, null);
  });

  test("host execution supports subscription model creation and encrypted credentials", async () => {
    codingTools.executionMode = "host";

    const created = await call<PublicModel>("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });
    assert.equal(created.status, 200);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 1);

    const accessToken = `codex-test-${randomUUID()}-${randomUUID()}`;
    const savedToken = await call("POST", `/${created.body.id}/subscription/access-token`, {
      accessToken,
    });
    assert.equal(savedToken.status, 200);
    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      id: created.body.id,
    });
    assert.equal(stored.configJson.includes(accessToken), false);
    const storedConfig = JSON.parse(stored.configJson) as Record<string, unknown>;
    assert.equal(decryptSecret(String(storedConfig.codexAccessTokenEncrypted)), accessToken);

    const listed = await call<PublicModel[]>("GET", "/");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].subscriptionAvailable, true);
    assert.equal(listed.body[0].subscriptionUnavailableReason, null);
    assert.equal(listed.body[0].status, "connected");
    assert.equal(JSON.stringify(listed.body).includes(accessToken), false);
    assert.equal(listed.body[0].subscriptionShellAvailable, true);
  });

  test("multi-tenant mode rejects both model creation and credentials on an existing model", async () => {
    security.multiTenant = true;

    const deniedCreate = await call("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });
    assert.equal(deniedCreate.status, 400);
    assert.match(String(deniedCreate.body.error), /trusted self-hosted/);
    assert.equal(await AppDataSource.getRepository(AIModel).count(), 0);

    const existing = await insertSubscriptionModel();
    const deniedToken = await call("POST", `/${existing.id}/subscription/access-token`, {
      accessToken: `codex-test-${randomUUID()}-${randomUUID()}`,
    });
    assert.equal(deniedToken.status, 400);
    assert.match(String(deniedToken.body.error), /trusted self-hosted/);
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: existing.id })).configJson,
      "{}",
    );

    const listed = await call<PublicModel[]>("GET", "/");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].subscriptionAvailable, false);
    assert.match(listed.body[0].subscriptionUnavailableReason ?? "", /trusted self-hosted/);
    assert.equal(listed.body[0].subscriptionShellAvailable, false);
  });

  test("a stale bubblewrap selection neither blocks subscriptions nor grants a shell", async () => {
    // Boot narrows it to disabled; a value that slipped past must fail closed
    // for the shell without taking subscription sign-in down with it.
    (codingTools as { executionMode: string }).executionMode = "bubblewrap";

    const created = await call<PublicModel>("POST", "/", {
      provider: "openai",
      model: "gpt-5.4",
      authMode: "subscription",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.subscriptionAvailable, true);
    assert.equal(created.body.subscriptionUnavailableReason, null);
    assert.equal(created.body.subscriptionShellAvailable, false);
  });
});

type DeviceStatus = { status: string; output: string | null; error: string | null };

type DeviceSignIn = {
  modelId: string;
  status: DeviceStatus;
  /** The sign-in as Codex left it: login completed, session not yet loaded. */
  beforeAnnouncement: DeviceStatus;
  readsBeforeAnnouncement: number;
  accountReads: Array<{ params: Record<string, unknown>; loaded: boolean }>;
  managedAuth: string;
};

type NotificationListener = (method: string, params: unknown) => void;

/**
 * Notification fan-out for an in-process fake app-server. Like the real
 * transport, every subscriber hears every notification until it unsubscribes;
 * subscribers also reach the connection-test fake, which emits its own.
 */
function fakeCodexNotifications() {
  const listeners = new Set<NotificationListener>();
  return {
    subscribe:
      (verification: CodexAppServer) =>
      (listener: NotificationListener): (() => void) => {
        listeners.add(listener);
        const stopVerification = verification.onNotification(listener);
        return () => {
          listeners.delete(listener);
          stopVerification();
        };
      },
    emit: (method: string, params: unknown) => {
      for (const listener of [...listeners]) listener(method, params);
    },
  };
}

/**
 * Drive one whole device sign-in against a fake Codex app-server that keeps
 * Codex 0.146.0's order: it writes the managed session into the isolated
 * CODEX_HOME, reports the login completed, and only then loads the session and
 * announces it with `account/updated`. `accountFor` answers each
 * `account/read` from whether the session has been loaded yet.
 */
async function runDeviceSignIn(
  accountFor: (loaded: boolean) => unknown,
  announcement: { authMode: string | null; planType: string | null },
  expected: "succeeded" | "failed",
): Promise<DeviceSignIn> {
  const created = await call<PublicModel>("POST", "/", {
    provider: "openai",
    model: "gpt-5.4",
    authMode: "subscription",
  });
  assert.equal(created.status, 200);

  const originalStart = CodexAppServer.start;
  const loginId = randomUUID();
  const managedAuth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `access-${randomUUID()}`,
      id_token: `identity-${randomUUID()}`,
      refresh_token: `refresh-${randomUUID()}`,
    },
  });
  const accountReads: DeviceSignIn["accountReads"] = [];
  const starts: Parameters<typeof CodexAppServer.start>[0][] = [];
  const codex = fakeCodexNotifications();
  let loaded = false;
  let sessionId: string | null = null;

  try {
    CodexAppServer.start = async (options) => {
      starts.push(options);
      const verification = fakeCodexVerification(options.cwd);
      return {
        request: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "account/login/start") {
            return {
              type: "chatgptDeviceCode",
              loginId,
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "WXYZ-1234",
            } as T;
          }
          if (method === "account/read") {
            accountReads.push({ params: (params ?? {}) as Record<string, unknown>, loaded });
            return accountFor(loaded) as T;
          }
          return verification.request<T>(method, params);
        },
        onNotification: codex.subscribe(verification),
        onExit: () => () => undefined,
        stderrSummary: () => "",
        close: async () => undefined,
      } as unknown as CodexAppServer;
    };

    const started = await call<DeviceStatus & { id: string }>(
      "POST",
      `/${created.body.id}/subscription/device`,
    );
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "running");
    sessionId = started.body.id;

    const startedOptions = starts[0];
    assert.ok(startedOptions);
    const authRoot = startedOptions.env.CODEX_HOME ?? "";
    assert.ok(authRoot);

    await fs.writeFile(path.join(authRoot, "auth.json"), managedAuth, {
      encoding: "utf8",
      mode: 0o600,
    });
    codex.emit("account/login/completed", { loginId, success: true });
    const beforeAnnouncement = await waitForDevice(
      created.body.id,
      sessionId,
      (session) => session.status !== "running" || session.output !== started.body.output,
      "sign-in to react to the completed login",
    );
    const readsBeforeAnnouncement = accountReads.length;

    loaded = true;
    codex.emit("account/updated", announcement);
    const status = await waitForDeviceStatus(created.body.id, sessionId, expected);
    await waitUntilMissing(authRoot);
    await waitUntilMissing(startedOptions.cwd);
    sessionId = null;
    return {
      modelId: created.body.id,
      status,
      beforeAnnouncement,
      readsBeforeAnnouncement,
      accountReads,
      managedAuth,
    };
  } finally {
    if (sessionId) {
      await call("DELETE", `/${created.body.id}/subscription/device/${sessionId}`).catch(
        () => undefined,
      );
    }
    CodexAppServer.start = originalStart;
    for (const options of starts) {
      await fs
        .rm(options.env.CODEX_HOME ?? "", { recursive: true, force: true })
        .catch(() => undefined);
      await fs.rm(options.cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function assertMissing(target: string): Promise<void> {
  await assert.rejects(fs.stat(target), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  });
}

async function waitForDeviceStatus(
  modelId: string,
  sessionId: string,
  expected: string,
): Promise<DeviceStatus> {
  return waitForDevice(
    modelId,
    sessionId,
    (session) => session.status === expected,
    `device sign-in to reach ${expected}`,
  );
}

async function waitForDevice(
  modelId: string,
  sessionId: string,
  done: (session: DeviceStatus) => boolean,
  what: string,
): Promise<DeviceStatus> {
  let last: DeviceStatus | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await call<DeviceStatus>(
      "GET",
      `/${modelId}/subscription/device/${sessionId}`,
    );
    assert.equal(response.status, 200);
    last = response.body;
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}; last state: ${JSON.stringify(last)}`);
}

async function waitUntilMissing(target: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`temporary path was not removed: ${target}`);
}
