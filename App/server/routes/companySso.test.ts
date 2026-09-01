import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { companySsoRouter } from "./companySso.js";

/**
 * The Settings → Single sign-on endpoints over real HTTP: the admin role
 * gate, the Scale-plan feature gate on enabling, blank-keeps-stored secrets,
 * and the reset. The sign-in flow itself is covered in
 * `services/companySso.test.ts`.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let admin: User;
let member: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", companySsoRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function withRole(email: string, role: Role): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  const founder = await insert(User, {
    email: "f@example.com",
    name: "F",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  admin = await withRole("admin@example.com", "admin" as Role);
  member = await withRole("member@example.com", "member" as Role);
  actingUserId = admin.id;
  // A Genosyn Cloud install: instance billing on. The company starts on Free.
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
});

async function putOnScale(): Promise<void> {
  await insert(CompanyBilling, { companyId: company.id, plan: "scale", status: "active" });
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const draft = {
  enabled: false,
  provider: "google",
  displayName: "",
  issuer: "",
  clientId: "client-id",
  clientSecret: "client-secret",
  autoJoin: true,
  allowedEmailDomains: "",
};

describe("GET /sso", () => {
  test("returns the disabled default with both URLs", async () => {
    const got = await call("GET", "/sso");
    assert.equal(got.status, 200);
    assert.equal(got.body.enabled, false);
    assert.equal(got.body.provider, "google");
    assert.equal(got.body.hasClientSecret, false);
    assert.equal(got.body.configured, false);
    assert.equal(got.body.autoJoin, true);
    assert.equal(got.body.allowedEmailDomains, "");
    assert.match(String(got.body.callbackUrl), /\/api\/auth\/sso\/company\/callback$/);
    assert.match(String(got.body.loginUrl), /\/login\/sso\/acme$/);
  });

  test("requires the admin company role", async () => {
    actingUserId = member.id;
    const got = await call("GET", "/sso");
    assert.equal(got.status, 403);
  });

  test("requires membership", async () => {
    const outsider = await insert(User, {
      email: "out@example.com",
      name: "Out",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    const got = await call("GET", "/sso");
    assert.equal(got.status, 403);
  });
});

describe("PUT /sso", () => {
  test("refuses enabling without the sso feature (402), phrased for the cloud edition", async () => {
    const got = await call("PUT", "/sso", { ...draft, enabled: true });
    assert.equal(got.status, 402);
    assert.deepEqual(got.body, { error: "SSO is available on the Scale plan." });
  });

  test("saving a disabled draft is never plan-gated", async () => {
    const got = await call("PUT", "/sso", draft);
    assert.equal(got.status, 200);
    assert.equal(got.body.enabled, false);
    assert.equal(got.body.hasClientSecret, true);
    assert.equal(got.body.configured, true);
  });

  test("enables on the Scale plan, and a blank secret keeps the stored one", async () => {
    await putOnScale();
    const enabled = await call("PUT", "/sso", {
      ...draft,
      enabled: true,
      allowedEmailDomains: "acme.com",
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);
    assert.equal(enabled.body.hasClientSecret, true);
    assert.equal(enabled.body.allowedEmailDomains, "acme.com");

    const kept = await call("PUT", "/sso", {
      ...draft,
      enabled: true,
      displayName: "Acme SSO",
      clientSecret: "",
      allowedEmailDomains: "acme.com",
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.displayName, "Acme SSO");
    assert.equal(kept.body.hasClientSecret, true, "blank secret keeps the stored one");
  });

  test("refuses enabling the Google preset with auto-join and no allowed domains", async () => {
    await putOnScale();
    const got = await call("PUT", "/sso", { ...draft, enabled: true });
    assert.equal(got.status, 400);
    assert.equal(
      got.body.error,
      "Google SSO signs in any Google account. List the email domains that belong to your company before enabling auto-join.",
    );
  });

  test("normalizes the domain list and refuses an invalid domain", async () => {
    await putOnScale();
    const saved = await call("PUT", "/sso", {
      ...draft,
      enabled: true,
      allowedEmailDomains: " Acme.COM , acme.com, other.io ",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.allowedEmailDomains, "acme.com,other.io");

    const bad = await call("PUT", "/sso", { ...draft, allowedEmailDomains: "not-a-domain" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /is not a valid email domain/);
  });

  test("refuses enabling while unconfigured even on Scale", async () => {
    await putOnScale();
    const got = await call("PUT", "/sso", { ...draft, enabled: true, clientSecret: "", clientId: "" });
    assert.equal(got.status, 400);
    assert.match(String(got.body.error), /client ID and client secret/);
  });

  test("is admin-gated", async () => {
    actingUserId = member.id;
    const got = await call("PUT", "/sso", draft);
    assert.equal(got.status, 403);
  });
});

describe("DELETE /sso", () => {
  test("clears the stored configuration", async () => {
    await putOnScale();
    await call("PUT", "/sso", { ...draft, enabled: true, allowedEmailDomains: "acme.com" });
    const got = await call("DELETE", "/sso");
    assert.equal(got.status, 200);
    assert.equal(got.body.enabled, false);
    assert.equal(got.body.hasClientSecret, false);
    assert.equal(got.body.configured, false);
  });
});
