import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { CodexAppServer } from "./agent/codexAppServer.js";
import type { PublicSubscriptionDeviceSession } from "./codexSubscription.js";

/**
 * ChatGPT device sign-in, end to end through a real child process.
 *
 * The fake app-server below speaks the JSONL protocol over stdio and keeps
 * Codex's own account semantics: `account/read` answers from the session the
 * process has loaded, a refreshing read cannot load a session the process
 * does not already hold, and `account/updated` is sent only once the session
 * is loaded. What it varies is the order Codex releases have used — 0.146.0,
 * which Genosyn pins, announces `account/login/completed` before it loads the
 * session (issue #59); 0.156.0 and later load first.
 */

type ExecutionMode = "host" | "disabled";

type MutableConfig = {
  sessionSecret: string;
  security: { multiTenant: boolean; encryptionSecret: string };
  agent: { codingTools: { enabled: boolean; executionMode: ExecutionMode } };
};

type FakeCodex = {
  /** Codex <= 0.155 announces completion first; 0.156+ loads the session first. */
  order: "completion-first" | "load-first";
  /** What the login leaves behind once Codex has finished with it. */
  outcome?: "chatgpt" | "no-session" | "exit-before-load" | "rejected";
  /** Hold the session load until the test releases it with `loadSession()`. */
  gateLoad?: boolean;
};

type ProtocolEntry = {
  at: number;
  seq: number;
  notification?: string;
  params?: Record<string, unknown>;
  request?: string;
  refreshToken?: boolean;
  sessionLoaded?: boolean;
  refreshed?: boolean;
  wroteAuth?: string;
};

const mutableConfig = config as unknown as MutableConfig;
const security = mutableConfig.security;
const codingTools = mutableConfig.agent.codingTools;
const originalSecurity = structuredClone(security);
const originalCodingTools = structuredClone(codingTools);
const originalSessionSecret = config.sessionSecret;
const originalTmpDir = process.env.TMPDIR;
const realCodexStart = CodexAppServer.start;

let tempRoot: string;
let fixtureRoot: string;
let subscription!: typeof import("./codexSubscription.js");
let owner: { companyId: string; actorUserId: string };

before(async () => {
  // Point the service's temporary Codex homes at a private root, so each test
  // can prove sign-in removed every directory that ever held a credential.
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-device-login-test-"));
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-device-login-fixture-"));
  process.env.TMPDIR = tempRoot;
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
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  security.multiTenant = false;
  security.encryptionSecret = "codex-device-login-test-encryption-secret-2026";
  mutableConfig.sessionSecret = "codex-device-login-test-session-secret-2026";
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  for (const entry of await fs.readdir(tempRoot)) {
    await fs.rm(path.join(tempRoot, entry), { recursive: true, force: true });
  }

  const user = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: user.id,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "owner" });
  owner = { companyId: company.id, actorUserId: user.id };
});

async function insertSubscriptionModel(): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: `employee-${randomUUID()}`,
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

/**
 * Route every `CodexAppServer.start` in this test to the fake app-server,
 * through the production transport. Returns the protocol the fake recorded
 * and the switch that lets a gated fake load its session.
 */
async function useFakeCodex(t: TestContext, fake: FakeCodex) {
  const dir = await fs.mkdtemp(path.join(fixtureRoot, "codex-"));
  const entrypoint = path.join(dir, "fake-app-server.mjs");
  const protocolPath = path.join(dir, "protocol.jsonl");
  const loadTrigger = path.join(dir, "load-session");
  await fs.writeFile(entrypoint, FAKE_CODEX_APP_SERVER);
  await fs.writeFile(protocolPath, "");
  t.mock.method(CodexAppServer, "start", (options: Parameters<typeof CodexAppServer.start>[0]) =>
    realCodexStart({
      ...options,
      entrypoint,
      env: {
        ...options.env,
        GENOSYN_FAKE_CODEX_ORDER: fake.order,
        GENOSYN_FAKE_CODEX_OUTCOME: fake.outcome ?? "chatgpt",
        GENOSYN_FAKE_CODEX_PROTOCOL: protocolPath,
        ...(fake.gateLoad ? { GENOSYN_FAKE_CODEX_LOAD_TRIGGER: loadTrigger } : {}),
      },
    }),
  );
  return {
    protocol: async (): Promise<ProtocolEntry[]> => {
      const text = await fs.readFile(protocolPath, "utf8");
      // The fake may be mid-append; only whole lines are entries.
      return text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ProtocolEntry);
    },
    loadSession: () => fs.writeFile(loadTrigger, ""),
  };
}

async function waitForSession(
  modelId: string,
  sessionId: string,
  done: (session: PublicSubscriptionDeviceSession) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<PublicSubscriptionDeviceSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = subscription.getSubscriptionDeviceLogin(modelId, sessionId);
    assert.ok(session, "the device session stays readable until it expires");
    if (done(session)) return session;
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${what}; last state: ${JSON.stringify(session)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProtocol(
  read: () => Promise<ProtocolEntry[]>,
  done: (entries: ProtocolEntry[]) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<ProtocolEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await read();
    if (done(entries)) return entries;
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${what}; protocol so far: ${JSON.stringify(entries)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Sign-in must leave nothing behind: every temporary Codex home is gone. */
async function assertNoTemporaryHomes(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const left = await fs.readdir(tempRoot);
    if (left.length === 0) return;
    if (Date.now() >= deadline) assert.fail(`temporary Codex homes left behind: ${left}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertNothingStored(modelId: string): Promise<void> {
  const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: modelId });
  assert.equal(stored.configJson, "{}");
  assert.equal(stored.connectedAt, null);
  assert.equal(subscription.hasSubscriptionCredential(stored), false);
}

const accountReads = (entries: ProtocolEntry[]) =>
  entries.filter((entry) => entry.request === "account/read");
const sent = (entries: ProtocolEntry[], notification: string) =>
  entries.find((entry) => entry.notification === notification);

describe("ChatGPT device sign-in against Codex's login protocol", () => {
  test("waits for Codex 0.146.0 to load the session it announced before confirming it (#59)", async (t) => {
    const codex = await useFakeCodex(t, { order: "completion-first", gateLoad: true });
    const model = await insertSubscriptionModel();

    const started = await subscription.startSubscriptionDeviceLogin(model.id, owner);
    assert.equal(started.status, "running");
    assert.equal(started.userCode, "TEST-0059");

    // Codex has announced the login complete but not loaded the session yet:
    // this is the window every sign-in on a fast host used to die in.
    await waitForProtocol(
      codex.protocol,
      (entries) => Boolean(sent(entries, "account/login/completed")),
      "Codex to announce the completed login",
    );
    const confirming = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running" || session.output !== started.output,
      "sign-in to react to the completed login",
    );
    assert.equal(confirming.status, "running", confirming.error ?? undefined);
    assert.equal(confirming.output, "Confirming the ChatGPT account…");
    assert.deepEqual(
      accountReads(await codex.protocol()),
      [],
      "nothing may ask Codex for the account before Codex has loaded it",
    );

    await codex.loadSession();
    const finished = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running",
      "sign-in to finish",
    );
    assert.equal(finished.status, "succeeded", finished.error ?? undefined);
    assert.equal(finished.output, "ChatGPT subscription connected.");
    assert.equal(finished.error, null);

    const entries = await codex.protocol();
    const updated = sent(entries, "account/updated");
    assert.ok(updated);
    const reads = accountReads(entries);
    assert.equal(reads.length, 1, "one read confirms the account once Codex holds it");
    assert.equal(reads[0].refreshToken, false);
    assert.equal(reads[0].sessionLoaded, true);
    assert.ok(reads[0].seq > updated.seq, "the read follows account/updated");
    assert.equal(
      entries.some((entry) => entry.refreshed),
      false,
      "confirming a brand-new session must not rotate its refresh token",
    );

    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id });
    const storedConfig = JSON.parse(stored.configJson) as Record<string, unknown>;
    const wroteAuth = entries.find((entry) => entry.wroteAuth)?.wroteAuth;
    assert.ok(wroteAuth);
    assert.equal(stored.configJson.includes(wroteAuth), false);
    assert.equal(decryptSecret(String(storedConfig.codexAuthEncrypted)), wroteAuth);
    assert.equal(storedConfig.subscriptionCredentialKind, "chatgptSession");
    assert.ok(stored.connectedAt instanceof Date);
    await assertNoTemporaryHomes();
  });

  test("connects at once when Codex loads the session before announcing the login", async (t) => {
    const codex = await useFakeCodex(t, { order: "load-first" });
    const model = await insertSubscriptionModel();

    const started = await subscription.startSubscriptionDeviceLogin(model.id, owner);
    const finished = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running",
      "sign-in to finish",
    );
    assert.equal(finished.status, "succeeded", finished.error ?? undefined);

    const entries = await codex.protocol();
    const updated = sent(entries, "account/updated");
    assert.ok(updated);
    const reads = accountReads(entries);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].refreshToken, false);
    assert.equal(reads[0].sessionLoaded, true);
    assert.ok(reads[0].seq > updated.seq);
    assert.equal(
      subscription.hasSubscriptionCredential(
        await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id }),
      ),
      true,
    );
    await assertNoTemporaryHomes();
  });

  test("fails at once, storing nothing, when Codex exits before loading the session", async (t) => {
    const codex = await useFakeCodex(t, { order: "completion-first", outcome: "exit-before-load" });
    const model = await insertSubscriptionModel();

    const started = await subscription.startSubscriptionDeviceLogin(model.id, owner);
    const startedAt = Date.now();
    const finished = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running",
      "sign-in to notice Codex exited",
    );
    assert.equal(finished.status, "failed");
    assert.match(String(finished.error), /exited unexpectedly/);
    assert.ok(
      Date.now() - startedAt < 10_000,
      "an exit ends the wait for the account instead of running out its bound",
    );
    assert.deepEqual(accountReads(await codex.protocol()), []);
    await assertNothingStored(model.id);
    await assertNoTemporaryHomes();
  });

  test("stores nothing when the completed login leaves Codex without a ChatGPT session", async (t) => {
    const codex = await useFakeCodex(t, { order: "completion-first", outcome: "no-session" });
    const model = await insertSubscriptionModel();

    const started = await subscription.startSubscriptionDeviceLogin(model.id, owner);
    const finished = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running",
      "sign-in to finish",
    );
    assert.equal(finished.status, "failed");
    assert.match(String(finished.error), /did not confirm the managed ChatGPT account/);

    const entries = await codex.protocol();
    assert.deepEqual(sent(entries, "account/updated")?.params, { authMode: null, planType: null });
    const reads = accountReads(entries);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].refreshToken, false);
    await assertNothingStored(model.id);
    await assertNoTemporaryHomes();
  });

  test("reports a login OpenAI rejected without waiting for an account", async (t) => {
    const codex = await useFakeCodex(t, { order: "completion-first", outcome: "rejected" });
    const model = await insertSubscriptionModel();

    const started = await subscription.startSubscriptionDeviceLogin(model.id, owner);
    const finished = await waitForSession(
      model.id,
      started.id,
      (session) => session.status !== "running",
      "sign-in to finish",
      // Codex sends no account/updated after a failed login, so a sign-in
      // that waited for one would sit out the whole bound here.
      5_000,
    );
    assert.equal(finished.status, "failed");
    assert.equal(finished.error, "device auth failed with status 403 Forbidden");
    assert.deepEqual(accountReads(await codex.protocol()), []);
    await assertNothingStored(model.id);
    await assertNoTemporaryHomes();
  });
});

/**
 * A Codex app-server reduced to the device login and the connection test.
 * Its `session` is Codex's in-memory auth cache: `account/read` answers from
 * it, and only the load after a completed login fills it.
 */
const FAKE_CODEX_APP_SERVER = String.raw`
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const order = process.env.GENOSYN_FAKE_CODEX_ORDER;
const outcome = process.env.GENOSYN_FAKE_CODEX_OUTCOME;
const loadTrigger = process.env.GENOSYN_FAKE_CODEX_LOAD_TRIGGER;
const protocolPath = process.env.GENOSYN_FAKE_CODEX_PROTOCOL;
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
let seq = 0;
let session = null;

const record = (entry) =>
  fs.appendFileSync(protocolPath, JSON.stringify({ at: Date.now(), seq: ++seq, ...entry }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => {
  record({ notification: method, params });
  send({ method, params });
};

function loadSession() {
  session = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : null;
  notify("account/updated", {
    authMode: session ? "chatgpt" : null,
    planType: session ? "plus" : null,
  });
}

function whenReleased(run) {
  if (!loadTrigger) return void setTimeout(run, 5);
  const poll = setInterval(() => {
    if (!fs.existsSync(loadTrigger)) return;
    clearInterval(poll);
    run();
  }, 5);
}

function completeLogin(loginId) {
  if (outcome === "rejected") {
    notify("account/login/completed", {
      loginId,
      success: false,
      error: "device auth failed with status 403 Forbidden",
    });
    return;
  }
  if (outcome !== "no-session") {
    const auth = JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          id_token: "id-" + loginId,
          access_token: "access-" + loginId,
          refresh_token: "refresh-" + loginId,
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    );
    fs.writeFileSync(authPath, auth, { mode: 0o600 });
    record({ wroteAuth: auth });
  }
  const completed = { loginId, success: true, error: null };
  if (order === "load-first") {
    session = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : null;
    notify("account/login/completed", completed);
    notify("account/updated", { authMode: session ? "chatgpt" : null, planType: session ? "plus" : null });
    return;
  }
  notify("account/login/completed", completed);
  if (outcome === "exit-before-load") return void setTimeout(() => process.exit(3), 5);
  whenReleased(loadSession);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { codexHome: process.env.CODEX_HOME } });
  } else if (method === "account/login/start") {
    const loginId = "login-" + process.pid;
    send({
      id,
      result: {
        type: "chatgptDeviceCode",
        loginId,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "TEST-0059",
      },
    });
    // The person approves the code in their browser a moment later.
    setTimeout(() => completeLogin(loginId), 20);
  } else if (method === "account/read") {
    const refreshToken = params?.refreshToken === true;
    record({ request: "account/read", refreshToken, sessionLoaded: Boolean(session) });
    // Codex refreshes only a session it already holds, rotating it over the
    // network; with nothing loaded the refresh is skipped and loads nothing.
    if (refreshToken && session) {
      session.tokens.refresh_token += "-rotated";
      fs.writeFileSync(authPath, JSON.stringify(session, null, 2), { mode: 0o600 });
      record({ refreshed: true });
    }
    send({
      id,
      result: {
        account: session ? { type: "chatgpt", email: "member@example.test", planType: "plus" } : null,
        requiresOpenaiAuth: true,
      },
    });
  } else if (method === "account/login/cancel") {
    send({ id, result: { status: "canceled" } });
  } else if (method === "thread/start") {
    const { cwd, model } = params;
    send({
      id,
      result: {
        thread: { id: "verify-thread", cwd, ephemeral: true, parentThreadId: null },
        cwd, model, modelProvider: "openai", approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
        runtimeWorkspaceRoots: [], instructionSources: [],
      },
    });
  } else if (method === "turn/start") {
    send({ id, result: { turn: { id: "verify-turn" } } });
    send({
      method: "item/completed",
      params: {
        threadId: "verify-thread", turnId: "verify-turn",
        item: { id: "reply", type: "agentMessage", text: "OK" },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId: "verify-thread", turn: { id: "verify-turn", status: "completed" } },
    });
  } else {
    send({ id, error: { code: -32601, message: "Unsupported fake method: " + method } });
  }
});
`;
