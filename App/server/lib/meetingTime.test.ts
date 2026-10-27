import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addMinutesToLocal,
  formatMeetingRange,
  isMeetingTimeZone,
  meetingTitleFromSubject,
  parseLocalDateTime,
  supportedTimeZones,
  timeZoneCity,
  timeZoneShortName,
  utcToZonedLocal,
  zoneOffsetMinutes,
  zonedLocalToUtc,
} from "../../shared/meetingTime.js";

/**
 * Wall-clock time in a named zone, the arithmetic every meeting scheduled from
 * an email depends on. A mistake here is a meeting an hour off for one side of
 * the call, so the daylight-saving edges are pinned explicitly.
 */

describe("isMeetingTimeZone", () => {
  test("accepts IANA zones the runtime knows", () => {
    assert.equal(isMeetingTimeZone("Europe/Berlin"), true);
    assert.equal(isMeetingTimeZone("America/New_York"), true);
    assert.equal(isMeetingTimeZone("UTC"), true);
  });

  test("refuses fixed offsets, junk and non-strings", () => {
    assert.equal(isMeetingTimeZone("+01:00"), false);
    assert.equal(isMeetingTimeZone("Mars/Olympus_Mons"), false);
    assert.equal(isMeetingTimeZone(""), false);
    assert.equal(isMeetingTimeZone(undefined), false);
    assert.equal(isMeetingTimeZone(42), false);
    assert.equal(isMeetingTimeZone("Europe/Berlin; DROP TABLE"), false);
  });
});

describe("parseLocalDateTime", () => {
  test("reads a wall time", () => {
    assert.deepEqual(parseLocalDateTime("2026-10-28T15:30"), {
      year: 2026,
      month: 10,
      day: 28,
      hour: 15,
      minute: 30,
    });
  });

  test("refuses days and hours that do not exist", () => {
    assert.equal(parseLocalDateTime("2026-02-30T10:00"), null);
    assert.equal(parseLocalDateTime("2026-13-01T10:00"), null);
    assert.equal(parseLocalDateTime("2026-10-28T24:00"), null);
    assert.equal(parseLocalDateTime("2026-10-28T10:60"), null);
    assert.equal(parseLocalDateTime("2026-10-28 10:00"), null);
    assert.equal(parseLocalDateTime("2026-10-28T10:00:00"), null);
  });
});

describe("zonedLocalToUtc", () => {
  test("converts a wall time in winter and summer", () => {
    // Berlin is UTC+1 in winter and UTC+2 in summer.
    assert.equal(
      zonedLocalToUtc("2026-01-15T15:00", "Europe/Berlin")?.toISOString(),
      "2026-01-15T14:00:00.000Z",
    );
    assert.equal(
      zonedLocalToUtc("2026-07-15T15:00", "Europe/Berlin")?.toISOString(),
      "2026-07-15T13:00:00.000Z",
    );
    // New York is UTC-5 / UTC-4.
    assert.equal(
      zonedLocalToUtc("2026-01-15T09:00", "America/New_York")?.toISOString(),
      "2026-01-15T14:00:00.000Z",
    );
    assert.equal(
      zonedLocalToUtc("2026-07-15T09:00", "America/New_York")?.toISOString(),
      "2026-07-15T13:00:00.000Z",
    );
    assert.equal(
      zonedLocalToUtc("2026-07-15T09:00", "UTC")?.toISOString(),
      "2026-07-15T09:00:00.000Z",
    );
  });

  test("handles the weeks Europe and America change clocks on different days", () => {
    // 2026-03-10: New York is already on EDT (-4), Berlin still on CET (+1).
    assert.equal(
      zonedLocalToUtc("2026-03-10T10:00", "America/New_York")?.toISOString(),
      "2026-03-10T14:00:00.000Z",
    );
    assert.equal(
      zonedLocalToUtc("2026-03-10T15:00", "Europe/Berlin")?.toISOString(),
      "2026-03-10T14:00:00.000Z",
    );
  });

  test("handles half-hour zones", () => {
    assert.equal(
      zonedLocalToUtc("2026-10-28T15:00", "Asia/Kolkata")?.toISOString(),
      "2026-10-28T09:30:00.000Z",
    );
  });

  test("lands a time inside the spring-forward gap just after it", () => {
    // 2026-03-29 02:30 does not exist in Berlin; clocks jump 02:00 → 03:00.
    const instant = zonedLocalToUtc("2026-03-29T02:30", "Europe/Berlin");
    assert.ok(instant);
    assert.equal(utcToZonedLocal(instant, "Europe/Berlin").slice(0, 10), "2026-03-29");
    assert.ok(["01:30", "03:30"].includes(utcToZonedLocal(instant, "Europe/Berlin").slice(11)));
  });

  test("refuses bad input rather than guessing", () => {
    assert.equal(zonedLocalToUtc("tomorrow at 3", "Europe/Berlin"), null);
    assert.equal(zonedLocalToUtc("2026-10-28T15:00", "CET+1"), null);
  });
});

describe("utcToZonedLocal and zoneOffsetMinutes", () => {
  test("round-trips through the zone", () => {
    for (const zone of [
      "Europe/Berlin",
      "America/Los_Angeles",
      "Asia/Tokyo",
      "Australia/Adelaide",
    ]) {
      for (const local of ["2026-01-05T08:15", "2026-06-30T23:45", "2026-10-28T00:00"]) {
        const instant = zonedLocalToUtc(local, zone);
        assert.ok(instant, `${local} ${zone}`);
        assert.equal(utcToZonedLocal(instant, zone), local, `${local} ${zone}`);
      }
    }
  });

  test("reports offsets in minutes ahead of UTC", () => {
    assert.equal(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin"), 60);
    assert.equal(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York"), -240);
    assert.equal(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata"), 330);
  });
});

describe("addMinutesToLocal", () => {
  test("adds across midnight", () => {
    assert.equal(addMinutesToLocal("2026-10-28T23:30", 60, "Europe/Berlin"), "2026-10-29T00:30");
  });

  test("keeps real elapsed time across the autumn change", () => {
    // Berlin falls back on 2026-10-25 at 03:00 → 02:00, so two real hours
    // after 01:30 read as 02:30 on the wall.
    assert.equal(addMinutesToLocal("2026-10-25T01:30", 120, "Europe/Berlin"), "2026-10-25T02:30");
  });
});

describe("formatting", () => {
  test("names the zone beside the slot", () => {
    const start = new Date("2026-10-28T14:00:00Z");
    const end = new Date("2026-10-28T14:30:00Z");
    const text = formatMeetingRange(start, end, "Europe/Berlin", "en-US");
    assert.match(text, /Wed, Oct 28/);
    assert.match(text, /3:00/);
    assert.match(text, /3:30/);
    assert.match(text, /GMT\+1|CET/);
  });

  test("short names and cities", () => {
    assert.match(
      timeZoneShortName("America/New_York", new Date("2026-07-01T12:00:00Z"), "en-US"),
      /EDT|GMT-4/,
    );
    assert.equal(timeZoneCity("America/Argentina/Buenos_Aires"), "Buenos Aires");
    assert.equal(timeZoneCity("UTC"), "UTC");
  });

  test("offers UTC among the zones", () => {
    const zones = supportedTimeZones();
    assert.ok(zones.includes("UTC"));
    assert.ok(zones.includes("Europe/Berlin"));
  });
});

describe("meetingTitleFromSubject", () => {
  test("drops reply and forward prefixes, however many", () => {
    assert.equal(meetingTitleFromSubject("Re: Re: Fwd: Pricing call"), "Pricing call");
    assert.equal(meetingTitleFromSubject("RE[2]: Onboarding"), "Onboarding");
    assert.equal(meetingTitleFromSubject("AW: Termin nächste Woche"), "Termin nächste Woche");
    assert.equal(meetingTitleFromSubject("Renewal timeline"), "Renewal timeline");
    assert.equal(meetingTitleFromSubject("  "), "");
  });
});
