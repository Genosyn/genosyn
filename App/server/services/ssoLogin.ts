import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { ensureUserHandle } from "./userHandle.js";
import { resolveSsoRuntime, ssoCallbackUrl, type ResolvedSso } from "./ssoSettings.js";

/**
 * The OpenID Connect login handshake behind the login page's SSO button.
 *
 * Deliberately spec-minimal and dependency-free: the authorization-code flow
 * with the provider's discovery document, then the `userinfo` endpoint for
 * identity claims. Reading `userinfo` over TLS (instead of decoding the
 * `id_token`) keeps JWT parsing/validation out of the codebase entirely —
 * the claims come straight from the issuer we just exchanged the code with.
 * Google is "just" an OIDC provider here (issuer accounts.google.com);
 * anything OIDC-compliant (Okta, Keycloak, Entra ID, Auth0, …) works the
 * same way.
 *
 * State tokens are kept in-process with a 10-minute TTL, same philosophy as
 * the integrations OAuth dance in `services/oauth.ts` — single-use, and if
 * the user dawdles past the TTL they start again.
 */

/** A login failure whose message is safe to show the person signing in. */
export class SsoLoginError extends Error {}

// ─────────────────────────── state store ───────────────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, number>();

function sweepStates(): void {
  const now = Date.now();
  for (const [k, expiresAt] of states) {
    if (expiresAt < now) states.delete(k);
  }
}

function mintState(): string {
  sweepStates();
  const state = crypto.randomBytes(24).toString("hex");
  states.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

/** Pop a state token — single-use. */
function consumeState(state: string): boolean {
  sweepStates();
  const expiresAt = states.get(state);
  if (!expiresAt) return false;
  states.delete(state);
  return expiresAt >= Date.now();
}

// ─────────────────────────── discovery ─────────────────────────────────────

export type OidcEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
};

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, { endpoints: OidcEndpoints; expiresAt: number }>();

/**
 * Fetch and validate the issuer's discovery document. Exported for the
 * Admin → SSO "check issuer" probe as well as the live handshake.
 */
export async function discoverOidcEndpoints(issuer: string): Promise<OidcEndpoints> {
  const base = issuer.trim().replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) {
    throw new SsoLoginError("Issuer URL must start with https://");
  }
  const cached = discoveryCache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached.endpoints;

  const url = `${base}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new SsoLoginError(
      `Could not reach the identity provider (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new SsoLoginError(
      `Identity provider discovery failed: ${res.status} from ${url}`,
    );
  }
  let doc: Record<string, unknown>;
  try {
    doc = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SsoLoginError("Identity provider discovery returned invalid JSON");
  }
  const endpoints: OidcEndpoints = {
    authorizationEndpoint: httpsUrlField(doc, "authorization_endpoint"),
    tokenEndpoint: httpsUrlField(doc, "token_endpoint"),
    userinfoEndpoint: httpsUrlField(doc, "userinfo_endpoint"),
  };
  discoveryCache.set(base, { endpoints, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return endpoints;
}

function httpsUrlField(doc: Record<string, unknown>, key: string): string {
  const v = doc[key];
  if (typeof v !== "string" || !/^https:\/\//.test(v)) {
    throw new SsoLoginError(
      `Identity provider discovery document is missing "${key}" — is the issuer URL right?`,
    );
  }
  return v;
}

// ─────────────────────────── the handshake ─────────────────────────────────

/** Build the redirect that sends the browser off to the identity provider.
 *  Throws `SsoLoginError` when SSO is disabled or misconfigured. */
export async function startSsoLogin(): Promise<{ authorizeUrl: string }> {
  const sso = await requireSsoRuntime();
  const endpoints = await discoverOidcEndpoints(sso.issuer);
  const u = new URL(endpoints.authorizationEndpoint);
  u.searchParams.set("client_id", sso.clientId);
  u.searchParams.set("redirect_uri", ssoCallbackUrl());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", mintState());
  return { authorizeUrl: u.toString() };
}

/**
 * Complete the handshake: validate state, exchange the code, read identity
 * claims from `userinfo`, and resolve them to a Genosyn user — linking an
 * existing account by verified email, or provisioning a fresh one when the
 * operator has auto-provision on.
 */
export async function finishSsoLogin(args: {
  code: string;
  state: string;
}): Promise<User> {
  if (!consumeState(args.state)) {
    throw new SsoLoginError(
      "The sign-in attempt expired or was already used — try again.",
    );
  }
  const sso = await requireSsoRuntime();
  const endpoints = await discoverOidcEndpoints(sso.issuer);
  const accessToken = await exchangeCode({ sso, endpoints, code: args.code });
  const claims = await fetchClaims(endpoints.userinfoEndpoint, accessToken);
  return resolveSsoUser({ sso, claims });
}

async function requireSsoRuntime(): Promise<ResolvedSso> {
  const sso = await resolveSsoRuntime();
  if (!sso) {
    throw new SsoLoginError("SSO sign-in is not enabled on this instance.");
  }
  return sso;
}

async function exchangeCode(args: {
  sso: ResolvedSso;
  endpoints: OidcEndpoints;
  code: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: ssoCallbackUrl(),
    client_id: args.sso.clientId,
    client_secret: args.sso.clientSecret,
  });
  const res = await fetch(args.endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new SsoLoginError(oidcErrorMessage(parsed, `Token exchange failed (${res.status})`));
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!access) {
    throw new SsoLoginError("The identity provider did not return an access token.");
  }
  return access;
}

type SsoClaims = {
  subject: string;
  email: string;
  name: string;
};

async function fetchClaims(
  userinfoEndpoint: string,
  accessToken: string,
): Promise<SsoClaims> {
  const res = await fetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new SsoLoginError(oidcErrorMessage(parsed, `Could not read your profile from the identity provider (${res.status})`));
  }
  const subject = typeof parsed.sub === "string" ? parsed.sub : "";
  const email = typeof parsed.email === "string" ? parsed.email.toLowerCase() : "";
  if (!subject || !email) {
    throw new SsoLoginError(
      "The identity provider did not share an email address — make sure the email scope is granted.",
    );
  }
  // Only reject an explicit false: many providers simply omit the claim, and
  // the operator chose to trust this issuer when they configured it.
  if (parsed.email_verified === false) {
    throw new SsoLoginError(
      `${email} is not a verified address at your identity provider.`,
    );
  }
  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "";
  return { subject, email, name };
}

/**
 * Map verified claims onto a Genosyn account:
 *   1. A user already linked to this issuer + subject signs straight in.
 *   2. Otherwise an existing account with the same email is linked — the
 *      match is on the pair, so a subject from a previously-configured
 *      issuer can never impersonate anyone here.
 *   3. Otherwise a fresh account is created when auto-provision is on. The
 *      password hash is random and unusable; "forgot password" mints a real
 *      one later if the person ever needs password login.
 */
async function resolveSsoUser(args: {
  sso: ResolvedSso;
  claims: SsoClaims;
}): Promise<User> {
  const { sso, claims } = args;
  const repo = AppDataSource.getRepository(User);

  const linked = await repo.findOneBy({
    ssoIssuer: sso.issuer,
    ssoSubject: claims.subject,
  });
  if (linked) return linked;

  const byEmail = await repo.findOneBy({ email: claims.email });
  if (byEmail) {
    byEmail.ssoIssuer = sso.issuer;
    byEmail.ssoSubject = claims.subject;
    await repo.save(byEmail);
    return byEmail;
  }

  if (!sso.autoProvision) {
    throw new SsoLoginError(
      `No Genosyn account matches ${claims.email}. Ask an administrator to invite you first.`,
    );
  }

  const user = repo.create({
    email: claims.email,
    name: claims.name || claims.email.split("@")[0],
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
    isMasterAdmin: false,
    resetToken: null,
    resetExpiresAt: null,
    ssoIssuer: sso.issuer,
    ssoSubject: claims.subject,
  });
  await repo.save(user);
  await ensureUserHandle(user);
  return user;
}

function oidcErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const desc = parsed.error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = parsed.error;
  if (typeof err === "string" && err) return err;
  return fallback;
}
