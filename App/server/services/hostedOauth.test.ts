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
import { sealConnectResult } from "../test/connectResult.js";
import { createAuthFlowState, readAuthFlowState } from "./authFlowState.js";
import {
  cancelHostedOauth,
  completeHostedReturn,
  HostedReturnOriginError,
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
/** What the fake Genosyn Connect advertises. */
let advertised: string[];

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const starts = () => calls.filter((call) => call.url.endsWith("/start"));
const startCall = () => starts().at(-1);

/**
 * The browser arriving back from Genosyn Connect at this installation's
 * return page, which posts the fragment to the server. By default it carries
 * a result sealed the way the service seals it, for the latest sign-in.
 */
async function returnWith(
  outcome: { credential: unknown } | { error: string },
  started: Record<string, unknown> = startCall()!.body,
) {
  return completeHostedReturn({
    state: String(started.state),
    ...("credential" in outcome
      ? {
          result: sealConnectResult({
            resultKey: String(started.resultKey),
            state: String(started.state),
            value: outcome.credential,
          }),
        }
      : { error: outcome.error }),
    origin: String(started.installationOrigin),
  });
}

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  calls = [];
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
      return reply({ version: 2, available: true, scopes: advertised });
    if (url === `${issuer}/api/connect/google/start`)
      return reply({
        requestId: "v1.sealed-request",
        authorizeUrl: `${issuer}/api/connect/google/authorize?requestId=v1.sealed-request`,
        expiresAt: Date.now() + 600_000,
      });
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
    // A service still on protocol 1 could not finish a sign-in started here.
    { version: 1, available: true, scopes: GMAIL },
    { version: 1, available: true },
    { version: 2, available: false, scopes: [] },
    { version: 2, available: true },
    { version: 2, available: true, scopes: [CALENDAR] },
    { version: 3, available: true, scopes: GMAIL },
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

  // A service still on protocol 1 offers nothing an installation could finish.
  resetHostedOauthAvailabilityForTests();
  globalThis.fetch = async () => reply({ version: 1, available: true, scopes: GMAIL });
  const older = listCatalog({ hostedSignIn: await hostedSignInOffers(new Set(), ["google"]) });
  assert.equal(
    older.some((entry) => entry.oauth?.hostedSignIn),
    false,
  );
});

test("a fresh Gmail sign-in sends a one-time key and its own return page, and keeps the key server-side", async () => {
  const result = await startOauth(base);
  assert.ok(result.hostedAttempt);
  assert.ok(result.hostedBrowserProof);
  const started = startCall()!.body;
  assert.deepEqual(Object.keys(started).sort(), [
    "browserChallenge",
    "installationOrigin",
    "resultKey",
    "returnUrl",
    "scopes",
    "state",
  ]);
  assert.deepEqual(started.scopes, [...IDENTITY, ...GMAIL]);
  assert.equal(started.state, result.hostedAttempt, "the service echoes the attempt back");
  assert.equal(
    started.returnUrl,
    `${String(started.installationOrigin)}/api/integrations/oauth/hosted/return`,
  );
  assert.equal(
    started.browserChallenge,
    crypto.createHash("sha256").update(result.hostedBrowserProof).digest("base64url"),
  );
  assert.match(String(started.resultKey), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result).includes(String(started.resultKey)), false);
  assert.equal(JSON.stringify(calls).includes(result.hostedBrowserProof), false);

  const state = await readAuthFlowState<{
    resultKey: string;
    tokenBrokerUrl: string;
    tokenBrokerPath: string;
    installationOrigin: string;
  }>("hosted-oauth-attempt", result.hostedAttempt);
  assert.ok(state);
  assert.equal(state.payload.resultKey, started.resultKey);
  assert.equal(state.payload.installationOrigin, started.installationOrigin);
  assert.equal(state.payload.tokenBrokerUrl, issuer);
  assert.equal(state.payload.tokenBrokerPath, "/api/connect/google");
  const rows = await AppDataSource.getRepository(AuthFlowState).find();
  assert.equal(JSON.stringify(rows).includes(String(started.resultKey)), false);
  assert.equal(JSON.stringify(rows).includes(result.hostedAttempt), false);

  // Waiting for the browser never contacts the service.
  calls = [];
  assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt }), {
    status: "pending",
  });
  assert.equal(calls.length, 0);
});

test("a service still on protocol 1 is never asked to start a sign-in", async () => {
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: {}, init });
    return String(input).endsWith("/status")
      ? reply({ version: 1, available: true, scopes: GMAIL })
      : reply({ requestId: "r", authorizeUrl: `${issuer}/x`, expiresAt: Date.now() + 1 });
  };
  await assert.rejects(startOauth(base), /Genosyn Connect is unavailable/);
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${issuer}/api/connect/google/status`],
  );
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
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
  assert.ok(await readAuthFlowState("hosted-oauth-attempt", attempt));
});

test("a returned sign-in saves local credentials with no shared secret, reports once, and cannot replay", async () => {
  const result = await startOauth(base);
  const attempt = result.hostedAttempt!;
  const started = startCall()!.body;
  assert.deepEqual(await returnWith({ credential: credential() }), { status: "complete" });
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

  // The same fragment again, before and after the opener hears the outcome.
  assert.deepEqual(await returnWith({ credential: credential() }, started), {
    status: "denied",
    detail: "This sign-in expired or was already used. Start again.",
  });
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), { status: "complete" });
  assert.equal((await pollHostedOauth({ ...base, attempt })).status, "denied");
  assert.equal((await returnWith({ credential: credential() }, started)).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("Calendar connects through Genosyn Connect like Gmail does", async () => {
  const result = await startOauth({ ...base, label: "Calendar", scopeGroups: ["calendar"] });
  assert.deepEqual(startCall()!.body.scopes, [...IDENTITY, CALENDAR]);
  assert.deepEqual(
    await returnWith({ credential: credential([...IDENTITY, CALENDAR].join(" ")) }),
    { status: "complete" },
  );
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
  assert.equal(
    (await returnWith({ credential: credential([...IDENTITY, ANALYTICS].join(" ")) })).status,
    "complete",
  );
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
  assert.equal(
    (await returnWith({ credential: credential([...IDENTITY, ADWORDS].join(" ")) })).status,
    "complete",
  );
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
    const returned = await returnWith({ credential: item.granted });
    const polled = await pollHostedOauth({ ...base, attempt: result.hostedAttempt! });
    assert.deepEqual(polled, returned, "the opener hears what the return page heard");
    if (item.detail) {
      assert.equal(polled.status, "denied", item.groups.join(","));
      assert.match(polled.detail ?? "", item.detail);
    } else {
      assert.equal(polled.status, "complete", item.groups.join(","));
    }
  }
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("a sign-in the Member cancelled cannot be finished by a late return", async () => {
  const result = await startOauth(base);
  const attempt = result.hostedAttempt!;
  await cancelHostedOauth({ ...base, attempt });
  await cancelHostedOauth({ ...base, attempt });
  assert.equal((await returnWith({ credential: credential() })).status, "denied");
  assert.equal((await pollHostedOauth({ ...base, attempt })).status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("only the page that started a sign-in, holding its result, can finish it", async () => {
  const first = await startOauth(base);
  const firstStart = startCall()!.body;
  const second = await startOauth({ ...base, label: "Second" });
  const secondStart = startCall()!.body;
  const sealed = sealConnectResult({
    resultKey: String(firstStart.resultKey),
    state: String(firstStart.state),
    value: credential(),
  });
  for (const origin of [
    "https://evil.example",
    undefined,
    `${String(firstStart.installationOrigin)}/`,
  ]) {
    await assert.rejects(
      completeHostedReturn({ state: String(firstStart.state), result: sealed, origin }),
      HostedReturnOriginError,
    );
  }
  // Those changed nothing: the genuine page still finishes it.
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: first.hostedAttempt! })).status,
    "pending",
  );

  // A result for one sign-in does not open another, nor does one sealed to another key.
  const crossed = await completeHostedReturn({
    state: String(secondStart.state),
    result: sealed,
    origin: String(secondStart.installationOrigin),
  });
  assert.deepEqual(crossed, {
    status: "denied",
    detail: "Google sign-in could not be verified. Start again.",
  });
  assert.deepEqual(await pollHostedOauth({ ...base, attempt: second.hostedAttempt! }), crossed);
  const forged = sealConnectResult({
    resultKey: crypto.randomBytes(32).toString("base64url"),
    state: String(firstStart.state),
    value: credential(),
  });
  const wrongKey = await completeHostedReturn({
    state: String(firstStart.state),
    result: forged,
    origin: String(firstStart.installationOrigin),
  });
  assert.equal(wrongKey.status, "denied");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("a result that is not a usable credential never persists tokens or echoes what arrived", async () => {
  for (const value of [
    { ...credential(), expiresAt: "wrong-type" },
    { ...credential(), clientId: "" },
    "secret-token-from-untrusted-service",
    null,
  ]) {
    const result = await startOauth(base);
    const outcome = await returnWith({ credential: value });
    assert.deepEqual(outcome, {
      status: "denied",
      detail: "Google sign-in could not be verified. Start again.",
    });
    assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt! }), outcome);
  }
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("why the service ended a sign-in is told in this installation's own words", async () => {
  const cases: Array<[string, RegExp]> = [
    ["access_denied", /^Google sign-in was cancelled\. Start again when ready\.$/],
    ["account_unverified", /did not confirm a verified email address.*another account/],
    ["offline_access_missing", /did not grant lasting access/],
    ["registration_changed", /sign-in settings changed while you were signing in/],
    ["exchange_failed", /^Google sign-in could not be completed\. Start again\.$/],
    ["something_new", /^Google sign-in could not be completed\. Start again\.$/],
  ];
  for (const [code, detail] of cases) {
    const result = await startOauth(base);
    const outcome = await returnWith({ error: code });
    assert.equal(outcome.status, "denied", code);
    assert.match(outcome.detail ?? "", detail, code);
    assert.deepEqual(await pollHostedOauth({ ...base, attempt: result.hostedAttempt! }), outcome);
  }
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("a return whose completion was interrupted is abandoned, never guessed at", async () => {
  const result = await startOauth(base);
  const attempt = result.hostedAttempt!;
  const snapshot = await readAuthFlowState<Record<string, unknown>>(
    "hosted-oauth-attempt",
    attempt,
  );
  const { compareAndSetAuthFlowState } = await import("./authFlowState.js");
  // A process claimed the return, then stopped before recording an outcome.
  assert.ok(
    await compareAndSetAuthFlowState("hosted-oauth-attempt", attempt, snapshot!, {
      ...snapshot!.payload,
      returnedAt: Date.now() - 3 * 60_000,
    }),
  );
  assert.equal((await returnWith({ credential: credential() })).status, "denied");
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), {
    status: "denied",
    detail: "This sign-in expired or was already used. Start again.",
  });
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);

  // While one is still being completed, the opener keeps waiting.
  const fresh = await startOauth(base);
  const current = await readAuthFlowState<Record<string, unknown>>(
    "hosted-oauth-attempt",
    fresh.hostedAttempt!,
  );
  await compareAndSetAuthFlowState("hosted-oauth-attempt", fresh.hostedAttempt!, current!, {
    ...current!.payload,
    returnedAt: Date.now(),
  });
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: fresh.hostedAttempt! })).status,
    "pending",
  );
});

test("a failed mailbox link reports failure and removes its newly created Connection", async () => {
  const result = await startOauth({ ...base, linkMailbox: true });
  assert.equal((await returnWith({ credential: credential() })).status, "denied");
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
  assert.deepEqual(await returnWith({ credential: credential() }), { status: "complete" });
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
  assert.equal(
    (await returnWith({ credential: { ...credential(), email: "different@gmail.com" } })).status,
    "denied",
  );
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
  assert.equal(
    (await returnWith({ credential: credential([...IDENTITY, CALENDAR, TASKS].join(" ")) })).status,
    "complete",
  );
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
        ? reply({ version: 2, available: true, scopes: GMAIL })
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

test("a sign-in left open across the upgrade asks the Member to start again", async () => {
  // What a release on protocol 1 saved: it waited to poll the service.
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
  assert.deepEqual(await pollHostedOauth({ ...base, attempt }), {
    status: "denied",
    detail: "This sign-in expired or was already used. Start again.",
  });
  await cancelHostedOauth({ ...base, attempt });
  assert.equal(calls.length, 0);
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
});

test("an older service starts nothing new here, but its Connections keep renewing", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), init });
    if (url === `${issuer}/api/connect/google/status`) return new Response(null, { status: 404 });
    if (url === `${issuer}/api/google-sign-in/refresh`)
      return reply({ accessToken: "renewed", expiresAt: Date.now() + 3_600_000 });
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(startHostedOauth(base), /unavailable/);
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${issuer}/api/connect/google/status`],
    "no fallback to the Gmail-only path",
  );
  const { original } = await hostedConnection(["mail"], null);
  const context: IntegrationRuntimeContext = {
    authMode: "oauth2",
    config: { ...original, expiresAt: 1 },
  };
  await ensureFreshGoogleToken(context);
  assert.equal(context.config.accessToken, "renewed");
  assert.equal(calls.at(-1)?.url, `${issuer}/api/google-sign-in/refresh`);
});

test("reconnecting a Connection from the Gmail-only path signs in on the service's current path", async () => {
  const { connection } = await hostedConnection(["mail"], null);
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInUrl: "https://changed.example" } });
  const result = await startOauthReconnect({ ...base, connectionId: connection.id });
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${issuer}/api/connect/google/status`, `${issuer}/api/connect/google/start`],
  );
  assert.equal((await returnWith({ credential: credential() })).status, "complete");
  assert.equal(
    (await pollHostedOauth({ ...base, attempt: result.hostedAttempt! })).status,
    "complete",
  );
  const saved = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
    id: connection.id,
  });
  const config = decryptConnectionConfig(saved);
  assert.equal(config.tokenBrokerUrl, issuer);
  assert.equal(config.tokenBrokerPath, "/api/connect/google");
});
