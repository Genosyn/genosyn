import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Standdown } from "../db/entities/Standdown.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import {
  StanddownError,
  activeStanddownFor,
  assertNotStoodDown,
  interruptCoveredRuns,
  liftStanddown,
  listStanddowns,
  placeStanddown,
  refreshStanddowns,
  registerRunInterrupter,
  serializeStanddown,
  stopStanddowns,
  unregisterRunInterrupter,
  workBlocked,
} from "./standdowns.js";

/**
 * Standdown guarantees. The stop is only worth anything if it is immediate on
 * the replica that placed it, exact about what it covers, harmless across
 * company lines, and impossible to half-lift — so that is what these assert.
 */

let companyId: string;
let otherCompanyId: string;
let ownerId: string;
let managerId: string;
let ada: AIEmployee;
let bo: AIEmployee;
let adaRoutine: Routine;
let boRoutine: Routine;
let strangerEmployee: AIEmployee;
let strangerRoutine: Routine;

const registeredRuns: string[] = [];

function registerRun(runId: string, employee: AIEmployee, routine: Routine, company = companyId) {
  const state = { aborted: false };
  registeredRuns.push(runId);
  registerRunInterrupter(
    runId,
    { companyId: company, employeeId: employee.id, routineId: routine.id },
    () => {
      state.aborted = true;
    },
  );
  return state;
}

async function makeRoutine(employee: AIEmployee, name: string) {
  return insert(Routine, {
    employeeId: employee.id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    cronExpr: "0 9 * * 1",
    body: "Do the thing.",
  });
}

before(initTestDb);
after(async () => {
  stopStanddowns();
  await closeTestDb();
});

beforeEach(async () => {
  stopStanddowns();
  for (const runId of registeredRuns.splice(0)) unregisterRunInterrupter(runId);
  await resetTestDb();

  companyId = testCompanyId();
  otherCompanyId = testCompanyId();
  ownerId = testId("owner");
  managerId = testId("manager");

  ada = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
    reportsToUserId: managerId,
  });
  bo = await insert(AIEmployee, {
    companyId,
    name: "Bo",
    slug: "bo",
    role: "Writer",
    soulBody: "",
  });
  strangerEmployee = await insert(AIEmployee, {
    companyId: otherCompanyId,
    name: "Cyd",
    slug: "cyd",
    role: "Analyst",
    soulBody: "",
  });
  adaRoutine = await makeRoutine(ada, "Ada morning sweep");
  boRoutine = await makeRoutine(bo, "Bo weekly digest");
  strangerRoutine = await makeRoutine(strangerEmployee, "Cyd nightly");

  await insert(Membership, { companyId, userId: ownerId, role: "owner" });
  await insert(Membership, { companyId, userId: managerId, role: "member" });
});

afterEach(() => {
  stopStanddowns();
  for (const runId of registeredRuns.splice(0)) unregisterRunInterrupter(runId);
});

describe("workBlocked", () => {
  test("resolves each scope and blocks nothing outside it", async () => {
    await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Ada emailed the wrong list.",
      placedByUserId: ownerId,
    });
    const adaBlock = workBlocked(companyId, { employeeId: ada.id });
    assert.equal(adaBlock.blocked, true);
    assert.equal(adaBlock.blocked && adaBlock.scope, "employee");
    assert.equal(adaBlock.blocked && adaBlock.reason, "Ada emailed the wrong list.");
    assert.equal(workBlocked(companyId, { employeeId: bo.id }).blocked, false);
    assert.equal(workBlocked(companyId, { routineId: boRoutine.id }).blocked, false);
    assert.equal(workBlocked(companyId).blocked, false);
  });

  test("a routine standdown covers only that Routine", async () => {
    await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "The sweep is double-charging.",
      placedByUserId: ownerId,
    });
    const block = workBlocked(companyId, { employeeId: ada.id, routineId: adaRoutine.id });
    assert.equal(block.blocked, true);
    assert.equal(block.blocked && block.scope, "routine");
    // The employee is free to do everything else — this is the narrow stop.
    assert.equal(workBlocked(companyId, { employeeId: ada.id }).blocked, false);
    assert.equal(workBlocked(companyId, { routineId: boRoutine.id }).blocked, false);
  });

  test("a company standdown subsumes the narrower scopes", async () => {
    await placeStanddown({
      companyId,
      scope: "company",
      reason: "Incident 41 — stop everything.",
      placedByUserId: ownerId,
    });
    for (const target of [
      {},
      { employeeId: ada.id },
      { employeeId: bo.id },
      { routineId: boRoutine.id },
      { employeeId: bo.id, routineId: boRoutine.id },
    ]) {
      const block = workBlocked(companyId, target);
      assert.equal(block.blocked, true, `expected ${JSON.stringify(target)} blocked`);
      assert.equal(block.blocked && block.scope, "company");
    }
  });

  test("a narrow standdown does not shadow the wider one that also covers it", async () => {
    const narrow = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Ada is quarantined.",
      placedByUserId: ownerId,
    });
    const wide = await placeStanddown({
      companyId,
      scope: "company",
      reason: "Then the whole company.",
      placedByUserId: ownerId,
    });
    const block = workBlocked(companyId, { employeeId: ada.id });
    assert.equal(block.blocked && block.standdownId, wide.id);
    // Lifting the wide one leaves Ada's own stop standing.
    await liftStanddown({ standdown: wide, userId: ownerId, reason: "Incident closed." });
    const after = workBlocked(companyId, { employeeId: ada.id });
    assert.equal(after.blocked && after.standdownId, narrow.id);
  });

  test("scopes do not leak across companies", async () => {
    await placeStanddown({
      companyId,
      scope: "company",
      reason: "Ours only.",
      placedByUserId: ownerId,
    });
    assert.equal(workBlocked(otherCompanyId).blocked, false);
    assert.equal(
      workBlocked(otherCompanyId, {
        employeeId: strangerEmployee.id,
        routineId: strangerRoutine.id,
      }).blocked,
      false,
    );
    // An employee id is only meaningful inside its own company's entry.
    assert.equal(workBlocked(otherCompanyId, { employeeId: ada.id }).blocked, false);
  });
});

describe("assertNotStoodDown", () => {
  test("names the scope and the reason, and stays silent when nothing covers", async () => {
    assert.doesNotThrow(() => assertNotStoodDown(companyId, { employeeId: ada.id }));
    await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Sent 4,000 duplicate invoices.",
      placedByUserId: ownerId,
    });
    assert.throws(
      () => assertNotStoodDown(companyId, { employeeId: ada.id }),
      (err: unknown) =>
        err instanceof StanddownError &&
        /AI Employee/.test(err.message) &&
        /duplicate invoices/.test(err.message),
    );
  });
});

describe("placeStanddown", () => {
  test("is idempotent per scope rather than stacking a second row", async () => {
    const first = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "First press.",
      placedByUserId: ownerId,
    });
    const second = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Second press with a different reason.",
      placedByUserId: ownerId,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.reason, "First press.");
    assert.equal((await listStanddowns(companyId, { active: true })).length, 1);
    // One journal entry, not two — the second press changed nothing.
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({ employeeId: ada.id });
    assert.equal(journal.length, 1);
  });

  test("different scopes are independently idempotent", async () => {
    await placeStanddown({ companyId, scope: "company", reason: "A.", placedByUserId: ownerId });
    await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "B.",
      placedByUserId: ownerId,
    });
    await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "C.",
      placedByUserId: ownerId,
    });
    await placeStanddown({
      companyId,
      scope: "company",
      reason: "A again.",
      placedByUserId: ownerId,
    });
    assert.equal((await listStanddowns(companyId, { active: true })).length, 3);
  });

  test("validates the scope target against this company", async () => {
    await assert.rejects(
      placeStanddown({
        companyId,
        scope: "company",
        scopeId: ada.id,
        reason: "Nonsense.",
        placedByUserId: ownerId,
      }),
      StanddownError,
    );
    await assert.rejects(
      placeStanddown({
        companyId,
        scope: "employee",
        reason: "No target.",
        placedByUserId: ownerId,
      }),
      StanddownError,
    );
    await assert.rejects(
      placeStanddown({
        companyId,
        scope: "employee",
        scopeId: strangerEmployee.id,
        reason: "Someone else's employee.",
        placedByUserId: ownerId,
      }),
      /not in this company/,
    );
    await assert.rejects(
      placeStanddown({
        companyId,
        scope: "routine",
        scopeId: strangerRoutine.id,
        reason: "Someone else's routine.",
        placedByUserId: ownerId,
      }),
      /not in this company/,
    );
    await assert.rejects(
      placeStanddown({
        companyId,
        scope: "employee",
        scopeId: ada.id,
        reason: "   ",
        placedByUserId: ownerId,
      }),
      /needs a reason/,
    );
    assert.equal((await listStanddowns(companyId)).length, 0);
  });

  test("trims an oversized reason rather than refusing the stop", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "company",
      reason: `  ${"x".repeat(3000)}  `,
      placedByUserId: ownerId,
    });
    assert.equal(standdown.reason.length, 2000);
  });

  test("updates the cache synchronously — no refresh in between", async () => {
    assert.equal(workBlocked(companyId, { employeeId: ada.id }).blocked, false);
    const standdown = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Immediate.",
      placedByUserId: ownerId,
    });
    assert.equal(workBlocked(companyId, { employeeId: ada.id }).blocked, true);
    assert.equal(activeStanddownFor(companyId, { employeeId: ada.id })?.id, standdown.id);
  });

  test("writes one audit row naming the scope, outside any Run's ledger", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "Sweep is looping.",
      placedByUserId: ownerId,
    });
    const events = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId,
      action: "standdown.place",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].targetId, standdown.id);
    assert.equal(events[0].targetType, "standdown");
    assert.equal(events[0].runId, null);
    assert.match(events[0].metadataJson, /"scope":"routine"/);
  });

  test("journals every covered AI Employee exactly once and pages owners plus the manager", async () => {
    await placeStanddown({
      companyId,
      scope: "company",
      reason: "Incident 41.",
      placedByUserId: ownerId,
    });
    const journal = await AppDataSource.getRepository(JournalEntry).find();
    assert.equal(journal.length, 2);
    assert.deepEqual(
      journal.map((j) => j.employeeId).sort(),
      [ada.id, bo.id].sort(),
      "both employees in the company, and only them",
    );
    for (const entry of journal) {
      assert.equal(entry.kind, "system");
      assert.match(entry.title, /stood down/);
      assert.match(entry.body, /Incident 41\./);
    }

    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "standdown_placed",
    });
    // The owner is an admin-role recipient; the manager is on the reporting
    // line and is not an admin, so their presence is the real assertion here.
    assert.deepEqual(bells.map((b) => b.userId).sort(), [ownerId, managerId].sort());
    assert.equal(bells[0].entityKind, "standdown");
    assert.match(bells[0].body, /A human placed it/);
  });

  test("does not journal an employee outside the standdown's scope", async () => {
    await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "Just this one.",
      placedByUserId: ownerId,
    });
    const journal = await AppDataSource.getRepository(JournalEntry).find();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].employeeId, ada.id);
  });

  test("a breaker-placed standdown enforces exactly like a human's", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "Five consecutive failures.",
      source: "breaker",
      placedByUserId: null,
    });
    assert.equal(standdown.source, "breaker");
    assert.equal(standdown.placedByUserId, null);
    const block = workBlocked(companyId, { routineId: adaRoutine.id });
    assert.equal(block.blocked, true);
    assert.equal(block.blocked && block.scope, "routine");
    const bells = await AppDataSource.getRepository(Notification).findBy({
      kind: "standdown_placed",
    });
    assert.ok(bells.length > 0);
    assert.match(bells[0].body, /failure breaker/);
    // And it is lifted by the same act as any other.
    await liftStanddown({ standdown, userId: ownerId, reason: "Root cause fixed." });
    assert.equal(workBlocked(companyId, { routineId: adaRoutine.id }).blocked, false);
  });

  test("interrupts the Runs it covers when it is placed", async () => {
    const adaRun = registerRun(testId("run"), ada, adaRoutine);
    const boRun = registerRun(testId("run"), bo, boRoutine);
    await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Stop Ada now.",
      placedByUserId: ownerId,
    });
    assert.equal(adaRun.aborted, true);
    assert.equal(boRun.aborted, false, "work outside the scope keeps running");
  });
});

describe("liftStanddown", () => {
  test("lifts exactly once under a double call and enforces nothing afterwards", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Held while we look.",
      placedByUserId: ownerId,
    });
    const first = await liftStanddown({ standdown, userId: ownerId, reason: "All clear." });
    const second = await liftStanddown({
      standdown,
      userId: managerId,
      reason: "All clear again.",
    });

    assert.ok(first.liftedAt);
    assert.equal(second.liftedAt?.getTime(), first.liftedAt?.getTime());
    assert.equal(second.liftedByUserId, ownerId, "the loser of the race does not overwrite");
    assert.equal(second.liftedReason, "All clear.");

    const lifts = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId,
      action: "standdown.lift",
    });
    assert.equal(lifts.length, 1);
    const liftJournal = (
      await AppDataSource.getRepository(JournalEntry).findBy({ employeeId: ada.id })
    ).filter((j) => /lifted/.test(j.title));
    assert.equal(liftJournal.length, 1);
  });

  test("clears the cache synchronously — no refresh in between", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "company",
      reason: "Briefly.",
      placedByUserId: ownerId,
    });
    assert.equal(workBlocked(companyId).blocked, true);
    await liftStanddown({ standdown, userId: ownerId, reason: "Done." });
    assert.equal(workBlocked(companyId).blocked, false);
    assert.equal(activeStanddownFor(companyId), null);
    assert.equal((await listStanddowns(companyId, { active: true })).length, 0);
    assert.equal((await listStanddowns(companyId)).length, 1, "history is kept");
  });

  test("a lifted standdown is inert even after a full reload", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "Briefly.",
      placedByUserId: ownerId,
    });
    await liftStanddown({ standdown, userId: ownerId, reason: "Done." });
    await refreshStanddowns();
    assert.equal(workBlocked(companyId, { routineId: adaRoutine.id }).blocked, false);
  });
});

describe("refreshStanddowns", () => {
  test("picks up a row another replica wrote and drops one it lifted", async () => {
    // Written straight to the database, exactly as a sibling process would.
    const row = await insert(Standdown, {
      companyId,
      scope: "employee",
      scopeId: bo.id,
      reason: "Placed elsewhere.",
      source: "human",
      placedByUserId: ownerId,
      placedAt: new Date(),
      liftedAt: null,
    });
    assert.equal(workBlocked(companyId, { employeeId: bo.id }).blocked, false);
    await refreshStanddowns();
    const block = workBlocked(companyId, { employeeId: bo.id });
    assert.equal(block.blocked, true);
    assert.equal(block.blocked && block.standdownId, row.id);

    await AppDataSource.getRepository(Standdown).update(
      { id: row.id },
      { liftedAt: new Date(), liftedByUserId: ownerId },
    );
    assert.equal(workBlocked(companyId, { employeeId: bo.id }).blocked, true, "still cached");
    await refreshStanddowns();
    assert.equal(workBlocked(companyId, { employeeId: bo.id }).blocked, false);
  });

  test("repairs a cache mutated behind its back", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "company",
      reason: "Real and active.",
      placedByUserId: ownerId,
    });
    // Simulate drift: the row is active in the database but the process has
    // somehow forgotten it. A refresh must restore the truth, not the drift.
    stopStanddowns();
    assert.equal(workBlocked(companyId).blocked, false);
    await refreshStanddowns();
    const block = workBlocked(companyId);
    assert.equal(block.blocked, true);
    assert.equal(block.blocked && block.standdownId, standdown.id);
  });

  test("a standdown placed while a refresh is reading survives the swap", async () => {
    const refreshing = refreshStanddowns();
    const standdown = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "Raced the poller.",
      placedByUserId: ownerId,
    });
    await refreshing;
    const block = workBlocked(companyId, { employeeId: ada.id });
    assert.equal(block.blocked, true);
    assert.equal(block.blocked && block.standdownId, standdown.id);
  });
});

describe("interruptCoveredRuns", () => {
  test("aborts only the covered Runs and returns their ids", async () => {
    const adaRunId = testId("run");
    const boRunId = testId("run");
    const strangerRunId = testId("run");
    const adaRun = registerRun(adaRunId, ada, adaRoutine);
    const boRun = registerRun(boRunId, bo, boRoutine);
    const strangerRun = registerRun(
      strangerRunId,
      strangerEmployee,
      strangerRoutine,
      otherCompanyId,
    );

    const routineStanddown = await placeStanddown({
      companyId,
      scope: "routine",
      scopeId: adaRoutine.id,
      reason: "Only this Routine.",
      placedByUserId: ownerId,
    });
    assert.deepEqual(interruptCoveredRuns(routineStanddown), [adaRunId]);
    assert.equal(adaRun.aborted, true);
    assert.equal(boRun.aborted, false);
    assert.equal(strangerRun.aborted, false);

    const companyStanddown = await placeStanddown({
      companyId,
      scope: "company",
      reason: "Now everything.",
      placedByUserId: ownerId,
    });
    assert.deepEqual(interruptCoveredRuns(companyStanddown).sort(), [adaRunId, boRunId].sort());
    assert.equal(boRun.aborted, true);
    assert.equal(strangerRun.aborted, false, "another company's Run is never touched");
  });

  test("an unregistered Run is no longer interruptible", async () => {
    const runId = testId("run");
    const run = registerRun(runId, ada, adaRoutine);
    unregisterRunInterrupter(runId);
    const standdown = await placeStanddown({
      companyId,
      scope: "company",
      reason: "Too late for that Run.",
      placedByUserId: ownerId,
    });
    assert.deepEqual(interruptCoveredRuns(standdown), []);
    assert.equal(run.aborted, false);
  });
});

describe("serializeStanddown", () => {
  test("is plain JSON with ISO dates and an explicit active flag", async () => {
    const standdown = await placeStanddown({
      companyId,
      scope: "employee",
      scopeId: ada.id,
      reason: "For the banner.",
      placedByUserId: ownerId,
    });
    const active = serializeStanddown(standdown);
    assert.equal(active.active, true);
    assert.equal(active.scopeId, ada.id);
    assert.equal(active.liftedAt, null);
    assert.equal(typeof active.placedAt, "string");
    assert.doesNotThrow(() => JSON.stringify(active));

    const lifted = serializeStanddown(
      await liftStanddown({ standdown, userId: ownerId, reason: "Resolved." }),
    );
    assert.equal(lifted.active, false);
    assert.equal(typeof lifted.liftedAt, "string");
    assert.equal(lifted.liftedReason, "Resolved.");
  });
});
