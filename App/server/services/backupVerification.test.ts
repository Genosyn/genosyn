import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type archiver from "archiver";
import * as archiverRuntime from "archiver";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Backup, type BackupKind, type BackupStatus } from "../db/entities/Backup.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import { BackupSchedule } from "../db/entities/BackupSchedule.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { User } from "../db/entities/User.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { getLastBackupVerification, scheduledRuns, verifyBackups } from "./backupVerification.js";
import { createDestination } from "./backupDestinations.js";
import { backupFilePath, getBackupSchedule } from "./backups.js";
import { getInstanceHealthReport } from "./instanceHealth.js";

const ZipArchive = (
  archiverRuntime as unknown as {
    ZipArchive: new (options?: archiver.ArchiverOptions) => archiver.Archiver;
  }
).ZipArchive;

type MutableConfig = { dataDir: string };
const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
let tempDir = "";
let nasDir = "";
let restorable: Buffer;
let withoutDatabase: Buffer;

/** Mid-June, clear of any daylight-saving change in the week before it. */
const NOW = new Date(2026, 5, 20, 8, 0, 0);

function day(date: number, hour = 3, minute = 0, second = 5): Date {
  return new Date(2026, 5, date, hour, minute, second);
}

async function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  const chunks: Buffer[] = [];
  zip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    zip.on("end", () => resolve());
    zip.on("error", reject);
  });
  for (const [name, body] of Object.entries(entries)) zip.append(body, { name });
  await zip.finalize();
  await done;
  return Buffer.concat(chunks);
}

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-backup-verification-"));
  mutable.dataDir = path.join(tempDir, "data");
  resetInstanceSecretsCacheForTests();
  restorable = await zipOf({ "app.sqlite": "SQLite format 3", "companies/acme/marker.txt": "x" });
  withoutDatabase = await zipOf({ "companies/acme/marker.txt": "x" });
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tempDir, "data", "Backup"), { recursive: true });
  nasDir = path.join(tempDir, "nas");
  await fs.mkdir(nasDir, { recursive: true });
  await insert(User, {
    email: "ops@example.com",
    passwordHash: "x",
    name: "Ops",
    isMasterAdmin: true,
  });
});

after(async () => {
  mutable.dataDir = originalDataDir;
  resetInstanceSecretsCacheForTests();
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** The name the backup service gives an archive taken at `at`. */
function archiveName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}.zip`;
}

async function schedule(patch: Partial<BackupSchedule>): Promise<void> {
  const row = await getBackupSchedule();
  Object.assign(row, { enabled: true, frequency: "daily", hour: 3 }, patch);
  await AppDataSource.getRepository(BackupSchedule).save(row);
}

/** A backup taken at `at`, with its archive on disk unless told otherwise. */
async function backup(
  at: Date,
  options: {
    status?: BackupStatus;
    kind?: BackupKind;
    file?: Buffer | null;
    error?: string;
  } = {},
): Promise<Backup> {
  const status = options.status ?? "completed";
  const filename = archiveName(at);
  const file = options.file === undefined ? (status === "completed" ? restorable : null) : options.file;
  if (file) await fs.writeFile(backupFilePath(filename), file);
  const row = await insert(Backup, {
    filename,
    kind: options.kind ?? "scheduled",
    status,
    sizeBytes: file?.length ?? 0,
    errorMessage: options.error ?? "",
    completedAt: status === "running" ? null : at,
  });
  // createdAt is stamped on insert; the check reads when each run happened from it.
  await AppDataSource.getRepository(Backup).update({ id: row.id }, { createdAt: at });
  return row;
}

async function nas(addedAt = day(1)): Promise<BackupDestination> {
  const dest = await createDestination({ name: "Synology", kind: "local", path: nasDir }, null);
  await AppDataSource.getRepository(BackupDestination).update({ id: dest.id }, { createdAt: addedAt });
  return dest;
}

/** Copy the archive taken at `at` to the NAS folder, as a delivery would. */
async function copyToNas(at: Date, bytes: Buffer = restorable, suffix = ""): Promise<void> {
  await fs.writeFile(path.join(nasDir, archiveName(at) + suffix), bytes);
}

function problemKeys(verification: Awaited<ReturnType<typeof verifyBackups>>): string[] {
  return verification.areas.flatMap((area) => area.problems.map((problem) => problem.key)).sort();
}

async function alertSubjects(): Promise<string[]> {
  const rows = await AppDataSource.getRepository(EmailLog).findBy({ purpose: "backup_alert" });
  return rows.map((row) => row.subject).sort();
}

describe("scheduled runs", () => {
  test("lists the runs a daily, weekly and monthly schedule fire, oldest first", async () => {
    const sched = await getBackupSchedule();
    Object.assign(sched, { enabled: true, frequency: "daily", hour: 3 });
    assert.deepEqual(scheduledRuns(sched, day(17, 8), NOW), [day(18, 3, 0, 0), day(19, 3, 0, 0), day(20, 3, 0, 0)]);

    // June 1, 2026 is a Monday.
    Object.assign(sched, { frequency: "weekly", dayOfWeek: 1 });
    assert.deepEqual(scheduledRuns(sched, day(1, 0), NOW), [
      day(1, 3, 0, 0),
      day(8, 3, 0, 0),
      day(15, 3, 0, 0),
    ]);

    Object.assign(sched, { frequency: "monthly", dayOfMonth: 5 });
    assert.deepEqual(scheduledRuns(sched, new Date(2026, 2, 10), NOW), [
      new Date(2026, 3, 5, 3),
      new Date(2026, 4, 5, 3),
      new Date(2026, 5, 5, 3),
    ]);
  });
});

describe("daily backup verification", () => {
  test("passes when every run left an archive that opens, here and on each destination", async () => {
    await schedule({});
    for (let date = 10; date <= 20; date++) await backup(day(date));
    await nas();
    for (let date = 10; date <= 19; date++) await copyToNas(day(date));

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), []);
    assert.deepEqual(
      verification.areas.map((area) => area.id === "schedule" || area.id === "server" ? area.id : "nas"),
      ["schedule", "server", "nas"],
    );
    assert.match(verification.areas[1].summary, /^11 archives on this server/);
    assert.match(verification.areas[1].summary, /7 of the 7 scheduled runs/);
    assert.match(verification.areas[2].summary, /6 of the 6 expected/);
    assert.deepEqual(await alertSubjects(), []);
    assert.equal((await getLastBackupVerification())?.verifiedAt, NOW.toISOString());
  });

  test("reports a run that never happened and one that failed, and emails master admins once", async () => {
    await schedule({});
    for (let date = 10; date <= 20; date++) {
      if (date === 16) continue;
      if (date === 17) await backup(day(date), { status: "failed", error: "No space left on device" });
      else await backup(day(date));
    }

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), [
      `failed:${day(17, 3, 0, 0).toISOString()}`,
      `missed:${day(16, 3, 0, 0).toISOString()}:${day(16, 3, 0, 0).toISOString()}`,
    ]);
    const messages = verification.areas[1].problems.map((problem) => problem.message).join("\n");
    assert.match(messages, /never ran/);
    assert.match(messages, /failed: No space left on device/);
    assert.deepEqual(await alertSubjects(), ["Backup verification found 2 problems"]);

    // The same problems the next hour: nothing new to say.
    await verifyBackups(new Date(NOW.getTime() + 60 * 60 * 1000));
    assert.equal((await alertSubjects()).length, 1);

    // A day later the next run is missed too: that is news.
    const nextDay = new Date(2026, 5, 21, 8, 0, 0);
    const later = await verifyBackups(nextDay);
    assert.ok(problemKeys(later).includes(`missed:${day(21, 3, 0, 0).toISOString()}:${day(21, 3, 0, 0).toISOString()}`));
    assert.deepEqual(await alertSubjects(), [
      "Backup verification found 2 problems",
      "Backup verification found a problem",
    ]);
    const [latest] = await AppDataSource.getRepository(EmailLog).find({
      where: { subject: "Backup verification found a problem" },
    });
    assert.match(latest.bodyPreview, /Still unresolved from earlier days/);
  });

  test("groups consecutive missed runs into one problem", async () => {
    await schedule({});
    await backup(day(10));
    for (let date = 11; date <= 15; date++) await backup(day(date));
    await backup(day(20));

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), [
      `missed:${day(16, 3, 0, 0).toISOString()}:${day(19, 3, 0, 0).toISOString()}`,
    ]);
    assert.match(verification.areas[1].problems[0].message, /^None of the 4 backups scheduled from/);
  });

  test("doesn't expect a run that is still being written", async () => {
    await schedule({});
    for (let date = 10; date <= 19; date++) await backup(day(date));
    await backup(day(20), { status: "running" });

    assert.deepEqual(problemKeys(await verifyBackups(NOW)), []);
  });

  test("finds archives gone from disk, damaged, or without the database", async () => {
    await schedule({ enabled: false });
    const gone = await backup(day(15));
    await fs.rm(backupFilePath(gone.filename));
    const damaged = await backup(day(16), { file: restorable.subarray(0, restorable.length - 30) });
    const empty = await backup(day(17), { file: withoutDatabase });
    await backup(day(18));

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), [
      `gone:${gone.filename}`,
      `no-database:${empty.filename}`,
      "schedule-off",
      `unreadable:${damaged.filename}`,
    ]);
  });

  test("finds copies missing from a destination or cut short, but not one still arriving", async () => {
    await schedule({});
    for (let date = 10; date <= 20; date++) await backup(day(date));
    const dest = await nas();
    for (const date of [13, 14, 17, 18]) await copyToNas(day(date));
    // June 15 never arrived; June 16 stopped part-way under its own name, as
    // copies killed mid-way used to; June 19 is still on its way.
    await copyToNas(day(16), restorable.subarray(0, 100));
    await copyToNas(day(19), restorable.subarray(0, 100), ".partial");

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), [
      `offbox-incomplete:${dest.id}:${archiveName(day(16))}`,
      `offbox-missing:${dest.id}:${day(15, 3, 0, 0).toISOString()}:${day(15, 3, 0, 0).toISOString()}`,
    ]);
    const nasArea = verification.areas.find((area) => area.id === dest.id)!;
    assert.match(nasArea.problems.map((p) => p.message).join("\n"), /never finished arriving/);
  });

  test("holds this server and each destination to their own retention windows", async () => {
    await schedule({
      retentionEnabled: true,
      retentionDays: 3,
      offBoxRetentionEnabled: true,
      offBoxRetentionDays: 10,
    });
    // On-box retention has deleted everything but the last three days here.
    for (let date = 17; date <= 20; date++) await backup(day(date));
    const dest = await nas();
    for (let date = 10; date <= 19; date++) if (date !== 12) await copyToNas(day(date));

    const verification = await verifyBackups(NOW);

    assert.deepEqual(problemKeys(verification), [
      `offbox-missing:${dest.id}:${day(12, 3, 0, 0).toISOString()}:${day(12, 3, 0, 0).toISOString()}`,
    ]);
  });

  test("expects nothing of a destination before it was added", async () => {
    await schedule({});
    for (let date = 10; date <= 20; date++) await backup(day(date));
    await nas(day(19, 9));
    await fs.rm(nasDir, { recursive: true });

    assert.deepEqual(problemKeys(await verifyBackups(NOW)), []);
  });

  test("reports a destination it can't look inside", async () => {
    await schedule({});
    await backup(day(20));
    const blocked = path.join(tempDir, "not-a-folder");
    await fs.writeFile(blocked, "");
    const dest = await createDestination({ name: "NAS", kind: "local", path: blocked }, null);

    const verification = await verifyBackups(NOW);

    assert.ok(problemKeys(verification).includes(`unlisted:${dest.id}`));
  });

  test("emails once more when everything is back in place", async () => {
    await schedule({});
    for (let date = 10; date <= 20; date++) await backup(day(date));
    const lost = path.join(tempDir, "lost.zip");
    await fs.rename(backupFilePath(archiveName(day(18))), lost);

    await verifyBackups(NOW);
    assert.deepEqual(await alertSubjects(), ["Backup verification found a problem"]);

    await fs.rename(lost, backupFilePath(archiveName(day(18))));
    assert.deepEqual(problemKeys(await verifyBackups(NOW)), []);
    assert.deepEqual(await alertSubjects(), [
      "Backup verification found a problem",
      "Backups are all in place again",
    ]);

    // Staying healthy stays quiet.
    await verifyBackups(NOW);
    assert.equal((await alertSubjects()).length, 2);
  });

  test("shows on the instance health report", async () => {
    await schedule({});
    const gone = await backup(day(19));
    await backup(day(20));
    await fs.rm(backupFilePath(gone.filename));
    await verifyBackups(NOW);

    const backups = (await getInstanceHealthReport()).checks.find((check) => check.id === "backups");

    assert.equal(backups?.severity, "error");
    assert.match(backups?.summary ?? "", /^Daily verification found/);
    assert.match(
      backups?.facts.find((fact) => fact.label === "Daily verification")?.value ?? "",
      /1 problem$/,
    );
  });
});
