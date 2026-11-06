import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { errorHandler } from "../middleware/error.js";
import { bootCron, resetSchedulesAfterRestore, stopCron, tickCron } from "../services/cron.js";
import { rescheduleCompanyRoutines } from "../services/companyTimeZone.js";
import { parseRoutineSpec } from "../services/initiatives.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { waitForRoutineQueueIdle } from "../services/routineQueue.js";
import { countMissedRoutineSlots, nextRoutineRun } from "../services/routineSchedule.js";
import { stopStanddowns } from "../services/standdowns.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * A random schedule from the outside in: a Member or an AI Employee writes one,
 * the Routine is scheduled from it, and nothing that works `nextRunAt` out again
 * afterwards moves the time it was given.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let ownerToken = "";
let employee: AIEmployee;

beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await resetTestDb();
  const owner = await createMemberOfNewCompany("owner");
  company = owner.company;
  await AppDataSource.getRepository(Company).update(company.id, { timezone: "Asia/Tokyo" });
  company.timezone = "Asia/Tokyo";
  ownerToken = (await mintTestApiKey(owner.user.id, company.id)).token;
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan Reyes",
    slug: "morgan",
    role: "Community",
  });
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ownerToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const repo = () => AppDataSource.getRepository(Routine);
const reload = (id: string) => repo().findOneByOrFail({ id });

async function createRoutine(cronExpr: string, name = "Post to Reddit") {
  return api("POST", `employees/${employee.id}/routines`, {
    name,
    cronExpr,
    brief: "Write something worth reading and post it.",
  });
}

function hourIn(zone: string, moment: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(
      moment,
    ),
  );
}

describe("a Member writing one", () => {
  test("creating a Routine with one schedules it and keeps the expression as written", async () => {
    const created = await createRoutine("@random 3/week");
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.cronExpr, "@random 3/week");
    assert.equal(created.body.enabled, true);

    const stored = await reload(created.body.id as string);
    assert.equal(stored.cronExpr, "@random 3/week");
    assert.ok(stored.nextRunAt && stored.nextRunAt.getTime() > Date.now());
    // The times the row was scheduled with are the ones its saved id gives, or
    // the first week of a new Routine would run a different number of times.
    assert.deepEqual(stored.nextRunAt, nextRoutineRun(stored, new Date(), "Asia/Tokyo"));
  });

  test("a Routine with no brief waits paused, and its first brief schedules it", async () => {
    const created = await api("POST", `employees/${employee.id}/routines`, {
      name: "No brief yet",
      cronExpr: "@random 1/day",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.enabled, false);
    assert.equal(created.body.nextRunAt, null);

    const written = await api("PUT", `routines/${created.body.id as string}/readme`, {
      content: "Post something.",
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const stored = await reload(created.body.id as string);
    assert.equal(stored.enabled, true);
    assert.deepEqual(stored.nextRunAt, nextRoutineRun(stored, new Date(), "Asia/Tokyo"));
  });

  test("switching a Routine between cron and random reschedules it each way", async () => {
    const created = await createRoutine("0 9 * * *");
    const id = created.body.id as string;
    assert.equal(hourIn("Asia/Tokyo", (await reload(id)).nextRunAt as Date), 9);

    const random = await api("PATCH", `routines/${id}`, {
      cronExpr: "@random 2/day 20:00-22:00",
    });
    assert.equal(random.status, 200, JSON.stringify(random.body));
    const hour = hourIn("Asia/Tokyo", (await reload(id)).nextRunAt as Date);
    assert.ok(hour >= 20 && hour < 22, `drawn at ${hour}:00 in the company's zone`);

    await api("PATCH", `routines/${id}`, { cronExpr: "0 9 * * *" });
    assert.equal(hourIn("Asia/Tokyo", (await reload(id)).nextRunAt as Date), 9);
  });

  for (const expr of [
    "@random",
    "@random 0/week",
    "@random 3/fortnight",
    "@random 500/week",
    "@random 1/day 09:00-09:00",
  ]) {
    test(`${JSON.stringify(expr)} is refused and says what a good one looks like`, async () => {
      const refused = await createRoutine(expr);
      assert.equal(refused.status, 400);
      assert.match(JSON.stringify(refused.body), /@random 3\/week/);
      assert.equal((await repo().find()).length, 0);
    });
  }

  test("plain cron is judged exactly as before", async () => {
    const invalid = await createRoutine("not cron");
    assert.equal(invalid.status, 400);
    assert.match(JSON.stringify(invalid.body), /Invalid cron expression/);
    const unschedulable = await createRoutine("5-1 9 * * *");
    assert.equal(unschedulable.status, 400);
    assert.match(JSON.stringify(unschedulable.body), /cannot be scheduled/);
  });
});

describe("nothing moves a time once it is drawn", () => {
  async function routineDueLater() {
    const created = await createRoutine("@random 3/week");
    assert.equal(created.status, 200);
    const id = created.body.id as string;
    const stored = await reload(id);
    assert.ok(stored.nextRunAt);
    return { id, slot: stored.nextRunAt };
  }

  test("saving settings that resend the same schedule, as the form always does", async () => {
    const { id, slot } = await routineDueLater();
    for (let save = 0; save < 3; save += 1) {
      const saved = await api("PATCH", `routines/${id}`, {
        cronExpr: "@random 3/week",
        timeoutSec: 600 + save,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual((await reload(id)).nextRunAt, slot);
    }
  });

  test("the boot sweep, a restore and an unchanged time zone", async () => {
    const { id, slot } = await routineDueLater();
    await bootCron();
    stopCron();
    await waitForRoutineQueueIdle();
    assert.deepEqual((await reload(id)).nextRunAt, slot, "boot");
    await resetSchedulesAfterRestore();
    assert.deepEqual((await reload(id)).nextRunAt, slot, "restore");
    assert.equal(await rescheduleCompanyRoutines(company.id), 0);
    assert.deepEqual((await reload(id)).nextRunAt, slot, "time zone");
  });

  test("pausing and resuming finds the same Runs still ahead", async () => {
    const { id, slot } = await routineDueLater();
    await api("PATCH", `routines/${id}`, { enabled: false });
    assert.equal((await reload(id)).nextRunAt, null);
    await api("PATCH", `routines/${id}`, { enabled: true });
    assert.deepEqual((await reload(id)).nextRunAt, slot);
  });

  test("two Routines on the same schedule get different times", async () => {
    const one = await createRoutine("@random 3/week", "One");
    const two = await createRoutine("@random 3/week", "Two");
    assert.notDeepEqual(
      (await reload(one.body.id as string)).nextRunAt,
      (await reload(two.body.id as string)).nextRunAt,
    );
  });

  test("changing the company's zone moves it onto the new clock", async () => {
    const created = await createRoutine("@random 2/day 20:00-22:00");
    const id = created.body.id as string;
    await AppDataSource.getRepository(Company).update(company.id, {
      timezone: "America/Los_Angeles",
    });
    assert.equal(await rescheduleCompanyRoutines(company.id), 1);
    const hour = hourIn("America/Los_Angeles", (await reload(id)).nextRunAt as Date);
    assert.ok(hour >= 20 && hour < 22, `drawn at ${hour}:00 in the new zone`);
  });
});

describe("the heartbeat", () => {
  test("advances a due Routine to its next Run and starts one", async () => {
    const created = await createRoutine("@random 4/day");
    const id = created.body.id as string;
    const stored = await reload(id);
    const expected = nextRoutineRun(stored, new Date(), "Asia/Tokyo");
    await repo().update(id, { nextRunAt: new Date(Date.now() - 1_000) });

    await tickCron();

    const after = await reload(id);
    assert.ok(after.nextRunAt && after.nextRunAt.getTime() > Date.now());
    assert.deepEqual(after.nextRunAt, expected);
    const runs = await AppDataSource.getRepository(Run).findBy({ routineId: id });
    assert.deepEqual(
      runs.map((run) => run.triggerKind),
      ["schedule"],
    );
    await waitForRoutineQueueIdle();
  });

  test("a long outage counts what it missed and catches up once, or skips and says so", async () => {
    const created = await createRoutine("@random 2/day");
    const id = created.body.id as string;
    const stored = await reload(id);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const missed = countMissedRoutineSlots(stored, weekAgo, now, 1_000, "Asia/Tokyo");
    // Fourteen shares long, so it holds thirteen whole ones and touches fifteen.
    assert.ok(missed.count >= 13 && missed.count <= 15, `${missed.count} in a week`);

    await repo().update(id, { nextRunAt: weekAgo, catchUpPolicy: "skip" });
    await tickCron();
    const after = await reload(id);
    assert.ok(after.nextRunAt && after.nextRunAt.getTime() > now.getTime());
    const skipped = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
      routineId: id,
    });
    assert.match(skipped.title, /Skipped \d+ missed occurrences/);
    assert.ok(skipped.title.includes(String(missed.count + 1)), skipped.title);
  });
});

describe("an AI Employee writing one", () => {
  const mcp = express();
  mcp.use(express.json());
  mcp.use("/internal/mcp", mcpInternalRouter);
  mcp.use(errorHandler);
  let mcpServer: Server;
  let mcpUrl = "";

  before(async () => {
    await new Promise<void>((resolve) => {
      mcpServer = mcp.listen(0, "127.0.0.1", resolve);
    });
    mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/internal/mcp`;
  });
  after(async () => {
    mcpServer.closeAllConnections();
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  });

  async function tool(name: string, body: unknown) {
    const token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const response = await fetch(`${mcpUrl}/tools/${name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, never> };
    } finally {
      revokeMcpToken(token);
    }
  }

  test("create_routine and update_routine take a random schedule", async () => {
    const created = await tool("create_routine", {
      name: "Post now and then",
      cronExpr: "@random 2/week 09:00-17:00",
      brief: "Post something.",
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const stored = await repo().findOneByOrFail({ name: "Post now and then" });
    assert.equal(stored.cronExpr, "@random 2/week 09:00-17:00");
    assert.ok(stored.nextRunAt);
    const hour = hourIn("Asia/Tokyo", stored.nextRunAt);
    assert.ok(hour >= 9 && hour < 17, `drawn at ${hour}:00 in the company's zone`);

    const updated = await tool("update_routine", {
      routineId: stored.id,
      cronExpr: "@random 1/month",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await reload(stored.id)).cronExpr, "@random 1/month");
  });

  test("a broken one is refused the same way", async () => {
    const refused = await tool("create_routine", {
      name: "Broken",
      cronExpr: "@random 0/never",
      brief: "Post something.",
    });
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.body), /@random 3\/week/);
  });

  test("an Initiative may propose one", () => {
    const spec = (cronExpr: string) =>
      JSON.stringify({ name: "Now and then", cronExpr, body: "Post something." });
    assert.equal(parseRoutineSpec(spec("@random 3/week")).cronExpr, "@random 3/week");
    assert.throws(() => parseRoutineSpec(spec("@random 0/week")), /cannot be scheduled/);
  });
});
