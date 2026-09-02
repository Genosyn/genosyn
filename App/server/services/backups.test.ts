import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import unzipper from "unzipper";
import { config } from "../../config.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  INSTANCE_SECRETS_FILENAME,
  INSTANCE_SECRETS_SENTINEL_FILENAME,
  getEffectiveInstanceSecrets,
  resetInstanceSecretsCacheForTests,
} from "../lib/instanceSecrets.js";
import { AppDataSource } from "../db/datasource.js";
import {
  backupDir,
  backupFilePath,
  bootBackups,
  runBackup,
  sweepOrphanedStagingArtifacts,
} from "./backups.js";

type MutableConfig = {
  dataDir: string;
  db: {
    driver: "sqlite" | "postgres";
  };
};

const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;
let tempDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-backup-"));
  mutable.dataDir = tempDir;
  // The test DB is in-memory, so there is no SQLite file to snapshot.
  mutable.db.driver = "postgres";
  resetInstanceSecretsCacheForTests();
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tempDir, "companies", "release-lab"), {
    recursive: true,
  });
});

after(async () => {
  mutable.dataDir = originalDataDir;
  mutable.db.driver = originalDriver;
  resetInstanceSecretsCacheForTests();
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("backup archive generation", () => {
  test("creates a complete zip without recursively including the Backup directory", async () => {
    const markerPath = path.join(tempDir, "companies", "release-lab", "marker.txt");
    await fs.writeFile(markerPath, "release proof");

    getEffectiveInstanceSecrets();
    const backup = await runBackup("manual");
    assert.equal(backup.status, "completed");
    assert.ok(backup.sizeBytes > 0);

    const archivePath = backupFilePath(backup.filename);
    assert.equal((await fs.stat(archivePath)).mode & 0o777, 0o600);
    const archive = await unzipper.Open.file(archivePath);
    const names = archive.files.map((entry) => entry.path);
    assert.ok(names.includes("companies/release-lab/marker.txt"));
    assert.ok(names.includes(INSTANCE_SECRETS_FILENAME));
    assert.ok(names.includes(INSTANCE_SECRETS_SENTINEL_FILENAME));
    assert.equal(
      names.some((name) => name.startsWith("Backup/")),
      false,
    );

    const marker = archive.files.find((entry) => entry.path === "companies/release-lab/marker.txt");
    assert.equal((await marker?.buffer())?.toString("utf8"), "release proof");
  });
});

/**
 * Regression coverage for the staging-snapshot leak.
 *
 * Each run stages a `VACUUM INTO` copy of the database at
 * `Backup/.staging-<id>.sqlite` before zipping it. That snapshot is the size of
 * the whole database, and two things used to strand copies of it forever:
 *
 *   1. the cleanup ran only in `runBackupInner`'s `finally`, which a SIGKILL
 *      (container restart, OOM killer) skips entirely — and nothing else ever
 *      looked for the leftovers;
 *   2. the cleanup unlinked only the `.sqlite`, so the rollback journal
 *      `VACUUM INTO` writes beside it survived *every* run, successful or not.
 *
 * On a real install that reached 121 GB of stranded snapshots.
 */

/** Absolute path of a plausible staging snapshot nobody owns. */
function orphanStagingPath(id = randomUUID()): string {
  return path.join(backupDir(), `.staging-${id}.sqlite`);
}

async function writeFileEnsuringDir(abs: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function listBackupDir(): Promise<string[]> {
  try {
    return (await fs.readdir(backupDir())).sort();
  } catch {
    return [];
  }
}

/** Run `fn` with the SQLite snapshot path enabled, restoring the driver after. */
async function withSqliteDriver<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutable.db.driver;
  mutable.db.driver = "sqlite";
  try {
    return await fn();
  } finally {
    mutable.db.driver = previous;
  }
}

/**
 * Replace `AppDataSource.createQueryRunner` so `VACUUM INTO` can be observed or
 * subverted. Returns a restore function. The real runner still does the work
 * unless `onVacuum` throws.
 */
function patchVacuum(onVacuum: (dest: string) => void | Promise<void>): () => void {
  type Runner = ReturnType<typeof AppDataSource.createQueryRunner>;
  const originalCreate = AppDataSource.createQueryRunner.bind(AppDataSource);
  // better-sqlite3 hands back one shared query runner, so a wrapper installed
  // on the instance outlives this patch unless every one is put back — left
  // alone they stack, and a later test inherits this test's behaviour.
  const wrapped: Array<{ runner: Runner; query: Runner["query"] }> = [];

  (AppDataSource as unknown as { createQueryRunner: unknown }).createQueryRunner = () => {
    const runner = originalCreate();
    const originalQuery = runner.query.bind(runner);
    wrapped.push({ runner, query: runner.query });
    // Forward every argument: TypeORM passes a third `useStructuredResult`
    // flag on the read path, and swallowing it breaks unrelated queries.
    runner.query = async (...args: Parameters<Runner["query"]>) => {
      const result = await originalQuery(...args);
      const [sql, params] = args;
      if (typeof sql === "string" && sql.includes("VACUUM INTO")) {
        await onVacuum(String((params as unknown[] | undefined)?.[0] ?? ""));
      }
      return result;
    };
    return runner;
  };

  return () => {
    (AppDataSource as unknown as { createQueryRunner: unknown }).createQueryRunner = originalCreate;
    for (const entry of wrapped.reverse()) entry.runner.query = entry.query;
    wrapped.length = 0;
  };
}

describe("staging snapshot sweep", () => {
  test("removes an orphaned staging snapshot left by a killed run", async () => {
    const orphan = orphanStagingPath();
    await writeFileEnsuringDir(orphan, "pretend 15GB snapshot");

    assert.equal(sweepOrphanedStagingArtifacts(), 1);
    assert.equal(await exists(orphan), false);
  });

  test("removes the SQLite sidecars that used to survive every run", async () => {
    const base = orphanStagingPath();
    const sidecars = ["-journal", "-wal", "-shm"].map((suffix) => `${base}${suffix}`);
    await writeFileEnsuringDir(base, "snapshot");
    for (const sidecar of sidecars) await writeFileEnsuringDir(sidecar, "sidecar");

    assert.equal(sweepOrphanedStagingArtifacts(), 4);
    for (const abs of [base, ...sidecars]) {
      assert.equal(await exists(abs), false, `${path.basename(abs)} should be gone`);
    }
  });

  test("sweeps a sidecar whose snapshot is already gone", async () => {
    // Exactly the state the old cleanup left behind: the `.sqlite` was
    // unlinked by the `finally`, the journal beside it was not.
    const stranded = `${orphanStagingPath()}-journal`;
    await writeFileEnsuringDir(stranded, "orphaned journal");

    assert.equal(sweepOrphanedStagingArtifacts(), 1);
    assert.equal(await exists(stranded), false);
  });

  test("clears a whole backlog of stranded snapshots in one pass", async () => {
    const orphans = Array.from({ length: 9 }, () => orphanStagingPath());
    for (const orphan of orphans) await writeFileEnsuringDir(orphan, "snapshot");

    assert.equal(sweepOrphanedStagingArtifacts(), 9);
    assert.deepEqual(await listBackupDir(), []);
  });

  test("never touches archives or unrelated files", async () => {
    const keep = [
      path.join(backupDir(), "backup-2026-08-21-145706.zip"),
      path.join(backupDir(), "uploaded-2026-05-04-161705.zip"),
      path.join(backupDir(), "backup-2026-09-02-195253.zip.part"),
      path.join(backupDir(), "notes.txt"),
      path.join(backupDir(), "staging-without-leading-dot.sqlite"),
    ];
    for (const abs of keep) await writeFileEnsuringDir(abs, "keep me");
    const orphan = orphanStagingPath();
    await writeFileEnsuringDir(orphan, "snapshot");

    assert.equal(sweepOrphanedStagingArtifacts(), 1);
    assert.equal(await exists(orphan), false);
    for (const abs of keep) {
      assert.equal(await exists(abs), true, `${path.basename(abs)} must survive the sweep`);
    }
  });

  test("is idempotent and a no-op on a clean directory", async () => {
    await writeFileEnsuringDir(orphanStagingPath(), "snapshot");
    assert.equal(sweepOrphanedStagingArtifacts(), 1);
    assert.equal(sweepOrphanedStagingArtifacts(), 0);
    assert.equal(sweepOrphanedStagingArtifacts(), 0);
  });

  test("does not throw when the Backup directory does not exist", async () => {
    await fs.rm(backupDir(), { recursive: true, force: true });
    assert.equal(sweepOrphanedStagingArtifacts(), 0);
  });
});

describe("backup run staging hygiene", () => {
  test("leaves no staging artifact behind after a successful SQLite run", async () => {
    getEffectiveInstanceSecrets();

    const backup = await withSqliteDriver(() => runBackup("manual"));
    assert.equal(backup.status, "completed");

    const leftovers = (await listBackupDir()).filter((name) => name.startsWith(".staging-"));
    assert.deepEqual(leftovers, [], `staging artifacts survived the run: ${leftovers.join(", ")}`);
  });

  test("removes the journal SQLite leaves beside the snapshot", async () => {
    getEffectiveInstanceSecrets();

    // Whether `VACUUM INTO` leaves a journal is a SQLite build detail, so plant
    // one at the moment the snapshot lands rather than depending on it.
    let stagedJournal = "";
    const restore = patchVacuum(async (dest) => {
      stagedJournal = `${dest}-journal`;
      await fs.writeFile(stagedJournal, "rollback journal");
    });

    try {
      const backup = await withSqliteDriver(() => runBackup("manual"));
      assert.equal(backup.status, "completed");
    } finally {
      restore();
    }

    assert.notEqual(stagedJournal, "", "the VACUUM INTO patch never fired");
    assert.equal(await exists(stagedJournal), false, "the staging journal was left behind");
  });

  test("still ships the snapshot as app.sqlite once cleanup is in play", async () => {
    getEffectiveInstanceSecrets();
    const marker = path.join(tempDir, "companies", "release-lab", "marker.txt");
    await fs.writeFile(marker, "snapshot proof");

    const backup = await withSqliteDriver(() => runBackup("manual"));
    const archive = await unzipper.Open.file(backupFilePath(backup.filename));
    const names = archive.files.map((entry) => entry.path);

    assert.ok(names.includes("app.sqlite"), "the archive lost its database snapshot");
    assert.ok(names.includes("companies/release-lab/marker.txt"));
    assert.equal(
      names.some((name) => name.includes(".staging-")),
      false,
      "staging artifacts must never be archived",
    );
  });

  test("cleans up the snapshot when the run fails", async () => {
    getEffectiveInstanceSecrets();

    // Write the snapshot, then blow up — the shape of a run that dies after
    // staging. The `finally` must still collect it.
    const restore = patchVacuum(async (dest) => {
      await fs.writeFile(dest, "half-staged snapshot");
      await fs.writeFile(`${dest}-journal`, "rollback journal");
      throw new Error("simulated snapshot failure");
    });

    try {
      await assert.rejects(
        withSqliteDriver(() => runBackup("manual")),
        /simulated snapshot failure/,
      );
    } finally {
      restore();
    }

    const leftovers = (await listBackupDir()).filter((name) => name.startsWith(".staging-"));
    assert.deepEqual(leftovers, [], `failed run stranded: ${leftovers.join(", ")}`);
  });

  test("sweeps snapshots stranded by an earlier killed run before staging its own", async () => {
    getEffectiveInstanceSecrets();
    const stranded = Array.from({ length: 3 }, () => orphanStagingPath());
    for (const orphan of stranded) await writeFileEnsuringDir(orphan, "snapshot from a dead run");

    const backup = await runBackup("manual");
    assert.equal(backup.status, "completed");

    for (const orphan of stranded) {
      assert.equal(await exists(orphan), false, `${path.basename(orphan)} should have been swept`);
    }
  });

  test("refuses to sweep the snapshot of a run that is still in flight", async () => {
    getEffectiveInstanceSecrets();

    // Sweep from inside the run, at the one moment the live snapshot is on
    // disk. Without the in-flight guard this deletes the file the run is about
    // to archive.
    let sweptDuringRun = -1;
    let snapshotPresentDuringRun = false;
    const restore = patchVacuum(async (dest) => {
      snapshotPresentDuringRun = await exists(dest);
      sweptDuringRun = sweepOrphanedStagingArtifacts();
      assert.equal(await exists(dest), true, "the live snapshot was swept out from under the run");
    });

    let backup;
    try {
      backup = await withSqliteDriver(() => runBackup("manual"));
    } finally {
      restore();
    }

    assert.equal(snapshotPresentDuringRun, true, "expected a staged snapshot mid-run");
    assert.equal(sweptDuringRun, 0, "the sweep must skip a live run's snapshot");
    assert.equal(backup.status, "completed");

    const archive = await unzipper.Open.file(backupFilePath(backup.filename));
    assert.ok(archive.files.some((entry) => entry.path === "app.sqlite"));
  });

  test("releases the in-flight marker once the run is over", async () => {
    getEffectiveInstanceSecrets();

    let stagingPath = "";
    const restore = patchVacuum((dest) => {
      stagingPath = dest;
    });
    try {
      await withSqliteDriver(() => runBackup("manual"));
    } finally {
      restore();
    }
    assert.notEqual(stagingPath, "", "never observed a staging path");

    // A later run reusing that exact path must be sweepable, or a single
    // backup would pin it as un-collectable for the life of the process.
    await writeFileEnsuringDir(stagingPath, "debris reusing the old id");
    assert.equal(sweepOrphanedStagingArtifacts(), 1);
    assert.equal(await exists(stagingPath), false);
  });
});

describe("boot recovery", () => {
  test("sweeps snapshots stranded by a crash on the next boot", async () => {
    // The production shape of the leak: the container is SIGKILLed part-way
    // through a backup, so `runBackupInner`'s `finally` never runs. Restarting
    // is the first opportunity to reclaim the space, and before this it was
    // never taken — the snapshots simply accumulated, one per killed run.
    const stranded = Array.from({ length: 4 }, () => orphanStagingPath());
    for (const orphan of stranded) await writeFileEnsuringDir(orphan, "snapshot from a dead run");
    const strandedJournal = `${stranded[0]}-journal`;
    await writeFileEnsuringDir(strandedJournal, "rollback journal");

    // A real archive alongside them must come through untouched.
    getEffectiveInstanceSecrets();

    // Under the SQLite driver throughout: that is what a self-hosted install
    // runs, and it is the configuration whose scheduler leases are in-process.
    const survivor = await withSqliteDriver(async () => {
      const created = await runBackup("manual");
      await bootBackups();
      return created;
    });

    for (const orphan of [...stranded, strandedJournal]) {
      assert.equal(await exists(orphan), false, `${path.basename(orphan)} survived boot`);
    }
    assert.equal(await exists(backupFilePath(survivor.filename)), true);
  });
});
