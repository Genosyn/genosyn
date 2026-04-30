import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { hashApiToken } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";

/**
 * Per-user API keys for the same REST surface the web UI hits. A key
 * authenticates as the User who minted it, but only unlocks the Company it
 * was scoped to (even if the User is a member of multiple companies). See
 * `middleware/auth.ts` for how Bearer tokens are resolved.
 *
 * Personal-not-shared by design: each member manages their own keys, and
 * revoking a Membership implicitly revokes the keys via the requireCompany
 * Member re-check at request time. A V2 "service account" model can land
 * later if shared keys are needed.
 *
 * The plaintext token is returned exactly once on create — never persisted,
 * never visible again. Revocation is soft so audit trails survive.
 */
export const apiKeysRouter = Router({ mergeParams: true });
apiKeysRouter.use(requireAuth);
apiKeysRouter.use(requireCompanyMember);

const TOKEN_PREFIX = "gen_";

function serialize(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    prefix: `${TOKEN_PREFIX}${k.prefix}`,
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    createdAt: k.createdAt.toISOString(),
  };
}

apiKeysRouter.get("/api-keys", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rows = await AppDataSource.getRepository(ApiKey).find({
    where: { companyId: cid, userId: req.userId },
    order: { createdAt: "DESC" },
  });
  res.json(rows.map(serialize));
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Optional ISO-8601 expiry. Past dates rejected. */
  expiresAt: z.string().datetime().nullable().optional(),
});

apiKeysRouter.post(
  "/api-keys",
  validateBody(createSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof createSchema>;

    // Don't let a leaked Bearer token mint more Bearer tokens. Key creation
    // must come from a real human session — that's the chain-of-custody root.
    if (req.apiKey) {
      return res
        .status(403)
        .json({ error: "API keys can only be created from a logged-in browser session." });
    }

    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      const d = new Date(body.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        return res.status(400).json({ error: "expiresAt must be in the future." });
      }
      expiresAt = d;
    }

    // 32 random bytes → 43 char base64url. The full token humans paste is
    // `gen_<body>`; only `body` gets sha256-hashed for storage.
    const tokenBody = randomBytes(32).toString("base64url");
    const tokenHash = hashApiToken(tokenBody);
    const prefix = tokenBody.slice(0, 8);
    const fullToken = `${TOKEN_PREFIX}${tokenBody}`;

    const repo = AppDataSource.getRepository(ApiKey);
    const k = repo.create({
      companyId: cid,
      userId: req.userId,
      name: body.name,
      prefix,
      tokenHash,
      expiresAt,
    });
    await repo.save(k);

    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "api_key.create",
      targetType: "api_key",
      targetId: k.id,
      targetLabel: k.name,
      metadata: { prefix: `${TOKEN_PREFIX}${prefix}` },
    });

    res.json({
      ...serialize(k),
      // The plaintext is returned ONCE. The client must surface it to the
      // user immediately and warn that it can't be shown again.
      token: fullToken,
    });
  },
);

apiKeysRouter.delete("/api-keys/:id", async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const repo = AppDataSource.getRepository(ApiKey);
  const k = await repo.findOneBy({ id, companyId: cid, userId: req.userId });
  if (!k) return res.status(404).json({ error: "Not found" });
  if (k.revokedAt) {
    // Idempotent — revoking a revoked key is a no-op rather than an error.
    return res.json(serialize(k));
  }
  k.revokedAt = new Date();
  await repo.save(k);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "api_key.revoke",
    targetType: "api_key",
    targetId: k.id,
    targetLabel: k.name,
    metadata: { prefix: `${TOKEN_PREFIX}${k.prefix}` },
  });
  res.json(serialize(k));
});
