import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream } from "../db/entities/Workstream.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  WorkstreamError,
  closeWorkstream,
  composeWorkstreamBlock,
  createWorkstream,
  updateWorkstream,
} from "./workstreams.js";

/**
 * Workstream guarantees: only the owner writes, one active workstream per
 * bound Routine (the brief seam stays unambiguous), terminal states say why,
 * and the brief block carries exactly the committed state.
 */

let companyId: string;
let employee: AIEmployee;
let routine: Routine;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Collections",
    slug: "collections",
    cronExpr: "0 9 * * *",
    body: "",
  });
});

describe("createWorkstream", () => {
  test("binds only the employee's own routine, and only one active stream per routine", async () => {
    const stranger = await insert(AIEmployee, {
      companyId,
      name: "Eve",
      slug: "eve",
      role: "Writer",
      soulBody: "",
    });
    const foreignRoutine = await insert(Routine, {
      employeeId: stranger.id,
      name: "Theirs",
      slug: "theirs",
      cronExpr: "0 9 * * *",
      body: "",
    });
    await assert.rejects(
      createWorkstream({
        companyId,
        employeeId: employee.id,
        title: "X",
        routineId: foreignRoutine.id,
      }),
      /not yours to bind/,
    );
    await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Overdue invoices",
      routineId: routine.id,
    });
    await assert.rejects(
      createWorkstream({
        companyId,
        employeeId: employee.id,
        title: "Second",
        routineId: routine.id,
      }),
      /already carries an active workstream/,
    );
  });
});

describe("updateWorkstream", () => {
  test("only the owner writes; abandoning needs a reason; closed streams refuse silent edits", async () => {
    const workstream = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Overdue invoices",
      stateDoc: "0 of 40 collected",
    });
    await assert.rejects(
      updateWorkstream({
        companyId,
        employeeId: testId("other-emp"),
        workstreamId: workstream.id,
        stateDoc: "hijacked",
      }),
      WorkstreamError,
    );
    await assert.rejects(
      updateWorkstream({
        companyId,
        employeeId: employee.id,
        workstreamId: workstream.id,
        status: "abandoned",
      }),
      /needs a reason/,
    );
    await updateWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: workstream.id,
      status: "done",
      closeReason: "All 40 collected.",
    });
    await assert.rejects(
      updateWorkstream({
        companyId,
        employeeId: employee.id,
        workstreamId: workstream.id,
        stateDoc: "more",
      }),
      /reopen it explicitly/,
    );
  });

  test("the last advancing Run is recorded", async () => {
    const workstream = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Overdue invoices",
    });
    const runId = testId("run");
    const updated = await updateWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: workstream.id,
      stateDoc: "12 of 40 collected",
      lastRunId: runId,
    });
    assert.equal(updated.lastRunId, runId);
  });
});

describe("composeWorkstreamBlock", () => {
  test("the bound routine's brief opens with exactly the committed state", async () => {
    assert.equal(await composeWorkstreamBlock(routine.id), "");
    const workstream = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Overdue invoices",
      objective: "Collect all 40.",
      stateDoc: "12 of 40 collected; Acme promised Friday.",
      routineId: routine.id,
    });
    const block = await composeWorkstreamBlock(routine.id);
    assert.match(block, /## Workstream: Overdue invoices/);
    assert.match(block, /12 of 40 collected; Acme promised Friday\./);
    assert.match(block, new RegExp(workstream.id));
    assert.match(block, /update_workstream/);
  });

  test("a closed workstream leaves the brief clean", async () => {
    await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Overdue invoices",
      routineId: routine.id,
    });
    const [workstream] = await AppDataSource.getRepository(Workstream).findBy({
      routineId: routine.id,
    });
    await closeWorkstream({
      companyId,
      workstreamId: workstream.id,
      status: "done",
      reason: "Collected.",
      userId: testId("owner"),
    });
    assert.equal(await composeWorkstreamBlock(routine.id), "");
  });
});
