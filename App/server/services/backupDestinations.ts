import path from "node:path";
import fs from "node:fs";
import SftpClient from "ssh2-sftp-client";
import { AppDataSource } from "../db/datasource.js";
import {
  BackupDestination,
  BackupDestinationKind,
  BackupDestinationStatus,
} from "../db/entities/BackupDestination.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";

/**
 * Off-box delivery of backup archives to NAS / remote volumes.
 *
 * Each {@link BackupDestination} is either a filesystem `path` (a mounted NAS
 * share / remote volume) or an `sftp` target. After every completed backup the
 * runner calls {@link deliverBackupToDestinations}, which copies the archive to
 * each enabled destination and records per-destination health. Operators can
 * also probe a destination up-front with {@link testDestination} and push an
 * existing archive on demand.
 *
 * The local `<dataDir>/Backup/` folder remains the primary store; destinations
 * are mirrors, so a delivery failure never fails the backup itself.
 */

type LocalConfig = { path: string };
type SftpAuthMode = "password" | "key";
type SftpConfig = {
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  authMode: SftpAuthMode;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};
type DestConfig = LocalConfig | SftpConfig;

/** A small file we write then remove to prove a destination is writable. */
const PROBE_NAME = ".genosyn-write-test";
const SFTP_READY_TIMEOUT_MS = 15_000;

export type DestinationInput = {
  name: string;
  kind: BackupDestinationKind;
  enabled?: boolean;
  // local
  path?: string;
  // sftp
  host?: string;
  port?: number;
  username?: string;
  remoteDir?: string;
  authMode?: SftpAuthMode;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

export type DeliveryResult = {
  destinationId: string;
  destinationName: string;
  ok: boolean;
  error?: string;
};

function decodeConfig(row: BackupDestination): DestConfig | null {
  try {
    return JSON.parse(decryptSecret(row.encryptedConfig)) as DestConfig;
  } catch {
    return null;
  }
}

function hintFor(kind: BackupDestinationKind, cfg: DestConfig): string {
  if (kind === "local") return (cfg as LocalConfig).path;
  const s = cfg as SftpConfig;
  return `${s.username}@${s.host}:${s.remoteDir}`;
}

/**
 * Fold a create / update payload into a stored config. On update, secret
 * fields (`password`, `privateKey`, `passphrase`) are only replaced when the
 * caller supplies a non-empty value — omitting them keeps what's on disk so
 * the UI never has to round-trip a secret back to re-save unrelated fields.
 */
function buildConfig(
  kind: BackupDestinationKind,
  input: DestinationInput,
  existing: DestConfig | null,
): DestConfig {
  if (kind === "local") {
    return { path: (input.path ?? (existing as LocalConfig)?.path ?? "").trim() };
  }
  const prev = (existing as SftpConfig) ?? null;
  const authMode: SftpAuthMode =
    input.authMode ?? prev?.authMode ?? "password";
  const cfg: SftpConfig = {
    host: (input.host ?? prev?.host ?? "").trim(),
    port: input.port ?? prev?.port ?? 22,
    username: (input.username ?? prev?.username ?? "").trim(),
    remoteDir: (input.remoteDir ?? prev?.remoteDir ?? "").trim(),
    authMode,
  };
  if (authMode === "password") {
    cfg.password = input.password && input.password.length > 0
      ? input.password
      : prev?.password;
  } else {
    cfg.privateKey = input.privateKey && input.privateKey.length > 0
      ? input.privateKey
      : prev?.privateKey;
    const pass = input.passphrase && input.passphrase.length > 0
      ? input.passphrase
      : prev?.passphrase;
    if (pass) cfg.passphrase = pass;
  }
  return cfg;
}

export async function listDestinations(): Promise<BackupDestination[]> {
  return AppDataSource.getRepository(BackupDestination).find({
    order: { createdAt: "ASC" },
  });
}

export async function getDestination(
  id: string,
): Promise<BackupDestination | null> {
  return AppDataSource.getRepository(BackupDestination).findOneBy({ id });
}

export async function createDestination(
  input: DestinationInput,
  createdById: string | null,
): Promise<BackupDestination> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const cfg = buildConfig(input.kind, input, null);
  const row = repo.create({
    name: input.name.trim(),
    kind: input.kind,
    enabled: input.enabled ?? true,
    encryptedConfig: encryptSecret(JSON.stringify(cfg)),
    hint: hintFor(input.kind, cfg),
    lastStatus: "unknown",
    lastError: "",
    lastSyncedAt: null,
    lastCheckedAt: null,
    createdById,
  });
  return repo.save(row);
}

export async function updateDestination(
  id: string,
  input: Partial<DestinationInput>,
): Promise<BackupDestination | null> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const row = await repo.findOneBy({ id });
  if (!row) return null;
  if (typeof input.name === "string" && input.name.trim())
    row.name = input.name.trim();
  if (typeof input.enabled === "boolean") row.enabled = input.enabled;
  // Kind is immutable — rebuild the config within the row's existing kind,
  // merging any provided fields over what's stored (secrets preserved).
  const existing = decodeConfig(row);
  const cfg = buildConfig(row.kind, { ...input, kind: row.kind } as DestinationInput, existing);
  row.encryptedConfig = encryptSecret(JSON.stringify(cfg));
  row.hint = hintFor(row.kind, cfg);
  return repo.save(row);
}

export async function deleteDestination(id: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const row = await repo.findOneBy({ id });
  if (!row) return false;
  await repo.delete({ id });
  return true;
}

/**
 * Probe a destination without shipping a real archive: ensure the target
 * directory exists and is writable by creating and deleting a tiny marker
 * file. Records the outcome on the row so History reflects the last check.
 */
export async function testDestination(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const row = await repo.findOneBy({ id });
  if (!row) return { ok: false, message: "Destination not found" };
  const cfg = decodeConfig(row);
  let ok = false;
  let message = "";
  try {
    if (!cfg) throw new Error("Stored configuration could not be decrypted");
    if (row.kind === "local") {
      await probeLocal(cfg as LocalConfig);
    } else {
      await probeSftp(cfg as SftpConfig);
    }
    ok = true;
    message = "Destination is reachable and writable.";
  } catch (err) {
    ok = false;
    message = (err as Error).message ?? String(err);
  }
  row.lastCheckedAt = new Date();
  row.lastStatus = ok ? "ok" : "error";
  row.lastError = ok ? "" : message;
  await repo.save(row);
  return { ok, message };
}

async function probeLocal(cfg: LocalConfig): Promise<void> {
  const dir = cfg.path?.trim();
  if (!dir) throw new Error("No path configured");
  await fs.promises.mkdir(dir, { recursive: true });
  const probe = path.join(dir, PROBE_NAME);
  await fs.promises.writeFile(probe, "genosyn backup destination test\n");
  await fs.promises.unlink(probe);
}

async function probeSftp(cfg: SftpConfig): Promise<void> {
  const client = new SftpClient();
  try {
    await client.connect(sftpConnectOptions(cfg));
    await client.mkdir(cfg.remoteDir, true);
    const probe = joinRemote(cfg.remoteDir, PROBE_NAME);
    await client.put(
      Buffer.from("genosyn backup destination test\n"),
      probe,
    );
    await client.delete(probe, true);
  } finally {
    await safeEnd(client);
  }
}

/**
 * Copy a completed archive to every enabled destination. Best-effort: a
 * failure to reach one destination is recorded on that row and returned in the
 * result list, but never throws — the local backup already succeeded.
 */
export async function deliverBackupToDestinations(
  filename: string,
  absPath: string,
): Promise<DeliveryResult[]> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const rows = await repo.find({ where: { enabled: true } });
  const results: DeliveryResult[] = [];
  for (const row of rows) {
    results.push(await deliverOne(row, filename, absPath));
  }
  return results;
}

/**
 * Push one specific archive to every enabled destination on demand (the
 * "Send to destinations" action in History). Throws if the source file is
 * gone; per-destination failures come back inside the result list.
 */
export async function deliverArchive(
  filename: string,
  absPath: string,
): Promise<DeliveryResult[]> {
  if (!fs.existsSync(absPath)) {
    throw new Error("Backup archive is missing on disk");
  }
  return deliverBackupToDestinations(filename, absPath);
}

async function deliverOne(
  row: BackupDestination,
  filename: string,
  absPath: string,
): Promise<DeliveryResult> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const cfg = decodeConfig(row);
  try {
    if (!cfg) throw new Error("Stored configuration could not be decrypted");
    if (!fs.existsSync(absPath)) throw new Error("Source archive missing");
    if (row.kind === "local") {
      await copyLocal(cfg as LocalConfig, filename, absPath);
    } else {
      await copySftp(cfg as SftpConfig, filename, absPath);
    }
    row.lastStatus = "ok";
    row.lastError = "";
    row.lastSyncedAt = new Date();
    await repo.save(row);
    return { destinationId: row.id, destinationName: row.name, ok: true };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    row.lastStatus = "error";
    row.lastError = message;
    await repo.save(row);
    // eslint-disable-next-line no-console
    console.error(`[backups] delivery to "${row.name}" failed:`, message);
    return {
      destinationId: row.id,
      destinationName: row.name,
      ok: false,
      error: message,
    };
  }
}

async function copyLocal(
  cfg: LocalConfig,
  filename: string,
  absPath: string,
): Promise<void> {
  const dir = cfg.path?.trim();
  if (!dir) throw new Error("No path configured");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(absPath, path.join(dir, filename));
}

async function copySftp(
  cfg: SftpConfig,
  filename: string,
  absPath: string,
): Promise<void> {
  const client = new SftpClient();
  try {
    await client.connect(sftpConnectOptions(cfg));
    await client.mkdir(cfg.remoteDir, true);
    await client.fastPut(absPath, joinRemote(cfg.remoteDir, filename));
  } finally {
    await safeEnd(client);
  }
}

function sftpConnectOptions(cfg: SftpConfig): SftpClient.ConnectOptions {
  const opts: SftpClient.ConnectOptions = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username,
    readyTimeout: SFTP_READY_TIMEOUT_MS,
  };
  if (cfg.authMode === "key" && cfg.privateKey) {
    opts.privateKey = cfg.privateKey;
    if (cfg.passphrase) opts.passphrase = cfg.passphrase;
  } else if (cfg.password) {
    opts.password = cfg.password;
  }
  return opts;
}

/** SFTP paths are always POSIX, regardless of the server's OS. */
function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

async function safeEnd(client: SftpClient): Promise<void> {
  try {
    await client.end();
  } catch {
    // Connection may already be torn down; nothing to clean up.
  }
}

export function serializeDestination(row: BackupDestination) {
  const cfg = decodeConfig(row);
  const local = row.kind === "local" ? (cfg as LocalConfig | null) : null;
  const sftp = row.kind === "sftp" ? (cfg as SftpConfig | null) : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    hint: row.hint,
    path: local?.path ?? null,
    host: sftp?.host ?? null,
    port: sftp?.port ?? null,
    username: sftp?.username ?? null,
    remoteDir: sftp?.remoteDir ?? null,
    authMode: sftp?.authMode ?? null,
    hasPassword: Boolean(sftp?.password),
    hasPrivateKey: Boolean(sftp?.privateKey),
    configError: cfg === null,
    lastStatus: row.lastStatus as BackupDestinationStatus,
    lastError: row.lastError,
    lastSyncedAt: row.lastSyncedAt,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
