import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isFreeMailDomain, isInternalAddress } from "./domains.js";
import { shouldAutoRecord } from "./store.js";
import { parseTranscriptText } from "./recorder.js";
import { parseTranscriptionResponse } from "./transcribe.js";
import { parseDueDate, parseWriteUp } from "./followUps.js";

/**
 * The auto-record policy is the one decision in this milestone with
 * consequences for people who never agreed to anything, so every refusal it
 * makes is asserted here rather than left to the UI to imply.
 */
const EVENT = {
  status: "confirmed" as const,
  allDay: false,
  conferenceProvider: "meet" as const,
  conferenceUrl: "https://meet.google.com/a-b-c",
  attendeesJson: JSON.stringify([
    {
      email: "me@acme.test",
      displayName: "",
      responseStatus: "",
      organizer: true,
      optional: false,
    },
    {
      email: "buyer@customer.test",
      displayName: "",
      responseStatus: "",
      organizer: false,
      optional: false,
    },
  ]),
  organizerEmail: "me@acme.test",
};

const ARMED = { autoRecord: "external" as const, notetakerEmployeeId: "emp_1" };
const OURS = new Set(["acme.test"]);

describe("shouldAutoRecord", () => {
  test("arms for a meeting with an outside attendee", () => {
    assert.equal(shouldAutoRecord({ account: ARMED, event: EVENT, domains: OURS }), true);
  });

  test("refuses when the calendar is not opted in", () => {
    assert.equal(
      shouldAutoRecord({
        account: { autoRecord: "off", notetakerEmployeeId: "emp_1" },
        event: EVENT,
        domains: OURS,
      }),
      false,
    );
  });

  test("refuses without a notetaker — a recording nobody reads is just surveillance", () => {
    assert.equal(
      shouldAutoRecord({
        account: { autoRecord: "all", notetakerEmployeeId: null },
        event: EVENT,
        domains: OURS,
      }),
      false,
    );
  });

  test("refuses an internal-only meeting under `external`", () => {
    const internal = {
      ...EVENT,
      attendeesJson: JSON.stringify([
        {
          email: "me@acme.test",
          displayName: "",
          responseStatus: "",
          organizer: true,
          optional: false,
        },
        {
          email: "pat@acme.test",
          displayName: "",
          responseStatus: "",
          organizer: false,
          optional: false,
        },
      ]),
    };
    assert.equal(shouldAutoRecord({ account: ARMED, event: internal, domains: OURS }), false);
  });

  test("`all` records that same internal meeting", () => {
    const internal = {
      ...EVENT,
      attendeesJson: JSON.stringify([
        {
          email: "me@acme.test",
          displayName: "",
          responseStatus: "",
          organizer: true,
          optional: false,
        },
      ]),
    };
    assert.equal(
      shouldAutoRecord({
        account: { autoRecord: "all", notetakerEmployeeId: "emp_1" },
        event: internal,
        domains: OURS,
      }),
      true,
    );
  });

  test("refuses `external` when we do not know our own domains", () => {
    // Every attendee would read as external and the recorder would arm for the
    // whole calendar. Refusing is the only safe reading of "we cannot tell".
    assert.equal(shouldAutoRecord({ account: ARMED, event: EVENT, domains: new Set() }), false);
  });

  test("refuses a cancelled event, an all-day event, and one with no link", () => {
    assert.equal(
      shouldAutoRecord({ account: ARMED, event: { ...EVENT, status: "cancelled" }, domains: OURS }),
      false,
    );
    assert.equal(
      shouldAutoRecord({ account: ARMED, event: { ...EVENT, allDay: true }, domains: OURS }),
      false,
    );
    assert.equal(
      shouldAutoRecord({
        account: ARMED,
        event: { ...EVENT, conferenceProvider: "none", conferenceUrl: "" },
        domains: OURS,
      }),
      false,
    );
  });

  test("refuses conference providers the built-in recorder cannot join", () => {
    for (const conferenceProvider of ["zoom", "teams", "webex", "other"] as const) {
      assert.equal(
        shouldAutoRecord({
          account: { autoRecord: "all", notetakerEmployeeId: "emp_1" },
          event: {
            ...EVENT,
            conferenceProvider,
            conferenceUrl: `https://${conferenceProvider}.example.test/room`,
          },
          domains: OURS,
        }),
        false,
      );
    }
  });
});

describe("internal-address detection", () => {
  test("free mail is never a company domain", () => {
    assert.equal(isFreeMailDomain("gmail.com"), true);
    assert.equal(isFreeMailDomain("acme.test"), false);
  });

  test("matches on the domain, case-insensitively", () => {
    assert.equal(isInternalAddress("Pat@Acme.test", OURS), true);
    assert.equal(isInternalAddress("pat@other.test", OURS), false);
    assert.equal(isInternalAddress("not-an-address", OURS), false);
  });
});

describe("parseTranscriptText", () => {
  test("splits `Speaker: words`", () => {
    const out = parseTranscriptText("Priya: Thanks for the time.\nSam: Of course.");
    assert.deepEqual(
      out.map((s) => [s.speaker, s.text]),
      [
        ["Priya", "Thanks for the time."],
        ["Sam", "Of course."],
      ],
    );
  });

  test("tolerates a leading timestamp", () => {
    const out = parseTranscriptText("[00:01:12] Priya: Let us begin.");
    assert.deepEqual([out[0].speaker, out[0].text], ["Priya", "Let us begin."]);
  });

  test("does not invent a speaker out of a sentence that happens to contain a colon", () => {
    const out = parseTranscriptText("so the thing about the price is that it depends: on volume");
    assert.equal(out[0].speaker, "");
    assert.equal(out[0].text, "so the thing about the price is that it depends: on volume");
  });

  test("blank lines are dropped", () => {
    assert.equal(parseTranscriptText("\n\n  \n").length, 0);
  });
});

describe("parseTranscriptionResponse", () => {
  test("reads verbose_json segments, converting seconds to ms", () => {
    const out = parseTranscriptionResponse({
      segments: [{ start: 1.5, end: 3.25, text: " hello " }],
    });
    assert.deepEqual(out, [{ startMs: 1500, endMs: 3250, speaker: "", text: "hello" }]);
  });

  test("a server that returns only `text` still yields a usable transcript", () => {
    const out = parseTranscriptionResponse({ text: "one long block" });
    assert.deepEqual(out, [{ startMs: 0, endMs: 0, speaker: "", text: "one long block" }]);
  });

  test("empty and malformed payloads yield nothing rather than throwing", () => {
    assert.deepEqual(parseTranscriptionResponse({}), []);
    assert.deepEqual(parseTranscriptionResponse(null), []);
    assert.deepEqual(parseTranscriptionResponse({ segments: [{ text: "  " }] }), []);
  });
});

describe("parseWriteUp", () => {
  test("pulls JSON out of a fenced, prefixed reply", () => {
    const out = parseWriteUp(
      'Here you go:\n```json\n{"summary":"They want SSO.","actionItems":[{"title":"Send SSO pricing","dueDate":"2026-09-01","owner":"us"}]}\n```',
    );
    assert.equal(out?.summary, "They want SSO.");
    assert.equal(out?.actionItems.length, 1);
    assert.equal(out?.actionItems[0].title, "Send SSO pricing");
  });

  test("an empty action list is a valid answer", () => {
    const out = parseWriteUp('{"summary":"Casual catch-up.","actionItems":[]}');
    assert.equal(out?.actionItems.length, 0);
  });

  test("items with no title are dropped, not guessed at", () => {
    const out = parseWriteUp('{"summary":"x","actionItems":[{"title":"  "},{"title":"real"}]}');
    assert.deepEqual(
      out?.actionItems.map((i) => i.title),
      ["real"],
    );
  });

  test("unparseable output degrades to null rather than failing the meeting", () => {
    assert.equal(parseWriteUp("I could not do that."), null);
    assert.equal(parseWriteUp("{not json}"), null);
  });

  test("caps the action list so a model cannot invent a backlog", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ title: `t${i}` }));
    const out = parseWriteUp(JSON.stringify({ summary: "s", actionItems: many }));
    assert.equal(out?.actionItems.length, 10);
  });
});

describe("parseDueDate", () => {
  test("reads a plain date at UTC noon so a timezone shift cannot move the day", () => {
    assert.equal(parseDueDate("2026-09-01")?.toISOString(), "2026-09-01T12:00:00.000Z");
  });

  test("refuses anything that is not YYYY-MM-DD", () => {
    assert.equal(parseDueDate(""), null);
    assert.equal(parseDueDate("next Tuesday"), null);
    assert.equal(parseDueDate("2026-13-45"), null);
  });
});
