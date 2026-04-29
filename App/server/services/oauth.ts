import crypto from "node:crypto";
import { getProvider } from "../integrations/index.js";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleRedirectUri,
  resolveGoogleScopes,
  type GoogleOauthConfig,
} from "../integrations/providers/google.js";
import {
  buildXAuthorizeUrl,
  exchangeXCode,
  generatePkceVerifier,
  pkceChallenge,
  resolveXScopes,
  xRedirectUri,
  type XOauthConfig,
} from "../integrations/providers/x.js";
import { decryptConnectionConfig, getConnection } from "./integrations.js";

/**
 * OAuth state store + provider dispatch.
 *
 * Each Connection carries its own `clientId` + `clientSecret`, so the start
 * handshake takes them as parameters, stashes them in the in-memory state
 * map, and the callback uses them to (a) exchange the auth code and
 * (b) embed them in the persisted Connection so future refreshes work
 * without reaching back to config.ts.
 *
 *   1. UI posts `startOauth({ companyId, userId, provider, label,
 *      clientId, clientSecret })` and receives `{ authorizeUrl }`.
 *   2. Google bounces the browser back to our shared callback:
 *      `${publicUrl}/api/integrations/oauth/callback/google?code=…&state=…`.
 *   3. The callback resolves `state` → the original company/provider/
 *      label/clientId/clientSecret, exchanges the code for tokens, asks
 *      the provider to shape them into a config blob, and creates the
 *      Connection.
 *
 * State tokens are kept in-process — same philosophy as the short-lived MCP
 * tokens. 10-minute TTL is plenty for a human to click "Allow"; if they
 * take longer we'd rather make them start again than widen the blast radius
 * of a leaked state string.
 */

export type OauthState = {
  state: string;
  userId: string;
  companyId: string;
  provider: string;
  label: string;
  clientId: string;
  clientSecret: string;
  /** Scope-group keys the user picked at start time. Stashed so the
   * callback can persist them on the new/updated connection. */
  scopeGroups: string[];
  expiresAt: number;
  /** When set, the callback updates this connection's tokens instead of
   * creating a new one — preserves the row id, label, and grants. */
  existingConnectionId?: string;
  /** PKCE code_verifier — required by X.com (and any other OAuth 2.0 +
   * PKCE provider we add). Stashed alongside state so the callback can
   * pass it to the token-exchange step. Empty string for non-PKCE flows. */
  codeVerifier?: string;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, OauthState>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of states) {
    if (v.expiresAt < now) states.delete(k);
  }
}

export function startOauth(args: {
  companyId: string;
  userId: string;
  provider: string;
  label: string;
  clientId: string;
  clientSecret: string;
  scopeGroups: string[];
  existingConnectionId?: string;
}): { authorizeUrl: string } {
  sweep();
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  const oauth = provider.catalog.oauth;
  if (!oauth) throw new Error(`${provider.catalog.name} has no OAuth metadata`);
  if (!args.clientId || !args.clientSecret) {
    throw new Error("clientId and clientSecret are required");
  }

  const state = crypto.randomBytes(24).toString("hex");
  // PKCE code_verifier — only emitted for providers that need it (X). For
  // Google's plain auth-code flow this is undefined and the callback skips
  // passing it.
  const codeVerifier = oauth.app === "x" ? generatePkceVerifier() : undefined;
  states.set(state, {
    state,
    userId: args.userId,
    companyId: args.companyId,
    provider: args.provider,
    label: args.label,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    scopeGroups: args.scopeGroups,
    expiresAt: Date.now() + STATE_TTL_MS,
    existingConnectionId: args.existingConnectionId,
    codeVerifier,
  });

  let authorizeUrl: string;
  switch (oauth.app) {
    case "google": {
      const scopes = resolveGoogleScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
      });
      authorizeUrl = buildGoogleAuthorizeUrl({
        state,
        scopes,
        clientId: args.clientId,
        redirectUri: googleRedirectUri(),
      });
      break;
    }
    case "x": {
      const scopes = resolveXScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
      });
      authorizeUrl = buildXAuthorizeUrl({
        state,
        scopes,
        clientId: args.clientId,
        redirectUri: xRedirectUri(),
        codeChallenge: pkceChallenge(codeVerifier!),
      });
      break;
    }
    default:
      throw new Error(`Unsupported OAuth app: ${oauth.app}`);
  }
  return { authorizeUrl };
}

/**
 * Reuse the clientId / clientSecret embedded in an existing OAuth
 * connection to start a fresh consent flow. The new state carries the
 * connection id so the callback can update tokens in place rather than
 * creating a duplicate row (which would orphan grants).
 */
export async function startOauthReconnect(args: {
  companyId: string;
  userId: string;
  connectionId: string;
  /** Scope-group keys to request this time. Falls back to whatever was
   * persisted on the existing connection — empty array on legacy rows
   * means "no groups picked", which the route layer translates into
   * "all groups" for backward-compat sanity. */
  scopeGroups?: string[];
}): Promise<{ authorizeUrl: string }> {
  const conn = await getConnection(args.companyId, args.connectionId);
  if (!conn) throw new Error("Connection not found");
  if (conn.authMode !== "oauth2") {
    throw new Error(
      `Connection is ${conn.authMode}, not OAuth — re-enter credentials in the matching modal.`,
    );
  }
  const provider = getProvider(conn.provider);
  if (!provider || !provider.catalog.oauth) {
    throw new Error(`${conn.provider} no longer supports OAuth`);
  }
  // GoogleOauthConfig and XOauthConfig both expose `clientId` /
  // `clientSecret` / `scopeGroups`; that is the only shape this function
  // cares about, so a structural narrowing covers every OAuth provider.
  const cfg = decryptConnectionConfig(conn) as Pick<
    GoogleOauthConfig & XOauthConfig,
    "clientId" | "clientSecret" | "scopeGroups"
  >;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Stored OAuth client credentials are missing — disconnect and create a new connection.",
    );
  }
  return startOauth({
    companyId: args.companyId,
    userId: args.userId,
    provider: conn.provider,
    label: conn.label,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scopeGroups: args.scopeGroups ?? cfg.scopeGroups ?? [],
    existingConnectionId: conn.id,
  });
}

/** Pop a state record — single-use. */
export function resolveOauthState(state: string): OauthState | null {
  sweep();
  const info = states.get(state);
  if (!info) return null;
  states.delete(state);
  if (info.expiresAt < Date.now()) return null;
  return info;
}

export type OauthApp = "google" | "x";

/**
 * Dispatch a finished OAuth handshake to the right provider helper. Called
 * from `/api/integrations/oauth/callback/:app`. Returns the provider id
 * (needed because the callback URL is keyed on the OAuth *app*, not the
 * integration itself — Google could back Gmail, Calendar, etc.).
 */
export async function finishOauth(args: {
  app: OauthApp;
  code: string;
  state: OauthState;
}): Promise<{
  provider: string;
  config: Record<string, unknown>;
  accountHint: string;
  companyId: string;
  label: string;
}> {
  const provider = getProvider(args.state.provider);
  if (!provider || !provider.buildOauthConfig) {
    throw new Error(`Provider ${args.state.provider} cannot finish OAuth`);
  }
  let tokens;
  let userInfo: Record<string, unknown>;
  switch (args.app) {
    case "google": {
      const exchanged = await exchangeGoogleCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        redirectUri: googleRedirectUri(),
      });
      tokens = exchanged.tokens;
      userInfo = exchanged.userInfo;
      break;
    }
    case "x": {
      if (!args.state.codeVerifier) {
        throw new Error("PKCE code_verifier missing from OAuth state");
      }
      const exchanged = await exchangeXCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        codeVerifier: args.state.codeVerifier,
        redirectUri: xRedirectUri(),
      });
      tokens = exchanged.tokens;
      userInfo = exchanged.userInfo;
      break;
    }
    default:
      throw new Error(`Unknown OAuth app: ${args.app}`);
  }
  const { config, accountHint } = provider.buildOauthConfig({
    tokens,
    userInfo,
    clientId: args.state.clientId,
    clientSecret: args.state.clientSecret,
    scopeGroups: args.state.scopeGroups,
  });
  return {
    provider: args.state.provider,
    config,
    accountHint,
    companyId: args.state.companyId,
    label: args.state.label,
  };
}
