import path from "node:path";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import archiver from "archiver";
import unzipper from "unzipper";
import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupSchedule, BackupFrequency } from "../db/entities/BackupSchedule.js";
import { config } from "../../config.js";
import { dataRoot } from "./paths.js";
import { bootCron, resetSchedulesAfterRestore, stopCron } from "./cron.js";
import {
  deliverArchive,
  deliverBackupToDestinations,
  DeliveryResult,
} from "./backupDestinations.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Install-wide backup service. Each backup zips `<dataDir>` (excluding the
 * `Backup/` folder itself and any staging artifact) into
 * `<dataDir>/Backup/backup-YYYY-MM-DD-HHMMSS.zip`. The SQLite file is first
 * snapshotted via `VACUUM INTO` so the archive captures a consistent view
 * even while the app is writing.
 *
 * A singleton {@link BackupSchedule} row drives the optional recurring cron.
 * The schedule is modelled as frequency + hour (and day-of-week / day-of-
 * month where applicable) rather than a raw cron expression so the settings
 * UI stays approachable. The same row carries the retention policy — see
 * {@link pruneOldBackups}.
 */

const SCHEDULE_ID = "default";
const BACKUP_DIR_NAME = "Backup";

/**
 * Suffix for an archive still being written. Deliberately not `.zip` so
 * {@link reconcileBackupHistory} can't adopt a half-written file as a backup.
 */
const PART_SUFFIX = ".part";

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
let runningBackup: Promise<Backup> | null = null;
let runningPrune: Promise<number> | null = null;

/**
 * True from the moment a restore is accepted until it finishes. Shared with
 * {@link pruneOldBackups}: a restore resolves its archive on disk and then
 * wipes `dataDir` around it, so nothing may delete archives underneath it.
 */
let restoreInProgress = false;

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
    });
    await repo.save(row);
  }
  return row;
}

/**
 * Persist a schedule/retention change and re-register both crons against it.
 * Retention is enforced immediately rather than at the next hourly tick, so
 * saving the form has a visible effect — the returned count is what the UI
 * reports back to the operator.
 */
export async function updateBackupSchedule(patch: {
  enabled?: boolean;
  frequency?: BackupFrequency;
  hour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  retentionEnabled?: boolean;
  retentionDays?: number;
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
 */
async function isRestorableArchive(filename: string): Promise<boolean> {
  return canOpenZip(backupFilePath(filename));
}

/** {@link isRestorableArchive} for a path that isn't (yet) a backup filename. */
async function canOpenZip(abs: string): Promise<boolean> {
  if (!fs.existsSync(abs)) return false;
  try {
    await unzipper.Open.file(abs);
    return true;
  } catch {
    return false;
  }
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
function previousScheduledFireTime(sched: BackupSchedule, now: Date): Date {
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
 * Create a zip archive of the data directory. Returns the completed
 * {@link Backup} row. Serialized via {@link runningBackup} so the user
 * can't kick off two concurrent runs from the UI.
 */
export async function runBackup(kind: "manual" | "scheduled"): Promise<Backup> {
  if (runningBackup) return runningBackup;
  runningBackup = runBackupInner(kind).finally(() => {
    runningBackup = null;
  });
  return runningBackup;
}

async function runBackupInner(kind: "manual" | "scheduled"): Promise<Backup> {
  ensureBackupDir();
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
  });
  await repo.save(row);

  const outPath = backupFilePath(filename);
  const stagingDbPath = path.join(backupDir(), `.staging-${row.id}.sqlite`);

  try {
    await snapshotSqlite(stagingDbPath);
    await writeZip(outPath, stagingDbPath);
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
    // delivery failure is recorded on the destination row rather than failing
    // the run.
    try {
      await deliverBackupToDestinations(filename, outPath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[backups] off-box delivery failed:", err);
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
    try {
      if (fs.existsSync(stagingDbPath)) fs.unlinkSync(stagingDbPath);
    } catch {
      // best-effort
    }
  }

  return row;
}

/**
 * Snapshot SQLite to a standalone file at `dest` using `VACUUM INTO`. This
 * captures a consistent view of the DB without blocking writers. No-op when
 * the app is configured for Postgres (operators handle that via `pg_dump`).
 */
async function snapshotSqlite(dest: string): Promise<void> {
  if (config.db.driver !== "sqlite") return;
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const runner = AppDataSource.createQueryRunner();
  try {
    await runner.query(`VACUUM INTO ?`, [dest]);
  } finally {
    await runner.release();
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
 */
function writeZip(outPath: string, sqliteSnapshot: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const partPath = `${outPath}${PART_SUFFIX}`;
    const output = createWriteStream(partPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      output.destroy();
      reject(err);
    };

    output.on("close", () => {
      if (failed) return;
      try {
        fs.renameSync(partPath, outPath);
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
    if (fs.existsSync(root)) {
      walkAndAppend(archive, root, "", sqliteSnapshot);
    }

    if (sqliteSnapshot && fs.existsSync(sqliteSnapshot)) {
      archive.file(sqliteSnapshot, { name: "app.sqlite" });
    }

    archive.finalize().catch(fail);
  });
}

function walkAndAppend(
  archive: archiver.Archiver,
  absDir: string,
  relPrefix: string,
  sqliteSnapshot: string | null,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    // Skip the backup folder itself — otherwise each backup grows unbounded.
    if (relPrefix === "" && entry.name === BACKUP_DIR_NAME) continue;

    if (entry.isDirectory()) {
      walkAndAppend(archive, absPath, relPath, sqliteSnapshot);
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

/**
 * Push an already-completed archive to every enabled backup destination on
 * demand (the "Send to destinations" action in History). Per-destination
 * failures come back inside the result list; throws only when the backup row
 * or its archive can't be found.
 */
export async function deliverBackup(id: string): Promise<DeliveryResult[]> {
  const repo = AppDataSource.getRepository(Backup);
  const row = await repo.findOneBy({ id });
  if (!row) throw new Error("Backup not found");
  if (row.status !== "completed") {
    throw new Error("Can only deliver a completed backup");
  }
  return deliverArchive(row.filename, backupFilePath(row.filename));
}

export async function deleteBackup(id: string): Promise<boolean> {
  // Same reasoning as the guard in pruneOldBackups: a restore has already
  // resolved its archive on disk and is about to wipe `dataDir` around it.
  // Deleting anything underneath it strands the restore mid-flight.
  if (restoreInProgress) {
    throw new Error("A restore is in progress; try again when it finishes.");
  }
  const repo = AppDataSource.getRepository(Backup);
  const row = await repo.findOneBy({ id });
  if (!row) return false;
  const filePath = backupFilePath(row.filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort; still remove the row so the UI doesn't orphan it
  }
  await repo.delete({ id });
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
  });
  await repo.save(row);

  const outPath = backupFilePath(filename);
  const partPath = `${outPath}${PART_SUFFIX}`;
  try {
    const contentLength = Number(req.headers["content-length"] ?? "0");
    if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Upload is ${(contentLength / (1024 * 1024)).toFixed(1)} MB, which exceeds the 2 GB limit.`,
      );
    }

    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.destroy(new Error("Upload exceeded 2 GB limit"));
      }
    });

    await pipeline(req, createWriteStream(partPath));

    // Open the archive rather than peeking at its `PK\x03\x04` header: a
    // signature check passes a file that was cut off in transit, and the
    // operator would only find out at restore time — the worst possible
    // moment. Reading the central directory rejects both a partial upload and
    // something that was never a zip.
    if (!(await canOpenZip(partPath))) {
      throw new Error("Uploaded file is not a complete zip archive");
    }

    fs.renameSync(partPath, outPath);
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
    throw new Error("A restore is already running; wait for it to finish.");
  }
  if (runningBackup) {
    throw new Error("A backup is currently running; try again in a moment.");
  }
  // A prune already in flight has read its candidate list and could unlink the
  // archive we're about to extract. Refuse rather than race it — the flag we
  // set below only stops prunes that haven't started yet.
  if (runningPrune) {
    throw new Error("Backup retention is currently running; try again in a moment.");
  }
  restoreInProgress = true;
  try {
    const repo = AppDataSource.getRepository(Backup);
    const target = await repo.findOneBy({ id });
    if (!target) throw new Error("Backup not found");
    if (target.status !== "completed") {
      throw new Error("Can only restore from a completed backup");
    }
    const zipPath = backupFilePath(target.filename);
    if (!fs.existsSync(zipPath)) {
      throw new Error("Backup archive is missing on disk");
    }
    // Open it before doing anything expensive or destructive. `status` and
    // `existsSync` only say a file is there, not that it can be extracted —
    // and this restore is about to delete everything the archive is supposed
    // to replace.
    if (!(await isRestorableArchive(target.filename))) {
      throw new Error("Backup archive is incomplete or corrupt and cannot be restored from");
    }

    // Pre-restore safety snapshot. Reuses runBackup so the resulting archive
    // shows up in History — tagged `manual` because the user initiated the
    // restore that triggered it.
    const safety = await runBackup("manual");

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
    await AppDataSource.destroy();

    // Last look before the point of no return. The checks above ran before the
    // safety snapshot, which takes long enough for the archive to have gone or
    // been damaged since. Failing here costs nothing; failing after the wipe
    // costs the install.
    if (!(await isRestorableArchive(target.filename))) {
      await AppDataSource.initialize();
      throw new Error(
        "Backup archive went missing or became unreadable before the restore started",
      );
    }

    wipeDataExceptBackup();
    await extractZipIntoDataRoot(zipPath);

    await AppDataSource.initialize();
    await AppDataSource.runMigrations();

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

  // Sweep debris from a backup killed mid-write. The `.part` name is what kept
  // it from being mistaken for an archive; nothing can resume one, so it is
  // just dead bytes. (An install upgraded from before writeZip wrote atomically
  // may still hold a truncated `.zip` under a real filename — the salvage loop
  // below leaves those `running` rather than promoting them.)
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(PART_SUFFIX)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
    } catch {
      // best-effort
    }
  }

  const existing = await repo.find();
  const byName = new Map(existing.map((r) => [r.filename, r]));

  // Patch up rows that were captured mid-backup. The VACUUM INTO snapshot we
  // ship inside each archive freezes the table while the row is still
  // `running` with sizeBytes=0; after a restore, those rows would otherwise
  // look perpetually in-flight. Promote them to completed and fill in the
  // real file size so History matches what's actually on disk.
  const salvage: Backup[] = [];
  for (const row of existing) {
    const abs = backupFilePath(row.filename);
    if (!fs.existsSync(abs)) continue;
    let dirty = false;
    if (row.status === "running") {
      // Existing on disk is not the same as restorable, and `completed` is a
      // load-bearing claim: it is what lets restoreFromBackup wipe `dataDir`
      // for this archive. Only promote one we can actually open. A row left
      // `running` is inert — prune skips it and restore refuses it — which is
      // the right resting place for both crash debris and an archive we simply
      // couldn't read right now.
      if (!(await isRestorableArchive(row.filename))) continue;
      row.status = "completed";
      if (!row.completedAt) row.completedAt = new Date();
      dirty = true;
    }
    if (row.sizeBytes === 0) {
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
    await pipeline(entry.stream(), createWriteStream(abs));
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
    createdAt: b.createdAt,
    completedAt: b.completedAt,
  };
}

export function serializeSchedule(s: BackupSchedule) {
  return {
    enabled: s.enabled,
    frequency: s.frequency,
    hour: s.hour,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    cronExpr: cronExprForSchedule(s),
    lastRunAt: s.lastRunAt,
    retentionEnabled: s.retentionEnabled,
    retentionDays: s.retentionDays,
    updatedAt: s.updatedAt,
  };
}
