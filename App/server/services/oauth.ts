import { getProvider } from "../integrations/index.js";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleRedirectUri,
  resolveScopeGroups,
  type GoogleOauthConfig,
} from "../integrations/providers/google/auth.js";
import {
  buildXAuthorizeUrl,
  exchangeXCode,
  generatePkceVerifier,
  pkceChallenge,
  resolveXScopes,
  xRedirectUri,
  type XOauthConfig,
} from "../integrations/providers/x.js";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  githubRedirectUri,
  resolveGithubScopes,
  type GithubOauthConfig,
} from "../integrations/providers/github-oauth.js";
import {
  buildRedditAuthorizeUrl,
  exchangeRedditCode,
  redditRedirectUri,
  resolveRedditScopes,
  type RedditOauthConfig,
} from "../integrations/providers/reddit.js";
import {
  buildLinkedinAuthorizeUrl,
  exchangeLinkedinCode,
  linkedinRedirectUri,
  resolveLinkedinScopes,
  type LinkedinOauthConfig,
} from "../integrations/providers/linkedin.js";
import {
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  microsoftRedirectUri,
  resolveMicrosoftScopes,
  type MicrosoftOauthConfig,
} from "../integrations/providers/microsoft-ads.js";
import { decryptConnectionConfig, getConnection } from "./integrations.js";
import { getRegisteredOauthApp } from "./oauthApps.js";
import { createAuthFlowState, consumeAuthFlowState } from "./authFlowState.js";
import { AppDataSource } from "../db/datasource.js";
import { MailAccount } from "../db/entities/MailAccount.js";

/**
 * OAuth state store + provider dispatch.
 *
 * A Connection carries its own `clientId` + `clientSecret`, so the start
 * handshake takes them as parameters, stores an encrypted single-use state
 * row, and the callback uses it to (a) exchange the auth code and
 * (b) embed them in the persisted Connection so future refreshes work
 * without reaching back to config.ts.
 *
 * When the caller omits them, they are resolved from the install-wide app a
 * master admin registered at Admin → Integrations (`services/oauthApps.ts`) —
 * that is what lets someone connect Gmail without first standing up their own
 * Google Cloud OAuth client. The resolved values are then persisted onto the
 * Connection exactly as a user-supplied pair would be, so token refresh and
 * reconnect stay a single code path that never reaches back to instance
 * settings.
 *
 *   1. UI posts `startOauth({ companyId, userId, provider, label })`, with
 *      `clientId` / `clientSecret` only when the Connection brings its own,
 *      and receives `{ authorizeUrl }`.
 *   2. Google bounces the browser back to our shared callback:
 *      `${publicUrl}/api/integrations/oauth/callback/google?code=…&state=…`.
 *   3. The callback resolves `state` → the original company/provider/
 *      label/clientId/clientSecret, exchanges the code for tokens, asks
 *      the provider to shape them into a config blob, and creates the
 *      Connection.
 *
 * Database-backed state means a callback may land on any replica. The row is
 * encrypted because it temporarily carries provider client credentials.
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
  /** Values for the catalog's `oauth.extraFields` (developer tokens,
   * account ids, safety caps) typed on the connect form. Carried through
   * the handshake so `buildOauthConfig` can persist them. */
  extraFields?: Record<string, string>;
  expiresAt: number;
  /** When set, the callback updates this connection's tokens instead of
   * creating a new one — preserves the row id, label, and grants. */
  existingConnectionId?: string;
  /** PKCE code_verifier — required by X.com (and any other OAuth 2.0 +
   * PKCE provider we add). Stashed alongside state so the callback can
   * pass it to the token-exchange step. Empty string for non-PKCE flows. */
  codeVerifier?: string;
  /**
   * Link the new Connection to a mailbox as soon as consent lands.
   *
   * Set when the handshake was started from the Email section, where the
   * person's intent was "connect my email" and not "register a Google
   * connection". Without it they came back from Google's consent screen to a
   * page that had not changed, and had to find a second Connect button on a
   * third screen to finish the thing they had already agreed to.
   */
  linkMailbox?: boolean;
};

const STATE_TTL_MS = 10 * 60 * 1000;

export async function startOauth(args: {
  companyId: string;
  userId: string;
  provider: string;
  label: string;
  /** Omit both to use the install-wide app registered at Admin → Integrations. */
  clientId?: string;
  clientSecret?: string;
  scopeGroups: string[];
  extraFields?: Record<string, string>;
  existingConnectionId?: string;
  /** See {@link OauthState.linkMailbox}. */
  linkMailbox?: boolean;
}): Promise<{ authorizeUrl: string }> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  const oauth = provider.catalog.oauth;
  if (!oauth) throw new Error(`${provider.catalog.name} has no OAuth metadata`);

  // Per-Connection credentials win when supplied; otherwise fall back to the
  // install-wide registration. Resolving here (rather than at the route) keeps
  // every caller — connect, reconnect, onboarding — on one rule.
  //
  // A pair is taken whole or not at all. Mixing a caller's client id with the
  // instance's secret would sail through consent and only fail at the token
  // exchange, after the user has already approved — so a half-filled pair
  // falls back to the registered app rather than being completed from it.
  const suppliedId = (args.clientId ?? "").trim();
  const suppliedSecret = (args.clientSecret ?? "").trim();
  const credentials =
    suppliedId && suppliedSecret
      ? { clientId: suppliedId, clientSecret: suppliedSecret }
      : await getRegisteredOauthApp(oauth.app);
  const clientId = credentials?.clientId ?? "";
  const clientSecret = credentials?.clientSecret ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      `No ${provider.catalog.name} OAuth client is available. Ask an instance admin to register one at Admin → Integrations, or supply a Client ID and Client Secret for this connection.`,
    );
  }

  // PKCE code_verifier — only emitted for providers that need it (X). For
  // Google's and GitHub's plain auth-code flows this is undefined and the
  // callback skips passing it.
  const codeVerifier = oauth.app === "x" ? generatePkceVerifier() : undefined;
  // Validate declared extra fields up front so a missing developer token
  // fails before the user round-trips through the consent screen.
  const extraFields: Record<string, string> = {};
  for (const field of oauth.extraFields ?? []) {
    const value = (args.extraFields?.[field.key] ?? "").trim();
    if (!value && field.required) {
      throw new Error(`${field.label} is required`);
    }
    if (value) extraFields[field.key] = value;
  }

  const expiresAt = Date.now() + STATE_TTL_MS;
  const statePayload: OauthState = {
    state: "",
    userId: args.userId,
    companyId: args.companyId,
    provider: args.provider,
    label: args.label,
    clientId,
    clientSecret,
    scopeGroups: args.scopeGroups,
    extraFields,
    expiresAt,
    existingConnectionId: args.existingConnectionId,
    codeVerifier,
    linkMailbox: args.linkMailbox === true,
  };
  const state = await createAuthFlowState("integration-oauth", statePayload, STATE_TTL_MS);

  let authorizeUrl: string;
  switch (oauth.app) {
    case "google": {
      // Resolve against the *provider's own* scope-group catalog (Workspace,
      // Analytics, Search Console each declare their own), not a hardcoded
      // Workspace list — so every Google-app integration requests the right
      // scopes.
      const scopes = resolveScopeGroups({
        keys: args.scopeGroups,
        groups: oauth.scopeGroups ?? [],
        baseline: oauth.scopes,
      });
      authorizeUrl = buildGoogleAuthorizeUrl({
        state,
        scopes,
        clientId,
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
        clientId,
        redirectUri: xRedirectUri(),
        codeChallenge: pkceChallenge(codeVerifier!),
      });
      break;
    }
    case "github": {
      const scopes = resolveGithubScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
      });
      authorizeUrl = buildGithubAuthorizeUrl({
        state,
        scopes,
        clientId,
        redirectUri: githubRedirectUri(),
      });
      break;
    }
    case "reddit": {
      const scopes = resolveRedditScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
        // Resolve against the requesting provider's own catalog so
        // reddit-ads (sharing the "reddit" OAuth app) gets its ads scopes.
        groups: oauth.scopeGroups ?? [],
      });
      authorizeUrl = buildRedditAuthorizeUrl({
        state,
        scopes,
        clientId,
        redirectUri: redditRedirectUri(),
      });
      break;
    }
    case "linkedin": {
      const scopes = resolveLinkedinScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
      });
      authorizeUrl = buildLinkedinAuthorizeUrl({
        state,
        scopes,
        clientId,
        redirectUri: linkedinRedirectUri(),
      });
      break;
    }
    case "microsoft": {
      const scopes = resolveMicrosoftScopes({
        scopeGroups: args.scopeGroups,
        baseline: oauth.scopes,
      });
      authorizeUrl = buildMicrosoftAuthorizeUrl({
        state,
        scopes,
        clientId,
        redirectUri: microsoftRedirectUri(),
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
  // GoogleOauthConfig, XOauthConfig, GithubOauthConfig, RedditOauthConfig,
  // and LinkedinOauthConfig all expose `clientId` / `clientSecret` /
  // `scopeGroups`; that is the only shape this function cares about, so a
  // structural narrowing covers every OAuth provider.
  const cfg = decryptConnectionConfig(conn) as Pick<
    GoogleOauthConfig &
      XOauthConfig &
      GithubOauthConfig &
      RedditOauthConfig &
      LinkedinOauthConfig &
      MicrosoftOauthConfig,
    "clientId" | "clientSecret" | "scopeGroups"
  >;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Stored OAuth client credentials are missing — disconnect and create a new connection.",
    );
  }
  // Carry any declared extra fields (developer token, account ids, caps)
  // forward from the stored config so a reconnect doesn't wipe them.
  const extraFields: Record<string, string> = {};
  for (const field of provider.catalog.oauth.extraFields ?? []) {
    const value = (cfg as Record<string, unknown>)[field.key];
    if (typeof value === "string" && value) extraFields[field.key] = value;
    else if (typeof value === "number") extraFields[field.key] = String(value);
  }
  let scopeGroups = args.scopeGroups ?? cfg.scopeGroups ?? [];
  const linkedMailbox = await AppDataSource.getRepository(MailAccount).findOneBy({
    companyId: args.companyId,
    connectionId: conn.id,
  });
  if (linkedMailbox && conn.provider === "google") {
    if (args.scopeGroups && !args.scopeGroups.includes("mail")) {
      throw new Error(
        "This Connection backs a mailbox. Reconnect it with the Gmail product selected.",
      );
    }
    // Legacy Connections may pre-date persisted scope groups. Preserve their
    // mailbox capability instead of silently starting an identity-only flow.
    if (!scopeGroups.includes("mail")) scopeGroups = [...scopeGroups, "mail"];
  }
  // A Connection created from the install-wide app should follow that app when
  // its secret is rotated — otherwise rotating would quietly break every
  // mailbox on the instance with no in-place fix, since reconnect is the only
  // path that preserves grants. Identity is the client id: same id means this
  // Connection *is* the instance app, so take the current secret. A different
  // id means the company deliberately brought its own client, and that keeps
  // winning untouched.
  const registered = await getRegisteredOauthApp(provider.catalog.oauth.app);
  const followsInstanceApp = !!registered && registered.clientId === cfg.clientId;

  return startOauth({
    companyId: args.companyId,
    userId: args.userId,
    provider: conn.provider,
    label: conn.label,
    clientId: followsInstanceApp ? undefined : cfg.clientId,
    clientSecret: followsInstanceApp ? undefined : cfg.clientSecret,
    scopeGroups,
    extraFields,
    existingConnectionId: conn.id,
  });
}

/** Pop a state record — single-use. */
export async function resolveOauthState(state: string): Promise<OauthState | null> {
  const info = await consumeAuthFlowState<OauthState>("integration-oauth", state);
  if (!info || info.expiresAt < Date.now()) return null;
  return { ...info, state };
}

export type OauthApp = "google" | "x" | "github" | "reddit" | "linkedin" | "microsoft";

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
    case "github": {
      const exchanged = await exchangeGithubCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        redirectUri: githubRedirectUri(),
      });
      tokens = exchanged.tokens;
      userInfo = exchanged.userInfo;
      break;
    }
    case "reddit": {
      const exchanged = await exchangeRedditCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        redirectUri: redditRedirectUri(),
      });
      tokens = exchanged.tokens;
      userInfo = exchanged.userInfo;
      break;
    }
    case "linkedin": {
      const exchanged = await exchangeLinkedinCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        redirectUri: linkedinRedirectUri(),
      });
      tokens = exchanged.tokens;
      userInfo = exchanged.userInfo;
      break;
    }
    case "microsoft": {
      const exchanged = await exchangeMicrosoftCode({
        code: args.code,
        clientId: args.state.clientId,
        clientSecret: args.state.clientSecret,
        redirectUri: microsoftRedirectUri(),
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
    extraFields: args.state.extraFields,
  });
  return {
    provider: args.state.provider,
    config,
    accountHint,
    companyId: args.state.companyId,
    label: args.state.label,
  };
}
