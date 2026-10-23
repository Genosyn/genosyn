import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  archiveTakenAt,
  createDestination,
  deliverBackupToDestinations,
  expiredArchives,
  parseSmbListing,
  smbDeliverTimeoutMs,
  smbErrorMessage,
  testDestination,
  updateDestination,
} from "./backupDestinations.js";
import { runBackup, serializeSchedule, updateBackupSchedule } from "./backups.js";
import { getInstanceHealthReport } from "./instanceHealth.js";

type MutableConfig = {
  dataDir: string;
  db: { driver: "sqlite" | "postgres" };
};

const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;
const DAY_MS = 24 * 60 * 60 * 1000;
let tempDir = "";
let nasDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-destinations-"));
  mutable.dataDir = path.join(tempDir, "data");
  // The test DB is in-memory, so there is no SQLite file to snapshot.
  mutable.db.driver = "postgres";
  resetInstanceSecretsCacheForTests();
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tempDir, "data"), { recursive: true });
  nasDir = path.join(tempDir, "nas");
  await fs.mkdir(nasDir, { recursive: true });
});

after(async () => {
  mutable.dataDir = originalDataDir;
  mutable.db.driver = originalDriver;
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

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** A freshly taken archive, outside any destination. */
async function freshArchive(): Promise<{ filename: string; absPath: string }> {
  const filename = archiveName(new Date());
  const dir = path.join(tempDir, "source");
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, filename);
  await fs.writeFile(absPath, "archive bytes");
  return { filename, absPath };
}

async function destinationRow(id: string): Promise<BackupDestination> {
  return AppDataSource.getRepository(BackupDestination).findOneByOrFail({ id });
}

/** Subjects of the backup alerts sent so far, sorted: rows written the same second have no order. */
async function alertSubjects(): Promise<string[]> {
  const rows = await AppDataSource.getRepository(EmailLog).findBy({ purpose: "backup_alert" });
  return rows.map((row) => row.subject).sort();
}

async function masterAdmin(email: string, companySlug?: string): Promise<User> {
  const user = await insert(User, {
    email,
    passwordHash: "x",
    name: email,
    isMasterAdmin: true,
  });
  if (companySlug) {
    const company = await insert(Company, { name: companySlug, slug: companySlug, ownerId: user.id });
    await insert(Membership, { companyId: company.id, userId: user.id, role: "owner" });
  }
  return user;
}

describe("off-box retention", () => {
  test("reads when an archive was taken from its name, and nothing from any other file", () => {
    assert.deepEqual(archiveTakenAt("backup-2026-10-21-031500.zip"), new Date(2026, 9, 21, 3, 15));
    assert.deepEqual(
      archiveTakenAt("backup-2026-10-21-031500.zip.partial"),
      new Date(2026, 9, 21, 3, 15),
    );
    assert.equal(archiveTakenAt("uploaded-2026-10-21-031500.zip"), null);
    assert.equal(archiveTakenAt("backup-2026-10-21-031500 copy.zip"), null);
    assert.equal(archiveTakenAt("backup-2026-10-21-031500.zip.part"), null);
    assert.equal(archiveTakenAt(".genosyn-write-test"), null);
  });

  test("expires archives taken before the cutoff, but never the one just delivered", () => {
    const names = [
      "backup-2026-08-01-030000.zip",
      "backup-2026-08-02-030000.zip.partial",
      "backup-2026-09-01-030000.zip",
      "backup-2026-10-20-030000.zip",
      "backup-2026-10-21-030000.zip.partial",
      "uploaded-2026-08-01-030000.zip",
      "backup-2026-08-01-030000 copy.zip",
      "notes.txt",
    ];
    assert.deepEqual(
      expiredArchives(names, new Date(2026, 9, 1), "backup-2026-09-01-030000.zip"),
      ["backup-2026-08-01-030000.zip", "backup-2026-08-02-030000.zip.partial"],
    );
  });

  test("finds the archives and their sizes in an smbclient listing, and nothing else", () => {
    // What smbclient 4.17, the version in the image, printed for
    // `ls "Genosyn/Nightly/backup-*.zip*"` against a Samba share.
    const listing = [
      "  backup-2026-08-01-030000.zip        N        2  Thu Oct 22 07:09:18 2026",
      "  backup-2026-08-02-030000.zip.partial      N        2  Thu Oct 22 07:09:18 2026",
      "  backup-2026-10-21-030000.zip        A   300000  Thu Oct 22 07:06:16 2026",
      "  backup-2026-08-03-030000.zip copy.zip      N        2  Thu Oct 22 07:09:18 2026",
      "",
      "\t\t1798303516 blocks of size 1024. 1312955988 blocks available",
    ].join("\n");
    assert.deepEqual(parseSmbListing(listing), [
      { name: "backup-2026-08-01-030000.zip", size: 2 },
      { name: "backup-2026-08-02-030000.zip.partial", size: 2 },
      { name: "backup-2026-10-21-030000.zip", size: 300000 },
    ]);
  });

  test("deletes expired archives from a destination once a copy lands there", async () => {
    const old = archiveName(daysAgo(40));
    const recent = archiveName(daysAgo(10));
    // What a copy cut short by a restart leaves behind.
    const interrupted = `${archiveName(daysAgo(35))}.partial`;
    for (const name of [old, interrupted, recent, "uploaded-2025-01-01-000000.zip", "notes.txt"]) {
      await fs.writeFile(path.join(nasDir, name), name);
    }
    await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const { filename, absPath } = await freshArchive();

    const [result] = await deliverBackupToDestinations(filename, absPath, { days: 30 });

    assert.equal(result.ok, true);
    assert.deepEqual(
      (await fs.readdir(nasDir)).sort(),
      [filename, recent, "notes.txt", "uploaded-2025-01-01-000000.zip"].sort(),
    );
  });

  test("leaves every archive on a destination while the off-box policy is off", async () => {
    const old = archiveName(daysAgo(400));
    await fs.writeFile(path.join(nasDir, old), old);
    await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const { filename, absPath } = await freshArchive();

    await deliverBackupToDestinations(filename, absPath, null);

    assert.deepEqual((await fs.readdir(nasDir)).sort(), [filename, old].sort());
  });

  test("copies under a .partial name and renames it into place, replacing a re-sent archive", async () => {
    await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const { filename, absPath } = await freshArchive();
    await fs.writeFile(path.join(nasDir, filename), "a copy that broke off");

    const [result] = await deliverBackupToDestinations(filename, absPath, null);

    assert.equal(result.ok, true);
    assert.deepEqual(await fs.readdir(nasDir), [filename]);
    assert.equal(await fs.readFile(path.join(nasDir, filename), "utf8"), "archive bytes");
  });

  test("applies the off-box policy saved on the schedule, apart from the on-box one", async () => {
    const { schedule } = await updateBackupSchedule({
      offBoxRetentionEnabled: true,
      offBoxRetentionDays: 7,
    });
    assert.equal(serializeSchedule(schedule).offBoxRetentionEnabled, true);
    assert.equal(serializeSchedule(schedule).offBoxRetentionDays, 7);
    assert.equal(schedule.retentionEnabled, false);

    const old = archiveName(daysAgo(8));
    const recent = archiveName(daysAgo(6));
    await fs.writeFile(path.join(nasDir, old), old);
    await fs.writeFile(path.join(nasDir, recent), recent);
    await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);

    const backup = await runBackup("manual");

    assert.equal(backup.status, "completed");
    assert.deepEqual((await fs.readdir(nasDir)).sort(), [backup.filename, recent].sort());
  });

  test("clamps the off-box policy to the same bounds as the on-box one", async () => {
    const { schedule } = await updateBackupSchedule({ offBoxRetentionDays: 99_999 });
    assert.equal(schedule.offBoxRetentionDays, 3650);
    assert.equal(schedule.offBoxRetentionEnabled, false);
  });
});

describe("SMB delivery", () => {
  const nas = { host: "nas.tail", share: "backups", encrypt: true };

  test("gives a big archive as long as a slow link needs instead of half an hour", () => {
    assert.equal(smbDeliverTimeoutMs(0), 30 * 60_000);
    // A 50 GB archive at the 2 MB/s floor: 25,600 s on top of the half hour.
    assert.equal(smbDeliverTimeoutMs(50 * 1024 ** 3), 30 * 60_000 + 25_600_000);
  });

  test("calls a link that drops mid-copy what it is, not an encryption problem", () => {
    // smbclient 4.17's output when the server went away 32 MB into a put.
    const dropped = Object.assign(new Error("Command failed"), {
      stdout: "NT_STATUS_CONNECTION_DISCONNECTED closing remote file \\Genosyn\\Nightly\\backup-2026-10-22-030000.zip.partial\n",
      stderr: "cli_push returned NT_STATUS_CONNECTION_DISCONNECTED\n",
    });
    assert.equal(
      smbErrorMessage(dropped, nas),
      "The connection to nas.tail dropped part-way through the copy",
    );
  });

  test("says when the share is full", () => {
    const full = Object.assign(new Error("Command failed"), {
      stderr: "cli_push returned NT_STATUS_DISK_FULL\n",
    });
    assert.match(smbErrorMessage(full, nas), /^The share on nas.tail is full/);
  });

  test("names a copy that ran out of time by how long it had", () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true });
    assert.equal(smbErrorMessage(killed, nas, "too slow"), "too slow");
    assert.equal(smbErrorMessage(killed, nas), "Timed out talking to the SMB server");
  });
});

describe("failed off-box deliveries", () => {
  test("record every attempt and when the run of failures began", async () => {
    // A file where the folder should be: every copy into it fails.
    const blocked = path.join(tempDir, "not-a-folder");
    await fs.writeFile(blocked, "");
    const dest = await createDestination({ name: "NAS", kind: "local", path: blocked }, null);
    const { filename, absPath } = await freshArchive();

    const [first] = await deliverBackupToDestinations(filename, absPath, null);
    assert.equal(first.ok, false);
    const failed = await destinationRow(dest.id);
    assert.equal(failed.lastStatus, "error");
    assert.ok(failed.lastError);
    assert.ok(failed.failingSince);
    assert.deepEqual(failed.lastAttemptAt, failed.failingSince);
    assert.equal(failed.lastSyncedAt, null);

    await deliverBackupToDestinations(filename, absPath, null);
    const again = await destinationRow(dest.id);
    assert.deepEqual(again.failingSince, failed.failingSince);
    assert.ok(again.lastAttemptAt!.getTime() >= failed.lastAttemptAt!.getTime());
  });

  test("email master admins when they start, daily while they last, and once they stop", async () => {
    const FAILING = "Off-box backups to Synology are failing";
    const RECOVERED = "Off-box backups to Synology are working again";
    await masterAdmin("ops@example.com", "acme");
    await insert(User, { email: "member@example.com", passwordHash: "x", name: "Member" });
    const blocked = path.join(tempDir, "not-a-folder");
    await fs.writeFile(blocked, "");
    const dest = await createDestination({ name: "Synology", kind: "local", path: blocked }, null);
    const { filename, absPath } = await freshArchive();

    await deliverBackupToDestinations(filename, absPath, null);
    const [email] = await AppDataSource.getRepository(EmailLog).findBy({ purpose: "backup_alert" });
    assert.equal(email.toAddress, "ops@example.com");
    assert.equal(email.companyId, null);
    assert.match(email.bodyPreview, /\/c\/acme\/admin\/backup/);
    assert.deepEqual(await alertSubjects(), [FAILING]);

    // A second failure the same day adds to the run without another email.
    await deliverBackupToDestinations(filename, absPath, null);
    assert.deepEqual(await alertSubjects(), [FAILING]);

    // A day after the last email, the next failure reminds them.
    await AppDataSource.getRepository(BackupDestination).update(
      { id: dest.id },
      { lastAlertedAt: daysAgo(1.1) },
    );
    await deliverBackupToDestinations(filename, absPath, null);
    assert.deepEqual(await alertSubjects(), [FAILING, FAILING]);

    await updateDestination(dest.id, { path: nasDir });
    const [ok] = await deliverBackupToDestinations(filename, absPath, null);
    assert.equal(ok.ok, true);
    const recovered = await destinationRow(dest.id);
    assert.equal(recovered.lastStatus, "ok");
    assert.equal(recovered.failingSince, null);
    assert.equal(recovered.lastAlertedAt, null);
    assert.ok(recovered.lastSyncedAt);
    assert.deepEqual(await alertSubjects(), [FAILING, FAILING, RECOVERED]);

    // Healthy deliveries stay quiet.
    await deliverBackupToDestinations(filename, absPath, null);
    assert.equal((await alertSubjects()).length, 3);
  });

  test("stay on the destination when a connection test passes", async () => {
    const blocked = path.join(tempDir, "not-a-folder");
    await fs.writeFile(blocked, "");
    const dest = await createDestination({ name: "NAS", kind: "local", path: blocked }, null);
    const { filename, absPath } = await freshArchive();
    await deliverBackupToDestinations(filename, absPath, null);
    const failed = await destinationRow(dest.id);

    // The folder works now, but no backup has been copied there yet.
    await fs.rm(blocked);
    const check = await testDestination(dest.id);

    assert.ok(check, "the destination exists");
    assert.equal(check.ok, true);
    assert.equal(check.stillFailing, true);
    assert.match(check.message, /still failing/);
    const row = await destinationRow(dest.id);
    assert.equal(row.lastStatus, "error");
    assert.equal(row.lastError, failed.lastError);
    assert.deepEqual(row.failingSince, failed.failingSince);
    assert.ok(row.lastCheckedAt);
  });

  test("show on the instance health report", async () => {
    const offBox = async () =>
      (await getInstanceHealthReport()).checks.find((check) => check.id === "offbox_backups");

    const none = await offBox();
    assert.equal(none?.severity, "ok");
    assert.match(none?.summary ?? "", /No off-box destination/);

    await createDestination({ name: "Spare disk", kind: "local", path: nasDir }, null);
    const blocked = path.join(tempDir, "not-a-folder");
    await fs.writeFile(blocked, "");
    await createDestination({ name: "Synology", kind: "local", path: blocked }, null);
    // A switched-off destination is no one's concern, however it last went.
    const retired = await createDestination(
      { name: "Retired", kind: "local", path: blocked, enabled: false },
      null,
    );
    await AppDataSource.getRepository(BackupDestination).update(
      { id: retired.id },
      { lastStatus: "error", lastError: "gone", failingSince: daysAgo(90) },
    );
    const { filename, absPath } = await freshArchive();
    await deliverBackupToDestinations(filename, absPath, null);

    const failing = await offBox();
    assert.equal(failing?.severity, "error");
    assert.match(failing?.summary ?? "", /"Synology"/);
    const facts = new Map(failing?.facts.map((fact) => [fact.label, fact.value]));
    assert.deepEqual([...facts.keys()].sort(), ["Spare disk", "Synology"]);
    assert.match(facts.get("Spare disk") ?? "", /^Healthy · last copy/);
    assert.match(facts.get("Synology") ?? "", /^Failing since/);
  });
});
