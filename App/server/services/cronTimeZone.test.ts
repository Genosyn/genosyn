import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import {
  bootCron,
  registerRoutine,
  resetSchedulesAfterRestore,
  stopCron,
  tickCron,
} from "./cron.js";
import {
  companyTimeZone,
  employeeTimeZone,
  rescheduleCompanyRoutines,
  schedulingZone,
  timeZoneLookup,
} from "./companyTimeZone.js";
import { acceptInitiative, proposeInitiative } from "./initiatives.js";
import { installProactiveStarter, toggleProactiveStarter } from "./proactive/setup.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { startRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * Where a Routine's schedule is read: the clock of its company's time zone,
 * or the server's own when the company has none.
 *
 * Every test pretends the server is in Auckland, because a clock nobody else
 * shares is the only way to tell "read on the server's clock" from "read on
 * the company's" — and from UTC, which is where a Docker server usually sits
 * and where a wrong answer would look right.
 */

const SERVER = "Pacific/Auckland";
const TOKYO = "Asia/Tokyo";
const NINE = "0 9 * * *";

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await resetTestDb();
});
after(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

/** Run `fn` with the process on `zone`'s clock — what "server time" means. */
async function onServerClock<T>(zone: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** The 24-hour wall clock ("09:00") a moment reads in `zone`. */
function clockIn(zone: string, moment: Date | null): string {
  assert.ok(moment, "expected a scheduled time");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(moment);
}

let counter = 0;
async function hire(timezone: string) {
  counter += 1;
  const company = await insert(Company, {
    name: `Company ${counter}`,
    slug: `company-${counter}`,
    ownerId: "owner",
    timezone,
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: `Employee ${counter}`,
    slug: `employee-${counter}`,
    role: "Operations",
  });
  return { company, employee };
}

async function routineFor(employee: AIEmployee, over: Partial<Routine> = {}): Promise<Routine> {
  counter += 1;
  return insert(Routine, {
    employeeId: employee.id,
    name: `Routine ${counter}`,
    slug: `routine-${counter}`,
    cronExpr: NINE,
    body: "Do the work.",
    ...over,
  });
}

const reload = (routine: Routine) =>
  AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });

/** When a Routine is next due; the test fails if it has no schedule. */
function scheduled(routine: Routine): Date {
  assert.ok(routine.nextRunAt, "expected a scheduled time");
  return routine.nextRunAt;
}

test("registerRoutine schedules on the zone it is given, and clears a paused Routine", async () => {
  await onServerClock(SERVER, () => {
    const routine = new Routine();
    routine.enabled = true;
    routine.cronExpr = NINE;
    registerRoutine(routine, TOKYO);
    assert.equal(clockIn(TOKYO, scheduled(routine)), "09:00");
    assert.ok(scheduled(routine).getTime() > Date.now());

    // "" is server time: nine o'clock on the machine's own clock.
    registerRoutine(routine, "");
    assert.equal(clockIn(SERVER, scheduled(routine)), "09:00");
    assert.notEqual(clockIn(TOKYO, scheduled(routine)), "09:00");

    routine.enabled = false;
    registerRoutine(routine, TOKYO);
    assert.equal(routine.nextRunAt, null);
  });
});

test("a company's zone reaches the scheduler through its employees", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const tokyo = await hire(TOKYO);
  const plain = await hire("");
  assert.equal(await companyTimeZone(tokyo.company.id), TOKYO);
  assert.equal(await employeeTimeZone(tokyo.employee.id), TOKYO);
  assert.equal(await employeeTimeZone(plain.employee.id), "");

  // Nothing to look up is server time, not an error: a deleted row under a
  // Routine mid-pass must not take the heartbeat down.
  assert.equal(await companyTimeZone("no-such-company"), "");
  assert.equal(await employeeTimeZone("no-such-employee"), "");

  // A stored name the runtime cannot resolve is server time too — said once.
  assert.equal(schedulingZone("Mars/Base", "co-1"), "");
  assert.equal(schedulingZone("Mars/Base", "co-1"), "");
  assert.equal(schedulingZone("  Europe/Berlin ", "co-1"), "Europe/Berlin");
  assert.equal(schedulingZone(null), "");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /Mars\/Base/);
});

test("one pass asks for each employee and company once", async (t) => {
  const first = await hire(TOKYO);
  const second = await insert(AIEmployee, {
    companyId: first.company.id,
    name: "Second",
    slug: "second",
    role: "Operations",
  });
  const employees = t.mock.method(AppDataSource.getRepository(AIEmployee), "findOne");
  const companies = t.mock.method(AppDataSource.getRepository(Company), "findOne");
  const zoneOf = timeZoneLookup();
  const answers = await Promise.all([
    zoneOf(first.employee.id),
    zoneOf(first.employee.id),
    zoneOf(second.id),
    zoneOf(second.id),
  ]);
  assert.deepEqual(answers, [TOKYO, TOKYO, TOKYO, TOKYO]);
  assert.equal(employees.mock.callCount(), 2, "one employee read each");
  assert.equal(companies.mock.callCount(), 1, "one company read, shared by both");
  assert.equal(await zoneOf("no-such-employee"), "");
});

test("the heartbeat advances a due Routine on its company's clock, and server time when it has none", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const tokyo = await hire(TOKYO);
  const plain = await hire("");
  // A name the runtime does not know, as an older Node would see a newer one.
  const unknown = await hire("Mars/Base");
  const overdue = new Date(Date.now() - 3 * 86_400_000);
  const routines: Routine[] = [];
  for (const { employee } of [tokyo, plain, unknown]) {
    // "skip" declines the three-day-old catch-up, so the pass moves the
    // schedule without starting a Run.
    routines.push(await routineFor(employee, { nextRunAt: overdue, catchUpPolicy: "skip" }));
  }

  await onServerClock(SERVER, () => tickCron());

  const [advancedTokyo, advancedPlain, advancedUnknown] = await Promise.all(routines.map(reload));
  assert.ok((advancedTokyo.nextRunAt as Date).getTime() > Date.now());
  assert.equal(clockIn(TOKYO, advancedTokyo.nextRunAt), "09:00");
  assert.equal(clockIn(SERVER, advancedPlain.nextRunAt), "09:00");
  assert.equal(clockIn(SERVER, advancedUnknown.nextRunAt), "09:00", "unknown zone fell back");
  assert.ok(warn.mock.calls.some((call) => /Mars\/Base/.test(String(call.arguments[0]))));
});

test("the boot sweep and a restore re-anchor every Routine on its company's clock", async () => {
  const tokyo = await hire(TOKYO);
  const plain = await hire("");
  const future = new Date(Date.now() + 86_400_000);
  const blank = await routineFor(tokyo.employee, { nextRunAt: null });
  const frozen = await routineFor(plain.employee, { nextRunAt: future });
  const paused = await routineFor(tokyo.employee, { enabled: false, nextRunAt: null });
  const later = await routineFor(tokyo.employee, { nextRunAt: future });

  await onServerClock(SERVER, async () => {
    // Boot fills in only what has no schedule.
    await bootCron();
    stopCron();
    assert.equal(clockIn(TOKYO, (await reload(blank)).nextRunAt), "09:00");
    assert.equal((await reload(later)).nextRunAt?.getTime(), future.getTime());

    // A restore re-anchors every enabled Routine, each on its own clock — and
    // the slots a restored archive froze in the past are not left owed.
    await AppDataSource.getRepository(Routine).update(
      { id: frozen.id },
      { nextRunAt: new Date(Date.now() - 86_400_000) },
    );
    await resetSchedulesAfterRestore();
    assert.equal(clockIn(TOKYO, (await reload(blank)).nextRunAt), "09:00");
    assert.equal(clockIn(TOKYO, (await reload(later)).nextRunAt), "09:00");
    assert.equal(clockIn(SERVER, (await reload(frozen)).nextRunAt), "09:00");
    assert.ok(((await reload(frozen)).nextRunAt as Date).getTime() > Date.now());
    assert.equal((await reload(paused)).nextRunAt, null);
  });
});

test("changing a company's zone re-anchors its enabled Routines and no one else's", async () => {
  const mine = await hire("");
  const other = await hire("");
  await onServerClock(SERVER, async () => {
    const scheduled = await routineFor(mine.employee);
    registerRoutine(scheduled, "");
    await AppDataSource.getRepository(Routine).save(scheduled);
    // One whose slot a restore left in the past, one that is paused, and a
    // different company's Routine on the same cron.
    const stale = await routineFor(mine.employee, { nextRunAt: new Date(Date.now() - 86_400_000) });
    const paused = await routineFor(mine.employee, { enabled: false, nextRunAt: null });
    const elsewhere = await routineFor(other.employee);
    registerRoutine(elsewhere, "");
    await AppDataSource.getRepository(Routine).save(elsewhere);
    const elsewhereAt = (await reload(elsewhere)).nextRunAt;
    assert.equal(clockIn(SERVER, (await reload(scheduled)).nextRunAt), "09:00");

    await AppDataSource.getRepository(Company).update({ id: mine.company.id }, { timezone: TOKYO });
    assert.equal(await rescheduleCompanyRoutines(mine.company.id), 2);

    for (const routine of [scheduled, stale]) {
      const moved = await reload(routine);
      assert.equal(clockIn(TOKYO, moved.nextRunAt), "09:00");
      assert.ok((moved.nextRunAt as Date).getTime() > Date.now());
    }
    assert.equal((await reload(paused)).nextRunAt, null, "a paused Routine stays unscheduled");
    assert.equal((await reload(elsewhere)).nextRunAt?.getTime(), elsewhereAt?.getTime());
    assert.equal(await rescheduleCompanyRoutines(mine.company.id), 0, "nothing left to move");

    // Back to "Server time": the Routines read the machine's clock again.
    await AppDataSource.getRepository(Company).update({ id: mine.company.id }, { timezone: "" });
    assert.equal(await rescheduleCompanyRoutines(mine.company.id), 2);
    assert.equal(clockIn(SERVER, (await reload(scheduled)).nextRunAt), "09:00");
    assert.equal(clockIn(SERVER, (await reload(stale)).nextRunAt), "09:00");
  });
});

test("a schedule edit that lands mid-reschedule is kept, not overwritten", async (t) => {
  const { company, employee } = await hire(TOKYO);
  const routine = await routineFor(employee, { nextRunAt: new Date(Date.now() + 3_600_000) });
  const repo = AppDataSource.getRepository(Routine);
  const update = repo.update.bind(repo);
  let raced = false;
  // The first guarded write loses to a concurrent edit of the cron, which has
  // already put its own slot on the new clock.
  t.mock.method(
    repo,
    "update",
    async (
      criteria: Parameters<typeof repo.update>[0],
      values: Parameters<typeof repo.update>[1],
    ) => {
      if (!raced) {
        raced = true;
        await update(
          { id: routine.id },
          { cronExpr: "30 14 * * *", nextRunAt: new Date(Date.now() + 5_000) },
        );
      }
      return update(criteria, values);
    },
  );
  assert.equal(await rescheduleCompanyRoutines(company.id), 1);
  const kept = await reload(routine);
  assert.equal(kept.cronExpr, "30 14 * * *", "the edit survives");
  assert.equal(clockIn(TOKYO, kept.nextRunAt), "14:30", "and is scheduled on the company clock");
});

test("rescheduling a company with no employees or no Routines does nothing", async () => {
  const { company } = await hire(TOKYO);
  assert.equal(await rescheduleCompanyRoutines(company.id), 0);
  const empty = await insert(Company, { name: "Empty", slug: "empty", ownerId: "owner" });
  assert.equal(await rescheduleCompanyRoutines(empty.id), 0);
  assert.equal(await rescheduleCompanyRoutines("no-such-company"), 0);
});

test("a finished Run re-anchors the schedule on the company's clock, not the server's", async (t) => {
  const { company, employee } = await hire(TOKYO);
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "test",
    }),
  });
  const routine = await routineFor(employee, {
    timeoutSec: 60,
    nextRunAt: new Date(Date.now() - 86_400_000),
  });
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Done",
    steps: 1,
    stopReason: "end_turn",
  }));

  // Earlier tests stopped the scheduler, and a stopped queue holds a Run back.
  await resumeRoutineQueue();
  const started = await onServerClock(SERVER, () => startRoutineRun(routine));
  const finished = await onServerClock(SERVER, () => started.completion);
  assert.equal(finished.status, "completed");
  assert.equal(company.timezone, TOKYO);

  // The next slot is nine in Tokyo. Read on the server's clock it would be
  // nine in Auckland — a different instant — and a Run that finished while
  // the heartbeat had set Tokyo's slot would skip or repeat a morning.
  const after = await reload(routine);
  assert.ok(after.lastRunAt);
  assert.equal(clockIn(TOKYO, after.nextRunAt), "09:00");
  assert.notEqual(clockIn(SERVER, after.nextRunAt), "09:00");
});

test("Initiatives and Proactive starters are first scheduled on the company's clock", async () => {
  const { company, employee } = await hire(TOKYO);

  await onServerClock(SERVER, async () => {
    const initiative = await proposeInitiative({
      companyId: company.id,
      employeeId: employee.id,
      title: "Chase stale deals",
      evidence: "Eleven deals sat untouched past 14 days last month.",
      proposal: "A weekly sweep costs one run and saves the quarter.",
      routineSpec: { name: "Stale-deal sweep", cronExpr: NINE, body: "Chase stale deals." },
    });
    const accepted = await acceptInitiative(initiative, { userId: null });
    const created = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: accepted.createdRoutineId!,
    });
    assert.equal(clockIn(TOKYO, created.nextRunAt), "09:00");

    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "fixture",
      isActive: true,
      authMode: "apikey",
      configJson: JSON.stringify({ apiKeyEncrypted: "fixture-only" }),
    });
    // "Review my own work" is Fridays at 15:00.
    const starter = await installProactiveStarter(company.id, null, {
      recipeId: "improve-own-work",
      employeeId: employee.id,
      accountId: null,
      delivery: "draft",
      instruction: "Review your own work and suggest improvements.",
    });
    const weekly = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: starter.id });
    assert.equal(clockIn(TOKYO, weekly.nextRunAt), "15:00");
    assert.equal(
      new Intl.DateTimeFormat("en-US", { timeZone: TOKYO, weekday: "short" }).format(
        weekly.nextRunAt as Date,
      ),
      "Fri",
    );

    // Pausing and resuming the starter re-reads the company's clock too.
    await toggleProactiveStarter(company.id, "member", starter.id, false);
    assert.equal((await reload(weekly)).nextRunAt, null);
    await toggleProactiveStarter(company.id, "member", starter.id, true);
    assert.equal(clockIn(TOKYO, (await reload(weekly)).nextRunAt), "15:00");
  });
});
