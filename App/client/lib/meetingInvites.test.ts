import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { MailAccount } from "./mail.js";
import { pickMailAccount } from "./mailAccountChoice.js";
import {
  agendaDateParam,
  agendaEventPath,
  attendeeEmailDraft,
  attendeeName,
  attendeeRecipients,
  rsvpCounts,
  rsvpOf,
} from "./meetings.js";

/**
 * Who an email to a meeting's attendees goes to, what it starts with, and
 * where the agenda links point — the decisions behind "Email attendees".
 */

const guest = (email: string, responseStatus: string) => ({ email, responseStatus });

describe("replies", () => {
  test("reads every reply Google sends, and treats anything else as unknown", () => {
    assert.equal(rsvpOf("accepted"), "accepted");
    assert.equal(rsvpOf("declined"), "declined");
    assert.equal(rsvpOf("tentative"), "tentative");
    assert.equal(rsvpOf("needsAction"), "awaiting");
    assert.equal(rsvpOf(""), "unknown");
    assert.equal(rsvpOf("something-new"), "unknown");
  });

  test("counts each kind of reply", () => {
    assert.deepEqual(
      rsvpCounts([
        guest("a@x.test", "accepted"),
        guest("b@x.test", "accepted"),
        guest("c@x.test", "needsAction"),
        guest("d@x.test", "declined"),
        guest("e@x.test", ""),
      ]),
      { accepted: 2, tentative: 0, awaiting: 1, declined: 1, unknown: 1 },
    );
  });

  test("names an attendee by the invite, then the Contact, then the address", () => {
    assert.equal(attendeeName({ email: "s@x.test", displayName: "Sam", contactName: "S" }), "Sam");
    assert.equal(
      attendeeName({ email: "s@x.test", displayName: "", contactName: "Sam R" }),
      "Sam R",
    );
    assert.equal(attendeeName({ email: "s@x.test", displayName: "" }), "s@x.test");
  });
});

describe("who an email to attendees goes to", () => {
  const invite = [
    guest("me@ourco.test", "accepted"),
    guest("Sam@Acme.test", "accepted"),
    guest("priya@acme.test", "tentative"),
    guest("lee@acme.test", "needsAction"),
    guest("kim@acme.test", "declined"),
    guest("new@acme.test", ""),
    guest("sam@acme.test", "accepted"),
  ];

  test("everyone invited, less the calendar's own address and repeats", () => {
    assert.deepEqual(attendeeRecipients(invite, "everyone", ["ME@ourco.test"]), [
      "sam@acme.test",
      "priya@acme.test",
      "lee@acme.test",
      "kim@acme.test",
      "new@acme.test",
    ]);
  });

  test("who is coming: accepted or maybe", () => {
    assert.deepEqual(attendeeRecipients(invite, "coming", ["me@ourco.test"]), [
      "sam@acme.test",
      "priya@acme.test",
    ]);
  });

  test("who hasn't replied, including anyone with no reply on file", () => {
    assert.deepEqual(attendeeRecipients(invite, "awaiting", ["me@ourco.test"]), [
      "lee@acme.test",
      "new@acme.test",
    ]);
  });
});

describe("the email's first draft", () => {
  test("keeps the meeting's title, time and join link under the message", () => {
    const draft = attendeeEmailDraft({
      title: "  Quarterly review ",
      startAt: "2026-08-03T10:00:00.000Z",
      endAt: "2026-08-03T11:00:00.000Z",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      location: "Room 4",
    });

    assert.equal(draft.subject, "Quarterly review");
    assert.match(draft.bodyText, /^Hi all,\n\n/);
    assert.match(
      draft.bodyText,
      /Quarterly review\n.+ · .+ – .+\nJoin: https:\/\/meet\.google\.com\/abc-defg-hij\n$/,
    );
    assert.doesNotMatch(draft.bodyText, /Room 4/);
  });

  test("names the place when there is no call, and copes with no title or time", () => {
    const draft = attendeeEmailDraft({
      title: "",
      startAt: null,
      endAt: null,
      conferenceUrl: "",
      location: "Room 4",
    });

    assert.equal(draft.subject, "Our meeting");
    assert.match(draft.bodyText, /Our meeting\nWhere: Room 4\n$/);
  });

  test("says all day for an all-day event", () => {
    const draft = attendeeEmailDraft({
      title: "Offsite",
      startAt: "2026-08-03T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z",
      allDay: true,
      conferenceUrl: "",
    });

    assert.match(draft.bodyText, /· All day\n/);
  });
});

describe("links to the agenda", () => {
  test("open the week the event falls in, with the event open", () => {
    const start = new Date(2026, 7, 3, 10, 0);
    assert.equal(agendaDateParam(start), "2026-08-03");
    assert.equal(
      agendaEventPath("acme", "evt-1", start.toISOString()),
      "/c/acme/meetings?date=2026-08-03&event=evt-1",
    );
  });
});

describe("the mailbox a message goes from", () => {
  const box = (id: string, status: MailAccount["status"]) => ({ id, status }) as MailAccount;

  test("is the one last used, when it still exists", () => {
    const boxes = [box("a", "active"), box("b", "active")];
    assert.equal(pickMailAccount(boxes, "b")?.id, "b");
    assert.equal(pickMailAccount(boxes, "gone")?.id, "a");
  });

  test("prefers a working mailbox to a paused one", () => {
    assert.equal(pickMailAccount([box("a", "paused"), box("b", "active")], null)?.id, "b");
    assert.equal(pickMailAccount([box("a", "error")], null)?.id, "a");
    assert.equal(pickMailAccount([], null), null);
  });
});
