import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { type MeetingHeartbeatDependencies, runMeetingsHeartbeat } from "./boot.js";

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
