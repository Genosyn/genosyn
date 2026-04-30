import { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership, Role } from "../db/entities/Membership.js";
import { ApiKey } from "../db/entities/ApiKey.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    user?: User;
    /** When set, the request is authenticated via an ApiKey scoped to this
     * company. Downstream `requireCompanyMember` rejects any other company. */
    apiKeyCompanyId?: string;
    /** Resolved ApiKey row when the request used Bearer auth. */
    apiKey?: ApiKey;
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
  const user = await AppDataSource.getRepository(User).findOneBy({ id: key.userId });
  if (!user) return null;
  // Membership is re-checked downstream by `requireCompanyMember` — we
  // deliberately don't gate at this seam so a key for a company the user has
  // since left fails with the same 403 a logged-out browser session would.
  if (
    !key.lastUsedAt ||
    now.getTime() - key.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS
  ) {
    key.lastUsedAt = now;
    void keyRepo.save(key).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("[apiKey] failed to update lastUsedAt:", err);
    });
  }
  return { user, key };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Cookie-session path — what the web UI uses.
  const uid = req.session?.userId as string | undefined;
  if (uid) {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: uid });
    if (!user) {
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
    return res
      .status(403)
      .json({ error: "API key is scoped to a different company" });
  }
  const m = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId: req.userId,
  });
  if (!m) return res.status(403).json({ error: "Forbidden" });
  (req as Request & { role: Role }).role = m.role;
  next();
}

export function roleAtLeast(role: Role, candidate: Role): boolean {
  const order: Role[] = ["member", "admin", "owner"];
  return order.indexOf(candidate) >= order.indexOf(role);
}
