import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupCopy } from "../db/entities/BackupCopy.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { holdCopies } from "../test/backupCopyGate.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  COPY_IN_FLIGHT,
  INTERRUPTED_COPY_ERROR,
  markCopiesPending,
  recordCopiesFound,
  recoverInterruptedCopies,
  unqueueCopy,
} from "./backupCopies.js";
import {
  createDestination,
  deleteDestination,
  deliverBackupToDestinations,
  isBackupBeingCopied,
  isDeliveryRunning,
  updateDestination,
} from "./backupDestinations.js";
import {
  backupFilePath,
  bootBackups,
  deleteBackup,
  isBackupRunning,
  listBackupHistory,
  pruneOldBackups,
  restoreFromBackup,
  runBackup,
  startBackup,
  startCopy,
  updateBackupSchedule,
} from "./backups.js";
import { verifyBackups } from "./backupVerification.js";

/**
 * Where each backup's off-box copies stand (`BackupCopy`), which is what lets
 * History say where a backup lives. Covers the copies a backup run records,
 * copying an existing backup now (to all destinations or to one), what a
 * paused or removed destination does to a copy waiting its turn, off-box
 * retention, a restart mid-copy, and what daily verification records —
 * including for backups taken before copies were recorded, which it alone may
 * fill in and only with what it finds.
 */

type MutableConfig = { dataDir: string; db: { driver: "sqlite" | "postgres" } };
const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;
const DAY_MS = 24 * 60 * 60 * 1000;
let tempDir = "";
let nasDir = "";
let spareDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-copies-"));
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
  spareDir = path.join(tempDir, "spare");
  await fs.mkdir(nasDir, { recursive: true });
  await fs.mkdir(spareDir, { recursive: true });
});

afterEach(async () => {
  // Nothing a test started may still be writing when the next one resets.
  await waitUntil(() => !isBackupRunning() && !isDeliveryRunning(), "background work to settle");
});

after(async () => {
  mutable.dataDir = originalDataDir;
  mutable.db.driver = originalDriver;
  resetInstanceSecretsCacheForTests();
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

/** A backup row taken at `takenAt` (createdAt is stamped on insert, so set after). */
async function backupRow(values: Partial<Backup> & { takenAt: Date }): Promise<Backup> {
  const { takenAt, ...rest } = values;
  const row = await insert(Backup, {
    filename: archiveName(takenAt),
    kind: "manual",
    status: "completed",
    errorMessage: "",
    copiesTracked: true,
    completedAt: takenAt,
    ...rest,
  });
  await AppDataSource.getRepository(Backup).update({ id: row.id }, { createdAt: takenAt });
  return AppDataSource.getRepository(Backup).findOneByOrFail({ id: row.id });
}

/** A backup row with its archive on this server, as History would hold it. */
async function backupOnServer(
  values: Partial<Backup> & { takenAt?: Date; bytes?: string } = {},
): Promise<Backup> {
  const { bytes: given, takenAt = daysAgo(1), ...rest } = values;
  const filename = rest.filename ?? archiveName(takenAt);
  const bytes = given ?? `archive ${filename}`;
  await fs.mkdir(path.dirname(backupFilePath(filename)), { recursive: true });
  await fs.writeFile(backupFilePath(filename), bytes);
  return backupRow({ ...rest, filename, takenAt, sizeBytes: Buffer.byteLength(bytes) });
}

/** Copies go to destinations oldest first: pin that order, whatever second each was added. */
async function inOrder(...destinations: BackupDestination[]): Promise<void> {
  const base = Date.now() - destinations.length * 60_000;
  for (const [i, dest] of destinations.entries()) {
    await AppDataSource.getRepository(BackupDestination).update(
      { id: dest.id },
      { createdAt: new Date(base + i * 60_000) },
    );
  }
}

/** Boot runs its scheduler leases in-process only under the SQLite driver. */
async function withSqliteDriver<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutable.db.driver;
  mutable.db.driver = "sqlite";
  try {
    return await fn();
  } finally {
    mutable.db.driver = previous;
  }
}

async function copiesOf(backupId: string): Promise<BackupCopy[]> {
  return AppDataSource.getRepository(BackupCopy).find({
    where: { backupId },
    order: { createdAt: "ASC" },
  });
}

async function copyAt(backupId: string, destinationId: string): Promise<BackupCopy | null> {
  return AppDataSource.getRepository(BackupCopy).findOneBy({ backupId, destinationId });
}

/** A local destination whose folder is a file, so every copy into it fails. */
async function blockedDestination(name: string) {
  const blocked = path.join(tempDir, `${name}-not-a-folder`);
  await fs.writeFile(blocked, "");
  return createDestination({ name, kind: "local", path: blocked }, null);
}

describe("copies a backup run records", () => {
  test("every enabled destination gets a copy row, copied or failed with its reason", async () => {
    const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const broken = await blockedDestination("Broken");
    const paused = await createDestination(
      { name: "Paused", kind: "local", path: spareDir, enabled: false },
      null,
    );

    const backup = await runBackup("manual");

    assert.equal(backup.copiesTracked, true);
    const copies = await copiesOf(backup.id);
    assert.deepEqual(copies.map((copy) => copy.destinationId).sort(), [nas.id, broken.id].sort());
    const ok = copies.find((copy) => copy.destinationId === nas.id)!;
    assert.equal(ok.status, "copied");
    assert.equal(ok.error, "");
    assert.ok(ok.copiedAt, "a copy that arrived says when");
    assert.ok(ok.startedAt);
    const failed = copies.find((copy) => copy.destinationId === broken.id)!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error, "a failed copy keeps the destination's reason");
    const brokenRow = await AppDataSource.getRepository(BackupDestination).findOneByOrFail({
      id: broken.id,
    });
    assert.equal(failed.error, brokenRow.lastError, "the same reason the destination shows");
    assert.equal(await copyAt(backup.id, paused.id), null, "a paused destination is not copied to");
    assert.deepEqual(await fs.readdir(nasDir), [backup.filename]);
  });

  test("a backup with no destination at all records no copies, and is still tracked", async () => {
    const backup = await runBackup("manual");
    assert.equal(backup.copiesTracked, true);
    assert.deepEqual(await copiesOf(backup.id), []);
  });

  test("Back up now answers once the backup is recorded and joins one already running", async () => {
    const copies = holdCopies();
    try {
      await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      const first = await startBackup("manual");
      assert.equal(first.alreadyRunning, false);
      assert.equal(first.backup.kind, "manual");
      await copies.reached("NAS");
      // The archive is written; its copy is still on its way, so the run is too.
      assert.equal(isBackupRunning(), true);
      const second = await startBackup("manual");
      assert.equal(second.alreadyRunning, true);
      assert.equal(second.backup.id, first.backup.id, "a second press joins the first backup");
      const [copy] = await copiesOf(first.backup.id);
      assert.equal(copy.status, "copying");
      assert.ok(copy.startedAt);
      await copies.pass("NAS");
      await waitUntil(() => !isBackupRunning(), "the backup to finish");
      const [settled] = await copiesOf(first.backup.id);
      assert.equal(settled.status, "copied");
      assert.deepEqual(await fs.readdir(nasDir), [first.backup.filename]);
    } finally {
      copies.release();
    }
  });
});

describe("copying an existing backup now", () => {
  test("queues every enabled destination as waiting, then copies them one at a time", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const first = await createDestination({ name: "First", kind: "local", path: spareDir }, null);
      const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      await inOrder(first, nas);

      const started = await startCopy(backup.id);

      assert.equal(started.alreadyRunning, false);
      assert.deepEqual(
        started.copies.map((copy) => [copy.destinationId, copy.status]),
        [
          [first.id, "pending"],
          [nas.id, "pending"],
        ],
      );
      await copies.reached("First");
      assert.equal((await copyAt(backup.id, first.id))?.status, "copying");
      assert.equal((await copyAt(backup.id, nas.id))?.status, "pending", "waits its turn");
      assert.equal(isBackupBeingCopied(backup.id), true);

      const again = await startCopy(backup.id);
      assert.equal(again.alreadyRunning, true, "a second press joins the copy under way");
      assert.equal(again.copies.length, 2);

      await copies.fail("First", "The connection to nas.local dropped part-way through the copy");
      await copies.pass("NAS");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copies to finish");
      const failed = await copyAt(backup.id, first.id);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error, "The connection to nas.local dropped part-way through the copy");
      assert.equal((await copyAt(backup.id, nas.id))?.status, "copied");
      assert.deepEqual(await fs.readdir(nasDir), [backup.filename]);
    } finally {
      copies.release();
    }
  });

  test("copies to just one destination when asked, even a paused one", async () => {
    const backup = await backupOnServer();
    const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const paused = await createDestination(
      { name: "Paused", kind: "local", path: spareDir, enabled: false },
      null,
    );

    const started = await startCopy(backup.id, paused.id);
    assert.deepEqual(
      started.copies.map((copy) => copy.destinationId),
      [paused.id],
    );
    await waitUntil(() => !isBackupBeingCopied(backup.id), "the copy to finish");

    assert.equal((await copyAt(backup.id, paused.id))?.status, "copied");
    assert.equal(await copyAt(backup.id, nas.id), null, "the other destination was left alone");
    assert.deepEqual(await fs.readdir(spareDir), [backup.filename]);
    assert.deepEqual(await fs.readdir(nasDir), []);
  });

  test("Try again turns a failed copy into a copied one once the destination works", async () => {
    const backup = await backupOnServer();
    const dest = await blockedDestination("NAS");
    await startCopy(backup.id);
    await waitUntil(() => !isBackupBeingCopied(backup.id), "the first copy");
    assert.equal((await copyAt(backup.id, dest.id))?.status, "failed");

    await updateDestination(dest.id, { path: nasDir });
    await startCopy(backup.id, dest.id);
    await waitUntil(() => !isBackupBeingCopied(backup.id), "the retry");

    const copy = await copyAt(backup.id, dest.id);
    assert.equal(copy?.status, "copied");
    assert.equal(copy?.error, "");
    assert.equal((await copiesOf(backup.id)).length, 1, "one row per backup and destination");
  });

  test("refuses what cannot be copied, with reasons the page can show", async () => {
    await assert.rejects(startCopy("missing"), { status: 404, message: /no longer exists/ });

    const running = await backupRow({ takenAt: new Date(), status: "running" });
    await assert.rejects(startCopy(running.id), { status: 409, message: /finished backup/ });

    const gone = await backupOnServer();
    await fs.rm(backupFilePath(gone.filename));
    await assert.rejects(startCopy(gone.id), { status: 409, message: /no longer on this server/ });

    const backup = await backupOnServer({ takenAt: daysAgo(2) });
    await assert.rejects(startCopy(backup.id), {
      status: 409,
      message: /No off-box destination is turned on/,
    });
    await createDestination(
      { name: "Paused", kind: "local", path: spareDir, enabled: false },
      null,
    );
    await assert.rejects(startCopy(backup.id), { status: 409, message: /No off-box destination/ });
    await assert.rejects(startCopy(backup.id, "no-such-destination"), {
      status: 404,
      message: /destination no longer exists/,
    });
    assert.equal(isBackupBeingCopied(backup.id), false, "a refusal releases the backup");
    assert.deepEqual(await copiesOf(backup.id), []);
  });

  test("a destination paused while its copy waits is skipped, and its row goes back", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const first = await createDestination({ name: "First", kind: "local", path: spareDir }, null);
      const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      const spare = await blockedDestination("Spare");
      await inOrder(first, nas, spare);
      // An earlier copy to the spare disk failed; the waiting one replaces nothing yet.
      await AppDataSource.getRepository(BackupCopy).save(
        AppDataSource.getRepository(BackupCopy).create({
          backupId: backup.id,
          destinationId: spare.id,
          status: "failed",
          error: "Disk was unplugged",
        }),
      );

      await startCopy(backup.id);
      await copies.reached("First");
      assert.equal((await copyAt(backup.id, nas.id))?.status, "pending");
      assert.equal((await copyAt(backup.id, spare.id))?.status, "pending");
      await updateDestination(nas.id, { enabled: false });
      await updateDestination(spare.id, { enabled: false });
      await copies.pass("First");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copies to finish");

      assert.equal((await copyAt(backup.id, first.id))?.status, "copied");
      assert.equal(await copyAt(backup.id, nas.id), null, "never attempted, so never recorded");
      const spareCopy = await copyAt(backup.id, spare.id);
      assert.equal(spareCopy?.status, "failed", "back to the earlier result");
      assert.equal(spareCopy?.error, "Disk was unplugged");
      assert.deepEqual(await fs.readdir(nasDir), [], "nothing was copied to a paused destination");
      const nasRow = await AppDataSource.getRepository(BackupDestination).findOneByOrFail({
        id: nas.id,
      });
      assert.equal(nasRow.enabled, false, "the pause survived the delivery");
    } finally {
      copies.release();
    }
  });

  test("a destination edited while a copy to it runs keeps the edit", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const dest = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      await startCopy(backup.id);
      await copies.reached("NAS");
      await updateDestination(dest.id, { name: "Renamed NAS", enabled: false, path: spareDir });
      await copies.fail("NAS", "The share on nas.local is full");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copy to finish");

      const row = await AppDataSource.getRepository(BackupDestination).findOneByOrFail({
        id: dest.id,
      });
      assert.equal(row.name, "Renamed NAS", "the delivery did not save over the rename");
      assert.equal(row.enabled, false, "nor over the pause");
      assert.equal(row.hint, spareDir, "nor over the new folder");
      assert.equal(row.lastStatus, "error", "while still recording its own result");
      assert.equal(row.lastError, "The share on nas.local is full");
      assert.ok(row.failingSince);
    } finally {
      copies.release();
    }
  });

  test("a destination being copied to can't be removed until the copy is over", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const dest = await createDestination({ name: "Slow NAS", kind: "local", path: nasDir }, null);
      await startCopy(backup.id);
      await copies.reached("Slow NAS");
      await assert.rejects(deleteDestination(dest.id), {
        status: 409,
        message: /being copied to Slow NAS/,
      });
      await copies.pass("Slow NAS");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copy to finish");

      assert.equal(await deleteDestination(dest.id), true);
      assert.deepEqual(await copiesOf(backup.id), [], "its copies leave History with it");
      assert.deepEqual(await fs.readdir(nasDir), [backup.filename], "but stay on the destination");
    } finally {
      copies.release();
    }
  });

  test("a destination removed while its copy waits is not copied to", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const first = await createDestination({ name: "First", kind: "local", path: spareDir }, null);
      const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      await inOrder(first, nas);
      await startCopy(backup.id);
      await copies.reached("First");
      assert.equal(await deleteDestination(nas.id), true, "a waiting destination may go");
      await copies.pass("First");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copies to finish");

      assert.equal(await copyAt(backup.id, nas.id), null);
      assert.deepEqual(await fs.readdir(nasDir), []);
      assert.equal(
        await AppDataSource.getRepository(BackupDestination).findOneBy({ id: nas.id }),
        null,
        "the delivery did not bring it back",
      );
    } finally {
      copies.release();
    }
  });

  test("a backup being copied is neither deleted, pruned, nor restored over", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer({ takenAt: daysAgo(60) });
      await backupOnServer({ takenAt: daysAgo(1) });
      await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
      await startCopy(backup.id);
      await copies.reached("NAS");

      await assert.rejects(deleteBackup(backup.id), {
        status: 409,
        message: /being copied off-box right now/,
      });
      const { pruned } = await updateBackupSchedule({ retentionEnabled: true, retentionDays: 30 });
      assert.equal(pruned, 0, "retention skips a backup mid-copy");
      assert.equal(await pruneOldBackups(), 0);
      await fs.access(backupFilePath(backup.filename));
      await assert.rejects(restoreFromBackup(backup.id), {
        status: 409,
        message: /being copied off-box right now/,
      });

      await copies.pass("NAS");
      await waitUntil(() => !isBackupBeingCopied(backup.id), "the copy to finish");
      assert.equal(await pruneOldBackups(), 1, "and gets it once the copy is over");
      assert.deepEqual(await copiesOf(backup.id), [], "its copy rows go with it");
    } finally {
      copies.release();
      // Turning retention off also stops its hourly timer.
      await updateBackupSchedule({ retentionEnabled: false });
    }
  });
});

describe("what keeps copy rows true", () => {
  test("off-box retention marks the copies it deletes as removed", async () => {
    const old = await backupOnServer({ takenAt: daysAgo(40), copiesTracked: false });
    const recent = await backupOnServer({ takenAt: daysAgo(10) });
    const dest = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    for (const row of [old, recent]) {
      await fs.copyFile(backupFilePath(row.filename), path.join(nasDir, row.filename));
    }
    await markCopiesPending(recent.id, [dest.id]);
    await AppDataSource.getRepository(BackupCopy).update(
      { backupId: recent.id },
      { status: "copied" },
    );

    const fresh = await backupOnServer({ takenAt: new Date() });
    await deliverBackupToDestinations(
      fresh.filename,
      backupFilePath(fresh.filename),
      { days: 30 },
      {
        backupId: fresh.id,
      },
    );

    const removed = await copyAt(old.id, dest.id);
    assert.equal(removed?.status, "removed", "even a backup from before copies were recorded");
    assert.equal((await copyAt(recent.id, dest.id))?.status, "copied", "inside the window");
    assert.equal((await copyAt(fresh.id, dest.id))?.status, "copied");
    assert.deepEqual((await fs.readdir(nasDir)).sort(), [recent.filename, fresh.filename].sort());
  });

  test("a restart fails every copy left waiting or part-way, and nothing else", async () => {
    const backup = await backupOnServer();
    const repo = AppDataSource.getRepository(BackupCopy);
    const states = ["pending", "copying", "copied", "failed", "missing", "removed"] as const;
    for (const status of states) {
      await repo.save(
        repo.create({ backupId: backup.id, destinationId: `dest-${status}`, status, error: "" }),
      );
    }

    assert.equal(await recoverInterruptedCopies(), 2);

    const byDestination = new Map(
      (await copiesOf(backup.id)).map((copy) => [copy.destinationId, copy]),
    );
    for (const status of COPY_IN_FLIGHT) {
      const copy = byDestination.get(`dest-${status}`)!;
      assert.equal(copy.status, "failed");
      assert.equal(copy.error, INTERRUPTED_COPY_ERROR);
    }
    for (const status of ["copied", "failed", "missing", "removed"]) {
      assert.equal(byDestination.get(`dest-${status}`)?.status, status);
    }
  });

  test("boot recovers interrupted copies", async () => {
    const backup = await backupOnServer();
    const repo = AppDataSource.getRepository(BackupCopy);
    await repo.save(
      repo.create({ backupId: backup.id, destinationId: "dest", status: "copying", error: "" }),
    );
    await withSqliteDriver(() => bootBackups());
    const [copy] = await copiesOf(backup.id);
    assert.equal(copy.status, "failed");
    assert.equal(copy.error, INTERRUPTED_COPY_ERROR);
  });

  test("a row a restart finds mid-backup cannot claim to know its copies", async () => {
    const takenAt = daysAgo(1);
    const filename = archiveName(takenAt);
    // What a restore brings back: the archive's own row, frozen mid-backup.
    // Taken under SQLite so the archive holds the database a restore needs.
    const archive = await withSqliteDriver(() => runBackup("manual"));
    await fs.rename(backupFilePath(archive.filename), backupFilePath(filename));
    await AppDataSource.getRepository(Backup).delete({ id: archive.id });
    const midBackup = await backupRow({ filename, takenAt, kind: "scheduled", status: "running" });
    // And an archive on disk with no row at all.
    const orphan = archiveName(daysAgo(2));
    await fs.copyFile(backupFilePath(filename), backupFilePath(orphan));

    await withSqliteDriver(() => bootBackups());

    const promoted = await AppDataSource.getRepository(Backup).findOneByOrFail({
      id: midBackup.id,
    });
    assert.equal(promoted.status, "completed");
    assert.equal(promoted.copiesTracked, false);
    const adopted = await AppDataSource.getRepository(Backup).findOneByOrFail({ filename: orphan });
    assert.equal(adopted.copiesTracked, false);
  });

  test("a skipped copy with no history of its own simply goes", async () => {
    const backup = await backupOnServer();
    await markCopiesPending(backup.id, ["dest"]);
    await unqueueCopy(backup.id, "dest");
    assert.equal(await copyAt(backup.id, "dest"), null);
    // Unqueueing something that isn't waiting changes nothing.
    await AppDataSource.getRepository(BackupCopy).save(
      AppDataSource.getRepository(BackupCopy).create({
        backupId: backup.id,
        destinationId: "dest",
        status: "copied",
        error: "",
      }),
    );
    await unqueueCopy(backup.id, "dest");
    assert.equal((await copyAt(backup.id, "dest"))?.status, "copied");
  });
});

describe("what daily verification records", () => {
  test("finds legacy backups on a destination, and says which aren't there", async () => {
    const dest = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const there = await backupOnServer({ takenAt: daysAgo(3), copiesTracked: false });
    const absent = await backupOnServer({ takenAt: daysAgo(4), copiesTracked: false });
    const short = await backupOnServer({
      takenAt: daysAgo(5),
      copiesTracked: false,
      bytes: "a much longer archive than its copy",
    });
    const partial = await backupOnServer({ takenAt: daysAgo(6), copiesTracked: false });
    await fs.copyFile(backupFilePath(there.filename), path.join(nasDir, there.filename));
    await fs.writeFile(path.join(nasDir, short.filename), "cut short");
    await fs.writeFile(path.join(nasDir, `${partial.filename}.partial`), "half");

    const before = Date.now();
    await verifyBackups();

    const found = await copyAt(there.id, dest.id);
    assert.equal(found?.status, "copied");
    assert.equal(found?.copiedAt, null, "found there, not seen arriving");
    assert.ok(found?.checkedAt && found.checkedAt.getTime() >= before - 1000);
    assert.equal((await copyAt(absent.id, dest.id))?.status, "missing");
    const cut = await copyAt(short.id, dest.id);
    assert.equal(cut?.status, "failed");
    assert.match(cut?.error ?? "", /never finished arriving/);
    const half = await copyAt(partial.id, dest.id);
    assert.equal(half?.status, "failed");
    assert.match(half?.error ?? "", /Only part of it is there/);
  });

  test("notices a copy that has gone, and leaves what it can't judge alone", async () => {
    const dest = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const gone = await backupOnServer({ takenAt: daysAgo(2) });
    const neverSent = await backupOnServer({ takenAt: daysAgo(3) });
    const inFlight = await backupOnServer({ takenAt: daysAgo(4) });
    const uploaded = await backupOnServer({
      filename: "uploaded-2026-01-01-000000.zip",
      kind: "uploaded",
    });
    const repo = AppDataSource.getRepository(BackupCopy);
    const copied = new Date(Date.now() - DAY_MS);
    for (const [backup, status] of [
      [gone, "copied"],
      [inFlight, "copying"],
      [uploaded, "copied"],
    ] as const) {
      await repo.save(
        repo.create({
          backupId: backup.id,
          destinationId: dest.id,
          status,
          error: "",
          copiedAt: status === "copied" ? copied : null,
        }),
      );
    }

    await verifyBackups();

    const missing = await copyAt(gone.id, dest.id);
    assert.equal(missing?.status, "missing", "copied once, no longer there");
    assert.deepEqual(missing?.copiedAt, copied, "when it arrived is kept");
    assert.equal(await copyAt(neverSent.id, dest.id), null, "never sent: nothing new to record");
    assert.equal((await copyAt(inFlight.id, dest.id))?.status, "copying", "a copy under way");
    assert.equal(
      (await copyAt(uploaded.id, dest.id))?.status,
      "copied",
      "an uploaded archive is never listed, so never judged missing",
    );
  });

  test("evidence beats a recorded failure", async () => {
    const dest = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const backup = await backupOnServer();
    const repo = AppDataSource.getRepository(BackupCopy);
    await repo.save(
      repo.create({ backupId: backup.id, destinationId: dest.id, status: "failed", error: "x" }),
    );
    await fs.copyFile(backupFilePath(backup.filename), path.join(nasDir, backup.filename));

    await recordCopiesFound({
      destinationId: dest.id,
      backups: [backup],
      whole: new Map([[backup.filename, backup.sizeBytes]]),
      partial: new Set(),
      localSizes: new Map([[backup.filename, backup.sizeBytes]]),
      now: new Date(),
    });

    const copy = await copyAt(backup.id, dest.id);
    assert.equal(copy?.status, "copied");
    assert.equal(copy?.error, "");
  });

  test("a destination it can't look inside teaches History nothing", async () => {
    // Its folder is a file, so listing it fails: verification reports that, and
    // records nothing about copies it could not see.
    const dest = await blockedDestination("Broken");
    const legacy = await backupOnServer({ copiesTracked: false });
    const verification = await verifyBackups();
    const area = verification.areas.find((entry) => entry.id === dest.id);
    assert.match(area?.problems[0]?.key ?? "", /^unlisted:/);
    assert.equal(await copyAt(legacy.id, dest.id), null, "still not recorded");
  });
});

describe("History", () => {
  test("says, for each backup, whether it is on this server and where its copies are", async () => {
    const nas = await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const kept = await runBackup("manual");
    const deletedHere = await backupOnServer({ takenAt: daysAgo(3) });
    await AppDataSource.getRepository(BackupCopy).save(
      AppDataSource.getRepository(BackupCopy).create({
        backupId: deletedHere.id,
        destinationId: nas.id,
        status: "copied",
        error: "",
      }),
    );
    await fs.rm(backupFilePath(deletedHere.filename));
    const failedRun = await backupRow({
      takenAt: daysAgo(4),
      kind: "scheduled",
      status: "failed",
      errorMessage: "Disk full",
    });
    const crashed = await backupRow({ takenAt: daysAgo(5), status: "running" });

    const history = await listBackupHistory();
    const byId = new Map(history.map((item) => [item.id, item]));

    assert.deepEqual(
      history.map((item) => item.id),
      [kept.id, deletedHere.id, failedRun.id, crashed.id],
      "newest first",
    );
    const keptItem = byId.get(kept.id)!;
    assert.equal(keptItem.onServer, true);
    assert.equal(keptItem.inProgress, false);
    assert.equal(keptItem.copiesTracked, true);
    assert.deepEqual(
      keptItem.copies.map((copy) => [copy.destinationId, copy.status]),
      [[nas.id, "copied"]],
    );
    assert.equal(byId.get(deletedHere.id)!.onServer, false, "only off-box now");
    assert.equal(byId.get(deletedHere.id)!.copies[0].status, "copied");
    assert.equal(byId.get(failedRun.id)!.onServer, false);
    assert.equal(byId.get(failedRun.id)!.errorMessage, "Disk full");
    assert.equal(byId.get(crashed.id)!.inProgress, false, "a running row nobody is writing");
  });

  test("deleting a backup takes its copy rows with it, but not the copies", async () => {
    await createDestination({ name: "NAS", kind: "local", path: nasDir }, null);
    const backup = await runBackup("manual");
    assert.equal((await copiesOf(backup.id)).length, 1);

    assert.equal(await deleteBackup(backup.id), true);

    assert.deepEqual(await copiesOf(backup.id), []);
    assert.deepEqual(await fs.readdir(nasDir), [backup.filename], "the copy stays on the NAS");
  });
});
