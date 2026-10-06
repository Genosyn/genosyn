import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { loadRunFollowUps, publicRun } from "./runContinuationView.js";

let company: Company;
let routine: Routine;
before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Follow-ups", slug: "follow-ups", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review",
    slug: "review",
    cronExpr: "0 9 * * *",
  });
});

async function seedRun(patch: Partial<Run> = {}) {
  return insert(Run, {
    routineId: routine.id,
    status: "failed",
    startedAt: new Date("2026-09-28T08:00:00Z"),
    finishedAt: new Date("2026-09-28T08:05:00Z"),
    ...patch,
  });
}

test("a Run without a related child has an explicit absent follow-up", async () => {
  const source = await seedRun();
  await seedRun({ status: "running", finishedAt: null });
  const views = await loadRunFollowUps(company.id, [source]);
  assert.equal(views.get(source.id), null);
  assert.equal(publicRun(source, views.get(source.id)).followUpRun, null);
  assert.equal((await loadRunFollowUps(company.id, [])).size, 0);
});

for (const status of [
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "reviewed",
  "skipped",
] as const) {
  test(`a ${status} continuation is linked without rewriting its parent's result`, async () => {
    const source = await seedRun({
      outcomeVerdict: "off_goal",
      checksVerdict: "failed",
      failureReason: "Original blocker",
    });
    const child = await seedRun({
      parentRunId: source.id,
      triggerKind: "continuation",
      continuationCount: 1,
      status,
    });
    const views = await loadRunFollowUps(company.id, [source, child]);
    const visible = publicRun(source, views.get(source.id));
    assert.equal(visible.followUpRun?.id, child.id);
    assert.equal(visible.followUpRun?.status, status);
    assert.equal(visible.followUpRun?.isLatest, true);
    assert.equal(visible.status, "failed");
    assert.equal(visible.failureReason, "Original blocker");
    assert.equal(visible.checksVerdict, "failed");
    assert.equal(visible.outcomeVerdict, "off_goal");
    assert.equal(views.get(child.id), null);
  });
}

test("a deep continuation chain links every ancestor to the current leaf and leaves its own retry separate", async () => {
  const source = await seedRun();
  const child = await seedRun({ parentRunId: source.id, triggerKind: "continuation" });
  const leaf = await seedRun({
    parentRunId: child.id,
    triggerKind: "continuation",
    status: "failed",
    retryAt: new Date(),
  });
  const views = await loadRunFollowUps(company.id, [source, child, leaf]);
  for (const ancestor of [source, child]) {
    assert.equal(views.get(ancestor.id)?.id, leaf.id);
    assert.equal(views.get(ancestor.id)?.retryPending, true);
    assert.equal(publicRun(ancestor, views.get(ancestor.id)).continuationPending, false);
    assert.equal(publicRun(ancestor, views.get(ancestor.id)).retryAt, null);
  }
  assert.equal(views.get(leaf.id), null);
});

test("ordinary retry children retain their trigger and pending work without claiming a saved continuation", async () => {
  const source = await seedRun({ status: "error", errorKind: "runtime" });
  const child = await seedRun({
    parentRunId: source.id,
    triggerKind: "retry",
    retryAt: new Date(),
  });
  const related = (await loadRunFollowUps(company.id, [source])).get(source.id)!;
  assert.equal(related.id, child.id);
  assert.equal(related.triggerKind, "retry");
  assert.equal(related.retryPending, true);
});

test("finished follow-ups stay live only while their configured outcome assessment is owed", async () => {
  const source = await seedRun();
  const child = await seedRun({
    parentRunId: source.id,
    status: "completed",
    outcomeVerdict: null,
  });
  assert.equal(
    (await loadRunFollowUps(company.id, [source])).get(source.id)?.awaitingOutcome,
    false,
  );
  await AppDataSource.getRepository(Routine).update(routine.id, {
    acceptanceCriteria: "Deliver the report",
  });
  assert.equal(
    (await loadRunFollowUps(company.id, [source])).get(source.id)?.awaitingOutcome,
    true,
  );
  await AppDataSource.getRepository(Run).update(child.id, { outcomeVerdict: "unverified" });
  assert.equal(
    (await loadRunFollowUps(company.id, [source])).get(source.id)?.awaitingOutcome,
    false,
  );
});

test("every relationship stays in the source Routine and its current company", async () => {
  const source = await seedRun();
  const child = await seedRun({ parentRunId: source.id });
  const otherRoutine = await insert(Routine, {
    employeeId: routine.employeeId,
    name: "Other",
    slug: "other",
    cronExpr: "0 9 * * *",
  });
  const unrelated = await seedRun({
    routineId: otherRoutine.id,
    parentRunId: source.id,
    status: "running",
  });
  const foreignCompany = await insert(Company, {
    name: "Foreign",
    slug: "foreign",
    ownerId: "owner",
  });
  const foreignEmployee = await insert(AIEmployee, {
    companyId: foreignCompany.id,
    name: "Foreign",
    slug: "foreign",
    role: "Support",
  });
  const foreignRoutine = await insert(Routine, {
    employeeId: foreignEmployee.id,
    name: "Foreign",
    slug: "foreign",
    cronExpr: "0 9 * * *",
  });
  const foreign = await seedRun({
    routineId: foreignRoutine.id,
    parentRunId: child.id,
    status: "running",
  });
  const result = (await loadRunFollowUps(company.id, [source, child])).get(source.id);
  assert.equal(result?.id, child.id);
  assert.equal(result?.isLatest, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${foreign.id}|${unrelated.id}`));
  assert.equal((await loadRunFollowUps(foreignCompany.id, [source])).get(source.id), null);
  await AppDataSource.getRepository(Routine).update(routine.id, { employeeId: foreignEmployee.id });
  assert.equal((await loadRunFollowUps(company.id, [source])).get(source.id), null);
});

test("only safe metadata leaves the descendant query", async () => {
  const source = await seedRun();
  const child = await seedRun({
    parentRunId: source.id,
    checkpointJson: "private checkpoint",
    logContent: "private transcript",
    queueOptionsJson: "private approval",
    diagnosticsJson: "private failure",
    failureReason: "private reason",
  });
  const related = (await loadRunFollowUps(company.id, [source])).get(source.id)!;
  assert.equal(related.id, child.id);
  assert.deepEqual(
    Object.keys(related).sort(),
    [
      "id",
      "routineId",
      "status",
      "errorKind",
      "createdAt",
      "startedAt",
      "finishedAt",
      "exitCode",
      "triggerKind",
      "continuationCount",
      "retryPending",
      "awaitingOutcome",
      "isLatest",
    ].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(related),
    /private|checkpoint|queueOptions|diagnostics|failureReason/,
  );
});

test("cycles and ambiguous branches are bounded and never presented as a latest completed result", async () => {
  const source = await seedRun();
  const child = await seedRun({ parentRunId: source.id, status: "completed" });
  await AppDataSource.getRepository(Run).update(source.id, { parentRunId: child.id });
  const cyclic = (await loadRunFollowUps(company.id, [source])).get(source.id)!;
  assert.equal(cyclic.id, child.id);
  assert.equal(cyclic.isLatest, false);
  await AppDataSource.getRepository(Run).update(source.id, { parentRunId: null });
  await seedRun({ parentRunId: source.id, status: "running", createdAt: new Date("2020-01-01") });
  const ambiguous = (await loadRunFollowUps(company.id, [source])).get(source.id)!;
  assert.equal(ambiguous.id, child.id);
  assert.equal(ambiguous.isLatest, false);
});

test("very long chains expose a bounded related Run without claiming it is the latest", async () => {
  const source = await seedRun();
  let parent = source;
  const chain: Run[] = [];
  for (let n = 0; n < 23; n++) {
    parent = await seedRun({ parentRunId: parent.id, status: "completed" });
    chain.push(parent);
  }
  const related = (await loadRunFollowUps(company.id, [source])).get(source.id)!;
  assert.equal(related.id, chain[19].id);
  assert.equal(related.isLatest, false);
  const next = (await loadRunFollowUps(company.id, [chain[19]])).get(chain[19].id)!;
  assert.equal(next.id, chain[22].id);
  assert.equal(next.isLatest, true);
});

test("newly enqueued Run responses omit private dispatch authority", () => {
  const run = Object.assign(new Run(), {
    id: "queued-run",
    status: "queued",
    createdAt: new Date("2026-09-24T12:00:00Z"),
    queueActiveEmployeeId: "private-slot",
    queueOptionsJson: JSON.stringify({ proactiveApprovalId: "private-approval" }),
    checkpointJson: null,
  });
  const visible = publicRun(run);
  assert.equal(visible.status, "queued");
  assert.equal(visible.queuedAt, run.createdAt);
  assert.equal("queueOptionsJson" in visible, false);
  assert.equal("queueActiveEmployeeId" in visible, false);
  assert.doesNotMatch(JSON.stringify(visible), /private-slot|private-approval/);
});
