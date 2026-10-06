import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import bcrypt from "bcrypt";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  anyCompanySsoEnabled,
  confirmCompanySsoLink,
  describeCompanySso,
  describeCompanySsoLink,
  finishCompanySsoLogin,
  getCompanySsoPublicStatus,
  startCompanySsoLogin,
  updateCompanySso,
  type CompanySsoInput,
} from "./companySso.js";
import { SsoLoginError } from "./ssoLogin.js";
import { COMPANY_SSO_ALLOWED_KEY, isCompanySsoAllowed, setCompanySsoAllowed } from "./ssoSettings.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Invitation } from "../db/entities/Invitation.js";
import { SIGNUP_DISABLED_KEY } from "./signupSettings.js";

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
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  await setCompanySsoAllowed(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

async function joinCompany(userId: string): Promise<void> {
  await insert(Membership, { companyId: company.id, userId, role: "member" });
}

// ───────────────────────── eligibility matrix ───────────────────────────────

test("public status is enabled only for a configured, enabled row", async () => {
  // Unknown slug leaks nothing.
  assert.deepEqual(await getCompanySsoPublicStatus("nope"), {
    enabled: false,
    buttonLabel: null,
  });

  // Configured but disabled — dark.
  await configureSso({ enabled: false });
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: false,
    buttonLabel: null,
  });
  await assert.rejects(startCompanySsoLogin(company.slug), SsoLoginError);

  // Enabled + configured — live, with the company's label.
  await configureSso();
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: true,
    buttonLabel: "Acme SSO",
  });
});

test("the install-wide probe is true only while some company has SSO enabled", async () => {
  assert.equal(await anyCompanySsoEnabled(), false);

  await configureSso({ enabled: false });
  assert.equal(await anyCompanySsoEnabled(), false);

  await configureSso();
  assert.equal(await anyCompanySsoEnabled(), true);
});

test("company SSO stays dark until a master admin allows it", async () => {
  await configureSso();
  await setCompanySsoAllowed(false);

  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: false,
    buttonLabel: null,
  });
  assert.equal(await anyCompanySsoEnabled(), false);
  await assert.rejects(startCompanySsoLogin(company.slug), SsoLoginError);
  assert.equal((await describeCompanySso(company.id, company.slug)).allowedByInstance, false);

  // A draft can still be prepared; turning it on waits for the admin.
  await configureSso({ enabled: false });
  await assert.rejects(configureSso(), /not allowed on this install/);
});

test("an install already signing in through company SSO keeps it allowed until an admin decides", async () => {
  await configureSso();
  await AppDataSource.getRepository(AppSetting).delete({ key: COMPANY_SSO_ALLOWED_KEY });
  assert.equal(await isCompanySsoAllowed(), true);

  await configureSso({ enabled: false });
  assert.equal(await isCompanySsoAllowed(), false);
});

test("with sign-ups disabled, auto-join creates accounts only for people the company invited", async () => {
  await configureSso();
  await AppDataSource.getRepository(AppSetting).save({ key: SIGNUP_DISABLED_KEY, value: "true" });

  await assert.rejects(ssoRoundTrip(), /Sign-ups are disabled/);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder

  await insert(Invitation, {
    companyId: company.id,
    email: "Member@Example.com",
    token: "invitation-token-hash",
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
  });
  const result = await ssoRoundTrip();
  assert.ok(result.kind === "signed-in");
  assert.equal(result.user.email, "member@example.com");
});

test("an email claim that is not a clean address is refused, not normalized", async () => {
  await configureSso();
  claimEmail = "member@example.com ";
  await assert.rejects(ssoRoundTrip(), /email address Genosyn cannot use/);
  claimEmail = "not-an-address";
  await assert.rejects(ssoRoundTrip(), /email address Genosyn cannot use/);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
});

// ───────────────────── allowed email domains — saving ───────────────────────

test("enabling the Google preset with auto-join and no domain list is refused", async () => {
  await assert.rejects(
    configureSso({ provider: "google", issuer: "", autoJoin: true, allowedEmailDomains: "" }),
    /Google SSO signs in any Google account\. List the email domains that belong to your company before enabling auto-join\./,
  );
});

test("the Google preset is allowed with a domain list, or with auto-join off", async () => {
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
  await configureSso({ autoJoin: true, allowedEmailDomains: "" });
  assert.deepEqual(await getCompanySsoPublicStatus(company.slug), {
    enabled: true,
    buttonLabel: "Acme SSO",
  });
});

test("domains are lowercased, trimmed, and deduped on save", async () => {
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
  await configureSso();

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "signed-in");
  assert.ok(result.kind === "signed-in");
  const user = result.user;
  assert.equal(user.email, "member@example.com");
  assert.equal(user.ssoIssuer, "https://idp.test");
  assert.equal(user.ssoSubject, "stable-subject");
  assert.equal(user.emailVerifiedAt, null, "a company IdP's email claim does not prove the mailbox");
  const stored = await AppDataSource.getRepository(User).findOneByOrFail({ id: user.id });
  assert.ok(stored.emailVerificationTokenHash, "a verification link was sent, as on signup");
  assert.ok(await membershipOf(user.id));
});

test("a company IdP never verifies an email, on a pair match or a password link", async () => {
  await configureSso();
  const paired = await insert(User, {
    email: "member@example.com",
    name: "Paired",
    passwordHash: "x",
    sessionVersion: 0,
    ssoIssuer: "https://idp.test",
    ssoSubject: "stable-subject",
    emailVerifiedAt: null,
  });
  const signedIn = await ssoRoundTrip();
  assert.ok(signedIn.kind === "signed-in");
  const afterPair = await AppDataSource.getRepository(User).findOneByOrFail({ id: paired.id });
  assert.equal(afterPair.emailVerifiedAt, null);

  claimEmail = "linker@example.com";
  claimSubject = "linker-subject";
  const linker = await insert(User, {
    email: "linker@example.com",
    name: "Linker",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: null,
  });
  await joinCompany(linker.id);
  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");
  const outcome = await confirmCompanySsoLink({ token: result.token, password: "correct-pw" });
  assert.equal(outcome.status, "linked");
  const afterLink = await AppDataSource.getRepository(User).findOneByOrFail({ id: linker.id });
  assert.equal(afterLink.ssoSubject, "linker-subject");
  assert.equal(afterLink.emailVerifiedAt, null);
});

test("once a pre-created account's pairing is cleared, the IdP must prove the password again", async () => {
  // A company IdP provisions an address its operator does not own. Password
  // recovery (POST /api/auth/reset) clears the pairing — see authSecurity
  // tests — after which the same IdP subject cannot sign in as the account.
  await configureSso();
  const first = await ssoRoundTrip();
  assert.ok(first.kind === "signed-in");
  await AppDataSource.getRepository(User).update(
    { id: first.user.id },
    { ssoIssuer: null, ssoSubject: null, passwordHash: await bcrypt.hash("owner-pw", 4) },
  );

  const again = await ssoRoundTrip();
  assert.equal(again.kind, "link-required");
  assert.ok(again.kind === "link-required");
  const wrong = await confirmCompanySsoLink({ token: again.token, password: "guess" });
  assert.equal(wrong.status, "invalid-password");
  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: first.user.id });
  assert.equal(reloaded.ssoSubject, null);
});

test("an unknown email is refused when auto-join is off, and nothing is created", async () => {
  await configureSso({ autoJoin: false });

  await assert.rejects(ssoRoundTrip(), /not a member of this company/);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
});

test("an email-only match is never linked silently — it returns the link step and binds nothing", async () => {
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await joinCompany(existing.id);

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "link-required");
  assert.ok(result.kind === "link-required");
  assert.ok(result.token);
  assert.deepEqual(await describeCompanySsoLink(result.token), {
    companyName: "Acme",
    companySlug: "acme",
    issuerHost: "idp.test",
    accountEmail: "member@example.com",
  });

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, null, "callback must not bind the issuer");
  assert.equal(reloaded.ssoSubject, null, "callback must not bind the subject");
});

test("an email-only match that is not a Member gets no link step — a company cannot prompt for a stranger's password", async () => {
  await configureSso();
  const outsider = await insert(User, {
    email: "member@example.com",
    name: "Outsider",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });

  await assert.rejects(ssoRoundTrip(), /not a member of this company/);
  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: outsider.id });
  assert.equal(reloaded.ssoSubject, null);
  assert.equal(await membershipOf(outsider.id), null);
});

test("an account bound to a DIFFERENT pair also goes through the confirm step before rebinding", async () => {
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
  await joinCompany(existing.id);

  const result = await ssoRoundTrip();
  assert.equal(result.kind, "link-required");

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, "https://old-idp.example");
  assert.equal(reloaded.ssoSubject, "old-subject");
});

test("link confirmation with the wrong password fails, binds nothing, and burns the token", async () => {
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await joinCompany(existing.id);

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");

  const outcome = await confirmCompanySsoLink({ token: result.token, password: "wrong-pw" });
  assert.deepEqual(outcome, { status: "invalid-password" });

  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoIssuer, null);
  assert.equal(reloaded.ssoSubject, null);

  // Single-use: the burned token cannot be retried with the right password.
  await assert.rejects(
    confirmCompanySsoLink({ token: result.token, password: "correct-pw" }),
    /expired or was already used/,
  );
  assert.equal(await describeCompanySsoLink(result.token), null);
});

test("link confirmation with the right password binds the pair for a Member", async () => {
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await joinCompany(existing.id);

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

  // The next SSO round-trip is a clean pair match.
  const again = await ssoRoundTrip();
  assert.ok(again.kind === "signed-in");
  assert.equal(again.user.id, existing.id);
});

test("link confirmation is refused once company SSO is no longer allowed", async () => {
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await joinCompany(existing.id);
  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");

  await setCompanySsoAllowed(false);
  await assert.rejects(
    confirmCompanySsoLink({ token: result.token, password: "correct-pw" }),
    /not available for this workspace/,
  );
  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoSubject, null);
});

test("link confirmation is refused when the Membership was removed after the token was minted", async () => {
  await configureSso();
  const existing = await insert(User, {
    email: "member@example.com",
    name: "Existing",
    passwordHash: await bcrypt.hash("correct-pw", 4),
    sessionVersion: 0,
    emailVerifiedAt: new Date(),
  });
  await joinCompany(existing.id);
  const result = await ssoRoundTrip();
  assert.ok(result.kind === "link-required");

  await AppDataSource.getRepository(Membership).delete({ companyId: company.id, userId: existing.id });
  await assert.rejects(
    confirmCompanySsoLink({ token: result.token, password: "correct-pw" }),
    /not a member of this company/,
  );
  const reloaded = await AppDataSource.getRepository(User).findOneByOrFail({ id: existing.id });
  assert.equal(reloaded.ssoSubject, null);
});

// ─────────────── allowed email domains — the sign-in flow ──────────────────

test("an unknown email outside the allowed domains is refused — nothing is provisioned", async () => {
  await configureSso({ allowedEmailDomains: "acme.com" });
  claimEmail = "attacker@gmail.com";

  await assert.rejects(ssoRoundTrip(), /Your email domain is not allowed for this company's SSO\./);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
  assert.equal(await AppDataSource.getRepository(Membership).count(), 0);
});

test("an unknown email on an allowed domain is provisioned and joined", async () => {
  await configureSso({ allowedEmailDomains: "example.com,other.io" });

  const result = await ssoRoundTrip();
  assert.ok(result.kind === "signed-in");
  assert.equal(result.user.email, "member@example.com");
  assert.ok(await membershipOf(result.user.id));
});

test("a pair-matched non-member outside the allowed domains is refused the auto-join", async () => {
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

test("a second @ cannot smuggle an allowed domain past the check", async () => {
  await configureSso({ allowedEmailDomains: "example.com" });
  // The claims parser refuses anything that is not a clean address, before
  // the domain check (which reads the part after the LAST @) is reached.
  claimEmail = "spoof@example.com@gmail.com";

  await assert.rejects(ssoRoundTrip(), /email address Genosyn cannot use/);
  assert.equal(await AppDataSource.getRepository(User).count(), 1); // just the founder
});
