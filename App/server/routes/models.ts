import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody } from "../middleware/validate.js";
import {
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { PROVIDERS, isModelConnected } from "../services/providers.js";
import { clearRoutinePins, effectiveActiveId, setActiveModel } from "../services/models.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { previewBaseURL, readCustomEndpoint } from "../services/customEndpoint.js";
import { canProbeContextWindow, probeContextWindow } from "../services/agent/contextWindow.js";
import { recordAudit } from "../services/audit.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";

/**
 * Per-employee Model routes, mounted at
 * `/api/companies/:cid/employees/:eid/models`.
 *
 * An employee can register several models and keep exactly one active. A model
 * is a direct connection to a model API — Anthropic (Claude), OpenAI (GPT), or a
 * custom OpenAI-compatible endpoint. Credentials are entered here and stored
 * encrypted in `configJson`; there is no CLI to install and no subscription
 * sign-in — those disappeared with the harnesses. `POST /:id/activate` flips
 * which model the runner + chat seams use.
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);
modelsRouter.use(requireCompanyRoleForMutations("admin"));

const providerSchema = z.enum(["anthropic", "openai", "custom"]);
const authModeSchema = z.enum(["apikey", "customEndpoint"]);

type PublicModel = {
  id: string;
  employeeId: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  authMode: "apikey" | "customEndpoint";
  /** True if this is the brain the runner + chat seams use for the employee. */
  isActive: boolean;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /** Env var the provider conventionally reads (informational), or null. */
  apiKeyEnv: string | null;
  /** Does this provider connect with a plain API key? */
  supportsApiKey: boolean;
  /** Does this provider connect via a custom OpenAI-compatible endpoint? */
  supportsCustomEndpoint: boolean;
  /** Host-only preview of the configured base URL — `null` when unset. */
  customEndpointHost: string | null;
  /** The raw model id stored on configJson — `null` when unset. */
  customEndpointModelId: string | null;
  /** True if a custom-endpoint API key is on file (we never echo the plaintext). */
  customEndpointHasApiKey: boolean;
  /**
   * Context window in tokens as reported by the provider, or null when it
   * doesn't say (OpenAI) or we couldn't reach it. Null means unknown.
   */
  contextWindow: number | null;
  /** Whether the window above was probed or typed in. Null when unknown. */
  contextWindowSource: "probed" | "manual" | null;
  /** Can we ask this provider for the window at all? Drives the UI's affordances. */
  contextWindowProbeable: boolean;
};

type CoEmp = { co: Company; emp: AIEmployee };
type LoadError = { error: string };

async function loadContext(cid: string, eid: string): Promise<CoEmp | LoadError> {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return { error: "Company not found" };
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
  if (!emp) return { error: "Employee not found" };
  return { co, emp };
}

async function loadModelContext(
  cid: string,
  eid: string,
  modelId: string,
): Promise<(CoEmp & { m: AIModel }) | LoadError> {
  const ctx = await loadContext(cid, eid);
  if ("error" in ctx) return ctx;
  const m = await AppDataSource.getRepository(AIModel).findOneBy({
    id: modelId,
    employeeId: ctx.emp.id,
  });
  if (!m) return { error: "Model not found" };
  return { co: ctx.co, emp: ctx.emp, m };
}

function toPublic(m: AIModel, isActive: boolean): PublicModel {
  const cfg = safeParseConfig(m.configJson);
  const apiKeyEncrypted =
    typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  const customEndpointHost =
    typeof cfg.baseURLPreview === "string" ? (cfg.baseURLPreview as string) : null;
  const customEndpointModelId = typeof cfg.modelId === "string" ? (cfg.modelId as string) : null;
  const spec = PROVIDERS[m.provider];
  const connected = isModelConnected(m);
  return {
    id: m.id,
    employeeId: m.employeeId,
    provider: m.provider,
    model: m.model,
    authMode: m.authMode,
    isActive,
    connectedAt: m.connectedAt?.toISOString() ?? null,
    status: connected ? "connected" : "not_connected",
    apiKeyMasked: apiKeyEncrypted ? "sk-…••••" : null,
    apiKeyEnv: spec.apiKeyEnv,
    supportsApiKey: spec.supportsApiKey,
    supportsCustomEndpoint: spec.supportsCustomEndpoint,
    customEndpointHost,
    customEndpointModelId,
    customEndpointHasApiKey: m.authMode === "customEndpoint" && Boolean(apiKeyEncrypted),
    contextWindow: m.contextWindow ?? null,
    contextWindowSource: m.contextWindowSource ?? null,
    contextWindowProbeable: canProbeContextWindow(m),
  };
}

/**
 * Re-ask the provider for the model's context window and persist what it says.
 *
 * Called after a credential lands, because that's the first moment we can ask.
 * Best-effort by design: an unreachable endpoint must not block saving a model,
 * so a failed probe just leaves the window unknown and the operator can retry
 * with `POST /:id/refresh` — or set the number by hand via
 * `PUT /:id/context-window`.
 */
async function refreshContextWindow(m: AIModel): Promise<void> {
  // A human who typed a number has told us something the probe demonstrably
  // couldn't work out. Don't relitigate it on every save — only an explicit
  // clear returns this model to probing.
  if (m.contextWindowSource === "manual") return;
  const found = await probeContextWindow(m);
  // Null means "couldn't ask", not "has no window" — keep whatever we already
  // knew rather than letting one unreachable moment erase it. Callers that
  // change the endpoint clear the field themselves, since the old number is
  // stale by definition at that point.
  if (found === null || found === m.contextWindow) return;
  m.contextWindow = found;
  m.contextWindowSource = "probed";
  await AppDataSource.getRepository(AIModel).save(m);
}

/** Shape a single model for the wire, computing its `isActive` live. */
async function publicModel(m: AIModel, emp: AIEmployee): Promise<PublicModel> {
  const all = await AppDataSource.getRepository(AIModel).find({
    where: { employeeId: emp.id },
  });
  const activeId = effectiveActiveId(all);
  return toPublic(m, m.id === activeId);
}

function safeParseConfig(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The provider ↔ authMode compatibility check. */
function unsupportedAuthError(
  provider: z.infer<typeof providerSchema>,
  authMode: z.infer<typeof authModeSchema>,
): string | null {
  const spec = PROVIDERS[provider];
  if (authMode === "apikey" && !spec.supportsApiKey) {
    return `${provider} connects via a custom endpoint, not an API key.`;
  }
  if (authMode === "customEndpoint" && !spec.supportsCustomEndpoint) {
    return `${provider} connects with an API key, not a custom endpoint.`;
  }
  return null;
}

// ---------- Collection routes ----------

// GET /api/companies/:cid/employees/:eid/models — list every model, newest first.
modelsRouter.get("/", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const all = await AppDataSource.getRepository(AIModel).find({
    where: { employeeId: ctx.emp.id },
    order: { createdAt: "DESC" },
  });
  const activeId = effectiveActiveId(all);
  res.json(all.map((m) => toPublic(m, m.id === activeId)));
});

// POST /api/companies/:cid/employees/:eid/models — add a model.
// The newest model becomes active by default; the operator can switch any time.
const createSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1).max(120),
  authMode: authModeSchema,
});

modelsRouter.post("/", validateBody(createSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const body = req.body as z.infer<typeof createSchema>;
  const unsupported = unsupportedAuthError(body.provider, body.authMode);
  if (unsupported) return res.status(400).json({ error: unsupported });

  const repo = AppDataSource.getRepository(AIModel);
  const m = repo.create({
    employeeId: ctx.emp.id,
    provider: body.provider,
    model: body.model,
    authMode: body.authMode,
    configJson: "{}",
    connectedAt: null,
    isActive: false,
  });
  await repo.save(m);
  // Newest-added model is active by default (clears the flag on its siblings).
  await setActiveModel(ctx.emp.id, m.id);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.configure",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider, model: m.model, authMode: m.authMode },
  });
  res.json(await publicModel(m, ctx.emp));
});

// ---------- Item routes ----------

// PUT /api/companies/:cid/employees/:eid/models/:id — change provider/model/auth.
const updateSchema = createSchema;

modelsRouter.put("/:id", validateBody(updateSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const body = req.body as z.infer<typeof updateSchema>;
  const unsupported = unsupportedAuthError(body.provider, body.authMode);
  if (unsupported) return res.status(400).json({ error: unsupported });

  const repo = AppDataSource.getRepository(AIModel);
  const m = ctx.m;
  const changedAuth = m.authMode !== body.authMode || m.provider !== body.provider;
  m.provider = body.provider;
  m.model = body.model;
  m.authMode = body.authMode;
  // If provider or auth mode switched, any prior credentials are invalid.
  if (changedAuth) {
    m.configJson = "{}";
    m.connectedAt = null;
  }
  await repo.save(m);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.configure",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider, model: m.model, authMode: m.authMode },
  });
  res.json(await publicModel(m, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/:id/activate — switch brain.
modelsRouter.post("/:id/activate", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  await setActiveModel(ctx.emp.id, ctx.m.id);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.activate",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: ctx.m.provider, model: ctx.m.model },
  });
  res.json(await publicModel(ctx.m, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/:id/apikey — set API key
const apiKeySchema = z.object({ apiKey: z.string().min(1).max(500) });

modelsRouter.post("/:id/apikey", validateBody(apiKeySchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  if (m.authMode !== "apikey") {
    return res.status(400).json({ error: "Model is not in apikey mode" });
  }
  if (!PROVIDERS[m.provider].supportsApiKey) {
    return res.status(400).json({ error: `${m.provider} doesn't connect with an API key` });
  }
  const { apiKey } = req.body as z.infer<typeof apiKeySchema>;
  const cfg = safeParseConfig(m.configJson);
  cfg.apiKeyEncrypted = encryptSecret(apiKey, ctx.co.id);
  cfg.apiKeyPreview = maskSecret(apiKey);
  m.configJson = JSON.stringify(cfg);
  m.connectedAt = new Date();
  await AppDataSource.getRepository(AIModel).save(m);
  // First moment we can ask the provider anything — find out how much room the
  // model actually has.
  await refreshContextWindow(m);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.apikey.set",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json(await publicModel(m, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/:id/custom-endpoint
//
// Save (or update) a custom OpenAI-compatible endpoint. The model must be in
// customEndpoint authMode (provider "custom"). The base URL is required; the API
// key is optional (most local LLMs don't enforce one). `modelId` is the model
// name the upstream server exposes; we store it as the model row's `model` too
// so the in-process client passes it straight through.
const customEndpointSchema = z.object({
  baseURL: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((s) => {
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "baseURL must be an http(s) URL"),
  modelId: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
});

modelsRouter.post("/:id/custom-endpoint", validateBody(customEndpointSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  if (m.authMode !== "customEndpoint") {
    return res.status(400).json({ error: "Model is not in custom-endpoint mode" });
  }
  if (!PROVIDERS[m.provider].supportsCustomEndpoint) {
    return res.status(400).json({
      error: `${m.provider} can't host a custom OpenAI-compatible endpoint.`,
    });
  }
  const { baseURL, modelId, apiKey } = req.body as z.infer<typeof customEndpointSchema>;
  try {
    await assertSafeOutboundUrl(baseURL);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unsafe custom endpoint URL",
    });
  }
  // Read the old target before we overwrite it: whether this save points the
  // model somewhere new decides whether the window we knew is still true.
  const previous = readCustomEndpoint(m);
  const targetChanged = !previous || previous.baseURL !== baseURL || previous.modelId !== modelId;
  const cfg = safeParseConfig(m.configJson);
  cfg.baseURLEncrypted = encryptSecret(baseURL, ctx.co.id);
  cfg.baseURLPreview = previewBaseURL(baseURL);
  cfg.modelId = modelId;
  if (apiKey) {
    cfg.apiKeyEncrypted = encryptSecret(apiKey, ctx.co.id);
    cfg.apiKeyPreview = maskSecret(apiKey);
  } else {
    // Clear any previously-set key so toggling apiKey off actually unsets it.
    delete cfg.apiKeyEncrypted;
    delete cfg.apiKeyPreview;
  }
  m.configJson = JSON.stringify(cfg);
  // Mirror the model id onto the row so the in-process client uses it directly.
  m.model = modelId;
  m.connectedAt = new Date();
  // Only drop the window when this save actually re-points the model. Pointed
  // at new weights, the old number is stale by definition — but a save that
  // merely rotates the API key shouldn't silently discard a number an operator
  // typed in, which is the one case where we can't get it back by asking.
  if (targetChanged) {
    m.contextWindow = null;
    m.contextWindowSource = null;
  }
  await AppDataSource.getRepository(AIModel).save(m);
  await refreshContextWindow(m);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.customEndpoint.set",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: {
      provider: m.provider,
      host: cfg.baseURLPreview,
      modelId,
      hasApiKey: Boolean(apiKey),
    },
  });
  res.json(await publicModel(m, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/:id/refresh
// Recompute connection status. Cheap; kept for the client to reconcile after a
// save without threading the fresh row through every path.
modelsRouter.post("/:id/refresh", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  const nowConnected = isModelConnected(m);
  if (nowConnected && !m.connectedAt) {
    m.connectedAt = new Date();
    await AppDataSource.getRepository(AIModel).save(m);
  }
  if (!nowConnected && m.connectedAt) {
    m.connectedAt = null;
    await AppDataSource.getRepository(AIModel).save(m);
  }
  // Also the operator's retry path when the probe missed at save time (endpoint
  // still booting, GPU host asleep) — cheap enough to just re-ask.
  if (nowConnected) await refreshContextWindow(m);
  res.json(await publicModel(m, ctx.emp));
});

// PUT /api/companies/:cid/employees/:eid/models/:id/context-window
//
// Set the model's context window by hand, or clear it back to whatever the
// provider reports. Needed because "unknown" is a normal outcome, not a failure:
// plain Ollama and OpenAI's own API report no window at all, and until one is
// known the agent loop has no budget to keep a long run inside — it can only
// react once the provider has already rejected a turn.
//
// The bounds mirror the probe's plausibility check, for the same reason: a wrong
// number here poisons every run on this model, so reject nonsense at the edge.
const contextWindowSchema = z.object({
  contextWindow: z.number().int().min(1_024).max(20_000_000).nullable(),
});

modelsRouter.put("/:id/context-window", validateBody(contextWindowSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  const { contextWindow } = req.body as z.infer<typeof contextWindowSchema>;

  if (contextWindow === null) {
    // Clearing hands the field back to the probe rather than just blanking it,
    // so an operator who set a number by mistake lands on the real one.
    m.contextWindow = null;
    m.contextWindowSource = null;
    await AppDataSource.getRepository(AIModel).save(m);
    if (isModelConnected(m)) await refreshContextWindow(m);
  } else {
    m.contextWindow = contextWindow;
    m.contextWindowSource = "manual";
    await AppDataSource.getRepository(AIModel).save(m);
  }

  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.configure",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: {
      provider: m.provider,
      model: m.model,
      contextWindow: m.contextWindow,
      contextWindowSource: m.contextWindowSource,
    },
  });
  res.json(await publicModel(m, ctx.emp));
});

// DELETE /api/companies/:cid/employees/:eid/models/:id — remove one model
modelsRouter.delete("/:id", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = ctx.m;
  const remaining = (await repo.find({ where: { employeeId: ctx.emp.id } })).filter(
    (r) => r.id !== m.id,
  );
  await repo.delete({ id: m.id });
  // Routines pinned to this model revert to inheriting the active one, so the
  // pin never outlives the row it names.
  await clearRoutinePins(m.id);
  // If we removed the active brain, promote the most-recently-added survivor so
  // the employee always has a defined active model.
  if (remaining.length > 0 && !remaining.some((r) => r.isActive)) {
    const promote = effectiveActiveId(remaining);
    if (promote) await setActiveModel(ctx.emp.id, promote);
  }
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
