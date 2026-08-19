import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingTranscriptSegment } from "../../db/entities/MeetingTranscriptSegment.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { attachTranscript, startNotetaker, NO_RECORDER_MESSAGE } from "./recorder.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_recorder";

async function blankMeeting(over: Partial<Meeting> = {}): Promise<Meeting> {
  return insert(Meeting, { companyId: CO, title: "A call", status: "scheduled", ...over });
}

describe("attachTranscript", () => {
  /**
   * Regression: `attachTranscript` used to load the meeting, call
   * `replaceTranscript` (which writes `transcriptText` straight to the row),
   * then `save()` the entity it had loaded *before* that — writing the stale
   * empty string back over the transcript. The segments survived, so the page
   * showed the transcript while the pipeline reported "no transcript" and
   * failed the meeting.
   */
  test("leaves transcriptText on the row, not the stale empty copy", async () => {
    const meeting = await blankMeeting();
    const result = await attachTranscript({
      companyId: CO,
      meetingId: meeting.id,
      text: "Sam: We need SSO.\nPat: I will send pricing.",
    });
    assert.equal(result.ok, true);

    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.ok(
      stored.transcriptText.includes("We need SSO"),
      `transcriptText was clobbered: ${JSON.stringify(stored.transcriptText)}`,
    );
    assert.equal(stored.transcriptState, "ready");
    assert.equal(stored.status, "processing");
    assert.equal(stored.recordingSource, "transcript");
    assert.ok(stored.endedAt);
  });

  test("stores one segment per line, with speakers", async () => {
    const meeting = await blankMeeting();
    await attachTranscript({
      companyId: CO,
      meetingId: meeting.id,
      text: "Sam: One.\nPat: Two.",
    });
    const segments = await AppDataSource.getRepository(MeetingTranscriptSegment).find({
      where: { meetingId: meeting.id },
      order: { sortOrder: "ASC" },
    });
    assert.deepEqual(
      segments.map((s) => [s.speaker, s.text]),
      [
        ["Sam", "One."],
        ["Pat", "Two."],
      ],
    );
  });

  test("re-pasting replaces rather than appends", async () => {
    const meeting = await blankMeeting();
    await attachTranscript({ companyId: CO, meetingId: meeting.id, text: "Sam: First take." });
    await attachTranscript({ companyId: CO, meetingId: meeting.id, text: "Sam: Second take." });

    const segments = await AppDataSource.getRepository(MeetingTranscriptSegment).find({
      where: { meetingId: meeting.id },
    });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, "Second take.");

    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.ok(stored.transcriptText.includes("Second take."));
    assert.ok(!stored.transcriptText.includes("First take."));
  });

  test("refuses an empty transcript and a missing meeting", async () => {
    const meeting = await blankMeeting();
    assert.deepEqual(await attachTranscript({ companyId: CO, meetingId: meeting.id, text: "  " }), {
      ok: false,
      error: "The transcript is empty.",
    });
    const missing = await attachTranscript({
      companyId: CO,
      meetingId: "00000000-0000-0000-0000-000000000000",
      text: "Sam: hi",
    });
    assert.equal(missing.ok, false);
  });

  test("does not reach across companies", async () => {
    const meeting = await blankMeeting();
    const result = await attachTranscript({
      companyId: "co_someone_else",
      meetingId: meeting.id,
      text: "Sam: hi",
    });
    assert.equal(result.ok, false);
  });
});

describe("startNotetaker", () => {
  test("with no recorder registered, fails with an actionable message", async () => {
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });
    const result = await startNotetaker({ companyId: CO, meetingId: meeting.id });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, NO_RECORDER_MESSAGE);

    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(stored.status, "failed");
    assert.equal(stored.statusMessage, NO_RECORDER_MESSAGE);
  });

  test("refuses a meeting with no conference link", async () => {
    const meeting = await blankMeeting();
    const result = await startNotetaker({ companyId: CO, meetingId: meeting.id });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /no conference link/i);
  });
});
