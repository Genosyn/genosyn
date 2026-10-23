import path from "node:path";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import type archiver from "archiver";
import * as archiverRuntime from "archiver";
import unzipper from "unzipper";
import cron, { ScheduledTask } from "node-cron";
import { AppDataSource, optimizeSqliteStatistics } from "../db/datasource.js";
import { bootMailSearchIndex, stopMailSearchIndex } from "./mail/searchIndex.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupSchedule, BackupFrequency } from "../db/entities/BackupSchedule.js";
import { config } from "../../config.js";
import { dataRoot } from "./paths.js";
import { bootCron, resetSchedulesAfterRestore, stopCron } from "./cron.js";
import {
  claimBackupCopy,
  deliverBackupToDestinations,
  isBackupBeingCopied,
  isDeliveryRunning,
  OffBoxRetention,
  releaseBackupCopy,
} from "./backupDestinations.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import type { BackupCopy } from "../db/entities/BackupCopy.js";
import {
  copiesByBackup,
  deleteCopiesOfBackups,
  failCopiesInFlight,
  markCopiesPending,
  recoverInterruptedCopies,
  serializeCopy,
} from "./backupCopies.js";
import { BackupError } from "./backupErrors.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { bootDurableChatTurnRecovery, stopDurableChatTurnRecovery } from "./durableChatTurns.js";
import { finalizeInterruptedAskAiTurns } from "./askAi/assistant.js";
import { finalizeInterruptedTldrQuestionTurns } from "./tldrQuestions.js";
import {
  bootContextWindowRefresh,
  stopContextWindowRefresh,
} from "./agent/contextWindowRefresh.js";
import { bootBankingSync, stopBankingSync } from "./bankingSync.js";
import {
  INSTANCE_SECRETS_FILENAME,
  INSTANCE_SECRETS_SENTINEL_FILENAME,
  reloadEffectiveInstanceSecrets,
  restoreManagedInstanceSecretsIfMissing,
  snapshotManagedInstanceSecrets,
} from "../lib/instanceSecrets.js";
import { bindInstanceSecretsToDatabase } from "./instanceSecretsDatabase.js";

/**
 * Install-wide backup service. Each backup zips `<dataDir>` (excluding the
 * `Backup/` folder itself and any staging artifact) into
 * `<dataDir>/Backup/backup-YYYY-MM-DD-HHMMSS.zip`. The SQLite file is first
 * snapshotted with SQLite's online backup API so the archive captures a
 * consistent view even while the app is writing.
 *
 * A singleton {@link BackupSchedule} row drives the optional recurring cron.
 * The schedule is modelled as frequency + hour (and day-of-week / day-of-
 * month where applicable) rather than a raw cron expression so the settings
 * UI stays approachable. The same row carries the retention policy — see
 * {@link pruneOldBackups}.
 */

const SCHEDULE_ID = "default";
const BACKUP_DIR_NAME = "Backup";
const ZipArchive = (
  archiverRuntime as unknown as {
    ZipArchive: new (options?: archiver.ArchiverOptions) => archiver.Archiver;
  }
).ZipArchive;

/**
 * Suffix for an archive still being written. Deliberately not `.zip` so
 * {@link reconcileBackupHistory} can't adopt a half-written file as a backup.
 */
const PART_SUFFIX = ".part";

/**
 * Prefix for the SQLite snapshot a run stages before zipping it.
 * Hidden, and deliberately distinct from {@link PART_SUFFIX}, so
 * {@link sweepOrphanedStagingArtifacts} can tell a stranded snapshot from a
 * half-written archive without consulting the `backups` table.
 */
const STAGING_PREFIX = ".staging-";

/**
 * Sidecars SQLite can leave beside a database file. Writing the snapshot
 * leaves a rollback journal next to its destination, and the cleanup used to
 * unlink only the `.sqlite` itself — so every single run, successful or not,
 * left a `.staging-<id>.sqlite-journal` behind for good.
 */
const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

/**
 * How long a snapshot waits on a change to the database that has not finished.
 * SQLite will not copy pages from the connection while it is part-way through
 * a write, and a healthy install finishes one in well under a second.
 */
const SNAPSHOT_BUSY_LIMIT_MS = 2 * 60_000;
const SNAPSHOT_RETRY_MS = 1_000;
let snapshotBusyLimitMs = SNAPSHOT_BUSY_LIMIT_MS;

/** Shorten the snapshot's wait so a test can reach the give-up path; null restores it. */
export function setSnapshotBusyLimitForTests(ms: number | null): void {
  snapshotBusyLimitMs = ms ?? SNAPSHOT_BUSY_LIMIT_MS;
}

/**
 * How long writing an archive may go without writing a byte or reaching a new
 * file before it is treated as stuck. Compressing even a 50 GB database emits
 * output every few megabytes, so half an hour of nothing is a hung disk or
 * mount, not a big backup.
 */
const WRITE_STALL_LIMIT_MS = 30 * 60_000;
let writeStallLimitMs = WRITE_STALL_LIMIT_MS;

/** Shorten the write watchdog so a test can reach it; null restores it. */
export function setWriteStallLimitForTests(ms: number | null): void {
  writeStallLimitMs = ms ?? WRITE_STALL_LIMIT_MS;
}

function writeStallMessage(): string {
  const minutes = Math.max(1, Math.round(writeStallLimitMs / 60_000));
  return (
    `Writing the backup made no progress for ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
    "so it was stopped. A disk, or a mount inside the data directory, may be stuck."
  );
}

/**
 * Call `onStall` once `read()` — a count of work done — has not moved for
 * `limitMs`. Looks a few times per limit; returns a function that stops it.
 */
export function watchForStall(
  read: () => number,
  limitMs: number,
  onStall: () => void,
): () => void {
  let last = read();
  let movedAt = Date.now();
  const timer = setInterval(
    () => {
      const current = read();
      if (current !== last) {
        last = current;
        movedAt = Date.now();
        return;
      }
      if (Date.now() - movedAt >= limitMs) {
        clearInterval(timer);
        onStall();
      }
    },
    Math.max(5, Math.min(60_000, Math.floor(limitMs / 4))),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Hourly rather than daily so a window that lapses at 14:05 isn't enforced at
 * 03:00 the next morning. The prune is a cheap no-op when nothing is past the
 * cutoff.
 */
const RETENTION_CRON = "0 * * * *";

/** Stable node-cron names — without one, node-cron keys each task by a fresh
 *  uuid in a module-global map that `stop()` never clears, so every re-register
 *  would leak an entry. */
const SCHEDULE_TASK_NAME = "backup-schedule";
const RETENTION_TASK_NAME = "backup-retention";

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

let scheduledTask: ScheduledTask | null = null;
let retentionTask: ScheduledTask | null = null;

/**
 * The backup this process is taking. `recorded` settles as soon as its row is
 * saved (or with the error that stopped it first); `done` once the archive is
 * written and copied off-box. Serializes runs: asking for a backup while one
 * is under way joins it.
 */
type BackupRun = { recorded: Promise<Backup>; done: Promise<Backup> };
let runningBackup: BackupRun | null = null;
/** The row of {@link runningBackup}, once it has one. */
let runningBackupId: string | null = null;
let runningPrune: Promise<number> | null = null;

/**
 * Staging paths owned by a run that is still in flight. {@link
 * sweepOrphanedStagingArtifacts} consults this so it can never unlink the
 * snapshot a live backup is part-way through zipping — the sweep runs from
 * boot reconcile and from the start of each run, either of which could in
 * principle overlap one.
 *
 * In-process is enough to be authoritative here: staging snapshots only exist
 * under the SQLite driver ({@link snapshotSqlite} is a no-op otherwise), and
 * that is the single-process self-hosted install. A Postgres deployment never
 * stages one to begin with.
 */
const activeStagingPaths = new Set<string>();

/**
 * True from the moment a restore is accepted until it finishes. Shared with
 * {@link pruneOldBackups}: a restore resolves its archive on disk and then
 * wipes `dataDir` around it, so nothing may delete archives underneath it.
 */
let restoreInProgress = false;

/** Whether a restore is replacing the data directory right now. */
export function isRestoreInProgress(): boolean {
  return restoreInProgress;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function timestampSuffix(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate(),
  )}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function backupDir(): string {
  return path.join(dataRoot(), BACKUP_DIR_NAME);
}

export function backupFilePath(filename: string): string {
  return path.join(backupDir(), filename);
}

function ensureBackupDir(): void {
  fs.mkdirSync(backupDir(), { recursive: true });
  fs.chmodSync(backupDir(), 0o700);
}

/**
 * Map a staging entry back to the snapshot path that owns it, so a sidecar and
 * the `.sqlite` it belongs to answer {@link activeStagingPaths} identically.
 */
function stagingOwnerPath(abs: string): string {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (abs.endsWith(suffix)) return abs.slice(0, -suffix.length);
  }
  return abs;
}

/**
 * Unlink a staging snapshot together with every sidecar SQLite may have put
 * beside it. Best-effort: this runs on the success path of a backup that has
 * already been recorded, so a file that won't unlink must not fail the run.
 */
function removeStagingArtifact(stagingPath: string): void {
  const paths = [stagingPath, ...SQLITE_SIDECAR_SUFFIXES.map((s) => `${stagingPath}${s}`)];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

/**
 * Delete staging snapshots that no live run owns.
 *
 * `runBackupInner` unlinks its own snapshot in a `finally`, but that block
 * never executes if the process dies between the snapshot and the end of the
 * run — a SIGKILL from a container restart or the OOM killer, which is exactly
 * what a backup of a large database invites. Each stranded snapshot is a full
 * copy of the database, so they dwarf the archives they were staged for and
 * accumulate silently until the volume fills.
 *
 * Called from {@link reconcileBackupHistory} (so a restart clears the debris)
 * and at the top of each run (so an install that never restarts still recovers
 * the space, at the one moment it is about to need it).
 *
 * Returns how many files were removed.
 */
export function sweepOrphanedStagingArtifacts(): number {
  const dir = backupDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    const abs = path.join(dir, entry);
    if (activeStagingPaths.has(stagingOwnerPath(abs))) continue;
    try {
      const size = fs.statSync(abs).size;
      fs.unlinkSync(abs);
      removed += 1;
      bytes += size;
    } catch {
      // best-effort — a snapshot we can't unlink is retried on the next sweep
    }
  }

  if (removed > 0) {
    const mb = Math.round(bytes / (1024 * 1024));
    // eslint-disable-next-line no-console
    console.log(`[backups] swept ${removed} orphaned staging file(s), reclaiming ~${mb} MB`);
  }
  return removed;
}

/**
 * Translate a schedule row into a node-cron expression. Seconds-level
 * precision isn't needed — we pin to minute 0 so all backup runs line up on
 * the hour.
 */
export function cronExprForSchedule(sched: BackupSchedule): string {
  const hour = clamp(sched.hour, 0, 23);
  switch (sched.frequency) {
    case "weekly": {
      const dow = clamp(sched.dayOfWeek, 0, 6);
      return `0 ${hour} * * ${dow}`;
    }
    case "monthly": {
      const dom = clamp(sched.dayOfMonth, 1, 28);
      return `0 ${hour} ${dom} * *`;
    }
    case "daily":
    default:
      return `0 ${hour} * * *`;
  }
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

export async function getBackupSchedule(): Promise<BackupSchedule> {
  const repo = AppDataSource.getRepository(BackupSchedule);
  let row = await repo.findOneBy({ id: SCHEDULE_ID });
  if (!row) {
    row = repo.create({
      id: SCHEDULE_ID,
      enabled: false,
      frequency: "daily",
      hour: 3,
      dayOfWeek: 0,
      dayOfMonth: 1,
      lastRunAt: null,
      retentionEnabled: false,
      retentionDays: 30,
      offBoxRetentionEnabled: false,
      offBoxRetentionDays: 30,
    });
    await repo.save(row);
  }
  return row;
}

/** The off-box policy deliveries apply, or null when it is off. */
async function offBoxRetention(): Promise<OffBoxRetention | null> {
  const sched = await getBackupSchedule();
  return sched.offBoxRetentionEnabled ? { days: sched.offBoxRetentionDays } : null;
}

/**
 * Persist a schedule/retention change and re-register both crons against it.
 * On-box retention is enforced immediately rather than at the next hourly
 * tick, so saving the form has a visible effect — the returned count is what
 * the UI reports back to the operator. The off-box policy waits for the next
 * delivery to each destination: that is the one moment a fresh, complete copy
 * is known to be there, so pruning can never leave a destination empty.
 */
export async function updateBackupSchedule(patch: {
  enabled?: boolean;
  frequency?: BackupFrequency;
  hour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  retentionEnabled?: boolean;
  retentionDays?: number;
  offBoxRetentionEnabled?: boolean;
  offBoxRetentionDays?: number;
}): Promise<{ schedule: BackupSchedule; pruned: number }> {
  const repo = AppDataSource.getRepository(BackupSchedule);
  const current = await getBackupSchedule();
  if (typeof patch.enabled === "boolean") current.enabled = patch.enabled;
  if (patch.frequency) current.frequency = patch.frequency;
  if (typeof patch.hour === "number") current.hour = clamp(patch.hour, 0, 23);
  if (typeof patch.dayOfWeek === "number") current.dayOfWeek = clamp(patch.dayOfWeek, 0, 6);
  if (typeof patch.dayOfMonth === "number") current.dayOfMonth = clamp(patch.dayOfMonth, 1, 28);
  if (typeof patch.retentionEnabled === "boolean")
    current.retentionEnabled = patch.retentionEnabled;
  if (typeof patch.retentionDays === "number")
    current.retentionDays = clamp(patch.retentionDays, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
  if (typeof patch.offBoxRetentionEnabled === "boolean")
    current.offBoxRetentionEnabled = patch.offBoxRetentionEnabled;
  if (typeof patch.offBoxRetentionDays === "number")
    current.offBoxRetentionDays = clamp(
      patch.offBoxRetentionDays,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS,
    );
  await repo.save(current);
  applyBackupSchedule(current);
  applyRetentionSchedule(current);
  // Best-effort, like every other prune trigger: the schedule is already saved
  // and both crons are already live, so a prune that fails here must not fail
  // the save and leave the UI reporting a policy the server isn't running.
  let pruned = 0;
  try {
    pruned = await pruneOldBackups();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[backups] retention on save failed:", err);
  }
  return { schedule: current, pruned };
}

/**
 * Register (or unregister) the cron task that fires a scheduled backup.
 * Called on boot and after any schedule mutation.
 */
export function applyBackupSchedule(sched: BackupSchedule): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (!sched.enabled) return;
  const expr = cronExprForSchedule(sched);
  if (!cron.validate(expr)) {
    // eslint-disable-next-line no-console
    console.warn(`[backups] invalid cron for schedule: ${expr}`);
    return;
  }
  scheduledTask = cron.schedule(
    expr,
    () => {
      withSchedulerLease("backup-scheduled", 6 * 60 * 60_000, () => runBackup("scheduled")).catch(
        (err) => {
          // eslint-disable-next-line no-console
          console.error("[backups] scheduled run failed:", err);
        },
      );
    },
    { name: SCHEDULE_TASK_NAME },
  );
}

/**
 * Register (or unregister) the hourly task that enforces retention. Mirrors
 * {@link applyBackupSchedule}; called on boot and after any schedule mutation.
 */
export function applyRetentionSchedule(sched: BackupSchedule): void {
  if (retentionTask) {
    retentionTask.stop();
    retentionTask = null;
  }
  if (!sched.retentionEnabled) return;
  retentionTask = cron.schedule(
    RETENTION_CRON,
    () => {
      withSchedulerLease("backup-retention", 60 * 60_000, () => pruneOldBackups()).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[backups] retention run failed:", err);
      });
    },
    { name: RETENTION_TASK_NAME },
  );
}

export async function bootBackups(): Promise<void> {
  // This archive format snapshots SQLite plus dataDir. It is not a valid
  // backup of a Postgres-backed shared SaaS deployment, whose database and
  // RWX volume must be protected by the hosting platform.
  if (config.security.multiTenant) return;
  ensureBackupDir();
  await withSchedulerLease("backup-boot", 30 * 60_000, async () => {
    await reconcileBackupHistory();
    // Copies the last process left waiting or part-way. Nothing resumes them,
    // and History must not show them as still on their way.
    const interrupted = await recoverInterruptedCopies();
    if (interrupted > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[backups] marked ${interrupted} interrupted off-box cop${interrupted === 1 ? "y" : "ies"} as failed`,
      );
    }
  });
  const sched = await getBackupSchedule();
  applyBackupSchedule(sched);
  applyRetentionSchedule(sched);
  await withSchedulerLease("backup-missed", 6 * 60 * 60_000, () => maybeRunMissedBackup(sched));
  // Catch up on anything that lapsed while the server was down. Not awaited —
  // index.ts awaits bootBackups() before listening, and unlinking a backlog of
  // large archives shouldn't hold up the port. Must follow the reconcile above,
  // which is what gives on-disk archives their rows.
  withSchedulerLease("backup-retention", 60 * 60_000, () => pruneOldBackups()).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backups] retention on boot failed:", err);
  });
}

/**
 * Delete archives older than the configured window. A no-op unless retention
 * is enabled. Returns how many archives were actually removed.
 *
 * Backups are the last line of defence, so the cutoff never decides alone:
 *
 *   - the newest archive on disk is always kept, however old, and so is the
 *     newest one that verifiably opens — so retention can never leave an
 *     install with nothing to restore from;
 *   - archives uploaded through Admin → Backups are never touched — an
 *     operator hand-carried those in and they may be the only copy;
 *   - an archive that can't be unlinked keeps its row, so History keeps
 *     matching the disk instead of the row reappearing on the next reconcile.
 *
 * Rows whose archive is already gone (the ghosts above) are reaped once past
 * the cutoff, which is the only thing that ever cleans them up.
 */
export async function pruneOldBackups(): Promise<number> {
  // Checked before the promise is memoized so a no-op prune can't make
  // restoreFromBackup's `runningPrune` guard fire spuriously.
  if (restoreInProgress) return 0;
  if (runningPrune) return runningPrune;
  runningPrune = pruneOldBackupsInner().finally(() => {
    runningPrune = null;
  });
  return runningPrune;
}

/**
 * Can this archive actually be restored from? `status === "completed"` is not
 * enough to answer that: {@link reconcileBackupHistory} promotes any `running`
 * row whose file exists to `completed`, so a zip left truncated by a crash
 * mid-write is indistinguishable from a good one at the row level — and the
 * `PK\x03\x04` header a partial write leaves behind would satisfy a signature
 * check too. Opening the archive reads its central directory, which only a
 * fully-written zip has. Cheap: a seek to the end, not a decompress.
 *
 * Under SQLite it must also hold the database. Restoring wipes `data/` before
 * it extracts, so an archive without `app.sqlite` — what a backup that could
 * not copy the database once wrote while recording itself as completed —
 * would start the install over empty.
 */
async function isRestorableArchive(filename: string): Promise<boolean> {
  return (await checkArchive(backupFilePath(filename))) === "restorable";
}

export type ArchiveCheck = "restorable" | "unreadable" | "no-database";

/** {@link isRestorableArchive} for a path that isn't (yet) a backup filename. */
export async function checkArchive(abs: string): Promise<ArchiveCheck> {
  if (!fs.existsSync(abs)) return "unreadable";
  let entries: Array<{ path: string; uncompressedSize: number }>;
  try {
    entries = await readArchiveDirectory(abs);
  } catch {
    return "unreadable";
  }
  const holdsDatabase = entries.some(
    (entry) => entry.path === "app.sqlite" && entry.uncompressedSize > 0,
  );
  if (config.db.driver === "sqlite" && !holdsDatabase) return "no-database";
  return "restorable";
}

/**
 * The entries an archive's central directory lists, read without leaving
 * anything open on the file.
 *
 * `unzipper.Open.file` reads through two streams that it neither listens to
 * for errors nor closes, and it can answer before the second has opened: an
 * archive that lists no files needs nothing from it. A caller that removed the
 * file next — {@link ingestUploadedArchive} turning an upload away — left that
 * open to fail by itself, and a stream error nobody listens for is an uncaught
 * exception, which stops the App. So every stream here has a listener, an
 * error fails the read instead, and each one is closed, its open settled,
 * before this returns.
 */
async function readArchiveDirectory(
  abs: string,
): Promise<Array<{ path: string; uncompressedSize: number }>> {
  const streams: fs.ReadStream[] = [];
  let failRead!: (err: unknown) => void;
  const streamFailed = new Promise<never>((_resolve, reject) => {
    failRead = reject;
  });
  // A stream that errors after the directory has been read changes nothing.
  streamFailed.catch(() => undefined);
  const source = {
    size: async () => (await fs.promises.stat(abs)).size,
    // The same byte range `Open.file` asks for.
    stream: (start: number, length?: number) => {
      const stream = fs.createReadStream(abs, { start, end: length ? start + length : undefined });
      stream.on("error", failRead);
      streams.push(stream);
      return stream;
    },
  };
  try {
    return (await Promise.race([unzipper.Open.custom(source), streamFailed])).files;
  } finally {
    await Promise.all(streams.map(closeStream));
  }
}

/** Close a stream and wait until it has — once an open still under way has finished. */
function closeStream(stream: fs.ReadStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}

async function pruneOldBackupsInner(): Promise<number> {
  const sched = await getBackupSchedule();
  if (!sched.retentionEnabled) return 0;

  const days = clamp(sched.retentionDays, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const repo = AppDataSource.getRepository(Backup);
  const rows = await repo.find({ order: { createdAt: "DESC" } });

  // Two archives are protected, and it takes both to be safe. `rows` is newest
  // first, so each is the first match.
  const keep = new Set<string>();

  // 1. The newest archive that is simply *there*. This is the fail-safe floor:
  //    existsSync can't be wrong for a transient reason, so an install always
  //    keeps its newest archive no matter what else goes sideways below.
  const newestOnDisk = rows.find(
    (r) => r.status === "completed" && fs.existsSync(backupFilePath(r.filename)),
  );
  if (newestOnDisk) keep.add(newestOnDisk.id);

  // 2. The newest archive that actually opens — which may be an older one, if
  //    the newest is a zip left truncated by a crash mid-write. Without this,
  //    that debris would hold the only slot and every real archive would age
  //    out from under it. Deliberately *additive* to the floor rather than a
  //    replacement for it: a failure to open can also mean a transient read
  //    error, and treating "can't verify" as "not restorable" would let one
  //    bad moment delete the entire history.
  for (const row of rows) {
    if (row.status !== "completed") continue;
    if (await isRestorableArchive(row.filename)) {
      keep.add(row.id);
      break;
    }
  }

  let deleted = 0;
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    if (row.kind === "uploaded") continue;
    // A `running` row is a backup in flight (its createdAt is now, so it can't
    // be past the cutoff anyway) or the debris of a crash that reconcile will
    // adopt on the next boot. Neither is ours to delete.
    if (row.status === "running") continue;
    // Being copied off-box right now: deleting the archive would break the
    // copy part-way. The next hourly prune gets it.
    if (isBackupBeingCopied(row.id)) continue;
    // createdAt, not completedAt: reconcile rewrites completedAt to restore
    // time, which would make every archive look freshly taken after a restore.
    if (row.createdAt.getTime() >= cutoff) continue;

    const abs = backupFilePath(row.filename);
    if (fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[backups] retention could not delete ${abs}:`, err);
        continue;
      }
    }
    await repo.delete({ id: row.id });
    // History's record of its off-box copies goes with it; the copies
    // themselves stay until off-box retention removes them there.
    await deleteCopiesOfBackups([row.id]);
    deleted += 1;
  }

  if (deleted > 0) {
    // eslint-disable-next-line no-console
    console.log(`[backups] retention removed ${deleted} archive(s) older than ${days} day(s)`);
  }
  return deleted;
}

/**
 * If the schedule was supposed to fire while the server was down, run a
 * catch-up backup now. Compares the most recent expected fire time against
 * `lastRunAt` (or `updatedAt` for a freshly-enabled schedule that has never
 * completed a run) so that toggling the schedule on doesn't immediately
 * trigger a backup, but a real missed run does.
 */
async function maybeRunMissedBackup(sched: BackupSchedule): Promise<void> {
  if (!sched.enabled) return;
  const now = new Date();
  const expected = previousScheduledFireTime(sched, now);
  const baseline = sched.lastRunAt ?? sched.updatedAt;
  if (!baseline || expected.getTime() <= baseline.getTime()) return;
  // eslint-disable-next-line no-console
  console.log(
    `[backups] missed scheduled run at ${expected.toISOString()}; running catch-up backup`,
  );
  runBackup("scheduled").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backups] catch-up run failed:", err);
  });
}

/**
 * Most recent moment the schedule should have fired at or before `now`.
 * Mirrors the cron expression from {@link cronExprForSchedule} but in JS
 * Date arithmetic so we don't need a cron-parser dependency.
 */
export function previousScheduledFireTime(sched: BackupSchedule, now: Date): Date {
  const hour = clamp(sched.hour, 0, 23);
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);

  switch (sched.frequency) {
    case "weekly": {
      const targetDow = clamp(sched.dayOfWeek, 0, 6);
      let daysBack = (candidate.getDay() - targetDow + 7) % 7;
      if (daysBack === 0 && candidate.getTime() > now.getTime()) {
        daysBack = 7;
      }
      candidate.setDate(candidate.getDate() - daysBack);
      return candidate;
    }
    case "monthly": {
      const targetDom = clamp(sched.dayOfMonth, 1, 28);
      candidate.setDate(targetDom);
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() > now.getTime()) {
        candidate.setMonth(candidate.getMonth() - 1);
      }
      return candidate;
    }
    case "daily":
    default: {
      if (candidate.getTime() > now.getTime()) {
        candidate.setDate(candidate.getDate() - 1);
      }
      return candidate;
    }
  }
}

/**
 * The first moment after `now` the schedule fires, in the server's local time
 * like the cron itself: one period after {@link previousScheduledFireTime}.
 * Calendar arithmetic, so the hour holds across a daylight-saving change.
 */
export function nextScheduledFireTime(sched: BackupSchedule, now: Date): Date {
  const next = previousScheduledFireTime(sched, now);
  switch (sched.frequency) {
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "daily":
    default:
      next.setDate(next.getDate() + 1);
      break;
  }
  next.setHours(clamp(sched.hour, 0, 23), 0, 0, 0);
  return next;
}

/**
 * Create a zip archive of the data directory and copy it off-box. Resolves
 * with the completed {@link Backup} row. Serialized via {@link runningBackup}
 * so two runs never overlap: asking while one is under way joins it.
 */
export async function runBackup(kind: "manual" | "scheduled"): Promise<Backup> {
  return beginBackup(kind).done;
}

/**
 * Start a backup without waiting for it, for Back up now. Resolves as soon as
 * its row is recorded: a 50 GB archive takes the better part of an hour to
 * write and hours more to reach a NAS, which no browser request — or the proxy
 * in front of one — waits for. A failure after that point is recorded on the
 * row, where History and the status summary show it. While a backup is already
 * under way, this is that backup, and `alreadyRunning` says so.
 */
export async function startBackup(
  kind: "manual" | "scheduled" = "manual",
): Promise<{ backup: Backup; alreadyRunning: boolean }> {
  const alreadyRunning = runningBackup !== null;
  const run = beginBackup(kind);
  run.done.catch(() => undefined);
  return { backup: await run.recorded, alreadyRunning };
}

/** Whether `backupId` is the backup this process is writing right now. */
export function isBackupInProgress(backupId: string): boolean {
  return runningBackupId === backupId;
}

/** Whether this process is taking a backup — writing it, or copying it off-box — right now. */
export function isBackupRunning(): boolean {
  return runningBackup !== null;
}

function beginBackup(kind: "manual" | "scheduled"): BackupRun {
  if (runningBackup) return runningBackup;
  let markRecorded!: (row: Backup) => void;
  let failedBeforeRecorded!: (err: unknown) => void;
  const recorded = new Promise<Backup>((resolve, reject) => {
    markRecorded = resolve;
    failedBeforeRecorded = reject;
  });
  // Nobody may be listening: a scheduled run only awaits `done`.
  recorded.catch(() => undefined);
  const done = runBackupInner(kind, (row) => {
    runningBackupId = row.id;
    markRecorded(row);
  })
    .catch((err: unknown) => {
      // A no-op once the row was recorded; otherwise the caller hears why.
      failedBeforeRecorded(err);
      throw err;
    })
    .finally(() => {
      runningBackup = null;
      runningBackupId = null;
    });
  runningBackup = { recorded, done };
  return runningBackup;
}

async function runBackupInner(
  kind: "manual" | "scheduled",
  onRecorded: (row: Backup) => void,
): Promise<Backup> {
  ensureBackupDir();
  // Reclaim debris from any previous run killed mid-flight before staging a
  // fresh snapshot of our own. A long-lived install that never restarts would
  // otherwise never sweep, and this is the moment the space is about to matter.
  sweepOrphanedStagingArtifacts();
  const repo = AppDataSource.getRepository(Backup);
  const startedAt = new Date();
  const filename = `backup-${timestampSuffix(startedAt)}.zip`;
  const row = repo.create({
    filename,
    sizeBytes: 0,
    kind,
    status: "running",
    errorMessage: "",
    completedAt: null,
    copiesTracked: true,
  });
  await repo.save(row);
  onRecorded(row);

  const outPath = backupFilePath(filename);
  const stagingDbPath = path.join(backupDir(), `${STAGING_PREFIX}${row.id}.sqlite`);
  activeStagingPaths.add(stagingDbPath);

  try {
    const snapshot = await snapshotSqlite(stagingDbPath);
    await writeZip(outPath, snapshot);
    // The archive is written and renamed into place, and nothing below reads
    // the snapshot again — so release it here rather than leaving it to the
    // `finally`. Off-box delivery can stream a 20 GB archive for hours, and
    // holding a database-sized snapshot across that doubles peak disk usage
    // for the whole of it and widens the window in which a SIGKILL strands it.
    // The `finally` still runs and is idempotent; this only makes it earlier.
    removeStagingArtifact(stagingDbPath);
    activeStagingPaths.delete(stagingDbPath);
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    row.sizeBytes = size;
    row.status = "completed";
    row.completedAt = new Date();
    await repo.save(row);

    if (kind === "scheduled") {
      const sched = await getBackupSchedule();
      sched.lastRunAt = row.completedAt;
      await AppDataSource.getRepository(BackupSchedule).save(sched);
    }

    // Mirror the finished archive to any enabled off-box destinations (NAS /
    // remote volume). Best-effort — the local backup already succeeded, so a
    // delivery failure is recorded on the destination row, and on this
    // backup's copy there, rather than failing the run.
    claimBackupCopy(row.id);
    try {
      await deliverBackupToDestinations(filename, outPath, await offBoxRetention(), {
        backupId: row.id,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[backups] off-box delivery failed:", err);
    } finally {
      releaseBackupCopy(row.id);
    }

    // Enforce retention now that a fresh archive has landed — that's the
    // moment the oldest one becomes expendable. Best-effort: this backup has
    // already succeeded and must not fail because a stale archive wouldn't
    // unlink. Note restoreFromBackup() takes a safety snapshot through here
    // while restoreInProgress is set; pruneOldBackups() bails in that case,
    // which is what stops it deleting the archive being restored.
    try {
      await pruneOldBackups();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[backups] retention after backup failed:", err);
    }
  } catch (err) {
    row.status = "failed";
    row.errorMessage = (err as Error).message ?? String(err);
    row.completedAt = new Date();
    await repo.save(row);
    // Both names: the archive may have been renamed into place before a later
    // step threw, or still be a `.part` if writeZip is what failed.
    for (const p of [outPath, `${outPath}${PART_SUFFIX}`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
    throw err;
  } finally {
    // Sidecars as well as the snapshot: writing it leaves a rollback
    // journal beside its destination, and unlinking only the `.sqlite` left
    // one behind on every run.
    removeStagingArtifact(stagingDbPath);
    activeStagingPaths.delete(stagingDbPath);
  }

  return row;
}

/** How far better-sqlite3's backup has got: pages in the source, pages still to copy. */
type SqliteBackupProgress = { totalPages: number; remainingPages: number };

/** The part of the DataSource's better-sqlite3 handle a snapshot uses. */
type SqliteBackupHandle = {
  backup(
    destination: string,
    options?: { progress?: (progress: SqliteBackupProgress) => number | undefined },
  ): Promise<SqliteBackupProgress>;
  pragma(source: string, options?: { simple?: boolean }): unknown;
};

const MISSING_SNAPSHOT_MESSAGE =
  "The database snapshot is missing. The backup was stopped rather than saved without its database.";

/** Why a backup left `running` by a process that stopped part-way failed. */
export const BACKUP_INTERRUPTED_MESSAGE =
  "Genosyn stopped while writing this backup (a restart, an upgrade or a crash), so it didn't finish.";
export const UPLOAD_INTERRUPTED_MESSAGE =
  "Genosyn stopped while receiving this upload, so it didn't finish.";
export const INTERRUPTED_UNREADABLE_MESSAGE =
  "Genosyn stopped while writing this backup, and the file it left doesn't open.";

function snapshotBusyMessage(): string {
  const minutes = Math.max(1, Math.round(snapshotBusyLimitMs / 60_000));
  return (
    `Could not copy the database: a change to it has not finished for ${minutes} ` +
    `minute${minutes === 1 ? "" : "s"}. The backup was stopped rather than saved without its database.`
  );
}

/**
 * Snapshot SQLite to a standalone file at `dest` with SQLite's online backup
 * API, on the connection that does all of this process's writing. Returns the
 * snapshot's path, or null when the app is configured for Postgres (operators
 * handle that via `pg_dump`).
 *
 * This used to be `VACUUM INTO`. That is one statement, and better-sqlite3
 * runs every statement synchronously on the event loop, so snapshotting a
 * large database froze every request until it finished — minutes on a 30 GB
 * file, every scheduled run. The backup API copies a bounded run of pages per
 * turn of the event loop instead. It shares the writing connection, so pages
 * written mid-copy are carried into the snapshot rather than restarting it,
 * and the result is the same consistent point-in-time copy. It is copied page
 * for page, free pages included, so the snapshot is the size of the live file.
 *
 * SQLite refuses to copy while that connection is part-way through a write.
 * better-sqlite3 reports a refusal on the very first step as a finished copy
 * of no pages and deletes the file, so a backup started at that moment used to
 * ship without its database and still record itself as completed. A refusal
 * is retried, a copy that stops moving is abandoned, and either way the run
 * fails rather than writing an archive that cannot be restored.
 */
async function snapshotSqlite(dest: string): Promise<string | null> {
  if (config.db.driver !== "sqlite") return null;
  const handle = (AppDataSource.driver as unknown as { databaseConnection: SqliteBackupHandle })
    .databaseConnection;
  const giveUpAt = Date.now() + snapshotBusyLimitMs;
  for (;;) {
    // Clear the destination *and* its sidecars: a journal stranded beside a
    // fresh snapshot would be replayed into it the next time the file is opened.
    removeStagingArtifact(dest);
    let remaining = -1;
    let movedAt = Date.now();
    const copied = await handle.backup(dest, {
      // Called after every step. A step SQLite refuses copies nothing, so the
      // count standing still is a write holding the connection.
      progress: ({ remainingPages }) => {
        if (remainingPages !== remaining) {
          remaining = remainingPages;
          movedAt = Date.now();
        } else if (Date.now() - movedAt >= snapshotBusyLimitMs) {
          throw new Error(snapshotBusyMessage());
        }
        return undefined;
      },
    });
    if (copied.totalPages > 0) {
      assertCompleteSnapshot(dest, copied.totalPages, handle);
      return dest;
    }
    if (Date.now() >= giveUpAt) throw new Error(snapshotBusyMessage());
    await sleep(SNAPSHOT_RETRY_MS);
  }
}

/** A finished copy holds every page the source had: never archive less. */
function assertCompleteSnapshot(dest: string, pages: number, handle: SqliteBackupHandle): void {
  const expected = pages * Number(handle.pragma("page_size", { simple: true }));
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (size === 0 || size < expected) {
    throw new Error(
      `The database snapshot is incomplete (${size} of ${expected} bytes). The backup was stopped rather than saved without its database.`,
    );
  }
}

/**
 * Write the zip archive to `outPath`. Everything under `dataDir` is
 * included except for the `Backup/` folder (so backups don't recurse) and
 * the live SQLite files (the snapshot at `sqliteSnapshot` is substituted
 * in as `app.sqlite` if present).
 *
 * The bytes go to a `.part` sibling and are renamed into place only once the
 * stream closes cleanly, so `outPath` never exists in a half-written state.
 * Without this, a SIGKILL mid-write (container restart, OOM) would leave a
 * truncated zip at the real filename — one with a valid `PK\x03\x04` header
 * but no central directory, which every consumer here would treat as a
 * finished backup. The rename is atomic because it stays in one directory.
 *
 * A snapshot that was asked for must land in the archive. Files that vanish
 * mid-walk are skipped on purpose, but an archive missing `app.sqlite` looks
 * complete and restores to an empty install, so it fails the run instead.
 */
function writeZip(outPath: string, sqliteSnapshot: string | null): Promise<void> {
  if (sqliteSnapshot && !fs.existsSync(sqliteSnapshot)) {
    return Promise.reject(new Error(MISSING_SNAPSHOT_MESSAGE));
  }
  return new Promise((resolve, reject) => {
    const partPath = `${outPath}${PART_SUFFIX}`;
    const output = createWriteStream(partPath, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const walked = { entries: 0 };

    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      stopWatching();
      output.destroy();
      reject(err);
    };

    // A read stuck on a hung disk or mount never errors: the run would hold
    // the backup lock — every later backup joining it — for good, and History
    // would say "running" for weeks. Bytes written and entries walked are the
    // run's pulse; when neither moves for the limit, it fails instead.
    const stopWatching = watchForStall(
      () => archive.pointer() + walked.entries,
      writeStallLimitMs,
      () => {
        fail(new Error(writeStallMessage()));
        archive.abort();
      },
    );

    let archivedDatabase = false;
    archive.on("entry", (entry) => {
      if (entry.name === "app.sqlite") archivedDatabase = true;
    });

    output.on("close", () => {
      if (failed) return;
      stopWatching();
      if (sqliteSnapshot && !archivedDatabase) {
        fail(new Error(MISSING_SNAPSHOT_MESSAGE));
        return;
      }
      try {
        fs.renameSync(partPath, outPath);
        fs.chmodSync(outPath, 0o600);
      } catch (err) {
        fail(err as Error);
        return;
      }
      resolve();
    });
    output.on("error", fail);
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") fail(err);
    });
    archive.on("error", fail);

    archive.pipe(output);

    const root = dataRoot();
    const appendAll = async () => {
      if (fs.existsSync(root)) {
        await walkAndAppend(archive, root, "", sqliteSnapshot, walked);
      }
      if (sqliteSnapshot) {
        archive.file(sqliteSnapshot, { name: "app.sqlite" });
      }
      await archive.finalize();
    };
    appendAll().catch(fail);
  });
}

/**
 * Queue every file under `absDir`. The listing is asynchronous on purpose: a
 * data directory holding employee checkouts runs to hundreds of thousands of
 * files, and a synchronous walk of that holds the event loop for as long as
 * it takes.
 */
async function walkAndAppend(
  archive: archiver.Archiver,
  absDir: string,
  relPrefix: string,
  sqliteSnapshot: string | null,
  walked: { entries: number },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    walked.entries += 1;
    const absPath = path.join(absDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    // Skip the backup folder itself — otherwise each backup grows unbounded.
    if (relPrefix === "" && entry.name === BACKUP_DIR_NAME) continue;

    if (entry.isDirectory()) {
      await walkAndAppend(archive, absPath, relPath, sqliteSnapshot, walked);
      continue;
    }
    if (!entry.isFile()) continue;

    // When we have a fresh sqlite snapshot, skip the live DB files so we
    // don't ship a partially-written page or WAL journal.
    if (sqliteSnapshot) {
      if (relPath === "app.sqlite") continue;
      if (relPath === "app.sqlite-wal") continue;
      if (relPath === "app.sqlite-shm") continue;
      if (relPath === "app.sqlite-journal") continue;
    }

    archive.file(absPath, { name: relPath });
  }
}

export async function listBackups(): Promise<Backup[]> {
  const repo = AppDataSource.getRepository(Backup);
  return repo.find({ order: { createdAt: "DESC" }, take: 200 });
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.promises.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function getBackup(id: string): Promise<Backup | null> {
  return AppDataSource.getRepository(Backup).findOneBy({ id });
}

/**
 * One History row: the backup, and where it is right now — whether its
 * archive is still on this server, whether this server's run for it is still
 * under way (writing it while `running`, copying it off-box once `completed`;
 * a new backup can't start until it ends), and each of its off-box copies.
 */
async function historyItem(row: Backup, copies: BackupCopy[]) {
  return {
    ...serializeBackup(row),
    onServer: row.status === "completed" && (await fileExists(backupFilePath(row.filename))),
    inProgress: isBackupInProgress(row.id),
    copies: copies.map(serializeCopy),
  };
}

export type BackupHistoryItem = Awaited<ReturnType<typeof historyItem>>;

/** History: every backup, newest first, each with where it is right now. */
export async function listBackupHistory(): Promise<BackupHistoryItem[]> {
  const rows = await listBackups();
  const copies = await copiesByBackup(rows.map((row) => row.id));
  return Promise.all(rows.map((row) => historyItem(row, copies.get(row.id) ?? [])));
}

/** {@link listBackupHistory}'s row for one backup. */
export async function backupHistoryItem(row: Backup): Promise<BackupHistoryItem> {
  return historyItem(row, (await copiesByBackup([row.id])).get(row.id) ?? []);
}

/**
 * Copy an existing backup off-box now — to every enabled destination, or to
 * just `destinationId` (Try again on one copy, paused or not). Returns as soon
 * as the copies are queued, each recorded as waiting its turn; the copying
 * runs on and History follows it. While this backup is already being copied,
 * returns its copies as they stand with `alreadyRunning` set.
 */
export async function startCopy(
  id: string,
  destinationId: string | null = null,
): Promise<{ copies: BackupCopy[]; alreadyRunning: boolean }> {
  const repo = AppDataSource.getRepository(Backup);
  const row = await repo.findOneBy({ id });
  if (!row) throw new BackupError("This backup no longer exists.", 404);
  if (row.status !== "completed") {
    throw new BackupError("Only a finished backup can be copied off-box.");
  }
  const absPath = backupFilePath(row.filename);
  if (!(await fileExists(absPath))) {
    throw new BackupError("This backup is no longer on this server, so there is nothing to copy.");
  }
  if (!claimBackupCopy(id)) {
    return { copies: (await copiesByBackup([id])).get(id) ?? [], alreadyRunning: true };
  }
  try {
    const destinations = AppDataSource.getRepository(BackupDestination);
    const targets = destinationId
      ? await destinations.findBy({ id: destinationId })
      : await destinations.find({ where: { enabled: true }, order: { createdAt: "ASC" } });
    if (destinationId && targets.length === 0) {
      throw new BackupError("That off-box destination no longer exists.", 404);
    }
    if (targets.length === 0) {
      throw new BackupError(
        "No off-box destination is turned on. Add one, or resume a paused one, first.",
      );
    }
    const destinationIds = targets.map((target) => target.id);
    const copies = await markCopiesPending(id, destinationIds);
    const retention = await offBoxRetention();
    void deliverBackupToDestinations(row.filename, absPath, retention, {
      backupId: id,
      destinationIds,
      includePaused: destinationId !== null,
    })
      .catch(async (err: unknown) => {
        const message = (err as Error)?.message ?? String(err);
        // eslint-disable-next-line no-console
        console.error("[backups] copying a backup off-box failed:", message);
        // Whatever stopped it, no copy may be left waiting for a delivery
        // that is no longer running.
        await failCopiesInFlight(id, destinationIds, message).catch(() => undefined);
      })
      .finally(() => releaseBackupCopy(id));
    return { copies, alreadyRunning: false };
  } catch (err) {
    releaseBackupCopy(id);
    throw err;
  }
}

export async function deleteBackup(id: string): Promise<boolean> {
  // Same reasoning as the guard in pruneOldBackups: a restore has already
  // resolved its archive on disk and is about to wipe `dataDir` around it.
  // Deleting anything underneath it strands the restore mid-flight.
  if (restoreInProgress) {
    throw new BackupError("A restore is in progress. Try again once it finishes.");
  }
  const repo = AppDataSource.getRepository(Backup);
  const row = await repo.findOneBy({ id });
  if (!row) return false;
  if (isBackupInProgress(id)) {
    throw new BackupError("This backup is still being written. Delete it once it finishes.");
  }
  if (isBackupBeingCopied(id)) {
    throw new BackupError(
      "This backup is being copied off-box right now. Delete it once the copy finishes.",
    );
  }
  const filePath = backupFilePath(row.filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort; still remove the row so the UI doesn't orphan it
  }
  await repo.delete({ id });
  // History's record of its off-box copies goes too. The copies themselves
  // stay on the destinations until off-box retention removes them there.
  await deleteCopiesOfBackups([id]);
  return true;
}

/**
 * Stream an uploaded archive body to `<dataDir>/Backup/` and register it as
 * a Backup row (`kind: 'uploaded'`). The body is piped straight through with
 * a size cap so a hostile client can't fill the disk. Returns the completed
 * row on success; rolls back the on-disk file and row on error.
 *
 * Lands via `.part` + rename for the same reason {@link writeZip} does: an
 * upload cut short must not leave something that looks like an archive under
 * a real filename. It matters more here — an `uploaded` archive is exempt from
 * retention, so debris in this path would never be cleaned up.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export async function ingestUploadedArchive(req: IncomingMessage): Promise<Backup> {
  ensureBackupDir();
  const repo = AppDataSource.getRepository(Backup);
  const now = new Date();
  const filename = `uploaded-${timestampSuffix(now)}.zip`;
  const row = repo.create({
    filename,
    sizeBytes: 0,
    kind: "uploaded",
    status: "running",
    errorMessage: "",
    completedAt: null,
    copiesTracked: true,
  });
  await repo.save(row);

  const outPath = backupFilePath(filename);
  const partPath = `${outPath}${PART_SUFFIX}`;
  try {
    const contentLength = Number(req.headers["content-length"] ?? "0");
    if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
      throw new BackupError(
        `Upload is ${(contentLength / (1024 * 1024)).toFixed(1)} MB, which exceeds the 2 GB limit.`,
        413,
      );
    }

    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy(new BackupError("Upload exceeded the 2 GB limit.", 413));
      }
    });

    await pipeline(req, createWriteStream(partPath, { mode: 0o600 }));

    // Open the archive rather than peeking at its `PK\x03\x04` header: a
    // signature check passes a file that was cut off in transit, and the
    // operator would only find out at restore time — the worst possible
    // moment. Reading the central directory rejects both a partial upload and
    // something that was never a zip.
    const check = await checkArchive(partPath);
    if (check === "unreadable") {
      throw new BackupError("The uploaded file is not a complete zip archive.", 400);
    }
    if (check === "no-database") {
      throw new BackupError(
        "The uploaded archive does not contain the database (app.sqlite), so it can't be restored from.",
        400,
      );
    }

    fs.renameSync(partPath, outPath);
    fs.chmodSync(outPath, 0o600);
    const size = fs.statSync(outPath).size;
    row.sizeBytes = size;
    row.status = "completed";
    row.completedAt = new Date();
    await repo.save(row);
    return row;
  } catch (err) {
    row.status = "failed";
    row.errorMessage = (err as Error).message ?? String(err);
    row.completedAt = new Date();
    await repo.save(row);
    for (const p of [outPath, partPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

/**
 * Replace the data directory with the contents of a Backup archive. Takes a
 * pre-restore safety snapshot, closes the TypeORM DataSource, wipes `data/`
 * (keeping `Backup/` so both the safety backup and history survive),
 * extracts the archive, re-initializes the DataSource, and reboots the cron
 * registries. Any failure is propagated to the caller — partial state on
 * disk may require manually restoring from the safety backup.
 */
export async function restoreFromBackup(id: string): Promise<{
  safety: Backup;
  restored: Backup;
}> {
  if (restoreInProgress) {
    throw new BackupError("A restore is already running. Wait for it to finish.");
  }
  if (runningBackup) {
    throw new BackupError("A backup is being taken right now. Restore once it finishes.");
  }
  // A copy reads its archive from Backup/ and records its progress in the
  // database the restore is about to replace.
  if (isDeliveryRunning()) {
    throw new BackupError(
      "A backup is being copied off-box right now. Restore once the copy finishes.",
    );
  }
  // A prune already in flight has read its candidate list and could unlink the
  // archive we're about to extract. Refuse rather than race it — the flag we
  // set below only stops prunes that haven't started yet.
  if (runningPrune) {
    throw new BackupError("Old backups are being deleted right now. Try again in a moment.");
  }
  restoreInProgress = true;
  try {
    const repo = AppDataSource.getRepository(Backup);
    const target = await repo.findOneBy({ id });
    if (!target) throw new BackupError("This backup no longer exists.", 404);
    if (target.status !== "completed") {
      throw new BackupError("Only a finished backup can be restored.");
    }
    const zipPath = backupFilePath(target.filename);
    if (!fs.existsSync(zipPath)) {
      throw new BackupError(
        "This backup is no longer on this server. Copy it back into the backup folder, or upload it under Advanced, to restore it.",
      );
    }
    // Open it before doing anything expensive or destructive. `status` and
    // `existsSync` only say a file is there, not that it can be extracted —
    // and this restore is about to delete everything the archive is supposed
    // to replace.
    const check = await checkArchive(zipPath);
    if (check === "no-database") {
      throw new BackupError(
        "This backup does not contain the database (app.sqlite), so restoring it would leave this install empty.",
      );
    }
    if (check !== "restorable") {
      throw new BackupError("This backup is incomplete or damaged and can't be restored from.");
    }

    // Pre-restore safety snapshot. Reuses runBackup so the resulting archive
    // shows up in History — tagged `manual` because the user initiated the
    // restore that triggered it.
    const safety = await runBackup("manual");
    // `wipeDataExceptBackup` removes the managed identity too. Hold it only in
    // memory so a pre-managed archive cannot silently rotate the encryption
    // root; an archive that contains its own identity still wins below.
    const instanceSecretsSnapshot = snapshotManagedInstanceSecrets();

    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;
    }
    // The retention cron has to come down too: extracting a large archive can
    // take minutes, and an hourly tick landing in that window would query a
    // destroyed DataSource. bootBackups() below re-registers both.
    if (retentionTask) {
      retentionTask.stop();
      retentionTask = null;
    }
    // Same reasoning for the routine heartbeat: it polls every 30s and would
    // otherwise keep firing — and starting runs — across the wipe window.
    stopCron();
    stopDurableChatTurnRecovery();
    // The context-window sweep is three-hourly, so it will rarely land here —
    // but a tick that did would query the destroyed DataSource for the whole
    // extract window. Cheap to take down; re-registered below.
    stopContextWindowRefresh();
    // Banking's background sync ticks every minute, so it would land in the
    // extract window and query — or write synced transactions into — a
    // database that is being replaced. Re-registered below.
    stopBankingSync();
    // The search index lives on this connection; it goes with it.
    stopMailSearchIndex();
    await AppDataSource.destroy();

    // Last look before the point of no return. The checks above ran before the
    // safety snapshot, which takes long enough for the archive to have gone or
    // been damaged since. Failing here costs nothing; failing after the wipe
    // costs the install.
    if (!(await isRestorableArchive(target.filename))) {
      await AppDataSource.initialize();
      bootMailSearchIndex();
      bootBankingSync();
      throw new BackupError(
        "This backup went missing or became unreadable before the restore started. Nothing was changed.",
      );
    }

    wipeDataExceptBackup();
    await extractZipIntoDataRoot(zipPath);
    restoreManagedInstanceSecretsIfMissing(instanceSecretsSnapshot, {
      // An archive without managed state predates this feature (or omitted its
      // hidden files). Keep the current identity, but retain decrypt-only
      // access to ciphertext written under the former stock placeholders.
      enablePlaceholderCompatibility: true,
    });
    // Every secret consumer resolves dynamically. Reload before opening the
    // restored DB so cross-instance archives use their own encryption root;
    // the next browser request also rebuilds cookie-session with its signer.
    reloadEffectiveInstanceSecrets();

    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    // An archive taken before planner statistics existed restores without
    // them; plan nothing against it until they do.
    optimizeSqliteStatistics();
    bootMailSearchIndex();
    await bindInstanceSecretsToDatabase();

    // After the restored DB comes back online it has no row for the safety
    // snapshot (or any other archive written since the restored zip was
    // taken). Stitch every zip in `Backup/` back into the `backups` table so
    // the History view reflects what's actually on disk.
    await reconcileBackupHistory();

    // Restored routines carry the `nextRunAt` frozen when the archive was
    // written — by definition in the past — so re-anchor every schedule to a
    // future slot before the heartbeat comes back, or the first tick fires the
    // whole company at once.
    await resetSchedulesAfterRestore();

    // Rebuild in-memory schedules from the restored DB rows.
    await bootCron();
    await bootDurableChatTurnRecovery();
    // Ask AI answers captured mid-turn by the archive have no process behind
    // them any more; close them out rather than restoring a spinner.
    await finalizeInterruptedAskAiTurns();
    // Same for TLDR question cards captured mid-answer.
    await finalizeInterruptedTldrQuestionTurns();
    bootContextWindowRefresh();
    // A restored account that was mid-sync when the archive was taken still
    // says Syncing…; the first tick clears that and syncs what is due.
    bootBankingSync();
    await bootBackups();

    return { safety, restored: target };
  } finally {
    restoreInProgress = false;
  }
}

function wipeDataExceptBackup(): void {
  const root = dataRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === BACKUP_DIR_NAME) continue;
    const p = path.join(root, entry.name);
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[backups] failed to remove ${p}:`, err);
    }
  }
}

async function reconcileBackupHistory(): Promise<void> {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return;
  const repo = AppDataSource.getRepository(Backup);

  // Snapshots stranded by a run that was killed before its `finally` could
  // run. Nothing else ever collects these, and each one is the size of the
  // whole database, so a restart is the first chance to get the space back.
  sweepOrphanedStagingArtifacts();

  // Sweep debris from a backup killed mid-write. The `.part` name is what kept
  // it from being mistaken for an archive; nothing can resume one, so it is
  // just dead bytes. (An install upgraded from before writeZip wrote atomically
  // may still hold a truncated `.zip` under a real filename — the loop below
  // fails its row rather than promoting it, and leaves the file for a person.)
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith(".zip")) fs.chmodSync(path.join(dir, entry), 0o600);
    if (!entry.endsWith(PART_SUFFIX)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
    } catch {
      // best-effort
    }
  }

  const existing = await repo.find();
  const byName = new Map(existing.map((r) => [r.filename, r]));

  // Settle every row still marked `running`. Nothing is writing one: this runs
  // at boot and after a restore, before anything can start a backup.
  //
  // A row captured mid-backup — what the SQLite snapshot inside each archive
  // freezes, and what a restore brings back — has its archive right here: it
  // is promoted to completed, with the real size, so History matches the disk.
  // `completed` is a load-bearing claim, since it lets restoreFromBackup wipe
  // `dataDir` for the archive, so only one that actually opens is promoted.
  //
  // Every other one belongs to a process that stopped part-way — a restart, an
  // upgrade, the OOM killer — whose `.part` was swept just above. Those used to
  // stay `running` for good, weeks-old rows History showed as still going; now
  // each fails with the plain reason.
  const salvage: Backup[] = [];
  const settledAt = new Date();
  for (const row of existing) {
    const abs = backupFilePath(row.filename);
    const onDisk = fs.existsSync(abs);
    let dirty = false;
    if (row.status === "running" && !isBackupInProgress(row.id)) {
      if (onDisk && (await isRestorableArchive(row.filename))) {
        row.status = "completed";
        if (!row.completedAt) row.completedAt = settledAt;
        // Whatever was copied off-box happened after this row was captured, so
        // this database cannot know it: its copies are "not recorded" until
        // daily verification looks for them.
        row.copiesTracked = false;
      } else {
        row.status = "failed";
        row.errorMessage = onDisk
          ? INTERRUPTED_UNREADABLE_MESSAGE
          : row.kind === "uploaded"
            ? UPLOAD_INTERRUPTED_MESSAGE
            : BACKUP_INTERRUPTED_MESSAGE;
        if (!row.completedAt) row.completedAt = settledAt;
      }
      dirty = true;
    }
    if (onDisk && row.sizeBytes === 0 && row.status === "completed") {
      row.sizeBytes = fs.statSync(abs).size;
      dirty = true;
    }
    if (dirty) salvage.push(row);
  }
  if (salvage.length > 0) await repo.save(salvage);

  const pending: Backup[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".zip")) continue;
    if (byName.has(entry)) continue;
    const abs = path.join(dir, entry);
    const stat = fs.statSync(abs);
    pending.push(
      repo.create({
        filename: entry,
        sizeBytes: stat.size,
        kind: entry.startsWith("uploaded-") ? "uploaded" : "manual",
        status: "completed",
        errorMessage: "",
        createdAt: stat.mtime,
        completedAt: stat.mtime,
      }),
    );
  }
  if (pending.length > 0) await repo.save(pending);
}

async function extractZipIntoDataRoot(zipPath: string): Promise<void> {
  const root = dataRoot();
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  fs.mkdirSync(root, { recursive: true });

  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type === "Directory") continue;
    // Normalise and guard against zip-slip — entry paths that try to escape
    // the data root with `..` segments are rejected rather than silently
    // clamped so we don't quietly write somewhere unexpected.
    const rel = entry.path.replace(/\\/g, "/");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(rootWithSep) && abs !== root) {
      throw new Error(`Refusing to extract outside data root: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const managedSecretState =
      rel === INSTANCE_SECRETS_FILENAME || rel === INSTANCE_SECRETS_SENTINEL_FILENAME;
    await pipeline(
      entry.stream(),
      createWriteStream(abs, managedSecretState ? { mode: 0o600 } : undefined),
    );
    if (managedSecretState) fs.chmodSync(abs, 0o600);
  }
}

export function serializeBackup(b: Backup) {
  return {
    id: b.id,
    filename: b.filename,
    sizeBytes: b.sizeBytes,
    kind: b.kind,
    status: b.status,
    errorMessage: b.errorMessage,
    copiesTracked: b.copiesTracked,
    createdAt: b.createdAt,
    completedAt: b.completedAt,
  };
}

/** The server's time zone, which the schedule's hour is in. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function serializeSchedule(s: BackupSchedule, now = new Date()) {
  return {
    enabled: s.enabled,
    frequency: s.frequency,
    hour: s.hour,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    cronExpr: cronExprForSchedule(s),
    /** When the schedule next fires; null while it is off. */
    nextRunAt: s.enabled ? nextScheduledFireTime(s, now) : null,
    /** The hour above is this zone's, the server's own. */
    timeZone: serverTimeZone(),
    lastRunAt: s.lastRunAt,
    retentionEnabled: s.retentionEnabled,
    retentionDays: s.retentionDays,
    offBoxRetentionEnabled: s.offBoxRetentionEnabled,
    offBoxRetentionDays: s.offBoxRetentionDays,
    updatedAt: s.updatedAt,
  };
}
