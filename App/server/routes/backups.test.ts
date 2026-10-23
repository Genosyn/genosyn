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
import { User } from "../db/entities/User.js";
import { resetInstanceSecretsCacheForTests } from "../lib/instanceSecrets.js";
import { errorHandler } from "../middleware/error.js";
import { createDestination, isDeliveryRunning } from "../services/backupDestinations.js";
import { backupFilePath, isBackupRunning, updateBackupSchedule } from "../services/backups.js";
import { holdCopies } from "../test/backupCopyGate.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { backupDestinationsRouter } from "./backupDestinations.js";
import { backupsRouter } from "./backups.js";

/**
 * Admin → Backups' own endpoints, booted on a real socket.
 *
 * What the page relies on: History saying where each backup is (on this
 * server, and each off-box copy's state), Back up now and Copy off-box
 * answering at once and running on, the schedule saying when it next fires and
 * in which zone, and every refusal reaching the page as its actual reason —
 * the error handler hides anything that isn't a 4xx behind "Internal server
 * error", which is how a refused restore or a bad upload used to read.
 */

type MutableConfig = { dataDir: string; db: { driver: "sqlite" | "postgres" } };
const mutable = config as unknown as MutableConfig;
const originalDataDir = config.dataDir;
const originalDriver = config.db.driver;
const DAY_MS = 24 * 60 * 60 * 1000;

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let tempDir = "";
let nasDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-backup-routes-"));
  mutable.dataDir = path.join(tempDir, "data");
  // The test DB is in-memory, so there is no SQLite file to snapshot.
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
  actingUserId = (await masterAdmin("op@example.com")).id;
});

afterEach(async () => {
  await waitUntil(() => !isBackupRunning() && !isDeliveryRunning(), "background work to settle");
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

async function masterAdmin(email: string, verified = true): Promise<User> {
  return insert(User, {
    email,
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: verified ? new Date() : null,
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Json = Record<string, unknown>;

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
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as T };
}

type CopyJson = { destinationId: string; status: string; error: string; copiedAt: string | null };
type HistoryJson = {
  id: string;
  filename: string;
  kind: string;
  status: string;
  onServer: boolean;
  inProgress: boolean;
  copiesTracked: boolean;
  copies: CopyJson[];
};

async function history(): Promise<HistoryJson[]> {
  const { status, body } = await call<HistoryJson[]>("GET", "/api/backups");
  assert.equal(status, 200);
  return body;
}

function archiveName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}.zip`;
}

/** A finished backup whose archive is on this server. */
async function backupOnServer(takenAt = new Date(Date.now() - DAY_MS), copiesTracked = true) {
  const filename = archiveName(takenAt);
  await fs.mkdir(path.dirname(backupFilePath(filename)), { recursive: true });
  await fs.writeFile(backupFilePath(filename), `archive ${filename}`);
  const row = await insert(Backup, {
    filename,
    sizeBytes: Buffer.byteLength(`archive ${filename}`),
    kind: "scheduled",
    status: "completed",
    errorMessage: "",
    copiesTracked,
    completedAt: takenAt,
  });
  await AppDataSource.getRepository(Backup).update({ id: row.id }, { createdAt: takenAt });
  return row;
}

async function nas(name = "NAS", enabled = true) {
  return createDestination({ name, kind: "local", path: nasDir, enabled }, null);
}

describe("who may use the backup endpoints", () => {
  test("someone signed out is turned away", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/api/backups")).status, 401);
    assert.equal((await call("POST", "/api/backups")).status, 401);
    assert.equal((await call("GET", "/api/backups/schedule")).status, 401);
  });

  test("a Member who is not a master admin is refused", async () => {
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
      isMasterAdmin: false,
      emailVerifiedAt: new Date(),
    });
    actingUserId = member.id;
    const { status, body } = await call("GET", "/api/backups");
    assert.equal(status, 403);
    assert.equal(body.error, "Master admin access required");
    assert.equal((await call("POST", "/api/backups")).status, 403);
    assert.equal((await call("POST", "/api/backups/some-id/deliver")).status, 403);
  });

  test("a master admin who hasn't verified their email is refused", async () => {
    actingUserId = (await masterAdmin("new@example.com", false)).id;
    const { status, body } = await call("GET", "/api/backups");
    assert.equal(status, 403);
    assert.match(String(body.error), /Verify your email/);
  });
});

describe("GET /api/backups", () => {
  test("an install with no backups has an empty History", async () => {
    assert.deepEqual(await history(), []);
  });

  test("each row says whether it is on this server and where its copies are", async () => {
    const dest = await nas();
    const here = await backupOnServer(new Date(Date.now() - DAY_MS));
    const gone = await backupOnServer(new Date(Date.now() - 2 * DAY_MS), false);
    await fs.rm(backupFilePath(gone.filename));
    const repo = AppDataSource.getRepository(BackupCopy);
    await repo.save(
      repo.create({ backupId: here.id, destinationId: dest.id, status: "failed", error: "Full" }),
    );
    await repo.save(
      repo.create({ backupId: gone.id, destinationId: dest.id, status: "copied", error: "" }),
    );

    const rows = await history();

    assert.deepEqual(
      rows.map((row) => row.id),
      [here.id, gone.id],
    );
    assert.equal(rows[0].onServer, true);
    assert.equal(rows[0].inProgress, false);
    assert.equal(rows[0].copiesTracked, true);
    assert.deepEqual(
      rows[0].copies.map((copy) => [copy.destinationId, copy.status, copy.error]),
      [[dest.id, "failed", "Full"]],
    );
    assert.equal(rows[1].onServer, false, "deleted here, still off-box");
    assert.equal(rows[1].copiesTracked, false);
    assert.equal(rows[1].copies[0].status, "copied");
    for (const key of ["filename", "kind", "status", "sizeBytes", "createdAt", "completedAt"]) {
      assert.ok(key in rows[0], `History rows carry ${key}`);
    }
  });
});

describe("POST /api/backups (Back up now)", () => {
  test("answers at once with the backup's History row, then finishes on its own", async () => {
    const dest = await nas();
    const { status, body } = await call<HistoryJson & { alreadyRunning: boolean }>(
      "POST",
      "/api/backups",
    );

    assert.equal(status, 202);
    assert.equal(body.alreadyRunning, false);
    assert.equal(body.kind, "manual");
    assert.ok(["running", "completed"].includes(body.status));
    assert.equal(typeof body.inProgress, "boolean");
    assert.ok(Array.isArray(body.copies));
    assert.equal(body.copiesTracked, true);

    await waitUntil(() => !isBackupRunning(), "the backup to finish");
    const [row] = await history();
    assert.equal(row.id, body.id);
    assert.equal(row.status, "completed");
    assert.equal(row.onServer, true);
    assert.equal(row.inProgress, false);
    assert.deepEqual(
      row.copies.map((copy) => [copy.destinationId, copy.status]),
      [[dest.id, "copied"]],
    );
  });

  test("a second press while a backup runs joins it", async () => {
    const copies = holdCopies();
    try {
      await nas();
      const first = await call<HistoryJson & { alreadyRunning: boolean }>("POST", "/api/backups");
      await copies.reached("NAS");
      const second = await call<HistoryJson & { alreadyRunning: boolean }>("POST", "/api/backups");
      assert.equal(second.status, 202);
      assert.equal(second.body.alreadyRunning, true);
      assert.equal(second.body.id, first.body.id);
      const [row] = await history();
      assert.equal(row.copies[0].status, "copying", "History shows the copy under way");
      await copies.pass("NAS");
    } finally {
      copies.release();
    }
  });
});

describe("POST /api/backups/:id/deliver (Copy off-box, Try again)", () => {
  test("queues a copy to every enabled destination and answers at once", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      const dest = await nas();
      const { status, body } = await call<{
        ok: boolean;
        alreadyRunning: boolean;
        copies: CopyJson[];
      }>("POST", `/api/backups/${backup.id}/deliver`);
      assert.equal(status, 202);
      assert.equal(body.ok, true);
      assert.equal(body.alreadyRunning, false);
      assert.deepEqual(
        body.copies.map((copy) => [copy.destinationId, copy.status]),
        [[dest.id, "pending"]],
      );
      await copies.reached("NAS");
      const again = await call<{ alreadyRunning: boolean; copies: CopyJson[] }>(
        "POST",
        `/api/backups/${backup.id}/deliver`,
      );
      assert.equal(again.status, 202);
      assert.equal(again.body.alreadyRunning, true);
      assert.equal(again.body.copies[0].status, "copying");
      await copies.fail("NAS", "Authentication failed — check the username, password, and domain");
      await waitUntil(() => !isDeliveryRunning(), "the copy to finish");
      const [row] = await history();
      assert.equal(row.copies[0].status, "failed");
      assert.equal(
        row.copies[0].error,
        "Authentication failed — check the username, password, and domain",
      );
    } finally {
      copies.release();
    }
  });

  test("Try again copies to the one destination named, and only there", async () => {
    const backup = await backupOnServer();
    const first = await nas("NAS");
    const other = await createDestination(
      { name: "Other", kind: "local", path: path.join(tempDir, "other") },
      null,
    );
    const { status, body } = await call<{ copies: CopyJson[] }>(
      "POST",
      `/api/backups/${backup.id}/deliver`,
      { destinationId: first.id },
    );
    assert.equal(status, 202);
    assert.deepEqual(
      body.copies.map((copy) => copy.destinationId),
      [first.id],
    );
    await waitUntil(() => !isDeliveryRunning(), "the copy to finish");
    const [row] = await history();
    assert.deepEqual(
      row.copies.map((copy) => [copy.destinationId, copy.status]),
      [[first.id, "copied"]],
    );
    assert.ok(!row.copies.some((copy) => copy.destinationId === other.id));
  });

  test("refusals carry their reason and status", async () => {
    const unknown = await call("POST", "/api/backups/no-such-backup/deliver");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "This backup no longer exists.");

    const backup = await backupOnServer();
    const none = await call("POST", `/api/backups/${backup.id}/deliver`);
    assert.equal(none.status, 409);
    assert.match(String(none.body.error), /No off-box destination is turned on/);

    await nas();
    const missingDest = await call("POST", `/api/backups/${backup.id}/deliver`, {
      destinationId: "no-such-destination",
    });
    assert.equal(missingDest.status, 404);
    assert.equal(missingDest.body.error, "That off-box destination no longer exists.");

    await fs.rm(backupFilePath(backup.filename));
    const gone = await call("POST", `/api/backups/${backup.id}/deliver`);
    assert.equal(gone.status, 409);
    assert.match(String(gone.body.error), /no longer on this server/);
  });

  test("the body is validated", async () => {
    const backup = await backupOnServer();
    await nas();
    const wrongType = await call("POST", `/api/backups/${backup.id}/deliver`, {
      destinationId: 42,
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error, "ValidationError");
    const unknownField = await call("POST", `/api/backups/${backup.id}/deliver`, {
      everywhere: true,
    });
    assert.equal(unknownField.status, 400);
    const empty = await call("POST", `/api/backups/${backup.id}/deliver`, { destinationId: "" });
    assert.equal(empty.status, 400);
    const longId = await call("POST", `/api/backups/${"x".repeat(65)}/deliver`);
    assert.equal(longId.status, 400, "the id is validated too");
  });
});

describe("DELETE /api/backups/:id", () => {
  test("deletes the backup here and History's record of its copies", async () => {
    const backup = await backupOnServer();
    const dest = await nas();
    await AppDataSource.getRepository(BackupCopy).save(
      AppDataSource.getRepository(BackupCopy).create({
        backupId: backup.id,
        destinationId: dest.id,
        status: "copied",
        error: "",
      }),
    );
    const { status, body } = await call("DELETE", `/api/backups/${backup.id}`);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(await history(), []);
    assert.equal(await AppDataSource.getRepository(BackupCopy).count(), 0);
    await assert.rejects(fs.access(backupFilePath(backup.filename)));
  });

  test("an unknown backup is a 404", async () => {
    const { status, body } = await call("DELETE", "/api/backups/no-such-backup");
    assert.equal(status, 404);
    assert.equal(body.error, "This backup no longer exists.");
  });

  test("a backup being copied can't be deleted, and says why", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      await nas();
      await call("POST", `/api/backups/${backup.id}/deliver`);
      await copies.reached("NAS");
      const { status, body } = await call("DELETE", `/api/backups/${backup.id}`);
      assert.equal(status, 409);
      assert.match(String(body.error), /being copied off-box right now/);
      await copies.pass("NAS");
    } finally {
      copies.release();
    }
  });
});

describe("POST /api/backups/:id/restore", () => {
  test("refusals reach the page as their reason, not as an internal error", async () => {
    const unknown = await call("POST", "/api/backups/no-such-backup/restore");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "This backup no longer exists.");

    const failed = await insert(Backup, {
      filename: archiveName(new Date()),
      kind: "manual",
      status: "failed",
      errorMessage: "Disk full",
    });
    const notFinished = await call("POST", `/api/backups/${failed.id}/restore`);
    assert.equal(notFinished.status, 409);
    assert.equal(notFinished.body.error, "Only a finished backup can be restored.");

    const gone = await backupOnServer();
    await fs.rm(backupFilePath(gone.filename));
    const missing = await call("POST", `/api/backups/${gone.id}/restore`);
    assert.equal(missing.status, 409);
    assert.match(String(missing.body.error), /no longer on this server/);

    const damaged = await backupOnServer(new Date(Date.now() - 2 * DAY_MS));
    const notAZip = await call("POST", `/api/backups/${damaged.id}/restore`);
    assert.equal(notAZip.status, 409);
    assert.match(String(notAZip.body.error), /incomplete or damaged/);
  });

  test("a restore waits for copies under way", async () => {
    const copies = holdCopies();
    try {
      const backup = await backupOnServer();
      await nas();
      await call("POST", `/api/backups/${backup.id}/deliver`);
      await copies.reached("NAS");
      const { status, body } = await call("POST", `/api/backups/${backup.id}/restore`);
      assert.equal(status, 409);
      assert.match(String(body.error), /being copied off-box right now/);
      await copies.pass("NAS");
    } finally {
      copies.release();
    }
  });
});

describe("GET /api/backups/:id/download", () => {
  test("serves an archive on this server, and 404s one that is gone", async () => {
    const backup = await backupOnServer();
    const response = await fetch(`${baseUrl}/api/backups/${backup.id}/download`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `archive ${backup.filename}`);
    assert.match(response.headers.get("content-disposition") ?? "", new RegExp(backup.filename));

    await fs.rm(backupFilePath(backup.filename));
    const gone = await call("GET", `/api/backups/${backup.id}/download`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error, "This backup is no longer on this server.");
    assert.equal((await call("GET", "/api/backups/nope/download")).status, 404);
  });
});

describe("POST /api/backups/upload", () => {
  test("a file that isn't an archive is refused with the reason", async () => {
    const response = await fetch(`${baseUrl}/api/backups/upload`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: Buffer.from("definitely not a zip"),
    });
    const body = (await response.json()) as Json;
    assert.equal(response.status, 400);
    assert.equal(body.error, "The uploaded file is not a complete zip archive.");
    const [row] = await history();
    assert.equal(row.kind, "uploaded");
    assert.equal(row.status, "failed", "History shows the failed upload with its reason");
  });
});

describe("the schedule", () => {
  test("says when it next fires, and in the server's time zone", async () => {
    const off = await call<{ nextRunAt: string | null; timeZone: string; enabled: boolean }>(
      "GET",
      "/api/backups/schedule",
    );
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.nextRunAt, null, "nothing is next while it is off");
    assert.equal(off.body.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);

    try {
      const on = await call<{ nextRunAt: string; hour: number }>("PUT", "/api/backups/schedule", {
        enabled: true,
        frequency: "daily",
        hour: 3,
      });
      assert.equal(on.status, 200);
      const next = new Date(on.body.nextRunAt);
      assert.ok(next.getTime() > Date.now(), "the next run is in the future");
      assert.ok(next.getTime() <= Date.now() + DAY_MS, "and within a day");
      assert.equal(next.getHours(), 3, "at the schedule's hour, server time");
      assert.equal(next.getMinutes(), 0);

      const weekly = await call<{ nextRunAt: string }>("PUT", "/api/backups/schedule", {
        frequency: "weekly",
        dayOfWeek: 1,
      });
      const monday = new Date(weekly.body.nextRunAt);
      assert.equal(monday.getDay(), 1, "a weekly schedule next fires on its day");
      assert.ok(monday.getTime() <= Date.now() + 7 * DAY_MS);
    } finally {
      // Off again, which also stops its cron timer.
      await updateBackupSchedule({ enabled: false });
    }
  });

  test("rejects a schedule that can't be kept", async () => {
    for (const body of [
      { hour: 24 },
      { frequency: "hourly" },
      { dayOfMonth: 29 },
      { retentionDays: 0 },
      { offBoxRetentionDays: 9999 },
      { enabled: "yes" },
    ]) {
      const response = await call("PUT", "/api/backups/schedule", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError");
    }
  });
});

describe("POST /api/backups/verification", () => {
  test("fills in where a backup from before copies were recorded really is", async () => {
    const dest = await nas();
    const legacy = await backupOnServer(new Date(Date.now() - DAY_MS), false);
    await fs.copyFile(backupFilePath(legacy.filename), path.join(nasDir, legacy.filename));
    const before = await history();
    assert.deepEqual(before[0].copies, [], "not recorded until verification looks");

    const { status } = await call("POST", "/api/backups/verification");
    assert.equal(status, 200);

    const [row] = await history();
    assert.deepEqual(
      row.copies.map((copy) => [copy.destinationId, copy.status, copy.copiedAt]),
      [[dest.id, "copied", null]],
    );
  });
});
