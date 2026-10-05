import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { clearStaleProfileLock } from "./browserProfileLock.js";

/**
 * Chrome refuses a profile whose lock names another host, and every upgrade
 * recreates the container under a new hostname, so a lock an unclean stop left
 * behind used to cost the employee their profile for good. Breaking a stale
 * lock is the fix; breaking a live one is two Chromes writing one Cookies
 * database. Both halves are pinned here against a real directory laid out the
 * way Chrome lays it out.
 */

const ALL_ENTRIES = ["SingletonCookie", "SingletonLock", "SingletonSocket"];

let profileDir = "";

/** The three symlinks a running Chrome keeps in its profile directory. */
async function lockProfile(holder: string): Promise<void> {
  await fs.symlink(holder, path.join(profileDir, "SingletonLock"));
  await fs.symlink("4211583926142307168", path.join(profileDir, "SingletonCookie"));
  await fs.symlink(
    "/tmp/.com.google.Chrome.Xz9Q2c/SingletonSocket",
    path.join(profileDir, "SingletonSocket"),
  );
}

async function singletonEntries(): Promise<string[]> {
  const entries = await fs.readdir(profileDir);
  return entries.filter((entry) => entry.startsWith("Singleton")).sort();
}

beforeEach(async () => {
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-profile-lock-"));
  await fs.writeFile(path.join(profileDir, "Local State"), "{}");
});

afterEach(async () => {
  await fs.rm(profileDir, { recursive: true, force: true });
});

describe("clearStaleProfileLock", () => {
  test("clears a lock left by a container that no longer exists", async () => {
    // The lock from the production report: the previous container's hostname.
    await lockProfile("3574345a1645-979");

    assert.equal(await clearStaleProfileLock(profileDir), "3574345a1645-979");
    assert.deepEqual(await singletonEntries(), []);
    // Only the lock goes. The rest of the profile is the reason to keep it.
    assert.equal(await fs.readFile(path.join(profileDir, "Local State"), "utf8"), "{}");
  });

  test("leaves a live lock on this host alone", async () => {
    // This test's own process, which is certainly running.
    await lockProfile(`${os.hostname()}-${process.pid}`);

    assert.equal(await clearStaleProfileLock(profileDir), null);
    assert.deepEqual(await singletonEntries(), ALL_ENTRIES);
  });

  test("clears a lock on this host whose process has exited", async () => {
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    const holder = `${os.hostname()}-${pid}`;
    await lockProfile(holder);

    assert.equal(await clearStaleProfileLock(profileDir), holder);
    assert.deepEqual(await singletonEntries(), []);
  });

  test("reads the hostname up to the last hyphen, as Chrome does", async (t) => {
    // A Kubernetes pod name. Split at the first hyphen, this live lock would
    // read as one from a host called "genosyn" and be broken under its Chrome.
    t.mock.method(os, "hostname", () => "genosyn-7d9f8c6b5-x2x4q");
    await lockProfile(`genosyn-7d9f8c6b5-x2x4q-${process.pid}`);

    assert.equal(await clearStaleProfileLock(profileDir), null);
    assert.deepEqual(await singletonEntries(), ALL_ENTRIES);
  });
});
