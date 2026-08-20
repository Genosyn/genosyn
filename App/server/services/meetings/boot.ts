import { In } from "typeorm";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { chatWithEmployee } from "../chat.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { syncCalendarAccount } from "./calendarSync.js";
import { parseWriteUp, setMeetingWriteUpAuthor } from "./followUps.js";
import { registerBuiltInMeetingRecorder } from "./googleMeetRecorder.js";
import { processMeeting } from "./pipeline.js";
import { dispatchDueMeetings } from "./recorder.js";
import { armMeetingsForAccount } from "./store.js";

/**
 * Boot wiring for the Meetings section.
 *
 * Three things live here, and all exist to keep a dependency pointing the right
 * way — the same reason `services/revenue/boot.ts` exists:
 *
 * 1. **The heartbeat.** Calendars re-sync, meetings arm themselves for calls
 *    about to start, and anything sitting in `processing` gets driven to
 *    `ready`. It takes its own scheduler lease rather than sharing the
 *    routines one, so a long routine dispatch cannot stall calendar sync and a
 *    slow calendar cannot stall routines.
 * 2. **The due dispatcher.** A separate brisk loop claims calls near their
 *    start time and returns immediately; the recorder never holds its lease.
 * 3. **The real write-up author.** `followUps.ts` is written against a
 *    callback precisely so importing the meeting pipeline in a test does not
 *    drag the agent runtime — and every model provider — in with it. This
 *    module is the one place that knows both halves, and it is imported only
 *    at boot.
 */

const HEARTBEAT_INTERVAL_MS = Math.max(60, config.meetings.syncIntervalSeconds) * 1000;
const DISPATCH_INTERVAL_MS = 20_000;

/** Meetings driven per pass. Bounds a heartbeat that finds a backlog. */
const MAX_MEETINGS_PER_PASS = 5;

let heartbeatTimer: NodeJS.Timeout | null = null;
let dispatchTimer: NodeJS.Timeout | null = null;
let heartbeatTicking = false;
let dispatchTicking = false;

/**
 * Ask the notetaker employee to write the meeting up.
 *
 * `toolAuthority: "employee"` is required and not optional decoration: without
 * it the turn is "untrusted" — no Soul, no Skills, no company tools — and the
 * employee would be reading a transcript with none of the context that makes
 * its judgement worth anything. This is the same seam `draftTouch` and
 * `handleSignal` use.
 */
async function authorWriteUp(args: {
  employeeId: string;
  prompt: string;
  meeting: Meeting;
}): Promise<ReturnType<typeof parseWriteUp>> {
  const result = await chatWithEmployee(args.meeting.companyId, args.employeeId, args.prompt, [], {
    toolAuthority: "employee",
  });
  if (result.status !== "ok") {
    throw new Error(result.reply || "The AI Employee could not write this meeting up.");
  }
  return parseWriteUp(result.reply);
}

export type MeetingHeartbeatDependencies = {
  syncAccount: typeof syncCalendarAccount;
  armAccount: typeof armMeetingsForAccount;
  process: typeof processMeeting;
};

const HEARTBEAT_DEPENDENCIES: MeetingHeartbeatDependencies = {
  syncAccount: syncCalendarAccount,
  armAccount: armMeetingsForAccount,
  process: processMeeting,
};

/** One pass: sync every non-paused calendar, then drain the processing backlog. */
export async function runMeetingsHeartbeat(
  dependencies: MeetingHeartbeatDependencies = HEARTBEAT_DEPENDENCIES,
): Promise<void> {
  const accounts = await AppDataSource.getRepository(CalendarAccount).find({
    // `error` describes the last attempt, not an operator pause. Retrying it
    // here is what lets a transient Google failure recover without a human
    // toggling the calendar off and on again.
    where: { status: In(["active", "error"]) },
  });

  for (const account of accounts) {
    const repo = AppDataSource.getRepository(CalendarAccount);
    try {
      await repo.update({ id: account.id }, { syncState: "running", syncStartedAt: new Date() });
      await dependencies.syncAccount(account);
      await dependencies.armAccount(account);
      await repo.update(
        { id: account.id },
        {
          syncState: "succeeded",
          syncFinishedAt: new Date(),
          status: "active",
          statusMessage: "",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One broken calendar must not stop the others, and must not silently
      // retry forever without saying why — the row carries the reason.
      await repo.update(
        { id: account.id },
        {
          syncState: "failed",
          syncFinishedAt: new Date(),
          status: "error",
          statusMessage: message.slice(0, 500),
        },
      );
      // eslint-disable-next-line no-console
      console.warn(`[meetings] calendar sync failed for ${account.id}:`, message);
    }
  }

  const pending = await AppDataSource.getRepository(Meeting).find({
    where: { status: "processing" },
    order: { updatedAt: "ASC" },
    take: MAX_MEETINGS_PER_PASS,
  });
  for (const meeting of pending) {
    try {
      await dependencies.process(meeting.companyId, meeting.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[meetings] processing failed for ${meeting.id}:`, err);
    }
  }
}

/**
 * Install the seam and start the heartbeat.
 *
 * The first pass is not awaited: a slow calendar must not gate server startup,
 * and the tick is written never to reject. The lease keeps two replicas from
 * doing the same work — see `services/schedulerLeases.ts`.
 */
export function bootMeetings(): void {
  setMeetingWriteUpAuthor(authorWriteUp);
  registerBuiltInMeetingRecorder();
  if (!config.meetings.enabled) return;

  const runHeartbeat = () => {
    if (heartbeatTicking) return;
    heartbeatTicking = true;
    void withSchedulerLease("meetings-sync", HEARTBEAT_INTERVAL_MS * 3, () =>
      runMeetingsHeartbeat(),
    )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[meetings] heartbeat failed:", err);
      })
      .finally(() => {
        heartbeatTicking = false;
      });
  };

  // This loop is intentionally separate from calendar sync. It runs often
  // enough to join just before the start time, and its lease ends as soon as
  // each durable claim is made — never after the call finishes.
  const runDispatch = () => {
    if (dispatchTicking) return;
    dispatchTicking = true;
    void withSchedulerLease("meetings-notetaker-dispatch", DISPATCH_INTERVAL_MS * 3, () =>
      dispatchDueMeetings(),
    )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[meetings] notetaker dispatch failed:", err);
      })
      .finally(() => {
        dispatchTicking = false;
      });
  };

  runHeartbeat();
  runDispatch();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  if (dispatchTimer) clearInterval(dispatchTimer);
  dispatchTimer = setInterval(runDispatch, DISPATCH_INTERVAL_MS);
  dispatchTimer.unref();
}
