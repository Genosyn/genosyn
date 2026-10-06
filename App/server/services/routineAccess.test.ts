import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import {
  DEFAULT_ROUTINE_ACCESS,
  EmployeeRoutineGrant,
  ROUTINE_ACCESS_LEVELS,
  type RoutineAccessLevel,
} from "../db/entities/EmployeeRoutineGrant.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { TOOL_DOMAINS } from "./agent/tools/toolIndex.js";
import { captureRecoveryGrants } from "./agent/workRecoveryScope.js";
import {
  ROUTINE_READ_TOOLS,
  ROUTINE_RUN_ONLY_ERROR,
  ROUTINE_SCHEDULE_TRIGGER_REFUSAL,
  ROUTINE_WRITE_TOOLS,
  RoutineAccessNotFoundError,
  canWriteRoutines,
  deleteRoutineAccessForEmployee,
  effectiveRoutineAccess,
  getRoutineAccess,
  getRoutineAccessRow,
  listRoutineAccess,
  routineOwnerRunOnlyError,
  routineWriteRefusalForActor,
  routineWriteRefusalForOwner,
  setRoutineAccess,
} from "./routineAccess.js";

/**
 * Routines → AI access, below the HTTP and MCP seams.
 *
 * The request: a settings page where AI Employees can be held to reading and
 * running Routines without editing them, per employee, across every Routine.
 * Most of what can go wrong is a default that silently flips — an upgrade that
 * stops every existing employee from managing its Routines, or an unknown
 * stored value that widens access — so the defaults are pinned here first,
 * then every transition.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function seedCompany(name = "Acme") {
  return insert(Company, {
    name,
    slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: "owner-1",
  });
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
  return AppDataSource.getRepository(EmployeeRoutineGrant).find({
    where: employeeId ? { employeeId } : {},
  });
}

/** Write a level this build does not know, as a rollback from a newer one would leave. */
async function storeRawLevel(company: Company, employee: AIEmployee, level: string) {
  await AppDataSource.getRepository(EmployeeRoutineGrant).save(
    AppDataSource.getRepository(EmployeeRoutineGrant).create({
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: level as RoutineAccessLevel,
    }),
  );
}

describe("effectiveRoutineAccess", () => {
  test("no stored row means read + write — today's behaviour, unchanged by the upgrade", () => {
    assert.equal(DEFAULT_ROUTINE_ACCESS, "write");
    assert.equal(effectiveRoutineAccess(undefined), "write");
    assert.equal(effectiveRoutineAccess(null), "write");
  });

  test("each known level reads back as itself", () => {
    assert.deepEqual(ROUTINE_ACCESS_LEVELS, ["run", "write"]);
    for (const level of ROUTINE_ACCESS_LEVELS) {
      assert.equal(effectiveRoutineAccess(level), level);
    }
  });

  test("a value this build does not know fails closed to read + run", () => {
    for (const unknown of [
      "admin",
      "owner",
      "full",
      "read",
      "",
      "WRITE",
      "Write",
      "RUN",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      assert.equal(effectiveRoutineAccess(unknown), "run", `"${unknown}" must not widen`);
    }
  });
});

describe("canWriteRoutines", () => {
  test("only read + write may write", () => {
    assert.equal(canWriteRoutines("write"), true);
    assert.equal(canWriteRoutines("run"), false);
  });
});

describe("the Routine tools", () => {
  test("every named tool is a real manifest tool", () => {
    const known = new Set(STATIC_TOOLS.map((tool) => tool.name));
    for (const name of [...ROUTINE_WRITE_TOOLS, ...ROUTINE_READ_TOOLS]) {
      assert.ok(known.has(name), `${name} is not in STATIC_TOOLS`);
    }
  });

  test("every tool in the routines domain is classified as a read or a write", () => {
    // A Routine tool added later must be decided on here — otherwise a new
    // writer would ship ungated by Routines → AI access.
    const classified = new Set<string>([...ROUTINE_WRITE_TOOLS, ...ROUTINE_READ_TOOLS]);
    for (const name of TOOL_DOMAINS.routines.tools) {
      assert.ok(classified.has(name), `${name} must be classified as a Routine read or write`);
    }
    assert.deepEqual(
      [...ROUTINE_WRITE_TOOLS].sort(),
      TOOL_DOMAINS.routines.tools
        .filter((name) => !name.startsWith("list_") && !name.startsWith("get_"))
        .sort(),
    );
  });

  test("Run tools are reads or part of running a Routine, never writes", () => {
    for (const name of TOOL_DOMAINS.runs.tools) {
      assert.equal(
        (ROUTINE_WRITE_TOOLS as readonly string[]).includes(name),
        false,
        `${name} must stay open at read + run`,
      );
    }
    assert.ok((ROUTINE_READ_TOOLS as readonly string[]).includes("list_runs"));
    assert.ok((ROUTINE_READ_TOOLS as readonly string[]).includes("get_run_report"));
  });

  test("the refusals name the setting, its location, and what still works", () => {
    assert.match(ROUTINE_RUN_ONLY_ERROR, /Routines → AI access/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /"write"/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /"run" \(read \+ run\)/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /yours or a teammate's/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /You can still read Routines and their Runs/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /your Routines keep running/);
    assert.match(ROUTINE_RUN_ONLY_ERROR, /propose_revision/);
    const owner = routineOwnerRunOnlyError("Ada");
    assert.match(owner, /Ada's access to Routines is "run"/);
    assert.match(
      owner,
      /no AI Employee can create, edit, re-schedule, pause, re-file, or delete Ada's Routines/,
    );
    assert.match(owner, /Routines → AI access/);
    assert.match(ROUTINE_SCHEDULE_TRIGGER_REFUSAL, /Routines → AI access/);
    assert.match(ROUTINE_SCHEDULE_TRIGGER_REFUSAL, /manual or webhook trigger/);
  });
});

describe("getRoutineAccess", () => {
  test("an employee nobody has touched holds read + write", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    assert.equal(await getRoutineAccess(ada.id), "write");
    assert.deepEqual(await storedRows(), []);
  });

  test("an id that is not an employee at all also reads as the default", async () => {
    assert.equal(await getRoutineAccess("00000000-0000-4000-8000-000000000000"), "write");
  });

  test("a stored level is returned, and it is per employee", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    await setRoutineAccess(company.id, ada.id, "run");
    assert.equal(await getRoutineAccess(ada.id), "run");
    assert.equal(await getRoutineAccess(bob.id), "write");
  });

  test("an unrecognized stored level fails closed", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    assert.equal(await getRoutineAccess(ada.id), "run");
  });
});

describe("routineWriteRefusalForActor / routineWriteRefusalForOwner", () => {
  test("read + write is allowed, as actor and as owner", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    assert.equal(await routineWriteRefusalForActor(ada.id), null);
    assert.equal(await routineWriteRefusalForOwner(ada), null);
    await setRoutineAccess(company.id, ada.id, "write");
    assert.equal(await routineWriteRefusalForActor(ada.id), null);
  });

  test("read + run is refused as actor and protected as owner", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await setRoutineAccess(company.id, ada.id, "run");
    assert.equal(await routineWriteRefusalForActor(ada.id), ROUTINE_RUN_ONLY_ERROR);
    assert.equal(await routineWriteRefusalForOwner(ada), routineOwnerRunOnlyError("Ada"));
  });

  test("an unknown stored level is refused and protected the same way", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "admin");
    assert.equal(await routineWriteRefusalForActor(ada.id), ROUTINE_RUN_ONLY_ERROR);
    assert.equal(await routineWriteRefusalForOwner(ada), routineOwnerRunOnlyError("Ada"));
  });
});

describe("setRoutineAccess", () => {
  test("narrowing to read + run writes one row and reports the change", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    const change = await setRoutineAccess(company.id, ada.id, "run");
    assert.equal(change.changed, true);
    assert.equal(change.previous, "write");
    assert.equal(change.accessLevel, "run");
    assert.equal(change.employee.id, ada.id);
    const rows = await storedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employeeId, ada.id);
    assert.equal(rows[0].companyId, company.id);
    assert.equal(rows[0].accessLevel, "run");
  });

  test("asking for the level an employee already holds writes nothing", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await setRoutineAccess(company.id, ada.id, "run");
    const [before] = await storedRows();
    const again = await setRoutineAccess(company.id, ada.id, "run");
    assert.equal(again.changed, false);
    assert.equal(again.previous, "run");
    const [after] = await storedRows();
    assert.deepEqual(after, before);
  });

  test("asking for read + write on an untouched employee creates no row", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    const change = await setRoutineAccess(company.id, ada.id, "write");
    assert.equal(change.changed, false);
    assert.equal(change.previous, "write");
    assert.deepEqual(await storedRows(), []);
  });

  test("restoring read + write moves the same row rather than adding one", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await setRoutineAccess(company.id, ada.id, "run");
    const [narrowed] = await storedRows();
    const change = await setRoutineAccess(company.id, ada.id, "write");
    assert.equal(change.changed, true);
    assert.equal(change.previous, "run");
    const rows = await storedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, narrowed.id);
    assert.equal(rows[0].accessLevel, "write");
    assert.equal(await getRoutineAccess(ada.id), "write");
  });

  test("an unrecognized stored level is replaced by whatever is asked for", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    await storeRawLevel(company, ada, "superuser");
    await storeRawLevel(company, bob, "superuser");

    const widened = await setRoutineAccess(company.id, ada.id, "write");
    assert.equal(widened.changed, true);
    assert.equal(widened.previous, "run", "the gate treated it as read + run");
    assert.equal((await storedRows(ada.id))[0].accessLevel, "write");

    // Asking for read + run over an unknown level writes too: it already
    // behaved as read + run, but the stored value becomes one this build knows.
    const narrowed = await setRoutineAccess(company.id, bob.id, "run");
    assert.equal(narrowed.changed, true);
    assert.equal(narrowed.previous, "run");
    assert.equal((await storedRows(bob.id))[0].accessLevel, "run");
    assert.equal((await storedRows()).length, 2);
  });

  test("an employee of another company is not found, and nothing is written", async () => {
    const company = await seedCompany();
    const other = await seedCompany("Other");
    const outsider = await hire(other, "Outsider");
    await assert.rejects(
      setRoutineAccess(company.id, outsider.id, "run"),
      RoutineAccessNotFoundError,
    );
    assert.deepEqual(await storedRows(), []);
    assert.equal(await getRoutineAccess(outsider.id), "write");
  });

  test("an unknown employee id is not found", async () => {
    const company = await seedCompany();
    await assert.rejects(
      setRoutineAccess(company.id, "00000000-0000-4000-8000-000000000000", "run"),
      RoutineAccessNotFoundError,
    );
    assert.deepEqual(await storedRows(), []);
  });
});

describe("listRoutineAccess", () => {
  test("lists the whole roster alphabetically, untouched employees at the default", async () => {
    const company = await seedCompany();
    // Hired out of alphabetical order, so the ordering is asserted.
    const cy = await hire(company, "Cy");
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    await setRoutineAccess(company.id, bob.id, "run");
    assert.deepEqual(await listRoutineAccess(company.id), [
      {
        employee: { id: ada.id, name: "Ada", slug: "ada", role: "Ada's role", avatarKey: null },
        accessLevel: "write",
        isDefault: true,
      },
      {
        employee: { id: bob.id, name: "Bob", slug: "bob", role: "Bob's role", avatarKey: null },
        accessLevel: "run",
        isDefault: false,
      },
      {
        employee: { id: cy.id, name: "Cy", slug: "cy", role: "Cy's role", avatarKey: null },
        accessLevel: "write",
        isDefault: true,
      },
    ]);
  });

  test("an explicit read + write row is no longer the default but reads the same", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await setRoutineAccess(company.id, ada.id, "run");
    await setRoutineAccess(company.id, ada.id, "write");
    const [row] = await listRoutineAccess(company.id);
    assert.equal(row.accessLevel, "write");
    assert.equal(row.isDefault, false);
  });

  test("never lists another company's employees or applies their rows", async () => {
    const company = await seedCompany();
    const other = await seedCompany("Other");
    await hire(company, "Ada");
    const outsider = await hire(other, "Outsider");
    await setRoutineAccess(other.id, outsider.id, "run");
    const rows = await listRoutineAccess(company.id);
    assert.deepEqual(
      rows.map((row) => [row.employee.name, row.accessLevel]),
      [["Ada", "write"]],
    );
    assert.deepEqual(
      (await listRoutineAccess(other.id)).map((row) => [row.employee.name, row.accessLevel]),
      [["Outsider", "run"]],
    );
  });

  test("a stored row is matched by employee, even if its companyId went stale", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await AppDataSource.getRepository(EmployeeRoutineGrant).save(
      AppDataSource.getRepository(EmployeeRoutineGrant).create({
        companyId: "some-other-company",
        employeeId: ada.id,
        accessLevel: "run",
      }),
    );
    // The gate keys by employee alone; the list must agree with it.
    assert.equal(await getRoutineAccess(ada.id), "run");
    assert.equal((await listRoutineAccess(company.id))[0].accessLevel, "run");
  });

  test("an unrecognized stored level is listed as read + run", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await storeRawLevel(company, ada, "superuser");
    const [row] = await listRoutineAccess(company.id);
    assert.equal(row.accessLevel, "run");
    assert.equal(row.isDefault, false);
  });

  test("a company without AI Employees lists nothing", async () => {
    const company = await seedCompany();
    assert.deepEqual(await listRoutineAccess(company.id), []);
  });
});

describe("getRoutineAccessRow", () => {
  test("returns one employee's row in the list's shape", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    await hire(company, "Bob");
    await setRoutineAccess(company.id, ada.id, "run");
    const [listed] = await listRoutineAccess(company.id);
    assert.deepEqual(await getRoutineAccessRow(company.id, ada.id), listed);
  });

  test("is null for another company's employee and for an unknown id", async () => {
    const company = await seedCompany();
    const outsider = await hire(await seedCompany("Other"), "Outsider");
    assert.equal(await getRoutineAccessRow(company.id, outsider.id), null);
    assert.equal(
      await getRoutineAccessRow(company.id, "00000000-0000-4000-8000-000000000000"),
      null,
    );
  });
});

describe("deleteRoutineAccessForEmployee", () => {
  test("drops exactly that employee's row", async () => {
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    const bob = await hire(company, "Bob");
    await setRoutineAccess(company.id, ada.id, "run");
    await setRoutineAccess(company.id, bob.id, "run");
    await deleteRoutineAccessForEmployee(ada.id);
    assert.deepEqual(
      (await storedRows()).map((row) => row.employeeId),
      [bob.id],
    );
    // Deleting a row that is not there is harmless.
    await deleteRoutineAccessForEmployee(ada.id);
    assert.equal((await storedRows()).length, 1);
  });
});

describe("Run recovery treats the row like every other Employee…Grant", () => {
  test("the row is part of the Grant snapshot a retry or continuation must still cover", async () => {
    // `workRecoveryScope` refuses to recover a Run whose original Grants were
    // replaced or changed. A level change between attempts therefore stops
    // that one chain's recovery, exactly as a Finance level change does; a
    // fresh scheduled Run is unaffected (see routineAccessRun.test.ts).
    const company = await seedCompany();
    const ada = await hire(company, "Ada");
    assert.deepEqual(
      (await captureRecoveryGrants(company.id, ada.id)).filter((entry) =>
        entry.startsWith("EmployeeRoutineGrant:"),
      ),
      [],
      "no row, nothing captured",
    );
    await setRoutineAccess(company.id, ada.id, "run");
    const narrowed = (await captureRecoveryGrants(company.id, ada.id)).filter((entry) =>
      entry.startsWith("EmployeeRoutineGrant:"),
    );
    assert.equal(narrowed.length, 1);
    await setRoutineAccess(company.id, ada.id, "write");
    const restored = (await captureRecoveryGrants(company.id, ada.id)).filter((entry) =>
      entry.startsWith("EmployeeRoutineGrant:"),
    );
    assert.equal(restored.length, 1);
    assert.notEqual(restored[0], narrowed[0], "a level change is a changed Grant");
  });
});
