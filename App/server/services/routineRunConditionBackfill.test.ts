import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream } from "../db/entities/Workstream.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { proactiveId } from "./proactive/ids.js";
import {
  RUN_CONDITION_BACKFILL_KEY,
  backfillRunConditions,
} from "./routineRunConditionBackfill.js";

/**
 * Upgrading an install whose Follow through on open work starters predate run
 * conditions: each real starter moves to `workstream_due` once, the work it
 * carries is planned for one more look so nothing in flight goes quiet, and
 * nothing a Member chose afterwards — or anything that merely looks like a
 * starter — is touched.
 */

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const upgradeAt = new Date("2026-11-16T12:00:00.000Z");
const longAgo = new Date("2026-10-01T08:00:00.000Z");

async function employeeIn(company: Company, slug: string): Promise<AIEmployee> {
  return insert(AIEmployee, { companyId: company.id, name: slug, slug, role: "Operations" });
}

/** A starter exactly as `installProactiveStarter` wrote one before conditions. */
async function starterFor(employee: AIEmployee, values: Partial<Routine> = {}): Promise<Routine> {
  const id = proactiveId(employee.companyId, employee.id, "work-followthrough", null);
  return insert(Routine, {
    id,
    employeeId: employee.id,
    name: "Follow through on open work",
    slug: `proactive-work-followthrough-${id.slice(0, 8)}`,
    cronExpr: "*/30 * * * *",
    body: "Review only your own open Workstreams whose next check is due.",
    mailDeliveryMode: "draft",
    ...values,
  });
}

function work(employee: AIEmployee, values: Partial<Workstream> = {}): Promise<Workstream> {
  return insert(Workstream, {
    companyId: employee.companyId,
    employeeId: employee.id,
    title: "In flight",
    status: "active",
    ...values,
  });
}

async function backdate(workstream: Workstream): Promise<void> {
  await AppDataSource.query(`UPDATE "workstreams" SET "updatedAt" = ? WHERE "id" = ?`, [
    longAgo.toISOString().replace("T", " ").replace("Z", ""),
    workstream.id,
  ]);
}

const routine = (id: string) => AppDataSource.getRepository(Routine).findOneByOrFail({ id });
const workstream = (id: string) => AppDataSource.getRepository(Workstream).findOneByOrFail({ id });

test("a real starter moves to its condition, and the work it resumes gets one more look", async () => {
  const company = await insert(Company, { name: "Upgrade", slug: "upgrade", ownerId: "owner" });
  const employee = await employeeIn(company, "maya");
  const starter = await starterFor(employee);
  const report = await insert(Routine, {
    employeeId: employee.id,
    name: "Weekly report",
    slug: "weekly-report",
    cronExpr: "0 9 * * 1",
  });
  const unbound = await work(employee, { title: "Unbound" });
  const boundToStarter = await work(employee, { title: "Its own", routineId: starter.id });
  const boundElsewhere = await work(employee, { title: "Report's", routineId: report.id });
  const planned = new Date("2026-11-20T09:00:00.000Z");
  const alreadyPlanned = await work(employee, { title: "Planned", revisitAt: planned });
  const archived = await work(employee, { title: "Archived", status: "archived" });
  await backdate(unbound);

  const colleague = await employeeIn(company, "bo");
  const theirs = await work(colleague, { title: "Colleague's" });

  assert.deepEqual(await backfillRunConditions(upgradeAt), { routines: 1, workstreams: 2 });

  assert.equal((await routine(starter.id)).runCondition, "workstream_due");
  assert.equal((await routine(report.id)).runCondition, "always");
  assert.deepEqual((await workstream(unbound.id)).revisitAt, upgradeAt);
  assert.deepEqual((await workstream(boundToStarter.id)).revisitAt, upgradeAt);
  assert.equal((await workstream(boundElsewhere.id)).revisitAt, null, "its Routine resumes it");
  assert.deepEqual((await workstream(alreadyPlanned.id)).revisitAt, planned, "a plan is kept");
  assert.equal((await workstream(archived.id)).revisitAt, null, "stopped work waits on nothing");
  assert.equal((await workstream(theirs.id)).revisitAt, null, "only the starter's own employee");
  assert.deepEqual(
    (await workstream(unbound.id)).updatedAt,
    longAgo,
    "planning a look is not the employee changing its work",
  );
  const marker = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
    key: RUN_CONDITION_BACKFILL_KEY,
  });
  assert.deepEqual(JSON.parse(marker.value), {
    at: upgradeAt.toISOString(),
    routines: 1,
    workstreams: 2,
  });
});

test("a starter a Member edited keeps its edits and still gains the condition", async () => {
  const company = await insert(Company, { name: "Edited", slug: "edited", ownerId: "owner" });
  const employee = await employeeIn(company, "maya");
  const starter = await starterFor(employee, {
    cronExpr: "0 * * * *",
    body: "Our own wording.",
    enabled: false,
    requiresApproval: true,
  });
  await backfillRunConditions(upgradeAt);
  const saved = await routine(starter.id);
  assert.equal(saved.runCondition, "workstream_due");
  assert.equal(saved.cronExpr, "0 * * * *");
  assert.equal(saved.body, "Our own wording.");
  assert.equal(saved.enabled, false);
  assert.equal(saved.requiresApproval, true);
});

test("something that only looks like a starter is left alone", async () => {
  const company = await insert(Company, { name: "Lookalike", slug: "lookalike", ownerId: "owner" });
  const employee = await employeeIn(company, "maya");
  const id = randomUUID();
  const lookalike = await insert(Routine, {
    id,
    employeeId: employee.id,
    name: "Follow through on open work",
    slug: `proactive-work-followthrough-${id.slice(0, 8)}`,
    cronExpr: "*/30 * * * *",
    mailDeliveryMode: "draft",
  });
  const realId = proactiveId(company.id, employee.id, "work-followthrough", null);
  const unrestricted = await insert(Routine, {
    id: realId,
    employeeId: employee.id,
    name: "Follow through on open work",
    slug: `proactive-work-followthrough-${realId.slice(0, 8)}`,
    cronExpr: "*/30 * * * *",
    mailDeliveryMode: null,
  });
  const other = await employeeIn(company, "bo");
  const reassigned = await insert(Routine, {
    id: proactiveId(company.id, employee.id, "work-followthrough", "mailbox"),
    employeeId: other.id,
    name: "Follow through on open work",
    slug: "proactive-work-followthrough-reassigned",
    cronExpr: "*/30 * * * *",
    mailDeliveryMode: "draft",
  });
  const item = await work(employee);
  assert.deepEqual(await backfillRunConditions(upgradeAt), { routines: 0, workstreams: 0 });
  for (const row of [lookalike, unrestricted, reassigned]) {
    assert.equal((await routine(row.id)).runCondition, "always", row.slug);
  }
  assert.equal((await workstream(item.id)).revisitAt, null);
});

test("it runs once: a Member's later choice stands, and later boots change nothing", async () => {
  const company = await insert(Company, { name: "Once", slug: "once", ownerId: "owner" });
  const employee = await employeeIn(company, "maya");
  const starter = await starterFor(employee);
  const first = await work(employee, { title: "First" });
  assert.deepEqual(await backfillRunConditions(upgradeAt), { routines: 1, workstreams: 1 });

  // A Member sets it back to Every time; the employee opens new unplanned work.
  await AppDataSource.getRepository(Routine).update(starter.id, { runCondition: "always" });
  const later = await work(employee, { title: "Later" });
  const another = await starterFor(await employeeIn(company, "bo"));

  assert.deepEqual(await backfillRunConditions(new Date()), { routines: 0, workstreams: 0 });
  assert.equal((await routine(starter.id)).runCondition, "always");
  assert.equal((await routine(another.id)).runCondition, "always", "the marker is written");
  assert.equal((await workstream(later.id)).revisitAt, null);
  assert.deepEqual((await workstream(first.id)).revisitAt, upgradeAt);
});

test("a starter already on its condition counts for nothing", async () => {
  const company = await insert(Company, { name: "Fresh", slug: "fresh", ownerId: "owner" });
  const employee = await employeeIn(company, "maya");
  await starterFor(employee, { runCondition: "workstream_due" });
  const item = await work(employee);
  assert.deepEqual(await backfillRunConditions(upgradeAt), { routines: 0, workstreams: 0 });
  assert.equal((await workstream(item.id)).revisitAt, null);
});
