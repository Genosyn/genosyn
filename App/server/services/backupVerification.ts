import fs from "node:fs";
import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import type { BackupSchedule } from "../db/entities/BackupSchedule.js";
import { config } from "../../config.js";
import { alertVerificationFailed, alertVerificationPassed } from "./backupAlerts.js";
import { formatBytes, recordCopiesFound } from "./backupCopies.js";
import {
  archiveTakenAt,
  type DestinationArchive,
  listDestinationArchives,
  PARTIAL_SUFFIX,
} from "./backupDestinations.js";
import {
  backupFilePath,
  checkArchive,
  getBackupSchedule,
  isRestoreInProgress,
  previousScheduledFireTime,
} from "./backups.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Daily backup verification: are the backups that should exist really there?
 *
 * Taking a backup and keeping it are different promises. A run is missed
 * while the server is down, an archive vanishes from disk or comes out
 * unreadable, a copy on a NAS is deleted there or never arrives — and each of
 * those stays invisible until the day someone needs to restore. Once a day
 * this walks every place backups are kept and holds it to the schedule and
 * the retention policy for that place: one archive per scheduled run, as far
 * back as the policy keeps them, each archive on this server opening.
 *
 * Master admins are emailed when verification finds something it hasn't
 * reported before, and once more when everything is back in place. A problem
 * keeps the same key from one verification to the next, so a missing archive
 * is reported once rather than every morning, while a run of missed backups
 * grows a new key with each one missed.
 */

export type BackupVerificationProblem = {
  /** Stable from one verification to the next, so a problem is emailed once. */
  key: string;
  severity: "error" | "warn";
  message: string;
};

export type BackupVerificationArea = {
  /** "schedule", "server", or a destination's id. */
  id: string;
  title: string;
  /** What verification found there, good or bad, in a sentence. */
  summary: string;
  problems: BackupVerificationProblem[];
};

export type BackupVerification = {
  verifiedAt: string;
  areas: BackupVerificationArea[];
};

type StoredVerification = { verification: BackupVerification; notifiedKeys: string[] };

const VERIFICATION_SETTING_KEY = "backup_verification";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Hours after the scheduled backup hour verification runs, for the run and its copies to land. */
const VERIFY_DELAY_HOURS = 4;
/** Verification this overdue runs at the next hourly tick — the server was down when it was due. */
const VERIFY_OVERDUE_MS = 26 * 60 * 60 * 1000;
/** How far back runs are verified in a place without a retention policy of its own. */
export const DEFAULT_LOOKBACK_DAYS = 7;
/** A run this recent may still be writing its archive, so none is expected yet. */
const RUN_GRACE_MS = 60 * 60 * 1000;
/** A `running` row this recent is a backup still being written, not one that died. */
const RUN_IN_PROGRESS_MS = 12 * 60 * 60 * 1000;
/** Copies of a run are only expected on a destination after this — big ones take hours. */
const DELIVERY_GRACE_MS = 12 * 60 * 60 * 1000;
/** A partial copy of a run this recent is a delivery still under way. */
const PARTIAL_IN_PROGRESS_MS = 2 * DAY_MS;
/** Archives on this server opened per verification, newest first; older ones are only looked for. */
const MAX_ARCHIVES_OPENED = 60;
/** Scheduled runs examined per place: daily for ten years, and a bound on the loop. */
const MAX_RUNS = 4000;

let verifyTask: ScheduledTask | null = null;
let runningVerification: Promise<BackupVerification> | null = null;

/** Scheduled run times after `from` and no later than `to`, oldest first. */
export function scheduledRuns(sched: BackupSchedule, from: Date, to: Date): Date[] {
  const runs: Date[] = [];
  let cursor = previousScheduledFireTime(sched, to);
  while (cursor.getTime() > from.getTime() && runs.length < MAX_RUNS) {
    runs.push(cursor);
    cursor = previousScheduledFireTime(sched, new Date(cursor.getTime() - 1));
  }
  return runs.reverse();
}

/**
 * Verify the backups now, store what was found, and email master admins about
 * anything new. Concurrent callers share one run.
 */
export async function verifyBackups(now = new Date()): Promise<BackupVerification> {
  if (runningVerification) return runningVerification;
  runningVerification = verifyBackupsInner(now).finally(() => {
    runningVerification = null;
  });
  return runningVerification;
}

/** The last verification, or null before the first one. */
export async function getLastBackupVerification(): Promise<BackupVerification | null> {
  return (await readStoredVerification())?.verification ?? null;
}

/**
 * Tick hourly and verify once a day, {@link VERIFY_DELAY_HOURS} after the
 * scheduled backup hour — or at the next tick when the last verification is
 * overdue. The hour is read at each tick, so a schedule change needs no
 * re-registration.
 */
export function bootBackupVerification(): void {
  if (config.security.multiTenant) return;
  stopBackupVerification();
  verifyTask = cron.schedule(
    "30 * * * *",
    () => {
      withSchedulerLease("backup-verification", 60 * 60_000, () => verifyBackupsIfDue()).catch(
        (err) => {
          // eslint-disable-next-line no-console
          console.error("[backups] daily verification failed:", err);
        },
      );
    },
    { name: "backup-verification" },
  );
}

export function stopBackupVerification(): void {
  verifyTask?.stop();
  verifyTask = null;
}

async function verifyBackupsIfDue(): Promise<void> {
  if (isRestoreInProgress()) return;
  const now = new Date();
  const sched = await getBackupSchedule();
  const last = await getLastBackupVerification();
  const overdue =
    !last || now.getTime() - new Date(last.verifiedAt).getTime() >= VERIFY_OVERDUE_MS;
  if (now.getHours() !== (sched.hour + VERIFY_DELAY_HOURS) % 24 && !overdue) return;
  await verifyBackups(now);
}

async function verifyBackupsInner(now: Date): Promise<BackupVerification> {
  const sched = await getBackupSchedule();
  // Newest first, like History.
  const rows = await AppDataSource.getRepository(Backup).find({ order: { createdAt: "DESC" } });
  const destinations = await AppDataSource.getRepository(BackupDestination).find({
    where: { enabled: true },
    order: { createdAt: "ASC" },
  });

  const areas: BackupVerificationArea[] = [
    verifySchedule(sched),
    await verifyServer(sched, rows, now),
  ];
  for (const dest of destinations) areas.push(await verifyDestination(dest, sched, rows, now));
  const verification: BackupVerification = { verifiedAt: now.toISOString(), areas };

  const problems = areas.flatMap((area) => area.problems);
  const previous = await readStoredVerification();
  const notified = new Set(previous?.notifiedKeys ?? []);
  const fresh = problems.filter((problem) => !notified.has(problem.key));
  // Written before the emails go out: a send that hangs must not leave the
  // next verification thinking nobody was told.
  await writeStoredVerification({
    verification,
    notifiedKeys: problems.map((problem) => problem.key),
  });
  if (fresh.length > 0) {
    await alertVerificationFailed(problems, new Set(fresh.map((problem) => problem.key)));
  } else if (problems.length === 0 && notified.size > 0) {
    await alertVerificationPassed();
  }
  return verification;
}

function verifySchedule(sched: BackupSchedule): BackupVerificationArea {
  const area: BackupVerificationArea = {
    id: "schedule",
    title: "Schedule",
    summary: `${describeSchedule(sched)}.`,
    problems: [],
  };
  if (!sched.enabled) {
    area.summary = "Recurring backups are off.";
    area.problems.push({
      key: "schedule-off",
      severity: "warn",
      message: "Recurring backups are off, so nothing is backed up unless someone does it by hand.",
    });
  }
  return area;
}

/**
 * The archives on this server: each one in History still on disk and opening,
 * and — while the schedule is on — one for every scheduled run in the on-box
 * retention window (the last {@link DEFAULT_LOOKBACK_DAYS} days without one).
 */
async function verifyServer(
  sched: BackupSchedule,
  rows: Backup[],
  now: Date,
): Promise<BackupVerificationArea> {
  const problems: BackupVerificationProblem[] = [];
  let present = 0;
  let opened = 0;
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const abs = backupFilePath(row.filename);
    if (!fs.existsSync(abs)) {
      problems.push({
        key: `gone:${row.filename}`,
        severity: "error",
        message: `${row.filename}, taken ${formatWhen(row.createdAt)}, is in History but its file is gone from this server.`,
      });
      continue;
    }
    present += 1;
    if (opened >= MAX_ARCHIVES_OPENED) continue;
    opened += 1;
    const verdict = await checkArchive(abs);
    if (verdict === "unreadable") {
      problems.push({
        key: `unreadable:${row.filename}`,
        severity: "error",
        message: `${row.filename}, taken ${formatWhen(row.createdAt)}, doesn't open — it is damaged or incomplete.`,
      });
    } else if (verdict === "no-database") {
      problems.push({
        key: `no-database:${row.filename}`,
        severity: "error",
        message: `${row.filename}, taken ${formatWhen(row.createdAt)}, has no database in it and can't restore this install.`,
      });
    }
  }

  const taken = rows.filter((row) => row.kind !== "uploaded");
  const parts = [`${present} archive${present === 1 ? "" : "s"} on this server`];
  const newest = taken.find((row) => row.status === "completed");
  if (newest) parts.push(`the newest taken ${formatWhen(newest.createdAt)}`);

  if (sched.enabled) {
    const windowDays = sched.retentionEnabled ? sched.retentionDays : DEFAULT_LOOKBACK_DAYS;
    const since = new Date(
      Math.max(now.getTime() - windowDays * DAY_MS, startOfBackups(sched, taken).getTime()),
    );
    const runs = scheduledRuns(sched, since, now);
    const missed: Date[] = [];
    let expected = 0;
    let failed = 0;
    runs.forEach((run, i) => {
      if (run.getTime() > now.getTime() - RUN_GRACE_MS) return;
      expected += 1;
      const end = runs[i + 1] ?? now;
      const during = taken.filter((row) => within(row.createdAt, run, end));
      if (during.some((row) => row.status === "completed")) return;
      const running = during.some(
        (row) =>
          row.status === "running" && now.getTime() - row.createdAt.getTime() < RUN_IN_PROGRESS_MS,
      );
      if (running) return;
      const failure = during.find((row) => row.status === "failed");
      if (failure) {
        failed += 1;
        problems.push({
          key: `failed:${run.toISOString()}`,
          severity: "error",
          message: `The backup scheduled for ${formatWhen(run)} failed: ${failure.errorMessage || "unknown error"}.`,
        });
      } else {
        missed.push(run);
      }
    });
    for (const range of consecutiveRuns(runs, missed)) {
      problems.push({
        key: `missed:${range[0].toISOString()}:${range[range.length - 1].toISOString()}`,
        severity: "error",
        message:
          range.length === 1
            ? `The backup scheduled for ${formatWhen(range[0])} never ran.`
            : `None of the ${range.length} backups scheduled from ${formatWhen(range[0])} to ${formatWhen(range[range.length - 1])} ran.`,
      });
    }
    if (expected > 0) {
      const ran = expected - missed.length - failed;
      parts.push(`${ran} of the ${expected} scheduled runs since ${formatWhen(since)} produced one`);
    }
  }

  return {
    id: "server",
    title: "This server",
    summary: `${capitalize(parts.join("; "))}.`,
    problems,
  };
}

/**
 * The copies on one destination: one for every scheduled run in the off-box
 * retention window (the last {@link DEFAULT_LOOKBACK_DAYS} days without one)
 * since the destination was added, each the size of the archive it copies
 * while that archive is still on this server. A run this server has no backup
 * from at all is left to {@link verifyServer}, which reports the cause.
 */
async function verifyDestination(
  dest: BackupDestination,
  sched: BackupSchedule,
  rows: Backup[],
  now: Date,
): Promise<BackupVerificationArea> {
  const area: BackupVerificationArea = { id: dest.id, title: dest.name, summary: "", problems: [] };
  let archives: DestinationArchive[];
  try {
    archives = await listDestinationArchives(dest);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    area.summary = "Couldn't be looked inside.";
    area.problems.push({
      key: `unlisted:${dest.id}`,
      severity: "error",
      message: `Couldn't look inside ${dest.name} to verify its backups: ${message}`,
    });
    return area;
  }

  // A copy that stopped short of its archive's size — what a delivery killed
  // mid-way used to leave under the archive's own name — is no backup.
  const taken = rows.filter((row) => row.kind !== "uploaded");
  const sizes = localArchiveSizes(taken);

  // What is really there, recorded against each backup for History — the only
  // way a backup taken before copies were recorded learns where it is.
  const whole = new Map<string, number>();
  const partial = new Set<string>();
  for (const archive of archives) {
    if (archive.name.endsWith(PARTIAL_SUFFIX)) {
      partial.add(archive.name.slice(0, -PARTIAL_SUFFIX.length));
    } else {
      whole.set(archive.name, archive.size);
    }
  }
  try {
    await recordCopiesFound({
      destinationId: dest.id,
      backups: rows,
      whole,
      partial,
      localSizes: sizes,
      now,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[backups] could not record the copies found on "${dest.name}":`,
      (err as Error)?.message ?? err,
    );
  }
  const copies: Date[] = [];
  const cutShort: Date[] = [];
  const partials: Date[] = [];
  for (const archive of archives) {
    const at = archiveTakenAt(archive.name);
    if (!at) continue;
    if (archive.name.endsWith(PARTIAL_SUFFIX)) {
      partials.push(at);
      continue;
    }
    const size = sizes.get(archive.name);
    if (size !== undefined && archive.size !== size) {
      cutShort.push(at);
      area.problems.push({
        key: `offbox-incomplete:${dest.id}:${archive.name}`,
        severity: "error",
        message: `${dest.name}'s copy of ${archive.name} is ${formatBytes(archive.size)}, but the backup is ${formatBytes(size)} — it never finished arriving.`,
      });
      continue;
    }
    copies.push(at);
  }
  const newest = copies.reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
  const parts = [`${copies.length} backup${copies.length === 1 ? "" : "s"} there`];
  if (newest) parts.push(`the newest taken ${formatWhen(newest)}`);

  if (sched.enabled) {
    // Its own copies are evidence too: on-box retention may have deleted the
    // rows of backups a destination still keeps.
    const oldestCopy = copies.concat(cutShort).reduce<Date | null>(
      (a, b) => (!a || b < a ? b : a),
      null,
    );
    const started = startOfBackups(sched, taken, oldestCopy);
    const windowDays = sched.offBoxRetentionEnabled
      ? sched.offBoxRetentionDays
      : DEFAULT_LOOKBACK_DAYS;
    const since = new Date(
      Math.max(
        now.getTime() - windowDays * DAY_MS,
        started.getTime(),
        new Date(dest.createdAt).getTime(),
      ),
    );
    // History is complete from here on: on-box retention deletes rows only
    // past its own window, so before it a run without a row may have had one.
    const historyFrom = sched.retentionEnabled
      ? Math.max(now.getTime() - sched.retentionDays * DAY_MS, started.getTime())
      : started.getTime();
    const runs = scheduledRuns(sched, since, now);
    const missing: Date[] = [];
    let expected = 0;
    runs.forEach((run, i) => {
      if (run.getTime() > now.getTime() - DELIVERY_GRACE_MS) return;
      const end = runs[i + 1] ?? now;
      const backedUp = taken.some(
        (row) => row.status === "completed" && within(row.createdAt, run, end),
      );
      if (run.getTime() >= historyFrom && !backedUp) return;
      expected += 1;
      if (copies.some((at) => within(at, run, end))) return;
      // Already reported, as a copy that never finished.
      if (cutShort.some((at) => within(at, run, end))) return;
      const underway =
        now.getTime() - run.getTime() < PARTIAL_IN_PROGRESS_MS &&
        partials.some((at) => within(at, run, end));
      if (!underway) missing.push(run);
    });
    for (const range of consecutiveRuns(runs, missing)) {
      area.problems.push({
        key: `offbox-missing:${dest.id}:${range[0].toISOString()}:${range[range.length - 1].toISOString()}`,
        severity: "error",
        message:
          range.length === 1
            ? `${dest.name} has no copy of the backup from ${formatWhen(range[0])}.`
            : `${dest.name} is missing the ${range.length} backups from ${formatWhen(range[0])} to ${formatWhen(range[range.length - 1])}.`,
      });
    }
    if (expected > 0) {
      const arrived = expected - missing.length;
      parts.push(`${arrived} of the ${expected} expected since ${formatWhen(since)}`);
    }
  }
  area.summary = `${capitalize(parts.join("; "))}.`;
  return area;
}

/** The size of each archive this server still holds, by filename. */
function localArchiveSizes(taken: Backup[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const row of taken) {
    if (row.status !== "completed") continue;
    try {
      sizes.set(row.filename, fs.statSync(backupFilePath(row.filename)).size);
    } catch {
      // Gone from this server: nothing to hold a copy's size to.
    }
  }
  return sizes;
}

/**
 * When this install started backing up, as far as can be told: its oldest
 * backup in History or `evidence` of an older one, or — before there is any —
 * the last time the schedule was saved, which is when it was turned on. Runs
 * before then were never expected.
 */
function startOfBackups(sched: BackupSchedule, taken: Backup[], evidence: Date | null = null): Date {
  const first = taken[taken.length - 1]?.createdAt ?? null;
  if (first && evidence) return first < evidence ? first : evidence;
  return first ?? evidence ?? sched.updatedAt;
}

/** `missing` (a subset of `runs`) split into runs of consecutive scheduled runs. */
function consecutiveRuns(runs: Date[], missing: Date[]): Date[][] {
  const gone = new Set(missing.map((run) => run.getTime()));
  const ranges: Date[][] = [];
  let current: Date[] = [];
  for (const run of runs) {
    if (gone.has(run.getTime())) {
      current.push(run);
    } else if (current.length > 0) {
      ranges.push(current);
      current = [];
    }
  }
  if (current.length > 0) ranges.push(current);
  return ranges;
}

function within(at: Date, from: Date, to: Date): boolean {
  return at.getTime() >= from.getTime() && at.getTime() < to.getTime();
}

function describeSchedule(sched: BackupSchedule): string {
  const at = `${String(sched.hour).padStart(2, "0")}:00`;
  if (sched.frequency === "weekly") {
    const day = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][
      sched.dayOfWeek
    ];
    return `Backs up on ${day ?? "one day a week"} at ${at}`;
  }
  if (sched.frequency === "monthly") return `Backs up on day ${sched.dayOfMonth} of each month at ${at}`;
  return `Backs up every day at ${at}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatWhen(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

async function readStoredVerification(): Promise<StoredVerification | null> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: VERIFICATION_SETTING_KEY,
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as StoredVerification;
    return parsed?.verification?.verifiedAt ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStoredVerification(stored: StoredVerification): Promise<void> {
  await AppDataSource.getRepository(AppSetting).upsert(
    { key: VERIFICATION_SETTING_KEY, value: JSON.stringify(stored) },
    ["key"],
  );
}
