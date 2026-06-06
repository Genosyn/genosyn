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
import { PROVIDERS, isCliInstalled, isModelConnected } from "../services/providers.js";
import { effectiveActiveId, setActiveModel } from "../services/models.js";
import { removeDir } from "../services/files.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
import {
  CUSTOM_GOOSE_PROVIDER_SLUG,
  CUSTOM_OPENCODE_PROVIDER_SLUG,
  clearHarnessCacheDir,
  previewBaseURL,
} from "../services/customEndpoint.js";
import { recordAudit } from "../services/audit.js";
import {
  createPtySession,
  getPtySession,
  killPtySession,
  PtySpawnError,
  viewSession,
  writeToSession,
} from "../services/ptySessions.js";

/**
 * Per-employee Model routes, mounted at
 * `/api/companies/:cid/employees/:eid/models`.
 *
 * An employee can register several models and keep exactly one active. The
 * collection endpoints (`GET /`, `POST /`) operate on the whole set; the item
 * endpoints (`/:id/...`) target a single model. `POST /:id/activate` flips
 * which one the runner + chat seams spawn. The active flag is maintained by
 * `services/models.ts` so this layer never hand-rolls it.
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);

const providerSchema = z.enum(["claude-code", "codex", "opencode", "goose", "openclaw"]);
const authModeSchema = z.enum(["subscription", "apikey", "customEndpoint"]);

type PublicModel = {
  id: string;
  employeeId: string;
  provider: "claude-code" | "codex" | "opencode" | "goose" | "openclaw";
  model: string;
  authMode: "subscription" | "apikey" | "customEndpoint";
  /** True if this is the brain the runner + chat seams spawn for the employee. */
  isActive: boolean;
  connectedAt: string | null;
  status: "not_connected" | "connected";
  apiKeyMasked: string | null;
  /** Absolute path to the employee's per-provider config/data dir. */
  configDir: string;
  /** Env var name to prefix the login command with (e.g. CLAUDE_CONFIG_DIR). */
  configDirEnv: string;
  /** The login command the operator runs in a terminal. `null` for providers without a login flow (openclaw). */
  loginCommand: string | null;
  /** Env var for pay-as-you-go keys, or null if this provider doesn't use one. */
  apiKeyEnv: string | null;
  /** Does this provider support the "Use an API key" flow at all? */
  supportsApiKey: boolean;
  /** Does this provider support the "Sign in with subscription" flow at all? */
  supportsSubscription: boolean;
  /** Does this provider support a custom OpenAI-compatible endpoint (UI-driven)? */
  supportsCustomEndpoint: boolean;
  /** Host-only preview of the configured base URL — `null` when unset. */
  customEndpointHost: string | null;
  /** The raw model id stored on configJson (e.g. "qwen2.5-coder:32b") — `null` when unset. */
  customEndpointModelId: string | null;
  /** True if a custom-endpoint API key is on file (we never echo the plaintext). */
  customEndpointHasApiKey: boolean;
  /** True if the provider's CLI binary resolves on PATH right now. */
  cliInstalled: boolean;
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

function toPublic(m: AIModel, co: Company, emp: AIEmployee, isActive: boolean): PublicModel {
  const cfg = safeParseConfig(m.configJson);
  const apiKeyEncrypted = typeof cfg.apiKeyEncrypted === "string"
    ? (cfg.apiKeyEncrypted as string)
    : null;
  const customEndpointHost = typeof cfg.baseURLPreview === "string"
    ? (cfg.baseURLPreview as string)
    : null;
  const customEndpointModelId = typeof cfg.modelId === "string"
    ? (cfg.modelId as string)
    : null;
  const spec = PROVIDERS[m.provider];
  const connected = isModelConnected(m, co, emp);
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
    configDir: spec.configDir(co.slug, emp.slug),
    configDirEnv: spec.configDirEnv,
    loginCommand: spec.loginCommand,
    apiKeyEnv: spec.apiKeyEnv,
    supportsApiKey: spec.supportsApiKey,
    supportsSubscription: spec.supportsSubscription,
    supportsCustomEndpoint: spec.supportsCustomEndpoint,
    customEndpointHost,
    customEndpointModelId,
    customEndpointHasApiKey: m.authMode === "customEndpoint" && Boolean(apiKeyEncrypted),
    cliInstalled: isCliInstalled(m.provider),
  };
}

/**
 * Shape a single model for the wire, computing its `isActive` against the
 * employee's full set (so a freshly-saved row reflects the live flag without
 * the caller threading the list through).
 */
async function publicModel(m: AIModel, co: Company, emp: AIEmployee): Promise<PublicModel> {
  const all = await AppDataSource.getRepository(AIModel).find({
    where: { employeeId: emp.id },
  });
  const activeId = effectiveActiveId(all);
  return toPublic(m, co, emp, m.id === activeId);
}

function safeParseConfig(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function unsupportedAuthError(
  provider: z.infer<typeof providerSchema>,
  authMode: z.infer<typeof authModeSchema>,
): string | null {
  const spec = PROVIDERS[provider];
  if (authMode === "apikey" && !spec.supportsApiKey) {
    return `${provider} doesn't support API key auth — use subscription.`;
  }
  if (authMode === "subscription" && !spec.supportsSubscription) {
    return `${provider} doesn't support subscription auth — use an API key.`;
  }
  if (authMode === "customEndpoint" && !spec.supportsCustomEndpoint) {
    return `${provider} can't host a custom OpenAI-compatible endpoint — pick opencode or goose.`;
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
  res.json(all.map((m) => toPublic(m, ctx.co, ctx.emp, m.id === activeId)));
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
  // Ensure the provider config dir exists so the login CLI can write into it.
  if (body.authMode === "subscription") {
    const spec = PROVIDERS[body.provider];
    ensureDir(spec.configDir(ctx.co.slug, ctx.emp.slug));
    ensureDir(path.dirname(spec.credsPath(ctx.co.slug, ctx.emp.slug)));
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
  res.json(await publicModel(m, ctx.co, ctx.emp));
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
  const changedAuth = m.authMode !== body.authMode;
  m.provider = body.provider;
  m.model = body.model;
  m.authMode = body.authMode;
  // If auth mode switched, any prior credentials are invalid.
  if (changedAuth) {
    m.configJson = "{}";
    m.connectedAt = null;
  }
  await repo.save(m);
  if (body.authMode === "subscription") {
    const spec = PROVIDERS[body.provider];
    ensureDir(spec.configDir(ctx.co.slug, ctx.emp.slug));
    ensureDir(path.dirname(spec.credsPath(ctx.co.slug, ctx.emp.slug)));
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
  res.json(await publicModel(m, ctx.co, ctx.emp));
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
  res.json(await publicModel(ctx.m, ctx.co, ctx.emp));
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
    return res.status(400).json({ error: `${m.provider} doesn't support API key auth` });
  }
  const { apiKey } = req.body as z.infer<typeof apiKeySchema>;
  const cfg = safeParseConfig(m.configJson);
  cfg.apiKeyEncrypted = encryptSecret(apiKey);
  cfg.apiKeyPreview = maskSecret(apiKey);
  m.configJson = JSON.stringify(cfg);
  m.connectedAt = new Date();
  await AppDataSource.getRepository(AIModel).save(m);
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.apikey.set",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json(await publicModel(m, ctx.co, ctx.emp));
});

// POST /api/companies/:cid/employees/:eid/models/:id/custom-endpoint
//
// Save (or update) a custom OpenAI-compatible endpoint configuration. The
// model row must already be in customEndpoint authMode (set via POST / or
// PUT /:id). The base URL is required; the API key is optional (most local
// LLMs don't enforce one). modelId is the raw model name the upstream server
// exposes (e.g. "qwen2.5-coder:32b") — we synthesize the harness-side
// `<provider>/<model>` string when we save to AIModel.model so the existing
// buildInvocation path doesn't need to know about customEndpoint.
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

modelsRouter.post(
  "/:id/custom-endpoint",
  validateBody(customEndpointSchema),
  async (req, res) => {
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
    const cfg = safeParseConfig(m.configJson);
    cfg.baseURLEncrypted = encryptSecret(baseURL);
    cfg.baseURLPreview = previewBaseURL(baseURL);
    cfg.modelId = modelId;
    if (apiKey) {
      cfg.apiKeyEncrypted = encryptSecret(apiKey);
      cfg.apiKeyPreview = maskSecret(apiKey);
    } else {
      // Clear any previously-set key so toggling apiKey off actually unsets it.
      delete cfg.apiKeyEncrypted;
      delete cfg.apiKeyPreview;
    }
    m.configJson = JSON.stringify(cfg);
    // Mirror the harness-prefixed string into AIModel.model so the existing
    // invocation path (which passes model.model to `--model`) just works.
    const slug =
      m.provider === "opencode" ? CUSTOM_OPENCODE_PROVIDER_SLUG : CUSTOM_GOOSE_PROVIDER_SLUG;
    m.model = `${slug}/${modelId}`;
    m.connectedAt = new Date();
    // Wipe any stale subscription/apikey state lying in the harness cache dir.
    // Spawn-time materializers re-create whatever the runner needs.
    clearHarnessCacheDir(m.provider, ctx.co.slug, ctx.emp.slug);
    await AppDataSource.getRepository(AIModel).save(m);
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
    res.json(await publicModel(m, ctx.co, ctx.emp));
  },
);

// POST /api/companies/:cid/employees/:eid/models/:id/refresh
// For subscription mode: re-check whether the creds file has appeared.
// Separate endpoint so the client can poll cheaply while the user signs in.
modelsRouter.post("/:id/refresh", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  const nowConnected = isModelConnected(m, ctx.co, ctx.emp);
  if (nowConnected && !m.connectedAt) {
    m.connectedAt = new Date();
    await AppDataSource.getRepository(AIModel).save(m);
  }
  if (!nowConnected && m.connectedAt && m.authMode === "subscription") {
    m.connectedAt = null;
    await AppDataSource.getRepository(AIModel).save(m);
  }
  res.json(await publicModel(m, ctx.co, ctx.emp));
});

// DELETE /api/companies/:cid/employees/:eid/models/:id — disconnect one model
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
  // If we removed the active brain, promote the most-recently-added survivor
  // so the employee always has a defined active model.
  if (remaining.length > 0 && !remaining.some((r) => r.isActive)) {
    const promote = effectiveActiveId(remaining);
    if (promote) await setActiveModel(ctx.emp.id, promote);
  }
  // Wipe on-disk creds for this provider only if no surviving model still
  // uses it — sibling models that share the provider's subscription dir
  // (e.g. two claude-code models) must keep their credentials.
  if (!remaining.some((r) => r.provider === m.provider)) {
    removeDir(PROVIDERS[m.provider].configDir(ctx.co.slug, ctx.emp.slug));
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

// ---------- Pty-backed install + login surface ----------
//
// Both endpoints below spawn a real pty so an interactive CLI (`claude login`,
// `npm install -g`, `goose configure`) thinks it's running under a terminal.
// The browser polls `/session/:id/output` for new bytes and posts back to
// `/session/:id/input` to forward keystrokes — letting the operator paste an
// OAuth code or hit ENTER on a prompt without ever leaving the page.

function asciiSafe(s: string): boolean {
  // Defensive: pty input is forwarded raw, so cap length and reject control
  // bytes outside of the printable + common control range. ENTER (0x0d / 0x0a),
  // TAB (0x09), and ESC (0x1b) are allowed — they're how arrow-key prompts and
  // wizard menus are driven.
  if (s.length > 4096) return false;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x1b) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function buildLoginEnv(configDir: string, configDirEnv: string): NodeJS.ProcessEnv {
  // Copy the operator's env, strip any ambient provider creds (mirror of the
  // runner's buildProviderEnv hygiene), then pin the config dir at the
  // employee's directory so login lands in the right place.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "GOOSE_PROVIDER",
    "GOOSE_MODEL",
    "GOOSE_DISABLE_KEYRING",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
  ]) {
    delete env[key];
  }
  env[configDirEnv] = configDir;
  // Goose stashes creds in the host keychain by default; force file-based
  // auth so per-employee isolation actually holds. Harmless for other
  // providers since they don't read this var.
  env.GOOSE_DISABLE_KEYRING = "1";
  // Force a non-CI, interactive-feeling shell so OAuth flows don't shortcut
  // to "no browser" mode. node-pty already sets TERM=xterm-256color.
  env.CI = "";
  return env;
}

// POST /api/companies/:cid/employees/:eid/models/:id/install
// Spawn the provider's installer under a pty. Returns a sessionId the client
// polls for output and exit.
modelsRouter.post("/:id/install", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  if (isCliInstalled(m.provider)) {
    return res.status(409).json({ error: `${m.provider} CLI is already installed.` });
  }
  const spec = PROVIDERS[m.provider];
  let session;
  try {
    session = createPtySession({
      kind: "install",
      provider: m.provider,
      companyId: ctx.co.id,
      employeeId: ctx.emp.id,
      cmd: spec.installArgv.cmd,
      args: spec.installArgv.args,
      env: { ...process.env },
      cwd: process.cwd(),
    });
  } catch (err) {
    if (err instanceof PtySpawnError) {
      return res.status(500).json({
        error: `Couldn't start the installer (${err.cmd} not found or not executable). On Docker the CLIs ship pre-installed; on bare metal you may need to install Node + npm first.`,
      });
    }
    throw err;
  }
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.install.start",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json({ sessionId: session.id });
});

// POST /api/companies/:cid/employees/:eid/models/:id/login
// Spawn the provider's login command under a pty for in-browser sign-in.
modelsRouter.post("/:id/login", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadModelContext(p.cid, p.eid, p.id);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const m = ctx.m;
  if (m.authMode !== "subscription") {
    return res.status(400).json({ error: "Model is not in subscription mode" });
  }
  const spec = PROVIDERS[m.provider];
  if (!spec.loginArgv || !spec.supportsSubscription) {
    return res
      .status(400)
      .json({ error: `${m.provider} doesn't have a sign-in flow — use an API key.` });
  }
  if (!isCliInstalled(m.provider)) {
    return res
      .status(409)
      .json({ error: `${m.provider} CLI is not installed yet. Install it first.` });
  }
  const configDir = spec.configDir(ctx.co.slug, ctx.emp.slug);
  ensureDir(configDir);
  ensureDir(path.dirname(spec.credsPath(ctx.co.slug, ctx.emp.slug)));
  const loginArgv = spec.loginArgv;
  let session;
  try {
    session = createPtySession({
      kind: "login",
      provider: m.provider,
      companyId: ctx.co.id,
      employeeId: ctx.emp.id,
      cmd: loginArgv.cmd,
      args: loginArgv.args,
      env: buildLoginEnv(configDir, spec.configDirEnv),
      cwd: configDir,
    });
  } catch (err) {
    if (err instanceof PtySpawnError) {
      return res.status(500).json({
        error: `Couldn't start ${loginArgv.cmd}. The CLI may have moved off PATH since the install check ran — try the install button again.`,
      });
    }
    throw err;
  }
  await recordAudit({
    companyId: ctx.co.id,
    actorUserId: req.userId ?? null,
    action: "model.login.start",
    targetType: "employee",
    targetId: ctx.emp.id,
    targetLabel: ctx.emp.name,
    metadata: { provider: m.provider },
  });
  res.json({ sessionId: session.id });
});

// GET /api/companies/:cid/employees/:eid/models/:id/session/:sid?since=<int>
// Returns new pty output since `since` plus the exit state. Cheap to poll.
// `:id` is cosmetic here — the pty session is keyed by company + employee, so
// the panel keeps working even if the model row is mid-reconfigure.
modelsRouter.get("/:id/session/:sid", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const session = getPtySession(p.sid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.companyId !== ctx.co.id || session.employeeId !== ctx.emp.id) {
    // Don't reveal cross-tenant existence; same shape as a missing record.
    return res.status(404).json({ error: "Session not found" });
  }
  const since = Number.parseInt(String(req.query.since ?? "0"), 10);
  res.json(viewSession(session, Number.isFinite(since) ? since : 0));
});

// POST /api/companies/:cid/employees/:eid/models/:id/session/:sid/input
// Forward `data` to the pty's stdin. Used to paste OAuth codes or hit ENTER.
const inputSchema = z.object({ data: z.string().max(4096) });
modelsRouter.post("/:id/session/:sid/input", validateBody(inputSchema), async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const session = getPtySession(p.sid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.companyId !== ctx.co.id || session.employeeId !== ctx.emp.id) {
    return res.status(404).json({ error: "Session not found" });
  }
  const { data } = req.body as z.infer<typeof inputSchema>;
  if (!asciiSafe(data)) return res.status(400).json({ error: "Disallowed control bytes in input" });
  const ok = writeToSession(p.sid, data);
  if (!ok) return res.status(409).json({ error: "Session is no longer accepting input" });
  res.json({ ok: true });
});

// POST /api/companies/:cid/employees/:eid/models/:id/session/:sid/cancel
// Kill an in-flight pty (operator clicked Cancel, or the page is unloading).
modelsRouter.post("/:id/session/:sid/cancel", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const session = getPtySession(p.sid);
  if (!session) return res.json({ ok: true });
  if (session.companyId !== ctx.co.id || session.employeeId !== ctx.emp.id) {
    return res.status(404).json({ error: "Session not found" });
  }
  killPtySession(p.sid);
  res.json({ ok: true });
});
