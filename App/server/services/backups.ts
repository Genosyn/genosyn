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
import { bootCron } from "./cron.js";

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
 * UI stays approachable.
 */

const SCHEDULE_ID = "default";
const BACKUP_DIR_NAME = "Backup";

let scheduledTask: ScheduledTask | null = null;
let runningBackup: Promise<Backup> | null = null;

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
    });
    await repo.save(row);
  }
  return row;
}

export async function updateBackupSchedule(patch: {
  enabled?: boolean;
  frequency?: BackupFrequency;
  hour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
}): Promise<BackupSchedule> {
  const repo = AppDataSource.getRepository(BackupSchedule);
  const current = await getBackupSchedule();
  if (typeof patch.enabled === "boolean") current.enabled = patch.enabled;
  if (patch.frequency) current.frequency = patch.frequency;
  if (typeof patch.hour === "number") current.hour = clamp(patch.hour, 0, 23);
  if (typeof patch.dayOfWeek === "number")
    current.dayOfWeek = clamp(patch.dayOfWeek, 0, 6);
  if (typeof patch.dayOfMonth === "number")
    current.dayOfMonth = clamp(patch.dayOfMonth, 1, 28);
  await repo.save(current);
  applyBackupSchedule(current);
  return current;
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
  scheduledTask = cron.schedule(expr, () => {
    runBackup("scheduled").catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[backups] scheduled run failed:", err);
    });
  });
}

export async function bootBackups(): Promise<void> {
  ensureBackupDir();
  await reconcileBackupHistory();
  const sched = await getBackupSchedule();
  applyBackupSchedule(sched);
  await maybeRunMissedBackup(sched);
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
  const stagingDbPath = path.join(
    backupDir(),
    `.staging-${row.id}.sqlite`,
  );

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
  } catch (err) {
    row.status = "failed";
    row.errorMessage = (err as Error).message ?? String(err);
    row.completedAt = new Date();
    await repo.save(row);
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // best-effort
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
 */
function writeZip(outPath: string, sqliteSnapshot: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };

    output.on("close", () => {
      if (!failed) resolve();
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

export async function deleteBackup(id: string): Promise<boolean> {
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

    await pipeline(req, createWriteStream(outPath));

    // Sanity-check that the uploaded file is a zip archive by peeking at the
    // local file header signature (PK\x03\x04). Reject plain text / tampered
    // uploads before the user can try to restore from them.
    await assertIsZip(outPath);

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
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      // best-effort
    }
    throw err;
  }
}

async function assertIsZip(p: string): Promise<void> {
  const fd = await fs.promises.open(p, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buf, 0, 4, 0);
    if (
      bytesRead < 4 ||
      buf[0] !== 0x50 ||
      buf[1] !== 0x4b ||
      buf[2] !== 0x03 ||
      buf[3] !== 0x04
    ) {
      throw new Error("File is not a valid zip archive");
    }
  } finally {
    await fd.close();
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
let restoreInProgress = false;

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

    // Pre-restore safety snapshot. Reuses runBackup so the resulting archive
    // shows up in History — tagged `manual` because the user initiated the
    // restore that triggered it.
    const safety = await runBackup("manual");

    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;
    }
    await AppDataSource.destroy();

    wipeDataExceptBackup();
    await extractZipIntoDataRoot(zipPath);

    await AppDataSource.initialize();
    await AppDataSource.runMigrations();

    // After the restored DB comes back online it has no row for the safety
    // snapshot (or any other archive written since the restored zip was
    // taken). Stitch every zip in `Backup/` back into the `backups` table so
    // the History view reflects what's actually on disk.
    await reconcileBackupHistory();

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
    updatedAt: s.updatedAt,
  };
}
