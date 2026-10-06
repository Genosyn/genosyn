import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import {
  DEFAULT_RESOURCE_LIBRARY_ACCESS,
  EmployeeResourceLibraryGrant,
  RESOURCE_LIBRARY_ACCESS_LEVELS,
  type ResourceLibraryAccessLevel,
} from "../db/entities/EmployeeResourceLibraryGrant.js";
import { Resource } from "../db/entities/Resource.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { TOOL_DOMAINS } from "./agent/tools/toolIndex.js";
import {
  RESOURCE_READ_ONLY_ERROR,
  RESOURCE_WRITE_TOOLS,
  ResourceLibraryAccessNotFoundError,
  canWriteResourceLibrary,
  composeResourceLibraryContext,
  effectiveResourceLibraryAccess,
  getResourceLibraryAccess,
  getResourceLibraryAccessRow,
  listResourceLibraryAccess,
  setResourceLibraryAccess,
} from "./resourceLibraryAccess.js";
import {
  RESERVED_RESOURCE_SLUGS,
  deleteResourceGrantsForEmployee,
  uniqueResourceSlug,
} from "./resources.js";

/**
 * Resources → AI access, below the HTTP and MCP seams.
 *
 * The requester asked for one thing above all: AI Employees read and write
 * Resources by default, and an owner can narrow one to read only. Most of what
 * can go wrong is a default that silently flips — an upgrade that makes every
 * existing employee read-only, or an unknown stored value that widens access —
 * so the defaults are pinned here first, then every transition.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function seedCompany(name = "Acme") {
  const company = await insert(Company, {
    name,
    slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: "owner-1",
  });
  return company;
}

async function hire(company: Company, name: string, slug = name.toLowerCase()) {
  return insert(AIEmployee, {
    companyId: company.id,
    name,
    slug,
    role: `${name}'s role`,
    soulBody: "",
  });
}

async function storedRows(employeeId?: string) {
  return AppDataSource.getRepository(EmployeeResourceLibraryGrant).find({
    where: employeeId ? { employeeId } : {},
  });
}

/** Write a level this build does not know, as a rollback from a newer one would leave. */
async function storeRawLevel(company: Company, employee: AIEmployee, level: string) {
  await AppDataSource.getRepository(EmployeeResourceLibraryGrant).save(
    AppDataSource.getRepository(EmployeeResourceLibraryGrant).create({
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: level as ResourceLibraryAccessLevel,
    }),
  );
}

describe("effectiveResourceLibraryAccess", () => {
  test("no stored row means read + write — the default the requester asked for", () => {
    assert.equal(DEFAULT_RESOURCE_LIBRARY_ACCESS, "write");
    assert.equal(effectiveResourceLibraryAccess(undefined), "write");
    assert.equal(effectiveResourceLibraryAccess(null), "write");
  });

  test("each known level reads back as itself", () => {
    for (const level of RESOURCE_LIBRARY_ACCESS_LEVELS) {
      assert.equal(effectiveResourceLibraryAccess(level), level);
    }
  });

  test("a value this build does not know fails closed to read only", () => {
    for (const unknown of ["admin", "owner", "", "WRITE", "Write", "toString", "__proto__", "edit"]) {
      assert.equal(effectiveResourceLibraryAccess(unknown), "read", `"${unknown}" must not widen`);
    }
  });
});

describe("canWriteResourceLibrary", () => {
  test("only read + write may write", () => {
    assert.equal(canWriteResourceLibrary("write"), true);
    assert.equal(canWriteResourceLibrary("read"), false);
  });
});

describe("RESOURCE_WRITE_TOOLS", () => {
  test("names real manifest tools", () => {
    const known = new Set(STATIC_TOOLS.map((tool) => tool.name));
    for (const name of RESOURCE_WRITE_TOOLS) assert.ok(known.has(name), `${name} is not a tool`);
  });

  /**
   * The guard against the next Resource tool. Every tool in the resources
   * domain must be either a read the ceiling leaves alone or a write it
   * refuses — a new mutating tool that lands in neither list would silently
   * let a read-only employee write.
   */
  test("every Resources tool is classified as a read or a write", () => {
    const reads = new Set(["list_resources", "search_resources", "get_resource", "export_resource"]);
    const writes = new Set<string>(RESOURCE_WRITE_TOOLS);
    const unclassified = TOOL_DOMAINS.resources.tools.filter(
      (name) => !reads.has(name) && !writes.has(name),
    );
    assert.deepEqual(unclassified, []);
    for (const name of writes) assert.ok(!reads.has(name));
  });

  test("the refusal names the setting, its location, and what still works", () => {
    assert.match(RESOURCE_READ_ONLY_ERROR, /^No grant:/);
    assert.match(RESOURCE_READ_ONLY_ERROR, /read only/);
    assert.match(RESOURCE_READ_ONLY_ERROR, /Resources → AI access/);
    assert.match(RESOURCE_READ_ONLY_ERROR, /list, search, read, and export/);
  });
});

describe("getResourceLibraryAccess", () => {
  test("an employee nobody has touched holds read + write", async () => {
    const company = await seedCompany("Default");
    const ada = await hire(company, "Ada");
    assert.equal(await getResourceLibraryAccess(ada.id), "write");
  });

  test("an id that is not an employee at all also reads as the default", async () => {
    assert.equal(await getResourceLibraryAccess("not-an-employee"), "write");
  });

  test("a stored level is returned, and it is per employee", async () => {
    const company = await seedCompany("Levels");
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    assert.equal(await getResourceLibraryAccess(ada.id), "read");
    assert.equal(await getResourceLibraryAccess(bob.id), "write");
  });

  test("an unrecognized stored level fails closed", async () => {
    const company = await seedCompany("Unknown");
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    assert.equal(await getResourceLibraryAccess(ada.id), "read");
  });
});

describe("setResourceLibraryAccess", () => {
  test("narrowing to read only writes one row and reports the change", async () => {
    const company = await seedCompany("Narrow");
    const ada = await hire(company, "Ada");
    const change = await setResourceLibraryAccess(company.id, ada.id, "read");
    assert.equal(change.changed, true);
    assert.equal(change.previous, "write");
    assert.equal(change.accessLevel, "read");
    assert.equal(change.employee.id, ada.id);
    const rows = await storedRows(ada.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].accessLevel, "read");
    assert.equal(rows[0].companyId, company.id);
  });

  test("asking for the level an employee already holds writes nothing", async () => {
    const company = await seedCompany("Idempotent");
    const ada = await hire(company, "Ada");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    const again = await setResourceLibraryAccess(company.id, ada.id, "read");
    assert.equal(again.changed, false);
    assert.equal(again.previous, "read");
    assert.equal((await storedRows(ada.id)).length, 1);
  });

  test("asking for read + write on an untouched employee creates no row", async () => {
    const company = await seedCompany("Untouched");
    const ada = await hire(company, "Ada");
    const change = await setResourceLibraryAccess(company.id, ada.id, "write");
    assert.equal(change.changed, false);
    assert.equal(change.previous, "write");
    assert.deepEqual(await storedRows(ada.id), []);
  });

  test("restoring read + write moves the same row rather than adding one", async () => {
    const company = await seedCompany("Restore");
    const ada = await hire(company, "Ada");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    const [before] = await storedRows(ada.id);
    const change = await setResourceLibraryAccess(company.id, ada.id, "write");
    assert.equal(change.changed, true);
    assert.equal(change.previous, "read");
    const rows = await storedRows(ada.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, before.id);
    assert.equal(rows[0].accessLevel, "write");
    assert.equal(await getResourceLibraryAccess(ada.id), "write");
  });

  test("an unrecognized stored level is replaced by whatever is asked for", async () => {
    const company = await seedCompany("Normalize");
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    const toRead = await setResourceLibraryAccess(company.id, ada.id, "read");
    assert.equal(toRead.changed, true, "the stored value still changed");
    assert.equal(toRead.previous, "read", "and before the call it already read as read only");
    assert.equal((await storedRows(ada.id))[0].accessLevel, "read");

    const bob = await hire(company, "Bob");
    await storeRawLevel(company, bob, "superuser");
    const toWrite = await setResourceLibraryAccess(company.id, bob.id, "write");
    assert.equal(toWrite.changed, true);
    assert.equal(await getResourceLibraryAccess(bob.id), "write");
  });

  test("an employee of another company is not found, and nothing is written", async () => {
    const mine = await seedCompany("Mine");
    const theirs = await seedCompany("Theirs");
    const outsider = await hire(theirs, "Outsider");
    await assert.rejects(
      setResourceLibraryAccess(mine.id, outsider.id, "read"),
      ResourceLibraryAccessNotFoundError,
    );
    assert.deepEqual(await storedRows(outsider.id), []);
    assert.equal(await getResourceLibraryAccess(outsider.id), "write");
  });

  test("an unknown employee id is not found", async () => {
    const company = await seedCompany("Ghost");
    await assert.rejects(
      setResourceLibraryAccess(company.id, "00000000-0000-4000-8000-000000000000", "read"),
      ResourceLibraryAccessNotFoundError,
    );
    assert.deepEqual(await storedRows(), []);
  });
});

describe("listResourceLibraryAccess", () => {
  test("lists the whole roster alphabetically, untouched employees at the default", async () => {
    const company = await seedCompany("Roster");
    const zed = await hire(company, "Zed");
    const ada = await hire(company, "Ada");
    const mia = await hire(company, "Mia");
    await setResourceLibraryAccess(company.id, mia.id, "read");

    const rows = await listResourceLibraryAccess(company.id);
    assert.deepEqual(
      rows.map((row) => [row.employee.name, row.accessLevel, row.isDefault]),
      [
        ["Ada", "write", true],
        ["Mia", "read", false],
        ["Zed", "write", true],
      ],
    );
    assert.deepEqual(rows[0].employee, {
      id: ada.id,
      name: "Ada",
      slug: "ada",
      role: "Ada's role",
      avatarKey: null,
    });
    assert.ok(rows.some((row) => row.employee.id === zed.id));
  });

  test("an explicit read + write row is no longer the default but reads the same", async () => {
    const company = await seedCompany("Explicit");
    const ada = await hire(company, "Ada");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    await setResourceLibraryAccess(company.id, ada.id, "write");
    const [row] = await listResourceLibraryAccess(company.id);
    assert.equal(row.accessLevel, "write");
    assert.equal(row.isDefault, false);
  });

  test("never lists another company's employees or applies their rows", async () => {
    const mine = await seedCompany("Mine");
    const theirs = await seedCompany("Theirs");
    const ada = await hire(mine, "Ada");
    const outsider = await hire(theirs, "Outsider");
    await setResourceLibraryAccess(theirs.id, outsider.id, "read");

    const rows = await listResourceLibraryAccess(mine.id);
    assert.deepEqual(
      rows.map((row) => row.employee.id),
      [ada.id],
    );
    assert.equal(rows[0].accessLevel, "write");
  });

  test("a stored row is matched by employee, even if its companyId went stale", async () => {
    // The MCP gate keys by employee alone. The list must agree with it, or the
    // page could say read + write while every write is refused.
    const company = await seedCompany("Stale");
    const ada = await hire(company, "Ada");
    await insert(EmployeeResourceLibraryGrant, {
      companyId: "some-other-company",
      employeeId: ada.id,
      accessLevel: "read",
    });
    const [row] = await listResourceLibraryAccess(company.id);
    assert.equal(row.accessLevel, "read");
    assert.equal(row.accessLevel, await getResourceLibraryAccess(ada.id));
  });

  test("an unrecognized stored level is listed as read only", async () => {
    const company = await seedCompany("UnknownList");
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    const [row] = await listResourceLibraryAccess(company.id);
    assert.equal(row.accessLevel, "read");
    assert.equal(row.isDefault, false);
  });

  test("a company without AI Employees lists nothing", async () => {
    const company = await seedCompany("Empty");
    assert.deepEqual(await listResourceLibraryAccess(company.id), []);
  });
});

describe("getResourceLibraryAccessRow", () => {
  test("returns one employee's row in the list's shape", async () => {
    const company = await seedCompany("Row");
    const ada = await hire(company, "Ada");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    const row = await getResourceLibraryAccessRow(company.id, ada.id);
    const [listed] = await listResourceLibraryAccess(company.id);
    assert.deepEqual(row, listed);
  });

  test("is null for another company's employee and for an unknown id", async () => {
    const mine = await seedCompany("Mine");
    const theirs = await seedCompany("Theirs");
    const outsider = await hire(theirs, "Outsider");
    assert.equal(await getResourceLibraryAccessRow(mine.id, outsider.id), null);
    assert.equal(
      await getResourceLibraryAccessRow(mine.id, "00000000-0000-4000-8000-000000000000"),
      null,
    );
  });
});

describe("composeResourceLibraryContext", () => {
  test("adds nothing to the prompt for read + write, default or explicit", async () => {
    const company = await seedCompany("Quiet");
    const ada = await hire(company, "Ada");
    assert.equal(await composeResourceLibraryContext(ada.id), "");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    await setResourceLibraryAccess(company.id, ada.id, "write");
    assert.equal(await composeResourceLibraryContext(ada.id), "");
  });

  test("tells a read-only employee what it can still do and which tools are refused", async () => {
    const company = await seedCompany("Briefed");
    const ada = await hire(company, "Ada");
    await setResourceLibraryAccess(company.id, ada.id, "read");
    const block = await composeResourceLibraryContext(ada.id);
    assert.match(block, /## Resources/);
    assert.match(block, /\*\*read only\*\*/);
    assert.match(block, /Resources → AI access/);
    assert.match(block, /Reading is unaffected/);
    for (const tool of RESOURCE_WRITE_TOOLS) assert.ok(block.includes(`\`${tool}\``), tool);
    assert.match(block, /instead of retrying/);
  });

  test("an unrecognized stored level is briefed as read only, like the gate treats it", async () => {
    const company = await seedCompany("UnknownBrief");
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    assert.match(await composeResourceLibraryContext(ada.id), /\*\*read only\*\*/);
  });
});

describe("deleteResourceGrantsForEmployee", () => {
  test("firing an employee drops its library row along with its per-Resource grants", async () => {
    const company = await seedCompany("Fired");
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    const resource = await insert(Resource, {
      companyId: company.id,
      title: "Handbook",
      slug: "handbook",
      sourceKind: "text",
      bodyText: "…",
      status: "ready",
    });
    await insert(EmployeeResourceGrant, {
      employeeId: ada.id,
      resourceId: resource.id,
      accessLevel: "delete",
    });
    await setResourceLibraryAccess(company.id, ada.id, "read");
    await setResourceLibraryAccess(company.id, bob.id, "read");

    await deleteResourceGrantsForEmployee(ada.id);

    assert.deepEqual(await storedRows(ada.id), []);
    assert.equal(
      await AppDataSource.getRepository(EmployeeResourceGrant).count({
        where: { employeeId: ada.id },
      }),
      0,
    );
    assert.equal((await storedRows(bob.id)).length, 1, "a teammate's setting is untouched");
  });
});

describe("uniqueResourceSlug", () => {
  test("never mints a slug the Resources section spends on its own pages", async () => {
    const company = await seedCompany("Slugs");
    assert.ok(RESERVED_RESOURCE_SLUGS.has("ai-access"));
    assert.ok(RESERVED_RESOURCE_SLUGS.has("integrations"));
    assert.equal(await uniqueResourceSlug(company.id, "ai-access"), "ai-access-2");
    assert.equal(await uniqueResourceSlug(company.id, "integrations"), "integrations-2");
  });

  test("keeps counting past a taken suffix and leaves ordinary slugs alone", async () => {
    const company = await seedCompany("Counting");
    await insert(Resource, {
      companyId: company.id,
      title: "AI access",
      slug: "ai-access-2",
      sourceKind: "text",
      bodyText: "…",
      status: "ready",
    });
    assert.equal(await uniqueResourceSlug(company.id, "ai-access"), "ai-access-3");
    assert.equal(await uniqueResourceSlug(company.id, "ai-access-policy"), "ai-access-policy");
    assert.equal(await uniqueResourceSlug(company.id, ""), "resource");
  });
});
