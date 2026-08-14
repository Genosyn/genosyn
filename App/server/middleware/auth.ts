import { Request, Response, NextFunction, type RequestHandler } from "express";
import { createHash } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership, Role } from "../db/entities/Membership.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import { hasTwoFactorMethod } from "../services/twoFactor.js";
import { config } from "../../config.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    user?: User;
    /** When set, the request is authenticated via an ApiKey scoped to this
     * company. Downstream `requireCompanyMember` rejects any other company. */
    apiKeyCompanyId?: string;
    /** Resolved ApiKey row when the request used Bearer auth. */
    apiKey?: ApiKey;
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

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const value = trimmed.slice(7).trim();
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  const body = value.slice(TOKEN_PREFIX.length);
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

async function tryBearerAuth(req: Request): Promise<{ user: User; key: ApiKey } | null> {
  const body = parseBearer(req.headers.authorization);
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
    const user = await AppDataSource.getRepository(User).findOneBy({ id: uid });
    if (!user || req.session?.sessionVersion !== user.sessionVersion) {
      req.session = null;
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.userId = user.id;
    req.user = user;
    return next();
  }

  // Bearer-token path — programmatic access via API keys.
  const bearer = await tryBearerAuth(req);
  if (bearer) {
    req.userId = bearer.user.id;
    req.user = bearer.user;
    req.apiKey = bearer.key;
    req.apiKeyCompanyId = bearer.key.companyId;
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

export function establishUserSession(req: Request, user: User): void {
  req.session = {
    userId: user.id,
    sessionVersion: user.sessionVersion,
    authenticatedAt: Date.now(),
  };
}

export const DEFAULT_RECENT_AUTH_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Reusable step-up seam for high-impact mutations. It intentionally requires
 * a browser cookie: API keys never carry human-presence evidence. Callers may
 * also require proof that a second factor completed in this same session.
 */
export function requireRecentAuthentication(
  options: { maxAgeMs?: number; requireSecondFactor?: boolean } = {},
): RequestHandler {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RECENT_AUTH_MAX_AGE_MS;
  return (req, res, next) => {
    if (!req.user || req.apiKey) {
      return res.status(403).json({
        error: "This action requires a recently authenticated browser session",
        code: "REAUTHENTICATION_REQUIRED",
      });
    }
    const now = Date.now();
    const authenticatedAt = req.session?.authenticatedAt;
    const secondFactorAt = req.session?.secondFactorAt;
    if (!authenticatedAt || now - authenticatedAt > maxAgeMs) {
      return res.status(403).json({
        error: "Sign in again before performing this action",
        code: "REAUTHENTICATION_REQUIRED",
      });
    }
    if (
      options.requireSecondFactor &&
      (!secondFactorAt || secondFactorAt < authenticatedAt || now - secondFactorAt > maxAgeMs)
    ) {
      return res.status(403).json({
        error: "Complete two-factor authentication before performing this action",
        code: "SECOND_FACTOR_REQUIRED",
      });
    }
    next();
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
  if (req.apiKey) {
    return res.status(403).json({
      error: "This action requires a logged-in browser session",
    });
  }
  next();
}

export async function requireCompanyMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const companyId = req.params.cid ?? req.params.companyId;
  if (!companyId) return res.status(400).json({ error: "Missing company id" });
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  // An ApiKey only unlocks the company it was minted for, even if the
  // owning user is a member of multiple companies. Reject before we hit
  // the DB so a wrong-company request is cheap.
  if (req.apiKeyCompanyId && req.apiKeyCompanyId !== companyId) {
    return res.status(403).json({ error: "API key is scoped to a different company" });
  }
  const m = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId: req.userId,
  });
  if (!m) return res.status(403).json({ error: "Forbidden" });
  if (!req.apiKey) {
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
    if (company?.requireTwoFactor && !(await hasTwoFactorMethod(req.userId))) {
      return res.status(403).json({
        error: "This company requires two-factor authentication. Enable it in Account → Security.",
      });
    }
  }
  req.companyRole = m.role;
  req.membership = m;
  // Backwards compatibility for route code that still reads the old ad-hoc
  // property. New authorization middleware uses the typed companyRole field.
  (req as Request & { role: Role }).role = m.role;
  next();
}

export function roleAtLeast(role: Role, candidate: Role): boolean {
  const order: Role[] = ["member", "admin", "owner"];
  return order.indexOf(candidate) >= order.indexOf(role);
}

export function requireCompanyRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (!req.companyRole || !roleAtLeast(minimum, req.companyRole)) {
      return res.status(403).json({ error: `${minimum} company role required` });
    }
    next();
  };
}

/** Keep reads collaborative while reserving configuration changes for admins. */
export function requireCompanyRoleForMutations(minimum: Role) {
  const gate = requireCompanyRole(minimum);
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    return gate(req, res, next);
  };
}

export type RoutePathMatcher = string | RegExp;

export function matchesRoutePath(path: string, matchers: readonly RoutePathMatcher[]): boolean {
  return matchers.some((matcher) => {
    if (typeof matcher === "string") {
      return path === matcher || path.startsWith(`${matcher}/`);
    }
    return matcher.test(path);
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
  return (req, res, next) => {
    if (!matchesRoutePath(req.path, matchers)) {
      next();
      return;
    }
    return middleware(req, res, next);
  };
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
  if (req.apiKey) {
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
    if (!(await hasTwoFactorMethod(req.user.id))) {
      return res.status(403).json({
        error: "Enable two-factor authentication before using instance administration",
        code: "SECOND_FACTOR_ENROLLMENT_REQUIRED",
      });
    }
    const authenticatedAt = req.session?.authenticatedAt;
    const secondFactorAt = req.session?.secondFactorAt;
    const now = Date.now();
    if (
      !authenticatedAt ||
      !secondFactorAt ||
      secondFactorAt < authenticatedAt ||
      now - authenticatedAt > DEFAULT_RECENT_AUTH_MAX_AGE_MS ||
      now - secondFactorAt > DEFAULT_RECENT_AUTH_MAX_AGE_MS
    ) {
      return res.status(403).json({
        error: "Sign in with two-factor authentication again before using instance administration",
        code: "SECOND_FACTOR_REQUIRED",
      });
    }
  }
  next();
}
