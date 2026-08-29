import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { overrideRuntimeSettingsForTests } from "../runtimeSettings.js";
import {
  meetingsHeartbeatTick,
  resetMeetingsHeartbeatPacingForTests,
  runMeetingsHeartbeat,
  type MeetingHeartbeatDependencies,
} from "./boot.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_meeting_heartbeat";

async function account(status: CalendarAccount["status"]): Promise<CalendarAccount> {
  return insert(CalendarAccount, {
    companyId: CO,
    connectionId: `connection-${status}`,
    calendarId: `calendar-${status}`,
    status,
  });
}

function dependencies(
  syncAccount: MeetingHeartbeatDependencies["syncAccount"],
): MeetingHeartbeatDependencies {
  return {
    syncAccount,
    armAccount: async () => 0,
    process: async () => ({
      transcribed: false,
      linked: 0,
      actionItems: 0,
      status: "ready",
      note: "",
    }),
  };
}

describe("meeting calendar heartbeat", () => {
  test("retries error calendars, restores them to active, and leaves paused calendars alone", async () => {
    const errored = await account("error");
    const paused = await account("paused");
    const synced: string[] = [];

    await runMeetingsHeartbeat(
      dependencies(async (row) => {
        synced.push(row.id);
        return { upserted: 0, cancelled: 0, pruned: 0, truncated: false };
      }),
    );

    assert.deepEqual(synced, [errored.id]);
    assert.equal(
      (await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id: errored.id }))
        .status,
      "active",
    );
    assert.equal(
      (await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id: paused.id }))
        .status,
      "paused",
    );
  });

  test("a transient failure is selected again on the next pass", async () => {
    const calendar = await account("active");
    let attempts = 0;
    const deps = dependencies(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary Google outage");
      return { upserted: 0, cancelled: 0, pruned: 0, truncated: false };
    });

    await runMeetingsHeartbeat(deps);
    assert.equal(
      (await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id: calendar.id }))
        .status,
      "error",
    );
    await runMeetingsHeartbeat(deps);
    assert.equal(attempts, 2);
    assert.equal(
      (await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id: calendar.id }))
        .status,
      "active",
    );
  });
});

/**
 * The heartbeat's pacing and its master switch.
 *
 * Both used to be frozen at module load — the interval into a `const`, the
 * switch into an early return from `bootMeetings()` — so changing either meant
 * restarting the process. They are operator-editable runtime settings now, and
 * the timer runs on a fixed short tick that re-reads them, so the tick itself
 * has to make the decision. That is what these cover.
 */
describe("the heartbeat tick reads its settings every time", () => {
  beforeEach(() => {
    resetMeetingsHeartbeatPacingForTests();
    overrideRuntimeSettingsForTests(null);
  });

  afterEach(() => {
    overrideRuntimeSettingsForTests(null);
  });

  /** The tick is fire-and-forget, so wait for its effect rather than for it. */
  async function syncStateOf(id: string): Promise<string> {
    const row = await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id });
    return row.syncState;
  }

  async function waitForWork(id: string, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await syncStateOf(id)) !== "idle") return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  test("a tick does no work at all while meetings are turned off", async () => {
    const row = await account("active");
    overrideRuntimeSettingsForTests({ meetings: { enabled: false } });

    meetingsHeartbeatTick();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Turning the section off stops the heartbeat without a restart.
    assert.equal(await syncStateOf(row.id), "idle");
  });

  test("turning meetings back on resumes work on the very next tick", async () => {
    const row = await account("active");
    overrideRuntimeSettingsForTests({ meetings: { enabled: false } });
    meetingsHeartbeatTick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await syncStateOf(row.id), "idle");

    overrideRuntimeSettingsForTests({ meetings: { enabled: true } });
    meetingsHeartbeatTick();

    assert.equal(await waitForWork(row.id), true);
  });

  test("a second tick inside the configured interval is a no-op", async () => {
    const row = await account("active");
    overrideRuntimeSettingsForTests({ meetings: { enabled: true, syncIntervalSeconds: 3_600 } });

    meetingsHeartbeatTick();
    assert.equal(await waitForWork(row.id), true);

    // Back to idle so a second pass would be visible …
    await AppDataSource.getRepository(CalendarAccount).update({ id: row.id }, { syncState: "idle" });
    meetingsHeartbeatTick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await syncStateOf(row.id), "idle");

    // … and it is, once the interval is treated as elapsed.
    resetMeetingsHeartbeatPacingForTests();
    meetingsHeartbeatTick();
    assert.equal(await waitForWork(row.id), true);
  });
});
