import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { chatWithEmployee } from "../chat.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { syncCalendarAccount } from "./calendarSync.js";
import { parseWriteUp, setMeetingWriteUpAuthor } from "./followUps.js";
import { processMeeting } from "./pipeline.js";
import { armMeetingsForAccount } from "./store.js";

/**
 * Boot wiring for the Meetings section.
 *
 * Two things live here, and both exist to keep a dependency pointing the right
 * way — the same reason `services/revenue/boot.ts` exists:
 *
 * 1. **The heartbeat.** Calendars re-sync, meetings arm themselves for calls
 *    about to start, and anything sitting in `processing` gets driven to
 *    `ready`. It takes its own scheduler lease rather than sharing the
 *    routines one, so a long routine dispatch cannot stall calendar sync and a
 *    slow calendar cannot stall routines.
 * 2. **The real write-up author.** `followUps.ts` is written against a
 *    callback precisely so importing the meeting pipeline in a test does not
 *    drag the agent runtime — and every model provider — in with it. This
 *    module is the one place that knows both halves, and it is imported only
 *    at boot.
 */

const HEARTBEAT_INTERVAL_MS = Math.max(60, config.meetings.syncIntervalSeconds) * 1000;

/** Meetings driven per pass. Bounds a heartbeat that finds a backlog. */
const MAX_MEETINGS_PER_PASS = 5;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

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
  const result = await chatWithEmployee(
    args.meeting.companyId,
    args.employeeId,
    args.prompt,
    [],
    { toolAuthority: "employee" },
  );
  if (result.status !== "ok") {
    throw new Error(result.reply || "The AI Employee could not write this meeting up.");
  }
  return parseWriteUp(result.reply);
}

/** One pass: sync every active calendar, then drain the processing backlog. */
async function tick(): Promise<void> {
  const accounts = await AppDataSource.getRepository(CalendarAccount).find({
    where: { status: "active" },
  });

  for (const account of accounts) {
    const repo = AppDataSource.getRepository(CalendarAccount);
    try {
      await repo.update(
        { id: account.id },
        { syncState: "running", syncStartedAt: new Date() },
      );
      await syncCalendarAccount(account);
      await armMeetingsForAccount(account);
      await repo.update(
        { id: account.id },
        { syncState: "succeeded", syncFinishedAt: new Date(), statusMessage: "" },
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
      await processMeeting(meeting.companyId, meeting.id);
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
  if (!config.meetings.enabled) return;

  const run = () => {
    if (ticking) return;
    ticking = true;
    void withSchedulerLease("meetings-sync", HEARTBEAT_INTERVAL_MS * 3, tick)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[meetings] heartbeat failed:", err);
      })
      .finally(() => {
        ticking = false;
      });
  };

  run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, HEARTBEAT_INTERVAL_MS);
  timer.unref();
}
