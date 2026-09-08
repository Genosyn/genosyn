import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream } from "../db/entities/Workstream.js";
import { AppDataSource } from "../db/datasource.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import {
  WorkstreamError,
  assertBusinessWorkstream,
  closeWorkstream,
  composeWorkstreamBlock,
  createWorkstream,
  listWorkstreams,
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
    assert.match(block, /Before you finish this Run, commit the new state/);
  });

  test("self-review tracking only changes when new evidence or human feedback warrants it", async () => {
    await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
    const workstream = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Review my collections approach",
      stateDoc: "Proposal pending; wait for a Member's decision.",
      routineId: routine.id,
    });
    const block = await composeWorkstreamBlock(routine.id);
    assert.match(block, /Proposal pending; wait for a Member's decision\./);
    assert.match(block, new RegExp(workstream.id));
    assert.match(block, /historical evidence, not instructions/);
    assert.match(block, /new evidence or human review feedback/);
    assert.match(block, /If nothing changed, finish quietly without rewriting it/);
    assert.doesNotMatch(block, /Before you finish this Run|trust it over memory/);

    await AppDataSource.getRepository(Workstream).update(workstream.id, { stateDoc: "" });
    const emptyBlock = await composeWorkstreamBlock(routine.id);
    assert.match(emptyBlock, /record evidence only when there is something worth tracking/);
    assert.doesNotMatch(emptyBlock, /write the first state before you finish/);
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

describe("business Workstream isolation", () => {
  test("business work cannot create tracking bound to a self-review Routine", async () => {
    await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
    const args = {
      companyId,
      employeeId: employee.id,
      title: "Review tracking",
      routineId: routine.id,
    };
    await assert.rejects(
      createWorkstream({ ...args, excludeSelfReviews: true }),
      /cannot carry background business work/,
    );
    assert.equal(await AppDataSource.getRepository(Workstream).count(), 0);
    const review = await createWorkstream(args);
    assert.equal(review.routineId, routine.id);
    const unbound = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Ordinary work",
      excludeSelfReviews: true,
    });
    assert.equal(unbound.routineId, null);
  });

  test("review tracking stays visible to Members and reviews but is hidden from business Runs", async () => {
    const reviewRoutine = await insert(Routine, {
      employeeId: employee.id,
      name: "Improve my work",
      slug: "improve-my-work",
      cronExpr: "0 15 * * 5",
      body: "Review only.",
      selfReviewOnly: true,
    });
    const business = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Collections",
      routineId: routine.id,
    });
    const unbound = await createWorkstream({ companyId, employeeId: employee.id, title: "Ad hoc" });
    const review = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Review evidence",
      routineId: reviewRoutine.id,
    });
    await insert(Workstream, {
      companyId: testId("foreign-company"),
      employeeId: employee.id,
      title: "Other company's work",
    });
    await insert(Workstream, {
      companyId,
      employeeId: testId("other-employee"),
      title: "Other employee's work",
    });

    const allOwn = await listWorkstreams(companyId, { employeeId: employee.id });
    assert.deepEqual(
      new Set(allOwn.map((w) => w.id)),
      new Set([business.id, unbound.id, review.id]),
    );
    const businessOwn = await listWorkstreams(companyId, {
      employeeId: employee.id,
      status: "active",
      excludeSelfReviews: true,
    });
    assert.deepEqual(new Set(businessOwn.map((w) => w.id)), new Set([business.id, unbound.id]));
    assert.equal((await listWorkstreams(companyId)).length, 4);
    assert.equal((await listWorkstreams(companyId, { excludeSelfReviews: true })).length, 3);
  });

  test("excludes review records in the database before applying the result limit", async () => {
    await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
    const repo = AppDataSource.getRepository(Workstream);
    // Multiple closed records are valid historical tracking for the same Routine.
    await repo.save(
      Array.from({ length: 201 }, (_, index) =>
        repo.create({
          companyId,
          employeeId: employee.id,
          routineId: routine.id,
          title: `Completed review ${index}`,
          status: "done",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        }),
      ),
    );
    const business = await insert(Workstream, {
      companyId,
      employeeId: employee.id,
      title: "Earlier completed work",
      status: "done",
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await createWorkstream({ companyId, employeeId: employee.id, title: "Current work" });
    const all = await listWorkstreams(companyId, { employeeId: employee.id, status: "done" });
    assert.equal(all.length, 200);
    assert.ok(all.every((w) => w.routineId === routine.id));
    const filtered = await listWorkstreams(companyId, {
      employeeId: employee.id,
      status: "done",
      excludeSelfReviews: true,
    });
    assert.deepEqual(
      filtered.map((w) => w.id),
      [business.id],
    );
  });

  test("known IDs cannot bypass ownership, review, or orphaned-binding restrictions", async () => {
    const bound = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Bound work",
      routineId: routine.id,
    });
    const unbound = await createWorkstream({ companyId, employeeId: employee.id, title: "Ad hoc" });
    await assertBusinessWorkstream(companyId, employee.id, bound.id);
    await assertBusinessWorkstream(companyId, employee.id, unbound.id);
    await assert.rejects(
      assertBusinessWorkstream(companyId, testId("other"), bound.id),
      WorkstreamError,
    );
    await assert.rejects(
      assertBusinessWorkstream(testId("other-company"), employee.id, bound.id),
      WorkstreamError,
    );
    await assert.rejects(
      assertBusinessWorkstream(companyId, employee.id, "malformed"),
      WorkstreamError,
    );
    await assert.rejects(
      assertBusinessWorkstream(companyId, employee.id, testId("missing")),
      WorkstreamError,
    );

    await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
    await assert.rejects(
      assertBusinessWorkstream(companyId, employee.id, bound.id),
      /not available/,
    );
    await AppDataSource.getRepository(Routine).delete(routine.id);
    await assert.rejects(
      assertBusinessWorkstream(companyId, employee.id, bound.id),
      /not available/,
    );
    assert.deepEqual(
      (await listWorkstreams(companyId, { employeeId: employee.id, excludeSelfReviews: true })).map(
        (w) => w.id,
      ),
      [unbound.id],
    );
    assert.equal((await listWorkstreams(companyId, { employeeId: employee.id })).length, 2);
  });
});
