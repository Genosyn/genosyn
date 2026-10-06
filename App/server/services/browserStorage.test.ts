import assert from "node:assert/strict";
import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  loadStorageState,
  migrateLegacyBrowserStorage,
  saveStorageState,
} from "./browserStorage.js";
import { employeeBrowserStateFile, employeeDir, legacyEmployeeBrowserStateFile } from "./paths.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-browser-storage-"));
  mutableConfig.dataDir = tempDir;
});

beforeEach(async () => {
  await resetTestDb();
  await Promise.all([
    fs.rm(path.join(tempDir, "companies"), { recursive: true, force: true }),
    fs.rm(path.join(tempDir, ".private"), { recursive: true, force: true }),
  ]);
});

after(async () => {
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function identity(companyId = "company", employeeId = "employee"): Promise<void> {
  await insert(Company, {
    id: companyId,
    name: "Test Company",
    slug: `${companyId}-slug`,
    ownerId: "owner",
  });
  await insert(AIEmployee, {
    id: employeeId,
    companyId,
    name: "Browser Employee",
    slug: `${employeeId}-slug`,
    role: "Researcher",
  });
}

describe("browser storage-state persistence", () => {
  test("round-trips cookies and origins through a private atomic file", async () => {
    await identity();
    const state = {
      cookies: [{ name: "session", value: "abc" }],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [{ name: "theme", value: "dark" }],
        },
      ],
    };
    await saveStorageState("company", "employee", {
      storageState: async () => state,
    });
    assert.deepEqual(await loadStorageState("company", "employee"), state);

    const file = employeeBrowserStateFile("company", "employee");
    const mode = (await fs.stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(file.startsWith(employeeDir("company-slug", "employee-slug")), false);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    const siblings = await fs.readdir(path.dirname(file));
    assert.deepEqual(siblings, ["employee.json"]);
  });

  test("returns undefined for missing, malformed, or structurally invalid snapshots", async () => {
    await identity();
    assert.equal(await loadStorageState("company", "employee"), undefined);
    const file = employeeBrowserStateFile("company", "employee");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{");
    assert.equal(await loadStorageState("company", "employee"), undefined);
    await fs.writeFile(file, JSON.stringify({ cookies: {}, origins: [] }));
    assert.equal(await loadStorageState("company", "employee"), undefined);
    await fs.writeFile(file, JSON.stringify({ cookies: [], origins: {} }));
    assert.equal(await loadStorageState("company", "employee"), undefined);
  });

  test("does nothing when either identity row is missing", async () => {
    let called = 0;
    const context = {
      storageState: async () => {
        called += 1;
        return { cookies: [], origins: [] };
      },
    };
    await saveStorageState("missing", "employee", context);
    assert.equal(await loadStorageState("missing", "employee"), undefined);
    assert.equal(called, 0);

    await insert(Company, {
      id: "company",
      name: "Test Company",
      slug: "company-slug",
      ownerId: "owner",
    });
    await saveStorageState("company", "missing", context);
    assert.equal(called, 0);
  });

  test("requires the AI Employee to belong to the supplied company", async () => {
    await identity("company-a", "employee-a");
    await insert(Company, {
      id: "company-b",
      name: "Other Company",
      slug: "company-b-slug",
      ownerId: "owner",
    });
    let called = false;
    await saveStorageState("company-b", "employee-a", {
      storageState: async () => {
        called = true;
        return { cookies: [], origins: [] };
      },
    });
    assert.equal(called, false);
    assert.equal(await loadStorageState("company-b", "employee-a"), undefined);
  });

  test("atomically migrates and removes every workspace-visible legacy artifact", async () => {
    await identity();
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    const state = { cookies: [{ name: "session", value: "legacy" }], origins: [] };
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify(state), { mode: 0o600 });
    await fs.writeFile(`${legacy}.torn.tmp`, "COOKIE_FRAGMENT", { mode: 0o600 });

    await Promise.all([
      migrateLegacyBrowserStorage("company", "employee"),
      migrateLegacyBrowserStorage("company", "employee"),
    ]);

    assert.deepEqual(await loadStorageState("company", "employee"), state);
    const remaining = await fs.readdir(path.dirname(legacy));
    assert.equal(
      remaining.some((name) => name.startsWith(".browser-state.json")),
      false,
    );
    assert.equal(
      (await fs.stat(employeeBrowserStateFile("company", "employee"))).mode & 0o777,
      0o600,
    );
  });

  test("overlapping migrations for one employee wait before reading mutable storage state", async (t) => {
    await identity();
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    const state = { cookies: [{ name: "session", value: "legacy" }], origins: [] };
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify(state));
    await fs.writeFile(`${legacy}.torn.tmp`, "COOKIE_FRAGMENT");
    const entered = barrier();
    const proceed = barrier();
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (source: PathLike, destination: PathLike) => {
      if (source === legacy) {
        entered.release();
        await proceed.promise;
      }
      return rename(source, destination);
    });
    const first = migrateLegacyBrowserStorage("company", "employee");
    await entered.promise;
    const inspections = t.mock.method(fs, "lstat");
    const second = migrateLegacyBrowserStorage("company", "employee");
    try {
      // The first rename remains gated while the competitor gets a turn.
      await delay(100);
      assert.equal(
        inspections.mock.calls.filter((call) => String(call.arguments[0]).startsWith(legacy))
          .length,
        0,
        "the queued migration must not inspect legacy inodes while its predecessor is moving them",
      );
    } finally {
      proceed.release();
      await Promise.allSettled([first, second]);
    }
    await Promise.all([first, second]);
    assert.deepEqual(await loadStorageState("company", "employee"), state);
    assert.deepEqual(await fs.readdir(path.dirname(legacy)), []);
  });

  test("fails closed instead of preserving a workspace hardlink to Browser cookies", async () => {
    await identity();
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    await fs.link(legacy, path.join(path.dirname(legacy), "cookie-alias.txt"));

    await assert.rejects(migrateLegacyBrowserStorage("company", "employee"), /unsafe hard link/);
    await assert.rejects(fs.stat(employeeBrowserStateFile("company", "employee")), /ENOENT/);

    await fs.unlink(path.join(path.dirname(legacy), "cookie-alias.txt"));
    await migrateLegacyBrowserStorage("company", "employee");
    assert.deepEqual(await loadStorageState("company", "employee"), { cookies: [], origins: [] });
  });

  test("a failed migration releases its successor without removing the successor's lock", async (t) => {
    await identity();
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    const state = { cookies: [{ name: "session", value: "retry" }], origins: [] };
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify(state));
    const firstEntered = barrier();
    const firstProceed = barrier();
    const secondEntered = barrier();
    const secondProceed = barrier();
    const rename = fs.rename.bind(fs);
    const failure = new Error("Injected migration rename failure");
    let attempts = 0;
    t.mock.method(fs, "rename", async (source: PathLike, destination: PathLike) => {
      if (source === legacy) {
        attempts++;
        if (attempts === 1) {
          firstEntered.release();
          await firstProceed.promise;
          throw failure;
        }
        if (attempts === 2) {
          secondEntered.release();
          await secondProceed.promise;
        }
      }
      return rename(source, destination);
    });
    const failed = assert.rejects(
      migrateLegacyBrowserStorage("company", "employee"),
      (error) => error === failure,
    );
    await firstEntered.promise;
    const second = migrateLegacyBrowserStorage("company", "employee");
    firstProceed.release();
    await failed;
    await secondEntered.promise;
    const inspections = t.mock.method(fs, "lstat");
    const third = migrateLegacyBrowserStorage("company", "employee");
    try {
      await delay(100);
      assert.equal(
        inspections.mock.calls.filter((call) => String(call.arguments[0]).startsWith(legacy))
          .length,
        0,
        "the failed predecessor must not remove the running successor's tail",
      );
    } finally {
      secondProceed.release();
      await Promise.allSettled([second, third]);
    }
    await Promise.all([second, third]);
    assert.equal(attempts, 2);
    assert.deepEqual(await loadStorageState("company", "employee"), state);

    // A settled tail must not turn later migrations into a cached no-op.
    await fs.writeFile(`${legacy}.later.tmp`, "COOKIE_FRAGMENT");
    await migrateLegacyBrowserStorage("company", "employee");
    assert.deepEqual(await fs.readdir(path.dirname(legacy)), []);
  });

  test("another employee can finish migrating while one employee's rename is blocked", async (t) => {
    await identity();
    await insert(AIEmployee, {
      id: "other",
      companyId: "company",
      name: "Other",
      slug: "other-slug",
      role: "Researcher",
    });
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    const otherLegacy = legacyEmployeeBrowserStateFile("company-slug", "other-slug");
    const state = { cookies: [{ name: "session", value: "first" }], origins: [] };
    const otherState = { cookies: [{ name: "session", value: "other" }], origins: [] };
    for (const [file, value] of [
      [legacy, state],
      [otherLegacy, otherState],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(value));
    }
    const entered = barrier();
    const proceed = barrier();
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (source: PathLike, destination: PathLike) => {
      if (source === legacy) {
        entered.release();
        await proceed.promise;
      }
      return rename(source, destination);
    });
    const first = migrateLegacyBrowserStorage("company", "employee");
    await entered.promise;
    const other = migrateLegacyBrowserStorage("company", "other");
    const timeout = new AbortController();
    try {
      await Promise.race([
        other,
        delay(5_000, undefined, { signal: timeout.signal }).then(() => {
          throw new Error("Unrelated employee migration was blocked");
        }),
      ]);
      assert.deepEqual(
        JSON.parse(await fs.readFile(employeeBrowserStateFile("company", "other"), "utf8")),
        otherState,
      );
      assert.deepEqual(await fs.readdir(path.dirname(otherLegacy)), []);
      assert.equal(await fs.readFile(legacy, "utf8"), JSON.stringify(state));
    } finally {
      timeout.abort();
      proceed.release();
      await Promise.allSettled([first, other]);
    }
    await Promise.all([first, other]);
    assert.deepEqual(await loadStorageState("company", "employee"), state);
  });

  test("repeated migrations remove newly found legacy artifacts and preserve the current private snapshot", async () => {
    await identity();
    const destination = employeeBrowserStateFile("company", "employee");
    const legacy = legacyEmployeeBrowserStateFile("company-slug", "employee-slug");
    const current = { cookies: [{ name: "session", value: "current-private" }], origins: [] };
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(current), { mode: 0o600 });
    for (const stale of ["old", "recreated"]) {
      await fs.writeFile(
        legacy,
        JSON.stringify({ cookies: [{ name: "session", value: stale }], origins: [] }),
      );
      await fs.writeFile(`${legacy}.torn.tmp`, "COOKIE_FRAGMENT");
      await migrateLegacyBrowserStorage("company", "employee");
      assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), current);
      assert.deepEqual(await fs.readdir(path.dirname(legacy)), []);
      assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(destination))).mode & 0o777, 0o700);
    }
  });

  test("swallows a torn-down context failure and leaves no partial file", async () => {
    await identity();
    await saveStorageState("company", "employee", {
      storageState: async () => {
        throw new Error("context closed");
      },
    });
    assert.equal(await loadStorageState("company", "employee"), undefined);
  });

  test("treats a null context as a no-op", async () => {
    await identity();
    await saveStorageState("company", "employee", null);
    assert.equal(await loadStorageState("company", "employee"), undefined);
  });
});
