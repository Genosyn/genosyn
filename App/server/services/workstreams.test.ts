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
  listEmployeeWorkstreams,
  listWorkstreams,
  readEmployeeWorkstream,
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

describe("bounded employee Workstream reads", () => {
  test("lists compact pages with deterministic ordering and exact coverage", async () => {
    const updatedAt = new Date("2026-09-20T10:00:00Z");
    const repo = AppDataSource.getRepository(Workstream);
    const rows = await repo.save(
      Array.from({ length: 7 }, (_, index) =>
        repo.create({
          companyId,
          employeeId: employee.id,
          title: `State ${index}`,
          stateDoc: "x".repeat(40_000),
          objective: "o".repeat(4_000),
          closeReason: "r".repeat(2_000),
          updatedAt,
        }),
      ),
    );
    const first = await listEmployeeWorkstreams({ companyId, employeeId: employee.id });
    assert.equal(first.workstreams.length, 5);
    assert.equal(first.coverage.total, 7);
    assert.equal(first.coverage.nextOffset, 5);
    assert.equal(first.coverage.hasMore, true);
    for (const row of first.workstreams) {
      assert.equal(row.stateDoc.length, 240);
      assert.equal(row.objective.length, 160);
      assert.equal(row.closeReason.length, 160);
      assert.deepEqual(row.textCoverage.stateDoc, {
        offset: 0,
        returnedChars: 240,
        totalChars: 40_000,
        truncated: true,
        nextOffset: 240,
      });
    }
    assert.ok(JSON.stringify(first).length < 8_000);
    const second = await listEmployeeWorkstreams({ companyId, employeeId: employee.id, offset: 5 });
    assert.equal(second.coverage.hasMore, false);
    assert.equal(second.coverage.nextOffset, null);
    assert.deepEqual(
      [...first.workstreams, ...second.workstreams].map((row) => row.id),
      rows
        .map((row) => row.id)
        .sort()
        .reverse(),
    );
    const empty = await listEmployeeWorkstreams({ companyId, employeeId: employee.id, offset: 20 });
    assert.equal(empty.coverage.total, 7);
    assert.equal(empty.workstreams.length, 0);
    assert.equal(empty.coverage.nextOffset, null);
  });

  test("a known ID reads a complete state in bounded pages, including finished work", async () => {
    const stateDoc = "begin\n" + "x".repeat(12_000) + "\nrecover this final evidence";
    const row = await insert(Workstream, {
      companyId,
      employeeId: employee.id,
      title: "Finished evidence",
      stateDoc,
      status: "done",
      objective: "Long objective ".repeat(100),
      closeReason: "Done.",
    });
    assert.equal(
      (await listEmployeeWorkstreams({ companyId, employeeId: employee.id })).coverage.total,
      0,
    );
    assert.equal(
      (await listEmployeeWorkstreams({ companyId, employeeId: employee.id, all: true })).coverage
        .total,
      1,
    );
    let offset: number | null = 0;
    let recovered = "";
    do {
      const page = await readEmployeeWorkstream({
        companyId,
        employeeId: employee.id,
        workstreamId: row.id,
        offset,
        maxChars: 2_000,
      });
      assert.ok(page.text.length <= 2_000);
      assert.equal(page.coverage.totalChars, stateDoc.length);
      assert.equal(page.workstream.status, "done");
      recovered += page.text;
      offset = page.coverage.nextOffset;
    } while (offset !== null);
    assert.equal(recovered, stateDoc);
    const objective = await readEmployeeWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: row.id,
      field: "objective",
    });
    assert.equal(objective.text, row.objective);
    assert.equal(objective.coverage.truncated, false);
    const exhausted = await readEmployeeWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: row.id,
      offset: 40_000,
    });
    assert.equal(exhausted.text, "");
    assert.equal(exhausted.coverage.nextOffset, null);
  });

  test("direct reads and compact pages keep current ownership and review boundaries", async () => {
    const row = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Review tracking",
      routineId: routine.id,
      stateDoc: "Private review evidence",
    });
    for (const scope of [
      { companyId: testId("elsewhere"), employeeId: employee.id },
      { companyId, employeeId: testId("stranger") },
    ]) {
      assert.equal((await listEmployeeWorkstreams(scope)).coverage.total, 0);
      await assert.rejects(readEmployeeWorkstream({ ...scope, workstreamId: row.id }), /not found/);
    }
    const scope = { companyId, employeeId: employee.id, excludeSelfReviews: true };
    assert.equal(
      (await readEmployeeWorkstream({ ...scope, workstreamId: row.id })).text,
      row.stateDoc,
    );
    await AppDataSource.getRepository(Routine).update(routine.id, { selfReviewOnly: true });
    assert.equal((await listEmployeeWorkstreams(scope)).coverage.total, 0);
    await assert.rejects(readEmployeeWorkstream({ ...scope, workstreamId: row.id }), /not found/);
    assert.equal(
      (await readEmployeeWorkstream({ ...scope, excludeSelfReviews: false, workstreamId: row.id }))
        .text,
      row.stateDoc,
    );
    await AppDataSource.getRepository(Routine).delete(routine.id);
    await assert.rejects(readEmployeeWorkstream({ ...scope, workstreamId: row.id }), /not found/);
  });

  test("rejects invalid ranges and malformed IDs at the service boundary", async () => {
    const scope = { companyId, employeeId: employee.id };
    const row = await createWorkstream({ ...scope, title: "State" });
    for (const value of [-1, 0.5, Number.NaN, 1_000_001]) {
      await assert.rejects(listEmployeeWorkstreams({ ...scope, offset: value }), WorkstreamError);
    }
    for (const value of [0, -1, 21, 1.5]) {
      await assert.rejects(listEmployeeWorkstreams({ ...scope, limit: value }), WorkstreamError);
    }
    for (const value of [0, 8_001, 1.5]) {
      await assert.rejects(
        readEmployeeWorkstream({ ...scope, workstreamId: row.id, maxChars: value }),
        WorkstreamError,
      );
    }
    await assert.rejects(
      readEmployeeWorkstream({ ...scope, workstreamId: "not-an-id" }),
      WorkstreamError,
    );
    await assert.rejects(
      readEmployeeWorkstream({ ...scope, workstreamId: testId("missing") }),
      WorkstreamError,
    );
  });
});

describe("active capacity and archive recovery", () => {
  test("archiving preserves state, exposes capacity, and resuming requires an available slot", async () => {
    const workstreams = [];
    for (let index = 0; index < 20; index++) {
      workstreams.push(
        await createWorkstream({
          companyId,
          employeeId: employee.id,
          title: `Work ${index}`,
          objective: "Keep the evidence",
          stateDoc: `Position ${index}`,
        }),
      );
    }
    const args = { companyId, employeeId: employee.id, workstreamId: workstreams[0].id };
    await assert.rejects(
      createWorkstream({ companyId, employeeId: employee.id, title: "Overflow" }),
      /Archive one/,
    );
    await assert.rejects(
      updateWorkstream({ ...args, status: "archived" }),
      /Archiving needs a reason/,
    );
    const archived = await updateWorkstream({
      ...args,
      status: "archived",
      closeReason: "Wait for next quarter",
    });
    assert.equal(archived.stateDoc, "Position 0");
    assert.equal(archived.objective, "Keep the evidence");
    const page = await listEmployeeWorkstreams({ companyId, employeeId: employee.id });
    assert.deepEqual(page.capacity, { active: 19, limit: 20, available: 1 });
    await createWorkstream({ companyId, employeeId: employee.id, title: "Current priority" });
    await assert.rejects(updateWorkstream({ ...args, status: "active" }), /Archive one/);
    await updateWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: workstreams[1].id,
      status: "archived",
      closeReason: "Waiting for input",
    });
    const resumed = await updateWorkstream({ ...args, status: "active" });
    assert.equal(resumed.stateDoc, "Position 0");
    assert.equal(resumed.closeReason, "");
  });

  test("concurrent creations cannot overfill the last active slot", async () => {
    for (let index = 0; index < 19; index++) {
      await createWorkstream({ companyId, employeeId: employee.id, title: `Existing ${index}` });
    }
    const outcomes = await Promise.allSettled(
      ["A", "B"].map((title) => createWorkstream({ companyId, employeeId: employee.id, title })),
    );
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      await AppDataSource.getRepository(Workstream).countBy({
        employeeId: employee.id,
        status: "active",
      }),
      20,
    );
  });

  test("resuming cannot create two active Workstreams on the same Routine", async () => {
    const first = await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Earlier",
      routineId: routine.id,
    });
    await updateWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: first.id,
      status: "archived",
      closeReason: "Wait",
    });
    await createWorkstream({
      companyId,
      employeeId: employee.id,
      title: "Current",
      routineId: routine.id,
    });
    await assert.rejects(
      updateWorkstream({
        companyId,
        employeeId: employee.id,
        workstreamId: first.id,
        status: "active",
      }),
      /already carries an active workstream/,
    );
    const unbound = await updateWorkstream({
      companyId,
      employeeId: employee.id,
      workstreamId: first.id,
      status: "active",
      routineId: null,
    });
    assert.equal(unbound.routineId, null);
  });
});
