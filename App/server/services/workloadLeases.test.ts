import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Company } from "../db/entities/Company.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  acquireChatWorkloadLease,
  EMPLOYEE_WIDE_SCOPE,
  EmployeeWorkloadBusyError,
  releaseChatWorkloadLease,
} from "./workloadLeases.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const THREAD_A = "conversation:thread_a";
const THREAD_B = "conversation:thread_b";

async function company(): Promise<Company> {
  return insert(Company, {
    name: "Parallel Co",
    slug: "parallel-co",
    ownerId: "owner_1",
  });
}

describe("chat workload leases", () => {
  test("serializes concurrent replies inside one thread", async () => {
    const co = await company();

    const attempts = await Promise.allSettled([
      acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000),
      acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof EmployeeWorkloadBusyError);
  });

  test("lets one employee reply in several conversations at once", async () => {
    // The whole point of scoping the lease: a Member holding three threads
    // with the same AI Employee gets three replies in parallel, not a queue.
    const co = await company();
    const threads = Array.from({ length: 5 }, (_, index) => `conversation:thread_${index}`);

    const leases = await Promise.all(
      threads.map((scopeKey) => acquireChatWorkloadLease(co.id, "employee_1", scopeKey, 60_000)),
    );

    assert.deepEqual(
      leases.map((lease) => lease.scopeKey),
      threads,
    );
  });

  test("serializes one thread without blocking other threads or employees", async () => {
    const co = await company();
    const first = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000);

    await assert.rejects(
      () => acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000),
      EmployeeWorkloadBusyError,
    );
    const otherThread = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_B, 60_000);
    assert.equal(otherThread.scopeKey, THREAD_B);
    const otherEmployee = await acquireChatWorkloadLease(co.id, "employee_2", THREAD_A, 60_000);
    assert.equal(otherEmployee.employeeId, "employee_2");

    await releaseChatWorkloadLease(first);
    const next = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000);
    assert.equal(next.employeeId, "employee_1");
  });

  test("shares one employee-wide lease across unthreaded surfaces", async () => {
    // A Base or meeting kickoff has no transcript of its own. Those keep the
    // single employee-wide lease they had before threads were scoped, and it
    // does not reach into anyone's conversation.
    const co = await company();
    const first = await acquireChatWorkloadLease(co.id, "employee_1", EMPLOYEE_WIDE_SCOPE, 60_000);
    assert.equal(first.scopeKey, EMPLOYEE_WIDE_SCOPE);

    await assert.rejects(
      () => acquireChatWorkloadLease(co.id, "employee_1", EMPLOYEE_WIDE_SCOPE, 60_000),
      EmployeeWorkloadBusyError,
    );
    const threaded = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000);
    assert.equal(threaded.scopeKey, THREAD_A);
  });

  test("a lease from a pre-scoping build still blocks every thread", async () => {
    // The rolling-upgrade case. A build that predates scoping writes NULL and
    // filters on the employee alone, so it blocks on our rows; we have to
    // block on its rows too, or the two halves of a rollout would answer the
    // same conversation twice.
    const co = await company();
    await insert(WorkloadLease, {
      companyId: co.id,
      employeeId: "employee_1",
      kind: "chat",
      scopeKey: null,
      ownerKey: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await assert.rejects(
      () => acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000),
      EmployeeWorkloadBusyError,
    );
    // Another employee is still untouched by it.
    const other = await acquireChatWorkloadLease(co.id, "employee_2", THREAD_A, 60_000);
    assert.equal(other.employeeId, "employee_2");
  });

  test("does not impose a company-wide concurrency ceiling", async () => {
    const co = await company();
    const employees = Array.from({ length: 12 }, (_, index) => `employee_${index}`);
    const leases = await Promise.all(
      employees.map((employeeId) => acquireChatWorkloadLease(co.id, employeeId, THREAD_A, 60_000)),
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
      scopeKey: THREAD_A,
      ownerKey: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const chat = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000);

    assert.equal(chat.kind, "chat");
  });

  test("replaces the abandoned reply lease for the same durable turn", async () => {
    const co = await company();
    const first = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000, {
      ownerKey: "turn-1",
    });
    const recovered = await acquireChatWorkloadLease(co.id, "employee_1", THREAD_A, 60_000, {
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
