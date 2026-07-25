import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { loadStorageState, saveStorageState } from "./browserStorage.js";
import { employeeBrowserStateFile } from "./paths.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-browser-storage-"));
  mutableConfig.dataDir = tempDir;
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(path.join(tempDir, "companies"), { recursive: true, force: true });
});

after(async () => {
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function identity(
  companyId = "company",
  employeeId = "employee",
): Promise<void> {
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

    const file = employeeBrowserStateFile("company-slug", "employee-slug");
    const mode = (await fs.stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
    const siblings = await fs.readdir(path.dirname(file));
    assert.deepEqual(siblings, [".browser-state.json"]);
  });

  test("returns undefined for missing, malformed, or structurally invalid snapshots", async () => {
    await identity();
    assert.equal(await loadStorageState("company", "employee"), undefined);
    const file = employeeBrowserStateFile("company-slug", "employee-slug");
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
