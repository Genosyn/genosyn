import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { ensureNotetakerCanRecord, updateCalendarAccount } from "./accounts.js";
import {
  dispatchDueMeetings,
  registerMeetingRecorder,
  setMeetingBackgroundProcessor,
  shutdownMeetingNotetakers,
  type MeetingRecorder,
} from "./recorder.js";
import { armMeetingsForAccount, createAdHocMeeting } from "./store.js";

/**
 * The setup flow, end to end — the bug this file exists for.
 *
 * Everything in the recording path was covered, and all of it passed, because
 * every test built its own `EmployeeCalendarGrant` by hand. Nothing in the
 * product ever did. An operator connected a calendar, chose "Record every
 * Google Meet", picked a notetaker, and was told on that very page that
 * eligible Meets would be joined — and then `validateClaimedJoin` refused
 * every single call for want of a Grant, settling it `skipped` with a reason
 * the UI rendered nowhere. The notetaker never turned up, ever, and no error
 * appeared anywhere a human would look.
 *
 * So these tests are deliberately written against the operator's flow rather
 * than the recorder's: nothing below writes a grant row directly, because the
 * point is that the product now writes it.
 */

const CO = "co_notetaker_setup";
const OTHER_CO = "co_someone_else";

before(initTestDb);
beforeEach(async () => {
  await shutdownMeetingNotetakers("Test reset.", 1_000);
  registerMeetingRecorder(null);
  setMeetingBackgroundProcessor();
  await resetTestDb();
});
after(async () => {
  await shutdownMeetingNotetakers("Test suite finished.", 1_000);
  await closeTestDb();
});

async function anEmployee(companyId = CO, name = "Nova"): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "Account executive",
  });
}

async function aCalendar(companyId = CO): Promise<CalendarAccount> {
  return insert(CalendarAccount, {
    companyId,
    connectionId: `connection-${Math.random()}`,
    calendarId: `calendar-${Math.random()}`,
    address: "sales@northwind.test",
    status: "active",
  });
}

async function anEvent(account: CalendarAccount, now: Date): Promise<CalendarEvent> {
  return insert(CalendarEvent, {
    companyId: account.companyId,
    accountId: account.id,
    externalId: `event-${Math.random()}`,
    summary: "Acme renewal",
    startAt: new Date(now.getTime() + 10_000),
    endAt: new Date(now.getTime() + 60 * 60_000),
    status: "confirmed",
    conferenceProvider: "meet",
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
  });
}

function recordingRecorder(joined: string[]): MeetingRecorder {
  return {
    id: "notetaker",
    canJoin: () => true,
    join: async (args) => {
      joined.push(args.meetingId);
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    },
  };
}

async function grantsFor(employeeId: string): Promise<EmployeeCalendarGrant[]> {
  return AppDataSource.getRepository(EmployeeCalendarGrant).find({ where: { employeeId } });
}

async function reload(account: CalendarAccount): Promise<CalendarAccount> {
  return AppDataSource.getRepository(CalendarAccount).findOneByOrFail({ id: account.id });
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached.");
}

describe("naming a notetaker grants it Record", () => {
  test("the ordinary setup flow ends with a Record grant nobody had to know about", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);

    await updateCalendarAccount(CO, account.id, {
      autoRecord: "all",
      notetakerEmployeeId: employee.id,
    });

    const grants = await grantsFor(employee.id);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].accountId, account.id);
    assert.equal(grants[0].accessLevel, "record");
  });

  test("an employee that could only read the calendar is upgraded, not duplicated", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    await insert(EmployeeCalendarGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "read",
    });

    await updateCalendarAccount(CO, account.id, { notetakerEmployeeId: employee.id });

    const grants = await grantsFor(employee.id);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].accessLevel, "record");
  });

  test("an employee that already holds Record is left exactly as it was", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    const before = await insert(EmployeeCalendarGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "record",
    });

    await updateCalendarAccount(CO, account.id, { notetakerEmployeeId: employee.id });

    const grants = await grantsFor(employee.id);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].id, before.id);
  });

  test("the grant is per calendar — a second calendar does not inherit the first", async () => {
    const employee = await anEmployee();
    const [sales, support] = await Promise.all([aCalendar(), aCalendar()]);

    await updateCalendarAccount(CO, sales.id, { notetakerEmployeeId: employee.id });

    const grants = await grantsFor(employee.id);
    assert.deepEqual(
      grants.map((row) => row.accountId),
      [sales.id],
    );
    assert.equal(
      await AppDataSource.getRepository(EmployeeCalendarGrant).countBy({ accountId: support.id }),
      0,
    );
  });

  test("un-assigning the notetaker revokes nothing a human may have granted", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    await updateCalendarAccount(CO, account.id, { notetakerEmployeeId: employee.id });

    await updateCalendarAccount(CO, account.id, { notetakerEmployeeId: null });

    const grants = await grantsFor(employee.id);
    assert.equal(grants.length, 1, "authority is withdrawn on the AI access page, not by a side effect");
    assert.equal((await reload(account)).notetakerEmployeeId, null);
  });

  test("an employee from another company is refused, and nothing is written", async () => {
    const [stranger, account] = await Promise.all([anEmployee(OTHER_CO, "Rook"), aCalendar()]);

    await assert.rejects(
      updateCalendarAccount(CO, account.id, {
        autoRecord: "all",
        notetakerEmployeeId: stranger.id,
      }),
      /not in this company/,
    );

    assert.equal(await AppDataSource.getRepository(EmployeeCalendarGrant).count(), 0);
    assert.equal((await reload(account)).notetakerEmployeeId, null);
    assert.equal((await reload(account)).autoRecord, "off");
  });

  test("a calendar in another company is never touched", async () => {
    const [employee, theirs] = await Promise.all([anEmployee(), aCalendar(OTHER_CO)]);

    assert.equal(await updateCalendarAccount(CO, theirs.id, { autoRecord: "all" }), null);
    assert.equal(await ensureNotetakerCanRecord(CO, theirs.id, employee.id), null);
    assert.equal(await AppDataSource.getRepository(EmployeeCalendarGrant).count(), 0);
  });

  test("ensureNotetakerCanRecord refuses an employee that no longer exists", async () => {
    const account = await aCalendar();
    assert.equal(
      await ensureNotetakerCanRecord(CO, account.id, "00000000-0000-4000-8000-0000000000ff"),
      null,
    );
    assert.equal(await AppDataSource.getRepository(EmployeeCalendarGrant).count(), 0);
  });
});

describe("the notetaker actually joins after an ordinary setup", () => {
  /**
   * The regression, stated as the user reported it: connect a calendar, turn
   * automatic recording on, pick an employee — and the notetaker joins. No
   * grant row is written by this test; if one is needed, the product has to
   * have made it.
   */
  test("connect → record automatically → pick a notetaker → the guest joins the call", async () => {
    const now = new Date();
    const joined: string[] = [];
    registerMeetingRecorder(recordingRecorder(joined));
    setMeetingBackgroundProcessor(() => undefined);

    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    await anEvent(account, now);

    await updateCalendarAccount(CO, account.id, {
      autoRecord: "all",
      notetakerEmployeeId: employee.id,
    });

    const armed = await armMeetingsForAccount(await reload(account), now);
    assert.equal(armed, 1, "the calendar arms the meeting");

    const dispatch = await dispatchDueMeetings(now);
    assert.equal(dispatch.due, 1);
    assert.equal(dispatch.claimed, 1);

    const meeting = await waitFor(
      () => AppDataSource.getRepository(Meeting).findOneByOrFail({ companyId: CO }),
      (row) => row.status === "processing",
    );
    assert.deepEqual(joined, [meeting.id]);
    assert.equal(meeting.recordingSource, "notetaker");
    assert.equal(meeting.statusMessage, "");
  });

  test("revoking the Grant still stops the join, and says so on the meeting", async () => {
    const now = new Date();
    const joined: string[] = [];
    registerMeetingRecorder(recordingRecorder(joined));

    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    await anEvent(account, now);
    await updateCalendarAccount(CO, account.id, {
      autoRecord: "all",
      notetakerEmployeeId: employee.id,
    });
    await armMeetingsForAccount(await reload(account), now);

    // What the AI access page does when somebody takes the authority back.
    await AppDataSource.getRepository(EmployeeCalendarGrant).delete({ employeeId: employee.id });

    await dispatchDueMeetings(now);

    const meeting = await waitFor(
      () => AppDataSource.getRepository(Meeting).findOneByOrFail({ companyId: CO }),
      (row) => row.status === "skipped",
    );
    assert.deepEqual(joined, [], "authority is re-checked at join time, not trusted from arming");
    assert.match(meeting.statusMessage, /does not have Record access/);
  });
});

describe("an ad-hoc meeting knows what it is a link to", () => {
  test("a Meet link makes the meeting joinable rather than an unnamed row", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Acme intro",
      scheduledStartAt: null,
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      notetakerEmployeeId: null,
      createdByUserId: null,
    });
    assert.equal(meeting.conferenceProvider, "meet");
  });

  test("a link we cannot name is still a call", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Jitsi standup",
      scheduledStartAt: null,
      conferenceUrl: "https://meet.northwind.test/standup",
      notetakerEmployeeId: null,
      createdByUserId: null,
    });
    assert.equal(meeting.conferenceProvider, "other");
  });

  test("a Zoom link is named Zoom, not offered to the Meet notetaker", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Acme on Zoom",
      scheduledStartAt: null,
      conferenceUrl: "https://northwind.zoom.us/j/123456",
      notetakerEmployeeId: null,
      createdByUserId: null,
    });
    assert.equal(meeting.conferenceProvider, "zoom");
  });

  test("no link at all stays `none`", async () => {
    const meeting = await createAdHocMeeting({
      companyId: CO,
      title: "Recording from yesterday",
      scheduledStartAt: null,
      conferenceUrl: "",
      notetakerEmployeeId: null,
      createdByUserId: null,
    });
    assert.equal(meeting.conferenceProvider, "none");
  });
});
