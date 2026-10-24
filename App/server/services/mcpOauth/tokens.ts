import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IsNull, LessThanOrEqual } from "typeorm";
import {
  CONNECTED_APP_ACCESS_TOKEN_SECONDS,
  CONNECTED_APP_IDLE_DAYS,
  mayConnectApps,
} from "../../../shared/connectedApps.js";
import { AppDataSource } from "../../db/datasource.js";
import { ConnectedApp, type ConnectedAppRevocation } from "../../db/entities/ConnectedApp.js";
import { ConnectedAppToken } from "../../db/entities/ConnectedAppToken.js";
import { Membership } from "../../db/entities/Membership.js";
import type { OAuthClient } from "../../db/entities/OAuthClient.js";
import { recordAudit } from "../audit.js";
import {
  compareAndSetAuthFlowState,
  createAuthFlowState,
  readAuthFlowState,
} from "../authFlowState.js";
import { OAuthProtocolError, touchClient } from "./clients.js";
import { companyIdFromResource } from "./metadata.js";

/**
 * A connected app's tokens: the authorization code a Member's approval
 * produces, the access and refresh tokens it is exchanged for, and what keeps
 * them honest.
 *
 * Every token is opaque — 32 random bytes behind a prefix that says what it is
 * — and only its sha256 is stored, as with API keys. No JWT: whether a token
 * still works is always the database's answer, so revoking an app or removing
 * its Member takes effect on the next request.
 *
 * - **Codes** live five minutes in `AuthFlowState` and work once. The code is
 *   bound to the app, its redirect URI and its PKCE challenge (S256 only); a
 *   second exchange of the same code revokes the app the first one created.
 * - **Access tokens** (`gat_`) last an hour and work only at their company's
 *   MCP endpoint (`middleware/auth.ts`).
 * - **Refresh tokens** (`grt_`) last 30 days and are spent on use: each
 *   refresh returns a new pair. Presenting a spent one again — a stolen copy —
 *   disconnects the app, except within a few seconds of its first use, which
 *   is a client refreshing twice at once rather than a thief.
 */

export const ACCESS_TOKEN_PREFIX = "gat_";
export const REFRESH_TOKEN_PREFIX = "grt_";
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

/** How long an authorization code may wait to be exchanged. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;

/** A spent refresh token presented again this soon is a concurrent refresh, not theft. */
export const REFRESH_REUSE_GRACE_MS = 30_000;

const CODE_KIND = "mcp_oauth_code";

/** Same debounce as API keys: "last used" is for people, not an access log. */
const LAST_USED_DEBOUNCE_MS = 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` is shaped like a connected app's access token. */
export function isAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX) && TOKEN_BODY.test(token.slice(4));
}

function mint(prefix: string): { token: string; hash: string } {
  const token = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

const invalidGrant = (description: string) => new OAuthProtocolError("invalid_grant", description);

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

export function isPkceValue(value: string): boolean {
  return PKCE_VALUE.test(value);
}

/** The S256 code challenge for a verifier: base64url(sha256(verifier)). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sameResource(requested: string, granted: string): boolean {
  const requestedCompany = companyIdFromResource(requested);
  return requestedCompany !== null && requestedCompany === companyIdFromResource(granted);
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/** A new access and refresh token for `app`; its 30 days start again. */
async function issueTokens(app: ConnectedApp, now: Date): Promise<TokenResponse> {
  const access = mint(ACCESS_TOKEN_PREFIX);
  const refresh = mint(REFRESH_TOKEN_PREFIX);
  const accessExpiresAt = new Date(now.getTime() + CONNECTED_APP_ACCESS_TOKEN_SECONDS * 1000);
  const refreshExpiresAt = new Date(now.getTime() + CONNECTED_APP_IDLE_DAYS * 86_400_000);
  await AppDataSource.transaction(async (manager) => {
    const tokens = manager.getRepository(ConnectedAppToken);
    await tokens.insert([
      {
        connectedAppId: app.id,
        kind: "access",
        tokenHash: access.hash,
        expiresAt: accessExpiresAt,
        usedAt: null,
      },
      {
        connectedAppId: app.id,
        kind: "refresh",
        tokenHash: refresh.hash,
        expiresAt: refreshExpiresAt,
        usedAt: null,
      },
    ]);
    await manager
      .getRepository(ConnectedApp)
      .update({ id: app.id }, { expiresAt: refreshExpiresAt });
  });
  app.expiresAt = refreshExpiresAt;
  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: CONNECTED_APP_ACCESS_TOKEN_SECONDS,
    refresh_token: refresh.token,
    scope: app.scope,
  };
}

/** What a Member's approval carries to the token endpoint, sealed in `AuthFlowState`. */
export type AuthorizationCodePayload = {
  /** `OAuthClient.id`. */
  clientId: string;
  userId: string;
  companyId: string;
  redirectUri: string;
  /** The authorization request named the redirect URI, so the token request must too. */
  redirectUriGiven: boolean;
  codeChallenge: string;
  scope: string;
  resource: string;
  appName: string;
  /** Set when the code is exchanged: the connected app it created. */
  redeemedBy?: string;
};

export function issueAuthorizationCode(payload: AuthorizationCodePayload): Promise<string> {
  return createAuthFlowState(CODE_KIND, payload, AUTHORIZATION_CODE_TTL_MS);
}

async function stillMayConnect(companyId: string, userId: string): Promise<boolean> {
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId,
  });
  return Boolean(membership && mayConnectApps(membership.role));
}

/** The authorization_code grant (RFC 6749 §4.1.3, with PKCE per RFC 7636 §4.6). */
export async function exchangeAuthorizationCode(input: {
  client: OAuthClient;
  code: string;
  redirectUri?: string;
  codeVerifier?: string;
  resource?: string;
}): Promise<TokenResponse> {
  const snapshot = await readAuthFlowState<AuthorizationCodePayload>(CODE_KIND, input.code);
  if (!snapshot) throw invalidGrant("The authorization code is unknown, expired or already used.");
  const payload = snapshot.payload;
  if (payload.redeemedBy) {
    // A code is used once. A second use means a copy is loose, so whatever
    // the first one issued is withdrawn too (RFC 6749 §4.1.2).
    await revokeConnectedApp(payload.redeemedBy, "reuse");
    throw invalidGrant("The authorization code was already used.");
  }
  if (payload.clientId !== input.client.id) {
    throw invalidGrant("The authorization code was issued to another client.");
  }
  if (payload.redirectUriGiven || input.redirectUri !== undefined) {
    if (input.redirectUri !== payload.redirectUri) {
      throw invalidGrant("redirect_uri does not match the one in the authorization request.");
    }
  }
  if (!input.codeVerifier) {
    throw new OAuthProtocolError("invalid_request", "code_verifier is required (PKCE).");
  }
  if (!isPkceValue(input.codeVerifier) || s256(input.codeVerifier) !== payload.codeChallenge) {
    throw invalidGrant(
      "PKCE verification failed: code_verifier does not match the code_challenge.",
    );
  }
  if (input.resource !== undefined && !sameResource(input.resource, payload.resource)) {
    throw new OAuthProtocolError(
      "invalid_target",
      "resource must be the MCP endpoint the app was approved for.",
    );
  }
  if (!(await stillMayConnect(payload.companyId, payload.userId))) {
    throw invalidGrant(
      "The Member who approved this app can no longer connect apps in this company.",
    );
  }

  const appId = randomUUID();
  const claimed = await compareAndSetAuthFlowState(CODE_KIND, input.code, snapshot, {
    ...payload,
    redeemedBy: appId,
  });
  if (!claimed) throw invalidGrant("The authorization code was already used.");

  const now = new Date();
  const repo = AppDataSource.getRepository(ConnectedApp);
  const app = repo.create({
    id: appId,
    companyId: payload.companyId,
    userId: payload.userId,
    oauthClientId: input.client.id,
    name: payload.appName,
    redirectUri: payload.redirectUri,
    scope: payload.scope,
    resource: payload.resource,
    lastUsedAt: null,
    expiresAt: new Date(now.getTime() + CONNECTED_APP_IDLE_DAYS * 86_400_000),
    revokedAt: null,
    revokedReason: null,
  });
  await repo.insert(app);
  touchClient(input.client);
  await recordAudit({
    companyId: app.companyId,
    actorUserId: app.userId,
    action: "connected_app.connect",
    targetType: "connected_app",
    targetId: app.id,
    targetLabel: app.name,
    metadata: { clientId: input.client.clientId, redirectUri: app.redirectUri },
  });
  return issueTokens(app, now);
}

/** The refresh_token grant (RFC 6749 §6), rotating the refresh token every time. */
export async function refreshTokens(input: {
  client: OAuthClient;
  refreshToken: string;
  resource?: string;
}): Promise<TokenResponse> {
  const now = new Date();
  const tokens = AppDataSource.getRepository(ConnectedAppToken);
  const row = input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)
    ? await tokens.findOneBy({ tokenHash: hashToken(input.refreshToken), kind: "refresh" })
    : null;
  if (!row) throw invalidGrant("The refresh token is unknown or expired. Connect the app again.");
  const app = await AppDataSource.getRepository(ConnectedApp).findOneBy({
    id: row.connectedAppId,
  });
  if (!app || app.revokedAt) throw invalidGrant("This app was disconnected. Connect it again.");
  if (app.oauthClientId !== input.client.id) {
    throw invalidGrant("The refresh token was issued to another client.");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw invalidGrant("The refresh token expired. Connect the app again.");
  }
  // A requested scope is ignored, as at authorization: there is only `mcp`,
  // so a refresh can never widen what the app holds, and the response says so.
  if (input.resource !== undefined && !sameResource(input.resource, app.resource)) {
    throw new OAuthProtocolError(
      "invalid_target",
      "resource must be the MCP endpoint the app was approved for.",
    );
  }
  if (row.usedAt && now.getTime() - row.usedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
    await revokeConnectedApp(app, "reuse");
    throw invalidGrant(
      "This refresh token was already used, so the app was disconnected to be safe. Connect it again.",
    );
  }
  if (!(await stillMayConnect(app.companyId, app.userId))) {
    throw invalidGrant(
      "The Member who approved this app can no longer connect apps in this company.",
    );
  }
  if (!row.usedAt) {
    // Spend it. Losing this race means another request spent it a moment
    // ago — the same client refreshing twice — which the grace above allows.
    await tokens.update({ id: row.id, usedAt: IsNull() }, { usedAt: now });
  }
  // Spent tokens are kept until they expire, to recognize a second use; the
  // rest of this app's expired rows can go now.
  await tokens.delete({ connectedAppId: app.id, expiresAt: LessThanOrEqual(now) });
  return issueTokens(app, now);
}

/**
 * Withdraw a connected app: its tokens stop working at once. Soft, so the
 * audit log keeps the row it points at. Idempotent.
 */
export async function revokeConnectedApp(
  target: ConnectedApp | string,
  reason: ConnectedAppRevocation,
  actorUserId: string | null = null,
): Promise<ConnectedApp | null> {
  const repo = AppDataSource.getRepository(ConnectedApp);
  const app = typeof target === "string" ? await repo.findOneBy({ id: target }) : target;
  if (!app || app.revokedAt) return app;
  const now = new Date();
  const result = await repo.update(
    { id: app.id, revokedAt: IsNull() },
    { revokedAt: now, revokedReason: reason },
  );
  if (result.affected !== 1) return repo.findOneBy({ id: app.id });
  await AppDataSource.getRepository(ConnectedAppToken).delete({ connectedAppId: app.id });
  app.revokedAt = now;
  app.revokedReason = reason;
  await recordAudit({
    companyId: app.companyId,
    actorKind: actorUserId ? "user" : "system",
    actorUserId,
    action: "connected_app.revoke",
    targetType: "connected_app",
    targetId: app.id,
    targetLabel: app.name,
    metadata: { reason },
  });
  return app;
}

/**
 * Token revocation (RFC 7009) by the app itself: a refresh token disconnects
 * the app, an access token ends just that token. A token the client does not
 * own, or that does not exist, is ignored — the answer is the same either way.
 */
export async function revokeTokenForClient(client: OAuthClient, token: string): Promise<void> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) && !token.startsWith(REFRESH_TOKEN_PREFIX)) return;
  const tokens = AppDataSource.getRepository(ConnectedAppToken);
  const row = await tokens.findOneBy({ tokenHash: hashToken(token) });
  if (!row) return;
  const app = await AppDataSource.getRepository(ConnectedApp).findOneBy({
    id: row.connectedAppId,
  });
  if (!app || app.oauthClientId !== client.id) return;
  if (row.kind === "access") {
    await tokens.delete({ id: row.id });
    return;
  }
  await revokeConnectedApp(app, "app");
}

/**
 * The connected app an access token belongs to, when the token is live and
 * the app still connected; otherwise null. Where the token may be used is the
 * caller's business (`middleware/auth.ts`).
 */
export async function connectedAppForAccessToken(token: string): Promise<ConnectedApp | null> {
  if (!isAccessToken(token)) return null;
  const row = await AppDataSource.getRepository(ConnectedAppToken).findOneBy({
    tokenHash: hashToken(token),
    kind: "access",
  });
  const now = new Date();
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  const repo = AppDataSource.getRepository(ConnectedApp);
  const app = await repo.findOneBy({ id: row.connectedAppId });
  if (!app || app.revokedAt) return null;
  if (!app.lastUsedAt || now.getTime() - app.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    app.lastUsedAt = now;
    void repo.update({ id: app.id }, { lastUsedAt: now }).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[connectedApp] failed to update lastUsedAt:", error);
    });
  }
  return app;
}

/** Delete tokens past their expiry. Spent refresh tokens stay until then. */
export async function sweepExpiredConnectedAppTokens(now = new Date()): Promise<number> {
  const result = await AppDataSource.getRepository(ConnectedAppToken).delete({
    expiresAt: LessThanOrEqual(now),
  });
  return result.affected ?? 0;
}
