import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  durationLabel,
  inviteConfirmationText,
  isMeetingDuration,
  joinLocal,
  type MeetingProposal,
  meetingInstants,
  overlapsBusy,
  proposalFromAnalysis,
  splitLocal,
  suggestedStart,
  timeZoneOptionLabel,
  viewerSlot,
} from "./mailMeetings.js";

const baseProposal: MeetingProposal = {
  title: "Pricing call",
  attendees: [
    { email: "felix@assense.com", name: "Felix Menzel" },
    { email: "dana@assense.com", name: "" },
  ],
  start: null,
  timeZone: "Europe/Berlin",
  durationMinutes: 30,
  description: "",
  evidence: null,
  alternatives: [],
  confidence: "none",
};

describe("splitLocal / joinLocal", () => {
  test("splits a wall time into the form's two inputs and back", () => {
    assert.deepEqual(splitLocal("2026-10-28T15:30"), { date: "2026-10-28", time: "15:30" });
    assert.equal(joinLocal("2026-10-28", "15:30"), "2026-10-28T15:30");
  });

  test("an incomplete or impossible input is no time at all", () => {
    assert.deepEqual(splitLocal(null), { date: "", time: "" });
    assert.deepEqual(splitLocal("garbage"), { date: "", time: "" });
    assert.equal(joinLocal("2026-10-28", ""), null);
    assert.equal(joinLocal("", "15:00"), null);
    assert.equal(joinLocal("2026-02-30", "15:00"), null);
  });
});

describe("suggestedStart", () => {
  test("rounds up to the next half hour, an hour out, during working hours", () => {
    // Wed 2026-10-28 10:10 in Berlin (09:10 UTC) → 11:30 is the first slot an hour out.
    assert.equal(
      suggestedStart(new Date("2026-10-28T09:10:00Z"), "Europe/Berlin"),
      "2026-10-28T11:30",
    );
  });

  test("before the working day starts, offers 10 AM that day", () => {
    // Wed 06:00 Berlin.
    assert.equal(
      suggestedStart(new Date("2026-10-28T05:00:00Z"), "Europe/Berlin"),
      "2026-10-28T10:00",
    );
  });

  test("after hours, offers 10 AM the next weekday", () => {
    // Wed 18:00 Berlin → Thu 10:00.
    assert.equal(
      suggestedStart(new Date("2026-10-28T17:00:00Z"), "Europe/Berlin"),
      "2026-10-29T10:00",
    );
    // Fri 18:00 Berlin → Mon 10:00.
    assert.equal(
      suggestedStart(new Date("2026-10-30T17:00:00Z"), "Europe/Berlin"),
      "2026-11-02T10:00",
    );
  });

  test("works in the meeting's zone, not the browser's", () => {
    // 2026-10-28 13:00 UTC is 09:00 in New York → 10:00 is the first half hour an hour out.
    assert.equal(
      suggestedStart(new Date("2026-10-28T13:00:00Z"), "America/New_York"),
      "2026-10-28T10:00",
    );
  });

  test("an unknown zone falls back to UTC rather than failing", () => {
    assert.match(suggestedStart(new Date("2026-10-28T09:10:00Z"), "Nowhere/Land"), /^2026-10-28T/);
  });
});

describe("meetingInstants", () => {
  test("turns the wall time and duration into instants", () => {
    const slot = meetingInstants("2026-10-28T15:00", 45, "Europe/Berlin");
    assert.equal(slot?.start.toISOString(), "2026-10-28T14:00:00.000Z");
    assert.equal(slot?.end.toISOString(), "2026-10-28T14:45:00.000Z");
  });

  test("is null while the form is incomplete", () => {
    assert.equal(meetingInstants(null, 30, "Europe/Berlin"), null);
    assert.equal(meetingInstants("2026-10-28T15:00", 30, "Not/AZone"), null);
  });
});

describe("durations", () => {
  test("labels", () => {
    assert.equal(durationLabel(15), "15 min");
    assert.equal(durationLabel(60), "1 hr");
    assert.equal(durationLabel(90), "1 hr 30 min");
  });

  test("bounds", () => {
    assert.equal(isMeetingDuration(30), true);
    assert.equal(isMeetingDuration(4), false);
    assert.equal(isMeetingDuration(721), false);
    assert.equal(isMeetingDuration(30.5), false);
  });
});

describe("viewerSlot", () => {
  test("shows the slot in the reader's own zone when it differs", () => {
    const slot = meetingInstants("2026-10-28T15:00", 30, "Europe/Berlin");
    assert.ok(slot);
    const mine = viewerSlot(slot, "Europe/Berlin", "America/New_York", "en-US");
    assert.ok(mine);
    assert.match(mine, /10:00/);
    assert.match(mine, /EDT|GMT-4/);
  });

  test("says nothing when the reader is in the meeting's zone", () => {
    const slot = meetingInstants("2026-10-28T15:00", 30, "Europe/Berlin");
    assert.ok(slot);
    assert.equal(viewerSlot(slot, "Europe/Berlin", "Europe/Berlin", "en-US"), null);
  });
});

describe("overlapsBusy", () => {
  const slot = { start: new Date("2026-10-28T14:00:00Z"), end: new Date("2026-10-28T14:30:00Z") };
  test("detects an overlap", () => {
    assert.equal(
      overlapsBusy([{ start: "2026-10-28T14:15:00Z", end: "2026-10-28T15:00:00Z" }], slot),
      true,
    );
  });
  test("back-to-back meetings do not conflict", () => {
    assert.equal(
      overlapsBusy([{ start: "2026-10-28T13:30:00Z", end: "2026-10-28T14:00:00Z" }], slot),
      false,
    );
    assert.equal(
      overlapsBusy([{ start: "2026-10-28T14:30:00Z", end: "2026-10-28T15:00:00Z" }], slot),
      false,
    );
    assert.equal(overlapsBusy([], slot), false);
  });
});

describe("inviteConfirmationText", () => {
  test("says when, in the meeting's zone, with the Meet link", () => {
    const text = inviteConfirmationText(
      {
        start: "2026-10-28T14:00:00.000Z",
        end: "2026-10-28T14:30:00.000Z",
        timeZone: "Europe/Berlin",
        meetLink: "https://meet.google.com/abc-defg-hij",
        invitesSent: true,
      },
      "en-US",
    );
    assert.match(text, /^I've sent a calendar invite for Wed, Oct 28/);
    assert.match(text, /3:00/);
    assert.match(text, /\nGoogle Meet: https:\/\/meet\.google\.com\/abc-defg-hij$/);
  });

  test("without invitations or a link it still names the slot", () => {
    const text = inviteConfirmationText(
      {
        start: "2026-10-28T14:00:00.000Z",
        end: "2026-10-28T14:30:00.000Z",
        timeZone: "UTC",
        meetLink: null,
        invitesSent: false,
      },
      "en-US",
    );
    assert.match(text, /^Let's meet Wed, Oct 28/);
    assert.ok(!text.includes("Google Meet"));
  });
});

describe("proposalFromAnalysis", () => {
  test("takes the verified fields the analysis button carries", () => {
    const merged = proposalFromAnalysis(
      {
        title: "Onboarding call",
        start: "2026-10-30T16:00",
        timeZone: "America/New_York",
        durationMinutes: 45,
        attendees: ["Felix@assense.com"],
      },
      baseProposal,
    );
    assert.equal(merged.title, "Onboarding call");
    assert.equal(merged.start, "2026-10-30T16:00");
    assert.equal(merged.timeZone, "America/New_York");
    assert.equal(merged.durationMinutes, 45);
    assert.deepEqual(merged.attendees, [{ email: "Felix@assense.com", name: "Felix Menzel" }]);
    assert.equal(merged.confidence, "proposed");
  });

  test("keeps the scheduler's own values where the button has none or bad ones", () => {
    const merged = proposalFromAnalysis(
      { start: "next tuesday", timeZone: "CET+1", durationMinutes: 9999, attendees: [] },
      baseProposal,
    );
    assert.equal(merged.title, "Pricing call");
    assert.equal(merged.start, null);
    assert.equal(merged.timeZone, "Europe/Berlin");
    assert.equal(merged.durationMinutes, 30);
    assert.deepEqual(merged.attendees, baseProposal.attendees);
    assert.equal(merged.confidence, "none");
  });
});

describe("timeZoneOptionLabel", () => {
  test("names the city and the zone's short name", () => {
    assert.match(
      timeZoneOptionLabel("America/New_York", new Date("2026-07-01T12:00:00Z"), "en-US"),
      /^New York \((EDT|GMT-4)\)$/,
    );
    assert.equal(timeZoneOptionLabel("UTC", new Date("2026-07-01T12:00:00Z"), "en-US"), "UTC");
  });
});
