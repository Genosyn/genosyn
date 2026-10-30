import { Router, type Request, type Response } from "express";
import { In } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { PROVIDERS, isModelConnected } from "../services/providers.js";
import { discoverApiModels, ModelSetupError } from "../services/modelCatalog.js";
import {
  connectApiModel,
  discoverStoredApiModels,
  replaceApiKey,
  verifyModelEdit,
  editApiModel,
} from "../services/modelSetup.js";
import { testModelConnection } from "../services/modelConnectionTest.js";
import { addApiKey, removeApiKey, reorderApiKeys } from "../services/modelApiKeySetup.js";
import { LEGACY_PRIMARY_KEY_ID, readApiKeys } from "../services/modelApiKeys.js";
import { pruneKeyHealth } from "../services/modelKeyHealth.js";
import { previewBaseURL } from "../services/customEndpoint.js";
import { connectCustomModel } from "../services/customModelSetup.js";
import { editSubscriptionModel } from "../services/subscriptionModelSetup.js";
import { refreshContextWindow } from "../services/agent/contextWindowRefresh.js";
import { recordAudit } from "../services/audit.js";
import { MAX_MODEL_CONCURRENT_RUNS, modelRunCapacity } from "../services/modelRunCapacity.js";
import { saveModelThinkingSettings } from "../services/modelThinkingSettings.js";
import { dispatchQueuedRoutineRuns } from "../services/routineQueue.js";
import { MODEL_EFFORT_VALUES } from "../../shared/modelEffort.js";
import {
  cancelSubscriptionDeviceLogin,
  cancelSubscriptionDeviceLoginsForModel,
  getSubscriptionDeviceLogin,
  saveSubscriptionAccessToken,
  startSubscriptionDeviceLogin,
  SubscriptionCredentialConflictError,
  subscriptionUnavailableReason,
} from "../services/codexSubscription.js";
import { attachModel, detachModel, saveNewModel } from "../services/models.js";
import {
  companyModelEntry,
  findCompanyModel,
  listCompanyModels,
  mergeDuplicateModels,
  removeCompanyModel,
} from "../services/companyModels.js";
import {
  describeModelForAudit,
  healthByModel,
  toPublicModel,
  type PublicModel,
} from "../services/modelViews.js";
import { emitResourceChange } from "../services/resourceEvents.js";

/**
 * The company's AI Models, mounted at `/api/companies/:cid/models` — what
 * Settings → AI Models shows and every route keyed on one model row.
 *
 * An AI Model belongs to the company: one set of credentials, one pool of API
 * keys and their health that any number of AI Employees run on. `POST /:id/attach`
 * and `POST /:id/detach` put it on and take it off employees (detaching never
 * deletes it), `DELETE /:id` removes it from the company — refused while
 * anyone still uses it unless `detach=true` — and `POST /:id/merge` folds
 * exact duplicates (same service, model, endpoint and keys) into it. A model
 * is a direct connection to a model API — Anthropic (Claude), OpenAI (GPT), or
 * a custom OpenAI-compatible endpoint — and OpenAI can also use a ChatGPT
 * subscription through the pinned official Codex app-server on trusted
 * self-hosted installs. Every credential remains encrypted in `configJson`
 * and only previews ever leave the server. `/:id/keys` adds, removes and
 * orders the API keys an API-key model spreads its sessions across
 * (`services/modelApiKeySetup.ts`);
 * `POST /:id/test` asks the model for one real reply and changes nothing
 * (`services/modelConnectionTest.ts`); `GET /:id/catalog` lists the models an
 * API-key model's own keys can reach, for changing its model.
 *
 * Owners and admins only, reads included, and only from a signed-in browser:
 * putting a credential in the company or a brain on an AI Employee is a human
 * decision, so neither an API key, the Genosyn MCP server nor any AI
 * Employee tool can reach these routes.
 */
export const companyModelsRouter = Router({ mergeParams: true });
companyModelsRouter.use(requireAuth);
companyModelsRouter.use(requireCompanyMember);
companyModelsRouter.use(requireBrowserSession);
companyModelsRouter.use(requireCompanyRole("admin"));

const providerSchema = z.enum(["anthropic", "openai", "custom"]);
const authModeSchema = z.enum(["apikey", "subscription", "customEndpoint"]);
const collectionParamsSchema = z.object({ cid: z.string().uuid() });
const itemParamsSchema = z.object({ cid: z.string().uuid(), id: z.string().uuid() });
const deviceSessionParamsSchema = itemParamsSchema.extend({ sessionId: z.string().uuid() });
/** AI Employees to attach a new or existing model to. */
const employeeIdsSchema = z
  .array(z.string().uuid())
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, "Each AI Employee may appear only once.");

type ModelContext = { co: Company; m: AIModel };

async function loadCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function loadModel(cid: string, id: string): Promise<ModelContext | { error: string }> {
  const co = await loadCompany(cid);
  if (!co) return { error: "Company not found" };
  const m = await findCompanyModel(co.id, id);
  if (!m) return { error: "Model not found" };
  return { co, m };
}

/** One model as the company's list shows it, read fresh. */
async function companyPublicModel(companyId: string, modelId: string): Promise<PublicModel | null> {
  const entry = await companyModelEntry(companyId, modelId);
  if (!entry) return null;
  const health = await healthByModel([entry.model]);
  return toPublicModel(entry.model, {
    health: health.get(entry.model.id),
    employees: entry.users,
    duplicateIds: entry.duplicateIds,
  });
}

async function sendModel(res: Response, companyId: string, modelId: string) {
  const model = await companyPublicModel(companyId, modelId);
  if (!model) return res.status(404).json({ error: "Model not found" });
  return res.json(model);
}

function sendSetupError(res: Response, error: unknown) {
  if (!(error instanceof ModelSetupError)) throw error;
  return res.status(error.status).json(error.responseBody());
}

/** A change to the model itself, recorded against the model. */
async function auditModel(
  req: Request,
  companyId: string,
  m: Pick<AIModel, "id" | "provider" | "model">,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await recordAudit({
    companyId,
    actorUserId: req.userId ?? null,
    action,
    targetType: "ai_model",
    targetId: m.id,
    targetLabel: describeModelForAudit(m),
    metadata: { provider: m.provider, model: m.model, ...metadata },
  });
}

/** Putting a model on, or taking it off, one AI Employee — recorded against the employee. */
export async function auditEmployeeModel(
  req: Request,
  companyId: string,
  employee: Pick<AIEmployee, "id" | "name">,
  m: Pick<AIModel, "id" | "provider" | "model">,
  action: "model.attach" | "model.detach" | "model.activate",
) {
  await recordAudit({
    companyId,
    actorUserId: req.userId ?? null,
    action,
    targetType: "employee",
    targetId: employee.id,
    targetLabel: employee.name,
    metadata: { modelId: m.id, provider: m.provider, model: m.model },
  });
}

/** The employees a new model was attached to, for their audit rows. */
async function employeesNamed(companyId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return AppDataSource.getRepository(AIEmployee).find({
    where: { id: In([...ids]), companyId },
    select: { id: true, name: true },
  });
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

// GET /api/companies/:cid/models — every company AI Model, newest first, with
// who uses each and which are exact duplicates of each other.
companyModelsRouter.get("/", validateParams(collectionParamsSchema), async (req, res) => {
  const co = await loadCompany((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const entries = await listCompanyModels(co.id);
  const health = await healthByModel(entries.map((entry) => entry.model));
  res.json(
    entries.map((entry) =>
      toPublicModel(entry.model, {
        health: health.get(entry.model.id),
        employees: entry.users,
        duplicateIds: entry.duplicateIds,
      }),
    ),
  );
});

const discoverSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  apiKey: z.string().trim().min(1).max(500),
});
const connectSchema = discoverSchema.extend({
  model: z.string().trim().min(1).max(120).optional(),
  employeeIds: employeeIdsSchema.optional(),
});

// POST /api/companies/:cid/models/discover — the models a key can reach.
// No credential is stored while the member previews them.
companyModelsRouter.post(
  "/discover",
  validateParams(collectionParamsSchema),
  validateBody(discoverSchema),
  async (req, res) => {
    const co = await loadCompany((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof discoverSchema>;
    try {
      res.json(await discoverApiModels(body.provider, body.apiKey));
    } catch (error) {
      sendSetupError(res, error);
    }
  },
);

// POST /api/companies/:cid/models/connect — discover, verify and save
// together, then attach to `employeeIds` as their active model. A failed test
// saves nothing.
companyModelsRouter.post(
  "/connect",
  validateParams(collectionParamsSchema),
  validateBody(connectSchema),
  async (req, res) => {
    const co = await loadCompany((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof connectSchema>;
    const attachTo = body.employeeIds ?? [];
    try {
      const model = await connectApiModel({
        companyId: co.id,
        provider: body.provider,
        apiKey: body.apiKey,
        model: body.model,
        attachTo,
      });
      await refreshContextWindow(model);
      await auditModel(req, co.id, model, "model.configure", {
        authMode: model.authMode,
        verified: true,
      });
      for (const employee of await employeesNamed(co.id, attachTo)) {
        await auditEmployeeModel(req, co.id, employee, model, "model.attach");
      }
      await sendModel(res, co.id, model.id);
    } catch (error) {
      sendSetupError(res, error);
    }
  },
);

// POST /api/companies/:cid/models/connect-custom
//
// Save a custom OpenAI-compatible endpoint as a new company model. The base
// URL is required; the API key is optional (most local LLMs don't enforce
// one). `modelId` is the model name the upstream server exposes; left blank,
// it is the model the server serves, when it serves exactly one.
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
  modelId: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
});
const connectCustomSchema = customEndpointSchema.extend({
  employeeIds: employeeIdsSchema.optional(),
});

companyModelsRouter.post(
  "/connect-custom",
  validateParams(collectionParamsSchema),
  validateBody(connectCustomSchema),
  async (req, res) => {
    const co = await loadCompany((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof connectCustomSchema>;
    const attachTo = body.employeeIds ?? [];
    try {
      const model = await connectCustomModel({
        baseURL: body.baseURL,
        modelId: body.modelId,
        apiKey: body.apiKey,
        companyId: co.id,
        attachTo,
      });
      await refreshContextWindow(model);
      await auditModel(req, co.id, model, "model.customEndpoint.set", {
        modelId: model.model,
        verified: true,
      });
      for (const employee of await employeesNamed(co.id, attachTo)) {
        await auditEmployeeModel(req, co.id, employee, model, "model.attach");
      }
      await sendModel(res, co.id, model.id);
    } catch (error) {
      sendSetupError(res, error);
    }
  },
);

// POST /api/companies/:cid/models — add a model that still needs connecting
// (a ChatGPT sign-in, or a key to come), attached to `employeeIds` as their
// active model.
const createSchema = z.object({
  provider: providerSchema,
  model: z.string().trim().min(1).max(120),
  authMode: authModeSchema,
  employeeIds: employeeIdsSchema.optional(),
});

companyModelsRouter.post(
  "/",
  validateParams(collectionParamsSchema),
  validateBody(createSchema),
  async (req, res) => {
    const co = await loadCompany((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof createSchema>;
    const unsupported = unsupportedAuthError(body.provider, body.authMode);
    if (unsupported) return res.status(400).json({ error: unsupported });
    const attachTo = body.employeeIds ?? [];
    let m: AIModel;
    try {
      m = await saveNewModel(
        AppDataSource.getRepository(AIModel).create({
          companyId: co.id,
          provider: body.provider,
          model: body.model,
          authMode: body.authMode,
          configJson: "{}",
          connectedAt: null,
        }),
        attachTo,
      );
    } catch (error) {
      return sendSetupError(res, error);
    }
    await auditModel(req, co.id, m, "model.configure", { authMode: m.authMode });
    for (const employee of await employeesNamed(co.id, attachTo)) {
      await auditEmployeeModel(req, co.id, employee, m, "model.attach");
    }
    await sendModel(res, co.id, m.id);
  },
);

// ---------- Item routes ----------

// GET /api/companies/:cid/models/:id — one company AI Model.
companyModelsRouter.get("/:id", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModel(p.cid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  await sendModel(res, ctx.co.id, ctx.m.id);
});

// PUT /api/companies/:cid/models/:id — change provider/model/auth. Every AI
// Employee on the model runs on the change.
const updateSchema = createSchema
  .omit({ employeeIds: true })
  .extend({ apiKey: z.string().trim().min(1).max(500).optional() });

companyModelsRouter.put(
  "/:id",
  validateParams(itemParamsSchema),
  validateBody(updateSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const body = req.body as z.infer<typeof updateSchema>;
    const unsupported = unsupportedAuthError(body.provider, body.authMode);
    if (unsupported) return res.status(400).json({ error: unsupported });

    const repo = AppDataSource.getRepository(AIModel);
    await cancelSubscriptionDeviceLoginsForModel(ctx.m.id);
    const m = await repo.findOneBy({ id: ctx.m.id, companyId: ctx.co.id });
    if (!m) return res.status(404).json({ error: "Model not found" });
    const changedAuth = m.authMode !== body.authMode || m.provider !== body.provider;
    const changedModel = m.model !== body.model;
    if (body.authMode !== "apikey" && !changedAuth && changedModel) {
      try {
        await verifyModelEdit(m, body.model);
      } catch (error) {
        return sendSetupError(res, error);
      }
    }
    // If provider or auth mode switched, any prior credentials are invalid.
    if (body.authMode === "subscription" && !changedAuth && changedModel && isModelConnected(m)) {
      try {
        await editSubscriptionModel(m, body.model);
      } catch (error) {
        return sendSetupError(res, error);
      }
    } else if (body.authMode === "apikey" && (changedAuth || changedModel || body.apiKey)) {
      try {
        await editApiModel(m, {
          provider: body.provider as "anthropic" | "openai",
          model: body.model,
          apiKey: body.apiKey,
          companyId: ctx.co.id,
        });
      } catch (error) {
        return sendSetupError(res, error);
      }
    } else if (changedAuth) {
      await repo.update(
        { id: m.id, companyId: ctx.co.id },
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
        { id: m.id, companyId: ctx.co.id },
        {
          provider: body.provider,
          model: body.model,
          authMode: body.authMode,
          ...(changedModel ? { contextWindow: null, contextWindowSource: null } : {}),
        },
      );
    }
    const saved = await repo.findOneBy({ id: m.id, companyId: ctx.co.id });
    if (!saved) return res.status(404).json({ error: "Model not found" });
    // A different model has a window of its own, and the edit cleared the old
    // one: ask for it now rather than leave the card reading "Unknown" until
    // the three-hourly sweep. Best-effort, and a hand-set window is kept.
    if ((changedModel || changedAuth) && isModelConnected(saved)) {
      await refreshContextWindow(saved);
    }
    // A change of service or sign-in takes the old keys, and their health, with it.
    await pruneKeyHealth(saved);
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, saved, "model.configure", { authMode: saved.authMode });
    await sendModel(res, ctx.co.id, saved.id);
  },
);

// DELETE /api/companies/:cid/models/:id — remove the model from the company,
// its credentials, API keys and their health with it. Refused with 409 and
// the employees' names while any AI Employee uses it, unless `detach=true`,
// which detaches it from all of them first.
const removeQuerySchema = z.object({
  detach: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

companyModelsRouter.delete(
  "/:id",
  validateParams(itemParamsSchema),
  validateQuery(removeQuerySchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const { detach } = req.query as unknown as z.infer<typeof removeQuerySchema>;
    let removed: Awaited<ReturnType<typeof removeCompanyModel>>;
    try {
      removed = await removeCompanyModel({
        companyId: ctx.co.id,
        modelId: ctx.m.id,
        detachFromEmployees: detach,
      });
    } catch (error) {
      return sendSetupError(res, error);
    }
    for (const user of removed.detachedFrom) {
      await auditEmployeeModel(req, ctx.co.id, user, ctx.m, "model.detach");
    }
    await auditModel(req, ctx.co.id, ctx.m, "model.delete", {
      authMode: ctx.m.authMode,
      detachedFrom: removed.detachedFrom.map((user) => user.id),
    });
    res.json({ ok: true });
  },
);

// POST /api/companies/:cid/models/:id/attach — put a connected model on AI
// Employees. With `makeActive` (the default) it becomes each one's active
// model; Make active on an employee's Model page switches back.
const attachSchema = z
  .object({
    employeeIds: employeeIdsSchema.refine((ids) => ids.length > 0, "Choose an AI Employee."),
    makeActive: z.boolean().optional(),
  })
  .strict();

companyModelsRouter.post(
  "/:id/attach",
  validateParams(itemParamsSchema),
  validateBody(attachSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const body = req.body as z.infer<typeof attachSchema>;
    let result: Awaited<ReturnType<typeof attachModel>>;
    try {
      result = await attachModel({
        companyId: ctx.co.id,
        modelId: ctx.m.id,
        employeeIds: body.employeeIds,
        makeActive: body.makeActive,
      });
    } catch (error) {
      return sendSetupError(res, error);
    }
    for (const employee of result.attached) {
      await auditEmployeeModel(req, ctx.co.id, employee, ctx.m, "model.attach");
    }
    if (body.makeActive !== false) {
      for (const employee of result.alreadyAttached) {
        await auditEmployeeModel(req, ctx.co.id, employee, ctx.m, "model.activate");
      }
    }
    await sendModel(res, ctx.co.id, ctx.m.id);
  },
);

// POST /api/companies/:cid/models/:id/detach — take the model off AI
// Employees. The model, its keys and everyone else's attachment stay; an
// employee whose active model this was switches to its newest other one.
const detachSchema = z
  .object({
    employeeIds: employeeIdsSchema.refine((ids) => ids.length > 0, "Choose an AI Employee."),
  })
  .strict();

companyModelsRouter.post(
  "/:id/detach",
  validateParams(itemParamsSchema),
  validateBody(detachSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    let result: Awaited<ReturnType<typeof detachModel>>;
    try {
      result = await detachModel({
        companyId: ctx.co.id,
        modelId: ctx.m.id,
        employeeIds: (req.body as z.infer<typeof detachSchema>).employeeIds,
      });
    } catch (error) {
      return sendSetupError(res, error);
    }
    for (const employee of result.detached) {
      await auditEmployeeModel(req, ctx.co.id, employee, ctx.m, "model.detach");
    }
    await sendModel(res, ctx.co.id, ctx.m.id);
  },
);

// POST /api/companies/:cid/models/:id/merge — fold exact duplicates of this
// model into it: their employees, pins and key health move onto it and the
// duplicates are removed. Refused unless each one is still an exact duplicate.
const mergeSchema = z
  .object({
    duplicateIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Each AI Model may appear only once."),
  })
  .strict();

companyModelsRouter.post(
  "/:id/merge",
  validateParams(itemParamsSchema),
  validateBody(mergeSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    let result: Awaited<ReturnType<typeof mergeDuplicateModels>>;
    try {
      result = await mergeDuplicateModels({
        companyId: ctx.co.id,
        targetId: ctx.m.id,
        duplicateIds: (req.body as z.infer<typeof mergeSchema>).duplicateIds,
      });
    } catch (error) {
      return sendSetupError(res, error);
    }
    await auditModel(req, ctx.co.id, ctx.m, "model.merge", {
      mergedModelIds: result.merged.map((model) => model.id),
      movedEmployees: result.movedEmployees,
    });
    await sendModel(res, ctx.co.id, ctx.m.id);
  },
);

// POST /api/companies/:cid/models/:id/apikey — set the API key a model still
// waiting for one connects with. On a model that has keys it replaces the
// first-listed one and keeps the rest; Settings adds and removes keys through
// `/:id/keys` instead.
const apiKeySchema = z.object({ apiKey: z.string().trim().min(1).max(500) });

companyModelsRouter.post(
  "/:id/apikey",
  validateParams(itemParamsSchema),
  validateBody(apiKeySchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const m = ctx.m;
    if (m.authMode !== "apikey") {
      return res.status(400).json({ error: "Model is not in apikey mode" });
    }
    if (!PROVIDERS[m.provider].supportsApiKey) {
      return res.status(400).json({ error: `${m.provider} doesn't connect with an API key` });
    }
    const { apiKey } = req.body as z.infer<typeof apiKeySchema>;
    let verified: AIModel;
    try {
      verified = await replaceApiKey(m, apiKey, ctx.co.id);
    } catch (error) {
      return sendSetupError(res, error);
    }
    // First moment we can ask the provider anything — find out how much room the
    // model actually has.
    await refreshContextWindow(verified);
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, verified, "model.apikey.set");
    await sendModel(res, ctx.co.id, verified.id);
  },
);

// ---------- API keys ----------
//
// An Anthropic or OpenAI model connected with an API key holds any number of
// keys, all equals: each session opens on the next key in turn and stays on
// it, moving to another key only when the provider refuses its own (see
// `services/agent/apiKeyRing.ts`). Every AI Employee on the model draws on the
// same pool. Only previews leave the server.

/** A key's id: a UUID, or `primary` for a key saved before keys had ids. */
const apiKeyIdSchema = z.union([z.literal(LEGACY_PRIMARY_KEY_ID), z.string().uuid()]);
const apiKeyItemParamsSchema = itemParamsSchema.extend({ keyId: apiKeyIdSchema });
const addApiKeySchema = z.object({ apiKey: z.string().trim().min(1).max(500) }).strict();
const reorderApiKeysSchema = z
  .object({
    orderedIds: z
      .array(apiKeyIdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "Each key may appear only once."),
  })
  .strict();

// POST /api/companies/:cid/models/:id/keys — test a key alone, then add it to
// the pool, where it takes its turn ahead of the keys that already had theirs.
companyModelsRouter.post(
  "/:id/keys",
  validateParams(itemParamsSchema),
  validateBody(addApiKeySchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    let added: Awaited<ReturnType<typeof addApiKey>>;
    try {
      added = await addApiKey(
        ctx.m,
        (req.body as z.infer<typeof addApiKeySchema>).apiKey,
        ctx.co.id,
      );
    } catch (error) {
      return sendSetupError(res, error);
    }
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, added.model, "model.apikey.add", {
      keyId: added.key.id,
      keyPreview: added.key.apiKeyPreview,
      keyCount: readApiKeys(added.model.configJson).length,
    });
    await sendModel(res, ctx.co.id, added.model.id);
  },
);

// POST /api/companies/:cid/models/:id/keys/reorder — the order the keys are
// listed in. Sessions take every key in turn whatever the order; it only sets
// where a connection test starts. Kept so a stored order can still be set.
companyModelsRouter.post(
  "/:id/keys/reorder",
  validateParams(itemParamsSchema),
  validateBody(reorderApiKeysSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    let saved: AIModel;
    try {
      saved = await reorderApiKeys(
        ctx.m,
        (req.body as z.infer<typeof reorderApiKeysSchema>).orderedIds,
      );
    } catch (error) {
      return sendSetupError(res, error);
    }
    const keys = readApiKeys(saved.configJson);
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, saved, "model.apikey.reorder", {
      orderedKeyIds: keys.map((key) => key.id),
      orderedPreviews: keys.map((key) => key.apiKeyPreview),
    });
    await sendModel(res, ctx.co.id, saved.id);
  },
);

// DELETE /api/companies/:cid/models/:id/keys/:keyId — sessions are spread
// across the remaining keys; the only key can't be removed.
companyModelsRouter.delete(
  "/:id/keys/:keyId",
  validateParams(apiKeyItemParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    let removed: Awaited<ReturnType<typeof removeApiKey>>;
    try {
      removed = await removeApiKey(ctx.m, p.keyId);
    } catch (error) {
      return sendSetupError(res, error);
    }
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, removed.model, "model.apikey.remove", {
      keyId: removed.key.id,
      keyPreview: removed.key.apiKeyPreview,
      keyCount: readApiKeys(removed.model.configJson).length,
    });
    await sendModel(res, ctx.co.id, removed.model.id);
  },
);

// POST /api/companies/:cid/models/:id/subscription/device
//
// Start OpenAI's managed device-code flow inside an isolated temporary
// CODEX_HOME. Poll the returned session id below; the service encrypts the
// completed managed session into this model row and deletes the temporary dir.
companyModelsRouter.post(
  "/:id/subscription/device",
  validateParams(itemParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
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
      await auditModel(req, ctx.co.id, ctx.m, "model.subscription.login.start");
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
companyModelsRouter.get(
  "/:id/subscription/device/:sessionId",
  validateParams(deviceSessionParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const session = getSubscriptionDeviceLogin(ctx.m.id, p.sessionId);
    if (!session) {
      return res.status(404).json({ error: "Subscription sign-in session not found" });
    }
    if (session.status === "succeeded") emitResourceChange(ctx.co.id, "employee");
    res.json(session);
  },
);

// DELETE /:id/subscription/device/:sessionId — cancel a pending login.
companyModelsRouter.delete(
  "/:id/subscription/device/:sessionId",
  validateParams(deviceSessionParamsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
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

companyModelsRouter.post(
  "/:id/subscription/access-token",
  validateParams(itemParamsSchema),
  validateBody(subscriptionAccessTokenSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
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
      if (error instanceof ModelSetupError)
        return res.status(error.status).json(error.responseBody());
      if (!(error instanceof SubscriptionCredentialConflictError)) throw error;
      return res.status(409).json({ error: error.message });
    }
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, saved, "model.subscription.accessToken.set");
    await sendModel(res, ctx.co.id, saved.id);
  },
);

// POST /api/companies/:cid/models/:id/custom-endpoint — change a custom
// model's endpoint. The test runs before anything is replaced, so a failed one
// leaves the working endpoint as it was.
companyModelsRouter.post(
  "/:id/custom-endpoint",
  validateParams(itemParamsSchema),
  validateBody(customEndpointSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
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
    let verified: AIModel;
    try {
      verified = await connectCustomModel({ baseURL, modelId, apiKey, companyId: ctx.co.id }, m);
    } catch (error) {
      return sendSetupError(res, error);
    }
    await refreshContextWindow(verified);
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, verified, "model.customEndpoint.set", {
      host: previewBaseURL(baseURL),
      modelId: verified.model,
      hasApiKey: Boolean(apiKey),
    });
    await sendModel(res, ctx.co.id, verified.id);
  },
);

// POST /api/companies/:cid/models/:id/refresh
// Recompute connection status. Cheap; kept for the client to reconcile after a
// save without threading the fresh row through every path.
companyModelsRouter.post("/:id/refresh", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModel(p.cid, p.id);
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
  await sendModel(res, ctx.co.id, m.id);
});

// POST /api/companies/:cid/models/:id/test
//
// Test connection: ask the AI Model for one small, harmless reply through the
// runtime its work uses, and change nothing (see `services/modelConnectionTest.ts`).
// The reply spends a little of the account's allowance. Answers with how long
// the model took and the model as it now reads, since the test's requests
// update each key's health.
companyModelsRouter.post("/:id/test", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModel(p.cid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  let elapsedMs: number;
  try {
    ({ elapsedMs } = await testModelConnection(ctx.m));
  } catch (error) {
    return sendSetupError(res, error);
  }
  const model = await companyPublicModel(ctx.co.id, ctx.m.id);
  res.json({ ok: true, elapsedMs, model: model ?? toPublicModel(ctx.m) });
});

// GET /api/companies/:cid/models/:id/catalog
//
// The models a connected Claude or OpenAI AI Model's own API keys can reach, so
// changing which model it runs is a pick from a list with no key pasted again
// (see `discoverStoredApiModels`).
companyModelsRouter.get("/:id/catalog", validateParams(itemParamsSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModel(p.cid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  try {
    res.json(await discoverStoredApiModels(ctx.m));
  } catch (error) {
    sendSetupError(res, error);
  }
});

// PUT /api/companies/:cid/models/:id/context-window
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

companyModelsRouter.put(
  "/:id/context-window",
  validateParams(itemParamsSchema),
  validateBody(contextWindowSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
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

    await auditModel(req, ctx.co.id, m, "model.configure", {
      contextWindow: m.contextWindow,
      contextWindowSource: m.contextWindowSource,
    });
    await sendModel(res, ctx.co.id, m.id);
  },
);

// PUT /api/companies/:cid/models/:id/run-concurrency
//
// How many Routine Runs may use this model's endpoint at once, across every AI
// Employee on it. A local model server slows every Run it serves in parallel,
// and a Run's clock keeps ticking while it waits for the GPU; Runs beyond the
// limit wait in the queue instead, with their time limit starting only when
// they do. Null restores the default (one at a time for a local endpoint or a
// ChatGPT sign-in), 0 removes the limit.
const runConcurrencySchema = z
  .object({
    maxConcurrentRuns: z.number().int().min(0).max(MAX_MODEL_CONCURRENT_RUNS).nullable(),
  })
  .strict();

companyModelsRouter.put(
  "/:id/run-concurrency",
  validateParams(itemParamsSchema),
  validateBody(runConcurrencySchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const { maxConcurrentRuns } = req.body as z.infer<typeof runConcurrencySchema>;
    const m = ctx.m;
    m.maxConcurrentRuns = maxConcurrentRuns;
    await AppDataSource.getRepository(AIModel).update({ id: m.id }, { maxConcurrentRuns });
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, m, "model.configure", {
      maxConcurrentRuns,
      effectiveMaxConcurrentRuns: modelRunCapacity(m).limit,
    });
    // A higher limit admits waiting Runs now rather than at the next heartbeat.
    void dispatchQueuedRoutineRuns();
    await sendModel(res, ctx.co.id, m.id);
  },
);

// PUT /api/companies/:cid/models/:id/thinking
//
// How hard this model thinks in chat: the thinking level a conversation left
// on Default starts at, and the highest level Members may choose — higher
// levels take longer and spend more. Both apply to chat, Help and Repository
// work sessions on this model, for every AI Employee on it; Routines keep the
// model's own default. A custom endpoint offers levels only once its owners
// turn them on, because a compatible API says nothing about whether the
// server reads `reasoning_effort`. Each setting is one of the levels the
// model offers, or null for the model's own default and no limit.
const thinkingSettingsSchema = z
  .object({
    defaultEffort: z.enum(MODEL_EFFORT_VALUES).nullable(),
    effortCeiling: z.enum(MODEL_EFFORT_VALUES).nullable(),
    /** A custom endpoint only: send `reasoning_effort`, offering Off to High. */
    customThinkingLevels: z.boolean().optional(),
  })
  .strict();

companyModelsRouter.put(
  "/:id/thinking",
  validateParams(itemParamsSchema),
  validateBody(thinkingSettingsSchema),
  async (req, res) => {
    const p = req.params as Record<string, string>;
    const ctx = await loadModel(p.cid, p.id);
    if ("error" in ctx) return res.status(404).json({ error: ctx.error });
    const body = req.body as z.infer<typeof thinkingSettingsSchema>;
    const result = await saveModelThinkingSettings(ctx.m, body);
    if ("error" in result) return res.status(400).json({ error: result.error });
    emitResourceChange(ctx.co.id, "employee");
    await auditModel(req, ctx.co.id, ctx.m, "model.configure", {
      defaultEffort: result.model.defaultEffort,
      effortCeiling: result.model.effortCeiling,
      customThinkingLevels: result.model.customThinkingLevels,
    });
    await sendModel(res, ctx.co.id, ctx.m.id);
  },
);
