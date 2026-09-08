import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { decryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { CodexAppServer } from "./agent/codexAppServer.js";
import { runCodexSubscriptionTurn } from "./agent/codexRuntime.js";
import { residentOnlyRegistry } from "./agent/tools/toolRegistry.js";

type ExecutionMode = "host" | "bubblewrap" | "disabled";

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
      bubblewrapPath: string;
    };
  };
};

const mutableConfig = config as unknown as MutableConfig;
const security = mutableConfig.security;
const codingTools = mutableConfig.agent.codingTools;
const originalSecurity = structuredClone(security);
const originalCodingTools = structuredClone(codingTools);
const originalSessionSecret = config.sessionSecret;
const originalTmpDir = process.env.TMPDIR;
const originalProcessAccessToken = process.env.CODEX_ACCESS_TOKEN;

let tempRoot: string;
let subscription!: typeof import("./codexSubscription.js");

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-subscription-runtime-test-"));
  process.env.TMPDIR = tempRoot;
  security.multiTenant = false;
  security.encryptionSecret = "codex-runtime-test-encryption-secret-2026";
  mutableConfig.sessionSecret = "codex-runtime-test-session-secret-2026";
  codingTools.executionMode = "disabled";
  codingTools.bubblewrapPath = `/definitely-missing-bwrap-${randomUUID()}`;
  subscription = await import("./codexSubscription.js");
  await initTestDb();
});

after(async () => {
  await closeTestDb();
  Object.assign(security, originalSecurity);
  Object.assign(codingTools, originalCodingTools);
  mutableConfig.sessionSecret = originalSessionSecret;
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  security.multiTenant = false;
  security.encryptionSecret = "codex-runtime-test-encryption-secret-2026";
  mutableConfig.sessionSecret = "codex-runtime-test-session-secret-2026";
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.bubblewrapPath = `/definitely-missing-bwrap-${randomUUID()}`;
  for (const entry of await fs.readdir(tempRoot)) {
    await fs.rm(path.join(tempRoot, entry), { recursive: true, force: true });
  }
});

async function insertSubscriptionModel(configJson = "{}"): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: `employee-${randomUUID()}`,
    provider: "openai",
    model: "gpt-5.4",
    authMode: "subscription",
    configJson,
    connectedAt: null,
    isActive: true,
    contextWindow: null,
    contextWindowSource: null,
  });
}

describe("OpenAI subscription credential runtime", () => {
  test("work-session effort reaches the Codex turn request and default effort stays omitted", async (t) => {
    const entrypoint = path.join(tempRoot, "fake-app-server.mjs");
    const requestPath = path.join(tempRoot, "turn-requests.jsonl");
    await fs.writeFile(entrypoint, EFFORT_APP_SERVER);
    const start = CodexAppServer.start;
    t.mock.method(CodexAppServer, "start", (options: Parameters<typeof CodexAppServer.start>[0]) =>
      start({
        ...options,
        entrypoint,
        env: { ...options.env, GENOSYN_TEST_TURN_REQUESTS: requestPath },
      }),
    );
    const model = await insertSubscriptionModel();
    await subscription.saveSubscriptionAccessToken(model.id, `test-codex-effort-${randomUUID()}`);

    for (const effort of ["max", "ultra", null, undefined] as const) {
      const result = await runCodexSubscriptionTurn({
        model,
        effort,
        system: "Read the work brief.",
        messages: [{ role: "user", content: [{ type: "text", text: "Review the change." }] }],
        registry: residentOnlyRegistry([]),
        maxSteps: 4,
      });
      assert.equal(result.finalText, "Reviewed.");
      assert.equal(result.steps, 1);
      // Only the test's fixture and captured protocol remain after each turn.
      assert.deepEqual((await fs.readdir(tempRoot)).sort(), [
        "fake-app-server.mjs",
        "turn-requests.jsonl",
      ]);
    }

    const requests = (await fs.readFile(requestPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.length, 4);
    assert.equal(requests[0].effort, "max");
    assert.equal(requests[1].effort, "ultra");
    assert.equal(Object.hasOwn(requests[2], "effort"), false);
    assert.equal(Object.hasOwn(requests[3], "effort"), false);
    for (const request of requests) {
      assert.equal(request.threadId, "test-thread");
      assert.equal(request.approvalPolicy, "never");
      assert.ok(Array.isArray(request.input));
    }
  });

  test("saving then preparing an access token keeps it encrypted at rest and ephemeral at runtime", async () => {
    const model = await insertSubscriptionModel(JSON.stringify({ harmlessSetting: true }));
    const accessToken = `codex-test-${randomUUID()}-${randomUUID()}`;
    const parentSecretName = `GENOSYN_SUBSCRIPTION_PARENT_SECRET_${randomUUID().replaceAll("-", "")}`;
    process.env[parentSecretName] = "must-not-be-inherited";

    let authRoot = "";
    let workspace = "";
    try {
      const saved = await subscription.saveSubscriptionAccessToken(model.id, accessToken);
      const storedConfig = JSON.parse(saved.configJson) as Record<string, unknown>;
      assert.equal(saved.configJson.includes(accessToken), false);
      assert.equal(storedConfig.harmlessSetting, true);
      assert.equal(storedConfig.subscriptionCredentialKind, "accessToken");
      assert.equal(storedConfig.codexAuthEncrypted, undefined);
      assert.equal(decryptSecret(String(storedConfig.codexAccessTokenEncrypted)), accessToken);
      assert.ok(saved.connectedAt instanceof Date);

      const lease = await subscription.prepareCodexRuntime(model.id);
      authRoot = lease.home.authRoot;
      workspace = lease.home.workspace;
      try {
        assert.equal(lease.credentialKind, "accessToken");
        assert.equal(lease.env.CODEX_ACCESS_TOKEN, accessToken);
        assert.equal(lease.env.CODEX_HOME, authRoot);
        assert.equal(lease.env.HOME, authRoot);
        assert.equal(lease.env.XDG_CONFIG_HOME, authRoot);
        assert.equal(lease.env.NO_COLOR, "1");
        assert.equal(lease.env[parentSecretName], undefined);
        assert.equal(process.env.CODEX_ACCESS_TOKEN, originalProcessAccessToken);
        assert.deepEqual(await fs.readdir(authRoot), []);
        assert.deepEqual(await fs.readdir(workspace), []);
        assert.equal((await fs.stat(authRoot)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(workspace)).mode & 0o777, 0o700);
      } finally {
        await lease.finish();
      }

      await assertMissing(authRoot);
      await assertMissing(workspace);
      assert.deepEqual(await fs.readdir(tempRoot), []);
      assert.equal(process.env.CODEX_ACCESS_TOKEN, originalProcessAccessToken);

      const persisted = await AppDataSource.getRepository(AIModel).findOneByOrFail({
        id: model.id,
      });
      assert.equal(persisted.configJson.includes(accessToken), false);
      assert.equal(
        decryptSecret(
          String(
            (JSON.parse(persisted.configJson) as Record<string, unknown>).codexAccessTokenEncrypted,
          ),
        ),
        accessToken,
      );
    } finally {
      delete process.env[parentSecretName];
      if (authRoot) await fs.rm(authRoot, { recursive: true, force: true });
      if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("preparation failures remove both temporary homes", async () => {
    const model = await insertSubscriptionModel();

    await assert.rejects(
      subscription.prepareCodexRuntime(model.id),
      /No ChatGPT subscription credential is connected/,
    );
    assert.deepEqual(await fs.readdir(tempRoot), []);
  });

  test("host and multi-tenant policies reject service writes before credentials change", async () => {
    const model = await insertSubscriptionModel();
    const accessToken = `codex-test-${randomUUID()}-${randomUUID()}`;

    codingTools.executionMode = "host";
    await assert.rejects(
      subscription.saveSubscriptionAccessToken(model.id, accessToken),
      /host-process tools/,
    );
    await assert.rejects(subscription.prepareCodexRuntime(model.id), /host-process tools/);
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
      "{}",
    );
    assert.deepEqual(await fs.readdir(tempRoot), []);

    codingTools.executionMode = "disabled";
    security.multiTenant = true;
    await assert.rejects(
      subscription.saveSubscriptionAccessToken(model.id, accessToken),
      /trusted self-hosted/,
    );
    await assert.rejects(subscription.prepareCodexRuntime(model.id), /trusted self-hosted/);
    assert.equal(
      (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
      "{}",
    );
    assert.deepEqual(await fs.readdir(tempRoot), []);
  });
});

async function assertMissing(target: string): Promise<void> {
  await assert.rejects(fs.stat(target), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  });
}

/** Real JSONL transport fixture: records only turn parameters, never its credential environment. */
const EFFORT_APP_SERVER = String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: process.env.CODEX_HOME } });
  } else if (message.method === "thread/start") {
    const { cwd, model } = message.params;
    send({
      id: message.id,
      result: {
        thread: { id: "test-thread", cwd, ephemeral: true, parentThreadId: null },
        cwd, model, modelProvider: "openai", approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
        runtimeWorkspaceRoots: [], instructionSources: [],
      },
    });
  } else if (message.method === "turn/start") {
    appendFileSync(process.env.GENOSYN_TEST_TURN_REQUESTS, JSON.stringify(message.params) + "\n");
    send({ id: message.id, result: { turn: { id: "test-turn" } } });
    send({
      method: "item/completed",
      params: {
        threadId: "test-thread", turnId: "test-turn",
        item: { id: "reply", type: "agentMessage", text: "Reviewed.", phase: "final_answer" },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } },
    });
  }
});
`;
