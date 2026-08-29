import bcrypt from "bcrypt";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { CompanySso } from "../db/entities/CompanySso.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { createAuthFlowState, consumeAuthFlowState } from "./authFlowState.js";
import { recordAudit } from "./audit.js";
import { getCompanyEntitlements } from "./entitlements.js";
import { getPublicUrl } from "./publicUrl.js";
import {
  completeOidcCodeExchange,
  consumeOidcHandshakeState,
  provisionSsoUser,
  SsoLoginError,
  startOidcHandshake,
  type OidcClientConfig,
} from "./ssoLogin.js";
import { GOOGLE_ISSUER, type SsoProvider } from "./ssoSettings.js";

/**
 * Per-company single sign-on (M56 Phase B) — a company on Genosyn Cloud's
 * Scale plan configures its own identity provider and members sign in at
 * `/login/sso/<companySlug>`. Reuses the instance OIDC machinery in
 * `ssoLogin.ts` (discovery, PKCE, single-use encrypted state, verified-email
 * userinfo); this module owns the per-company persistence, eligibility, and
 * the account-resolution rules.
 *
 * The resolution rules are security-critical. A company-configured IdP
 * asserting an email must NEVER silently take over an existing Genosyn
 * account — the person may belong to other companies the IdP's operator has
 * no authority over. Sign-in therefore matches on the exact
 * `{ssoIssuer, ssoSubject}` pair; an email-only match instead goes through a
 * short-lived link-confirmation step where the person proves the account's
 * password before the pair is bound.
 */

export const COMPANY_SSO_STATE_KIND = "company-sso";
export const COMPANY_SSO_LINK_STATE_KIND = "company-sso-link";
const LINK_STATE_TTL_MS = 10 * 60 * 1000;

const NOT_AVAILABLE_MESSAGE = "SSO sign-in is not available for this workspace.";
const NOT_A_MEMBER_MESSAGE = "You are not a member of this company yet";
const DOMAIN_NOT_ALLOWED_MESSAGE = "Your email domain is not allowed for this company's SSO.";

/** A bare domain like "acme.com" — lowercase, with a real TLD. */
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** The redirect URI every company registers with its identity provider —
 *  shared across companies; the state token carries the company id. */
export function companySsoCallbackUrl(): string {
  return `${getPublicUrl()}/api/auth/sso/company/callback`;
}

/** The page members bookmark to sign in through this company's IdP. */
export function companySsoLoginUrl(companySlug: string): string {
  return `${getPublicUrl()}/login/sso/${companySlug}`;
}

/** Non-secret view for the Settings → Single sign-on page. */
export type CompanySsoDescriptor = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  autoJoin: boolean;
  /** Comma-separated lowercase domains; empty means no restriction. */
  allowedEmailDomains: string;
  /** True when issuer + client id + client secret are all present. */
  configured: boolean;
  callbackUrl: string;
  loginUrl: string;
};

/** Payload the settings form submits. Blank secret keeps the stored one. */
export type CompanySsoInput = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoJoin: boolean;
  allowedEmailDomains: string;
};

function normalizeProvider(value: string): SsoProvider {
  return value === "oidc" ? "oidc" : "google";
}

function effectiveIssuer(row: CompanySso): string {
  return normalizeProvider(row.provider) === "google" ? GOOGLE_ISSUER : row.issuer;
}

function defaultButtonLabel(provider: SsoProvider): string {
  return provider === "google" ? "Continue with Google" : "Continue with SSO";
}

function isConfigured(row: CompanySso): boolean {
  return Boolean(effectiveIssuer(row) && row.clientId && row.encryptedClientSecret);
}

function secretScope(companyId: string): string {
  return `company:${companyId}`;
}

/**
 * Normalize the settings form's domain list: lowercased, trimmed, deduped,
 * each a bare domain. Throws (as a form 400) on anything that is not one.
 */
function normalizeAllowedEmailDomains(value: string): string {
  const domains: string[] = [];
  for (const raw of value.split(",")) {
    const domain = raw.trim().toLowerCase();
    if (!domain) continue;
    if (!EMAIL_DOMAIN_PATTERN.test(domain)) {
      throw new Error(
        `"${domain}" is not a valid email domain — enter bare domains like acme.com, separated by commas.`,
      );
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.join(",");
}

function parseAllowedEmailDomains(stored: string): string[] {
  return stored.split(",").filter(Boolean);
}

function emailDomainAllowed(allowedDomains: string[], email: string): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return allowedDomains.includes(domain);
}

async function findRow(companyId: string): Promise<CompanySso | null> {
  return AppDataSource.getRepository(CompanySso).findOneBy({ companyId });
}

function emptyRow(companyId: string): CompanySso {
  return AppDataSource.getRepository(CompanySso).create({
    companyId,
    enabled: false,
    provider: "google",
    displayName: "",
    issuer: "",
    clientId: "",
    encryptedClientSecret: "",
    autoJoin: true,
    allowedEmailDomains: "",
  });
}

function describeRow(row: CompanySso, companySlug: string): CompanySsoDescriptor {
  return {
    enabled: row.enabled,
    provider: normalizeProvider(row.provider),
    displayName: row.displayName,
    issuer: effectiveIssuer(row),
    clientId: row.clientId,
    hasClientSecret: Boolean(row.encryptedClientSecret),
    autoJoin: row.autoJoin,
    allowedEmailDomains: row.allowedEmailDomains,
    configured: isConfigured(row),
    callbackUrl: companySsoCallbackUrl(),
    loginUrl: companySsoLoginUrl(companySlug),
  };
}

export async function describeCompanySso(
  companyId: string,
  companySlug: string,
): Promise<CompanySsoDescriptor> {
  const row = (await findRow(companyId)) ?? emptyRow(companyId);
  return describeRow(row, companySlug);
}

/**
 * Persist the settings form. Mirrors the instance rules: a blank client
 * secret keeps the stored one, the Google preset fixes the issuer, and
 * enabling while unconfigured is refused (a login page must never advertise
 * a button that 500s). Throws plain `Error`s whose messages the route
 * returns as a 400.
 */
export async function updateCompanySso(
  companyId: string,
  companySlug: string,
  input: CompanySsoInput,
): Promise<CompanySsoDescriptor> {
  const repo = AppDataSource.getRepository(CompanySso);
  const row = (await findRow(companyId)) ?? emptyRow(companyId);
  row.enabled = input.enabled;
  row.provider = input.provider;
  row.displayName = input.displayName.trim();
  row.issuer = input.provider === "google" ? "" : input.issuer.trim().replace(/\/+$/, "");
  row.clientId = input.clientId.trim();
  if (input.clientSecret) {
    row.encryptedClientSecret = encryptSecret(input.clientSecret, secretScope(companyId));
  }
  row.autoJoin = input.autoJoin;
  row.allowedEmailDomains = normalizeAllowedEmailDomains(input.allowedEmailDomains);
  if (row.provider === "oidc" && row.issuer && !/^https:\/\//.test(row.issuer)) {
    throw new Error("Issuer URL must start with https://");
  }
  if (row.enabled && !isConfigured(row)) {
    throw new Error(
      row.provider === "oidc" && !row.issuer
        ? "Enter the issuer URL, client ID, and client secret before enabling SSO."
        : "Enter the client ID and client secret before enabling SSO.",
    );
  }
  // The Google preset's issuer is a public IdP that vouches for every Google
  // account on Earth — auto-join without a domain list would admit anyone. A
  // custom "oidc" issuer stays allowed without one: the company controls that
  // IdP and decides who it vouches for.
  if (row.enabled && row.provider === "google" && row.autoJoin && !row.allowedEmailDomains) {
    throw new Error(
      "Google SSO signs in any Google account. List the email domains that belong to your company before enabling auto-join.",
    );
  }
  await repo.save(row);
  return describeRow(row, companySlug);
}

/** Remove the stored settings entirely — back to the disabled default. */
export async function clearCompanySso(
  companyId: string,
  companySlug: string,
): Promise<CompanySsoDescriptor> {
  await AppDataSource.getRepository(CompanySso).delete({ companyId });
  return describeCompanySso(companyId, companySlug);
}

// ─────────────────────────── runtime eligibility ───────────────────────────

type ResolvedCompanySso = {
  company: Company;
  client: OidcClientConfig;
  autoJoin: boolean;
  /** Parsed domain allowlist; empty means no restriction. */
  allowedEmailDomains: string[];
  buttonLabel: string;
};

async function resolveForCompany(company: Company | null): Promise<ResolvedCompanySso | null> {
  if (!company) return null;
  const row = await findRow(company.id);
  if (!row || !row.enabled || !isConfigured(row)) return null;
  // A company keeps its saved configuration when it drops off Scale, but the
  // runtime goes dark: the entitlements resolver is the single source of truth.
  const entitlements = await getCompanyEntitlements(company.id);
  if (!entitlements.features.sso) return null;
  let clientSecret = "";
  try {
    clientSecret = decryptSecret(row.encryptedClientSecret);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[company-sso] could not decrypt the stored client secret for company ${company.id} — SSO is unavailable until it is re-entered`,
    );
    return null;
  }
  if (!clientSecret) return null;
  const provider = normalizeProvider(row.provider);
  return {
    company,
    client: {
      issuer: effectiveIssuer(row),
      clientId: row.clientId,
      clientSecret,
      callbackUrl: companySsoCallbackUrl(),
    },
    autoJoin: row.autoJoin,
    allowedEmailDomains: parseAllowedEmailDomains(row.allowedEmailDomains),
    buttonLabel: row.displayName.trim() || defaultButtonLabel(provider),
  };
}

async function resolveBySlug(companySlug: string): Promise<ResolvedCompanySso | null> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ slug: companySlug });
  return resolveForCompany(company);
}

async function resolveById(companyId: string): Promise<ResolvedCompanySso | null> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  return resolveForCompany(company);
}

/**
 * Public probe for the login page. Deliberately leaks nothing about an
 * unknown slug, a disabled row, or a plan below Scale — they are all the
 * same `{ enabled: false }`.
 */
export async function getCompanySsoPublicStatus(
  companySlug: string,
): Promise<{ enabled: boolean; buttonLabel: string | null }> {
  const resolved = await resolveBySlug(companySlug);
  if (!resolved) return { enabled: false, buttonLabel: null };
  return { enabled: true, buttonLabel: resolved.buttonLabel };
}

// ─────────────────────────── the sign-in flow ──────────────────────────────

/** Build the redirect to the company's identity provider. */
export async function startCompanySsoLogin(companySlug: string): Promise<{
  authorizeUrl: string;
  browserBinding: string;
}> {
  const resolved = await resolveBySlug(companySlug);
  if (!resolved) throw new SsoLoginError(NOT_AVAILABLE_MESSAGE);
  return startOidcHandshake({
    client: resolved.client,
    stateKind: COMPANY_SSO_STATE_KIND,
    extraStatePayload: { companyId: resolved.company.id },
  });
}

export type CompanySsoLoginResult =
  | { kind: "signed-in"; user: User; companyId: string }
  /** An existing account matched by email only — the person must confirm
   *  with that account's password before the identity is linked. */
  | { kind: "link-required"; token: string };

type LinkState = {
  userId: string;
  companyId: string;
  issuer: string;
  subject: string;
};

async function findMembership(companyId: string, userId: string): Promise<Membership | null> {
  return AppDataSource.getRepository(Membership).findOneBy({ companyId, userId });
}

async function createMembership(companyId: string, userId: string): Promise<void> {
  const repo = AppDataSource.getRepository(Membership);
  await repo.save(repo.create({ companyId, userId, role: "member" }));
  await recordAudit({
    companyId,
    actorUserId: userId,
    action: "sso.join",
    targetType: "user",
    targetId: userId,
  });
}

/**
 * Complete the callback. Resolution rules (security-critical — see the
 * module doc):
 *  1. Exact `{ssoIssuer, ssoSubject}` pair match → sign in; join the company
 *     (role "member") when `autoJoin`, refuse otherwise.
 *  2. No account with the claimed email → auto-provision + join when
 *     `autoJoin`, refuse otherwise.
 *  3. An existing account matches by email only (no pair, or a different
 *     pair) → never link silently; mint a single-use link-confirmation
 *     token the login page redeems with the account's password.
 *
 * A non-empty `allowedEmailDomains` gates every path above that would create
 * something new — a provisioned User, a Membership, a link-confirmation —
 * against the IdP-asserted email's domain. A pair-matched existing member
 * still signs in: they were already admitted.
 */
export async function finishCompanySsoLogin(args: {
  code: string;
  state: string;
  browserBinding: string;
}): Promise<CompanySsoLoginResult> {
  const { codeVerifier, extra } = await consumeOidcHandshakeState(COMPANY_SSO_STATE_KIND, {
    state: args.state,
    browserBinding: args.browserBinding,
  });
  const companyId = typeof extra.companyId === "string" ? extra.companyId : "";
  if (!companyId) {
    throw new SsoLoginError("The sign-in attempt expired or was already used — try again.");
  }
  // Re-check eligibility at redemption: the row may have been disabled, or
  // the plan changed, while the person was away at the identity provider.
  const resolved = await resolveById(companyId);
  if (!resolved) throw new SsoLoginError(NOT_AVAILABLE_MESSAGE);
  const claims = await completeOidcCodeExchange({
    client: resolved.client,
    code: args.code,
    codeVerifier,
  });

  const userRepo = AppDataSource.getRepository(User);

  // 1. Pair match — this issuer already vouched for this exact account.
  const paired = await userRepo.findOneBy({
    ssoIssuer: resolved.client.issuer,
    ssoSubject: claims.subject,
  });
  if (paired) {
    if (!paired.emailVerifiedAt) {
      paired.emailVerifiedAt = new Date();
      paired.emailVerificationTokenHash = null;
      paired.emailVerificationExpiresAt = null;
      await userRepo.save(paired);
    }
    if (!(await findMembership(companyId, paired.id))) {
      if (!resolved.autoJoin) throw new SsoLoginError(NOT_A_MEMBER_MESSAGE);
      if (!emailDomainAllowed(resolved.allowedEmailDomains, claims.email)) {
        throw new SsoLoginError(DOMAIN_NOT_ALLOWED_MESSAGE);
      }
      await createMembership(companyId, paired.id);
    }
    await recordAudit({
      companyId,
      actorUserId: paired.id,
      action: "sso.sign_in",
      targetType: "user",
      targetId: paired.id,
    });
    return { kind: "signed-in", user: paired, companyId };
  }

  const byEmail = await userRepo.findOneBy({ email: claims.email });

  // 2. Nobody has this email — a brand-new person, provisioned when the
  //    company allows auto-join.
  if (!byEmail) {
    if (!resolved.autoJoin) throw new SsoLoginError(NOT_A_MEMBER_MESSAGE);
    if (!emailDomainAllowed(resolved.allowedEmailDomains, claims.email)) {
      throw new SsoLoginError(DOMAIN_NOT_ALLOWED_MESSAGE);
    }
    const user = await provisionSsoUser({ issuer: resolved.client.issuer, claims });
    await createMembership(companyId, user.id);
    await recordAudit({
      companyId,
      actorUserId: user.id,
      action: "sso.sign_in",
      targetType: "user",
      targetId: user.id,
    });
    return { kind: "signed-in", user, companyId };
  }

  // 3. Email-only match (including an account bound to a DIFFERENT pair).
  //    Never bind here — the person proves the password first. Starting the
  //    link-confirmation is itself gated on the domain allowlist.
  if (!emailDomainAllowed(resolved.allowedEmailDomains, claims.email)) {
    throw new SsoLoginError(DOMAIN_NOT_ALLOWED_MESSAGE);
  }
  const token = await createAuthFlowState(
    COMPANY_SSO_LINK_STATE_KIND,
    {
      userId: byEmail.id,
      companyId,
      issuer: resolved.client.issuer,
      subject: claims.subject,
    } satisfies LinkState,
    LINK_STATE_TTL_MS,
  );
  return { kind: "link-required", token };
}

export type CompanySsoLinkOutcome =
  | { status: "invalid-password" }
  | { status: "linked"; user: User; companyId: string };

/**
 * Redeem a link-confirmation token with the account's password. The token is
 * single-use — a wrong password burns it, and the person restarts the SSO
 * sign-in (deliberate: the token embodies one IdP round-trip's claims).
 * On success the `{ssoIssuer, ssoSubject}` pair is (re)bound to the account
 * and a Membership is created when the company allows auto-join.
 */
export async function confirmCompanySsoLink(args: {
  token: string;
  password: string;
}): Promise<CompanySsoLinkOutcome> {
  const state = await consumeAuthFlowState<LinkState>(COMPANY_SSO_LINK_STATE_KIND, args.token);
  if (!state) {
    throw new SsoLoginError(
      "The confirmation expired or was already used — start the SSO sign-in again.",
    );
  }
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOneBy({ id: state.userId });
  if (!user) {
    throw new SsoLoginError("That account no longer exists — start the SSO sign-in again.");
  }
  const ok = await bcrypt.compare(args.password, user.passwordHash);
  if (!ok) return { status: "invalid-password" };

  user.ssoIssuer = state.issuer;
  user.ssoSubject = state.subject;
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
  }
  await userRepo.save(user);
  await recordAudit({
    companyId: state.companyId,
    actorUserId: user.id,
    action: "sso.link",
    targetType: "user",
    targetId: user.id,
  });

  const row = await findRow(state.companyId);
  if (row?.autoJoin && !(await findMembership(state.companyId, user.id))) {
    await createMembership(state.companyId, user.id);
  }
  return { status: "linked", user, companyId: state.companyId };
}
