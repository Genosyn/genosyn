import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { PROVIDERS, isModelConnected } from "../services/providers.js";
import { clearRoutinePins, effectiveActiveId, setActiveModel } from "../services/models.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import { previewBaseURL, readCustomEndpoint } from "../services/customEndpoint.js";
import { canProbeContextWindow } from "../services/agent/contextWindow.js";
import { refreshContextWindow } from "../services/agent/contextWindowRefresh.js";
import { recordAudit } from "../services/audit.js";
import { assertSafeOutboundUrl } from "../lib/outboundUrl.js";
import { config } from "../../config.js";
import {
  cancelSubscriptionDeviceLogin,
  cancelSubscriptionDeviceLoginsForModel,
  getSubscriptionDeviceLogin,
  saveSubscriptionAccessToken,
  startSubscriptionDeviceLogin,
  SubscriptionCredentialConflictError,
  subscriptionCredentialKind,
  subscriptionUnavailableReason,
} from "../services/codexSubscription.js";

/**
 * Per-employee Model routes, mounted at
 * `/api/companies/:cid/employees/:eid/models`.
 *
 * An employee can register several models and keep exactly one active. A model
 * is a direct connection to a model API — Anthropic (Claude), OpenAI (GPT), or a
 * custom OpenAI-compatible endpoint. OpenAI models can also use a ChatGPT
 * subscription through the pinned official Codex app-server on trusted
 * self-hosted installs. Every credential remains encrypted in `configJson`.
 * `POST /:id/activate` flips the default model used by the runner and chat.
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);
modelsRouter.use(requireBrowserSession);
modelsRouter.use(requireCompanyRoleForMutations("admin"));

const providerSchema = z.enum(["anthropic", "openai", "custom"]);
const authModeSchema = z.enum(["apikey", "subscription", "customEndpoint"]);
const modelItemParamsSchema = z.object({
  cid: z.string().uuid(),
  eid: z.string().uuid(),
  id: z.string().uuid(),
});
const deviceSessionParamsSchema = modelItemParamsSchema.extend({
  sessionId: z.string().uuid(),
});

type PublicModel = {
  id: string;
  employeeId: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  authMode: "apikey" | "subscription" | "customEndpoint";
  /** True if this is the default brain for Routines and employee Chat. */
  isActive: boolean;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /** Env var the provider conventionally reads (informational), or null. */
  apiKeyEnv: string | null;
  /** Does this provider connect with a plain API key? */
  supportsApiKey: boolean;
  /** Does this provider support the official consumer-subscription runtime? */
  supportsSubscription: boolean;
  /** Is subscription auth allowed by this install's security mode? */
  subscriptionAvailable: boolean;
  subscriptionUnavailableReason: string | null;
  /** Which encrypted subscription credential is present, without its value. */
  subscriptionCredentialKind: "chatgptSession" | "accessToken" | null;
  /** Whether subscription turns may safely receive the bash coding tool. */
  subscriptionShellAvailable: boolean;
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
  const unavailable = spec.supportsSubscription ? subscriptionUnavailableReason() : null;
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
    supportsSubscription: spec.supportsSubscription,
    subscriptionAvailable: spec.supportsSubscription && unavailable === null,
    subscriptionUnavailableReason: unavailable,
    subscriptionCredentialKind: subscriptionCredentialKind(m),
    subscriptionShellAvailable:
      spec.supportsSubscription &&
      unavailable === null &&
      config.agent.codingTools.enabled &&
      config.agent.codingTools.executionMode === "bubblewrap",
    supportsCustomEndpoint: spec.supportsCustomEndpoint,
    customEndpointHost,
    customEndpointModelId,
    customEndpointHasApiKey: m.authMode === "customEndpoint" && Boolean(apiKeyEncrypted),
    contextWindow: m.contextWindow ?? null,
    contextWindowSource: m.contextWindowSource ?? null,
    contextWindowProbeable: canProbeContextWindow(m),
  };
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
  if (authMode === "subscription" && !spec.supportsSubscription) {
    return provider === "anthropic"
      ? "Anthropic does not allow third-party products to use Claude consumer subscriptions. Use an Anthropic Console API key."
      : `${provider} does not support subscription authentication.`;
  }
  if (authMode === "subscription") {
    const unavailable = subscriptionUnavailableReason();
    if (unavailable) return unavailable;
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
  await cancelSubscriptionDeviceLoginsForModel(ctx.m.id);
  const m = await repo.findOneBy({ id: ctx.m.id, employeeId: ctx.emp.id });
  if (!m) return res.status(404).json({ error: "Model not found" });
  const changedAuth = m.authMode !== body.authMode || m.provider !== body.provider;
  const changedModel = m.model !== body.model;
  // If provider or auth mode switched, any prior credentials are invalid.
  if (changedAuth) {
    await repo.update(
      { id: m.id, employeeId: ctx.emp.id },
      {
        provider: body.provider,
        model: body.model,
        authMode: body.authMode,
        configJson: "{}",
        connectedAt: null,
        contextWindow: null,
        contextWindowSource: null,
      },
    );
  } else {
    // Partial update is load-bearing for managed ChatGPT auth: a concurrent
    // refresh may rotate its token, and saving this stale entity would restore
    // the invalid pre-refresh configJson.
    await repo.update(
      { id: m.id, employeeId: ctx.emp.id },
      {
        provider: body.provider,
        model: body.model,
        authMode: body.authMode,
        ...(changedModel ? { contextWindow: null, contextWindowSource: null } : {}),
      },
    );
  }
  const saved = await repo.findOneBy({ id: m.id, employeeId: ctx.emp.id });
  if (!saved) return res.status(404).json({ error: "Model not found" });
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.configure",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: {
      provider: saved.provider,
      model: saved.model,
      authMode: saved.authMode,
    },
  });
  res.json(await publicModel(saved, ctx.emp));
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

// POST /api/companies/:cid/employees/:eid/models/:id/subscription/device
//
// Start OpenAI's managed device-code flow inside an isolated temporary
// CODEX_HOME. Poll the returned session id below; the service encrypts the
// completed managed session into this model row and deletes the temporary dir.
modelsRouter.post(
  "/:id/subscription/device",
  validateParams(modelItemParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModelContext(p.cid, p.eid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    if (ctx.m.provider !== "openai" || ctx.m.authMode !== "subscription") {
      return res.status(400).json({
        error: "Only OpenAI AI Models in subscription mode can sign in with ChatGPT.",
      });
    }
    const unavailable = subscriptionUnavailableReason();
    if (unavailable) return res.status(400).json({ error: unavailable });
    try {
      const session = await startSubscriptionDeviceLogin(ctx.m.id, {
        companyId: ctx.co.id,
        actorUserId: req.userId!,
      });
      await recordAudit({
        companyId: ctx.co.id,
        actorUserId: req.userId ?? null,
        action: "model.subscription.login.start",
        targetType: "employee",
        targetId: ctx.emp.id,
        targetLabel: ctx.emp.name,
        metadata: { provider: "openai", model: ctx.m.model },
      });
      res.json(session);
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : "Could not start ChatGPT subscription sign-in.",
      });
    }
  },
);

// GET /:id/subscription/device/:sessionId — poll the short-lived login state.
modelsRouter.get(
  "/:id/subscription/device/:sessionId",
  validateParams(deviceSessionParamsSchema),
  requireCompanyRole("admin"),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModelContext(p.cid, p.eid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const session = getSubscriptionDeviceLogin(ctx.m.id, p.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Subscription sign-in session not found" });
    }
    res.json(session);
  },
);

// DELETE /:id/subscription/device/:sessionId — cancel a pending login.
modelsRouter.delete(
  "/:id/subscription/device/:sessionId",
  validateParams(deviceSessionParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModelContext(p.cid, p.eid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const session = await cancelSubscriptionDeviceLogin(ctx.m.id, p.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Subscription sign-in session not found" });
    }
    res.json(session);
  },
);

// POST /:id/subscription/access-token
//
// Trusted Business/Enterprise automation may receive a supported Codex access
// token. It is injected as CODEX_ACCESS_TOKEN only into the one short-lived
// app-server process; unlike the internal chatgptAuthTokens RPC, no external
// token fields are handed to an unstable protocol method.
const subscriptionAccessTokenSchema = z.object({
  accessToken: z.string().trim().min(20).max(16_384),
});

modelsRouter.post(
  "/:id/subscription/access-token",
  validateParams(modelItemParamsSchema),
  validateBody(subscriptionAccessTokenSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModelContext(p.cid, p.eid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const m = ctx.m;
    if (m.provider !== "openai" || m.authMode !== "subscription") {
      return res.status(400).json({
        error: "Only OpenAI AI Models in subscription mode accept a Codex access token.",
      });
    }
    const unavailable = subscriptionUnavailableReason();
    if (unavailable) return res.status(400).json({ error: unavailable });

    const { accessToken } = req.body as z.infer<typeof subscriptionAccessTokenSchema>;
    let saved: AIModel;
    try {
      saved = await saveSubscriptionAccessToken(m.id, accessToken);
    } catch (error) {
      if (!(error instanceof SubscriptionCredentialConflictError)) throw error;
      return res.status(409).json({
        error: error.message,
      });
    }
    await recordAudit({
      companyId: ctx.co.id,
      actorUserId: req.userId ?? null,
      action: "model.subscription.accessToken.set",
      targetType: "employee",
      targetId: ctx.emp.id,
      targetLabel: ctx.emp.name,
      metadata: { provider: "openai", model: m.model },
    });
    res.json(await publicModel(saved, ctx.emp));
  },
);

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
    await AppDataSource.getRepository(AIModel).update({ id: m.id }, { connectedAt: m.connectedAt });
  }
  if (!nowConnected && m.connectedAt) {
    m.connectedAt = null;
    await AppDataSource.getRepository(AIModel).update({ id: m.id }, { connectedAt: null });
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
  if (m.authMode === "subscription") {
    return res.status(400).json({
      error: "OpenAI Codex manages context for subscription models.",
    });
  }
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
  await cancelSubscriptionDeviceLoginsForModel(m.id);
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
