import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingTranscriptSegment } from "../../db/entities/MeetingTranscriptSegment.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  abortAllActiveNotetakers,
  attachRecording,
  attachTranscript,
  checkActiveNotetakersNow,
  dispatchDueMeetings,
  type MeetingRecorder,
  NO_RECORDER_MESSAGE,
  recoverStaleNotetakers,
  registerMeetingRecorder,
  setActiveNotetakerLeaseHeldForTests,
  setMeetingBackgroundProcessor,
  shutdownMeetingNotetakers,
  startNotetaker,
  STOP_NOTETAKER_MESSAGE,
  stopNotetaker,
} from "./recorder.js";
import { readRecording } from "./storage.js";
import { armMeetingsForAccount } from "./store.js";

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

const CO = "co_recorder";
const EMPLOYEE_A = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_B = "00000000-0000-4000-8000-000000000002";

async function blankMeeting(over: Partial<Meeting> = {}): Promise<Meeting> {
  return insert(Meeting, { companyId: CO, title: "A call", status: "scheduled", ...over });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function installRecorder(
  join: MeetingRecorder["join"],
  canJoin: MeetingRecorder["canJoin"] = () => true,
): void {
  registerMeetingRecorder({ id: "notetaker", canJoin, join });
}

async function waitForMeeting(
  meetingId: string,
  predicate: (meeting: Meeting) => boolean,
): Promise<Meeting> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const meeting = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meetingId });
    if (predicate(meeting)) return meeting;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Meeting did not reach the expected state.");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not reached.");
}

async function calendarMeeting(args: {
  now: Date;
  meetingStartAt?: Date;
  eventStartAt?: Date;
  eventEndAt?: Date;
  eventStatus?: CalendarEvent["status"];
  autoRecord?: CalendarAccount["autoRecord"];
  accountEmployeeId?: string | null;
  meetingEmployeeId?: string | null;
  eventUrl?: string;
  meetingUrl?: string;
  grantEmployeeId?: string | null;
}): Promise<{ account: CalendarAccount; event: CalendarEvent; meeting: Meeting }> {
  const eventStartAt = args.eventStartAt ?? new Date(args.now.getTime() + 10_000);
  const eventEndAt = args.eventEndAt ?? new Date(args.now.getTime() + 60 * 60_000);
  const accountEmployeeId =
    args.accountEmployeeId === undefined ? EMPLOYEE_A : args.accountEmployeeId;
  const meetingEmployeeId =
    args.meetingEmployeeId === undefined ? EMPLOYEE_A : args.meetingEmployeeId;
  const account = await insert(CalendarAccount, {
    companyId: CO,
    connectionId: `connection-${Math.random()}`,
    calendarId: `calendar-${Math.random()}`,
    status: "active",
    autoRecord: args.autoRecord ?? "all",
    notetakerEmployeeId: accountEmployeeId,
  });
  const event = await insert(CalendarEvent, {
    companyId: CO,
    accountId: account.id,
    externalId: `event-${Math.random()}`,
    summary: "Current title",
    startAt: eventStartAt,
    endAt: eventEndAt,
    status: args.eventStatus ?? "confirmed",
    conferenceProvider: "meet",
    conferenceUrl: args.eventUrl ?? "https://meet.google.com/current-room",
  });
  const meeting = await blankMeeting({
    accountId: account.id,
    calendarEventId: event.id,
    scheduledStartAt: args.meetingStartAt ?? eventStartAt,
    scheduledEndAt: eventEndAt,
    conferenceProvider: "meet",
    conferenceUrl: args.meetingUrl ?? event.conferenceUrl,
    notetakerEmployeeId: meetingEmployeeId,
  });
  const grantEmployeeId =
    args.grantEmployeeId === undefined ? accountEmployeeId : args.grantEmployeeId;
  if (grantEmployeeId) {
    await insert(EmployeeCalendarGrant, {
      employeeId: grantEmployeeId,
      accountId: account.id,
      accessLevel: "record",
    });
  }
  return { account, event, meeting };
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

  test("returns after the claim instead of waiting for the call", async () => {
    const finish = deferred<{ bytes: Buffer; mime: string; durationMs: number }>();
    let joins = 0;
    installRecorder(async (args) => {
      joins += 1;
      await args.onJoined();
      return finish.promise;
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });

    const result = await startNotetaker({ companyId: CO, meetingId: meeting.id });
    assert.equal(result.ok, true);
    await waitForCondition(() => joins === 1);
    assert.equal(joins, 1);
    const recording = await waitForMeeting(meeting.id, (row) => row.status === "recording");
    assert.equal(recording.status, "recording");

    abortAllActiveNotetakers("End immediate-return test.");
    finish.reject(new Error("aborted"));
    await waitForMeeting(meeting.id, (row) => row.status === "failed");
  });

  test("stores a successful recording and queues the processing pipeline", async () => {
    const processed: string[] = [];
    setMeetingBackgroundProcessor((_companyId, meetingId) => processed.push(meetingId));
    installRecorder(async (args) => {
      await args.onJoined();
      return { bytes: Buffer.from("recorded call"), mime: "audio/webm", durationMs: 12_345 };
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });

    assert.equal((await startNotetaker({ companyId: CO, meetingId: meeting.id })).ok, true);
    const stored = await waitForMeeting(meeting.id, (row) => row.status === "processing");
    assert.equal(stored.recordingSource, "notetaker");
    assert.equal(stored.recordingMime, "audio/webm");
    assert.equal(Number(stored.recordingBytes), Buffer.byteLength("recorded call"));
    assert.equal(stored.durationMs, 12_345);
    assert.equal(stored.transcriptState, "queued");
    assert.ok(stored.recordingPath);
    assert.deepEqual(processed, [meeting.id]);
  });

  test("keeps finalized partial audio after abort and preserves the actual join time", async () => {
    setMeetingBackgroundProcessor(() => undefined);
    installRecorder(async (args) => {
      await args.onJoined();
      await new Promise<void>((resolve) => {
        if (args.signal.aborted) {
          resolve();
          return;
        }
        args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { bytes: Buffer.from("partial audio"), mime: "audio/webm", durationMs: 5_000 };
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });

    assert.equal((await startNotetaker({ companyId: CO, meetingId: meeting.id })).ok, true);
    const recording = await waitForMeeting(meeting.id, (row) => row.status === "recording");
    assert.ok(recording.startedAt);
    abortAllActiveNotetakers("Meeting ended during shutdown.");
    const stored = await waitForMeeting(meeting.id, (row) => row.status === "processing");
    assert.equal(stored.recordingSource, "notetaker");
    assert.equal(stored.startedAt?.getTime(), recording.startedAt?.getTime());
    assert.equal(stored.durationMs, 5_000);
  });

  test("a durable Stop during admission is not erased by onJoined and settles skipped", async () => {
    let entered = false;
    installRecorder(async (args) => {
      entered = true;
      await new Promise<void>((resolve) => {
        if (args.signal.aborted) resolve();
        else args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await args.onJoined();
      throw new Error("stopped during admission");
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });
    assert.equal((await startNotetaker({ companyId: CO, meetingId: meeting.id })).ok, true);
    await waitForCondition(() => entered);
    assert.equal((await stopNotetaker({ companyId: CO, meetingId: meeting.id })).ok, true);
    const stopped = await waitForMeeting(meeting.id, (row) => row.status === "skipped");
    assert.equal(stopped.statusMessage, STOP_NOTETAKER_MESSAGE);
  });

  test("a durable Stop publishes valid partial audio captured after admission", async () => {
    setMeetingBackgroundProcessor(() => undefined);
    installRecorder(async (args) => {
      await args.onJoined();
      await new Promise<void>((resolve) => {
        if (args.signal.aborted) resolve();
        else args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { bytes: Buffer.from("stopped partial"), mime: "audio/webm", durationMs: 2_000 };
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });
    await startNotetaker({ companyId: CO, meetingId: meeting.id });
    await waitForMeeting(meeting.id, (row) => row.status === "recording");
    await stopNotetaker({ companyId: CO, meetingId: meeting.id });
    const stored = await waitForMeeting(meeting.id, (row) => row.status === "processing");
    assert.equal(readRecording(stored.recordingPath)?.toString(), "stopped partial");
  });

  test("lease loss aborts and fences a stale owner from publishing", async () => {
    let finalized = false;
    installRecorder(async (args) => {
      await args.onJoined();
      await new Promise<void>((resolve) => {
        if (args.signal.aborted) resolve();
        else args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      finalized = true;
      return { bytes: Buffer.from("stale bytes"), mime: "audio/webm", durationMs: 1_000 };
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });
    await startNotetaker({ companyId: CO, meetingId: meeting.id });
    await waitForMeeting(meeting.id, (row) => row.status === "recording");
    assert.equal(setActiveNotetakerLeaseHeldForTests(meeting.id, false), true);
    await checkActiveNotetakersNow();
    await waitForCondition(() => finalized);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const fenced = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(fenced.recordingPath, "");
    assert.equal(fenced.status, "recording");
  });

  test("a concurrent upload wins without being overwritten or deleted", async () => {
    const finish = deferred<{ bytes: Buffer; mime: string; durationMs: number }>();
    installRecorder(async (args) => {
      await args.onJoined();
      return finish.promise;
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });
    await startNotetaker({ companyId: CO, meetingId: meeting.id });
    await waitForMeeting(meeting.id, (row) => row.status === "recording");
    const uploaded = await attachRecording({
      companyId: CO,
      meetingId: meeting.id,
      bytes: Buffer.from("member upload"),
      mime: "audio/webm",
      filename: "call.webm",
    });
    assert.equal(uploaded.ok, true);
    finish.resolve({ bytes: Buffer.from("late notetaker"), mime: "audio/webm", durationMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(stored.recordingSource, "upload");
    assert.equal(readRecording(stored.recordingPath)?.toString(), "member upload");
  });

  test("persists recorder failures", async () => {
    installRecorder(async () => {
      throw new Error("Google Meet refused admission");
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });

    assert.equal((await startNotetaker({ companyId: CO, meetingId: meeting.id })).ok, true);
    const failed = await waitForMeeting(meeting.id, (row) => row.status === "failed");
    assert.match(failed.statusMessage, /refused admission/);
  });

  test("only one concurrent caller can claim the meeting", async () => {
    const finish = deferred<{ bytes: Buffer; mime: string; durationMs: number }>();
    let joins = 0;
    installRecorder(async () => {
      joins += 1;
      return finish.promise;
    });
    const meeting = await blankMeeting({ conferenceUrl: "https://meet.google.com/a-b-c" });

    const results = await Promise.all([
      startNotetaker({ companyId: CO, meetingId: meeting.id }),
      startNotetaker({ companyId: CO, meetingId: meeting.id }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    await waitForCondition(() => joins === 1);
    assert.equal(joins, 1);

    abortAllActiveNotetakers("End concurrency test.");
    finish.reject(new Error("aborted"));
    await waitForMeeting(meeting.id, (row) => row.status === "failed");
  });

  test("requires an explicit retry and never rejoins a failed processed recording", async () => {
    installRecorder(async () => {
      throw new Error("still unavailable");
    });
    const retryable = await blankMeeting({
      conferenceUrl: "https://meet.google.com/a-b-c",
      status: "failed",
    });
    assert.equal((await startNotetaker({ companyId: CO, meetingId: retryable.id })).ok, false);
    assert.equal(
      (
        await startNotetaker({
          companyId: CO,
          meetingId: retryable.id,
          retryFailed: true,
        })
      ).ok,
      true,
    );
    await waitForMeeting(retryable.id, (row) => row.status === "failed");

    const withAudio = await blankMeeting({
      conferenceUrl: "https://meet.google.com/a-b-c",
      status: "failed",
      recordingPath: "meetings/existing.webm",
    });
    assert.equal(
      (
        await startNotetaker({
          companyId: CO,
          meetingId: withAudio.id,
          retryFailed: true,
        })
      ).ok,
      false,
    );
  });
});

describe("automatic notetaker dispatch", () => {
  test("arms an event first seen just after it starts, but never one already ended", async () => {
    const now = new Date();
    const account = await insert(CalendarAccount, {
      companyId: CO,
      connectionId: "connection-catch-up",
      calendarId: "calendar-catch-up",
      status: "active",
      autoRecord: "all",
      notetakerEmployeeId: EMPLOYEE_A,
    });
    const live = await insert(CalendarEvent, {
      companyId: CO,
      accountId: account.id,
      externalId: "event-live-catch-up",
      startAt: new Date(now.getTime() - 5 * 60_000),
      endAt: new Date(now.getTime() + 30 * 60_000),
      status: "confirmed",
      conferenceProvider: "meet",
      conferenceUrl: "https://meet.google.com/live-catch-up",
    });
    await insert(CalendarEvent, {
      companyId: CO,
      accountId: account.id,
      externalId: "event-ended-catch-up",
      startAt: new Date(now.getTime() - 5 * 60_000),
      endAt: new Date(now.getTime() - 1),
      status: "confirmed",
      conferenceProvider: "meet",
      conferenceUrl: "https://meet.google.com/ended-catch-up",
    });

    assert.equal(await armMeetingsForAccount(account, now), 1);
    assert.ok(await AppDataSource.getRepository(Meeting).findOneBy({ calendarEventId: live.id }));
  });

  test("joins due meetings and live catch-up meetings, but not future or ended meetings", async () => {
    const now = new Date();
    const joined: string[] = [];
    const finishes = new Map<
      string,
      ReturnType<typeof deferred<{ bytes: Buffer; mime: string; durationMs: number }>>
    >();
    installRecorder(async (args) => {
      joined.push(args.meetingId);
      const finish = deferred<{ bytes: Buffer; mime: string; durationMs: number }>();
      finishes.set(args.meetingId, finish);
      return finish.promise;
    });
    const due = await calendarMeeting({ now });
    const catchUp = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() - 5 * 60_000),
      meetingStartAt: new Date(now.getTime() - 5 * 60_000),
    });
    const future = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() + 2 * 60_000),
      meetingStartAt: new Date(now.getTime() + 2 * 60_000),
    });
    const ended = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() - 60 * 60_000),
      eventEndAt: new Date(now.getTime() - 1),
      meetingStartAt: new Date(now.getTime() - 60 * 60_000),
    });

    const result = await dispatchDueMeetings(now);
    assert.equal(result.due, 2);
    assert.equal(result.claimed, 2);
    await waitForCondition(() => joined.length === 2);
    assert.deepEqual(new Set(joined), new Set([due.meeting.id, catchUp.meeting.id]));
    assert.equal(
      (await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: future.meeting.id }))
        .status,
      "scheduled",
    );
    assert.equal(
      (await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: ended.meeting.id })).status,
      "scheduled",
    );

    abortAllActiveNotetakers("End due dispatch test.");
    for (const finish of finishes.values()) finish.reject(new Error("aborted"));
    await Promise.all([
      waitForMeeting(due.meeting.id, (row) => row.status === "failed"),
      waitForMeeting(catchUp.meeting.id, (row) => row.status === "failed"),
    ]);
  });

  test("revalidates cancellation, reschedule, opt-out, and Record access before joining", async () => {
    const now = new Date();
    let joins = 0;
    installRecorder(async () => {
      joins += 1;
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    const cancelled = await calendarMeeting({ now, eventStatus: "cancelled" });
    const rescheduled = await calendarMeeting({
      now,
      meetingStartAt: new Date(now.getTime() + 10_000),
      eventStartAt: new Date(now.getTime() + 10 * 60_000),
    });
    const optedOut = await calendarMeeting({ now, autoRecord: "off" });
    const noGrant = await calendarMeeting({ now, grantEmployeeId: null });
    const syncError = await calendarMeeting({ now });
    await AppDataSource.getRepository(CalendarAccount).update(
      { id: syncError.account.id },
      { status: "error" },
    );

    await dispatchDueMeetings(now);
    await Promise.all([
      waitForMeeting(cancelled.meeting.id, (row) => row.status === "skipped"),
      waitForMeeting(rescheduled.meeting.id, (row) => row.status === "scheduled"),
      waitForMeeting(optedOut.meeting.id, (row) => row.status === "skipped"),
      waitForMeeting(noGrant.meeting.id, (row) => row.status === "skipped"),
      waitForMeeting(
        syncError.meeting.id,
        (row) => row.status === "scheduled" && /sync successfully/.test(row.statusMessage),
      ),
    ]);
    assert.equal(joins, 0);
    const grantFailure = await AppDataSource.getRepository(Meeting).findOneByOrFail({
      id: noGrant.meeting.id,
    });
    assert.match(grantFailure.statusMessage, /Record access/);
  });

  test("uses the current notetaker and conference link, never the armed copies", async () => {
    const now = new Date();
    let seenUrl = "";
    installRecorder(async (args) => {
      seenUrl = args.conferenceUrl;
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    setMeetingBackgroundProcessor(() => undefined);
    const fixture = await calendarMeeting({
      now,
      accountEmployeeId: EMPLOYEE_B,
      meetingEmployeeId: EMPLOYEE_A,
      meetingStartAt: new Date(now.getTime() + 10 * 60_000),
      eventUrl: "https://meet.google.com/new-room",
      meetingUrl: "https://meet.google.com/old-room",
      grantEmployeeId: EMPLOYEE_B,
    });

    await dispatchDueMeetings(now);
    const stored = await waitForMeeting(fixture.meeting.id, (row) => row.status === "processing");
    assert.equal(seenUrl, fixture.event.conferenceUrl);
    assert.equal(stored.notetakerEmployeeId, EMPLOYEE_B);
    assert.equal(stored.conferenceUrl, fixture.event.conferenceUrl);
  });

  test("revoking Record access stops an active automatic recorder", async () => {
    const now = new Date();
    let aborted = false;
    setMeetingBackgroundProcessor(() => undefined);
    installRecorder(async (args) => {
      await args.onJoined();
      await new Promise<void>((resolve) => {
        if (args.signal.aborted) resolve();
        else args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = true;
      return { bytes: Buffer.from("authority partial"), mime: "audio/webm", durationMs: 1_000 };
    });
    const fixture = await calendarMeeting({ now });
    await dispatchDueMeetings(now);
    await waitForMeeting(fixture.meeting.id, (row) => row.status === "recording");
    await AppDataSource.getRepository(EmployeeCalendarGrant).delete({
      employeeId: EMPLOYEE_A,
      accountId: fixture.account.id,
    });
    await checkActiveNotetakersNow();
    const stored = await waitForMeeting(fixture.meeting.id, (row) => row.status === "processing");
    assert.equal(aborted, true);
    assert.equal(stored.recordingSource, "notetaker");
  });
});

describe("retrying a join that did not happen", () => {
  /**
   * The second half of the "it never joins" bug.
   *
   * Dispatch only ever claimed `scheduled` rows, and a claim that failed for
   * any reason at all settled the meeting `failed` for good. So the first
   * flake — a lobby that had not rendered, a host who had not opened the call
   * — wrote off the whole meeting at second one, thirty minutes before it was
   * due to end, and no later pass ever looked at it again. `skipped` was worse
   * still: not even a human pressing the button could re-open it.
   */
  test("a human may re-open a meeting the automatic pass skipped", async () => {
    const now = new Date();
    const joined: string[] = [];
    installRecorder(async (args) => {
      joined.push(args.meetingId);
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    setMeetingBackgroundProcessor(() => undefined);
    const fixture = await calendarMeeting({ now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "skipped", statusMessage: "Automatic recording was turned off for this event." },
    );

    const result = await startNotetaker({
      companyId: CO,
      meetingId: fixture.meeting.id,
      retryFailed: true,
    });

    assert.equal(result.ok, true);
    await waitForMeeting(fixture.meeting.id, (row) => row.status === "processing");
    assert.deepEqual(joined, [fixture.meeting.id]);
  });

  test("a skipped meeting is still not re-opened without an explicit retry", async () => {
    const now = new Date();
    installRecorder(async () => ({ bytes: Buffer.from("a"), mime: "audio/webm", durationMs: 1 }));
    const fixture = await calendarMeeting({ now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "skipped", statusMessage: "Automatic recording was turned off for this event." },
    );

    const result = await startNotetaker({ companyId: CO, meetingId: fixture.meeting.id });

    assert.equal(result.ok, false);
    assert.equal(
      (await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: fixture.meeting.id }))
        .status,
      "skipped",
    );
  });

  test("a skipped meeting that already has audio is never re-recorded", async () => {
    const now = new Date();
    installRecorder(async () => ({ bytes: Buffer.from("a"), mime: "audio/webm", durationMs: 1 }));
    const fixture = await calendarMeeting({ now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "skipped", recordingPath: "meetings/co/x.webm" },
    );

    const result = await startNotetaker({
      companyId: CO,
      meetingId: fixture.meeting.id,
      retryFailed: true,
    });

    assert.equal(result.ok, false);
  });

  test("dispatch retries a failed join while the call is still running", async () => {
    const now = new Date();
    const joined: string[] = [];
    installRecorder(async (args) => {
      joined.push(args.meetingId);
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    setMeetingBackgroundProcessor(() => undefined);
    const fixture = await calendarMeeting({ now, eventStartAt: now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "failed", statusMessage: "The notetaker could not open the Google Meet lobby." },
    );

    const result = await dispatchDueMeetings(new Date(now.getTime() + 3 * 60_000));

    assert.equal(result.due, 1);
    assert.equal(result.claimed, 1);
    assert.equal(result.retried, 1);
    await waitForMeeting(fixture.meeting.id, (row) => row.status === "processing");
    assert.deepEqual(joined, [fixture.meeting.id]);
  });

  test("dispatch waits out the backoff rather than retrying every tick", async () => {
    const now = new Date();
    const joined: string[] = [];
    installRecorder(async (args) => {
      joined.push(args.meetingId);
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    const fixture = await calendarMeeting({ now, eventStartAt: now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "failed", statusMessage: "The notetaker could not open the Google Meet lobby." },
    );

    const result = await dispatchDueMeetings(new Date(now.getTime() + 30_000));

    assert.deepEqual({ due: result.due, claimed: result.claimed, retried: result.retried }, {
      due: 0,
      claimed: 0,
      retried: 0,
    });
    assert.deepEqual(joined, []);
  });

  test("dispatch stops retrying once the call is well under way", async () => {
    const now = new Date();
    installRecorder(async () => ({ bytes: Buffer.from("a"), mime: "audio/webm", durationMs: 1 }));
    const fixture = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() - 30 * 60_000),
      eventEndAt: new Date(now.getTime() + 30 * 60_000),
    });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      { status: "failed", statusMessage: "The notetaker could not open the Google Meet lobby." },
    );

    const result = await dispatchDueMeetings(new Date(now.getTime() + 3 * 60_000));

    assert.equal(result.due, 0);
    assert.equal(result.retried, 0);
  });

  test("a Stop is a decision, not a flake — dispatch never undoes one", async () => {
    const now = new Date();
    const joined: string[] = [];
    installRecorder(async (args) => {
      joined.push(args.meetingId);
      return { bytes: Buffer.from("audio"), mime: "audio/webm", durationMs: 1 };
    });
    const stopped = await calendarMeeting({ now, eventStartAt: now });
    const policyStopped = await calendarMeeting({ now, eventStartAt: now });
    await AppDataSource.getRepository(Meeting).update(
      { id: stopped.meeting.id },
      { status: "failed", statusMessage: STOP_NOTETAKER_MESSAGE },
    );
    await AppDataSource.getRepository(Meeting).update(
      { id: policyStopped.meeting.id },
      {
        status: "failed",
        statusMessage: "Notetaker stopping: Automatic recording was paused for this calendar.",
      },
    );

    const result = await dispatchDueMeetings(new Date(now.getTime() + 3 * 60_000));

    assert.equal(result.due, 0);
    assert.deepEqual(joined, []);
  });

  test("a failed meeting that did save audio belongs in /process, not in a new call", async () => {
    const now = new Date();
    installRecorder(async () => ({ bytes: Buffer.from("a"), mime: "audio/webm", durationMs: 1 }));
    const fixture = await calendarMeeting({ now, eventStartAt: now });
    await AppDataSource.getRepository(Meeting).update(
      { id: fixture.meeting.id },
      {
        status: "failed",
        statusMessage: "Transcription failed.",
        recordingPath: "meetings/co/kept.webm",
      },
    );

    const result = await dispatchDueMeetings(new Date(now.getTime() + 3 * 60_000));

    assert.equal(result.due, 0);
  });

  test("an ordinary scheduled meeting is still claimed as a fresh join", async () => {
    const now = new Date();
    installRecorder(async () => ({ bytes: Buffer.from("a"), mime: "audio/webm", durationMs: 1 }));
    setMeetingBackgroundProcessor(() => undefined);
    const fixture = await calendarMeeting({ now });

    const result = await dispatchDueMeetings(now);

    assert.equal(result.claimed, 1);
    assert.equal(result.retried, 0, "a first attempt is not a retry");
    await waitForMeeting(fixture.meeting.id, (row) => row.status !== "scheduled");
  });
});

describe("stale notetaker recovery", () => {
  test("requeues a live calendar call and fails an unrecoverable ad-hoc call", async () => {
    const now = new Date();
    const live = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() - 5 * 60_000),
      meetingStartAt: new Date(now.getTime() - 5 * 60_000),
    });
    await AppDataSource.getRepository(Meeting).update(
      { id: live.meeting.id },
      { status: "recording", startedAt: new Date(now.getTime() - 4 * 60_000) },
    );
    const adHoc = await blankMeeting({
      conferenceUrl: "https://meet.google.com/a-b-c",
      status: "joining",
    });
    const stoppedFixture = await calendarMeeting({
      now,
      eventStartAt: new Date(now.getTime() - 5 * 60_000),
      meetingStartAt: new Date(now.getTime() - 5 * 60_000),
    });
    await AppDataSource.getRepository(Meeting).update(
      { id: stoppedFixture.meeting.id },
      { status: "joining", statusMessage: STOP_NOTETAKER_MESSAGE },
    );

    const result = await recoverStaleNotetakers(new Date(now.getTime() + 10_000), 0);
    assert.deepEqual(result, { recovered: 1, failed: 2 });
    const requeued = await AppDataSource.getRepository(Meeting).findOneByOrFail({
      id: live.meeting.id,
    });
    const failed = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: adHoc.id });
    assert.equal(requeued.status, "scheduled");
    assert.equal(requeued.startedAt, null);
    assert.equal(failed.status, "failed");
    assert.match(failed.statusMessage, /stopped before it saved/);
    const durableStop = await AppDataSource.getRepository(Meeting).findOneByOrFail({
      id: stoppedFixture.meeting.id,
    });
    assert.equal(durableStop.status, "failed");
    assert.equal(durableStop.statusMessage, STOP_NOTETAKER_MESSAGE);
  });
});
