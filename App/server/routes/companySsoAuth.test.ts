import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import bcrypt from "bcrypt";
import express, { type Request } from "express";

import { config } from "../../config.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { createAuthFlowState } from "../services/authFlowState.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import { COMPANY_SSO_LINK_STATE_KIND, updateCompanySso } from "../services/companySso.js";
import { setCompanySsoAllowed } from "../services/ssoSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { companySsoAuthRouter } from "./companySsoAuth.js";

/**
 * The company-SSO link confirmation over HTTP: the confirm page learns only
 * the company's name, and wrong passwords draw on the same per-account bucket
 * as the login form, so fresh tokens from a company IdP cannot buy extra
 * guesses against one person.
 */

type MutableRateLimit = { windowMinutes: number; maxAttempts: number; blockMinutes: number };
const rateLimit = config.security.authRateLimit as unknown as MutableRateLimit;
const originalRateLimit = { ...rateLimit };

let server: Server;
let baseUrl: string;
let company: Company;
let member: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
    next();
  });
  app.use("/api/auth/sso/company", companySsoAuthRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(rateLimit, originalRateLimit);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  Object.assign(rateLimit, { ...originalRateLimit, maxAttempts: 2 });
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await setCompanySsoAllowed(true);
  await updateCompanySso(company.id, company.slug, {
    enabled: true,
    provider: "oidc",
    displayName: "Acme SSO",
    issuer: "https://idp.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: true,
    allowedEmailDomains: "",
  });
});

async function mintLinkToken(): Promise<string> {
  return createAuthFlowState(
    COMPANY_SSO_LINK_STATE_KIND,
    { userId: member.id, companyId: company.id, issuer: "https://idp.test", subject: "sub" },
    10 * 60 * 1000,
  );
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("describe names the company and never the account's email", async () => {
  const token = await mintLinkToken();
  const described = await post("/api/auth/sso/company/link/describe", { token });
  assert.equal(described.status, 200);
  assert.deepEqual(described.body, {
    companyName: "Acme",
    companySlug: "acme",
    issuerHost: "idp.test",
  });

  const unknown = await post("/api/auth/sso/company/link/describe", { token: "not-a-token" });
  assert.equal(unknown.status, 400);
});

test("a company sign-in cannot be started from another site", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const response = await fetch(`${baseUrl}/api/auth/sso/company/acme/start`, {
      headers: { "sec-fetch-site": site },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.match(
      decodeURIComponent(response.headers.get("location") ?? ""),
      /Start SSO sign-in from your company's sign-in page/,
    );
  }
  // This site's own page (or a typed address) gets past the guard — here to
  // the ordinary "not available" answer, with company SSO switched off so no
  // identity provider is contacted.
  await setCompanySsoAllowed(false);
  const own = await fetch(`${baseUrl}/api/auth/sso/company/acme/start`, {
    headers: { "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
  assert.equal(own.status, 302);
  assert.match(decodeURIComponent(own.headers.get("location") ?? ""), /not available/);
});

/** A request from another address, for reading or filling the login buckets
 *  the way the password form would from elsewhere. */
function elsewhere(): Request {
  return { ip: "203.0.113.9", socket: {} } as unknown as Request;
}

test("wrong link passwords count against the account's password-login lockout", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wrong = await post("/api/auth/sso/company/link", {
      token: await mintLinkToken(),
      password: "guess",
    });
    assert.equal(wrong.status, 401);
  }

  // The login form, from a different address, is now locked for this person.
  await assert.rejects(
    assertAuthAllowed(authThrottleKeys(elsewhere(), "login", "Member@Example.com")),
    AuthRateLimitError,
  );
});

test("an account locked at the login form cannot be guessed through a fresh link token", async () => {
  const loginKeys = authThrottleKeys(elsewhere(), "login", "member@example.com");
  await recordAuthFailure(loginKeys);
  await recordAuthFailure(loginKeys);

  // A fresh token — as a company IdP could mint on demand — is still refused.
  const blocked = await post("/api/auth/sso/company/link", {
    token: await mintLinkToken(),
    password: "correct-pw",
  });
  assert.equal(blocked.status, 429);
});
