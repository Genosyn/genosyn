import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import unzipper from "unzipper";
import { config } from "../../config.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { backupFilePath, runBackup } from "./backups.js";

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
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("backup archive generation", () => {
  test("creates a complete zip without recursively including the Backup directory", async () => {
    const markerPath = path.join(tempDir, "companies", "release-lab", "marker.txt");
    await fs.writeFile(markerPath, "release proof");

    const backup = await runBackup("manual");
    assert.equal(backup.status, "completed");
    assert.ok(backup.sizeBytes > 0);

    const archivePath = backupFilePath(backup.filename);
    const archive = await unzipper.Open.file(archivePath);
    const names = archive.files.map((entry) => entry.path);
    assert.ok(names.includes("companies/release-lab/marker.txt"));
    assert.equal(names.some((name) => name.startsWith("Backup/")), false);

    const marker = archive.files.find(
      (entry) => entry.path === "companies/release-lab/marker.txt",
    );
    assert.equal((await marker?.buffer())?.toString("utf8"), "release proof");
  });
});
