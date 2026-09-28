import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { ensureFreshGoogleToken } from "../integrations/providers/google/auth.js";
import type { IntegrationRuntimeContext } from "../integrations/types.js";
import { listCatalog } from "../integrations/index.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { readAuthFlowState } from "./authFlowState.js";
import {
  cancelHostedGoogleOauth,
  hostedGoogleSignInAvailable,
  pollHostedGoogleOauth,
  resetHostedGoogleAvailabilityForTests,
  startHostedGoogleOauth,
} from "./hostedGoogleOauth.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
  serializeConnection,
} from "./integrations.js";
import { describeMailboxConnect } from "./mail/connect.js";
import { waitForAccountSync } from "./mail/sync.js";
import { finishOauth, startOauth, startOauthReconnect } from "./oauth.js";
import { saveOauthApp } from "./oauthApps.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";

const issuer = "https://signin.example";
const base = {
  companyId: "company-hosted",
  userId: "member-hosted",
  provider: "google",
  label: "My Gmail",
  scopeGroups: ["mail"],
};
const credential = () => ({
  clientId: "shared-client",
  accessToken: "google-access-secret",
  refreshToken: "google-refresh-secret",
  expiresAt: Date.now() + 3_600_000,
  scope: "openid https://www.googleapis.com/auth/gmail.modify",
  email: "member@gmail.com",
});
const originalFetch = globalThis.fetch;
type Call = { url: string; body: Record<string, unknown>; init?: RequestInit };
let calls: Call[] = [];
let remoteResult: unknown;

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  calls = [];
  remoteResult = { status: "pending" };
  resetHostedGoogleAvailabilityForTests();
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: true, gmailSignInUrl: issuer } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      init,
    });
    if (url === `${issuer}/api/google-sign-in/status`)
      return reply({ version: 1, available: true });
    if (url === `${issuer}/api/google-sign-in/start`)
      return reply({
        requestId: "remote-request",
        authorizeUrl: `${issuer}/api/google-sign-in/authorize?requestId=remote-request`,
        expiresAt: Date.now() + 600_000,
      });
    if (url === `${issuer}/api/google-sign-in/poll`) return reply(remoteResult);
    if (url === `${issuer}/api/google-sign-in/refresh`)
      return reply({
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
        expiresAt: Date.now() + 3_600_000,
      });
    throw new Error("Unexpected network request");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  overrideRuntimeSettingsForTests(null);
});

test("availability verifies the remote protocol, caches briefly, and advertises Gmail alone", async () => {
  assert.equal(await hostedGoogleSignInAvailable(), true);
  const plan = await describeMailboxConnect("member@gmail.com");
  assert.equal(plan.options[0].ready, true);
  assert.equal(plan.options[0].hostedSignIn, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, "error");
  const enabled = listCatalog({ hostedGoogleSignIn: true }).filter(
    (entry) => entry.oauth?.hostedSignIn,
  );
  assert.deepEqual(
    enabled.map((entry) => entry.provider),
    ["google"],
  );
  assert.equal(enabled[0].oauth?.instanceApp, undefined);
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: false } });
  assert.equal(await hostedGoogleSignInAvailable(), false);
  assert.equal(calls.length, 1);
});

test("an unavailable or incompatible hosted service leaves Gmail blocked with a working setup path", async () => {
  globalThis.fetch = async () => reply({ version: 2, available: true });
  assert.equal(await hostedGoogleSignInAvailable(), false);
  const plan = await describeMailboxConnect("member@gmail.com");
  assert.equal(plan.options[0].ready, false);
  assert.match(plan.options[0].blockedReason ?? "", /Admin → Integrations/);
});

test("fresh Gmail sign-in keeps the verifier encrypted and off browser and start responses", async () => {
  const result = await startOauth(base);
  assert.ok(result.hostedAttempt);
  const state = await readAuthFlowState<{ codeVerifier: string; tokenBrokerUrl: string }>(
    "hosted-google-consumer",
    result.hostedAttempt,
  );
  assert.ok(state);
  assert.equal(
    calls[0].body.codeChallenge,
    crypto.createHash("sha256").update(state.payload.codeVerifier).digest("base64url"),
  );
  assert.ok(result.hostedBrowserProof);
  assert.equal(
    calls[0].body.browserChallenge,
    crypto.createHash("sha256").update(result.hostedBrowserProof).digest("base64url"),
  );
  assert.notEqual(result.hostedBrowserProof, state.payload.codeVerifier);
  assert.equal(JSON.stringify(calls).includes(result.hostedBrowserProof), false);
  assert.equal(state.payload.tokenBrokerUrl, issuer);
  assert.equal(JSON.stringify(result).includes(state.payload.codeVerifier), false);
  assert.equal(JSON.stringify(calls).includes(state.payload.codeVerifier), false);
  const rows = await AppDataSource.getRepository(AuthFlowState).find();
  assert.equal(JSON.stringify(rows).includes(state.payload.codeVerifier), false);
  assert.equal(JSON.stringify(rows).includes(result.hostedAttempt), false);
});

test("direct client credentials win and hosted sign-in cannot widen beyond Gmail", async () => {
  const own = await startOauth({ ...base, clientId: "own-id", clientSecret: "own-secret" });
  assert.equal(new URL(own.authorizeUrl).searchParams.get("client_id"), "own-id");
  await assert.rejects(startOauth({ ...base, scopeGroups: ["mail", "drive"] }), /OAuth client/);
  await assert.rejects(startOauth({ ...base, clientId: "half-pair" }), /OAuth client/);
  await saveOauthApp("google", { clientId: "registered-id", clientSecret: "registered-secret" });
  const registered = await startOauth(base);
  assert.equal(new URL(registered.authorizeUrl).searchParams.get("client_id"), "registered-id");
  assert.equal(calls.length, 0);
});

test("wrong Member or company cannot poll or cancel another sign-in or consume its state", async () => {
  const result = await startHostedGoogleOauth(base);
  const attempt = result.hostedAttempt!;
  await assert.rejects(
    pollHostedGoogleOauth({ ...base, userId: "intruder", attempt }),
    /different Member/,
  );
  await assert.rejects(
    cancelHostedGoogleOauth({ ...base, companyId: "other-company", attempt }),
    /different Member/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(await pollHostedGoogleOauth({ ...base, attempt }), { status: "pending" });
  assert.ok(await readAuthFlowState("hosted-google-consumer", attempt));
});

test("one completed poll persists local credentials with no shared secret and cannot replay", async () => {
  const result = await startOauth(base);
  remoteResult = { status: "complete", credential: credential() };
  const attempt = result.hostedAttempt!;
  assert.deepEqual(await pollHostedGoogleOauth({ ...base, attempt }), { status: "complete" });
  const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
  assert.ok(connection);
  const config = decryptConnectionConfig(connection);
  assert.equal(config.credentialSource, "hosted");
  assert.equal(config.clientSecret, undefined);
  assert.equal(config.tokenBrokerUrl, issuer);
  assert.equal(config.refreshToken, "google-refresh-secret");
  assert.equal(connection.encryptedConfig.includes("google-refresh-secret"), false);
  const serialized = serializeConnection(connection);
  assert.equal(serialized.hostedSignIn, true);
  assert.equal(JSON.stringify(serialized).includes("google-refresh-secret"), false);
  assert.equal(JSON.stringify(serialized).includes(issuer), false);
  assert.equal((await pollHostedGoogleOauth({ ...base, attempt })).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("cancelling an in-flight poll prevents a late Google result from creating a Connection", async () => {
  const result = await startOauth(base);
  const attempt = result.hostedAttempt!;
  let release!: (response: Response) => void;
  let contacted!: () => void;
  const started = new Promise<void>((resolve) => {
    contacted = resolve;
  });
  globalThis.fetch = async () => {
    contacted();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  const polling = pollHostedGoogleOauth({ ...base, attempt });
  await started;
  assert.equal((await pollHostedGoogleOauth({ ...base, attempt })).status, "pending");
  await cancelHostedGoogleOauth({ ...base, attempt });
  await cancelHostedGoogleOauth({ ...base, attempt });
  release(reply({ status: "complete", credential: credential() }));
  assert.equal((await polling).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("malformed remote completion never persists tokens and remote details never reach the Member", async () => {
  const result = await startOauth(base);
  remoteResult = { status: "complete", credential: { ...credential(), expiresAt: "wrong-type" } };
  await assert.rejects(
    pollHostedGoogleOauth({ ...base, attempt: result.hostedAttempt! }),
    (error: Error) => {
      assert.equal(error.message.includes("google-refresh-secret"), false);
      return true;
    },
  );
  remoteResult = { status: "denied", detail: "secret-token-from-untrusted-broker" };
  const denied = await pollHostedGoogleOauth({ ...base, attempt: result.hostedAttempt! });
  assert.equal(denied.status, "denied");
  assert.equal(JSON.stringify(denied).includes("secret-token"), false);
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("a failed mailbox link reports failure and removes its newly created Connection", async () => {
  const result = await startOauth({ ...base, linkMailbox: true });
  remoteResult = { status: "complete", credential: credential() };
  const denied = await pollHostedGoogleOauth({ ...base, attempt: result.hostedAttempt! });
  assert.equal(denied.status, "denied");
  assert.match(denied.detail ?? "", /mailbox could not be connected/);
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
  assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
});

test("hosted consent creates a real Gmail mailbox and starts its first successful import", async () => {
  const brokerFetch = globalThis.fetch;
  const gmailCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://gmail.googleapis.com") return brokerFetch(input, init);
    gmailCalls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer google-access-secret");
    if (url.pathname.endsWith("/profile"))
      return reply({ emailAddress: "member@gmail.com", historyId: "100" });
    if (url.pathname.endsWith("/labels")) return reply({ labels: [] });
    if (url.pathname.endsWith("/threads")) return reply({ threads: [], resultSizeEstimate: 0 });
    if (url.pathname.endsWith("/history")) return reply({ history: [], historyId: "100" });
    if (url.pathname.endsWith("/drafts")) return reply({ drafts: [], resultSizeEstimate: 0 });
    throw new Error(`Unexpected Gmail fixture path: ${url.pathname}`);
  };
  const result = await startOauth({ ...base, linkMailbox: true });
  remoteResult = { status: "complete", credential: credential() };
  assert.deepEqual(await pollHostedGoogleOauth({ ...base, attempt: result.hostedAttempt! }), {
    status: "complete",
  });
  const [mailbox] = await AppDataSource.getRepository(MailAccount).find();
  assert.ok(mailbox);
  assert.equal(mailbox.address, "member@gmail.com");
  assert.equal(mailbox.companyId, base.companyId);
  assert.equal(mailbox.provider, "gmail");
  await waitForAccountSync(mailbox.id);
  const synced = await AppDataSource.getRepository(MailAccount).findOneByOrFail({ id: mailbox.id });
  assert.equal(synced.syncState, "succeeded", synced.statusMessage);
  assert.ok(synced.backfilledAt);
  assert.ok(gmailCalls.some((url) => url.endsWith("/threads")));
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("hosted reconnect pins issuer and protects an existing mailbox's identity and stable Connection", async () => {
  const original = {
    ...credential(),
    credentialSource: "hosted",
    tokenBrokerUrl: issuer,
    scopeGroups: ["mail"],
  };
  const connection = await insert(IntegrationConnection, {
    companyId: base.companyId,
    provider: "google",
    label: base.label,
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(original, base.companyId),
    accountHint: original.email,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  await insert(MailAccount, {
    companyId: base.companyId,
    connectionId: connection.id,
    address: original.email,
    provider: "gmail",
    status: "active",
  });
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInUrl: "https://changed.example" } });
  await assert.rejects(
    startOauthReconnect({ ...base, connectionId: connection.id, scopeGroups: ["mail", "drive"] }),
    /Gmail only/,
  );
  const result = await startOauthReconnect({ ...base, connectionId: connection.id });
  assert.ok(result.authorizeUrl.startsWith(issuer));
  remoteResult = {
    status: "complete",
    credential: { ...credential(), email: "different@gmail.com" },
  };
  assert.equal(
    (await pollHostedGoogleOauth({ ...base, attempt: result.hostedAttempt! })).status,
    "denied",
  );
  const saved = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
    id: connection.id,
  });
  assert.equal(saved.encryptedConfig, connection.encryptedConfig);
  assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);
});

test("refresh follows the persisted issuer even after runtime settings change and preserves rotations", async () => {
  overrideRuntimeSettingsForTests({
    oauth: { gmailSignInEnabled: false, gmailSignInUrl: "https://changed.example" },
  });
  const context: IntegrationRuntimeContext = {
    authMode: "oauth2",
    config: { ...credential(), credentialSource: "hosted", tokenBrokerUrl: issuer, expiresAt: 1 },
  };
  await ensureFreshGoogleToken(context);
  assert.equal(calls[0].url, `${issuer}/api/google-sign-in/refresh`);
  assert.deepEqual(calls[0].body, {
    clientId: "shared-client",
    refreshToken: "google-refresh-secret",
  });
  assert.equal(context.config.accessToken, "refreshed-access");
  assert.equal(context.config.refreshToken, "rotated-refresh");
  assert.equal(context.config.clientSecret, undefined);
  assert.equal(context.config.tokenBrokerUrl, issuer);
});

test("unsafe broker origins and authorization redirects are refused before credentials can escape", async () => {
  await assert.rejects(
    startHostedGoogleOauth({ ...base, tokenBrokerUrl: "http://remote.example" }),
    /unavailable/,
  );
  assert.equal(calls.length, 0);
  globalThis.fetch = async () =>
    reply({
      requestId: "id",
      authorizeUrl: "https://evil.example/steal",
      expiresAt: Date.now() + 600_000,
    });
  await assert.rejects(startHostedGoogleOauth(base), /unavailable/);
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
});

test("a direct OAuth callback must match the provider saved in the original state", async () => {
  await assert.rejects(
    finishOauth({
      app: "github",
      code: "code",
      state: {
        ...base,
        state: "state",
        clientId: "id",
        clientSecret: "secret",
        expiresAt: Date.now() + 600_000,
      },
    }),
    /callback does not match/,
  );
  assert.equal(calls.length, 0);
});
