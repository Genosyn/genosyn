import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import SftpClient from "ssh2-sftp-client";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import {
  BackupDestination,
  BackupDestinationKind,
  BackupDestinationStatus,
} from "../db/entities/BackupDestination.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { alertDeliveryFailed, alertDeliveryRecovered, alertDue } from "./backupAlerts.js";
import {
  deleteCopiesAtDestination,
  formatBytes,
  markCopiesPending,
  markCopiesRemoved,
  markCopyCopied,
  markCopyFailed,
  markCopyStarted,
  unqueueCopy,
} from "./backupCopies.js";
import { BackupError } from "./backupErrors.js";

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
const SFTP_KEEPALIVE_INTERVAL_MS = 30_000;
const SFTP_KEEPALIVE_COUNT_MAX = 4;
const SMB_PROBE_TIMEOUT_MS = 30_000;
/** Listing a destination, deleting archives there, or renaming a finished copy. */
const SMB_HOUSEKEEPING_TIMEOUT_MS = 5 * 60_000;
/** Archives deleted per smbclient run, keeping its command line well short of the kernel's limit. */
const SMB_DELETE_BATCH = 200;
const SMB_DELIVER_BASE_TIMEOUT_MS = 30 * 60_000;
/** The slowest an SMB copy may run before it is treated as stuck. */
const SMB_MIN_BYTES_PER_SECOND = 2 * 1024 * 1024;
const SMB_DEFAULT_PORT = 445;

/**
 * How long one archive may take to reach an SMB share. This used to be a flat
 * half hour, which a 50 GB archive only meets at 28 MB/s — more than a NAS
 * across a VPN usually sustains — so every delivery was killed part-way while
 * the backup itself was fine. The limit now grows with the archive, at a floor
 * of 2 MB/s on top of the old half hour, so only a copy that has effectively
 * stopped runs out of time.
 */
export function smbDeliverTimeoutMs(sizeBytes: number): number {
  const transferMs = (Math.max(0, sizeBytes) / SMB_MIN_BYTES_PER_SECOND) * 1000;
  return SMB_DELIVER_BASE_TIMEOUT_MS + Math.ceil(transferMs);
}

/** The off-box retention policy a delivery applies, from the backup schedule. */
export type OffBoxRetention = { days: number };

/**
 * Every kind copies an archive under this suffix and renames it into place
 * once the whole of it is there. A copy cut short — a timeout, a dropped link,
 * an upgrade restarting the server — then leaves a file that says it is
 * incomplete, never one named like a backup that will not open.
 */
export const PARTIAL_SUFFIX = ".partial";

/**
 * Archives the backup service writes, `backup-YYYY-MM-DD-HHMMSS.zip` in the
 * server's local time, and the `.partial` a copy of one is written under.
 * Off-box retention only ever deletes names of this exact shape, so uploads
 * and anything else in a destination folder are left alone.
 */
const ARCHIVE_NAME = /^backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.zip(?:\.partial)?$/;

/** When the archive `name` (or a partial copy of it) was taken, read from its name; null for any other file. */
export function archiveTakenAt(name: string): Date | null {
  const match = ARCHIVE_NAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const at = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The archives on a destination that the off-box policy deletes: ones taken
 * before `cutoff` and partial copies of them, except `keep` — the archive just
 * delivered, so a destination always holds at least one complete copy however
 * old it is.
 */
export function expiredArchives(names: string[], cutoff: Date, keep: string): string[] {
  return names.filter((name) => {
    if (name === keep) return false;
    const takenAt = archiveTakenAt(name);
    return takenAt !== null && takenAt.getTime() < cutoff.getTime();
  });
}

/**
 * The archives the off-box policy deletes from a destination before `sending`
 * is copied there, to make room for it: the expired ones, except `sending`
 * itself and the newest complete archive among them. Until the new copy has
 * arrived, that newest one stands in for it, so a copy that then fails leaves
 * the destination what the policy keeps and one backup older than that; once
 * the copy arrives, {@link expiredArchives} lets it go.
 *
 * Retention used to wait for a copy to arrive, so a destination filled with
 * archives it had expired could never take another: every copy failed part-way
 * for want of the room that only a finished copy would have freed.
 */
export function expiredBeforeCopy(names: string[], cutoff: Date, sending: string): string[] {
  const expired = expiredArchives(names, cutoff, sending);
  const standIn = expired
    .filter((name) => !name.endsWith(PARTIAL_SUFFIX))
    .reduce<{ name: string; at: number } | null>((newest, name) => {
      const at = archiveTakenAt(name)!.getTime();
      return newest && newest.at >= at ? newest : { name, at };
    }, null);
  return expired.filter((name) => name !== standIn?.name);
}

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

/**
 * What one connection test found. `message` is the destination's own reason
 * when it failed. `stillFailing` marks a test that passed on a destination
 * whose copies of real backups are still failing: a test file is tiny, and a
 * share can take it and still time out on a 50 GB archive.
 */
export type DestinationTestResult = {
  ok: boolean;
  message: string;
  stillFailing: boolean;
  testedAt: string;
};

/** How a delivery is aimed and recorded. */
export type DeliveryOptions = {
  /** Record each copy's progress against this backup, as `BackupCopy` rows. */
  backupId?: string | null;
  /** Copy to these destinations only; otherwise to every enabled one. */
  destinationIds?: string[] | null;
  /**
   * Copy to a paused destination too: Try again on that one copy is asked for
   * by name. Otherwise a destination paused by its turn is skipped.
   */
  includePaused?: boolean;
};

/**
 * What this process is copying right now. In memory, like the backup run it
 * guards: built-in archives belong to the single-process self-hosted install.
 * A restore waits for every copy to finish, a backup being copied is neither
 * deleted nor pruned, and a destination being copied to isn't removed under
 * the copy.
 */
const backupsBeingCopied = new Set<string>();
const destinationsBeingCopied = new Set<string>();
let deliveriesRunning = 0;

/** Reserve `backupId` for one delivery; false while another is copying it. */
export function claimBackupCopy(backupId: string): boolean {
  if (backupsBeingCopied.has(backupId)) return false;
  backupsBeingCopied.add(backupId);
  return true;
}

export function releaseBackupCopy(backupId: string): void {
  backupsBeingCopied.delete(backupId);
}

export function isBackupBeingCopied(backupId: string): boolean {
  return backupsBeingCopied.has(backupId);
}

/** Whether any copy to any destination is running in this process. */
export function isDeliveryRunning(): boolean {
  return deliveriesRunning > 0 || backupsBeingCopied.size > 0;
}

/**
 * A test's hold on each copy to a destination, and each connection test of
 * one, just before it starts; always null in production.
 */
let destinationGateForTests: ((destination: BackupDestination) => Promise<void>) | null = null;

/**
 * Hold every copy and connection test until `gate` settles, so a test can see
 * one waiting its turn or under way; a rejection fails it with that error.
 * Null lets them through again.
 */
export function setDestinationGateForTests(
  gate: ((destination: BackupDestination) => Promise<void>) | null,
): void {
  destinationGateForTests = gate;
}

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
    cfg.password = input.password && input.password.length > 0 ? input.password : prevSmb?.password;
    return cfg;
  }
  const prev = (existing as SftpConfig) ?? null;
  const authMode: SftpAuthMode = input.authMode ?? prev?.authMode ?? "password";
  const cfg: SftpConfig = {
    host: (input.host ?? prev?.host ?? "").trim(),
    port: input.port ?? prev?.port ?? 22,
    username: (input.username ?? prev?.username ?? "").trim(),
    remoteDir: (input.remoteDir ?? prev?.remoteDir ?? "").trim(),
    authMode,
  };
  if (authMode === "password") {
    cfg.password = input.password && input.password.length > 0 ? input.password : prev?.password;
  } else {
    cfg.privateKey =
      input.privateKey && input.privateKey.length > 0 ? input.privateKey : prev?.privateKey;
    const pass =
      input.passphrase && input.passphrase.length > 0 ? input.passphrase : prev?.passphrase;
    if (pass) cfg.passphrase = pass;
  }
  return cfg;
}

export async function listDestinations(): Promise<BackupDestination[]> {
  return AppDataSource.getRepository(BackupDestination).find({
    order: { createdAt: "ASC" },
  });
}

export async function getDestination(id: string): Promise<BackupDestination | null> {
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
  if (typeof input.name === "string" && input.name.trim()) row.name = input.name.trim();
  if (typeof input.enabled === "boolean") row.enabled = input.enabled;
  // Kind is immutable — rebuild the config within the row's existing kind,
  // merging any provided fields over what's stored (secrets preserved).
  const existing = decodeConfig(row);
  const cfg = buildConfig(row.kind, { ...input, kind: row.kind } as DestinationInput, existing);
  row.encryptedConfig = encryptSecret(JSON.stringify(cfg));
  row.hint = hintFor(row.kind, cfg);
  return repo.save(row);
}

/**
 * Remove a destination and History's record of the copies on it. The archives
 * already there stay on the destination: Genosyn just stops copying to it and
 * tracking them. Refused while a copy to it is running, which would otherwise
 * finish by recording itself against a destination that no longer exists.
 */
export async function deleteDestination(id: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const row = await repo.findOneBy({ id });
  if (!row) return false;
  if (destinationsBeingCopied.has(id)) {
    throw new BackupError(
      `A backup is being copied to ${row.name} right now. Remove it once that copy finishes.`,
    );
  }
  await repo.delete({ id });
  await deleteCopiesAtDestination(id);
  return true;
}

/** What a passing test says, in plain words. */
export const TEST_PASSED_MESSAGE = "Connected. Genosyn can write backups here.";
export const TEST_PASSED_STILL_FAILING_MESSAGE =
  "Connected, and a test file got through, but copies of real backups here are still failing. Copy the latest backup here to confirm it's fixed.";

/**
 * Probe a destination without shipping a real archive: ensure the target
 * directory exists and is writable by creating and deleting a tiny marker
 * file. Records the outcome on the row, except that a passing probe leaves a
 * run of failed deliveries standing — and says so, rather than reading as
 * though the destination were fixed.
 */
export async function testDestination(id: string): Promise<DestinationTestResult | null> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const row = await repo.findOneBy({ id });
  if (!row) return null;
  const cfg = decodeConfig(row);
  let ok = false;
  let message = "";
  try {
    if (destinationGateForTests) await destinationGateForTests(row);
    if (!cfg) {
      throw new Error(
        "Its saved settings can't be read (was the encryption key changed?). Edit it and enter its password again.",
      );
    }
    if (row.kind === "local") {
      await probeLocal(cfg as LocalConfig);
    } else if (row.kind === "smb") {
      await probeSmb(cfg as SmbConfig);
    } else {
      await probeSftp(cfg as SftpConfig);
    }
    ok = true;
  } catch (err) {
    ok = false;
    message =
      ((err as Error)?.message ?? String(err)).trim() || "The test failed without a reason.";
  }
  const testedAt = new Date();
  // The probe proves a small file gets through, not a whole archive: a share
  // can take it and still time out on a 50 GB copy. While deliveries are
  // failing, their error stays the destination's status until one succeeds.
  const stillFailing = ok && row.failingSince !== null;
  if (ok) message = stillFailing ? TEST_PASSED_STILL_FAILING_MESSAGE : TEST_PASSED_MESSAGE;
  // Only the columns a test owns: an edit saved while it ran must survive it.
  await repo.update(
    { id: row.id },
    stillFailing
      ? { lastCheckedAt: testedAt }
      : { lastCheckedAt: testedAt, lastStatus: ok ? "ok" : "error", lastError: ok ? "" : message },
  );
  return { ok, message, stillFailing, testedAt: testedAt.toISOString() };
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
    await client.put(Buffer.from("genosyn backup destination test\n"), probe);
    await client.delete(probe, true);
  } finally {
    await safeEnd(client);
  }
}

/**
 * Copy a completed archive to every enabled destination, one at a time, or to
 * the ones `options.destinationIds` names. Best-effort: a failure to reach one
 * destination is recorded on that row and returned in the result list, but
 * never throws — the local backup already succeeded. With an off-box
 * `retention` policy, each destination drops the archives the policy has
 * expired there: all but the newest before the copy, to make room for it, and
 * that one once the copy arrives. Given a `backupId`, each copy's progress is
 * recorded against that backup, so History can say where it is.
 */
export async function deliverBackupToDestinations(
  filename: string,
  absPath: string,
  retention: OffBoxRetention | null = null,
  options: DeliveryOptions = {},
): Promise<DeliveryResult[]> {
  const repo = AppDataSource.getRepository(BackupDestination);
  const backupId = options.backupId ?? null;
  deliveriesRunning += 1;
  try {
    const queued = options.destinationIds
      ? await repo.find({ where: { id: In(options.destinationIds) }, order: { createdAt: "ASC" } })
      : await repo.find({ where: { enabled: true }, order: { createdAt: "ASC" } });
    if (backupId) {
      await recordCopy("queue", () =>
        markCopiesPending(
          backupId,
          queued.map((row) => row.id),
        ),
      );
    }
    const results: DeliveryResult[] = [];
    for (const { id } of queued) {
      // Read again when its turn comes: the copy before may have taken hours,
      // and a destination removed — or, unless it was asked for by name,
      // paused — in the meantime is not copied to. Fresh credentials are used.
      const row = await repo.findOneBy({ id });
      if (!row || (!row.enabled && !options.includePaused)) {
        if (backupId) await recordCopy("skip", () => unqueueCopy(backupId, id));
        continue;
      }
      destinationsBeingCopied.add(id);
      try {
        if (backupId) await recordCopy("start", () => markCopyStarted(backupId, id));
        const result = await deliverOne(row, filename, absPath, retention);
        if (backupId) {
          await recordCopy("finish", () =>
            result.ok
              ? markCopyCopied(backupId, id)
              : markCopyFailed(backupId, id, result.error ?? ""),
          );
        }
        results.push(result);
      } finally {
        destinationsBeingCopied.delete(id);
      }
    }
    return results;
  } finally {
    deliveriesRunning -= 1;
  }
}

/**
 * Bookkeeping for History, best-effort like the rest of a delivery's: a copy
 * that arrived must not be reported as failed because its row would not save.
 */
async function recordCopy(step: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[backups] could not record a copy (${step}):`, (err as Error)?.message ?? err);
  }
}

/**
 * One delivery, recorded on the row whatever happens. Every attempt is
 * stamped, so a destination that keeps failing the same way still shows when
 * it last tried; the first failure of a run starts {@link
 * BackupDestination.failingSince}, and master admins are emailed when one
 * begins, daily while it lasts, and once more when a copy gets through again.
 */
async function deliverOne(
  row: BackupDestination,
  filename: string,
  absPath: string,
  retention: OffBoxRetention | null,
): Promise<DeliveryResult> {
  const cfg = decodeConfig(row);
  const attemptedAt = new Date();
  try {
    if (destinationGateForTests) await destinationGateForTests(row);
    if (!cfg) {
      throw new Error(
        "Its saved settings can't be read (was the encryption key changed?). Edit it and enter its password again.",
      );
    }
    if (!fs.existsSync(absPath)) {
      throw new Error("This backup is no longer on this server, so there was nothing to copy.");
    }
    await makeRoom(row, cfg, filename, absPath, retention);
    if (row.kind === "local") {
      await copyLocal(cfg as LocalConfig, filename, absPath);
    } else if (row.kind === "smb") {
      await copySmb(cfg as SmbConfig, filename, absPath);
    } else {
      await copySftp(cfg as SftpConfig, filename, absPath);
    }
  } catch (err) {
    const message = ((err as Error)?.message ?? String(err)).trim() || "The copy failed";
    row.lastStatus = "error";
    row.lastError = message;
    row.lastAttemptAt = attemptedAt;
    row.failingSince = row.failingSince ?? attemptedAt;
    const alert = alertDue(row.lastAlertedAt, attemptedAt);
    if (alert) row.lastAlertedAt = attemptedAt;
    await saveDeliveryState(row);
    // eslint-disable-next-line no-console
    console.error(`[backups] delivery to "${row.name}" failed:`, message);
    if (alert) await alertDeliveryFailed(row, filename);
    return { destinationId: row.id, destinationName: row.name, ok: false, error: message };
  }
  const failedFor = row.failingSince;
  const adminsWereTold = row.lastAlertedAt !== null;
  row.lastStatus = "ok";
  row.lastError = "";
  row.lastSyncedAt = new Date();
  row.lastAttemptAt = attemptedAt;
  row.failingSince = null;
  row.lastAlertedAt = null;
  await saveDeliveryState(row);
  if (failedFor && adminsWereTold) await alertDeliveryRecovered(row, failedFor);
  if (retention) await applyOffBoxRetention(row, cfg, filename, retention);
  return { destinationId: row.id, destinationName: row.name, ok: true };
}

/**
 * Only the columns a delivery owns. The row was read before a copy that can
 * run for hours: saving all of it would undo a pause, a rename or new
 * credentials saved meanwhile — and an update, unlike a save, can never bring
 * back a destination removed in the meantime.
 */
async function saveDeliveryState(dest: BackupDestination): Promise<void> {
  await AppDataSource.getRepository(BackupDestination).update(
    { id: dest.id },
    {
      lastStatus: dest.lastStatus,
      lastError: dest.lastError,
      lastSyncedAt: dest.lastSyncedAt,
      lastAttemptAt: dest.lastAttemptAt,
      failingSince: dest.failingSince,
      lastAlertedAt: dest.lastAlertedAt,
    },
  );
}

/**
 * Before a copy: delete what the off-box policy has expired on the destination
 * — all but the newest of it, which waits for the copy ({@link
 * expiredBeforeCopy}) — then refuse a copy there is no room for. Such a copy
 * used to run for an hour, fill the destination to the last byte and fail,
 * every day. Looking is best-effort: a destination that can't be listed, or
 * doesn't say how much room it has, is copied to regardless.
 */
async function makeRoom(
  row: BackupDestination,
  cfg: DestConfig,
  filename: string,
  absPath: string,
  retention: OffBoxRetention | null,
): Promise<void> {
  let contents = await inspectQuietly(row, cfg);
  if (contents && retention) {
    const expired = expiredBeforeCopy(
      contents.archives.map((archive) => archive.name),
      retentionCutoff(retention),
      filename,
    );
    if (expired.length > 0) {
      await removeExpired(row, cfg, expired, retention);
      contents = await inspectQuietly(row, cfg);
    }
  }
  if (contents?.freeBytes == null) return;
  const size = (await fs.promises.stat(absPath)).size;
  // A copy of this backup cut short is written over in place, so its room is the copy's too.
  const partial = contents.archives.find((archive) => archive.name === filename + PARTIAL_SUFFIX);
  if (contents.freeBytes + (partial?.size ?? 0) >= size) return;
  const free = formatBytes(contents.freeBytes);
  throw new Error(
    `${row.name} has ${free} free, but this backup is ${formatBytes(size)}. ` +
      (retention
        ? "Free up space there, or keep fewer days off-box. If it has a recycle bin, empty it: the backups Genosyn deletes stay in it until then."
        : "Free up space there, or turn on off-box retention under Advanced."),
  );
}

/** {@link inspectDestination}, logging rather than throwing when the destination can't be listed. */
async function inspectQuietly(
  row: BackupDestination,
  cfg: DestConfig,
): Promise<DestinationContents | null> {
  try {
    return await inspectDestination(row.kind, cfg);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[backups] could not look inside "${row.name}":`,
      (err as Error).message ?? String(err),
    );
    return null;
  }
}

function retentionCutoff(retention: OffBoxRetention): Date {
  return new Date(Date.now() - retention.days * 24 * 60 * 60 * 1000);
}

/**
 * Delete what the off-box policy has expired on a destination that just took a
 * copy. Best-effort and logged: the archive is safely delivered, and a folder
 * left a little fuller is retried at the next delivery.
 */
async function applyOffBoxRetention(
  row: BackupDestination,
  cfg: DestConfig | null,
  keep: string,
  retention: OffBoxRetention,
): Promise<void> {
  if (!cfg) return;
  const contents = await inspectQuietly(row, cfg);
  if (!contents) return;
  const names = contents.archives.map((archive) => archive.name);
  await removeExpired(row, cfg, expiredArchives(names, retentionCutoff(retention), keep), retention);
}

/** Delete `expired` from a destination and record each backup's copy there as removed. Best-effort and logged. */
async function removeExpired(
  row: BackupDestination,
  cfg: DestConfig,
  expired: string[],
  retention: OffBoxRetention,
): Promise<void> {
  if (expired.length === 0) return;
  try {
    await deleteArchives(row.kind, cfg, expired);
    await markCopiesRemoved(
      row.id,
      expired.filter((name) => !name.endsWith(PARTIAL_SUFFIX)),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[backups] retention removed ${expired.length} archive(s) older than ${retention.days} day(s) from "${row.name}"`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[backups] retention on "${row.name}" failed:`,
      (err as Error).message ?? String(err),
    );
  }
}

/** An archive on a destination, and its size in bytes. */
export type DestinationArchive = { name: string; size: number };

/**
 * What a destination holds: the archives Genosyn wrote there, partial copies
 * included, and the bytes still free there — null when it doesn't say, as an
 * SFTP server without OpenSSH's `statvfs` extension doesn't.
 */
type DestinationContents = { archives: DestinationArchive[]; freeBytes: number | null };

/** The archives Genosyn wrote to a destination, partial copies included, for daily verification. */
export async function listDestinationArchives(
  row: BackupDestination,
): Promise<DestinationArchive[]> {
  const cfg = decodeConfig(row);
  if (!cfg) throw new Error("Stored configuration could not be decrypted");
  return (await inspectDestination(row.kind, cfg)).archives;
}

/**
 * The archives Genosyn wrote to a destination, and the room left there. A
 * folder that doesn't exist yet holds none, and its room is unknown: it is
 * created by the first delivery.
 */
async function inspectDestination(
  kind: BackupDestinationKind,
  cfg: DestConfig,
): Promise<DestinationContents> {
  if (kind === "local") {
    const dir = (cfg as LocalConfig).path?.trim();
    if (!dir) throw new Error("No path configured");
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { archives: [], freeBytes: null };
      throw err;
    }
    const archives: DestinationArchive[] = [];
    for (const name of names.filter((n) => ARCHIVE_NAME.test(n))) {
      archives.push({ name, size: (await fs.promises.stat(path.join(dir, name))).size });
    }
    return { archives, freeBytes: await localFreeBytes(dir) };
  }
  if (kind === "smb") return inspectSmb(cfg as SmbConfig);
  const sftp = cfg as SftpConfig;
  const client = new SftpClient();
  try {
    const session = await client.connect(sftpConnectOptions(sftp));
    if (!(await client.exists(sftp.remoteDir))) return { archives: [], freeBytes: null };
    const entries = await client.list(sftp.remoteDir);
    return {
      archives: entries
        .filter((entry) => ARCHIVE_NAME.test(entry.name))
        .map((entry) => ({ name: entry.name, size: entry.size })),
      freeBytes: await sftpFreeBytes(session, sftp.remoteDir),
    };
  } finally {
    await safeEnd(client);
  }
}

/** The bytes free in a folder on this server; null when its filesystem won't say, as some FUSE mounts don't. */
async function localFreeBytes(dir: string): Promise<number | null> {
  try {
    const disk = await fs.promises.statfs(dir);
    return disk.bavail * disk.bsize;
  } catch {
    return null;
  }
}

/** The session `connect()` resolves with: ssh2's own SFTP client, extensions and all. */
type SftpSession = Awaited<ReturnType<SftpClient["connect"]>>;

/** The bytes free in `dir` on an SFTP server, through OpenSSH's `statvfs` extension; null without it. */
function sftpFreeBytes(session: SftpSession, dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      session.ext_openssh_statvfs(dir, (err, disk) => {
        const free = err ? NaN : Number(disk?.f_bavail) * Number(disk?.f_frsize);
        resolve(Number.isFinite(free) ? free : null);
      });
    } catch {
      // The server doesn't offer the extension.
      resolve(null);
    }
  });
}

/** Delete archives by name; each was matched against {@link ARCHIVE_NAME}. */
async function deleteArchives(
  kind: BackupDestinationKind,
  cfg: DestConfig,
  names: string[],
): Promise<void> {
  const archives = names.filter((name) => ARCHIVE_NAME.test(name));
  if (archives.length === 0) return;
  if (kind === "local") {
    const dir = (cfg as LocalConfig).path.trim();
    for (const name of archives) await fs.promises.rm(path.join(dir, name), { force: true });
    return;
  }
  if (kind === "smb") {
    const smb = cfg as SmbConfig;
    const segments = smbDirSegments(smb.remoteDir);
    for (let i = 0; i < archives.length; i += SMB_DELETE_BATCH) {
      await runSmbClient(
        smb,
        archives
          .slice(i, i + SMB_DELETE_BATCH)
          .map((name) => `del "${smbRemotePath(segments, name)}"`),
        SMB_HOUSEKEEPING_TIMEOUT_MS,
        // Only the batch's last `del` sets the exit status; one already gone is no failure.
        { tolerate: ["NT_STATUS_NO_SUCH_FILE"] },
      );
    }
    return;
  }
  const sftp = cfg as SftpConfig;
  const client = new SftpClient();
  try {
    await client.connect(sftpConnectOptions(sftp));
    for (const name of archives) await client.delete(joinRemote(sftp.remoteDir, name), true);
  } finally {
    await safeEnd(client);
  }
}

async function copyLocal(cfg: LocalConfig, filename: string, absPath: string): Promise<void> {
  const dir = cfg.path?.trim();
  if (!dir) throw new Error("No path configured");
  await fs.promises.mkdir(dir, { recursive: true });
  const destination = path.join(dir, filename);
  const partial = destination + PARTIAL_SUFFIX;
  try {
    await fs.promises.copyFile(absPath, partial);
    await fs.promises.chmod(partial, 0o600);
    await fs.promises.rename(partial, destination);
  } catch (err) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function copySftp(cfg: SftpConfig, filename: string, absPath: string): Promise<void> {
  const destination = joinRemote(cfg.remoteDir, filename);
  const partial = destination + PARTIAL_SUFFIX;
  const client = new SftpClient();
  try {
    await client.connect(sftpConnectOptions(cfg));
    await client.mkdir(cfg.remoteDir, true);
    try {
      await client.fastPut(absPath, partial);
      // SFTP's rename refuses to replace, which a re-sent archive would need.
      if (await client.exists(destination)) await client.delete(destination);
      await client.rename(partial, destination);
    } catch (err) {
      await client.delete(partial, true).catch(() => undefined);
      throw err;
    }
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
    // A link that dies mid-copy sends no error: without these, the copy — and
    // the backup run waiting on it — would hang for good. Any answer resets the
    // count, so only a server silent for two minutes is given up on.
    keepaliveInterval: SFTP_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SFTP_KEEPALIVE_COUNT_MAX,
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
  return dir
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
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
 *
 * Resolves with smbclient's stdout. `tolerate` names NT statuses that are an
 * answer rather than a failure — `ls` on a pattern that matches nothing exits
 * non-zero with NT_STATUS_NO_SUCH_FILE — and `timeoutMessage` says what a
 * kill at `timeout` means for this particular command.
 */
async function runSmbClient(
  cfg: SmbConfig,
  commands: string[],
  timeout: number,
  options: { tolerate?: string[]; timeoutMessage?: string } = {},
): Promise<string> {
  if (!cfg.host.trim()) throw new Error("No host configured");
  assertSafeSmbSegment(cfg.share, "Share");

  return withSmbAuthFile(cfg, async (authFile) => {
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
      const { stdout } = await execFileAsync("smbclient", args, {
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean };
      if (options.tolerate && !e.killed) {
        const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
        if (options.tolerate.some((status) => output.includes(status))) return e.stdout ?? "";
      }
      throw new Error(smbErrorMessage(err, cfg, options.timeoutMessage));
    }
  });
}

/**
 * Turn an execFile rejection into something an operator can act on. smbclient
 * reports protocol errors on *stdout* and exits 1, so the useful text isn't
 * where you'd expect it.
 */
export function smbErrorMessage(
  err: unknown,
  cfg: Pick<SmbConfig, "host" | "share" | "encrypt">,
  timeoutMessage?: string,
): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
  if (e?.code === "ENOENT") {
    return "smbclient is not installed in this image — SMB destinations need the samba-client package";
  }
  if (e?.killed) return timeoutMessage ?? "Timed out talking to the SMB server";

  const output = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`;
  // A copy that fails says why on stderr — `cli_push returned
  // NT_STATUS_DISK_FULL` — and the close smbclient still attempts afterwards
  // fails too, on stdout and so earlier in the output: `NT_STATUS_INVALID_
  // NETWORK_RESPONSE closing remote file …`. The push's status is the reason;
  // reading the close's instead reported every full share as a dropped link.
  const pushStatus = /cli_push returned (NT_STATUS_[A-Z_]+)/.exec(output)?.[1];
  // The mkdir chain re-creates existing directories on every delivery, so a
  // collision is expected noise on stdout — never the reason we failed. It's
  // also the *first* status in the output, so scanning naively would report it
  // in place of the real error further down.
  const status =
    pushStatus ??
    (output.match(/NT_STATUS_[A-Z_]+/g) ?? []).find((s) => s !== "NT_STATUS_OBJECT_NAME_COLLISION");
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
    case "NT_STATUS_DISK_FULL":
    case "NT_STATUS_QUOTA_EXCEEDED":
      return `The share on ${cfg.host} is full — free some space there, or turn on off-box retention`;
    default:
      break;
  }
  // A copy already under way when the link went: the session itself was fine,
  // so this is no reason to suspect encryption, as the next branch would.
  if (/cli_push returned|closing remote file/.test(output)) {
    return `The connection to ${cfg.host} dropped part-way through the copy`;
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
  return segments.map((_seg, i) => `mkdir "${segments.slice(0, i + 1).join("/")}"`);
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
      [...smbMkdirChain(segments), `put "${localProbe}" "${probe}"`, `del "${probe}"`],
      SMB_PROBE_TIMEOUT_MS,
    );
  } finally {
    await fs.promises.rm(local, { recursive: true, force: true });
  }
}

/**
 * Two smbclient runs, because smbclient carries on past a failed command and
 * reports only the last one's status: renaming in the same run as the `put`
 * would promote a copy that broke off half-way. `rename -f` replaces an
 * archive that is already there, for one sent a second time.
 */
async function copySmb(cfg: SmbConfig, filename: string, absPath: string): Promise<void> {
  assertSafeSmbSegment(filename, "Backup filename");
  const segments = smbDirSegments(cfg.remoteDir);
  const destination = smbRemotePath(segments, filename);
  const partial = destination + PARTIAL_SUFFIX;
  const timeout = smbDeliverTimeoutMs(fs.statSync(absPath).size);
  const hours = Math.round((timeout / 3_600_000) * 10) / 10;
  try {
    await runSmbClient(
      cfg,
      [...smbMkdirChain(segments), `put "${absPath}" "${partial}"`],
      timeout,
      {
        timeoutMessage: `The copy to ${cfg.host} didn't finish within ${hours} hours — the link moved under 2 MB/s`,
      },
    );
  } catch (err) {
    // Don't leave gigabytes of a copy that will never finish on the share.
    await runSmbClient(cfg, [`del "${partial}"`], SMB_PROBE_TIMEOUT_MS).catch(() => undefined);
    throw err;
  }
  await runSmbClient(
    cfg,
    [`rename "${partial}" "${destination}" -f`],
    SMB_HOUSEKEEPING_TIMEOUT_MS,
  );
}

/**
 * One entry of an smbclient `ls` listing: the name, its attribute letters, its
 * size, then its date. Archive names hold no spaces; anchoring on the size
 * keeps a name that does — `backup-….zip copy.zip` — from passing for the
 * archive it starts with.
 */
const SMB_LISTING_ENTRY = /^\s*(\S+)\s+[A-Za-z]*\s+(\d+)\s/;

/** The archives, and their sizes, in an smbclient `ls` listing. */
export function parseSmbListing(stdout: string): DestinationArchive[] {
  const archives: DestinationArchive[] = [];
  for (const line of stdout.split("\n")) {
    const match = SMB_LISTING_ENTRY.exec(line);
    if (match && ARCHIVE_NAME.test(match[1])) {
      archives.push({ name: match[1], size: Number(match[2]) });
    }
  }
  return archives;
}

/**
 * The line an smbclient listing ends with, saying how much room the share has
 * left for this account: `3839458616 blocks of size 1024. 27552564 blocks
 * available`.
 */
const SMB_DISK_LINE = /(\d+) blocks of size (\d+)\. (\d+) blocks available/;

/**
 * The bytes free on the share, from an smbclient listing; null when it has no
 * such line — a folder no delivery has created yet lists nothing — or the
 * share reports no size at all, which is no answer.
 */
export function parseSmbFreeBytes(stdout: string): number | null {
  const match = SMB_DISK_LINE.exec(stdout);
  if (!match) return null;
  const [total, blockSize, available] = match.slice(1).map(Number);
  if (!(total > 0) || !(blockSize > 0)) return null;
  return available * blockSize;
}

/**
 * Everything in the folder is listed, not only archives: smbclient prints the
 * room left only after a listing that matched something, and `.` always does.
 */
async function inspectSmb(cfg: SmbConfig): Promise<DestinationContents> {
  const segments = smbDirSegments(cfg.remoteDir);
  const stdout = await runSmbClient(
    cfg,
    [`ls "${smbRemotePath(segments, "*")}"`],
    SMB_HOUSEKEEPING_TIMEOUT_MS,
    // A folder no delivery has created yet: no archives.
    { tolerate: ["NT_STATUS_NO_SUCH_FILE", "NT_STATUS_OBJECT_PATH_NOT_FOUND", "NT_STATUS_OBJECT_NAME_NOT_FOUND"] },
  );
  return { archives: parseSmbListing(stdout), freeBytes: parseSmbFreeBytes(stdout) };
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
    lastAttemptAt: row.lastAttemptAt,
    failingSince: row.failingSince,
    lastAlertedAt: row.lastAlertedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
