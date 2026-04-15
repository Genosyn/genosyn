import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Secret } from "../db/entities/Secret.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/secret.js";
import { recordAudit } from "../services/audit.js";

/**
 * Per-company secrets vault. Values are encrypted at rest and never leave the
 * server unmasked — the list endpoint returns only a masked preview. On
 * spawn, the runner decrypts each secret and merges them into the child's
 * env (see buildProviderEnv).
 *
 * Names are validated as POSIX-style env var identifiers so they can be used
 * directly. A small blacklist prevents overriding reserved keys the runner
 * uses for its own auth plumbing.
 */
export const secretsRouter = Router({ mergeParams: true });
secretsRouter.use(requireAuth);
secretsRouter.use(requireCompanyMember);

const RESERVED_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_DATA_HOME",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
]);

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "Uppercase letters, digits, and underscores only; must start with a letter or underscore");

function serialize(s: Secret) {
  let preview = "••••";
  try {
    preview = maskSecret(decryptSecret(s.encryptedValue));
  } catch {
    preview = "••••";
  }
  return {
    id: s.id,
    companyId: s.companyId,
    name: s.name,
    description: s.description,
    preview,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

secretsRouter.get("/secrets", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const rows = await AppDataSource.getRepository(Secret).find({
    where: { companyId: cid },
    order: { name: "ASC" },
  });
  res.json(rows.map(serialize));
});

const createSchema = z.object({
  name: nameSchema,
  value: z.string().min(1).max(10_000),
  description: z.string().max(500).optional(),
});

secretsRouter.post("/secrets", validateBody(createSchema), async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const body = req.body as z.infer<typeof createSchema>;
  if (RESERVED_NAMES.has(body.name)) {
    return res
      .status(400)
      .json({ error: `"${body.name}" is reserved by the runner and can't be used as a secret name.` });
  }
  const repo = AppDataSource.getRepository(Secret);
  const existing = await repo.findOneBy({ companyId: cid, name: body.name });
  if (existing) {
    return res.status(409).json({ error: "A secret with that name already exists" });
  }
  const s = repo.create({
    companyId: cid,
    name: body.name,
    encryptedValue: encryptSecret(body.value),
    description: body.description ?? "",
  });
  await repo.save(s);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "secret.create",
    targetType: "secret",
    targetId: s.id,
    targetLabel: s.name,
  });
  res.json(serialize(s));
});

const patchSchema = z.object({
  value: z.string().min(1).max(10_000).optional(),
  description: z.string().max(500).optional(),
});

secretsRouter.patch("/secrets/:sid", validateBody(patchSchema), async (req, res) => {
  const { cid, sid } = req.params as Record<string, string>;
  const body = req.body as z.infer<typeof patchSchema>;
  const repo = AppDataSource.getRepository(Secret);
  const s = await repo.findOneBy({ id: sid, companyId: cid });
  if (!s) return res.status(404).json({ error: "Not found" });
  const rotated = typeof body.value === "string";
  if (rotated) s.encryptedValue = encryptSecret(body.value as string);
  if (typeof body.description === "string") s.description = body.description;
  await repo.save(s);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: rotated ? "secret.rotate" : "secret.update",
    targetType: "secret",
    targetId: s.id,
    targetLabel: s.name,
  });
  res.json(serialize(s));
});

secretsRouter.delete("/secrets/:sid", async (req, res) => {
  const { cid, sid } = req.params as Record<string, string>;
  const repo = AppDataSource.getRepository(Secret);
  const s = await repo.findOneBy({ id: sid, companyId: cid });
  if (!s) return res.status(404).json({ error: "Not found" });
  await repo.delete({ id: s.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "secret.delete",
    targetType: "secret",
    targetId: s.id,
    targetLabel: s.name,
  });
  res.json({ ok: true });
});

/**
 * Internal helper — load all secrets for a company and return a plain
 * name→value map for merging into a spawned process's env. Decryption
 * failures are logged and skipped so one stale ciphertext doesn't prevent
 * the whole run. Keys in RESERVED_NAMES are additionally filtered defensively
 * (validation blocks them at create time, but a sessionSecret rotation or
 * direct DB edit could sneak one through).
 */
export async function loadCompanySecretsEnv(companyId: string): Promise<Record<string, string>> {
  const rows = await AppDataSource.getRepository(Secret).find({
    where: { companyId },
  });
  const out: Record<string, string> = {};
  for (const s of rows) {
    if (RESERVED_NAMES.has(s.name)) continue;
    try {
      out[s.name] = decryptSecret(s.encryptedValue);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[secrets] failed to decrypt ${s.name} for company ${companyId} — skipped`);
    }
  }
  return out;
}
