import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Membership } from "../db/entities/Membership.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { CodexAppServer } from "./agent/codexAppServer.js";
import { bubblewrapProbeError } from "./runtimeSecurity.js";

const AUTH_FILE_MAX_BYTES = 2 * 1024 * 1024;
const ACCOUNT_READ_TIMEOUT_MS = 30_000;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const TERMINAL_SESSION_TTL_MS = 15 * 60 * 1_000;
const STALE_TEMP_MAX_AGE_MS = 8 * 60 * 60 * 1_000;
const MAX_ACTIVE_DEVICE_SESSIONS = 8;
const AUTH_TEMP_PREFIX = "genosyn-codex-auth-";
const WORK_TEMP_PREFIX = "genosyn-codex-work-";
const REMOVE_RETRY_DELAYS_MS = [0, 50, 250] as const;

/**
 * Codex keeps its diagnostics in a SQLite log database inside `CODEX_HOME` and
 * writes nothing to stderr unless `RUST_LOG` asks it to. Both this service's
 * login and turn paths delete that home the moment they finish, so without this
 * filter every failure arrives with its cause already destroyed. Warnings and
 * errors alone are near-silent on a healthy sign-in; `codex_login::server`
 * additionally confirms at info level that a token exchange was attempted.
 */
const CODEX_LOG_FILTER = "warn,codex_login::server=info";

export type SubscriptionCredentialKind = "chatgptSession" | "accessToken";
export type SubscriptionDeviceStatus = "running" | "succeeded" | "failed" | "cancelled";

export class SubscriptionCredentialConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionCredentialConflictError";
  }
}

export type PublicSubscriptionDeviceSession = {
  id: string;
  status: SubscriptionDeviceStatus;
  output: string | null;
  loginUrl: string | null;
  userCode: string | null;
  error: string | null;
};

type DeviceSession = PublicSubscriptionDeviceSession & {
  modelId: string;
  companyId: string;
  actorUserId: string;
  expectedConfigJson: string;
  loginId: string | null;
  home: IsolatedCodexHome;
  server: CodexAppServer;
  timeout: ReturnType<typeof setTimeout>;
  settling: boolean;
  finishStarted: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
};

type IsolatedCodexHome = {
  authRoot: string;
  workspace: string;
};

export type CodexRuntimeLease = {
  /** Fresh row loaded after this model's refresh-token lock was acquired. */
  model: AIModel;
  home: IsolatedCodexHome;
  env: NodeJS.ProcessEnv;
  credentialKind: SubscriptionCredentialKind;
  finish: () => Promise<void>;
};

const deviceSessions = new Map<string, DeviceSession>();
const deviceStarts = new Map<string, Promise<PublicSubscriptionDeviceSession>>();
const modelLockTails = new Map<string, Promise<void>>();

void sweepStaleCodexHomes();

/**
 * Locked-down app-server config used for both login and AI Employee turns.
 *
 * Codex receives only an empty scratch cwd. Genosyn's existing dynamic tools
 * remain the sole path to employee files, browser sessions, Connections and
 * other granted resources, so the product's own sandbox and approval policy
 * stay authoritative.
 */
export const CODEX_CONFIG_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'mcp_oauth_credentials_store="file"',
  'web_search="disabled"',
  "tools.web_search=false",
  "project_doc_max_bytes=0",
  "project_doc_fallback_filenames=[]",
  'history.persistence="none"',
  "agents.enabled=false",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.apps=false",
  "features.goals=false",
  "features.hooks=false",
  "features.memories=false",
  "features.multi_agent=false",
  "features.plugins=false",
  "features.remote_plugin=false",
  "features.skill_search=false",
  "features.skill_mcp_dependency_install=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.browser_use_full_cdp_access=false",
  "features.computer_use=false",
  "features.in_app_browser=false",
  "features.image_generation=false",
  "features.code_mode_host=false",
  "features.workspace_dependencies=false",
  "features.tool_suggest=false",
  "features.auth_elicitation=false",
  "features.tool_call_mcp_elicitation=false",
  "analytics.enabled=false",
  'otel.exporter="none"',
  'otel.metrics_exporter="none"',
  'otel.trace_exporter="none"',
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'shell_environment_policy.inherit="none"',
  "shell_environment_policy.ignore_default_excludes=false",
  "shell_environment_policy.include_only=[]",
  "allow_login_shell=false",
] as const;

export function subscriptionUnavailableReasonFor(options: {
  multiTenant: boolean;
  codingToolsEnabled: boolean;
  codingToolsExecutionMode: "host" | "bubblewrap" | "disabled";
  bubblewrapAvailable: boolean;
}): string | null {
  if (options.multiTenant) {
    return "ChatGPT subscription sign-in is limited to trusted self-hosted Genosyn installs.";
  }
  if (options.codingToolsExecutionMode === "disabled") {
    return null;
  }
  if (options.codingToolsExecutionMode === "host") {
    return 'ChatGPT subscription auth cannot run beside host-process tools. Set config.agent.codingTools.executionMode to "disabled" for subscription access without coding tools, or use "bubblewrap" on Linux for an isolated shell.';
  }
  if (!options.codingToolsEnabled) {
    return null;
  }
  if (!options.bubblewrapAvailable) {
    return "ChatGPT subscription auth requires a working bubblewrap executable and user namespaces.";
  }
  return null;
}

export function subscriptionUnavailableReason(): string | null {
  // Preserve the cheap configuration checks on the normal host-mode path.
  // The full namespace probe is synchronous and may take up to five seconds on
  // a restrictive container, so run it only after the operator has explicitly
  // selected bubblewrap.
  const executionMode = config.agent.codingTools.executionMode;
  const codingToolsEnabled = config.agent.codingTools.enabled;
  if (config.security.multiTenant || executionMode !== "bubblewrap" || !codingToolsEnabled) {
    return subscriptionUnavailableReasonFor({
      multiTenant: config.security.multiTenant,
      codingToolsEnabled,
      codingToolsExecutionMode: executionMode,
      bubblewrapAvailable: false,
    });
  }
  return subscriptionUnavailableReasonFor({
    multiTenant: false,
    codingToolsEnabled,
    codingToolsExecutionMode: executionMode,
    bubblewrapAvailable: bubblewrapProbeError() === null,
  });
}

/**
 * Repository checkouts are writable by the AI Employee, including `.git/config`.
 * Never hand one of those configs to a host-side git process immediately before
 * materializing a subscription credential: git config can name executable
 * credential helpers, SSH commands, remote helpers, and other hooks into the
 * App UID. Subscription turns keep repository work inside the coding sandbox.
 */
export function shouldMaterializeRepositoriesForTurnFor(options: {
  authMode: AIModel["authMode"];
  codingToolsEnabled: boolean;
  codingToolsExecutionMode: "host" | "bubblewrap" | "disabled";
}): boolean {
  if (!options.codingToolsEnabled || options.codingToolsExecutionMode === "disabled") return false;
  if (options.authMode === "subscription") {
    return options.codingToolsExecutionMode === "bubblewrap";
  }
  return true;
}

export function shouldMaterializeRepositoriesForTurn(authMode: AIModel["authMode"]): boolean {
  return shouldMaterializeRepositoriesForTurnFor({
    authMode,
    codingToolsEnabled: config.agent.codingTools.enabled,
    codingToolsExecutionMode: config.agent.codingTools.executionMode,
  });
}

export function subscriptionCredentialKind(model: AIModel): SubscriptionCredentialKind | null {
  const cfg = parseModelConfig(model.configJson);
  if (nonEmptyString(cfg.codexAuthEncrypted)) return "chatgptSession";
  if (nonEmptyString(cfg.codexAccessTokenEncrypted)) return "accessToken";
  return null;
}

export function hasSubscriptionCredential(model: AIModel): boolean {
  return subscriptionCredentialKind(model) !== null;
}

export function configWithSubscriptionAccessToken(model: AIModel, accessToken: string): string {
  const cfg = parseModelConfig(model.configJson);
  delete cfg.codexAuthEncrypted;
  cfg.codexAccessTokenEncrypted = encryptSecret(accessToken, subscriptionScope(model.id));
  cfg.subscriptionCredentialKind = "accessToken";
  return JSON.stringify(cfg);
}

export async function saveSubscriptionAccessToken(
  modelId: string,
  accessToken: string,
): Promise<AIModel> {
  assertSubscriptionAllowed();
  await cancelSubscriptionDeviceLoginsForModel(modelId);
  const model = await loadSubscriptionModel(modelId);
  const nextConfig = configWithSubscriptionAccessToken(model, accessToken);
  const repo = AppDataSource.getRepository(AIModel);
  const updated = await repo.update(
    {
      id: model.id,
      provider: "openai",
      authMode: "subscription",
      configJson: model.configJson,
    },
    {
      configJson: nextConfig,
      connectedAt: new Date(),
    },
  );
  if (updated.affected !== 1) {
    throw new SubscriptionCredentialConflictError(
      "This AI Model changed while the access token was being saved. Try again.",
    );
  }
  const saved = await repo.findOneBy({ id: model.id });
  if (!saved) throw new Error("AI Model not found after saving its access token.");
  return saved;
}

export async function startSubscriptionDeviceLogin(
  modelId: string,
  authorization: { companyId: string; actorUserId: string },
): Promise<PublicSubscriptionDeviceSession> {
  const existingStart = deviceStarts.get(modelId);
  if (existingStart) return existingStart;
  const running = [...deviceSessions.values()].find(
    (session) => session.modelId === modelId && session.status === "running",
  );
  if (running) return publicSession(running);
  const activeModels = new Set([
    ...deviceStarts.keys(),
    ...[...deviceSessions.values()]
      .filter((session) => session.status === "running")
      .map((session) => session.modelId),
  ]);
  if (activeModels.size >= MAX_ACTIVE_DEVICE_SESSIONS) {
    throw new Error(
      `This Genosyn process already has ${MAX_ACTIVE_DEVICE_SESSIONS} active ChatGPT sign-ins. Cancel or finish one before starting another.`,
    );
  }

  const start = startSubscriptionDeviceLoginInner(modelId, authorization);
  deviceStarts.set(modelId, start);
  try {
    return await start;
  } finally {
    if (deviceStarts.get(modelId) === start) deviceStarts.delete(modelId);
  }
}

async function startSubscriptionDeviceLoginInner(
  modelId: string,
  authorization: { companyId: string; actorUserId: string },
): Promise<PublicSubscriptionDeviceSession> {
  assertSubscriptionAllowed();
  const model = await loadSubscriptionModel(modelId);
  const running = [...deviceSessions.values()].find(
    (session) => session.modelId === model.id && session.status === "running",
  );
  if (running) return publicSession(running);

  const home = await createIsolatedCodexHome();
  let server: CodexAppServer | null = null;
  try {
    server = await CodexAppServer.start({
      cwd: home.workspace,
      env: codexEnvironment(home.authRoot),
      configOverrides: [...CODEX_CONFIG_OVERRIDES],
    });

    const id = crypto.randomUUID();
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const session: DeviceSession = {
      id,
      modelId: model.id,
      companyId: authorization.companyId,
      actorUserId: authorization.actorUserId,
      expectedConfigJson: model.configJson,
      status: "running" as const,
      output: "Waiting for ChatGPT device authorization.",
      loginUrl: null,
      userCode: null,
      error: null,
      loginId: null,
      home,
      server,
      settling: false,
      finishStarted: false,
      finished,
      resolveFinished,
      timeout: setTimeout(() => undefined, DEVICE_LOGIN_TIMEOUT_MS),
    };
    clearTimeout(session.timeout);

    const earlyCompletion: { value: Record<string, unknown> | null } = {
      value: null,
    };
    const stopNotifications = server.onNotification((method, params) => {
      if (method !== "account/login/completed") return;
      const body = asObject(params);
      if (!body) return;
      if (!session.loginId) {
        earlyCompletion.value = body;
        return;
      }
      if (body.loginId !== session.loginId) return;
      stopNotifications();
      void settleDeviceSession(
        session,
        body.success === true ? "succeeded" : "failed",
        typeof body.error === "string" ? body.error : null,
      );
    });
    server.onExit((error) => {
      if (session.status !== "running") return;
      void settleDeviceSession(
        session,
        "failed",
        error?.message || "OpenAI Codex closed before sign-in completed.",
      );
    });

    const login = await server.request<{
      type: string;
      loginId?: string;
      verificationUrl?: string;
      userCode?: string;
    }>("account/login/start", { type: "chatgptDeviceCode" }, 60_000);
    const verificationUrl = parseDeviceVerificationUrl(login.verificationUrl);
    if (
      login.type !== "chatgptDeviceCode" ||
      !nonEmptyString(login.loginId) ||
      !verificationUrl ||
      !nonEmptyString(login.userCode)
    ) {
      throw new Error("OpenAI Codex returned an invalid device sign-in response.");
    }

    session.loginId = login.loginId;
    session.loginUrl = verificationUrl;
    session.userCode = login.userCode;
    session.timeout = setTimeout(() => {
      void settleDeviceSession(
        session,
        "failed",
        "ChatGPT sign-in expired. Start a new sign-in to try again.",
      );
    }, DEVICE_LOGIN_TIMEOUT_MS);
    session.timeout.unref?.();
    deviceSessions.set(id, session);
    if (earlyCompletion.value?.loginId === session.loginId) {
      stopNotifications();
      void settleDeviceSession(
        session,
        earlyCompletion.value.success === true ? "succeeded" : "failed",
        typeof earlyCompletion.value.error === "string" ? earlyCompletion.value.error : null,
      );
    }
    return publicSession(session);
  } catch (error) {
    if (server) await server.close().catch(() => undefined);
    await removeIsolatedCodexHome(home);
    throw error;
  }
}

export function parseDeviceVerificationUrl(value: unknown): string | null {
  if (!nonEmptyString(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getSubscriptionDeviceLogin(
  modelId: string,
  sessionId: string,
): PublicSubscriptionDeviceSession | null {
  const session = deviceSessions.get(sessionId);
  return session && session.modelId === modelId ? publicSession(session) : null;
}

export async function cancelSubscriptionDeviceLogin(
  modelId: string,
  sessionId: string,
): Promise<PublicSubscriptionDeviceSession | null> {
  const session = deviceSessions.get(sessionId);
  if (!session || session.modelId !== modelId) return null;
  if (session.status !== "running") return publicSession(session);
  if (session.settling) {
    await session.finished;
    return publicSession(session);
  }

  session.status = "cancelled";
  if (session.loginId) {
    await session.server
      .request("account/login/cancel", { loginId: session.loginId }, 10_000)
      .catch(() => undefined);
  }
  await finishDeviceSession(session);
  return publicSession(session);
}

export async function cancelSubscriptionDeviceLoginsForModel(modelId: string): Promise<void> {
  await deviceStarts.get(modelId)?.catch(() => undefined);
  const matching = [...deviceSessions.values()].filter(
    (session) => session.modelId === modelId && session.status === "running",
  );
  await Promise.all(matching.map((session) => cancelSubscriptionDeviceLogin(modelId, session.id)));
}

/**
 * Materialize the model's encrypted credential into a private, short-lived
 * Codex home. Managed ChatGPT auth may refresh while a turn runs; `finish`
 * merges the refreshed JSON back into the same model row only if an admin did
 * not replace the credential in the meantime.
 */
export async function prepareCodexRuntime(modelId: string): Promise<CodexRuntimeLease> {
  assertSubscriptionAllowed();
  const model = await loadSubscriptionModel(modelId);

  const home = await createIsolatedCodexHome();
  const cfg = parseModelConfig(model.configJson);
  const authEncrypted = stringValue(cfg.codexAuthEncrypted);
  const accessTokenEncrypted = stringValue(cfg.codexAccessTokenEncrypted);

  try {
    if (authEncrypted) {
      const authJson = decryptSecret(authEncrypted);
      validateManagedAuthJson(authJson);
      await fs.writeFile(path.join(home.authRoot, "auth.json"), authJson, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return {
        model,
        home,
        env: codexEnvironment(home.authRoot),
        credentialKind: "chatgptSession",
        finish: async () => {
          try {
            const refreshed = await readManagedAuthJson(home.authRoot);
            if (refreshed !== authJson) {
              await persistRefreshedManagedAuth(model.id, authEncrypted, refreshed);
            }
          } finally {
            await removeIsolatedCodexHome(home);
          }
        },
      };
    }

    if (accessTokenEncrypted) {
      const accessToken = decryptSecret(accessTokenEncrypted);
      if (!accessToken.trim()) throw new Error("The stored OpenAI access token is empty.");
      return {
        model,
        home,
        env: codexEnvironment(home.authRoot, accessToken),
        credentialKind: "accessToken",
        finish: () => removeIsolatedCodexHome(home),
      };
    }

    throw new Error(
      "No ChatGPT subscription credential is connected. Open Settings → Model and sign in.",
    );
  } catch (error) {
    await removeIsolatedCodexHome(home);
    throw error;
  }
}

/**
 * Managed ChatGPT refresh tokens rotate. Serialize turns using the same model
 * so two copied temporary auth files can never race and invalidate each other.
 */
export async function withSubscriptionModelLock<T>(
  modelId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = modelLockTails.get(modelId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  modelLockTails.set(modelId, tail);

  try {
    await waitForLock(previous, signal);
    if (signal?.aborted) throw abortError();
    return await run();
  } finally {
    release();
    void tail.finally(() => {
      if (modelLockTails.get(modelId) === tail) modelLockTails.delete(modelId);
    });
  }
}

async function settleDeviceSession(
  session: DeviceSession,
  status: "succeeded" | "failed",
  error: string | null,
): Promise<void> {
  if (session.status !== "running" || session.settling) return;
  session.settling = true;
  try {
    if (status === "succeeded") {
      const confirmed = await confirmManagedChatgptAccount((params) =>
        session.server.request<unknown>("account/read", params, ACCOUNT_READ_TIMEOUT_MS),
      );
      if (!confirmed) {
        throw new Error("OpenAI Codex did not confirm the managed ChatGPT account.");
      }
      const authJson = await readManagedAuthJson(session.home.authRoot);
      const membership = await AppDataSource.getRepository(Membership).findOneBy({
        companyId: session.companyId,
        userId: session.actorUserId,
      });
      if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
        throw new Error("The Member who started sign-in is no longer an admin of this company.");
      }
      const cfg = parseModelConfig(session.expectedConfigJson);
      delete cfg.codexAccessTokenEncrypted;
      cfg.codexAuthEncrypted = encryptSecret(authJson, subscriptionScope(session.modelId));
      cfg.subscriptionCredentialKind = "chatgptSession";
      const updated = await AppDataSource.getRepository(AIModel).update(
        {
          id: session.modelId,
          provider: "openai",
          authMode: "subscription",
          configJson: session.expectedConfigJson,
        },
        {
          configJson: JSON.stringify(cfg),
          connectedAt: new Date(),
        },
      );
      if (updated.affected !== 1) {
        throw new Error(
          "This AI Model changed while sign-in was in progress. Start sign-in again.",
        );
      }
      session.status = "succeeded";
      session.output = "ChatGPT subscription connected.";
      session.error = null;
    } else {
      session.status = "failed";
      session.output = null;
      session.error = safePublicError(
        describeDeviceLoginFailure(error || "ChatGPT sign-in failed."),
      );
    }
  } catch (persistError) {
    session.status = "failed";
    session.output = null;
    session.error = safePublicError(
      persistError instanceof Error ? persistError.message : String(persistError),
    );
  } finally {
    await finishDeviceSession(session);
  }
}

async function finishDeviceSession(session: DeviceSession): Promise<void> {
  if (session.finishStarted) {
    await session.finished;
    return;
  }
  session.finishStarted = true;
  try {
    clearTimeout(session.timeout);
    await session.server.close().catch(() => undefined);
    // Delete the home that just held a credential before doing anything as
    // optional as logging: the stderr this reports is already buffered in
    // memory, so it survives the directory it described.
    await removeIsolatedCodexHome(session.home);
    logFailedDeviceLogin(session);
    const expiry = setTimeout(() => deviceSessions.delete(session.id), TERMINAL_SESSION_TTL_MS);
    expiry.unref?.();
  } finally {
    session.resolveFinished();
  }
}

/** How reqwest words a request that never got an answer, in all its shapes. */
const TRANSPORT_FAILURE_PATTERN =
  /error sending request|error trying to connect|tcp connect error|connection closed before message completed|dns error|operation timed out/i;

/**
 * Codex reports a failed token exchange in reqwest's transport wording, which
 * names the endpoint but never the cause: the connect, DNS, TLS or timeout
 * detail behind it stays in Codex's own log. Reaching this point means the
 * one-time code was already accepted, so the browser half of the sign-in
 * worked and only the call from this install to OpenAI did not. Say that,
 * because "error sending request" alone reads like a dead end.
 */
export function describeDeviceLoginFailure(error: string): string {
  if (!TRANSPORT_FAILURE_PATTERN.test(error)) return error;
  return `${error}. Your one-time code was accepted, so this is a network problem between Genosyn and OpenAI, not a rejected sign-in. Check outbound HTTPS, DNS, and any proxy or TLS interception on this install, then start a new sign-in. The Genosyn server log records the underlying cause.`;
}

/**
 * The isolated `CODEX_HOME` is about to be deleted, and with it the SQLite log
 * database holding Codex's own account of the failure. Its stderr stream is the
 * only copy that outlives the temporary home, so record it for the operator —
 * the Member reading the sign-in card is told what to check, but only this line
 * names which of connect, DNS, TLS or timeout actually failed.
 */
function logFailedDeviceLogin(session: DeviceSession): void {
  if (session.status !== "failed") return;
  const detail = session.server.stderrSummary();
  console.warn(
    `[genosyn] ChatGPT sign-in failed for AI Model ${session.modelId}: ${
      session.error ?? "unknown error"
    }${detail ? ` | codex: ${detail}` : ""}`,
  );
}

async function persistRefreshedManagedAuth(
  modelId: string,
  expectedCiphertext: string,
  authJson: string,
): Promise<void> {
  validateManagedAuthJson(authJson);
  const repo = AppDataSource.getRepository(AIModel);
  const fresh = await repo.findOneBy({ id: modelId });
  if (!fresh || fresh.provider !== "openai" || fresh.authMode !== "subscription") return;
  const cfg = parseModelConfig(fresh.configJson);
  if (cfg.codexAuthEncrypted !== expectedCiphertext || cfg.codexAccessTokenEncrypted) return;
  cfg.codexAuthEncrypted = encryptSecret(authJson, subscriptionScope(modelId));
  cfg.subscriptionCredentialKind = "chatgptSession";
  await repo.update(
    {
      id: modelId,
      provider: "openai",
      authMode: "subscription",
      configJson: fresh.configJson,
    },
    {
      configJson: JSON.stringify(cfg),
      connectedAt: fresh.connectedAt ?? new Date(),
    },
  );
}

async function loadSubscriptionModel(modelId: string): Promise<AIModel> {
  const model = await AppDataSource.getRepository(AIModel).findOneBy({ id: modelId });
  if (!model) throw new Error("AI Model not found.");
  if (model.provider !== "openai" || model.authMode !== "subscription") {
    throw new Error("Only OpenAI AI Models in subscription mode can sign in with ChatGPT.");
  }
  return model;
}

function assertSubscriptionAllowed(): void {
  const unavailable = subscriptionUnavailableReason();
  if (unavailable) throw new Error(unavailable);
}

async function createIsolatedCodexHome(): Promise<IsolatedCodexHome> {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), AUTH_TEMP_PREFIX));
  await fs.chmod(authRoot, 0o700);
  try {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), WORK_TEMP_PREFIX));
    await fs.chmod(workspace, 0o700);
    return { authRoot, workspace };
  } catch (error) {
    await removePathWithRetry(authRoot);
    throw error;
  }
}

async function removeIsolatedCodexHome(home: IsolatedCodexHome): Promise<void> {
  const results = await Promise.allSettled([
    removePathWithRetry(home.authRoot),
    removePathWithRetry(home.workspace),
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    const target = index === 0 ? "authentication" : "workspace";
    console.warn(
      `[genosyn] could not remove temporary Codex ${target} directory: ${safePublicError(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      )}`,
    );
  }
}

async function removePathWithRetry(target: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of REMOVE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await delay(delayMs);
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function sweepStaleCodexHomes(): Promise<void> {
  const tempRoot = os.tmpdir();
  const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
  try {
    const entries = await fs.readdir(tempRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            (entry.name.startsWith(AUTH_TEMP_PREFIX) || entry.name.startsWith(WORK_TEMP_PREFIX)),
        )
        .map(async (entry) => {
          const target = path.join(tempRoot, entry.name);
          const stat = await fs.stat(target).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) await removePathWithRetry(target);
        }),
    );
  } catch (error) {
    console.warn(
      `[genosyn] could not sweep stale temporary Codex directories: ${safePublicError(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

/**
 * Every name here either points at a CA bundle or names a proxy Codex should
 * dial through, so forwarding one can only follow the operator's own outbound
 * policy — none of them reach the isolated `CODEX_HOME` or the credential this
 * service materializes. The list has to match what the pinned Codex actually
 * reads: an install whose only proxy setting is `ALL_PROXY`, or whose CA lives
 * in `CODEX_CA_CERTIFICATE`, has a working `curl` and a Codex child that tries
 * to connect directly and fails with a bare transport error.
 */
const INHERITED_NETWORK_ENV = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function codexEnvironment(root: string, accessToken?: string): NodeJS.ProcessEnv {
  const inherited = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", ...INHERITED_NETWORK_ENV];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = root;
  env.XDG_CONFIG_HOME = root;
  env.CODEX_HOME = root;
  env.NO_COLOR = "1";
  env.RUST_LOG = CODEX_LOG_FILTER;
  if (accessToken) env.CODEX_ACCESS_TOKEN = accessToken;
  return env;
}

async function readManagedAuthJson(root: string): Promise<string> {
  const file = path.join(root, "auth.json");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > AUTH_FILE_MAX_BYTES) {
    throw new Error("OpenAI Codex wrote an invalid authentication file.");
  }
  const value = await fs.readFile(file, "utf8");
  validateManagedAuthJson(value);
  return value;
}

function validateManagedAuthJson(value: string): void {
  if (Buffer.byteLength(value, "utf8") > AUTH_FILE_MAX_BYTES) {
    throw new Error("OpenAI Codex authentication data is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OpenAI Codex authentication data is not valid JSON.");
  }
  const auth = asObject(parsed);
  const tokens = asObject(auth?.tokens);
  if (
    auth?.auth_mode !== "chatgpt" ||
    !nonEmptyString(tokens?.access_token) ||
    !nonEmptyString(tokens?.id_token) ||
    !nonEmptyString(tokens?.refresh_token)
  ) {
    throw new Error("OpenAI Codex did not return a complete managed ChatGPT session.");
  }
}

/**
 * `requiresOpenaiAuth` describes the active provider, not login success, and
 * remains true for an authenticated ChatGPT account. The account discriminator
 * is the authoritative success signal.
 */
export function isManagedChatgptAccount(value: unknown): boolean {
  const response = asObject(value);
  const account = asObject(response?.account);
  return account?.type === "chatgpt";
}

/**
 * Codex answers `account/read` from the credential snapshot its app-server
 * already holds. A device sign-in writes the managed session into `CODEX_HOME`
 * long after that snapshot was taken, so the cheap non-refreshing read still
 * reports the empty account the process booted with and every completed
 * sign-in looked unconfirmed. Only the refreshing read reloads the credential,
 * so ask a second time before rejecting the account. The first read stays
 * because it costs nothing and skips the refresh-token flow whenever Codex
 * already knows about the account.
 */
export async function confirmManagedChatgptAccount(
  read: (params: { refreshToken: boolean }) => Promise<unknown>,
): Promise<boolean> {
  if (isManagedChatgptAccount(await read({ refreshToken: false }))) return true;
  return isManagedChatgptAccount(await read({ refreshToken: true }));
}

function parseModelConfig(value: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(value || "{}")) ?? {};
  } catch {
    return {};
  }
}

function subscriptionScope(modelId: string): string {
  return `model:${modelId}:openai-subscription`;
}

function publicSession(session: DeviceSession): PublicSubscriptionDeviceSession {
  return {
    id: session.id,
    status: session.status,
    output: session.output,
    loginUrl: session.loginUrl,
    userCode: session.userCode,
    error: session.error,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | null {
  return nonEmptyString(value) ? value : null;
}

function safePublicError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("The OpenAI subscription turn was aborted.");
  error.name = "AbortError";
  return error;
}
