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
  const sched = await getBackupSchedule();
  applyBackupSchedule(sched);
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
