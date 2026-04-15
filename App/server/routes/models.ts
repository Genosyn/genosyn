import { Router } from "express";
import path from "node:path";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { ensureDir } from "../services/paths.js";
import { PROVIDERS, isModelConnected } from "../services/providers.js";
import { removeDir } from "../services/files.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { recordAudit } from "../services/audit.js";

/**
 * Per-employee Model routes. Mounted twice in `index.ts`:
 *  - /api/companies/:cid/employees/:eid/model   (per-employee CRUD)
 *  - /api/companies/:cid/models                 (read-only overview; see GET /overview)
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);

const providerSchema = z.enum(["claude-code", "codex", "opencode"]);
const authModeSchema = z.enum(["subscription", "apikey"]);

type PublicModel = {
  id: string;
  employeeId: string;
  provider: "claude-code" | "codex" | "opencode";
  model: string;
  authMode: "subscription" | "apikey";
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /** Absolute path to the employee's per-provider config/data dir. */
  configDir: string;
  /** Env var name to prefix the login command with (e.g. CLAUDE_CONFIG_DIR). */
  configDirEnv: string;
  /** The login command the operator runs in a terminal. */
  loginCommand: string;
  /** Env var for pay-as-you-go keys, or null if this provider doesn't use one. */
  apiKeyEnv: string | null;
  /** Does this provider support the "Use an API key" flow at all? */
  supportsApiKey: boolean;
};

async function loadContext(cid: string, eid: string) {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return { error: "Company not found" as const };
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
  if (!emp) return { error: "Employee not found" as const };
  return { co, emp };
}

function toPublic(m: AIModel, co: Company, emp: AIEmployee): PublicModel {
  const cfg = safeParseConfig(m.configJson);
  const apiKeyEncrypted = typeof cfg.apiKeyEncrypted === "string"
    ? (cfg.apiKeyEncrypted as string)
    : null;
  const spec = PROVIDERS[m.provider];
  const connected = isModelConnected(m, co, emp);
  return {
    id: m.id,
    employeeId: m.employeeId,
    provider: m.provider,
    model: m.model,
    authMode: m.authMode,
    connectedAt: m.connectedAt?.toISOString() ?? null,
    status: connected ? "connected" : "not_connected",
    apiKeyMasked: apiKeyEncrypted ? "sk-…••••" : null,
    configDir: spec.configDir(co.slug, emp.slug),
    configDirEnv: spec.configDirEnv,
    loginCommand: spec.loginCommand,
    apiKeyEnv: spec.apiKeyEnv,
    supportsApiKey: spec.supportsApiKey,
  };
}

function safeParseConfig(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Per-employee routes ----------

// GET /api/companies/:cid/employees/:eid/model
modelsRouter.get("/", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = await AppDataSource.getRepository(AIModel).findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.json(null);
  res.json(toPublic(m, ctx.co, ctx.emp));
});

// PUT /api/companies/:cid/employees/:eid/model
// Upsert — creates the row if missing, updates provider/model/authMode.
const upsertSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1).max(120),
  authMode: authModeSchema,
});

modelsRouter.put("/", validateBody(upsertSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const body = req.body as z.infer<typeof upsertSchema>;
  if (body.authMode === "apikey" && !PROVIDERS[body.provider].supportsApiKey) {
    return res
      .status(400)
      .json({ error: `${body.provider} doesn't support API key auth — use subscription.` });
  }
  const repo = AppDataSource.getRepository(AIModel);
  let m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) {
    m = repo.create({
      employeeId: ctx.emp.id,
      provider: body.provider,
      model: body.model,
      authMode: body.authMode,
      configJson: "{}",
      connectedAt: null,
    });
  } else {
    const changedAuth = m.authMode !== body.authMode;
    m.provider = body.provider;
    m.model = body.model;
    m.authMode = body.authMode;
    // If auth mode switched, any prior credentials are invalid.
    if (changedAuth) {
      m.configJson = "{}";
      m.connectedAt = null;
    }
  }
  await repo.save(m);
  // Ensure the employee's provider config dir exists so the login CLI can
  // write into it. Opencode expects XDG_DATA_HOME/opencode/ so we also
  // pre-create the nested directory it will drop auth.json into.
  if (body.authMode === "subscription") {
    const spec = PROVIDERS[body.provider];
    ensureDir(spec.configDir(ctx.co.slug, ctx.emp.slug));
    if (body.provider === "opencode") {
      ensureDir(path.dirname(spec.credsPath(ctx.co.slug, ctx.emp.slug)));
    }
  }
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.configure",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider, model: m.model, authMode: m.authMode },
  });
  res.json(toPublic(m, ctx.co, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/model/apikey — set or clear API key
const apiKeySchema = z.object({ apiKey: z.string().min(1).max(500) });

modelsRouter.post("/apikey", validateBody(apiKeySchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.status(404).json({ error: "Configure provider/model first" });
  if (m.authMode !== "apikey") {
    return res.status(400).json({ error: "Model is not in apikey mode" });
  }
  if (!PROVIDERS[m.provider].supportsApiKey) {
    return res
      .status(400)
      .json({ error: `${m.provider} doesn't support API key auth` });
  }
  const { apiKey } = req.body as z.infer<typeof apiKeySchema>;
  const cfg = safeParseConfig(m.configJson);
  cfg.apiKeyEncrypted = encryptSecret(apiKey);
  cfg.apiKeyPreview = maskSecret(apiKey);
  m.configJson = JSON.stringify(cfg);
  m.connectedAt = new Date();
  await repo.save(m);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.apikey.set",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json(toPublic(m, ctx.co, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/model/refresh
// For subscription mode: re-check whether the creds file has appeared.
// Separate endpoint so the client can poll cheaply while the user runs
// `claude login` in their terminal.
modelsRouter.post("/refresh", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.json(null);
  const nowConnected = isModelConnected(m, ctx.co, ctx.emp);
  if (nowConnected && !m.connectedAt) {
    m.connectedAt = new Date();
    await repo.save(m);
  }
  if (!nowConnected && m.connectedAt && m.authMode === "subscription") {
    m.connectedAt = null;
    await repo.save(m);
  }
  res.json(toPublic(m, ctx.co, ctx.emp));
});

// DELETE /api/companies/:cid/employees/:eid/model — disconnect
modelsRouter.delete("/", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.json({ ok: true });
  await repo.delete({ id: m.id });
  // Wipe on-disk creds for subscription auth. Safe no-op if missing.
  removeDir(PROVIDERS[m.provider].configDir(ctx.co.slug, ctx.emp.slug));
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.disconnect",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json({ ok: true });
});

