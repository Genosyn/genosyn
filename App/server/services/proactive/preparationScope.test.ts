import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { Activity } from "../../db/entities/Activity.js";
import { Routine } from "../../db/entities/Routine.js";
import { Workstream } from "../../db/entities/Workstream.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { proactivePreparationError } from "./preparationScope.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const context = { companyId: randomUUID(), employeeId: randomUUID(), routineId: randomUUID() };

test("preparation tracking stays unbound or on its own source Routine", async () => {
  await insert(Routine, {
    id: context.routineId,
    employeeId: context.employeeId,
    name: "Review customer requests",
    slug: randomUUID(),
    cronExpr: "0 9 * * *",
    mailDeliveryMode: "draft",
  });
  for (const routineId of [undefined, context.routineId])
    assert.equal(
      await proactivePreparationError(context, "create_workstream", { routineId }),
      null,
    );
  assert.ok(
    await proactivePreparationError(context, "create_workstream", { routineId: randomUUID() }),
  );
  assert.ok(
    await proactivePreparationError({ ...context, routineId: null }, "create_workstream", {
      routineId: context.routineId,
    }),
  );
  for (const routineId of [null, context.routineId, randomUUID()]) {
    const row = await insert(Workstream, { ...context, routineId, title: "Customer request" });
    const error = await proactivePreparationError(context, "update_workstream", {
      workstreamId: row.id,
      stateDoc: "Source verified; reply prepared.",
    });
    assert.equal(Boolean(error), routineId !== null && routineId !== context.routineId);
  }
});

test("a transient event review cannot seed a later unrestricted Run of the same Routine", async () => {
  for (const fields of [
    { mailDeliveryMode: null, selfReviewOnly: false },
    { mailDeliveryMode: "draft" as const, selfReviewOnly: true },
  ]) {
    const routine = await insert(Routine, {
      employeeId: context.employeeId,
      name: "Existing standing work",
      slug: randomUUID(),
      cronExpr: "0 9 * * *",
      ...fields,
    });
    const source = { ...context, routineId: routine.id };
    assert.ok(
      await proactivePreparationError(source, "create_workstream", { routineId: routine.id }),
    );
    const existing = await insert(Workstream, {
      ...source,
      title: "Bound standing work",
    });
    assert.ok(
      await proactivePreparationError(source, "update_workstream", {
        workstreamId: existing.id,
        stateDoc: "Attempt to queue restricted work for a later Run.",
      }),
    );
    assert.equal(await proactivePreparationError(source, "create_workstream", {}), null);
  }
});

test("one-off internal follow-ups can be reconciled without starting another recurrence", async () => {
  const ordinary = await insert(Activity, {
    companyId: context.companyId,
    kind: "task",
    occurredAt: new Date(),
    assignedEmployeeId: context.employeeId,
    subject: "Record the actual customer response",
  });
  assert.equal(
    await proactivePreparationError(context, "update_follow_up", {
      followUpId: ordinary.id,
      status: "completed",
    }),
    null,
  );
  const unassigned = await insert(Activity, {
    companyId: context.companyId,
    kind: "task",
    occurredAt: new Date(),
  });
  assert.equal(
    await proactivePreparationError(context, "update_follow_up", {
      followUpId: unassigned.id,
      bodyText: "Latest source checked.",
    }),
    null,
  );
  for (const restricted of [
    { recurrenceRule: "FREQ=DAILY", dueAt: new Date() },
    { reminderAt: new Date() },
    { assignedUserId: randomUUID() },
    { assignedEmployeeId: randomUUID() },
  ]) {
    const row = await insert(Activity, {
      companyId: context.companyId,
      kind: "task",
      occurredAt: new Date(),
      ...restricted,
    });
    assert.ok(
      await proactivePreparationError(context, "update_follow_up", {
        followUpId: row.id,
        status: "completed",
      }),
      JSON.stringify(restricted),
    );
  }
});

test("scope checks defer malformed or invisible resource IDs to route validation and Grants", async () => {
  assert.equal(
    await proactivePreparationError(context, "update_workstream", { workstreamId: "malformed" }),
    null,
  );
  assert.equal(
    await proactivePreparationError(context, "update_follow_up", { followUpId: "malformed" }),
    null,
  );
  const other = await insert(Workstream, {
    companyId: randomUUID(),
    employeeId: randomUUID(),
    routineId: randomUUID(),
    title: "Private work",
  });
  assert.equal(
    await proactivePreparationError(context, "update_workstream", { workstreamId: other.id }),
    null,
  );
});
