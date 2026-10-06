import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { requireTrustedOrigin } from "../middleware/httpSecurity.js";
import { resetHostedOauthAvailabilityForTests, startHostedOauth } from "../services/hostedOauth.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { overrideRuntimeSettingsForTests } from "../services/runtimeSettings.js";
import { sealConnectResult } from "../test/connectResult.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { integrationsRouter } from "./integrations.js";
import { integrationsOauthRouter } from "./integrationsOauth.js";

const issuer = "https://sign-in.example";
const nativeFetch = globalThis.fetch;
let server: Server;
let origin: string;
let actingUserId: string | null;
let owner: User;
let member: User;
let company: Company;
let remoteCalls = 0;
let remoteStarts: Array<Record<string, unknown>> = [];

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  // As in the App: the return surface sits before the session and origin gate.
  app.use("/api/integrations/oauth", integrationsOauthRouter);
  app.use(requireTrustedOrigin);
  app.use(async (req, _res, next) => {
    req.session = actingUserId ? { userId: actingUserId, sessionVersion: 0 } : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/integrations", integrationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Hosted sign-in",
    slug: "hosted-sign-in",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  actingUserId = owner.id;
  remoteCalls = 0;
  resetHostedOauthAvailabilityForTests();
  remoteStarts = [];
  overrideRuntimeSettingsForTests({ oauth: { gmailSignInEnabled: true, gmailSignInUrl: issuer } });
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith(issuer)) return nativeFetch(input, init);
    if (String(input).endsWith("/status"))
      return Response.json({
        version: 2,
        available: true,
        scopes: [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.settings.basic",
        ],
      });
    remoteCalls++;
    if (String(input).endsWith("/start")) {
      remoteStarts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    }
    if (!String(input).endsWith("/start")) throw new Error(`Unexpected request: ${String(input)}`);
    return Response.json({
      requestId: "request",
      authorizeUrl: `${String(input).replace(/\/start$/, "/authorize")}?requestId=request`,
      expiresAt: Date.now() + 600_000,
    });
  };
});
after(async () => {
  globalThis.fetch = nativeFetch;
  overrideRuntimeSettingsForTests(null);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

async function post(action: "poll" | "cancel", attempt: unknown) {
  const response = await nativeFetch(
    `${origin}/api/companies/${company.id}/integrations/oauth/hosted/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt }),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function start() {
  const result = await startHostedOauth({
    companyId: company.id,
    userId: owner.id,
    provider: "google",
    label: "Gmail",
    scopeGroups: ["mail"],
  });
  remoteCalls = 0;
  resetHostedOauthAvailabilityForTests();
  return result.hostedAttempt!;
}

test("poll and cancel require a browser login and company administrator", async () => {
  const attempt = await start();
  for (const action of ["poll", "cancel"] as const) {
    actingUserId = null;
    assert.equal((await post(action, attempt)).status, 401);
    actingUserId = member.id;
    assert.equal((await post(action, attempt)).status, 403);
  }
  assert.equal(remoteCalls, 0);
});

test("even another company admin cannot redeem or cancel the initiating Member's flow", async () => {
  const attempt = await start();
  // Reuse the real Member identity and promote its existing membership.
  const { AppDataSource } = await import("../db/datasource.js");
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: member.id },
    { role: "admin" },
  );
  actingUserId = member.id;
  for (const action of ["poll", "cancel"] as const) {
    const result = await post(action, attempt);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /different Member/);
  }
  assert.equal(remoteCalls, 0);
  actingUserId = owner.id;
  assert.deepEqual((await post("poll", attempt)).body, { status: "pending" });
  assert.equal(remoteCalls, 0, "waiting never contacts the service");
});

test("attempt schema rejects malformed input and cancelling ends the attempt", async () => {
  const attempt = await start();
  assert.equal((await post("poll", { token: attempt })).status, 400);
  assert.equal((await post("cancel", "bad")).status, 400);
  assert.deepEqual((await post("cancel", attempt)).body, { ok: true });
  assert.equal((await post("poll", attempt)).body.status, "denied");
  assert.equal(remoteCalls, 0);
});

test("start and reconnect retain the verified browser Origin through a trusted proxy rewriting Host", async () => {
  const testSecurity = config.security as { trustedProxyHops: number };
  const originalProxyHops = testSecurity.trustedProxyHops;
  testSecurity.trustedProxyHops = 1;
  try {
    const browserOrigin = "https://mail.example.com";
    const headers = {
      "content-type": "application/json",
      host: "internal-app:3000",
      "x-forwarded-host": "mail.example.com",
      origin: browserOrigin,
      "sec-fetch-site": "same-origin",
    };
    const root = `${origin}/api/companies/${company.id}/integrations`;
    const start = await nativeFetch(`${root}/oauth/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "google", label: "Gmail", scopeGroups: ["mail"] }),
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get("cache-control"), "no-store");
    assert.equal(remoteStarts[0].installationOrigin, browserOrigin);
    const connection = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "google",
      label: "Gmail",
      authMode: "oauth2",
      encryptedConfig: encryptConnectionConfig(
        {
          credentialSource: "hosted",
          tokenBrokerUrl: issuer,
          scopeGroups: ["mail"],
          clientId: "shared-client",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: Date.now() + 3_600_000,
          scope: "https://www.googleapis.com/auth/gmail.modify",
          email: "owner@gmail.com",
        },
        company.id,
      ),
      accountHint: "owner@gmail.com",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    const reconnect = await nativeFetch(`${root}/connections/${connection.id}/reconnect/oauth`, {
      method: "POST",
      headers,
      body: JSON.stringify({ scopeGroups: ["mail"] }),
    });
    assert.equal(reconnect.status, 200);
    assert.equal(reconnect.headers.get("cache-control"), "no-store");
    assert.equal(remoteStarts[1].installationOrigin, browserOrigin);

    const rejected = await nativeFetch(`${root}/oauth/start`, {
      method: "POST",
      headers: { ...headers, origin: "https://attacker.example" },
      body: JSON.stringify({ provider: "google", label: "Gmail", scopeGroups: ["mail"] }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(remoteStarts.length, 2, "CSRF rejection must happen before contacting the broker");
  } finally {
    testSecurity.trustedProxyHops = originalProxyHops;
  }
});

async function returnPost(body: unknown, headers: Record<string, string> = {}) {
  const response = await nativeFetch(`${origin}/api/integrations/oauth/hosted/return`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function sealedReturn(started: Record<string, unknown>) {
  return {
    state: String(started.state),
    result: sealConnectResult({
      resultKey: String(started.resultKey),
      state: String(started.state),
      value: {
        clientId: "shared-client",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
        scope: [
          "openid",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.settings.basic",
        ].join(" "),
        email: "owner@gmail.com",
        account: "owner@gmail.com",
      },
    }),
  };
}

test("the return page reads the fragment in the browser, behind a strict policy", async () => {
  const page = await nativeFetch(`${origin}/api/integrations/oauth/hosted/return`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const scriptNonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(scriptNonce);
  const html = await page.text();
  assert.ok(html.includes(`<script nonce="${scriptNonce}">`));
  assert.match(html, /history\.replaceState\(null,"",window\.location\.pathname\)/);
  assert.match(html, /credentials:"same-origin"/);
  assert.doesNotMatch(html, /innerHTML/);
});

test("the return page's post finishes the sign-in without a session, once", async () => {
  await start();
  const started = remoteStarts[0];
  const installation = String(started.installationOrigin);
  actingUserId = null;
  const finished = await returnPost(sealedReturn(started), { origin: installation });
  assert.equal(finished.status, 200);
  assert.deepEqual(finished.body, { status: "complete" });
  const replay = await returnPost(sealedReturn(started), { origin: installation });
  assert.deepEqual(replay.body, {
    status: "denied",
    detail: "This sign-in expired or was already used. Start again.",
  });
  actingUserId = owner.id;
  assert.deepEqual((await post("poll", started.state)).body, { status: "complete" });
  const { AppDataSource } = await import("../db/datasource.js");
  assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 1);
});

test("a return from anywhere but the installation's own page is refused untouched", async () => {
  await start();
  const started = remoteStarts[0];
  const installation = String(started.installationOrigin);
  const refusals: Array<Record<string, string>> = [
    { origin: "https://attacker.example" },
    {},
    { origin: installation, "sec-fetch-site": "cross-site" },
  ];
  for (const headers of refusals) {
    const refused = await returnPost(sealedReturn(started), headers);
    assert.equal(refused.status, 403, JSON.stringify(headers));
  }
  for (const body of [
    { state: started.state },
    { state: "short", error: "access_denied" },
    { state: started.state, error: "Not A Code" },
    { state: started.state, result: "r", error: "access_denied" },
    { ...sealedReturn(started), extra: true },
  ]) {
    assert.equal((await returnPost(body, { origin: installation })).status, 400);
  }
  // The genuine page still finishes it afterwards.
  const genuine = await returnPost(sealedReturn(started), { origin: installation });
  assert.deepEqual(genuine.body, { status: "complete" });
});

test("a cancelled sign-in reported by the service ends with this installation's words", async () => {
  await start();
  const started = remoteStarts[0];
  const cancelled = await returnPost(
    { state: started.state, error: "access_denied" },
    { origin: String(started.installationOrigin) },
  );
  assert.deepEqual(cancelled.body, {
    status: "denied",
    detail: "Google sign-in was cancelled. Start again when ready.",
  });
  assert.deepEqual((await post("poll", started.state)).body, cancelled.body);
});
