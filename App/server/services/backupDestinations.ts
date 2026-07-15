import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
 * Each {@link BackupDestination} is a filesystem `path` (a mounted NAS share /
 * remote volume), an `sftp` target, or an `smb` share. After every completed
 * backup the runner calls {@link deliverBackupToDestinations}, which copies the
 * archive to each enabled destination and records per-destination health.
 * Operators can also probe a destination up-front with {@link testDestination}
 * and push an existing archive on demand.
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
type SmbConfig = {
  host: string;
  port: number;
  share: string;
  /** Directory *within* the share. Empty means the share root. */
  remoteDir: string;
  domain: string;
  username: string;
  password?: string;
  /**
   * SMB3 in-transit encryption. On by default: an archive is every company's
   * data in one file, and signing alone leaves it readable on the wire. Every
   * NAS with SMB3 supports it; the pre-SMB3 boxes that don't are why this is a
   * toggle rather than a constant.
   */
  encrypt: boolean;
};
type DestConfig = LocalConfig | SftpConfig | SmbConfig;

/** A small file we write then remove to prove a destination is writable. */
const PROBE_NAME = ".genosyn-write-test";
const SFTP_READY_TIMEOUT_MS = 15_000;
const SMB_PROBE_TIMEOUT_MS = 30_000;
const SMB_DELIVER_TIMEOUT_MS = 30 * 60_000;
const SMB_DEFAULT_PORT = 445;

export type DestinationInput = {
  name: string;
  kind: BackupDestinationKind;
  enabled?: boolean;
  // local
  path?: string;
  // sftp + smb
  host?: string;
  port?: number;
  username?: string;
  remoteDir?: string;
  password?: string;
  // sftp
  authMode?: SftpAuthMode;
  privateKey?: string;
  passphrase?: string;
  // smb
  share?: string;
  domain?: string;
  encrypt?: boolean;
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
  if (kind === "smb") {
    const s = cfg as SmbConfig;
    const base = `//${s.host}/${s.share}`;
    return s.remoteDir ? `${base}/${s.remoteDir}` : base;
  }
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
  if (kind === "smb") {
    const prevSmb = (existing as SmbConfig) ?? null;
    const cfg: SmbConfig = {
      host: (input.host ?? prevSmb?.host ?? "").trim(),
      port: input.port ?? prevSmb?.port ?? SMB_DEFAULT_PORT,
      share: (input.share ?? prevSmb?.share ?? "").trim().replace(/^\/+|\/+$/g, ""),
      remoteDir: normalizeSmbDir(input.remoteDir ?? prevSmb?.remoteDir ?? ""),
      domain: (input.domain ?? prevSmb?.domain ?? "").trim(),
      username: (input.username ?? prevSmb?.username ?? "").trim(),
      encrypt: input.encrypt ?? prevSmb?.encrypt ?? true,
    };
    cfg.password = input.password && input.password.length > 0
      ? input.password
      : prevSmb?.password;
    return cfg;
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
    } else if (row.kind === "smb") {
      await probeSmb(cfg as SmbConfig);
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
    } else if (row.kind === "smb") {
      await copySmb(cfg as SmbConfig, filename, absPath);
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

const execFileAsync = promisify(execFile);

/**
 * Characters we refuse in an SMB path segment.
 *
 * SMB itself forbids \ / : * ? " < > | in a name, so most of this list is just
 * the protocol's own rule. We additionally reject `;` — legal in SMB, but
 * fatal for us, see {@link runSmbClient} — and control characters.
 *
 * Spaces and hyphens stay legal: "My Backups" is an ordinary share name, and
 * the archive filenames are themselves hyphenated.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they're what we reject.
const SMB_UNSAFE_SEGMENT = /[\\/:*?"<>|;\x00-\x1f]/;

/** Accept backslashes (what a Windows user will paste) and trim edge slashes. */
function normalizeSmbDir(dir: string): string {
  return dir.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function assertSafeSmbSegment(value: string, label: string): void {
  if (!value) throw new Error(`${label} is empty`);
  if (SMB_UNSAFE_SEGMENT.test(value)) {
    throw new Error(
      `${label} contains a character that isn't allowed in an SMB path ` +
        `(\\ / : * ? " < > | ; or a control character)`,
    );
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} can't contain "." or ".." segments`);
  }
}

/** Split a validated remote dir into its path segments (empty = share root). */
function smbDirSegments(remoteDir: string): string[] {
  const segments = normalizeSmbDir(remoteDir).split("/").filter(Boolean);
  for (const seg of segments) assertSafeSmbSegment(seg, "Remote directory");
  return segments;
}

/**
 * Write smbclient's credentials file, run `fn`, then shred it.
 *
 * smbclient will also take `-U user%password`, but argv is readable through
 * /proc to anything in the same PID namespace — and this image ships `bash`
 * for the coding tool, so an employee running `ps` mid-delivery would read the
 * NAS password straight off the process list. A 0600 file inside a 0700
 * mkdtemp dir keeps it to this process, and the finally bounds it to the
 * transfer.
 */
async function withSmbAuthFile<T>(
  cfg: SmbConfig,
  fn: (authFile: string) => Promise<T>,
): Promise<T> {
  // The file is line-oriented, so a newline in any value would forge a field.
  const fields: [string, string][] = [
    ["Username", cfg.username],
    ["Password", cfg.password ?? ""],
    ["Domain", cfg.domain],
  ];
  for (const [label, value] of fields) {
    if (/[\r\n]/.test(value)) throw new Error(`${label} can't contain a line break`);
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "genosyn-smb-"));
  const authFile = path.join(dir, "auth");
  const lines = [`username=${cfg.username}`, `password=${cfg.password ?? ""}`];
  if (cfg.domain) lines.push(`domain=${cfg.domain}`);
  await fs.promises.writeFile(authFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    return await fn(authFile);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run one smbclient invocation against `cfg`, executing `commands` on the
 * share.
 *
 * `commands` is smbclient's own semicolon-separated mini-language, and quoting
 * is *not* a security boundary inside it: a `"` in a name closes the quote and
 * everything past the next `;` runs as a further smbclient command (`del`,
 * `get`, ...). There's no shell behind it — `!` escapes aren't honoured under
 * `--command` — so this can't reach the host, but it can still delete or
 * exfiltrate files on the share. Hence: callers must pass segments already
 * through {@link assertSafeSmbSegment}, and every interpolated value here is
 * one we've proven inert. `--directory` *is* parsed as a literal path (safe),
 * but it can't create anything, which is why the mkdir chain goes through
 * `--command` at all.
 */
async function runSmbClient(
  cfg: SmbConfig,
  commands: string[],
  timeout: number,
): Promise<void> {
  if (!cfg.host.trim()) throw new Error("No host configured");
  assertSafeSmbSegment(cfg.share, "Share");

  await withSmbAuthFile(cfg, async (authFile) => {
    const args = [
      `//${cfg.host}/${cfg.share}`,
      "--authentication-file",
      authFile,
      // Cap at SMB3 and negotiate down; modern servers land on SMB3_11.
      "--max-protocol",
      "SMB3",
      // Signing is the floor — it's the whole reason we shell out to Samba
      // instead of using a JS client that can't sign at all.
      "--client-protection",
      cfg.encrypt ? "encrypt" : "sign",
      "--command",
      commands.join("; "),
    ];
    if (cfg.port && cfg.port !== SMB_DEFAULT_PORT) {
      args.push("--port", String(cfg.port));
    }
    try {
      await execFileAsync("smbclient", args, { timeout, windowsHide: true });
    } catch (err) {
      throw new Error(smbErrorMessage(err, cfg));
    }
  });
}

/**
 * Turn an execFile rejection into something an operator can act on. smbclient
 * reports protocol errors on *stdout* and exits 1, so the useful text isn't
 * where you'd expect it.
 */
function smbErrorMessage(err: unknown, cfg: SmbConfig): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
  if (e?.code === "ENOENT") {
    return "smbclient is not installed in this image — SMB destinations need the samba-client package";
  }
  if (e?.killed) return "Timed out talking to the SMB server";

  const output = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`;
  // The mkdir chain re-creates existing directories on every delivery, so a
  // collision is expected noise on stdout — never the reason we failed. It's
  // also the *first* status in the output, so scanning naively would report it
  // in place of the real error further down.
  const status = (output.match(/NT_STATUS_[A-Z_]+/g) ?? []).find(
    (s) => s !== "NT_STATUS_OBJECT_NAME_COLLISION",
  );
  switch (status) {
    case "NT_STATUS_LOGON_FAILURE":
      return "Authentication failed — check the username, password, and domain";
    case "NT_STATUS_BAD_NETWORK_NAME":
      return `Share "${cfg.share}" does not exist on ${cfg.host}`;
    case "NT_STATUS_ACCESS_DENIED":
      return "Access denied — the account can't write to that share";
    case "NT_STATUS_OBJECT_PATH_NOT_FOUND":
    case "NT_STATUS_OBJECT_NAME_NOT_FOUND":
      return "The remote directory could not be created or reached";
    default:
      break;
  }
  if (/protocol negotiation failed|NT_STATUS_CONNECTION/i.test(output)) {
    return cfg.encrypt
      ? `Could not negotiate an encrypted SMB3 session with ${cfg.host} — if this NAS predates SMB3, turn off "Encrypt in transit"`
      : `Could not connect to ${cfg.host}`;
  }
  const firstLine = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.includes("NT_STATUS_OBJECT_NAME_COLLISION"));
  return firstLine || (e?.message ?? "smbclient failed");
}

/**
 * `mkdir -p` for a share: smbclient's own mkdir won't create intermediate
 * directories, so we walk the chain a level at a time. Creating one that
 * already exists prints a collision but still exits 0, which is exactly the
 * idempotency we want — a real failure (a bad `put`) still surfaces as a
 * non-zero exit from the same invocation.
 */
function smbMkdirChain(segments: string[]): string[] {
  return segments.map(
    (_seg, i) => `mkdir "${segments.slice(0, i + 1).join("/")}"`,
  );
}

/** Path of `name` inside the destination's remote dir, for smbclient's `-c`. */
function smbRemotePath(segments: string[], name: string): string {
  return [...segments, name].join("/");
}

async function probeSmb(cfg: SmbConfig): Promise<void> {
  const segments = smbDirSegments(cfg.remoteDir);
  const probe = smbRemotePath(segments, PROBE_NAME);
  const local = await fs.promises.mkdtemp(path.join(os.tmpdir(), "genosyn-smb-probe-"));
  const localProbe = path.join(local, PROBE_NAME);
  await fs.promises.writeFile(localProbe, "genosyn backup destination test\n");
  try {
    await runSmbClient(
      cfg,
      [
        ...smbMkdirChain(segments),
        `put "${localProbe}" "${probe}"`,
        `del "${probe}"`,
      ],
      SMB_PROBE_TIMEOUT_MS,
    );
  } finally {
    await fs.promises.rm(local, { recursive: true, force: true });
  }
}

async function copySmb(
  cfg: SmbConfig,
  filename: string,
  absPath: string,
): Promise<void> {
  assertSafeSmbSegment(filename, "Backup filename");
  const segments = smbDirSegments(cfg.remoteDir);
  await runSmbClient(
    cfg,
    [
      ...smbMkdirChain(segments),
      `put "${absPath}" "${smbRemotePath(segments, filename)}"`,
    ],
    SMB_DELIVER_TIMEOUT_MS,
  );
}

export function serializeDestination(row: BackupDestination) {
  const cfg = decodeConfig(row);
  const local = row.kind === "local" ? (cfg as LocalConfig | null) : null;
  const sftp = row.kind === "sftp" ? (cfg as SftpConfig | null) : null;
  const smb = row.kind === "smb" ? (cfg as SmbConfig | null) : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    hint: row.hint,
    path: local?.path ?? null,
    // host / port / username / remoteDir are shared by the sftp and smb kinds.
    host: sftp?.host ?? smb?.host ?? null,
    port: sftp?.port ?? smb?.port ?? null,
    username: sftp?.username ?? smb?.username ?? null,
    remoteDir: sftp?.remoteDir ?? smb?.remoteDir ?? null,
    authMode: sftp?.authMode ?? null,
    share: smb?.share ?? null,
    domain: smb?.domain ?? null,
    encrypt: smb?.encrypt ?? null,
    hasPassword: Boolean(sftp?.password ?? smb?.password),
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
