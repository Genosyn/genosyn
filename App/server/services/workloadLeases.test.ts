import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  acquireChatWorkloadLease,
  EmployeeWorkloadBusyError,
  releaseChatWorkloadLease,
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

describe("chat workload leases", () => {
  test("serializes concurrent chat replies for one employee", async () => {
    const co = await company();

    const attempts = await Promise.allSettled([
      acquireChatWorkloadLease(co.id, "employee_1", 60_000),
      acquireChatWorkloadLease(co.id, "employee_1", 60_000),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof EmployeeWorkloadBusyError);
  });

  test("serializes chat turns for one employee without blocking other employees", async () => {
    const co = await company();
    const first = await acquireChatWorkloadLease(co.id, "employee_1", 60_000);

    await assert.rejects(
      () => acquireChatWorkloadLease(co.id, "employee_1", 60_000),
      EmployeeWorkloadBusyError,
    );
    const otherEmployee = await acquireChatWorkloadLease(co.id, "employee_2", 60_000);
    assert.equal(otherEmployee.employeeId, "employee_2");

    await releaseChatWorkloadLease(first);
    const next = await acquireChatWorkloadLease(co.id, "employee_1", 60_000);
    assert.equal(next.employeeId, "employee_1");
  });

  test("does not impose a company-wide concurrency ceiling", async () => {
    const co = await company();
    const employees = Array.from({ length: 12 }, (_, index) => `employee_${index}`);
    const leases = await Promise.all(
      employees.map((employeeId) => acquireChatWorkloadLease(co.id, employeeId, 60_000)),
    );

    assert.equal(leases.length, employees.length);
    assert.equal(
      await AppDataSource.getRepository(WorkloadLease).countBy({ companyId: co.id }),
      12,
    );
  });

  test("ignores a legacy Routine lease while acquiring a chat reply lease", async () => {
    const co = await company();
    await insert(WorkloadLease, {
      companyId: co.id,
      employeeId: "employee_1",
      kind: "routine",
      ownerKey: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const chat = await acquireChatWorkloadLease(co.id, "employee_1", 60_000);

    assert.equal(chat.kind, "chat");
  });

  test("replaces the abandoned reply lease for the same durable turn", async () => {
    const co = await company();
    const first = await acquireChatWorkloadLease(co.id, "employee_1", 60_000, {
      ownerKey: "turn-1",
    });
    const recovered = await acquireChatWorkloadLease(co.id, "employee_1", 60_000, {
      ownerKey: "turn-1",
    });

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
