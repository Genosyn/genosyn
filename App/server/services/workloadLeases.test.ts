import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  acquireWorkloadLease,
  EmployeeWorkloadBusyError,
  releaseWorkloadLease,
  WorkloadLimitError,
} from "./workloadLeases.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function company(): Promise<Company> {
  return insert(Company, {
    name: "Parallel Co",
    slug: "parallel-co",
    ownerId: "owner_1",
  });
}

describe("workload leases", () => {
  test("allows a chat and independent Routines to run for the same employee", async () => {
    const co = await company();

    const [firstRoutine, chat, secondRoutine] = await Promise.all([
      acquireWorkloadLease(co.id, "employee_1", "routine", 60_000),
      acquireWorkloadLease(co.id, "employee_1", "chat", 60_000),
      acquireWorkloadLease(co.id, "employee_1", "routine", 60_000),
    ]);

    assert.deepEqual(
      [firstRoutine.kind, chat.kind, secondRoutine.kind].sort(),
      ["chat", "routine", "routine"],
    );
    assert.equal(
      await AppDataSource.getRepository(WorkloadLease).countBy({ employeeId: "employee_1" }),
      3,
    );
  });

  test("serializes chat turns for one employee without blocking other employees", async () => {
    const co = await company();
    const first = await acquireWorkloadLease(co.id, "employee_1", "chat", 60_000);

    await assert.rejects(
      () => acquireWorkloadLease(co.id, "employee_1", "chat", 60_000),
      EmployeeWorkloadBusyError,
    );
    const otherEmployee = await acquireWorkloadLease(co.id, "employee_2", "chat", 60_000);
    assert.equal(otherEmployee.employeeId, "employee_2");

    await releaseWorkloadLease(first);
    const next = await acquireWorkloadLease(co.id, "employee_1", "chat", 60_000);
    assert.equal(next.employeeId, "employee_1");
  });

  test("keeps the company-wide capacity ceiling across chats and Runs", async () => {
    const co = await company();
    await Promise.all([
      acquireWorkloadLease(co.id, "employee_1", "routine", 60_000),
      acquireWorkloadLease(co.id, "employee_1", "chat", 60_000),
      acquireWorkloadLease(co.id, "employee_1", "routine", 60_000),
      acquireWorkloadLease(co.id, "employee_2", "chat", 60_000),
    ]);

    await assert.rejects(
      () => acquireWorkloadLease(co.id, "employee_3", "routine", 60_000),
      WorkloadLimitError,
    );
  });

  test("replaces the abandoned capacity lease for the same durable turn", async () => {
    const co = await company();
    const first = await acquireWorkloadLease(
      co.id,
      "employee_1",
      "chat",
      60_000,
      { ownerKey: "turn-1" },
    );
    const recovered = await acquireWorkloadLease(
      co.id,
      "employee_1",
      "chat",
      60_000,
      { ownerKey: "turn-1" },
    );

    assert.notEqual(recovered.id, first.id);
    assert.equal(recovered.ownerKey, "turn-1");
    assert.equal(
      await AppDataSource.getRepository(WorkloadLease).countBy({
        employeeId: "employee_1",
        kind: "chat",
      }),
      1,
    );
  });
});
