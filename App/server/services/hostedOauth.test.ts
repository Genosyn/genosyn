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
import { createAuthFlowState, readAuthFlowState } from "./authFlowState.js";
import {
  cancelHostedOauth,
  hostedSignInAvailability,
  hostedSignInOffers,
  pollHostedOauth,
  resetHostedOauthAvailabilityForTests,
  startHostedOauth,
} from "./hostedOauth.js";
import { refreshHostedOauthToken } from "./hostedOauthTokens.js";
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
const IDENTITY = ["https://www.googleapis.com/auth/userinfo.email", "openid"];
const GMAIL = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];
const CALENDAR = "https://www.googleapis.com/auth/calendar";
const TASKS = "https://www.googleapis.com/auth/tasks";
const ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
const ADWORDS = "https://www.googleapis.com/auth/adwords";
const base = {
  companyId: "company-hosted",
  userId: "member-hosted",
  provider: "google",
  label: "My Gmail",
  scopeGroups: ["mail"],
};
const credential = (scope = [...IDENTITY, ...GMAIL].join(" ")) => ({
  clientId: "shared-client",
  accessToken: "google-access-secret",
  refreshToken: "google-refresh-secret",
  expiresAt: Date.now() + 3_600_000,
  scope,
  email: "member@gmail.com",
  account: "member@gmail.com",
});
const originalFetch = globalThis.fetch;
type Call = { url: string; body: Record<string, unknown>; init?: RequestInit };
let calls: Call[] = [];
let remoteResult: unknown;
/** What the fake Genosyn Connect advertises; null imitates a service from before scopes. */
let advertised: string[] | null;

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const startCall = () => calls.find((call) => call.url.endsWith("/start"));

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  calls = [];
  remoteResult = { status: "pending" };
  advertised = [...GMAIL, CALENDAR, TASKS, ANALYTICS, ADWORDS];
  resetHostedOauthAvailabilityForTests();
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: true, gmailSignInUrl: issuer } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      init,
    });
    if (url === `${issuer}/api/connect/google/status`)
      return reply({ version: 1, available: true, ...(advertised ? { scopes: advertised } : {}) });
    if (url === `${issuer}/api/connect/google/start`)
      return reply({
        requestId: "remote-request",
        authorizeUrl: `${issuer}/api/connect/google/authorize?requestId=remote-request`,
        expiresAt: Date.now() + 600_000,
      });
    if (url === `${issuer}/api/connect/google/poll`) return reply(remoteResult);
    if (
      url === `${issuer}/api/google-sign-in/refresh` ||
      url === `${issuer}/api/connect/google/refresh`
    )
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

test("availability asks the service, caches its answer briefly, and reports what it offers", async () => {
  const availability = await hostedSignInAvailability("google");
  assert.equal(availability.status, "available");
  if (availability.status !== "available") return;
  assert.equal(availability.issuer, issuer);
  assert.equal(availability.offer.path, "/api/connect/google");
  assert.ok(availability.scopes.has(CALENDAR));
  const plan = await describeMailboxConnect("member@gmail.com");
  assert.equal(plan.options[0].ready, true);
  assert.equal(plan.options[0].hostedSignIn, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((await hostedSignInAvailability("github")).status, "unsupported");
  assert.equal(calls.length, 1, "no hosted adapter means no request");
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: false } });
  assert.equal((await hostedSignInAvailability("google")).status, "disabled");
  assert.equal(calls.length, 1);
});

test("each way Gmail sign-in can be unavailable tells the person what to ask for", async () => {
  const reasons: Record<string, RegExp> = {};
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: false } });
  reasons.disabled =
    /turned Genosyn Connect off.*Admin → Runtime → Hosted sign-in.*Admin → Integrations/;
  let plan = await describeMailboxConnect("member@gmail.com");
  assert.equal(plan.options[0].ready, false);
  assert.match(plan.options[0].blockedReason ?? "", reasons.disabled);

  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: true } });
  resetHostedOauthAvailabilityForTests();
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  plan = await describeMailboxConnect("member@gmail.com");
  assert.match(
    plan.options[0].blockedReason ?? "",
    /could not reach https:\/\/signin\.example.*outbound HTTPS.*Admin → Integrations/,
  );

  for (const response of [
    { version: 1, available: false },
    { version: 2, available: true },
    { version: 1, available: true, scopes: [CALENDAR] },
  ]) {
    resetHostedOauthAvailabilityForTests();
    globalThis.fetch = async () => reply(response);
    plan = await describeMailboxConnect("member@gmail.com");
    assert.equal(plan.options[0].ready, false, JSON.stringify(response));
    assert.match(
      plan.options[0].blockedReason ?? "",
      /does not offer Gmail sign-in right now.*Admin → Integrations/,
    );
  }
});

test("the catalog marks every Integration Genosyn Connect can sign in to, and only the groups it covers", async () => {
  const offers = await hostedSignInOffers(new Set(), ["google"]);
  const catalog = listCatalog({ hostedSignIn: offers });
  const hosted = Object.fromEntries(
    catalog
      .filter((entry) => entry.oauth?.hostedSignIn)
      .map((entry) => [entry.provider, entry.oauth!.hostedScopeGroups]),
  );
  assert.deepEqual(hosted, {
    google: ["mail", "calendar", "tasks"],
    "google-analytics": ["analytics"],
    "google-ads": ["ads"],
  });
  assert.equal(catalog.find((entry) => entry.provider === "google")?.oauth?.instanceApp, undefined);

  // A registered app is the installation opting out; Connect is not offered.
  await saveOauthApp("google", { clientId: "registered-id", clientSecret: "registered-secret" });
  const registered = new Set(["google"]);
  const none = listCatalog({
    registeredOauthApps: registered,
    hostedSignIn: await hostedSignInOffers(registered, ["google"]),
  });
  assert.equal(
    none.some((entry) => entry.oauth?.hostedSignIn),
    false,
  );
  assert.equal(none.find((entry) => entry.provider === "google")?.oauth?.instanceApp, true);

  // A service from before scopes were advertised offers Gmail alone.
  advertised = null;
  resetHostedOauthAvailabilityForTests();
  const legacy = listCatalog({ hostedSignIn: await hostedSignInOffers(new Set(), ["google"]) });
  assert.deepEqual(
    legacy
      .filter((entry) => entry.oauth?.hostedSignIn)
      .map((entry) => [entry.provider, entry.oauth!.hostedScopeGroups]),
    [["google", ["mail"]]],
  );
});

test("a fresh Gmail sign-in names its scopes and keeps the verifier encrypted and server-side", async () => {
  const result = await startOauth(base);
  assert.ok(result.hostedAttempt);
  const state = await readAuthFlowState<{
    codeVerifier: string;
    tokenBrokerUrl: string;
    tokenBrokerPath: string;
  }>("hosted-google-consumer", result.hostedAttempt);
  assert.ok(state);
  const started = startCall()!;
  assert.deepEqual(started.body.scopes, [...IDENTITY, ...GMAIL]);
  assert.equal(
    started.body.codeChallenge,
    crypto.createHash("sha256").update(state.payload.codeVerifier).digest("base64url"),
  );
  assert.ok(result.hostedBrowserProof);
  assert.equal(
    started.body.browserChallenge,
    crypto.createHash("sha256").update(result.hostedBrowserProof).digest("base64url"),
  );
  assert.notEqual(result.hostedBrowserProof, state.payload.codeVerifier);
  assert.equal(JSON.stringify(calls).includes(result.hostedBrowserProof), false);
  assert.equal(state.payload.tokenBrokerUrl, issuer);
  assert.equal(state.payload.tokenBrokerPath, "/api/connect/google");
  assert.equal(JSON.stringify(result).includes(state.payload.codeVerifier), false);
  assert.equal(JSON.stringify(calls).includes(state.payload.codeVerifier), false);
  const rows = await AppDataSource.getRepository(AuthFlowState).find();
  assert.equal(JSON.stringify(rows).includes(state.payload.codeVerifier), false);
  assert.equal(JSON.stringify(rows).includes(result.hostedAttempt), false);
});

test("a service from before scopes were negotiable is asked for Gmail without naming scopes", async () => {
  advertised = null;
  await startOauth(base);
  assert.equal("scopes" in startCall()!.body, false);
  assert.deepEqual(Object.keys(startCall()!.body).sort(), [
    "browserChallenge",
    "codeChallenge",
    "installationOrigin",
  ]);
  calls = [];
  await assert.rejects(
    startOauth({ ...base, scopeGroups: ["calendar"] }),
    /does not offer Calendar/,
  );
  assert.equal(startCall(), undefined);
});

test("an app of the installation's own always wins over Genosyn Connect", async () => {
  const own = await startOauth({ ...base, clientId: "own-id", clientSecret: "own-secret" });
  assert.equal(new URL(own.authorizeUrl).searchParams.get("client_id"), "own-id");
  await assert.rejects(startOauth({ ...base, clientId: "half-pair" }), /OAuth client/);
  await saveOauthApp("google", { clientId: "registered-id", clientSecret: "registered-secret" });
  const registered = await startOauth({ ...base, scopeGroups: ["mail", "drive"] });
  assert.equal(new URL(registered.authorizeUrl).searchParams.get("client_id"), "registered-id");
  assert.equal(calls.length, 0);
});

test("products the service does not offer are refused before a sign-in starts", async () => {
  await assert.rejects(
    startOauth({ ...base, scopeGroups: ["mail", "drive"] }),
    /Genosyn Connect does not offer Drive for Google.*own OAuth client/,
  );
  await assert.rejects(startOauth({ ...base, scopeGroups: [] }), /at least one product/);
  await assert.rejects(startOauth({ ...base, scopeGroups: ["unknown"] }), /at least one product/);
  assert.equal(startCall(), undefined);
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
});

test("turning hosted sign-in off leaves only the installation's own app", async () => {
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: false } });
  await assert.rejects(startOauth(base), /No Google Workspace OAuth client is available/);
  assert.equal(calls.length, 0);
});

test("wrong Member or company cannot poll or cancel another sign-in or consume its state", async () => {
  const result = await startHostedOauth(base);
  const attempt = result.hostedAttempt!;
  await assert.rejects(
    pollHostedOauth({ ...base, userId: "intruder", attempt }),
    /different Member/,
  );
  await assert.rejects(
    cancelHostedOauth({ ...base, companyId: "other-company", attempt }),
    /different Member/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), { status: "pending" });
  assert.ok(await readAuthFlowState("hosted-google-consumer", attempt));
});

test("one completed poll persists local credentials with no shared secret and cannot replay", async () => {
  const result = await startOauth(base);
  remoteResult = { status: "complete", credential: credential() };
  const attempt = result.hostedAttempt!;
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), { status: "complete" });
  const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
  assert.ok(connection);
  assert.equal(connection.accountHint, "member@gmail.com");
  const config = decryptConnectionConfig(connection);
  assert.equal(config.credentialSource, "hosted");
  assert.equal("clientSecret" in config, false);
  assert.equal(config.tokenBrokerUrl, issuer);
  assert.equal(config.tokenBrokerPath, "/api/connect/google");
  assert.equal(config.refreshToken, "google-refresh-secret");
  assert.deepEqual(config.scopeGroups, ["mail"]);
  assert.equal(connection.encryptedConfig.includes("google-refresh-secret"), false);
  const serialized = serializeConnection(connection);
  assert.equal(serialized.hostedSignIn, true);
  assert.equal(JSON.stringify(serialized).includes("google-refresh-secret"), false);
  assert.equal(JSON.stringify(serialized).includes(issuer), false);
  assert.equal((await pollHostedOauth({ ...base, attempt })).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("Calendar connects through Genosyn Connect like Gmail does", async () => {
  const result = await startOauth({ ...base, label: "Calendar", scopeGroups: ["calendar"] });
  assert.deepEqual(startCall()!.body.scopes, [...IDENTITY, CALENDAR]);
  remoteResult = {
    status: "complete",
    credential: credential([...IDENTITY, CALENDAR].join(" ")),
  };
  assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt! }), {
    status: "complete",
  });
  const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
  const config = decryptConnectionConfig(connection);
  assert.deepEqual(config.scopeGroups, ["calendar"]);
  assert.equal(config.scope, [...IDENTITY, CALENDAR].join(" "));
  assert.equal(config.credentialSource, "hosted");
  assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
});

test("other Google Integrations build their own configuration, extra fields included", async () => {
  const analytics = await startOauth({
    ...base,
    provider: "google-analytics",
    label: "Analytics",
    scopeGroups: ["analytics"],
  });
  assert.deepEqual(startCall()!.body.scopes, [...IDENTITY, ANALYTICS]);
  remoteResult = { status: "complete", credential: credential([...IDENTITY, ANALYTICS].join(" ")) };
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: analytics.hostedAttempt! })).status,
    "complete",
  );
  const saved = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
    provider: "google-analytics",
  });
  assert.equal(decryptConnectionConfig(saved).credentialSource, "hosted");

  await assert.rejects(
    startOauth({ ...base, provider: "google-ads", label: "Ads", scopeGroups: ["ads"] }),
    /Developer token is required/,
  );
  calls = [];
  const ads = await startOauth({
    ...base,
    provider: "google-ads",
    label: "Ads",
    scopeGroups: ["ads"],
    extraFields: { developerToken: " dev-token ", loginCustomerId: "123-456-7890" },
  });
  remoteResult = { status: "complete", credential: credential([...IDENTITY, ADWORDS].join(" ")) };
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: ads.hostedAttempt! })).status,
    "complete",
  );
  const adsConfig = decryptConnectionConfig(
    await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      provider: "google-ads",
    }),
  );
  assert.equal(adsConfig.developerToken, "dev-token");
  assert.equal(adsConfig.loginCustomerId, "1234567890");
  assert.equal(adsConfig.credentialSource, "hosted");
  assert.equal("clientSecret" in adsConfig, false);
});

test("a grant that leaves out what was asked for is refused, Gmail all-or-nothing", async () => {
  const cases: Array<{
    groups: string[];
    granted: Record<string, unknown>;
    detail: RegExp | null;
  }> = [
    {
      groups: ["mail"],
      granted: credential(IDENTITY.join(" ")),
      detail: /did not grant Gmail access/,
    },
    {
      groups: ["calendar"],
      granted: credential(IDENTITY.join(" ")),
      detail: /did not grant access to anything/,
    },
    {
      groups: ["mail", "calendar"],
      granted: credential([...IDENTITY, CALENDAR].join(" ")),
      detail: /did not grant Gmail access/,
    },
    {
      groups: ["calendar"],
      granted: { ...credential(), refreshToken: undefined },
      detail: /without lasting access/,
    },
    {
      groups: ["calendar"],
      granted: { ...credential(), expiresAt: Date.now() - 1 },
      detail: /expired/,
    },
    {
      groups: ["calendar", "tasks"],
      granted: credential([...IDENTITY, CALENDAR].join(" ")),
      detail: null,
    },
  ];
  for (const item of cases) {
    calls = [];
    const result = await startOauth({
      ...base,
      label: item.groups.join("+"),
      scopeGroups: item.groups,
    });
    remoteResult = { status: "complete", credential: item.granted };
    const polled = await pollHostedOauth({ ...base, attempt: result.hostedAttempt! });
    if (item.detail) {
      assert.equal(polled.status, "denied", item.groups.join(","));
      assert.match(polled.detail ?? "", item.detail);
    } else {
      assert.equal(polled.status, "complete", item.groups.join(","));
    }
  }
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("cancelling an in-flight poll prevents a late result from creating a Connection", async () => {
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
  const polling = pollHostedOauth({ ...base, attempt });
  await started;
  assert.equal((await pollHostedOauth({ ...base, attempt })).status, "pending");
  await cancelHostedOauth({ ...base, attempt });
  await cancelHostedOauth({ ...base, attempt });
  release(reply({ status: "complete", credential: credential() }));
  assert.equal((await polling).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("malformed remote completion never persists tokens and remote details never reach the Member", async () => {
  const result = await startOauth(base);
  remoteResult = { status: "complete", credential: { ...credential(), expiresAt: "wrong-type" } };
  await assert.rejects(
    pollHostedOauth({ ...base, attempt: result.hostedAttempt! }),
    (error: Error) => {
      assert.equal(error.message.includes("google-refresh-secret"), false);
      assert.match(error.message, /Genosyn Connect is unavailable/);
      return true;
    },
  );
  remoteResult = { status: "denied", detail: "secret-token-from-untrusted-broker" };
  const denied = await pollHostedOauth({ ...base, attempt: result.hostedAttempt! });
  assert.equal(denied.status, "denied");
  assert.equal(JSON.stringify(denied).includes("secret-token"), false);
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("a failed mailbox link reports failure and removes its newly created Connection", async () => {
  const result = await startOauth({ ...base, linkMailbox: true });
  remoteResult = { status: "complete", credential: credential() };
  const denied = await pollHostedOauth({ ...base, attempt: result.hostedAttempt! });
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
  assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt! }), {
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

/** `path: null` imitates a Connection issued before the protocol path was saved. */
async function hostedConnection(
  scopeGroups = ["mail"],
  path: string | null = "/api/connect/google",
) {
  const original = {
    ...credential(),
    credentialSource: "hosted",
    tokenBrokerUrl: issuer,
    ...(path ? { tokenBrokerPath: path } : {}),
    scopeGroups,
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
  return { original, connection };
}

test("hosted reconnect pins its issuer and protects an existing mailbox's identity and Connection", async () => {
  const { original, connection } = await hostedConnection();
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
    /does not offer Drive/,
  );
  await assert.rejects(
    startOauthReconnect({ ...base, connectionId: connection.id, scopeGroups: ["calendar"] }),
    /backs a mailbox/,
  );
  const result = await startOauthReconnect({ ...base, connectionId: connection.id });
  assert.ok(result.authorizeUrl.startsWith(issuer));
  assert.equal(
    calls.some((call) => call.url.startsWith("https://changed.example")),
    false,
  );
  remoteResult = {
    status: "complete",
    credential: { ...credential(), email: "different@gmail.com" },
  };
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: result.hostedAttempt! })).status,
    "denied",
  );
  const saved = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
    id: connection.id,
  });
  assert.equal(saved.encryptedConfig, connection.encryptedConfig);
  assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);
});

test("a hosted Connection can widen to other offered products on reconnect, keeping its row", async () => {
  const { connection } = await hostedConnection(["calendar"]);
  const result = await startOauthReconnect({
    ...base,
    connectionId: connection.id,
    scopeGroups: ["calendar", "tasks"],
  });
  assert.deepEqual(startCall()!.body.scopes, [...IDENTITY, CALENDAR, TASKS]);
  remoteResult = {
    status: "complete",
    credential: credential([...IDENTITY, CALENDAR, TASKS].join(" ")),
  };
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: result.hostedAttempt! })).status,
    "complete",
  );
  const rows = await AppDataSource.getRepository(IntegrationConnection).find();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, connection.id);
  assert.deepEqual(decryptConnectionConfig(rows[0]).scopeGroups, ["calendar", "tasks"]);
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

test("renewal failures say what to do without echoing the service's answer", async () => {
  const config = {
    ...credential(),
    credentialSource: "hosted" as const,
    refreshToken: "google-refresh-secret",
    expiresAt: 1,
    tokenBrokerUrl: issuer,
    tokenBrokerPath: "/api/connect/google",
  };
  for (const response of [
    () => new Response("upstream says: secret-detail", { status: 401 }),
    () => reply({ accessToken: "a", expiresAt: Date.now() - 1 }),
    () => reply({ accessToken: "", expiresAt: Date.now() + 1000 }),
  ]) {
    globalThis.fetch = async () => response();
    await assert.rejects(refreshHostedOauthToken("google", config), (error: Error) => {
      assert.equal(
        error.message,
        "Genosyn Connect could not renew this Connection's access. Try again later, or reconnect it.",
      );
      return true;
    });
  }
  await assert.rejects(
    refreshHostedOauthToken("github", { ...config, tokenBrokerPath: "/api/google-sign-in" }),
    /could not renew/,
  );
});

test("unsafe service origins and consent redirects are refused before credentials can escape", async () => {
  await assert.rejects(
    startHostedOauth({ ...base, tokenBrokerUrl: "http://remote.example" }),
    /unavailable/,
  );
  assert.equal(calls.length, 0);
  for (const authorizeUrl of [
    "https://evil.example/steal",
    `${issuer}/api/admin?requestId=id`,
    `${issuer}/api/connect/github/authorize?requestId=id`,
    `${issuer}/api/connect/google/authorize?requestId=wrong`,
    `https://user:pass@signin.example/api/connect/google/authorize?requestId=id`,
  ]) {
    resetHostedOauthAvailabilityForTests();
    globalThis.fetch = async (input) =>
      String(input).endsWith("/status")
        ? reply({ version: 1, available: true, scopes: GMAIL })
        : reply({ requestId: "id", authorizeUrl, expiresAt: Date.now() + 600_000 });
    await assert.rejects(startHostedOauth(base), /unavailable/);
  }
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

test("canonical refresh keeps its saved provider path after the service default changes", async () => {
  overrideRuntimeSettingsForTests({
    oauth: {
      hostedSignInEnabled: false,
      hostedSignInUrl: "https://changed.example",
    },
  });
  const refreshed = await refreshHostedOauthToken("google", {
    ...credential(),
    credentialSource: "hosted",
    tokenBrokerUrl: issuer,
    tokenBrokerPath: "/api/connect/google",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${issuer}/api/connect/google/refresh`);
  assert.equal(refreshed.tokenBrokerPath, "/api/connect/google");
  assert.equal(refreshed.refreshToken, "rotated-refresh");
});

test("attempts saved by an earlier release still poll their legacy path and default to Gmail", async () => {
  const attempt = await createAuthFlowState(
    "hosted-google-consumer",
    {
      companyId: base.companyId,
      userId: base.userId,
      label: base.label,
      tokenBrokerUrl: issuer,
      requestId: "old-request",
      codeVerifier: "v".repeat(43),
      linkMailbox: false,
    },
    600_000,
  );
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${issuer}/api/google-sign-in/poll`);
    return reply({ status: "complete", credential: credential() });
  };
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), { status: "complete" });
  const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
  const config = decryptConnectionConfig(connection);
  assert.equal(connection.provider, "google");
  assert.equal(config.tokenBrokerPath, "/api/google-sign-in");
  assert.deepEqual(config.scopeGroups, ["mail"]);
});

test("new installations can connect and renew against an older Google host", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), init });
    if (url === `${issuer}/api/connect/google/status`) return new Response(null, { status: 404 });
    if (url === `${issuer}/api/google-sign-in/status`)
      return reply({ version: 1, available: true });
    if (url === `${issuer}/api/google-sign-in/start`)
      return reply({
        requestId: "old-host-request",
        authorizeUrl: `${issuer}/api/google-sign-in/authorize?requestId=old-host-request`,
        expiresAt: Date.now() + 600_000,
      });
    if (url === `${issuer}/api/google-sign-in/poll`)
      return reply({ status: "complete", credential: credential() });
    if (url === `${issuer}/api/google-sign-in/refresh`)
      return reply({ accessToken: "renewed", expiresAt: Date.now() + 3_600_000 });
    throw new Error("Unexpected request");
  };
  const result = await startHostedOauth(base);
  assert.equal("scopes" in startCall()!.body, false);
  assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt! }), {
    status: "complete",
  });
  const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
  const config = decryptConnectionConfig(connection);
  assert.equal(config.tokenBrokerPath, "/api/google-sign-in");
  const context: IntegrationRuntimeContext = {
    authMode: "oauth2",
    config: { ...config, expiresAt: 1 },
  };
  await ensureFreshGoogleToken(context);
  assert.equal(context.config.accessToken, "renewed");
  assert.equal(calls.at(-1)?.url, `${issuer}/api/google-sign-in/refresh`);
});

test("reconnecting credentials without a saved protocol stays on the legacy endpoint", async () => {
  const { connection } = await hostedConnection(["mail"], null);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), init });
    if (url === `${issuer}/api/google-sign-in/status`)
      return reply({ version: 1, available: true });
    assert.equal(url, `${issuer}/api/google-sign-in/start`);
    return reply({
      requestId: "legacy-reconnect",
      authorizeUrl: `${issuer}/api/google-sign-in/authorize?requestId=legacy-reconnect`,
      expiresAt: Date.now() + 600_000,
    });
  };
  const result = await startOauthReconnect({ ...base, connectionId: connection.id });
  const attempt = await readAuthFlowState<{ tokenBrokerPath: string }>(
    "hosted-google-consumer",
    result.hostedAttempt!,
  );
  assert.equal(attempt?.payload.tokenBrokerPath, "/api/google-sign-in");
  assert.equal(
    calls.some((call) => call.url.includes("/api/connect/")),
    false,
  );
});
