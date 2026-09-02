import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId, testId } from "../test/dbHarness.js";
import {
  InitiativeError,
  acceptInitiative,
  declineInitiative,
  proposeInitiative,
} from "./initiatives.js";

/**
 * Initiative guarantees: the spec is validated when proposed so an accept
 * can never fail on a bad cron, the queue is bounded, and accept creates
 * exactly the Routine the reviewer read — once.
 */

let companyId: string;
let employee: AIEmployee;
let ownerId: string;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  ownerId = testId("owner");
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  await insert(Membership, { companyId, userId: ownerId, role: "owner" });
});

function spec(over: Partial<{ name: string; cronExpr: string; body: string }> = {}) {
  return {
    name: "Weekly stale-deal sweep",
    cronExpr: "0 9 * * 1",
    body: "Find deals with no activity in 14 days and chase their owners.",
    ...over,
  };
}

async function propose(title = "Stale deals go unchased") {
  return proposeInitiative({
    companyId,
    employeeId: employee.id,
    title,
    evidence: "Eleven deals sat untouched past 14 days last month; three died silently.",
    proposal: "A weekly sweep that chases every stale deal costs one run and saves the quarter.",
    routineSpec: spec(),
  });
}

describe("proposeInitiative", () => {
  test("validates the spec at propose time — a bad cron never reaches a reviewer", async () => {
    await assert.rejects(
      proposeInitiative({
        companyId,
        employeeId: employee.id,
        title: "X",
        evidence: "e",
        proposal: "p",
        routineSpec: spec({ cronExpr: "every tuesday-ish" }),
      }),
      /cannot be scheduled/,
    );
  });

  test("refuses every shape the rest of the product cannot read or schedule", async () => {
    // `cron-parser` alone is not the bar. It happily schedules a four-field
    // expression and a bare `*`, which really do fire — and which `node-cron`,
    // `cronstrue`, and the schedule picker all reject, so an accepted
    // Initiative could create a live Routine that the reviewer approving it,
    // and everyone after, sees as an unreadable expression with no sentence.
    // The other direction is `node-cron`-only expressions that compute no next
    // run and therefore never fire at all.
    for (const cronExpr of ["0 9 * *", "*", "@annually", "0 9 1W * *", "5-1 9 * * *"]) {
      await assert.rejects(
        proposeInitiative({
          companyId,
          employeeId: employee.id,
          title: `Initiative ${cronExpr}`,
          evidence: "e",
          proposal: "p",
          routineSpec: spec({ cronExpr }),
        }),
        /cannot be scheduled/,
        `${cronExpr} reached a reviewer`,
      );
    }
  });

  test("pages the admins, bounds the queue, and refuses duplicate titles", async () => {
    await propose();
    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "initiative_pending",
    });
    assert.equal(bells.length, 1);
    await assert.rejects(propose(), /already pending/);
    for (let n = 2; n <= 5; n++) await propose(`Initiative ${n}`);
    await assert.rejects(propose("Initiative 6"), /pending review/);
  });
});

describe("acceptInitiative", () => {
  test("creates exactly the routine the reviewer read, owned by the proposer, once", async () => {
    const initiative = await propose();
    const accepted = await acceptInitiative(initiative, { userId: ownerId, note: "Good case." });
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.createdRoutineId);
    const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: accepted.createdRoutineId!,
    });
    assert.equal(routine.employeeId, employee.id);
    assert.equal(routine.name, "Weekly stale-deal sweep");
    assert.equal(routine.cronExpr, "0 9 * * 1");
    assert.equal(routine.enabled, true);
    assert.ok(routine.nextRunAt, "the created routine is actually scheduled");
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: employee.id,
    });
    assert.ok(journal.some((j) => /was accepted/.test(j.title)));

    await assert.rejects(acceptInitiative(accepted, { userId: ownerId }), /already decided/);
  });

  test("declining journals the reason and blocks a re-decide", async () => {
    const initiative = await propose();
    const declined = await declineInitiative(initiative, {
      userId: ownerId,
      note: "Not this quarter.",
    });
    assert.equal(declined.status, "declined");
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: employee.id,
    });
    assert.ok(journal.some((j) => /was declined/.test(j.title)));
    await assert.rejects(acceptInitiative(declined, { userId: ownerId }), InitiativeError);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findBy({ employeeId: employee.id })).length,
      0,
    );
  });
});
