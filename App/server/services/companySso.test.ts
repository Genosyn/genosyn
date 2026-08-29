import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import bcrypt from "bcrypt";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { BILLING_SETTING_KEY, invalidateBillingSettingsCache } from "./billing/billingSettings.js";
import { invalidateLicenseCache } from "./license.js";
import {
  confirmCompanySsoLink,
  finishCompanySsoLogin,
  getCompanySsoPublicStatus,
  startCompanySsoLogin,
  updateCompanySso,
  type CompanySsoInput,
} from "./companySso.js";
import { SsoLoginError } from "./ssoLogin.js";

/**
 * Per-company SSO (M56 Phase B) against a stubbed identity provider — the
 * eligibility matrix, and above all the account-resolution rules: sign-in
 * matches on the exact issuer+subject pair; an email-only match must never
 * be linked without proving the account's password.
 */

type MutableSecurity = { outboundPrivateHostAllowlist: string[] };
const mutableSecurity = config.security as unknown as MutableSecurity;
const originalAllowlist = [...mutableSecurity.outboundPrivateHostAllowlist];
const originalFetch = globalThis.fetch;

let claimSubject = "stable-subject";
let claimEmail = "member@example.com";
let company: Company;

before(async () => {
  await initTestDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  mutableSecurity.outboundPrivateHostAllowlist = originalAllowlist;
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  mutableSecurity.outboundPrivateHostAllowlist = ["idp.test"];
  claimSubject = "stable-subject";
  claimEmail = "member@example.com";
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url === "https://idp.test/.well-known/openid-configuration") {
      return Response.json({
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        userinfo_endpoint: "https://idp.test/userinfo",
      });
    }
    if (url === "https://idp.test/token") {
      void init;
      return Response.json({ access_token: "access-token" });
    }
    if (url === "https://idp.test/userinfo") {
      return Response.json({
        sub: claimSubject,
        email: claimEmail,
        email_verified: true,
        name: "SSO Member",
      });
    }
    throw new Error(`Unexpected fetch in company SSO test: ${url}`);
  };
  // Company SSO exists only on a billing-enabled (Genosyn Cloud) install.
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthPriceId: "price_growth",
      scalePriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function putOnScale(): Promise<void> {
  await insert(CompanyBilling, { companyId: company.id, plan: "scale", status: "active" });
}

async function configureSso(overrides: Partial<CompanySsoInput> = {}): Promise<void> {
  await updateCompanySso(company.id, company.slug, {
    enabled: true,
    provider: "oidc",
    displayName: "Acme SSO",
    issuer: "https://idp.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: true,
    allowedEmailDomains: "",
    ...overrides,
  });
}

async function ssoRoundTrip() {
  const started = await startCompanySsoLogin(company.slug);
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  assert.ok(state);
  return finishCompanySsoLogin({
    code: "authorization-code",
    state,
    browserBinding: started.browserBinding,
  });
}

async function membershipOf(userId: string): Promise<Membership | null> {
  return AppDataSource.getRepository(Membership).findOneBy({ companyId: company.id, userId });
}

// ───────────────────────── eligibility matrix ───────────────────────────────

test("public status is enabled only for a configured, enabled row on a plan with the sso feature", async () => {
  // Unknown slug leaks nothing.
  assert.deepEqual(await getCompanySsoPublicStatus("nope"), {
    enabled: false,
    buttonLabel: null,
  });

  // Configured but on the Free plan (no billing row) — dark.
  await configureSso();
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: false,
    buttonLabel: null,
  });
  await assert.rejects(startCompanySsoLogin(company.slug), SsoLoginError);

  // Scale plan but the row is disabled — dark.
  await putOnScale();
  await configureSso({ enabled: false });
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: false,
    buttonLabel: null,
  });

  // Scale plan + enabled + configured — live, with the company's label.
  await configureSso();
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: true,
    buttonLabel: "Acme SSO",
  });
});

// ───────────────────── allowed email domains — saving ───────────────────────

test("enabling the Google preset with auto-join and no domain list is refused", async () => {
  await putOnScale();
  await assert.rejects(
    configureSso({ provider: "google", issuer: "", autoJoin: true, allowedEmailDomains: "" }),
    /Google SSO signs in any Google account\. List the email domains that belong to your company before enabling auto-join\./,
  );
});

test("the Google preset is allowed with a domain list, or with auto-join off", async () => {
  await putOnScale();
  const withDomains = await updateCompanySso(company.id, company.slug, {
    enabled: true,
    provider: "google",
    displayName: "",
    issuer: "",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: true,
    allowedEmailDomains: "acme.com",
  });
  assert.equal(withDomains.enabled, true);
  assert.equal(withDomains.allowedEmailDomains, "acme.com");

  const noAutoJoin = await updateCompanySso(company.id, company.slug, {
    enabled: true,
    provider: "google",
    displayName: "",
    issuer: "",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: false,
    allowedEmailDomains: "",
  });
  assert.equal(noAutoJoin.enabled, true);
});

test("a disabled Google draft with auto-join and no domains still saves", async () => {
  const saved = await updateCompanySso(company.id, company.slug, {
    enabled: false,
    provider: "google",
    displayName: "",
    issuer: "",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: true,
    allowedEmailDomains: "",
  });
  assert.equal(saved.enabled, false);
});

test("a custom oidc issuer stays allowed with auto-join and no domain list", async () => {
  await putOnScale();
  await configureSso({ autoJoin: true, allowedEmailDomains: "" });
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: true,
    buttonLabel: "Acme SSO",
  });
});

test("domains are lowercased, trimmed, and deduped on save", async () => {
  await putOnScale();
  const saved = await updateCompanySso(company.id, company.slug, {
    enabled: true,
    provider: "oidc",
    displayName: "",
    issuer: "https://idp.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoJoin: true,
    allowedEmailDomains: " Acme.COM ,, acme.com , other.io ",
  });
  assert.equal(saved.allowedEmailDomains, "acme.com,other.io");
});

test("an invalid domain is refused on save", async () => {
  await putOnScale();
  for (const bad of ["acme", "not a domain.com", "acme_corp.com", "@acme.com"]) {
    await assert.rejects(
      configureSso({ allowedEmailDomains: bad }),
      /is not a valid email domain/,
      `expected "${bad}" to be refused`,
    );
  }
});

// ───────────────────────── resolution rules ─────────────────────────────────

test("an exact issuer+subject pair match signs in, and auto-join creates the Membership", async () => {
  await putOnScale();
  await configureSso();
  const paired = await insert(User, {
    email: "member@example.com",
    name: "Paired",
    passwordHash: "x",
    sessionVersion: 0,
    ssoIssuer: "https://idp.test",
    ssoSubject: "stable-subject",
    emailVerifiedAt: new Date(),
  });

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "signed-in");
  assert.ok(result.kind === "signed-in");
  assert.equal(result.user.id, paired.id);
  assert.equal(await AppDataSource.getRepository(User).count(), 2);
  const membership = await membershipOf(paired.id);
  assert.ok(membership, "auto-join created a Membership");
  assert.equal(membership.role, "member");
});

test("a pair-matched non-member is refused when auto-join is off", async () => {
  await putOnScale();
  await configureSso({ autoJoin: false });
  await insert(User, {
    email: "member@example.com",
    name: "Paired",
    passwordHash: "x",
    sessionVersion: 0,
    ssoIssuer: "https://idp.test",
    ssoSubject: "stable-subject",
    emailVerifiedAt: new Date(),
  });

  await assert.rejects(ssoRoundTrip(), /not a member of this company/);
});

test("an unknown email is auto-provisioned and joined when auto-join is on", async () => {
  await putOnScale();
  await configureSso();

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "signed-in");
  assert.ok(result.kind === "signed-in");
  const user = result.user;
  assert.equal(user.email, "member@example.com");
  assert.equal(user.ssoIssuer, "https://idp.test");
  assert.equal(user.ssoSubject, "stable-subject");
  assert.ok(user.emailVerifiedAt);
  assert.ok(await membershipOf(user.id));
});

test("an unknown email is refused when auto-join is off, and nothing is created", async () => {
  await putOnScale();
  await configureSso({ autoJoin: false });

  await assert.rejects(ssoRoundTrip(), /not a member of this company/);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
});

test("an email-only match is never linked silently — it returns the link step and binds nothing", async () => {
  await putOnScale();
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "link-required");
  assert.ok(result.kind === "link-required");
  assert.ok(result.token);

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, null, "callback must not bind the issuer");
  assert.equal(reloaded.ssoSubject, null, "callback must not bind the subject");
  assert.equal(await membershipOf(existing.id), null, "callback must not join the company");
});

test("an account bound to a DIFFERENT pair also goes through the confirm step before rebinding", async () => {
  await putOnScale();
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    ssoIssuer: "https://old-idp.example",
    ssoSubject: "old-subject",
    emailVerifiedAt: new Date(),
  });

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "link-required");

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, "https://old-idp.example");
  assert.equal(reloaded.ssoSubject, "old-subject");
});

test("link confirmation with the wrong password fails, binds nothing, and burns the token", async () => {
  await putOnScale();
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");

  const outcome = await confirmCompanySsoLink({ token: result.token, password: "wrong-pw" });
  assert.deepEqual(outcome, { status: "invalid-password" });

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, null);
  assert.equal(reloaded.ssoSubject, null);
  assert.equal(await membershipOf(existing.id), null);

  // Single-use: the burned token cannot be retried with the right password.
  await assert.rejects(
    confirmCompanySsoLink({ token: result.token, password: "correct-pw" }),
    /expired or was already used/,
  );
});

test("link confirmation with the right password binds the pair and joins the company", async () => {
  await putOnScale();
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");

  const outcome = await confirmCompanySsoLink({ token: result.token, password: "correct-pw" });
  assert.equal(outcome.status, "linked");
  assert.ok(outcome.status === "linked");
  assert.equal(outcome.user.id, existing.id);
  assert.equal(outcome.companyId, company.id);

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, "https://idp.test");
  assert.equal(reloaded.ssoSubject, "stable-subject");
  const membership = await membershipOf(existing.id);
  assert.ok(membership, "auto-join created the Membership after linking");
  assert.equal(membership.role, "member");

  // The next SSO round-trip is a clean pair match.
  const again = await ssoRoundTrip();
  assert.ok(again.kind === "signed-in");
  assert.equal(again.user.id, existing.id);
});

// ─────────────── allowed email domains — the sign-in flow ──────────────────

test("an unknown email outside the allowed domains is refused — nothing is provisioned", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "acme.com" });
  claimEmail = "attacker@gmail.com";

  await assert.rejects(ssoRoundTrip(), /Your email domain is not allowed for this company's SSO\./);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
  assert.equal(await AppDataSource.getRepository(Membership).count(), 0);
});

test("an unknown email on an allowed domain is provisioned and joined", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "example.com,other.io" });

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "signed-in");
  assert.equal(result.user.email, "member@example.com");
  assert.ok(await membershipOf(result.user.id));
});

test("a pair-matched non-member outside the allowed domains is refused the auto-join", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "acme.com" });
  claimEmail = "outsider@gmail.com";
  const paired = await insert(User, {
    email: "outsider@gmail.com",
    name: "Paired",
    passwordHash: "x",
    sessionVersion: 0,
    ssoIssuer: "https://idp.test",
    ssoSubject: "stable-subject",
    emailVerifiedAt: new Date(),
  });

  await assert.rejects(ssoRoundTrip(), /Your email domain is not allowed for this company's SSO\./);
  assert.equal(await membershipOf(paired.id), null);
});

test("a pair-matched EXISTING member outside the allowed domains still signs in", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "acme.com" });
  claimEmail = "grandfathered@gmail.com";
  const paired = await insert(User, {
    email: "grandfathered@gmail.com",
    name: "Paired",
    passwordHash: "x",
    sessionVersion: 0,
    ssoIssuer: "https://idp.test",
    ssoSubject: "stable-subject",
    emailVerifiedAt: new Date(),
  });
  await insert(Membership, { companyId: company.id, userId: paired.id, role: "member" });

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "signed-in");
  assert.equal(result.user.id, paired.id);
});

test("an email-only match outside the allowed domains is refused the link-confirmation step", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "acme.com" });
  claimEmail = "existing@gmail.com";
  const existing = await insert(User, {
    email: "existing@gmail.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });

  await assert.rejects(ssoRoundTrip(), /Your email domain is not allowed for this company's SSO\./);
  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, null);
  assert.equal(reloaded.ssoSubject, null);
});

test("the domain check matches the part after the LAST @, case-insensitively", async () => {
  await putOnScale();
  await configureSso({ allowedEmailDomains: "example.com" });
  // Lowercasing happens in the claims parser; a tricky local part with an @
  // must not fool the check into reading the wrong domain.
  claimEmail = "spoof@example.com@gmail.com";

  await assert.rejects(ssoRoundTrip(), /Your email domain is not allowed for this company's SSO\./);
});
