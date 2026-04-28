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
import { removeDir } from "../services/files.js";
import { encryptSecret, maskSecret } from "../lib/secret.js";
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
 * Per-employee Model routes. Mounted twice in `index.ts`:
 *  - /api/companies/:cid/employees/:eid/model   (per-employee CRUD)
 *  - /api/companies/:cid/models                 (read-only overview; see GET /overview)
 */
export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);

const providerSchema = z.enum(["claude-code", "codex", "opencode", "goose"]);
const authModeSchema = z.enum(["subscription", "apikey"]);

type PublicModel = {
  id: string;
  employeeId: string;
  provider: "claude-code" | "codex" | "opencode" | "goose";
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
  /** True if the provider's CLI binary resolves on PATH right now. */
  cliInstalled: boolean;
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
    cliInstalled: isCliInstalled(m.provider),
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
  // write into it. Some providers (opencode, goose) follow XDG conventions
  // and write auth into a nested subdirectory of the config dir — pre-create
  // it for everyone so the CLI doesn't error on first login.
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

// POST /api/companies/:cid/employees/:eid/model/install
// Spawn the provider's installer under a pty. Returns a sessionId the client
// polls for output and exit. Caller must have already PUT a model row.
modelsRouter.post("/install", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.status(404).json({ error: "Configure provider/model first" });
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

// POST /api/companies/:cid/employees/:eid/model/login
// Spawn the provider's login command under a pty for in-browser sign-in.
// The CLI must already be installed; surfacing a clear error here means the
// frontend never has to guess at install state when it shows the "Sign in"
// button.
modelsRouter.post("/login", async (req, res) => {
  const p = req.params as Record<string, string>;
  const ctx = await loadContext(p.cid, p.eid);
  if ("error" in ctx) return res.status(404).json({ error: ctx.error });
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ employeeId: ctx.emp.id });
  if (!m) return res.status(404).json({ error: "Configure provider/model first" });
  if (m.authMode !== "subscription") {
    return res.status(400).json({ error: "Model is not in subscription mode" });
  }
  if (!isCliInstalled(m.provider)) {
    return res
      .status(409)
      .json({ error: `${m.provider} CLI is not installed yet. Install it first.` });
  }
  const spec = PROVIDERS[m.provider];
  const configDir = spec.configDir(ctx.co.slug, ctx.emp.slug);
  ensureDir(configDir);
  ensureDir(path.dirname(spec.credsPath(ctx.co.slug, ctx.emp.slug)));
  let session;
  try {
    session = createPtySession({
      kind: "login",
      provider: m.provider,
      companyId: ctx.co.id,
      employeeId: ctx.emp.id,
      cmd: spec.loginArgv.cmd,
      args: spec.loginArgv.args,
      env: buildLoginEnv(configDir, spec.configDirEnv),
      cwd: configDir,
    });
  } catch (err) {
    if (err instanceof PtySpawnError) {
      return res.status(500).json({
        error: `Couldn't start ${spec.loginArgv.cmd}. The CLI may have moved off PATH since the install check ran — try the install button again.`,
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

// GET /api/companies/:cid/employees/:eid/model/session/:sid?since=<int>
// Returns new pty output since `since` plus the exit state. Cheap to poll.
modelsRouter.get("/session/:sid", async (req, res) => {
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

// POST /api/companies/:cid/employees/:eid/model/session/:sid/input
// Forward `data` to the pty's stdin. Used to paste OAuth codes or hit ENTER.
const inputSchema = z.object({ data: z.string().max(4096) });
modelsRouter.post("/session/:sid/input", validateBody(inputSchema), async (req, res) => {
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

// POST /api/companies/:cid/employees/:eid/model/session/:sid/cancel
// Kill an in-flight pty (operator clicked Cancel, or the page is unloading).
modelsRouter.post("/session/:sid/cancel", async (req, res) => {
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
