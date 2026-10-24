import { In } from "typeorm";
import {
  CONNECT_APPS_ROLE_REQUIRED,
  CONNECTED_APP_SCOPE,
  mayConnectApps,
} from "../../../shared/connectedApps.js";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { Membership, type FinanceAccess, type Role } from "../../db/entities/Membership.js";
import { OAuthClient } from "../../db/entities/OAuthClient.js";
import type { User } from "../../db/entities/User.js";
import { decryptSecret, encryptSecret } from "../../lib/secret.js";
import { financeAccessFor } from "../../middleware/financeAccess.js";
import { hasTwoFactorMethod } from "../twoFactor.js";
import { findClient, redirectUriRegistered, redirectUrisOf, touchClient } from "./clients.js";
import { companyIdFromResource, companyMcpResource, oauthIssuer } from "./metadata.js";
import { isPkceValue, issueAuthorizationCode } from "./tokens.js";

/**
 * The authorization endpoint and the consent behind it.
 *
 * `GET /oauth/authorize` checks a request against the client's registration
 * and either answers the client at once — with an error on its own redirect
 * URI — or seals the request and sends the browser to the consent page. A
 * request whose client or redirect URI cannot be trusted is never redirected
 * anywhere it names: the consent page explains the problem instead (RFC 6749
 * §4.1.2.1).
 *
 * The sealed request travels in the consent page's URL, encrypted with the
 * install's key, so nothing is stored for a visitor who never signs in, and
 * what the Member approves is exactly what the client asked for. Approving it
 * takes a signed-in browser session at the consent page; the code that comes
 * out of it is bound to the app, the Member, the company, the redirect URI and
 * the PKCE challenge.
 */

/** How long the consent page may stay open before the app has to ask again. */
export const AUTHORIZATION_REQUEST_TTL_MS = 15 * 60_000;

const SEAL_SCOPE = "mcp-oauth:authorization-request";

/** What the consent page approves or denies. */
export type AuthorizationRequest = {
  v: 1;
  /** `OAuthClient.id`. */
  clientId: string;
  redirectUri: string;
  redirectUriGiven: boolean;
  state: string | null;
  codeChallenge: string;
  scope: string;
  /** The company the request's `resource` named, or null to let the Member choose. */
  companyId: string | null;
  expiresAt: number;
};

/** Why the consent page shows an error instead of sending the browser back to the app. */
export type AuthorizationPageError =
  | "missing_client"
  | "unknown_client"
  | "missing_redirect_uri"
  | "unregistered_redirect_uri"
  | "invalid_request";

export type AuthorizeOutcome =
  /** The browser goes here: the consent page, or the consent page's error. */
  | { kind: "page"; location: string }
  /** The browser goes back to the client with an error. */
  | { kind: "redirect"; location: string };

function seal(request: AuthorizationRequest): string {
  return encryptSecret(JSON.stringify(request), SEAL_SCOPE);
}

/** The request a consent URL carries, or null when it is not one, was tampered with, or expired. */
export function unsealAuthorizationRequest(
  sealed: string,
  now = Date.now(),
): AuthorizationRequest | null {
  const parts = sealed.split(".");
  if (parts.length !== 5 || sealed.length > 8000) return null;
  try {
    // Only ciphertext sealed for this purpose: the scope is authenticated with it.
    if (Buffer.from(parts[1], "base64url").toString("utf8") !== SEAL_SCOPE) return null;
    const parsed = JSON.parse(decryptSecret(sealed)) as AuthorizationRequest;
    if (parsed?.v !== 1 || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const pagePath = (params: Record<string, string>) =>
  `/oauth/consent?${new URLSearchParams(params).toString()}`;

/** `redirectUri` with the response parameters added, keeping any query it already has. */
export function clientRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  // RFC 9207: say which authorization server answered, against mix-up attacks.
  url.searchParams.set("iss", oauthIssuer());
  return url.toString();
}

const single = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Validate an authorization request (`GET /oauth/authorize`'s query) and decide where the browser goes. */
export async function startAuthorization(
  query: Record<string, unknown>,
  now = Date.now(),
): Promise<AuthorizeOutcome> {
  const page = (error: AuthorizationPageError): AuthorizeOutcome => ({
    kind: "page",
    location: pagePath({ error }),
  });
  const clientId = single(query.client_id);
  if (!clientId) return page("missing_client");
  const client = await findClient(clientId);
  if (!client) return page("unknown_client");

  const registered = redirectUrisOf(client);
  const givenRedirect = query.redirect_uri;
  let redirectUri: string;
  if (givenRedirect === undefined) {
    if (registered.length !== 1) return page("missing_redirect_uri");
    redirectUri = registered[0];
  } else {
    if (typeof givenRedirect !== "string" || !redirectUriRegistered(givenRedirect, registered)) {
      return page("unregistered_redirect_uri");
    }
    redirectUri = givenRedirect;
  }

  // From here the redirect URI is trusted, so errors go back to the client.
  const rawState = query.state;
  const state = typeof rawState === "string" && rawState.length <= 2000 ? rawState : null;
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "redirect",
    location: clientRedirect(redirectUri, { error, error_description: description, state }),
  });
  if (rawState !== undefined && state === null) {
    return fail("invalid_request", "state must be a single value of at most 2000 characters.");
  }
  if (single(query.response_type) !== "code") {
    return fail("unsupported_response_type", 'Only response_type "code" is supported.');
  }
  const codeChallenge = single(query.code_challenge);
  if (!codeChallenge || !isPkceValue(codeChallenge)) {
    return fail(
      "invalid_request",
      "PKCE is required: send a code_challenge with code_challenge_method S256.",
    );
  }
  if (single(query.code_challenge_method) !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  if (query.scope !== undefined && typeof query.scope !== "string") {
    return fail("invalid_scope", "scope must be a single space-separated value.");
  }

  let companyId: string | null = null;
  if (query.resource !== undefined) {
    const resources = Array.isArray(query.resource) ? query.resource : [query.resource];
    const named = new Set<string>();
    for (const resource of resources) {
      const id = typeof resource === "string" ? companyIdFromResource(resource) : null;
      if (!id) {
        return fail(
          "invalid_target",
          `resource must be this install's MCP endpoint for one company: ${oauthIssuer()}/api/companies/<company-id>/mcp.`,
        );
      }
      named.add(id);
    }
    if (named.size !== 1)
      return fail("invalid_target", "Ask for one company's MCP endpoint at a time.");
    companyId = [...named][0];
  }

  touchClient(client);
  const request: AuthorizationRequest = {
    v: 1,
    clientId: client.id,
    redirectUri,
    redirectUriGiven: givenRedirect !== undefined,
    state,
    codeChallenge,
    // Scopes this server does not define are ignored (RFC 6749 §3.3); the
    // token response says what was granted.
    scope: CONNECTED_APP_SCOPE,
    companyId,
    expiresAt: now + AUTHORIZATION_REQUEST_TTL_MS,
  };
  return { kind: "page", location: pagePath({ request: seal(request) }) };
}

export class ConsentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConsentError";
  }
}

const EXPIRED =
  "This request has expired. Go back to the app and connect again — the request is good for 15 minutes.";

async function requestAndClient(
  sealed: string,
): Promise<{ request: AuthorizationRequest; client: OAuthClient }> {
  const request = unsealAuthorizationRequest(sealed);
  if (!request) throw new ConsentError(410, EXPIRED);
  const client = await AppDataSource.getRepository(OAuthClient).findOneBy({
    id: request.clientId,
  });
  if (!client) {
    throw new ConsentError(410, "This app is no longer registered with Genosyn. Connect it again.");
  }
  return { request, client };
}

export type ConsentCompany = {
  id: string;
  name: string;
  slug: string;
  role: Role;
  financeAccess: FinanceAccess;
  /** Whether this Member may connect the app to this company now. */
  canConnect: boolean;
  /** Why not, when they may not. */
  reason: string | null;
};

export type ConsentDetails = {
  app: {
    name: string;
    clientUri: string | null;
    /** Where the browser goes back to: the app's own address. */
    redirectUri: string;
    redirectOrigin: string;
  };
  member: { name: string; email: string };
  /** Set when the app asked for one company's endpoint: the choice is made. */
  requestedCompanyId: string | null;
  /** The companies the Member may pick from: only the requested one when there is one. */
  companies: ConsentCompany[];
  expiresAt: string;
};

const TWO_FACTOR_REQUIRED =
  "This company requires two-factor authentication. Turn it on in Account → Security first.";

async function companiesFor(user: User, only: string | null): Promise<ConsentCompany[]> {
  const memberships = await AppDataSource.getRepository(Membership).findBy(
    only ? { userId: user.id, companyId: only } : { userId: user.id },
  );
  if (!memberships.length) return [];
  const companies = await AppDataSource.getRepository(Company).findBy({
    id: In(memberships.map((membership) => membership.companyId)),
  });
  const byId = new Map(companies.map((company) => [company.id, company]));
  const twoFactor = companies.some((company) => company.requireTwoFactor)
    ? await hasTwoFactorMethod(user.id)
    : true;
  const rows: ConsentCompany[] = [];
  for (const membership of memberships) {
    const company = byId.get(membership.companyId);
    if (!company) continue;
    const roleAllows = mayConnectApps(membership.role);
    const twoFactorAllows = !company.requireTwoFactor || twoFactor;
    rows.push({
      id: company.id,
      name: company.name,
      slug: company.slug,
      role: membership.role,
      financeAccess: financeAccessFor(membership.role, membership.financeAccess),
      canConnect: roleAllows && twoFactorAllows,
      reason: !roleAllows
        ? CONNECT_APPS_ROLE_REQUIRED
        : !twoFactorAllows
          ? TWO_FACTOR_REQUIRED
          : null,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the consent page shows the signed-in Member. */
export async function consentDetails(sealed: string, user: User): Promise<ConsentDetails> {
  const { request, client } = await requestAndClient(sealed);
  return {
    app: {
      name: client.name,
      clientUri: client.clientUri,
      redirectUri: request.redirectUri,
      redirectOrigin: new URL(request.redirectUri).origin,
    },
    member: { name: user.name, email: user.email },
    requestedCompanyId: request.companyId,
    companies: await companiesFor(user, request.companyId),
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

/**
 * The Member's answer. Either way the browser goes back to the app: with a
 * code to exchange, or with `access_denied`.
 */
export async function decideConsent(input: {
  sealed: string;
  user: User;
  decision: "allow" | "deny";
  companyId?: string;
}): Promise<{ redirectTo: string }> {
  const { request, client } = await requestAndClient(input.sealed);
  if (input.decision === "deny") {
    return {
      redirectTo: clientRedirect(request.redirectUri, {
        error: "access_denied",
        error_description: "The Member declined to connect this app.",
        state: request.state,
      }),
    };
  }
  const companyId = request.companyId ?? input.companyId?.toLowerCase();
  if (!companyId) throw new ConsentError(400, "Choose the company to connect the app to.");
  if (request.companyId && input.companyId && input.companyId.toLowerCase() !== request.companyId) {
    throw new ConsentError(400, "This app asked for another company's MCP server.");
  }
  const [company] = await companiesFor(input.user, companyId);
  if (!company) throw new ConsentError(403, "You are not a member of that company.");
  if (!company.canConnect)
    throw new ConsentError(403, company.reason ?? CONNECT_APPS_ROLE_REQUIRED);

  const code = await issueAuthorizationCode({
    clientId: client.id,
    userId: input.user.id,
    companyId: company.id,
    redirectUri: request.redirectUri,
    redirectUriGiven: request.redirectUriGiven,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: companyMcpResource(company.id),
    appName: client.name,
  });
  return { redirectTo: clientRedirect(request.redirectUri, { code, state: request.state }) };
}
