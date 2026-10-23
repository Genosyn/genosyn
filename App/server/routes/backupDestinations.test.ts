import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Backup } from "../db/entities/Backup.js";
import { BackupCopy } from "../db/entities/BackupCopy.js";
import { BackupDestination } from "../db/entities/BackupDestination.js";
import { User } from "../db/entities/User.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { errorHandler } from "../middleware/error.js";
import {
  TEST_PASSED_MESSAGE,
  TEST_PASSED_STILL_FAILING_MESSAGE,
  isDeliveryRunning,
} from "../services/backupDestinations.js";
import { backupFilePath } from "../services/backups.js";
import { holdCopies } from "../test/backupCopyGate.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { backupDestinationsRouter } from "./backupDestinations.js";
import { backupsRouter } from "./backups.js";

/**
 * Admin → Backups → Off-box destinations, booted on a real socket.
 *
 * The regression this file exists for: pressing Test on a destination showed
 * nothing. A passing test's message was never rendered, and on a destination
 * whose copies were failing — the case the owner hit — the server's "reachable,
 * but copies are still failing" reached the page and was thrown away. The page
 * now shows the result beside the destination, so the result has a shape it
 * can rely on: `ok`, the `message` (the destination's own reason when it
 * fails), `stillFailing`, and `testedAt` — always a 200 for a destination that
 * exists, whatever the test found.
 */

type MutableConfig = { dataDir: string; db: { driver: "sqlite" | "postgres" } };
const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let tempDir = "";
let nasDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-destination-routes-"));
  mutable.dataDir = path.join(tempDir, "data");
  mutable.db.driver = "postgres";
  resetInstanceSecretsCacheForTests();

  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/backups", backupsRouter);
  app.use("/api/backup-destinations", backupDestinationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tempDir, "data"), { recursive: true });
  nasDir = path.join(tempDir, "nas");
  await fs.mkdir(nasDir, { recursive: true });
  const operator = await insert(User, {
    email: "op@example.com",
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
  });
  actingUserId = operator.id;
});

afterEach(async () => {
  const deadline = Date.now() + 10_000;
  while (isDeliveryRunning()) {
    if (Date.now() > deadline) throw new Error("A copy was still running after the test");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  mutable.dataDir = originalDataDir;
  mutable.db.driver = originalDriver;
  resetInstanceSecretsCacheForTests();
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
type TestResult = { ok: boolean; message: string; stillFailing: boolean; testedAt: string };
type DestinationJson = {
  id: string;
  name: string;
  enabled: boolean;
  lastStatus: string;
  lastError: string;
  lastCheckedAt: string | null;
  failingSince: string | null;
};

async function call<T = Json>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function addLocal(name: string, folder: string): Promise<DestinationJson> {
  const { status, body } = await call<DestinationJson>("POST", "/api/backup-destinations", {
    name,
    kind: "local",
    path: folder,
  });
  assert.equal(status, 200);
  return body;
}

/** A local destination whose folder is a file: Genosyn can't write there. */
async function addBlocked(name: string): Promise<DestinationJson> {
  const blocked = path.join(tempDir, `${name}-not-a-folder`);
  await fs.writeFile(blocked, "");
  return addLocal(name, blocked);
}

async function listed(id: string): Promise<DestinationJson> {
  const { body } = await call<DestinationJson[]>("GET", "/api/backup-destinations");
  const row = body.find((entry) => entry.id === id);
  assert.ok(row, "the destination is listed");
  return row;
}

function assertTestResultShape(result: TestResult): void {
  assert.deepEqual(Object.keys(result).sort(), ["message", "ok", "stillFailing", "testedAt"]);
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.trim().length > 0, "a result always says something");
  assert.equal(typeof result.stillFailing, "boolean");
  assert.ok(!Number.isNaN(Date.parse(result.testedAt)), "testedAt is a date");
}

describe("POST /api/backup-destinations/:id/test", () => {
  test("a reachable destination passes, and says so in plain words", async () => {
    const dest = await addLocal("Office NAS", nasDir);
    const before = Date.now();

    const { status, body } = await call<TestResult>(
      "POST",
      `/api/backup-destinations/${dest.id}/test`,
    );

    assert.equal(status, 200);
    assertTestResultShape(body);
    assert.equal(body.ok, true);
    assert.equal(body.stillFailing, false);
    assert.equal(body.message, TEST_PASSED_MESSAGE);
    assert.ok(Date.parse(body.testedAt) >= before - 1000);
    assert.deepEqual(await fs.readdir(nasDir), [], "the test file is removed again");
    const row = await listed(dest.id);
    assert.equal(row.lastStatus, "ok");
    assert.equal(row.lastError, "");
    assert.equal(row.lastCheckedAt, body.testedAt);
  });

  test("an unreachable destination fails with its own reason, still as a 200", async () => {
    const dest = await addBlocked("Broken share");

    const { status, body } = await call<TestResult>(
      "POST",
      `/api/backup-destinations/${dest.id}/test`,
    );

    assert.equal(status, 200, "the test ran; what it found is the result");
    assertTestResultShape(body);
    assert.equal(body.ok, false);
    assert.equal(body.stillFailing, false);
    assert.match(body.message, /EEXIST|ENOTDIR|not a directory|file already exists/i);
    assert.notEqual(body.message, "Something went wrong");
    const row = await listed(dest.id);
    assert.equal(row.lastStatus, "error");
    assert.equal(row.lastError, body.message, "the row shows the same reason the result gave");
  });

  test("a pass on a destination whose copies keep failing says they are still failing", async () => {
    const dest = await addBlocked("Synology");
    // A backup fails to reach it, starting a run of failures…
    const filename = "backup-2026-10-22-030000.zip";
    await fs.mkdir(path.dirname(backupFilePath(filename)), { recursive: true });
    await fs.writeFile(backupFilePath(filename), "archive");
    const backup = await insert(Backup, {
      filename,
      kind: "scheduled",
      status: "completed",
      copiesTracked: true,
    });
    await call("POST", `/api/backups/${backup.id}/deliver`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    while (isDeliveryRunning()) await new Promise((resolve) => setTimeout(resolve, 10));
    const failing = await listed(dest.id);
    assert.ok(failing.failingSince, "copies there are failing");
    // …then the folder is fixed, and a test file gets through.
    await fs.rm(path.join(tempDir, "Synology-not-a-folder"));

    const { status, body } = await call<TestResult>(
      "POST",
      `/api/backup-destinations/${dest.id}/test`,
    );

    assert.equal(status, 200);
    assertTestResultShape(body);
    assert.equal(body.ok, true);
    assert.equal(body.stillFailing, true);
    assert.equal(body.message, TEST_PASSED_STILL_FAILING_MESSAGE);
    assert.match(body.message, /still failing/);
    const row = await listed(dest.id);
    assert.equal(row.lastStatus, "error", "a test file is not a backup: still failing");
    assert.equal(row.failingSince, failing.failingSince);
    assert.equal(row.lastCheckedAt, body.testedAt);
  });

  test("a destination whose settings can't be read says how to fix it", async () => {
    const dest = await addLocal("Old NAS", nasDir);
    await AppDataSource.getRepository(BackupDestination).update(
      { id: dest.id },
      { encryptedConfig: "not something this install can decrypt" },
    );
    const { status, body } = await call<TestResult>(
      "POST",
      `/api/backup-destinations/${dest.id}/test`,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(body.message, /saved settings can't be read/);
  });

  test("the button's request stays open while the test runs, and an edit meanwhile survives", async () => {
    const held = holdCopies();
    try {
      const dest = await addLocal("Office NAS", nasDir);
      let settled = false;
      const testing = call<TestResult>("POST", `/api/backup-destinations/${dest.id}/test`).then(
        (result) => {
          settled = true;
          return result;
        },
      );
      await held.reached("Office NAS");
      assert.equal(settled, false, "no answer until the test has run");
      const renamed = await call<DestinationJson>("PUT", `/api/backup-destinations/${dest.id}`, {
        name: "Renamed NAS",
        enabled: false,
      });
      assert.equal(renamed.status, 200);

      await held.fail("Office NAS", "NT_STATUS_ACCESS_DENIED: the account can't write there");
      const { status, body } = await testing;

      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.message, "NT_STATUS_ACCESS_DENIED: the account can't write there");
      const row = await listed(dest.id);
      assert.equal(row.name, "Renamed NAS", "the test did not save over the rename");
      assert.equal(row.enabled, false, "nor over the pause");
      assert.equal(row.lastStatus, "error", "while recording its own result");
      assert.equal(row.lastError, body.message);
    } finally {
      held.release();
    }
  });

  test("an unknown destination is a 404 with a reason", async () => {
    const { status, body } = await call("POST", "/api/backup-destinations/no-such-id/test");
    assert.equal(status, 404);
    assert.equal(body.error, "This destination no longer exists.");
    const tooLong = await call("POST", `/api/backup-destinations/${"x".repeat(65)}/test`);
    assert.equal(tooLong.status, 400);
  });

  test("only a signed-in master admin may test", async () => {
    const dest = await addLocal("Office NAS", nasDir);
    actingUserId = null;
    assert.equal((await call("POST", `/api/backup-destinations/${dest.id}/test`)).status, 401);
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
      isMasterAdmin: false,
      emailVerifiedAt: new Date(),
    });
    actingUserId = member.id;
    const refused = await call("POST", `/api/backup-destinations/${dest.id}/test`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, "Master admin access required");
  });
});

describe("removing and editing a destination", () => {
  test("removing one drops History's record of its copies, not the copies", async () => {
    const dest = await addLocal("Office NAS", nasDir);
    const backup = await insert(Backup, {
      filename: "backup-2026-10-22-030000.zip",
      kind: "scheduled",
      status: "completed",
      copiesTracked: true,
    });
    await AppDataSource.getRepository(BackupCopy).save(
      AppDataSource.getRepository(BackupCopy).create({
        backupId: backup.id,
        destinationId: dest.id,
        status: "copied",
        error: "",
      }),
    );
    await fs.writeFile(path.join(nasDir, backup.filename), "the copy");

    const { status, body } = await call("DELETE", `/api/backup-destinations/${dest.id}`);

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(await AppDataSource.getRepository(BackupCopy).count(), 0);
    assert.deepEqual(await fs.readdir(nasDir), [backup.filename], "the copy stays there");
    const again = await call("DELETE", `/api/backup-destinations/${dest.id}`);
    assert.equal(again.status, 404);
  });

  test("one being copied to can't be removed, and says why", async () => {
    const copies = holdCopies();
    try {
      const dest = await addLocal("Office NAS", nasDir);
      const filename = "backup-2026-10-22-030000.zip";
      await fs.mkdir(path.dirname(backupFilePath(filename)), { recursive: true });
      await fs.writeFile(backupFilePath(filename), "archive");
      const backup = await insert(Backup, {
        filename,
        kind: "scheduled",
        status: "completed",
        copiesTracked: true,
      });
      await call("POST", `/api/backups/${backup.id}/deliver`);
      await copies.reached("Office NAS");

      const { status, body } = await call("DELETE", `/api/backup-destinations/${dest.id}`);

      assert.equal(status, 409);
      assert.match(String(body.error), /being copied to Office NAS right now/);
      await copies.pass("Office NAS");
    } finally {
      copies.release();
    }
  });

  test("edits and new destinations are validated", async () => {
    const dest = await addLocal("Office NAS", nasDir);
    const badPort = await call("PUT", `/api/backup-destinations/${dest.id}`, { port: 70000 });
    assert.equal(badPort.status, 400);
    const unknown = await call("PUT", "/api/backup-destinations/no-such-id", { name: "x" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "This destination no longer exists.");
    const noPath = await call("POST", "/api/backup-destinations", { name: "x", kind: "local" });
    assert.equal(noPath.status, 400);
    const noPassword = await call("POST", "/api/backup-destinations", {
      name: "x",
      kind: "smb",
      host: "nas",
      share: "backups",
      username: "u",
    });
    assert.equal(noPassword.status, 400);
  });
});
