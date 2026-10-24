import { Request, Response, NextFunction, type RequestHandler } from "express";
import { createHash } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership, Role } from "../db/entities/Membership.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import type { ConnectedApp } from "../db/entities/ConnectedApp.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import { isInProcessRequest } from "../services/companyMcp/dispatch.js";
import { protectedResourceMetadataUrl } from "../services/mcpOauth/metadata.js";
import { connectedAppForAccessToken, isAccessToken } from "../services/mcpOauth/tokens.js";
import { hasTwoFactorMethod } from "../services/twoFactor.js";
import { CONNECT_APPS_ROLE_REQUIRED, mayConnectApps } from "../../shared/connectedApps.js";
import { config } from "../../config.js";
import { withRouteMetadata } from "./routeMetadata.js";
import {
  createUserSession,
  resolveUserSession,
  revokeCurrentUserSession,
  userSessionIdentity,
} from "../services/userSessions.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    user?: User;
    /** When set, the request is authenticated with a bearer credential — an
     * ApiKey or a connected app's access token — scoped to this company.
     * Downstream `requireCompanyMember` rejects any other company. */
    bearerCompanyId?: string;
    /** Resolved ApiKey row when the request used an API key. */
    apiKey?: ApiKey;
    /** The connected app whose OAuth access token authenticated the request:
     * at the Genosyn MCP server, and on the calls that server makes back into
     * the App for each tool. Every guard that refuses API keys refuses it. */
    connectedApp?: ConnectedApp;
    /** Company role resolved by requireCompanyMember. */
    companyRole?: Role;
    /** Full membership row resolved by requireCompanyMember — carries
     *  `financeAccess` and anything else route middleware needs without a
     *  second lookup. */
    membership?: Membership;
  }
}

/**
 * Token format is `gen_` followed by base64url-encoded 32 random bytes
 * (43 chars after the prefix). The DB stores sha256 of the suffix only —
 * the prefix is fixed metadata, not part of the secret.
 */
const TOKEN_PREFIX = "gen_";
const TOKEN_BODY_LEN = 43;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim() || null;
}

function apiKeyBody(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  if (body.length !== TOKEN_BODY_LEN) return null;
  // base64url alphabet only — guards against arbitrary garbage hitting sha256.
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  return body;
}

export function hashApiToken(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// Throttle `lastUsedAt` writes so a hot key under load doesn't churn the row
// on every request. 60 s resolution is plenty for a "last used" UI display.
const LAST_USED_DEBOUNCE_MS = 60_000;

/**
 * What one request's guards read from the database, kept for that request.
 *
 * About sixty routers are mounted under `/api/companies/:cid`, and each opens
 * with `requireAuth` and `requireCompanyMember`, so a request meets those
 * guards once for every router it passes on its way to the one that answers
 * it. They decide from the same inputs each time — the session cookie or the
 * `Authorization` header, the company in the URL, the Member — so each read
 * is made once and kept under exactly those inputs, and every later guard
 * decides again from the kept answer. A different input is a different entry,
 * read afresh. Nothing outlives the request, so the next one sees a revoked
 * key, an ended sign-in or a removed Member at once, and a read that fails is
 * not kept.
 */
const readsByRequest = new WeakMap<Request, Map<string, unknown>>();

async function readOncePerRequest<T>(
  req: Request,
  inputs: readonly unknown[],
  read: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify(inputs);
  let reads = readsByRequest.get(req);
  if (reads?.has(key)) return reads.get(key) as T;
  const value = await read();
  if (!reads) readsByRequest.set(req, (reads = new Map()));
  reads.set(key, value);
  return value;
}

type BearerPrincipal =
  | { user: User; key: ApiKey; app?: undefined }
  | { user: User; app: ConnectedApp; key?: undefined };

/** {@link readBearerAuth} once per request: every company router asks. */
function tryBearerAuth(
  req: Request,
  options: { connectedApps: boolean },
): Promise<BearerPrincipal | null> {
  return readOncePerRequest(
    req,
    [
      "bearer",
      req.headers.authorization ?? null,
      companyIdFromApiPath(req.originalUrl),
      options.connectedApps,
    ],
    () => readBearerAuth(req, options),
  );
}

/** The user who sent a session cookie, read once per request like the key. */
function sessionUser(req: Request): Promise<User | null> {
  const identity = userSessionIdentity(req.session);
  return readOncePerRequest(
    req,
    [
      "session",
      identity?.userId ?? null,
      identity?.userSessionId ?? null,
      identity?.sessionVersion ?? null,
      identity?.expiresAt ?? null,
    ],
    () => resolveUserSession(req.session),
  );
}

async function readBearerAuth(
  req: Request,
  options: { connectedApps: boolean },
): Promise<BearerPrincipal | null> {
  const token = bearerToken(req.headers.authorization);
  if (!token) return null;
  if (isAccessToken(token)) return tryConnectedAppAuth(req, token, options);
  const body = apiKeyBody(token);
  if (!body) return null;
  const tokenHash = hashApiToken(body);
  const keyRepo = AppDataSource.getRepository(ApiKey);
  const key = await keyRepo.findOneBy({ tokenHash });
  if (!key) return null;
  const now = new Date();
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return null;
  // API keys are company credentials, not replacements for a Member's
  // browser session. Fail closed unless the URL itself names the exact
  // company the key was minted for. This keeps account, invitation,
  // company-creation, and instance-operator surfaces browser-only even when a
  // route accidentally uses the broad `requireAuth` middleware.
  if (companyIdFromApiPath(req.originalUrl) !== key.companyId) return null;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: key.userId });
  if (!user) return null;
  // Membership is re-checked downstream by `requireCompanyMember` — we
  // deliberately don't gate at this seam so a key for a company the user has
  // since left fails with the same 403 a logged-out browser session would.
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    key.lastUsedAt = now;
    void keyRepo.save(key).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[apiKey] failed to update lastUsedAt:", err);
    });
  }
  return { user, key };
}

/** `/api/companies/<cid>/mcp` itself: the one URL a connected app's token is issued for. */
function isCompanyMcpEndpoint(originalUrl: string): boolean {
  return /^\/api\/companies\/[^/]+\/mcp\/?$/.test(originalUrl.split("?", 1)[0]);
}

/**
 * A connected app's access token is for the Genosyn MCP server alone — its
 * audience (RFC 8707) is the company's `/mcp` endpoint. So it is accepted at
 * that endpoint, where its guard asks for it (`connectedApps`), and on the
 * requests the server sends back through this App in memory for each tool
 * call, which no one outside the process can make; anywhere else it is not a
 * credential. Like a key, it opens only the company it was approved for.
 */
async function tryConnectedAppAuth(
  req: Request,
  token: string,
  options: { connectedApps: boolean },
): Promise<BearerPrincipal | null> {
  const atEndpoint = options.connectedApps && isCompanyMcpEndpoint(req.originalUrl);
  if (!atEndpoint && !isInProcessRequest(req)) return null;
  const app = await connectedAppForAccessToken(token);
  if (!app) return null;
  if (companyIdFromApiPath(req.originalUrl) !== app.companyId) return null;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: app.userId });
  if (!user) return null;
  return { user, app };
}

function authenticateBearer(req: Request, principal: BearerPrincipal): void {
  req.userId = principal.user.id;
  req.user = principal.user;
  if (principal.key) {
    req.apiKey = principal.key;
    req.bearerCompanyId = principal.key.companyId;
  } else {
    req.connectedApp = principal.app;
    req.bearerCompanyId = principal.app.companyId;
  }
}

/**
 * Whether the request carries a bearer credential — an API key or a connected
 * app's token — rather than a person's browser session. What a session alone
 * may do refuses both alike.
 */
export function usesBearerCredential(req: Pick<Request, "apiKey" | "connectedApp">): boolean {
  return Boolean(req.apiKey || req.connectedApp);
}

/** Return the company named by the canonical REST mount, or null otherwise. */
export function companyIdFromApiPath(originalUrl: string): string | null {
  const path = originalUrl.split("?", 1)[0];
  const match = /^\/api\/companies\/([^/]+)(?:\/|$)/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.get(AI_BROWSER_REQUEST_HEADER) === AI_BROWSER_REQUEST_VALUE) {
    return res.status(403).json({
      error:
        "Authenticated Genosyn APIs are unavailable inside an AI Browser. Use AI Employee Grants and governed tools.",
    });
  }
  // Cookie-session path — what the web UI uses.
  const uid = req.session?.userId as string | undefined;
  if (uid) {
    let user: User | null;
    try {
      user = await sessionUser(req);
    } catch (error) {
      // Express 4 drops a rejected promise; hand the failure to the error handler
      // so the client gets an answer instead of a socket left open.
      return next(error);
    }
    if (!user) {
      req.session = null;
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.userId = user.id;
    req.user = user;
    return next();
  }

  // Bearer-token path — programmatic access via API keys, and a connected
  // app's token on the Genosyn MCP server's own calls.
  let bearer: BearerPrincipal | null;
  try {
    bearer = await tryBearerAuth(req, { connectedApps: false });
  } catch (error) {
    return next(error);
  }
  if (bearer) {
    authenticateBearer(req, bearer);
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Authenticate with a bearer credential and nothing else: a company API key,
 * or the access token of an app a Member connected through OAuth.
 *
 * For surfaces that are programmatic by nature — the Genosyn MCP server — a
 * browser session must never be the credential: a page the Member has open
 * elsewhere cannot ride their cookie into it. So, unlike {@link requireAuth},
 * this never reads the session cookie, even when one is sent alongside a
 * token. A key is checked exactly as `requireAuth` checks it — live, minted
 * for the company the path names — and a connected app's token the same way,
 * here at the endpoint it was issued for. `requireCompanyMember` still has to
 * find the Member in that company.
 *
 * A refusal says `WWW-Authenticate: Bearer` with the endpoint's
 * protected-resource metadata (RFC 9728), which is how an MCP client that
 * signs in with OAuth finds where to do it.
 */
export async function requireBearerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  if (req.get(AI_BROWSER_REQUEST_HEADER) === AI_BROWSER_REQUEST_VALUE) {
    return res.status(403).json({
      error:
        "Authenticated Genosyn APIs are unavailable inside an AI Browser. Use AI Employee Grants and governed tools.",
    });
  }
  let bearer: BearerPrincipal | null;
  try {
    bearer = await tryBearerAuth(req, { connectedApps: true });
  } catch (error) {
    // Express 4 drops a rejected promise; hand the failure to the error handler
    // so the client gets an answer instead of a socket left open.
    return next(error);
  }
  if (!bearer) {
    const challenge = ['Bearer realm="Genosyn"'];
    const companyId = companyIdFromApiPath(req.originalUrl);
    if (companyId) {
      challenge.push(`resource_metadata="${protectedResourceMetadataUrl(companyId)}"`);
    }
    // RFC 6750 §3.1: name the error only when a bearer token was presented.
    if (bearerToken(req.headers.authorization)) challenge.push('error="invalid_token"');
    res.setHeader("WWW-Authenticate", challenge.join(", "));
    return res.status(401).json({
      error: req.headers.authorization
        ? "The API key or access token was not accepted: it is unknown, revoked or expired, or belongs to another company."
        : "An API key is required: send it as `Authorization: Bearer gen_…` (mint one at Settings → API keys), or connect an app that signs in with OAuth.",
    });
  }
  authenticateBearer(req, bearer);
  next();
}

export async function establishUserSession(
  req: Request,
  user: User,
  options: { secondFactor?: boolean } = {},
): Promise<void> {
  await revokeCurrentUserSession(req);
  const authenticatedAt = Date.now();
  req.session = {
    ...(await createUserSession(user)),
    authenticatedAt,
    ...(options.secondFactor ? { secondFactorAt: authenticatedAt } : {}),
  };
}

/**
 * Require a signed browser session after `requireAuth`. Sensitive account
 * operations use this explicitly; the bearer authenticator also denies API
 * keys outside `/api/companies/:cid` as a defense-in-depth default.
 */
export function requireBrowserSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (usesBearerCredential(req)) {
    return res.status(403).json({
      error: "This action requires a logged-in browser session",
    });
  }
  next();
}

/** A user's Membership of a company, or why `requireCompanyMember` refuses them. */
type CompanyStanding = Membership | "notMember" | "twoFactorRequired";

async function readCompanyStanding(
  companyId: string,
  userId: string,
  viaBearer: boolean,
): Promise<CompanyStanding> {
  const membership = await AppDataSource.getRepository(Membership).findOneBy({ companyId, userId });
  if (!membership) return "notMember";
  if (!viaBearer) {
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
    if (company?.requireTwoFactor && !(await hasTwoFactorMethod(userId))) {
      return "twoFactorRequired";
    }
  }
  return membership;
}

export async function requireCompanyMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const companyId = req.params.cid ?? req.params.companyId;
  if (!companyId) return res.status(400).json({ error: "Missing company id" });
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  // An ApiKey only unlocks the company it was minted for, even if the
  // owning user is a member of multiple companies — and a connected app the
  // company it was approved for. Reject before we hit the DB so a
  // wrong-company request is cheap.
  if (req.bearerCompanyId && req.bearerCompanyId !== companyId) {
    return res.status(403).json({
      error: req.connectedApp
        ? "This app is connected to a different company"
        : "API key is scoped to a different company",
    });
  }
  // A bearer credential was minted from a signed-in session, so the company's
  // two-factor rule is the session's to meet, as it always was for API keys.
  const viaBearer = usesBearerCredential(req);
  let standing: CompanyStanding;
  try {
    standing = await readOncePerRequest(req, ["companyMember", companyId, userId, viaBearer], () =>
      readCompanyStanding(companyId, userId, viaBearer),
    );
  } catch (error) {
    // Express 4 drops a rejected promise; answer through the error handler.
    return next(error);
  }
  if (standing === "notMember") return res.status(403).json({ error: "Forbidden" });
  if (standing === "twoFactorRequired") {
    return res.status(403).json({
      error: "This company requires two-factor authentication. Enable it in Account → Security.",
    });
  }
  // Who may connect an app is checked again on every request, so a Member
  // demoted below admin loses their connected apps with the role.
  if (req.connectedApp && !mayConnectApps(standing.role)) {
    return res.status(403).json({ error: CONNECT_APPS_ROLE_REQUIRED });
  }
  req.companyRole = standing.role;
  req.membership = standing;
  // Backwards compatibility for route code that still reads the old ad-hoc
  // property. New authorization middleware uses the typed companyRole field.
  (req as Request & { role: Role }).role = standing.role;
  next();
}

export function roleAtLeast(role: Role, candidate: Role): boolean {
  const order: Role[] = ["member", "admin", "owner"];
  return order.indexOf(candidate) >= order.indexOf(role);
}

export function requireCompanyRole(minimum: Role) {
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction): void | Response => {
      if (!req.companyRole || !roleAtLeast(minimum, req.companyRole)) {
        return res.status(403).json({ error: `${minimum} company role required` });
      }
      next();
    },
    // Read back by the OpenAPI document to say which role an operation needs.
    { kind: "companyRole", minimum, mutationsOnly: false },
  );
}

/** Keep reads collaborative while reserving configuration changes for admins. */
export function requireCompanyRoleForMutations(minimum: Role) {
  const gate = requireCompanyRole(minimum);
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction): void | Response => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        next();
        return;
      }
      return gate(req, res, next);
    },
    { kind: "companyRole", minimum, mutationsOnly: true },
  );
}

export type RoutePathMatcher = string | RegExp;

export function matchesRoutePath(path: string, matchers: readonly RoutePathMatcher[]): boolean {
  // Matched the way Express routes the request, not the way the caller spelled
  // it: wherever the two disagree, the guard skips itself and the handler still
  // runs.
  //
  // Case-insensitively, because a Router defaults to `caseSensitive: false`:
  // `POST /ROUTINE-FOLDERS` reaches the handler registered at
  // `/routine-folders`, so an ordinary Member could create a folder — or write
  // to Secrets, API keys, Repositories, or any other surface gated this way —
  // by shouting the path.
  //
  // Without a trailing slash, because a Router also defaults to `strict: false`:
  // `PATCH /meetings/calendars/:id/` reaches the handler registered at
  // `/meetings/calendars/:id`, which an anchored matcher such as
  // `/^\/meetings\/calendars\/[^/]+$/` did not see, so a Member could arm
  // auto-record on a calendar, or rewrite or delete an AI Employee, by ending
  // the path with "/". The root stays "/", so `/^\/$/` still matches it.
  //
  // Nothing else needs folding. `req.path` is the pathname the router itself
  // matches, and the other respellings (percent-encoding, doubled or dot
  // segments, backslashes) reach no handler or fall inside a `[^/]+` segment.
  //
  // Every matcher in the codebase is lowercase, uses `[^/]+` for variable
  // segments, and is written against the path without its trailing slash, so
  // normalizing can only make a guard match MORE paths, never fewer.
  const normalized = path.toLowerCase().replace(/\/+$/, "") || "/";
  return matchers.some((matcher) => {
    if (typeof matcher === "string") {
      return normalized === matcher || normalized.startsWith(`${matcher}/`);
    }
    return matcher.test(normalized);
  });
}

/**
 * Scope a router-level authorization guard to the paths that router owns.
 * Several company routers are mounted at `/api/companies/:cid`; without this
 * wrapper, a `.use()` guard in one router also intercepts unrelated routes
 * mounted after it.
 */
export function onRoutePaths(
  matchers: readonly RoutePathMatcher[],
  middleware: RequestHandler,
): RequestHandler {
  return withRouteMetadata<RequestHandler>(
    (req, res, next) => {
      if (!matchesRoutePath(req.path, matchers)) {
        next();
        return;
      }
      return middleware(req, res, next);
    },
    // The OpenAPI document evaluates the same matchers against each route's
    // path to know which operations the scoped guard covers.
    { kind: "pathScoped", matchers, middleware },
  );
}

/**
 * Gate a route to instance-level operators. `isMasterAdmin` is a global flag
 * on the User row — not a per-company `Membership.role` — so this layers on top
 * of `requireAuth`: a valid session or API-key user whose account carries the
 * flag. Used by the install-wide Admin + Backups routers; every other surface
 * stays company-scoped via `requireCompanyMember`.
 */
export async function requireMasterAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (usesBearerCredential(req)) {
    return res.status(403).json({
      error: "Instance administration requires a logged-in browser session",
    });
  }
  if (!req.user.isMasterAdmin) {
    return res.status(403).json({ error: "Master admin access required" });
  }
  if (!req.user.emailVerifiedAt) {
    return res
      .status(403)
      .json({ error: "Verify your email before using instance administration" });
  }
  if (config.security.multiTenant) {
    let enrolled: boolean;
    try {
      enrolled = await hasTwoFactorMethod(req.user.id);
    } catch (error) {
      // Express 4 drops a rejected promise; answer through the error handler.
      return next(error);
    }
    if (!enrolled) {
      return res.status(403).json({
        error: "Enable two-factor authentication before using instance administration",
        code: "SECOND_FACTOR_ENROLLMENT_REQUIRED",
      });
    }
    if (!req.session?.secondFactorAt) {
      return res.status(403).json({
        error: "Complete two-factor authentication before using instance administration",
        code: "SECOND_FACTOR_REQUIRED",
      });
    }
  }
  next();
}
