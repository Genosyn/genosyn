import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { Contact } from "../../db/entities/Contact.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { inviteList, listAgendaEvents } from "./agenda.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_agenda";
const OTHER_CO = "co_elsewhere";
const WINDOW = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-08T00:00:00.000Z"),
};

async function calendar(companyId = CO): Promise<CalendarAccount> {
  return insert(CalendarAccount, {
    companyId,
    connectionId: `conn-${companyId}`,
    calendarId: "primary",
    address: "me@ourco.test",
  });
}

async function event(
  account: CalendarAccount,
  over: Partial<CalendarEvent> & { attendees?: unknown[] } = {},
): Promise<CalendarEvent> {
  const { attendees = [], ...rest } = over;
  return insert(CalendarEvent, {
    companyId: account.companyId,
    accountId: account.id,
    externalId: `evt-${Math.random()}`,
    summary: "Intro",
    startAt: new Date("2026-08-03T10:00:00.000Z"),
    endAt: new Date("2026-08-03T11:00:00.000Z"),
    status: "confirmed",
    organizerEmail: "me@ourco.test",
    attendeesJson: JSON.stringify(attendees),
    ...rest,
  });
}

const guest = (email: string, responseStatus: string, organizer = false) => ({
  email,
  displayName: "",
  responseStatus,
  organizer,
  optional: false,
});

describe("the agenda", () => {
  test("keeps every attendee's address and reply", async () => {
    const account = await calendar();
    await event(account, {
      attendees: [
        guest("me@ourco.test", "accepted", true),
        guest("sam@acme.test", "declined"),
        guest("priya@acme.test", "needsAction"),
      ],
    });

    const [row] = await listAgendaEvents(CO, WINDOW);

    assert.deepEqual(
      row.attendees.map((a) => [a.email, a.responseStatus, a.organizer]),
      [
        ["me@ourco.test", "accepted", true],
        ["sam@acme.test", "declined", false],
        ["priya@acme.test", "needsAction", false],
      ],
    );
  });

  test("names attendees who are Contacts, and only this company's", async () => {
    const account = await calendar();
    await event(account, { attendees: [guest("sam@acme.test", "accepted")] });
    const sam = await insert(Contact, {
      companyId: CO,
      name: "Sam Rivera",
      email: "sam@acme.test",
    });
    await insert(Contact, { companyId: OTHER_CO, name: "Not ours", email: "priya@acme.test" });
    await event(account, { attendees: [guest("priya@acme.test", "accepted")] });

    const rows = await listAgendaEvents(CO, WINDOW);
    const attendees = rows.flatMap((row) => row.attendees);

    const samRow = attendees.find((a) => a.email === "sam@acme.test");
    assert.equal(samRow?.contactId, sam.id);
    assert.equal(samRow?.contactName, "Sam Rivera");
    const priyaRow = attendees.find((a) => a.email === "priya@acme.test");
    assert.equal(priyaRow?.contactId, null);
    assert.equal(priyaRow?.contactName, "");
  });

  test("points an event at the Meeting Genosyn keeps for it", async () => {
    const account = await calendar();
    const recorded = await event(account, { summary: "Recorded" });
    await event(account, {
      summary: "Plain",
      startAt: new Date("2026-08-04T10:00:00.000Z"),
      endAt: new Date("2026-08-04T11:00:00.000Z"),
    });
    const meeting = await insert(Meeting, {
      companyId: CO,
      calendarEventId: recorded.id,
      title: "Recorded",
      status: "ready",
    });

    const rows = await listAgendaEvents(CO, WINDOW);

    assert.deepEqual(
      rows.map((row) => [row.summary, row.meeting]),
      [
        ["Recorded", { id: meeting.id, status: "ready" }],
        ["Plain", null],
      ],
    );
  });

  test("leaves out cancelled events, other windows and other companies", async () => {
    const account = await calendar();
    const elsewhere = await calendar(OTHER_CO);
    await event(account, { summary: "Kept" });
    await event(account, { summary: "Cancelled", status: "cancelled" });
    await event(account, {
      summary: "Next month",
      startAt: new Date("2026-09-03T10:00:00.000Z"),
      endAt: new Date("2026-09-03T11:00:00.000Z"),
    });
    await event(elsewhere, { summary: "Theirs" });

    const rows = await listAgendaEvents(CO, WINDOW);

    assert.deepEqual(
      rows.map((row) => row.summary),
      ["Kept"],
    );
  });
});

describe("the invite list", () => {
  test("adds back an organizer Google left out, with no reply invented", () => {
    const list = inviteList([guest("sam@acme.test", "accepted")], "Boss@OurCo.test", "The Boss");

    assert.deepEqual(list[0], {
      email: "boss@ourco.test",
      displayName: "The Boss",
      responseStatus: "",
      organizer: true,
      optional: false,
    });
    assert.equal(list.length, 2);
  });

  test("does not repeat an organizer already listed", () => {
    const attendees = [guest("boss@ourco.test", "accepted", true), guest("sam@acme.test", "")];

    assert.equal(inviteList(attendees, "boss@ourco.test", "The Boss"), attendees);
  });

  test("gives a block on someone's own calendar no attendees", () => {
    assert.deepEqual(inviteList([], "me@ourco.test", "Me"), []);
  });
});
