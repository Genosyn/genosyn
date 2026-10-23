import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Backup } from "../db/entities/Backup.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  BACKUP_INTERRUPTED_MESSAGE,
  INTERRUPTED_UNREADABLE_MESSAGE,
  UPLOAD_INTERRUPTED_MESSAGE,
  backupFilePath,
  bootBackups,
  listBackupHistory,
  runBackup,
  watchForStall,
} from "./backups.js";
import { verifyBackups } from "./backupVerification.js";

/**
 * Backups whose process stopped part-way.
 *
 * Admin → Backups showed rows "running" at 0 B for weeks: five on one install,
 * three of them on one day at odd minutes — catch-up runs that each boot
 * started and the next restart killed. Boot recovery only ever promoted a
 * `running` row whose archive was on disk and opened; a row whose archive
 * never landed (its `.part` swept at that same boot) was skipped and stayed
 * `running` for good, and nothing else ever looked at it again. Now every
 * `running` row boot finds is settled — completed when its archive opens,
 * failed with the plain reason otherwise — and a write that stops moving is
 * stopped rather than left to hold the backup lock forever.
 */

type MutableConfig = { dataDir: string; db: { driver: "sqlite" | "postgres" } };
const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;
const DAY_MS = 24 * 60 * 60 * 1000;
let tempDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-backup-recovery-"));
  mutable.dataDir = path.join(tempDir, "data");
  mutable.db.driver = "postgres";
  resetInstanceSecretsCacheForTests();
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tempDir, "data", "companies", "acme"), { recursive: true });
});

after(async () => {
  mutable.dataDir = originalDataDir;
  mutable.db.driver = originalDriver;
  resetInstanceSecretsCacheForTests();
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** Under the SQLite driver: boot's scheduler leases are in-process, and an archive must hold the database. */
async function withSqlite<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutable.db.driver;
  mutable.db.driver = "sqlite";
  try {
    return await fn();
  } finally {
    mutable.db.driver = previous;
  }
}

async function boot(): Promise<void> {
  await withSqlite(() => bootBackups());
}

function archiveName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}.zip`;
}

/** A row left `running` by a process that stopped, `daysAgo` days ago. */
async function zombie(daysAgo: number, values: Partial<Backup> = {}): Promise<Backup> {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  const row = await insert(Backup, {
    filename: archiveName(at),
    kind: "scheduled",
    status: "running",
    sizeBytes: 0,
    errorMessage: "",
    copiesTracked: true,
    completedAt: null,
    ...values,
  });
  await AppDataSource.getRepository(Backup).update({ id: row.id }, { createdAt: at });
  return row;
}

async function reload(row: Backup): Promise<Backup> {
  return AppDataSource.getRepository(Backup).findOneByOrFail({ id: row.id });
}

describe("boot settles every backup a stopped process left running", () => {
  test("weeks-old rows with no archive fail with the plain reason, and History shows none running", async () => {
    // What the owner's History held: five "running" rows at 0 B, weeks old.
    const rows = [
      await zombie(24),
      await zombie(48),
      await zombie(51, { kind: "manual" }),
      await zombie(51.1),
      await zombie(51.2),
    ];
    // The .part each left behind is swept by the same boot.
    await fs.mkdir(path.dirname(backupFilePath(rows[0].filename)), { recursive: true });
    await fs.writeFile(`${backupFilePath(rows[0].filename)}.part`, "half an archive");

    const before = Date.now();
    await boot();

    for (const row of rows) {
      const settled = await reload(row);
      assert.equal(settled.status, "failed");
      assert.equal(settled.errorMessage, BACKUP_INTERRUPTED_MESSAGE);
      assert.ok(settled.completedAt, "a settled row says when it was settled");
      assert.ok(settled.completedAt.getTime() >= before - 1000);
    }
    await assert.rejects(fs.access(`${backupFilePath(rows[0].filename)}.part`));
    const history = await listBackupHistory();
    assert.equal(
      history.filter((item) => item.status === "running").length,
      0,
      "nothing in History claims to be running",
    );
  });

  test("an upload cut off part-way says it was an upload", async () => {
    const upload = await zombie(3, {
      kind: "uploaded",
      filename: "uploaded-2026-10-01-120000.zip",
    });
    await boot();
    const settled = await reload(upload);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorMessage, UPLOAD_INTERRUPTED_MESSAGE);
  });

  test("a row whose file is there but doesn't open fails, and the file is kept for a person", async () => {
    const truncated = await zombie(5);
    await fs.mkdir(path.dirname(backupFilePath(truncated.filename)), { recursive: true });
    await fs.writeFile(backupFilePath(truncated.filename), "PK\x03\x04 and then nothing");

    await boot();

    const settled = await reload(truncated);
    assert.equal(settled.status, "failed");
    assert.equal(settled.errorMessage, INTERRUPTED_UNREADABLE_MESSAGE);
    await fs.access(backupFilePath(truncated.filename));
  });

  test("a row whose archive is there and opens is completed, as before", async () => {
    const archive = await withSqlite(() => runBackup("manual"));
    const midBackup = await zombie(1);
    await fs.rename(backupFilePath(archive.filename), backupFilePath(midBackup.filename));
    await AppDataSource.getRepository(Backup).delete({ id: archive.id });

    await boot();

    const settled = await reload(midBackup);
    assert.equal(settled.status, "completed");
    assert.equal(settled.errorMessage, "");
    assert.ok(settled.sizeBytes > 0, "with its real size");
    assert.equal(settled.copiesTracked, false);
  });

  test("finished rows are left exactly as they were", async () => {
    const done = await runBackup("manual");
    const failed = await insert(Backup, {
      filename: archiveName(new Date(Date.now() - 2 * DAY_MS)),
      kind: "scheduled",
      status: "failed",
      errorMessage: "ENOSPC: no space left on device, write",
    });

    await boot();

    assert.equal((await reload(done)).status, "completed");
    const stillFailed = await reload(failed);
    assert.equal(stillFailed.status, "failed");
    assert.equal(stillFailed.errorMessage, "ENOSPC: no space left on device, write");
  });

  test("daily verification then reports a settled run as failed, with its reason", async () => {
    await insert(Backup, {
      filename: archiveName(new Date(Date.now() - 3 * DAY_MS)),
      kind: "manual",
      status: "completed",
    });
    const killed = await zombie(1);
    await boot();
    const settled = await reload(killed);
    assert.equal(settled.status, "failed");
    // With no schedule, verification has no runs to hold it to: nothing claims it is running.
    const verification = await verifyBackups();
    const server = verification.areas.find((area) => area.id === "server");
    assert.ok(server, "verification looked at this server");
    assert.ok(
      !server.problems.some((problem) => /running/i.test(problem.message)),
      "no problem calls it running",
    );
  });
});

describe("a write that stops moving is stopped", () => {
  test("calls back once nothing has moved for the limit, and only once", async () => {
    let stalls = 0;
    const stop = watchForStall(() => 42, 40, () => (stalls += 1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    assert.equal(stalls, 1);
  });

  test("keeps quiet while the count keeps moving", async () => {
    let count = 0;
    let stalls = 0;
    const ticker = setInterval(() => (count += 1), 5);
    const stop = watchForStall(() => count, 60, () => (stalls += 1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    stop();
    clearInterval(ticker);
    assert.equal(stalls, 0);
  });

  test("notices a count that moved and then stopped", async () => {
    let count = 0;
    let stalls = 0;
    const ticker = setInterval(() => (count += 1), 5);
    const stop = watchForStall(() => count, 50, () => (stalls += 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    clearInterval(ticker);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    assert.equal(stalls, 1);
  });

  test("stopping it first means it never calls back", async () => {
    let stalls = 0;
    const stop = watchForStall(() => 0, 30, () => (stalls += 1));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(stalls, 0);
  });

  test("an ordinary backup is not mistaken for a stuck one", async () => {
    await fs.writeFile(path.join(tempDir, "data", "companies", "acme", "notes.txt"), "x".repeat(2048));
    const backup = await runBackup("manual");
    assert.equal(backup.status, "completed");
    assert.equal(backup.errorMessage, "");
  });
});
