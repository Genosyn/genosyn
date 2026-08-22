import { In } from "typeorm";
import type { EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import {
  assertIntegrationAllowed,
  getProvider,
  getRetiredProvider,
  providerSupportsApiKey,
} from "../integrations/index.js";
import {
  ApprovalRequiredError,
  ConnectionAuthError,
  type IntegrationConfig,
  type IntegrationRuntimeContext,
  type RetiredIntegration,
} from "../integrations/types.js";
import { refreshTelegramListener } from "./telegramListener.js";
import { createAdSpendApproval, createPaymentApproval } from "./approvals.js";
import { makeResourceAttachmentResolver } from "./resourceAttachments.js";
import { makeConnectionCapabilityGate } from "./connectionCapabilities.js";
import { makeAdSpendLedger } from "./adSpend.js";
import { assertSafeOutboundConfig } from "../lib/outboundUrl.js";
import { hasGoogleGmailMailboxScope } from "../integrations/providers/google/auth.js";

const connectionCredentialTails = new Map<string, Promise<void>>();

/**
 * Service layer for Integration Connections + Grants.
 *
 * Wraps the two entities with:
 *  - Encrypt / decrypt of the JSON config blob (reusing the same
 *    scoped, rotation-aware AES-256-GCM key as `secrets` and AI Model API keys).
 *  - Status refresh via the provider's `checkStatus` hook.
 *  - Tool invocation with automatic re-persist if the provider refreshes
 *    tokens inside the handler (Gmail's OAuth flow depends on this).
 */

export type ConnectionDTO = {
  id: string;
  companyId: string;
  provider: string;
  label: string;
  authMode: "apikey" | "oauth2" | "service_account" | "github_app" | "browser";
  accountHint: string;
  status: "connected" | "error" | "expired";
  statusMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Scope-group keys persisted on the connection (OAuth + SA only).
   * Empty array for API-key connections or legacy rows that pre-date
   * scope groups. The reconnect modal uses this to prefill checkboxes. */
  scopeGroups: string[];
  /** Set when this row's connector has been removed from the catalog, so the
   * connection list can say so instead of rendering an anonymous card the
   * operator can only stare at. Null for every live Connection. Costs no
   * decryption, so it cannot break the list endpoint. */
  retired: RetiredIntegration | null;
};

export function serializeConnection(c: IntegrationConnection): ConnectionDTO {
  return {
    id: c.id,
    companyId: c.companyId,
    provider: c.provider,
    label: c.label,
    authMode: c.authMode,
    accountHint: c.accountHint,
    status: c.status,
    statusMessage: c.statusMessage,
    lastCheckedAt: c.lastCheckedAt ? c.lastCheckedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    scopeGroups: readScopeGroups(c),
    retired: getRetiredProvider(c.provider),
  };
}

/**
 * Pull `scopeGroups` out of the encrypted config without surfacing any
 * other secret fields. Returns `[]` for API-key connections or anything
 * we can't decrypt — the UI treats `[]` as "no scope groups picked".
 */
function readScopeGroups(c: IntegrationConnection): string[] {
  // `browser` is a retired mode with rows still in the table; its config
  // never held scope groups, so keep skipping it rather than decrypting a
  // credential blob to learn nothing.
  if (c.authMode === "apikey" || c.authMode === "browser") return [];
  try {
    const cfg = decryptConnectionConfig(c) as { scopeGroups?: unknown };
    if (Array.isArray(cfg.scopeGroups)) {
      return cfg.scopeGroups.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // Bad config — surface as empty rather than crashing the list endpoint.
  }
  return [];
}

export async function listConnections(companyId: string): Promise<IntegrationConnection[]> {
  return AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
}

export async function getConnection(
  companyId: string,
  id: string,
): Promise<IntegrationConnection | null> {
  return AppDataSource.getRepository(IntegrationConnection).findOneBy({
    companyId,
    id,
  });
}

export function decryptConnectionConfig(c: IntegrationConnection): IntegrationConfig {
  const raw = decryptSecret(c.encryptedConfig);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IntegrationConfig;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Integration config is corrupted or was encrypted with a different encryption key.",
  );
}

export function encryptConnectionConfig(cfg: IntegrationConfig, companyId = "instance"): string {
  return encryptSecret(JSON.stringify(cfg), `company:${companyId}`);
}

/** Persist refreshed credentials only when the caller still holds the config
 * snapshot it decrypted. A reconnect that landed while an API call was in
 * flight wins the compare-and-swap instead of being overwritten by stale
 * refresh tokens when that older call returns. */
export async function persistConnectionConfigIfCurrent(args: {
  connectionId: string;
  companyId: string;
  previousEncryptedConfig: string;
  config: IntegrationConfig;
  healthy?: boolean;
}): Promise<string | null> {
  const encryptedConfig = encryptConnectionConfig(args.config, args.companyId);
  const values: Partial<IntegrationConnection> = {
    encryptedConfig,
  };
  if (args.healthy) {
    values.lastCheckedAt = new Date();
    values.status = "connected";
    values.statusMessage = "";
  }
  const result = await AppDataSource.getRepository(IntegrationConnection)
    .createQueryBuilder()
    .update()
    .set(values)
    .where("id = :connectionId", { connectionId: args.connectionId })
    .andWhere('"companyId" = :companyId', { companyId: args.companyId })
    .andWhere('"encryptedConfig" = :previousEncryptedConfig', {
      previousEncryptedConfig: args.previousEncryptedConfig,
    })
    .execute();
  return (result.affected ?? 0) === 1 ? encryptedConfig : null;
}

/** Start a short credential transaction with a real conditional write. The
 * write holds the Connection row until commit on Postgres and the SQLite
 * writer lock on self-hosted installs, so mailbox binding and reconnect use
 * one cross-process ordering without keeping a transaction open over I/O. */
export async function claimConnectionForCredentialWrite(
  manager: EntityManager,
  args: {
    companyId: string;
    connectionId: string;
    expectedEncryptedConfig?: string;
  },
): Promise<IntegrationConnection | null> {
  const repo = manager.getRepository(IntegrationConnection);
  let update = repo
    .createQueryBuilder()
    .update()
    .set({ updatedAt: new Date() })
    .where("id = :connectionId", { connectionId: args.connectionId })
    .andWhere('"companyId" = :companyId', { companyId: args.companyId });
  if (args.expectedEncryptedConfig !== undefined) {
    update = update.andWhere('"encryptedConfig" = :expectedEncryptedConfig', {
      expectedEncryptedConfig: args.expectedEncryptedConfig,
    });
  }
  const claimed = await update.execute();
  if ((claimed.affected ?? 0) !== 1) return null;
  return repo.findOneBy({ companyId: args.companyId, id: args.connectionId });
}

/** TypeORM's SQLite driver shares one QueryRunner, so two concurrent
 * transactions in one process can become nested savepoints instead of
 * blocking each other. Pair the database claim with this local gate; the DB
 * write remains the cross-process lock, while this tail closes that
 * same-process SQLite window. */
export async function withConnectionCredentialMutation<T>(
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = connectionCredentialTails.get(connectionId) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  connectionCredentialTails.set(connectionId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (connectionCredentialTails.get(connectionId) === tail) {
      connectionCredentialTails.delete(connectionId);
    }
  }
}

/**
 * Record that a Connection's credential itself is unusable. Keyed on the
 * row rather than compare-and-swapped against the config, because the
 * provider may have just rewritten that config (an OAuth refresh rotates
 * the token there) and losing the status write is worse than losing a race
 * for the newest message.
 */
async function markConnectionUnusable(args: {
  connection: IntegrationConnection;
  status: "error" | "expired";
  message: string;
}): Promise<void> {
  await AppDataSource.getRepository(IntegrationConnection).update(
    { id: args.connection.id, companyId: args.connection.companyId },
    {
      status: args.status,
      statusMessage: args.message.slice(0, 2000),
      lastCheckedAt: new Date(),
    },
  );
}

async function persistConnectionStatusIfCurrent(args: {
  connection: IntegrationConnection;
  status: IntegrationConnection["status"];
  statusMessage: string;
  lastCheckedAt: Date;
  config?: IntegrationConfig;
}): Promise<boolean> {
  const values: Partial<IntegrationConnection> = {
    status: args.status,
    statusMessage: args.statusMessage,
    lastCheckedAt: args.lastCheckedAt,
  };
  if (args.config) {
    values.encryptedConfig = encryptConnectionConfig(args.config, args.connection.companyId);
  }
  const result = await AppDataSource.getRepository(IntegrationConnection)
    .createQueryBuilder()
    .update()
    .set(values)
    .where("id = :connectionId", { connectionId: args.connection.id })
    .andWhere('"companyId" = :companyId', { companyId: args.connection.companyId })
    .andWhere('"encryptedConfig" = :previousEncryptedConfig', {
      previousEncryptedConfig: args.connection.encryptedConfig,
    })
    .execute();
  return (result.affected ?? 0) === 1;
}

/**
 * Create a new API-key connection. Validates with the provider, encrypts,
 * persists. Returns the stored row.
 */
export async function createApiKeyConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  fields: Record<string, string>;
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (!providerSupportsApiKey(provider)) {
    throw new Error(`${provider.catalog.name} is not an API-key integration`);
  }
  if (!provider.validateApiKey) {
    throw new Error(`${provider.catalog.name} has no API-key validator`);
  }
  const { config, accountHint } = await provider.validateApiKey(args.fields);
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig(config, args.companyId),
    accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  notifyConnectionChanged(row.id, row.provider);
  return row;
}

/**
 * Persist a freshly-completed OAuth handshake. Called from the oauth
 * callback once we have tokens + userInfo.
 */
export async function createOauthConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  config: IntegrationConfig;
  accountHint: string;
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (!provider.catalog.oauth) {
    throw new Error(`${provider.catalog.name} does not support OAuth`);
  }
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(args.config, args.companyId),
    accountHint: args.accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  notifyConnectionChanged(row.id, row.provider);
  return row;
}

/**
 * Create a Connection from a service-account JSON key. The provider
 * validates the JSON shape, mints a sample access token (so the user gets
 * an immediate error if the key is rejected), and returns the config blob
 * to persist.
 */
export async function createServiceAccountConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  keyJson: Record<string, unknown>;
  impersonationEmail?: string;
  scopeGroups: string[];
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (!provider.catalog.serviceAccount) {
    throw new Error(`${provider.catalog.name} does not support service accounts`);
  }
  if (!provider.buildServiceAccountConfig) {
    throw new Error(
      `${provider.catalog.name} declared service-account support but has no validator`,
    );
  }
  const { config, accountHint } = await provider.buildServiceAccountConfig({
    keyJson: args.keyJson,
    impersonationEmail: args.impersonationEmail,
    scopeGroups: args.scopeGroups,
  });
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "service_account",
    encryptedConfig: encryptConnectionConfig(config, args.companyId),
    accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  notifyConnectionChanged(row.id, row.provider);
  return row;
}

/**
 * Rename a connection. The `label` is purely cosmetic — credentials and the
 * status of the connection are untouched.
 */
export async function updateConnectionLabel(
  companyId: string,
  id: string,
  label: string,
): Promise<IntegrationConnection | null> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({ companyId, id });
  if (!existing) return null;
  await repo.update({ companyId, id }, { label: label.trim() || existing.label });
  return repo.findOneBy({ companyId, id });
}

/**
 * Reconnect helpers — replace the encrypted credentials on an existing
 * connection without touching its id, label, or grants. Used when an API
 * key rotates, a service-account JSON is regenerated, or an OAuth token
 * is fully revoked and the user needs to re-grant consent. Keeping the
 * row id stable means every existing employee grant survives.
 */
export async function updateApiKeyCredentials(args: {
  companyId: string;
  connectionId: string;
  fields: Record<string, string>;
}): Promise<IntegrationConnection | null> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({
    companyId: args.companyId,
    id: args.connectionId,
  });
  if (!existing) return null;
  if (existing.authMode !== "apikey") {
    throw new Error(
      `Connection is ${existing.authMode}, not API-key — use the matching reconnect flow.`,
    );
  }
  const provider = getProvider(existing.provider);
  if (!provider || !provider.validateApiKey) {
    throw new Error(`Unknown integration: ${existing.provider}`);
  }
  const { config, accountHint } = await provider.validateApiKey(args.fields);
  existing.encryptedConfig = encryptConnectionConfig(config, existing.companyId);
  existing.accountHint = accountHint;
  existing.status = "connected";
  existing.statusMessage = "";
  existing.lastCheckedAt = new Date();
  await repo.save(existing);
  notifyConnectionChanged(existing.id, existing.provider);
  return existing;
}

export async function updateServiceAccountCredentials(args: {
  companyId: string;
  connectionId: string;
  keyJson: Record<string, unknown>;
  impersonationEmail?: string;
  scopeGroups: string[];
}): Promise<IntegrationConnection | null> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({
    companyId: args.companyId,
    id: args.connectionId,
  });
  if (!existing) return null;
  if (existing.authMode !== "service_account") {
    throw new Error(
      `Connection is ${existing.authMode}, not service-account — use the matching reconnect flow.`,
    );
  }
  const provider = getProvider(existing.provider);
  if (!provider || !provider.buildServiceAccountConfig) {
    throw new Error(`Unknown integration: ${existing.provider}`);
  }
  let impersonationEmail = args.impersonationEmail;
  if (impersonationEmail === undefined) {
    const previous = decryptConnectionConfig(existing) as Record<string, unknown>;
    if (typeof previous.impersonationEmail === "string" && previous.impersonationEmail.trim()) {
      impersonationEmail = previous.impersonationEmail;
    }
  }
  const { config, accountHint } = await provider.buildServiceAccountConfig({
    keyJson: args.keyJson,
    impersonationEmail,
    scopeGroups: args.scopeGroups,
  });
  const updated = await withConnectionCredentialMutation(existing.id, () =>
    AppDataSource.transaction(async (manager) => {
      const current = await claimConnectionForCredentialWrite(manager, {
        companyId: args.companyId,
        connectionId: args.connectionId,
      });
      if (!current) return null;
      if (current.authMode !== "service_account") {
        throw new Error(
          `Connection is ${current.authMode}, not service-account — use the matching reconnect flow.`,
        );
      }
      await assertMailReconnectBinding(manager, current, config, accountHint);
      current.encryptedConfig = encryptConnectionConfig(config, current.companyId);
      current.accountHint = accountHint;
      current.status = "connected";
      current.statusMessage = "";
      current.lastCheckedAt = new Date();
      return manager.getRepository(IntegrationConnection).save(current);
    }),
  );
  if (updated) notifyConnectionChanged(updated.id, updated.provider);
  return updated;
}

/**
 * Replace the encrypted config on an existing OAuth connection — called by
 * the OAuth callback when it resolves a state that carried an
 * `existingConnectionId`. The provider has already shaped the new tokens
 * into a config blob via `buildOauthConfig`.
 */
export async function updateOauthConnectionConfig(args: {
  companyId: string;
  connectionId: string;
  config: IntegrationConfig;
  accountHint: string;
}): Promise<IntegrationConnection | null> {
  const updated = await withConnectionCredentialMutation(args.connectionId, () =>
    AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(IntegrationConnection);
      const existing = await claimConnectionForCredentialWrite(manager, {
        companyId: args.companyId,
        connectionId: args.connectionId,
      });
      if (!existing) return null;
      if (existing.authMode !== "oauth2") {
        throw new Error(
          `Connection is ${existing.authMode}, not OAuth — use the matching reconnect flow.`,
        );
      }

      await assertMailReconnectBinding(manager, existing, args.config, args.accountHint);
      existing.encryptedConfig = encryptConnectionConfig(args.config, existing.companyId);
      existing.accountHint = args.accountHint;
      existing.status = "connected";
      existing.statusMessage = "";
      existing.lastCheckedAt = new Date();
      return repo.save(existing);
    }),
  );
  if (updated) notifyConnectionChanged(updated.id, updated.provider);
  return updated;
}

function normalizedMailboxIdentity(config: IntegrationConfig, accountHint: string): string {
  const record = config as Record<string, unknown>;
  for (const key of ["impersonationEmail", "email", "clientEmail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return accountHint.trim().toLowerCase();
}

function configHasGmailScope(config: IntegrationConfig): boolean {
  const record = config as Record<string, unknown>;
  const oauthScope = typeof record.scope === "string" ? record.scope : "";
  const serviceScopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  return hasGoogleGmailMailboxScope([oauthScope, ...serviceScopes]);
}

async function assertMailReconnectBinding(
  manager: EntityManager,
  connection: IntegrationConnection,
  config: IntegrationConfig,
  accountHint: string,
): Promise<void> {
  const mailAccount = await manager.getRepository(MailAccount).findOneBy({
    companyId: connection.companyId,
    connectionId: connection.id,
  });
  if (!mailAccount) return;
  if (mailAccount.address.trim().toLowerCase() !== normalizedMailboxIdentity(config, accountHint)) {
    throw new Error(
      `Reconnect the same Google account (${mailAccount.address}). To use a different mailbox, disconnect this mailbox first.`,
    );
  }
  if (!configHasGmailScope(config)) {
    throw new Error(
      "This Connection backs a mailbox. Reconnect it with the Gmail product selected.",
    );
  }
}

/**
 * Create a Connection from a GitHub App credential (App ID + PEM private
 * key + installation id). Mints an installation token eagerly so the user
 * sees an immediate error if the triple is wrong.
 */
export async function createGithubAppConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (!provider.catalog.githubApp) {
    throw new Error(`${provider.catalog.name} does not support GitHub Apps`);
  }
  if (!provider.buildGithubAppConfig) {
    throw new Error(`${provider.catalog.name} declared GitHub App support but has no validator`);
  }
  const { config, accountHint } = await provider.buildGithubAppConfig({
    appId: args.appId,
    privateKey: args.privateKey,
    installationId: args.installationId,
  });
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "github_app",
    encryptedConfig: encryptConnectionConfig(config, args.companyId),
    accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  notifyConnectionChanged(row.id, row.provider);
  return row;
}

export async function updateGithubAppCredentials(args: {
  companyId: string;
  connectionId: string;
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<IntegrationConnection | null> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({
    companyId: args.companyId,
    id: args.connectionId,
  });
  if (!existing) return null;
  if (existing.authMode !== "github_app") {
    throw new Error(
      `Connection is ${existing.authMode}, not github-app — use the matching reconnect flow.`,
    );
  }
  const provider = getProvider(existing.provider);
  if (!provider || !provider.buildGithubAppConfig) {
    throw new Error(`Unknown integration: ${existing.provider}`);
  }
  const { config, accountHint } = await provider.buildGithubAppConfig({
    appId: args.appId,
    privateKey: args.privateKey,
    installationId: args.installationId,
  });
  existing.encryptedConfig = encryptConnectionConfig(config, existing.companyId);
  existing.accountHint = accountHint;
  existing.status = "connected";
  existing.statusMessage = "";
  existing.lastCheckedAt = new Date();
  await repo.save(existing);
  notifyConnectionChanged(existing.id, existing.provider);
  return existing;
}

export async function deleteConnection(companyId: string, id: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({ companyId, id });
  if (!existing) return false;
  // Grants cascade via the orphan cleanup below — SQLite FK enforcement is
  // off by default so we delete manually.
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
    connectionId: id,
  });
  await repo.delete({ id });
  notifyConnectionChanged(id, existing.provider, { deleted: true });
  return true;
}

/**
 * Side-channel hook for providers that need to react to connection-row
 * changes outside the request-response cycle. Today only Telegram cares —
 * its long-polling listener has to start, stop, or re-key when a token
 * rotates. Other providers stay free of background workers, so this is a
 * targeted dispatch rather than an event bus.
 */
function notifyConnectionChanged(
  connectionId: string,
  provider: string,
  opts: { deleted?: boolean } = {},
): void {
  if (provider !== "telegram") return;
  void refreshTelegramListener(connectionId, opts).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[telegram] refresh listener failed for ${connectionId}:`, err);
  });
}

/**
 * Run the provider's cheap health check. Updates `status` + `lastCheckedAt`.
 * Returns the updated row (fresh from the repo after save).
 */
export async function refreshConnectionStatus(
  conn: IntegrationConnection,
): Promise<IntegrationConnection> {
  assertIntegrationAllowed(conn.provider);
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const returnCurrent = async (): Promise<IntegrationConnection> =>
    (await repo.findOneBy({ id: conn.id, companyId: conn.companyId })) ?? conn;
  const provider = getProvider(conn.provider);
  if (!provider) {
    // "No provider registered" and "provider has no health hook" used to
    // collapse into the same healthy write, so a connector removed from the
    // catalog kept reporting a green badge — and overwrote anything that had
    // explained why it was there. A row with no provider cannot work.
    const retired = getRetiredProvider(conn.provider);
    await persistConnectionStatusIfCurrent({
      connection: conn,
      status: "error",
      statusMessage: retired
        ? `${retired.name} was retired in ${retired.retiredIn}. ${retired.reason}`
        : `The "${conn.provider}" Integration is not available on this instance.`,
      lastCheckedAt: new Date(),
    });
    return returnCurrent();
  }
  if (!provider.checkStatus) {
    await persistConnectionStatusIfCurrent({
      connection: conn,
      status: "connected",
      statusMessage: "",
      lastCheckedAt: new Date(),
    });
    return returnCurrent();
  }
  let cfg: IntegrationConfig;
  try {
    cfg = decryptConnectionConfig(conn);
    await assertSafeOutboundConfig(cfg);
  } catch (err) {
    await persistConnectionStatusIfCurrent({
      connection: conn,
      status: "error",
      statusMessage: err instanceof Error ? err.message : String(err),
      lastCheckedAt: new Date(),
    });
    return returnCurrent();
  }
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
  };
  const result = await provider.checkStatus(ctx);
  await persistConnectionStatusIfCurrent({
    connection: conn,
    // A provider may say "not broken, just signed out" — that's `expired`,
    // and it reads very differently to an operator than a hard error.
    status: result.status ?? (result.ok ? "connected" : "error"),
    statusMessage: result.ok ? "" : (result.message ?? "Unknown error"),
    lastCheckedAt: new Date(),
    config: refreshed ?? undefined,
  });
  return returnCurrent();
}

// -------- Grants --------

export type GrantDTO = {
  id: string;
  employeeId: string;
  connectionId: string;
  createdAt: string;
  connection: ConnectionDTO;
};

export async function listGrantsForEmployee(
  employeeId: string,
): Promise<Array<EmployeeConnectionGrant & { connection: IntegrationConnection }>> {
  const grants = await AppDataSource.getRepository(EmployeeConnectionGrant).find({
    where: { employeeId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const conns = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { id: In(grants.map((g) => g.connectionId)) },
  });
  const byId = new Map(conns.map((c) => [c.id, c] as const));
  return grants
    .filter((g) => byId.has(g.connectionId))
    .map((g) => Object.assign(g, { connection: byId.get(g.connectionId)! }));
}

/**
 * Inverse of `listGrantsForEmployee`: every employee that currently has an
 * active grant on this connection. The Settings → Integrations page uses
 * this to render a per-connection "Manage access" view.
 */
export async function listGrantsForConnection(
  connectionId: string,
): Promise<Array<EmployeeConnectionGrant & { employee: AIEmployee }>> {
  const grants = await AppDataSource.getRepository(EmployeeConnectionGrant).find({
    where: { connectionId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(grants.map((g) => g.employeeId)) },
  });
  const byId = new Map(emps.map((e) => [e.id, e] as const));
  return grants
    .filter((g) => byId.has(g.employeeId))
    .map((g) => Object.assign(g, { employee: byId.get(g.employeeId)! }));
}

export async function grantAccess(
  employeeId: string,
  connectionId: string,
): Promise<EmployeeConnectionGrant> {
  const repo = AppDataSource.getRepository(EmployeeConnectionGrant);
  const existing = await repo.findOneBy({ employeeId, connectionId });
  if (existing) return existing;
  const row = repo.create({ employeeId, connectionId });
  await repo.save(row);
  return row;
}

export async function revokeAccess(employeeId: string, connectionId: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(EmployeeConnectionGrant);
  const existing = await repo.findOneBy({ employeeId, connectionId });
  if (!existing) return false;
  await repo.delete({ id: existing.id });
  return true;
}

export async function getGrantWithConnection(
  employeeId: string,
  connectionId: string,
): Promise<{ grant: EmployeeConnectionGrant; connection: IntegrationConnection } | null> {
  const grant = await AppDataSource.getRepository(EmployeeConnectionGrant).findOneBy({
    employeeId,
    connectionId,
  });
  if (!grant) return null;
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
  });
  if (!connection) return null;
  return { grant, connection };
}

/**
 * Load every {connection, provider} pair an employee has been granted. The
 * MCP dispatcher uses this to advertise tools to the AI CLI.
 */
export async function loadEmployeeConnections(employee: AIEmployee): Promise<
  Array<{
    grant: EmployeeConnectionGrant;
    connection: IntegrationConnection;
  }>
> {
  const grants = await listGrantsForEmployee(employee.id);
  return grants
    .filter((g) => g.connection.companyId === employee.companyId)
    .map(({ connection, ...rest }) => ({
      grant: rest as EmployeeConnectionGrant,
      connection,
    }));
}

/**
 * Invoke one tool on behalf of an employee. Handles:
 *   - authorization (employee must have an active grant on the connection).
 *     The Connection grant is the outer boundary, not the whole of it: a
 *     provider can name a finer capability via `ctx.assertCapability`, which
 *     is how the Google connector's mail tools end up honouring the same
 *     `EmployeeMailAccountGrant` levels the `mail_*` tools do.
 *   - decrypt → provider.invokeTool → re-encrypt if the provider rotated
 *     credentials (OAuth refresh)
 *   - status bookkeeping (tool error ≠ connection error; connection error
 *     only when decrypt / auth fails)
 */
export async function invokeConnectionTool(args: {
  employee: AIEmployee;
  connectionId: string;
  toolName: string;
  toolArgs: unknown;
}): Promise<unknown> {
  const pair = await getGrantWithConnection(args.employee.id, args.connectionId);
  if (!pair) {
    throw new Error("No grant: you do not have access to this connection.");
  }
  if (pair.connection.companyId !== args.employee.companyId) {
    throw new Error("Connection belongs to a different company.");
  }
  assertIntegrationAllowed(pair.connection.provider);
  const provider = getProvider(pair.connection.provider);
  if (!provider) throw new Error(`Unknown provider: ${pair.connection.provider}`);
  const tool = provider.tools.find((t) => t.name === args.toolName);
  if (!tool) throw new Error(`Unknown tool: ${args.toolName}`);
  // The tool listing already hides what this auth mode can't do; enforce it
  // here too so a name the model remembers from another Connection can't
  // reach a provider path that has no implementation behind it.
  if (provider.supportsTool && !provider.supportsTool(args.toolName, pair.connection.authMode)) {
    throw new Error(
      `${provider.catalog.name} connection "${pair.connection.label}" is ${pair.connection.authMode} mode, which does not support ${args.toolName}.`,
    );
  }

  const cfg = decryptConnectionConfig(pair.connection);
  const credentialSnapshot = pair.connection.encryptedConfig;
  await assertSafeOutboundConfig(cfg);
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: pair.connection.authMode,
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
    connectionId: pair.connection.id,
    companyId: pair.connection.companyId,
    employeeId: args.employee.id,
    // Bound to this employee here, not read back off `ctx` by the provider —
    // a tool cannot widen its own reach by rewriting the context it was
    // handed. The other ctx builders (pipelines, approval replay) have no
    // employee to bind, so they leave this out and attachment-bearing calls
    // fail closed there.
    resolveAttachments: makeResourceAttachmentResolver({
      companyId: pair.connection.companyId,
      employeeId: args.employee.id,
    }),
    assertCapability: makeConnectionCapabilityGate({
      connection: pair.connection,
      employeeId: args.employee.id,
    }),
    adSpend: makeAdSpendLedger({
      connection: pair.connection,
      employeeId: args.employee.id,
    }),
  };

  let result: unknown;
  try {
    result = await provider.invokeTool(args.toolName, args.toolArgs, ctx);
  } catch (err) {
    // A provider that rotated credentials and *then* failed must not lose
    // the rotation — dropping it would replay a spent refresh token, or
    // re-drive a login we already know is walled off, on the next call.
    if (refreshed) {
      await persistConnectionConfigIfCurrent({
        connectionId: pair.connection.id,
        companyId: pair.connection.companyId,
        previousEncryptedConfig: credentialSnapshot,
        config: refreshed,
      });
    }
    if (err instanceof ConnectionAuthError) {
      await markConnectionUnusable({
        connection: pair.connection,
        status: err.connectionStatus,
        message: err.message,
      });
      throw err;
    }
    if (err instanceof ApprovalRequiredError) {
      const approval =
        err.request?.kind === "ad_spend"
          ? await createAdSpendApproval({
              companyId: pair.connection.companyId,
              employeeId: args.employee.id,
              connectionId: pair.connection.id,
              toolName: args.toolName,
              toolArgs: (args.toolArgs as Record<string, unknown>) ?? {},
              title: err.title,
              summary: err.summary,
              request: err.request,
            })
          : await createPaymentApproval({
              companyId: pair.connection.companyId,
              employeeId: args.employee.id,
              connectionId: pair.connection.id,
              toolName: args.toolName,
              toolArgs: (args.toolArgs as Record<string, unknown>) ?? {},
              amountSats: err.amountSats,
              title: err.title,
              summary: err.summary,
            });
      throw new Error(
        `Approval pending — a human must approve before this runs. Approval id: ${approval.id}. Do not retry the call yourself; it executes automatically once approved.`,
      );
    }
    throw err;
  }
  if (refreshed) {
    await persistConnectionConfigIfCurrent({
      connectionId: pair.connection.id,
      companyId: pair.connection.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: refreshed,
      healthy: true,
    });
  }
  return result;
}
