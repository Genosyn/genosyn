import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../../config.js";

export const SESSION_SECRET_PLACEHOLDER = "change-me-in-production";
export const ENCRYPTION_SECRET_PLACEHOLDER = "change-me-in-production-too";

const MANAGED_SECRET_VERSION = 1;
export const INSTANCE_SECRETS_FILENAME = ".instance-secrets.json";
export const INSTANCE_SECRETS_SENTINEL_FILENAME = ".instance-secrets.required";
const SECRET_BYTES = 48;

type ManagedInstanceSecrets = {
  version: typeof MANAGED_SECRET_VERSION;
  sessionSecret: string;
  encryptionSecret: string;
  compatibility: {
    placeholderSessionDecryption: boolean;
    placeholderEncryptionDecryption: boolean;
  };
};

type InstanceSecretsSentinel = {
  version: typeof MANAGED_SECRET_VERSION;
  keyId: string;
};

export type EffectiveInstanceSecrets = {
  sessionSecret: string;
  encryptionSecret: string;
  /** Current key first, followed by read-only rotation/compatibility keys. */
  encryptionDecryptionSecrets: readonly string[];
  /** Session-derived keys used only to read pre-v2 ciphertext. */
  legacySessionDecryptionSecrets: readonly string[];
  managedFilePath: string | null;
  /** Non-secret digest used to bind the managed file to its database. */
  managedKeyId: string | null;
  usingManagedSessionSecret: boolean;
  usingManagedEncryptionSecret: boolean;
  placeholderSessionFallbackEnabled: boolean;
  placeholderEncryptionFallbackEnabled: boolean;
};

/** Opaque in-memory copy used only while replacing dataDir during restore. */
export type InstanceSecretsDiskSnapshot = {
  secretsJson: string;
  sentinelJson: string;
};

let cached: { fingerprint: string; value: EffectiveInstanceSecrets } | null = null;

export function isInstanceSecretPlaceholder(value: string): boolean {
  return value === SESSION_SECRET_PLACEHOLDER || value === ENCRYPTION_SECRET_PLACEHOLDER;
}

export function isStrongInstanceSecret(value: string): boolean {
  return value.length >= 32 && !isInstanceSecretPlaceholder(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function generateSecret(exclusions: readonly string[] = []): string {
  for (;;) {
    const candidate = crypto.randomBytes(SECRET_BYTES).toString("base64url");
    if (!exclusions.includes(candidate)) return candidate;
  }
}

function validateManagedSecrets(value: unknown, filePath: string): ManagedInstanceSecrets {
  if (!value || typeof value !== "object") {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  const candidate = value as Partial<ManagedInstanceSecrets>;
  if (candidate.version !== MANAGED_SECRET_VERSION) {
    throw new Error(`${filePath} has an unsupported version`);
  }
  if (
    typeof candidate.sessionSecret !== "string" ||
    !isStrongInstanceSecret(candidate.sessionSecret)
  ) {
    throw new Error(`${filePath} contains an invalid session secret`);
  }
  if (
    typeof candidate.encryptionSecret !== "string" ||
    !isStrongInstanceSecret(candidate.encryptionSecret)
  ) {
    throw new Error(`${filePath} contains an invalid encryption secret`);
  }
  if (candidate.sessionSecret === candidate.encryptionSecret) {
    throw new Error(`${filePath} must contain distinct session and encryption secrets`);
  }
  if (
    !candidate.compatibility ||
    typeof candidate.compatibility.placeholderSessionDecryption !== "boolean" ||
    typeof candidate.compatibility.placeholderEncryptionDecryption !== "boolean"
  ) {
    throw new Error(`${filePath} contains invalid compatibility state`);
  }
  return {
    version: MANAGED_SECRET_VERSION,
    sessionSecret: candidate.sessionSecret,
    encryptionSecret: candidate.encryptionSecret,
    compatibility: {
      placeholderSessionDecryption: candidate.compatibility.placeholderSessionDecryption,
      placeholderEncryptionDecryption: candidate.compatibility.placeholderEncryptionDecryption,
    },
  };
}

function readManagedSecrets(filePath: string): ManagedInstanceSecrets | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  // Repair permissive modes left by a manual copy before reading any values.
  fs.chmodSync(filePath, 0o600);
  let decoded: unknown;
  try {
    decoded = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${filePath} could not be read as JSON`, { cause: error });
  }
  return validateManagedSecrets(decoded, filePath);
}

function syncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some platforms do not allow fsync on directories. The file itself was
    // still fsynced and linked atomically, so this is a durability enhancement.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function publishFileAtomically(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    try {
      // A hard link publishes the fully-written inode only if the destination
      // does not already exist. Concurrent starters therefore share one winner
      // without ever observing a partial JSON file or overwriting each other.
      fs.linkSync(tempPath, filePath);
      fs.chmodSync(filePath, 0o600);
      syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The published file is already durable and the unpublished sibling is
      // mode 0600. A failed best-effort cleanup must not mask the real result.
    }
  }
}

function replaceFileAtomically(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(directory);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The rename normally consumed the temporary file. A remaining 0600
      // sibling is safe to clean up on a later operator maintenance pass.
    }
  }
}

function createManagedSecrets(
  filePath: string,
  compatibility: ManagedInstanceSecrets["compatibility"],
): ManagedInstanceSecrets {
  const sessionSecret = generateSecret([
    String(config.sessionSecret),
    String(config.security.encryptionSecret),
  ]);
  const encryptionSecret = generateSecret([
    sessionSecret,
    String(config.sessionSecret),
    String(config.security.encryptionSecret),
  ]);
  const value: ManagedInstanceSecrets = {
    version: MANAGED_SECRET_VERSION,
    sessionSecret,
    encryptionSecret,
    compatibility,
  };
  publishFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);

  // Re-read even when this process won. That applies the same validation path
  // to disk bytes and returns the other process's value if it won the race.
  const stored = readManagedSecrets(filePath);
  if (!stored) throw new Error(`Failed to create ${filePath}`);
  return stored;
}

function managedKeyId(managed: ManagedInstanceSecrets): string {
  return crypto
    .createHash("sha256")
    .update(managed.sessionSecret)
    .update("\0")
    .update(managed.encryptionSecret)
    .digest("hex");
}

function validateSentinel(value: unknown, filePath: string): InstanceSecretsSentinel {
  const candidate = value as Partial<InstanceSecretsSentinel>;
  if (
    candidate.version !== MANAGED_SECRET_VERSION ||
    typeof candidate.keyId !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.keyId)
  ) {
    throw new Error(`${filePath} contains invalid managed-secret state`);
  }
  return { version: MANAGED_SECRET_VERSION, keyId: candidate.keyId };
}

function readSentinel(filePath: string): InstanceSecretsSentinel | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  fs.chmodSync(filePath, 0o600);
  try {
    return validateSentinel(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown, filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} could not be read as JSON`, { cause: error });
    }
    throw error;
  }
}

function ensureSentinel(filePath: string, managed: ManagedInstanceSecrets): void {
  const expected: InstanceSecretsSentinel = {
    version: MANAGED_SECRET_VERSION,
    keyId: managedKeyId(managed),
  };
  const existing = readSentinel(filePath);
  if (existing && existing.keyId !== expected.keyId) {
    throw new Error(`${filePath} does not match ${INSTANCE_SECRETS_FILENAME}`);
  }
  if (!existing) {
    publishFileAtomically(filePath, `${JSON.stringify(expected, null, 2)}\n`);
    const stored = readSentinel(filePath);
    if (!stored || stored.keyId !== expected.keyId) {
      throw new Error(`Failed to create ${filePath}`);
    }
  }
}

function installationHasExistingData(dataDir: string): boolean {
  try {
    const sqlitePath = path.resolve(config.db.sqlitePath);
    if (fs.statSync(sqlitePath).size > 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return fs
      .readdirSync(dataDir)
      .some(
        (entry) =>
          entry !== INSTANCE_SECRETS_FILENAME &&
          entry !== INSTANCE_SECRETS_SENTINEL_FILENAME &&
          !entry.startsWith(`.${INSTANCE_SECRETS_FILENAME}.`) &&
          !entry.startsWith(`.${INSTANCE_SECRETS_SENTINEL_FILENAME}.`),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Resolve the active installation secrets and every compatibility read key.
 *
 * Placeholder self-host installs receive durable generated secrets. Shared
 * multi-tenant installs never substitute managed values for placeholders:
 * runtime validation requires operators to configure explicit secrets there.
 */
export function getEffectiveInstanceSecrets(): EffectiveInstanceSecrets {
  const dataDir = path.resolve(config.dataDir);
  const fingerprint = JSON.stringify([
    dataDir,
    config.security.multiTenant,
    config.sessionSecret,
    config.security.encryptionSecret,
    config.security.previousEncryptionSecrets,
  ]);
  if (cached?.fingerprint === fingerprint) return cached.value;

  const filePath = path.join(dataDir, INSTANCE_SECRETS_FILENAME);
  const sentinelPath = path.join(dataDir, INSTANCE_SECRETS_SENTINEL_FILENAME);
  const configuredSession = String(config.sessionSecret);
  const configuredEncryption = String(config.security.encryptionSecret);
  if (
    config.security.multiTenant &&
    (configuredSession === SESSION_SECRET_PLACEHOLDER ||
      configuredEncryption === ENCRYPTION_SECRET_PLACEHOLDER)
  ) {
    throw new Error("Shared multi-tenant installs require explicit session and encryption secrets");
  }
  const mayUseManaged = !config.security.multiTenant;
  const needsManaged =
    mayUseManaged &&
    (configuredSession === SESSION_SECRET_PLACEHOLDER ||
      configuredEncryption === ENCRYPTION_SECRET_PLACEHOLDER);
  const sentinel = readSentinel(sentinelPath);
  let managed = readManagedSecrets(filePath);
  if (!managed && sentinel) {
    throw new Error(`${filePath} is missing; restore it from the same backup as the database`);
  }
  if (!managed && needsManaged) {
    const existingData = installationHasExistingData(dataDir);
    managed = createManagedSecrets(filePath, {
      placeholderSessionDecryption:
        existingData && configuredSession === SESSION_SECRET_PLACEHOLDER,
      placeholderEncryptionDecryption:
        existingData && configuredEncryption === ENCRYPTION_SECRET_PLACEHOLDER,
    });
  }
  if (managed) ensureSentinel(sentinelPath, managed);

  const usingManagedSessionSecret =
    mayUseManaged && configuredSession === SESSION_SECRET_PLACEHOLDER;
  const usingManagedEncryptionSecret =
    mayUseManaged && configuredEncryption === ENCRYPTION_SECRET_PLACEHOLDER;
  const sessionSecret = usingManagedSessionSecret ? managed!.sessionSecret : configuredSession;
  const encryptionSecret = usingManagedEncryptionSecret
    ? managed!.encryptionSecret
    : configuredEncryption;
  const placeholderSessionFallbackEnabled = Boolean(
    mayUseManaged && managed?.compatibility.placeholderSessionDecryption,
  );
  const placeholderEncryptionFallbackEnabled = Boolean(
    mayUseManaged && managed?.compatibility.placeholderEncryptionDecryption,
  );

  const value: EffectiveInstanceSecrets = Object.freeze({
    sessionSecret,
    encryptionSecret,
    encryptionDecryptionSecrets: Object.freeze(
      unique([
        encryptionSecret,
        ...config.security.previousEncryptionSecrets.filter(isStrongInstanceSecret),
        managed?.encryptionSecret ?? "",
        placeholderEncryptionFallbackEnabled ? ENCRYPTION_SECRET_PLACEHOLDER : "",
      ]),
    ),
    legacySessionDecryptionSecrets: Object.freeze(
      unique([
        sessionSecret,
        managed?.sessionSecret ?? "",
        placeholderSessionFallbackEnabled ? SESSION_SECRET_PLACEHOLDER : "",
      ]),
    ),
    managedFilePath: managed ? filePath : null,
    managedKeyId: managed ? managedKeyId(managed) : null,
    usingManagedSessionSecret,
    usingManagedEncryptionSecret,
    placeholderSessionFallbackEnabled,
    placeholderEncryptionFallbackEnabled,
  });
  cached = { fingerprint, value };
  return value;
}

/**
 * Durably add decrypt-only compatibility after the database proves this is a
 * legacy installation. Current cookie, encryption and unsubscribe signing keys
 * remain managed; this changes read fallbacks only.
 */
export function enableLegacyPlaceholderDecryption(options: {
  session: boolean;
  encryption: boolean;
}): EffectiveInstanceSecrets {
  if (config.security.multiTenant) {
    throw new Error("Placeholder compatibility is unavailable in multi-tenant mode");
  }
  const dataDir = path.resolve(config.dataDir);
  const filePath = path.join(dataDir, INSTANCE_SECRETS_FILENAME);
  const sentinelPath = path.join(dataDir, INSTANCE_SECRETS_SENTINEL_FILENAME);
  const managed = readManagedSecrets(filePath);
  if (!managed) {
    throw new Error(`${filePath} is required for placeholder compatibility`);
  }
  ensureSentinel(sentinelPath, managed);
  const next: ManagedInstanceSecrets = {
    ...managed,
    compatibility: {
      placeholderSessionDecryption:
        managed.compatibility.placeholderSessionDecryption || options.session,
      placeholderEncryptionDecryption:
        managed.compatibility.placeholderEncryptionDecryption || options.encryption,
    },
  };
  if (
    next.compatibility.placeholderSessionDecryption !==
      managed.compatibility.placeholderSessionDecryption ||
    next.compatibility.placeholderEncryptionDecryption !==
      managed.compatibility.placeholderEncryptionDecryption
  ) {
    replaceFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return reloadEffectiveInstanceSecrets();
}

/**
 * Hold the current managed files in memory across an in-process backup restore.
 * Callers must never serialize, log, or return this snapshot.
 */
export function snapshotManagedInstanceSecrets(): InstanceSecretsDiskSnapshot | null {
  const dataDir = path.resolve(config.dataDir);
  const filePath = path.join(dataDir, INSTANCE_SECRETS_FILENAME);
  const sentinelPath = path.join(dataDir, INSTANCE_SECRETS_SENTINEL_FILENAME);
  const managed = readManagedSecrets(filePath);
  const sentinel = readSentinel(sentinelPath);
  if (!managed) {
    if (sentinel) {
      throw new Error(`${filePath} is missing; restore it from the same backup as the database`);
    }
    return null;
  }
  ensureSentinel(sentinelPath, managed);
  const verifiedSentinel = readSentinel(sentinelPath);
  if (!verifiedSentinel) throw new Error(`Failed to read ${sentinelPath}`);
  return {
    secretsJson: `${JSON.stringify(managed, null, 2)}\n`,
    sentinelJson: `${JSON.stringify(verifiedSentinel, null, 2)}\n`,
  };
}

/** Preserve this install's managed identity when restoring a pre-managed backup. */
export function restoreManagedInstanceSecretsIfMissing(
  snapshot: InstanceSecretsDiskSnapshot | null,
  options: { enablePlaceholderCompatibility?: boolean } = {},
): void {
  if (!snapshot) return;
  const dataDir = path.resolve(config.dataDir);
  const filePath = path.join(dataDir, INSTANCE_SECRETS_FILENAME);
  const sentinelPath = path.join(dataDir, INSTANCE_SECRETS_SENTINEL_FILENAME);
  // An archive-supplied identity wins as a pair. Partial archive state is left
  // untouched so the reload below fails closed rather than mixing identities.
  if (fs.existsSync(filePath) || fs.existsSync(sentinelPath)) return;

  const preservedManaged = validateManagedSecrets(
    JSON.parse(snapshot.secretsJson) as unknown,
    filePath,
  );
  const managed: ManagedInstanceSecrets = options.enablePlaceholderCompatibility
    ? {
        ...preservedManaged,
        compatibility: {
          placeholderSessionDecryption: true,
          placeholderEncryptionDecryption: true,
        },
      }
    : preservedManaged;
  const sentinel = validateSentinel(JSON.parse(snapshot.sentinelJson) as unknown, sentinelPath);
  if (sentinel.keyId !== managedKeyId(managed)) {
    throw new Error("The preserved managed-secret files do not match");
  }
  publishFileAtomically(filePath, `${JSON.stringify(managed, null, 2)}\n`);
  publishFileAtomically(sentinelPath, snapshot.sentinelJson);
}

/** Reload managed state after an in-process dataDir replacement. */
export function reloadEffectiveInstanceSecrets(): EffectiveInstanceSecrets {
  cached = null;
  return getEffectiveInstanceSecrets();
}

/** Tests change config and temporary data directories inside one process. */
export function resetInstanceSecretsCacheForTests(): void {
  cached = null;
}
