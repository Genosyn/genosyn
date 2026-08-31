import { In } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { EmployeeVaultGrant } from "../db/entities/EmployeeVaultGrant.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { VaultItemMemberAccess } from "../db/entities/VaultItemMemberAccess.js";
import { VaultSource, type VaultSourceStatus } from "../db/entities/VaultSource.js";
import {
  BitwardenApiError,
  bitwardenCipher,
  bitwardenEndpoints,
  bitwardenLogin,
  bitwardenPrelogin,
  bitwardenProfile,
  bitwardenRefresh,
  bitwardenSync,
  newBitwardenDeviceIdentifier,
  normalizeBitwardenServerUrl,
  readField,
  type BitwardenEndpoints,
  type BitwardenSession,
} from "../lib/bitwarden/client.js";
import {
  decodeBitwardenCipher,
  readBitwardenVault,
  readBitwardenVaultKeys,
  type BitwardenItem,
  type BitwardenVaultKeys,
} from "../lib/bitwarden/ciphers.js";
import { BitwardenCryptoError, type BitwardenSymmetricKey } from "../lib/bitwarden/encString.js";
import {
  deriveBitwardenMasterKey,
  deriveBitwardenPasswordHash,
  unwrapBitwardenUserKey,
} from "../lib/bitwarden/keys.js";
import { decryptSecretWithStrongKeys, encryptSecret } from "../lib/secret.js";

/**
 * Vault sources: a company's connection to an external password manager.
 *
 * This module owns the `VaultSource` rows, the sign-in material on them, and
 * the short-lived unlocked session each one needs to read items. It does not
 * touch `VaultItem` rows except to clean up after a disconnect — mirroring is
 * `services/vault.ts`'s job, because only that module may write a Vault
 * payload ciphertext.
 *
 * ## What lives where
 *
 * The account's master password has to be stored: Bitwarden derives the key
 * that decrypts the vault from it, so a server that reads items unattended
 * cannot avoid holding it. It is encrypted with the same company-scoped key
 * ring every other Genosyn secret uses and is never returned by any API.
 *
 * The *derived* keys — master key, user key, organization keys — exist only in
 * this process's memory, for as long as the cached session lives. Deriving them
 * costs a deliberate 0.2-1s (PBKDF2 at 600k rounds, or Argon2id), which is why
 * the cache exists at all; it is not a correctness shortcut, and every entry is
 * dropped the moment the source's configuration changes.
 */

export class VaultSourceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "VaultSourceError";
  }
}

const vaultSourceConfigSchema = z
  .object({
    email: z.string().min(1).max(320),
    masterPassword: z.string().min(1).max(1024),
    /** Personal API key ("user.<uuid>" plus its secret), when one is configured. */
    clientId: z.string().max(200).default(""),
    clientSecret: z.string().max(400).default(""),
    /** Stable per source, so Bitwarden does not see every sync as a new device. */
    deviceIdentifier: z.string().min(1).max(100),
    /** Reused so a routine sync does not re-derive the master key every time. */
    refreshToken: z.string().max(4096).default(""),
    /** A remembered second factor, when the server issued one. */
    twoFactorToken: z.string().max(2048).default(""),
  })
  .strict();

type VaultSourceConfig = z.infer<typeof vaultSourceConfigSchema>;

export type VaultSourceView = {
  id: string;
  companyId: string;
  kind: "bitwarden";
  label: string;
  serverUrl: string;
  accountHint: string;
  scopeName: string;
  defaultVisibility: "company" | "restricted";
  /** True when the source signs in with an API key rather than the password grant. */
  usesApiKey: boolean;
  status: VaultSourceStatus;
  statusMessage: string;
  lastSyncedAt: Date | null;
  lastSyncItemCount: number;
  /** How many Vault items this source currently mirrors. */
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** One unlocked vault, held in memory only. */
type VaultSourceSession = {
  endpoints: BitwardenEndpoints;
  accessToken: string;
  tokenExpiresAt: number;
  userKey: BitwardenSymmetricKey;
  /**
   * Organization keys, loaded the first time an organization-owned item is
   * read. A personal vault never needs them, so they are not part of unlocking.
   */
  organizationKeys: BitwardenVaultKeys | null;
  /** Dropped as soon as the source row changes underneath us. */
  configVersion: number;
  expiresAt: number;
};

const SESSION_IDLE_MS = 30 * 60 * 1000;
/**
 * A ceiling on what one source may mirror. A personal vault of a few hundred
 * items is the shape this is for; a five-figure enterprise vault mirrored
 * wholesale would be a Vault nobody can navigate and a sync nobody can finish,
 * so it is refused with the fix in the message rather than half-applied.
 */
const MAX_MIRRORED_ITEMS = 2_000;
const sessions = new Map<string, VaultSourceSession>();
const unlocking = new Map<string, Promise<VaultSourceSession>>();
/** Bumped on every write to a source so a stale session cannot be reused. */
const configVersions = new Map<string, number>();

function encryptionScope(companyId: string): string {
  return `company:${companyId}:vault-source`;
}

function readConfig(row: VaultSource): VaultSourceConfig {
  try {
    // The scope is authenticated inside the ciphertext, but it also has to be
    // the scope of *this* row's company — otherwise a ciphertext moved between
    // rows would still decrypt. `services/vault.ts` makes the same check for
    // the same reason.
    const parts = row.encryptedConfig.split(".");
    const storedScope =
      parts.length === 5 && parts[0] === "v2"
        ? Buffer.from(parts[1], "base64url").toString("utf8")
        : "";
    if (storedScope !== encryptionScope(row.companyId)) {
      throw new Error("ciphertext scope does not match the source's company");
    }
    const parsed = vaultSourceConfigSchema.safeParse(
      JSON.parse(decryptSecretWithStrongKeys(row.encryptedConfig)),
    );
    if (!parsed.success) throw new Error("invalid config shape");
    return parsed.data;
  } catch {
    throw new VaultSourceError("This Vault source's saved sign-in could not be read", 500);
  }
}

function writeConfig(companyId: string, config: VaultSourceConfig): string {
  return encryptSecret(JSON.stringify(config), encryptionScope(companyId));
}

function bumpConfigVersion(sourceId: string): number {
  const next = (configVersions.get(sourceId) ?? 0) + 1;
  configVersions.set(sourceId, next);
  sessions.delete(sourceId);
  return next;
}

export function forgetVaultSourceSession(sourceId: string): void {
  sessions.delete(sourceId);
  unlocking.delete(sourceId);
}

async function toView(row: VaultSource): Promise<VaultSourceView> {
  const itemCount = await AppDataSource.getRepository(VaultItem).countBy({
    companyId: row.companyId,
    vaultSourceId: row.id,
  });
  let usesApiKey = false;
  try {
    const config = readConfig(row);
    usesApiKey = Boolean(config.clientId && config.clientSecret);
  } catch {
    usesApiKey = false;
  }
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    label: row.label,
    serverUrl: row.serverUrl,
    accountHint: row.accountHint,
    scopeName: row.scopeName,
    defaultVisibility: row.defaultVisibility,
    usesApiKey,
    status: row.status,
    statusMessage: row.statusMessage,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncItemCount: row.lastSyncItemCount,
    itemCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listVaultSources(companyId: string): Promise<VaultSourceView[]> {
  const rows = await AppDataSource.getRepository(VaultSource).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  return Promise.all(rows.map(toView));
}

export async function loadVaultSource(companyId: string, sourceId: string): Promise<VaultSource> {
  const row = await AppDataSource.getRepository(VaultSource).findOneBy({
    id: sourceId,
    companyId,
  });
  if (!row) throw new VaultSourceError("Vault source not found", 404);
  return row;
}

export async function getVaultSource(
  companyId: string,
  sourceId: string,
): Promise<VaultSourceView> {
  return toView(await loadVaultSource(companyId, sourceId));
}

export type VaultSourceInput = {
  label: string;
  serverUrl: string;
  email: string;
  masterPassword: string;
  clientId: string;
  clientSecret: string;
  scopeName: string;
  defaultVisibility: "company" | "restricted";
  /** A freshly typed authenticator code, only ever used for this one sign-in. */
  twoFactorCode?: string;
};

/**
 * Connect a company to an external vault.
 *
 * The sign-in is proved before the row is written: a source that cannot sign in
 * is a support ticket waiting to happen, and there is nothing useful to save.
 */
export async function createVaultSource(args: {
  companyId: string;
  actorUserId: string;
  input: VaultSourceInput;
}): Promise<VaultSourceView> {
  const repo = AppDataSource.getRepository(VaultSource);
  const existing = await repo.countBy({ companyId: args.companyId });
  if (existing >= 5) {
    throw new VaultSourceError("A company can connect at most five Vault sources", 400);
  }
  const serverUrl = normalizeServerUrl(args.input.serverUrl);
  const config: VaultSourceConfig = {
    email: args.input.email.trim(),
    masterPassword: args.input.masterPassword,
    clientId: args.input.clientId.trim(),
    clientSecret: args.input.clientSecret.trim(),
    deviceIdentifier: newBitwardenDeviceIdentifier(),
    refreshToken: "",
    twoFactorToken: "",
  };
  const proved = await signIn(serverUrl, config, args.input.twoFactorCode ?? null);

  const row = repo.create({
    companyId: args.companyId,
    kind: "bitwarden",
    label: args.input.label.trim(),
    serverUrl,
    accountHint: config.email,
    encryptedConfig: writeConfig(args.companyId, proved.config),
    scopeName: args.input.scopeName.trim(),
    defaultVisibility: args.input.defaultVisibility,
    status: "connected",
    statusMessage: "",
    lastSyncedAt: null,
    lastSyncItemCount: 0,
    createdByUserId: args.actorUserId,
  });
  await repo.save(row);
  cacheSession(row.id, proved.session);
  return toView(row);
}

/**
 * Change a source's settings.
 *
 * Credentials are re-proved whenever any of them move, so a saved source is
 * always one that worked at least once.
 */
export async function updateVaultSource(args: {
  companyId: string;
  sourceId: string;
  patch: Partial<VaultSourceInput>;
}): Promise<VaultSourceView> {
  const repo = AppDataSource.getRepository(VaultSource);
  const row = await loadVaultSource(args.companyId, args.sourceId);
  const current = readConfig(row);
  const serverUrl =
    args.patch.serverUrl === undefined ? row.serverUrl : normalizeServerUrl(args.patch.serverUrl);
  const next: VaultSourceConfig = {
    ...current,
    email: args.patch.email?.trim() ?? current.email,
    masterPassword: args.patch.masterPassword ?? current.masterPassword,
    clientId: args.patch.clientId?.trim() ?? current.clientId,
    clientSecret: args.patch.clientSecret?.trim() ?? current.clientSecret,
  };
  const credentialsMoved =
    serverUrl !== row.serverUrl ||
    next.email !== current.email ||
    next.masterPassword !== current.masterPassword ||
    next.clientId !== current.clientId ||
    next.clientSecret !== current.clientSecret;

  let saved = next;
  let session: VaultSourceSession | null = null;
  if (credentialsMoved) {
    // A different account means different keys; the old refresh token and
    // remembered factor belong to the account that is being replaced.
    const proved = await signIn(
      serverUrl,
      { ...next, refreshToken: "", twoFactorToken: "" },
      args.patch.twoFactorCode ?? null,
    );
    saved = proved.config;
    session = proved.session;
  }

  row.label = args.patch.label?.trim() ?? row.label;
  row.serverUrl = serverUrl;
  row.accountHint = saved.email;
  row.encryptedConfig = writeConfig(args.companyId, saved);
  row.scopeName = args.patch.scopeName?.trim() ?? row.scopeName;
  row.defaultVisibility = args.patch.defaultVisibility ?? row.defaultVisibility;
  if (credentialsMoved) {
    row.status = "connected";
    row.statusMessage = "";
  }
  await repo.save(row);
  bumpConfigVersion(row.id);
  if (session) cacheSession(row.id, session);
  return toView(row);
}

/**
 * Disconnect a source and remove everything it mirrored.
 *
 * The mirrors carry no secret, so nothing is lost from the external vault —
 * but the human Access and AI Grants attached to them are meaningless once the
 * items are gone, and leaving them would silently re-grant on a reconnect.
 */
export async function deleteVaultSource(args: {
  companyId: string;
  sourceId: string;
}): Promise<{ id: string; label: string; removedItems: number }> {
  const row = await loadVaultSource(args.companyId, args.sourceId);
  const removedItems = await AppDataSource.transaction(async (manager) => {
    const items = await manager.find(VaultItem, {
      where: { companyId: args.companyId, vaultSourceId: row.id },
      select: { id: true },
    });
    const itemIds = items.map((item) => item.id);
    if (itemIds.length > 0) {
      await manager.delete(VaultItemMemberAccess, {
        companyId: args.companyId,
        vaultItemId: In(itemIds),
      });
      await manager.delete(EmployeeVaultGrant, {
        companyId: args.companyId,
        vaultItemId: In(itemIds),
      });
      await manager.delete(VaultItem, { companyId: args.companyId, vaultSourceId: row.id });
    }
    await manager.delete(VaultSource, { id: row.id, companyId: args.companyId });
    return itemIds.length;
  });
  forgetVaultSourceSession(row.id);
  configVersions.delete(row.id);
  return { id: row.id, label: row.label, removedItems };
}

/** Record the outcome of a sync or a health check on the source row. */
export async function recordVaultSourceStatus(args: {
  companyId: string;
  sourceId: string;
  status: VaultSourceStatus;
  statusMessage: string;
  syncedItemCount?: number;
}): Promise<void> {
  const patch: Partial<VaultSource> = {
    status: args.status,
    statusMessage: args.statusMessage.slice(0, 500),
  };
  if (args.status === "connected" && args.syncedItemCount !== undefined) {
    patch.lastSyncedAt = new Date();
    patch.lastSyncItemCount = args.syncedItemCount;
  }
  await AppDataSource.getRepository(VaultSource).update(
    { id: args.sourceId, companyId: args.companyId },
    patch,
  );
}

function normalizeServerUrl(value: string): string {
  try {
    return normalizeBitwardenServerUrl(value);
  } catch (error) {
    throw new VaultSourceError(
      error instanceof BitwardenApiError ? error.message : "That server URL could not be read",
      400,
    );
  }
}

/**
 * Sign in and unlock, returning the config as it should now be persisted.
 *
 * A refresh token and a remembered second factor both come back from the
 * server and both save a full re-derivation next time, so they are folded into
 * the config the caller stores.
 */
async function signIn(
  serverUrl: string,
  config: VaultSourceConfig,
  twoFactorCode: string | null,
): Promise<{ config: VaultSourceConfig; session: VaultSourceSession }> {
  const endpoints = bitwardenEndpoints(serverUrl);
  const email = config.email;
  const kdf = await run(() => bitwardenPrelogin(endpoints, email));
  const masterKey = await run(() => deriveBitwardenMasterKey(config.masterPassword, email, kdf));
  const masterPasswordHash = deriveBitwardenPasswordHash(masterKey, config.masterPassword);
  const session = await run(() =>
    bitwardenLogin({
      endpoints,
      email,
      masterPasswordHash,
      deviceIdentifier: config.deviceIdentifier,
      clientId: config.clientId || null,
      clientSecret: config.clientSecret || null,
      twoFactorCode,
      twoFactorToken: config.twoFactorToken || null,
    }),
  );
  return {
    config: {
      ...config,
      refreshToken: session.refreshToken ?? "",
      twoFactorToken: session.twoFactorToken ?? config.twoFactorToken,
    },
    session: unlock(endpoints, session, masterKey),
  };
}

/** Turn an authenticated session into an unlocked one. */
function unlock(
  endpoints: BitwardenEndpoints,
  session: BitwardenSession,
  masterKey: Buffer,
): VaultSourceSession {
  if (!session.protectedUserKey) {
    throw new VaultSourceError(
      "This Bitwarden account has no master-password unlock — single sign-on and key-connector accounts cannot be read by Genosyn",
      400,
    );
  }
  let userKey: BitwardenSymmetricKey;
  try {
    userKey = unwrapBitwardenUserKey(session.protectedUserKey, masterKey);
  } catch {
    throw new VaultSourceError(
      "That master password did not unlock the Bitwarden vault. Check it and try again.",
      400,
    );
  }
  return {
    endpoints,
    accessToken: session.accessToken,
    tokenExpiresAt: session.expiresAt,
    userKey,
    organizationKeys: null,
    configVersion: 0,
    expiresAt: Date.now() + SESSION_IDLE_MS,
  };
}

function cacheSession(sourceId: string, session: VaultSourceSession): void {
  const version = configVersions.get(sourceId) ?? 0;
  configVersions.set(sourceId, version);
  sessions.set(sourceId, { ...session, configVersion: version });
}

/**
 * Get an unlocked session for a source, reusing the cached one when it is still
 * good. Concurrent callers share one unlock rather than each paying the KDF.
 */
async function sessionFor(row: VaultSource): Promise<VaultSourceSession> {
  const version = configVersions.get(row.id) ?? 0;
  configVersions.set(row.id, version);
  const cached = sessions.get(row.id);
  const now = Date.now();
  if (
    cached &&
    cached.configVersion === version &&
    cached.expiresAt > now &&
    cached.tokenExpiresAt > now + 60_000
  ) {
    cached.expiresAt = now + SESSION_IDLE_MS;
    return cached;
  }
  const inFlight = unlocking.get(row.id);
  if (inFlight) return inFlight;

  const startedAtVersion = version;
  const attempt = (async () => {
    const config = readConfig(row);
    const endpoints = bitwardenEndpoints(row.serverUrl);
    const kdf = await run(() => bitwardenPrelogin(endpoints, config.email));
    const masterKey = await run(() =>
      deriveBitwardenMasterKey(config.masterPassword, config.email, kdf),
    );

    // A refresh saves nothing on the KDF — the master key is needed to unwrap
    // the user key either way — but it does avoid a second password check and
    // keeps the server's "new device" bookkeeping quiet.
    let authenticated: BitwardenSession | null = null;
    if (config.refreshToken) {
      try {
        authenticated = await bitwardenRefresh(endpoints, config.refreshToken);
      } catch {
        authenticated = null;
      }
    }
    if (!authenticated) {
      authenticated = await run(() =>
        bitwardenLogin({
          endpoints,
          email: config.email,
          masterPasswordHash: deriveBitwardenPasswordHash(masterKey, config.masterPassword),
          deviceIdentifier: config.deviceIdentifier,
          clientId: config.clientId || null,
          clientSecret: config.clientSecret || null,
          twoFactorCode: null,
          twoFactorToken: config.twoFactorToken || null,
        }),
      );
    }
    if (!authenticated.protectedUserKey && config.refreshToken) {
      // A refresh response carries no key material; fall back to a full login.
      authenticated = await run(() =>
        bitwardenLogin({
          endpoints,
          email: config.email,
          masterPasswordHash: deriveBitwardenPasswordHash(masterKey, config.masterPassword),
          deviceIdentifier: config.deviceIdentifier,
          clientId: config.clientId || null,
          clientSecret: config.clientSecret || null,
          twoFactorCode: null,
          twoFactorToken: config.twoFactorToken || null,
        }),
      );
    }
    const unlocked = unlock(endpoints, authenticated, masterKey);
    if ((configVersions.get(row.id) ?? 0) !== startedAtVersion) {
      // The source's credentials changed while this unlock was in flight. This
      // session belongs to the account that was replaced; use it for the call
      // that asked, but never cache it as the source's current session.
      return unlocked;
    }
    if (
      (authenticated.refreshToken ?? "") !== config.refreshToken ||
      (authenticated.twoFactorToken ?? config.twoFactorToken) !== config.twoFactorToken
    ) {
      await persistTokens(row, {
        ...config,
        refreshToken: authenticated.refreshToken ?? "",
        twoFactorToken: authenticated.twoFactorToken ?? config.twoFactorToken,
      });
    }
    cacheSession(row.id, unlocked);
    return sessions.get(row.id) ?? unlocked;
  })();

  unlocking.set(row.id, attempt);
  try {
    return await attempt;
  } finally {
    unlocking.delete(row.id);
  }
}

/**
 * Save refreshed tokens without disturbing anything else on the row.
 *
 * Deliberately a targeted update rather than a `save()`: a sync running beside
 * an operator editing the label must not write back the label it read.
 */
async function persistTokens(row: VaultSource, config: VaultSourceConfig): Promise<void> {
  const encryptedConfig = writeConfig(row.companyId, config);
  await AppDataSource.getRepository(VaultSource).update(
    { id: row.id, companyId: row.companyId },
    { encryptedConfig },
  );
  row.encryptedConfig = encryptedConfig;
}

/** Map a protocol-level failure onto a message a Member can act on. */
async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof VaultSourceError) throw error;
    if (error instanceof BitwardenApiError) {
      // A transport failure or a session the server rejected is Genosyn's
      // problem to report as an upstream one; a rejected credential is the
      // caller's to fix.
      const statusCode =
        error.status === 0 || error.status === 401 || error.status === 403
          ? 502
          : error.status === 404 || error.status === 429
            ? error.status
            : 400;
      throw new VaultSourceError(error.message, statusCode);
    }
    if (error instanceof BitwardenCryptoError) throw new VaultSourceError(error.message, 400);
    throw error;
  }
}

/** True when an item belongs to the folder or collection the source is scoped to. */
function inScope(item: BitwardenItem, scopeName: string): boolean {
  if (!scopeName) return true;
  const needle = scopeName.trim().toLocaleLowerCase();
  return item.scopeNames.some((name) => name.trim().toLocaleLowerCase() === needle);
}

export type VaultSourceRead = {
  items: BitwardenItem[];
  skipped: { unsupportedType: number; unreadable: number; outOfScope: number };
  /** Items that exist but could not be decoded; their mirrors must be kept. */
  unreadableIds: string[];
};

/**
 * Read every item this source should mirror.
 *
 * The structural check is load-bearing rather than defensive. A 200 that is not
 * a Bitwarden sync body — a captive portal, a proxy error page, a reverse proxy
 * pointed at the wrong service — would otherwise decode as a vault with no
 * items, and the caller would faithfully mirror that emptiness by deleting
 * every item, its Member Access and its AI Employee Grants.
 */
export async function readVaultSourceItems(row: VaultSource): Promise<VaultSourceRead> {
  const session = await sessionFor(row);
  const sync = await run(() => bitwardenSync(session.endpoints, session.accessToken));
  if (!Array.isArray(readField(sync, "ciphers"))) {
    throw new VaultSourceError(
      "That server answered without a vault Genosyn could read. Check the server URL.",
      502,
    );
  }
  const read = readBitwardenVault(sync, session.userKey);
  const items = read.items.filter((item) => inScope(item, row.scopeName));
  if (items.length > MAX_MIRRORED_ITEMS) {
    throw new VaultSourceError(
      `This vault holds ${items.length} items Genosyn can mirror, over the ${MAX_MIRRORED_ITEMS} limit. Name a folder or collection to narrow it.`,
      400,
    );
  }
  return {
    items,
    skipped: { ...read.skipped, outOfScope: read.items.length - items.length },
    unreadableIds: read.unreadableIds,
  };
}

/**
 * Every key this session can decrypt an item with.
 *
 * Organization keys are RSA-encapsulated on the account profile rather than in
 * the token response, so they cost one extra request — paid once per session,
 * and only when an organization-owned item is actually read.
 */
async function vaultKeysFor(session: VaultSourceSession): Promise<BitwardenVaultKeys> {
  if (session.organizationKeys) return session.organizationKeys;
  const profile = await run(() => bitwardenProfile(session.endpoints, session.accessToken));
  const keys = readBitwardenVaultKeys({ profile }, session.userKey);
  session.organizationKeys = keys;
  return keys;
}

/**
 * Read one item live.
 *
 * This is the path every reveal, autofill and authenticator code takes, so it
 * deliberately fetches a single item rather than the whole vault.
 */
export async function readVaultSourceItem(
  row: VaultSource,
  externalItemId: string,
): Promise<BitwardenItem> {
  const session = await sessionFor(row);
  const cipher = await run(() =>
    bitwardenCipher(session.endpoints, session.accessToken, externalItemId),
  );
  const keys = await vaultKeysFor(session);
  let decoded: BitwardenItem | null = null;
  try {
    decoded = decodeBitwardenCipher(cipher, keys, { folders: new Map(), collections: new Map() });
  } catch (error) {
    if (error instanceof BitwardenCryptoError) {
      throw new VaultSourceError(error.message, 502);
    }
    throw error;
  }
  if (!decoded) {
    throw new VaultSourceError("That Vault source item could no longer be read", 502);
  }
  return decoded;
}
