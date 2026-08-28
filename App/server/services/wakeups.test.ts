import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import type { chatWithEmployee } from "./chat.js";
import { WakeupError, cancelWakeup, dispatchDueWakeups, scheduleWakeup } from "./wakeups.js";

/**
 * Wakeup guarantees: scheduling is bounded, cancellation is exactly-once and
 * own-only for employees, and a fired wakeup always leaves a legible outcome
 * — a session report, a journal fallback, or the failure reason. Never a
 * timer that fired into silence.
 */

let companyId: string;
let employee: AIEmployee;

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
});

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);

describe("scheduleWakeup", () => {
  test("needs a future time inside the horizon and a non-empty brief", async () => {
    await assert.rejects(
      scheduleWakeup({ companyId, employeeId: employee.id, at: new Date(Date.now() - 1), brief: "x" }),
      WakeupError,
    );
    await assert.rejects(
      scheduleWakeup({
        companyId,
        employeeId: employee.id,
        at: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000),
        brief: "x",
      }),
      /90 days/,
    );
    await assert.rejects(
      scheduleWakeup({ companyId, employeeId: employee.id, at: inOneHour(), brief: "   " }),
      WakeupError,
    );
  });

  test("the pending cap bounds a self-scheduling loop", async () => {
    for (let n = 0; n < 20; n++) {
      await scheduleWakeup({ companyId, employeeId: employee.id, at: inOneHour(), brief: `n${n}` });
    }
    await assert.rejects(
      scheduleWakeup({ companyId, employeeId: employee.id, at: inOneHour(), brief: "one more" }),
      /pending wakeups/,
    );
  });
});

describe("cancelWakeup", () => {
  test("an employee cancels only its own, exactly once", async () => {
    const wakeup = await scheduleWakeup({
      companyId,
      employeeId: employee.id,
      at: inOneHour(),
      brief: "check the invoice",
    });
    const stranger = await insert(AIEmployee, {
      companyId,
      name: "Eve",
      slug: "eve",
      role: "Writer",
      soulBody: "",
    });
    assert.equal(await cancelWakeup(companyId, wakeup.id, { employeeId: stranger.id }), false);
    assert.equal(await cancelWakeup(companyId, wakeup.id, { employeeId: employee.id }), true);
    assert.equal(await cancelWakeup(companyId, wakeup.id, { employeeId: employee.id }), false);
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fresh.status, "cancelled");
  });
});

describe("dispatchDueWakeups", () => {
  async function due(brief = "check the invoice"): Promise<EmployeeWakeup> {
    return insert(EmployeeWakeup, {
      companyId,
      employeeId: employee.id,
      at: new Date(Date.now() - 60_000),
      brief,
      status: "pending",
    });
  }

  test("no model → journal fallback, and the outcome says so", async () => {
    const wakeup = await due();
    await dispatchDueWakeups();
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fresh.status, "fired");
    assert.match(fresh.outcomeNote, /journal instead/);
    const journal = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: employee.id,
    });
    assert.ok(journal.some((j) => /wakeup you scheduled is due/.test(j.title)));
  });

  test("with a model the session is briefed with the note, once, and reports back", async () => {
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-x",
      isActive: true,
    });
    const wakeup = await due("chase the Acme invoice");
    let seenBrief = "";
    let sessions = 0;
    const runChat = (async (_cid: string, _eid: string, brief: string) => {
      sessions += 1;
      seenBrief = brief;
      return { status: "ok" as const, reply: "Chased it; they pay Friday." };
    }) as unknown as typeof chatWithEmployee;

    await dispatchDueWakeups(new Date(), runChat);
    await dispatchDueWakeups(new Date(), runChat); // the race: claimed once

    assert.equal(sessions, 1);
    assert.match(seenBrief, /your past self left this note/i);
    assert.match(seenBrief, /chase the Acme invoice/);
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fresh.status, "fired");
    assert.match(fresh.outcomeNote, /pay Friday/);
  });

  test("a session failure lands as the outcome, never silence", async () => {
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-x",
      isActive: true,
    });
    const wakeup = await due();
    const runChat = (async () => {
      throw new Error("provider unreachable");
    }) as unknown as typeof chatWithEmployee;
    await dispatchDueWakeups(new Date(), runChat);
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fresh.status, "fired");
    assert.match(fresh.outcomeNote, /provider unreachable/);
  });

  test("future wakeups are left alone", async () => {
    const wakeup = await insert(EmployeeWakeup, {
      companyId,
      employeeId: employee.id,
      at: inOneHour(),
      brief: "later",
      status: "pending",
    });
    await dispatchDueWakeups();
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({
      id: wakeup.id,
    });
    assert.equal(fresh.status, "pending");
  });
});
