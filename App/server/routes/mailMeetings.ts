import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import {
  LOCAL_DATE_TIME,
  MAX_MEETING_MINUTES,
  MIN_MEETING_MINUTES,
  isMeetingTimeZone,
} from "../../shared/meetingTime.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { loadAccount, loadThread } from "../services/mail/lookup.js";
import { proposeMeeting } from "../services/mail/meetingProposal.js";
import {
  MeetingSchedulingError,
  calendarAvailability,
  listSchedulingCalendars,
  scheduleMeeting,
} from "../services/mail/meetingScheduling.js";

/**
 * Scheduling a meeting from the Email section: the calendars a mailbox can
 * book on, the AI Employee's proposal read from a thread, the organizer's busy
 * time, and the event itself with its Google Meet link and invitations.
 *
 * Mounted at `/api/companies/:cid` beside `mailRouter`, so every path starts
 * `/mail`. Any Member may use it, as any Member may send mail: the calendars
 * on offer were connected by an owner or admin, the guests clear the same
 * do-not-email gate as a send, and nothing here connects or widens a Google
 * account. Handlers parse and shape only — `services/mail/meetingScheduling.ts`
 * and `services/mail/meetingProposal.ts` do the work.
 */
export const mailMeetingsRouter = Router({ mergeParams: true });
mailMeetingsRouter.use(requireAuth);
mailMeetingsRouter.use(requireCompanyMember);

/** Express 4 does not await handlers; a rejection must reach the error handler. */
function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof MeetingSchedulingError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

const accountParams = z.object({ cid: z.string().min(1), aid: z.string().uuid() });
const threadParams = z.object({ cid: z.string().min(1), tid: z.string().uuid() });

mailMeetingsRouter.get(
  "/mail/accounts/:aid/scheduling-calendars",
  validateParams(accountParams),
  h(async (req, res) => {
    const { cid, aid } = req.params as z.infer<typeof accountParams>;
    const account = await loadAccount(cid, aid);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    res.json(await listSchedulingCalendars(account));
  }),
);

const proposalSchema = z
  .object({
    /** The Member's own IANA zone, used when the thread names none. */
    timeZone: z.string().max(64).optional(),
  })
  .strict();

/**
 * What the scheduler should open with for this thread. The AI Employee that
 * reads the mailbox fills it in from the thread; without one, or when its
 * reading fails, the plain proposal comes back with a note saying why.
 */
mailMeetingsRouter.post(
  "/mail/threads/:tid/meeting-proposal",
  requireBrowserSession,
  validateParams(threadParams),
  validateBody(proposalSchema),
  h(async (req, res) => {
    const { cid, tid } = req.params as z.infer<typeof threadParams>;
    const found = await loadThread(cid, tid);
    if (!found) return res.status(404).json({ error: "Thread not found" });
    const body = req.body as z.infer<typeof proposalSchema>;
    res.json(await proposeMeeting(found.account, found.thread, { timeZone: body.timeZone }));
  }),
);

const MAX_AVAILABILITY_SPAN_MS = 24 * 60 * 60 * 1000;

const availabilitySchema = z
  .object({
    calendarId: z.string().min(1).max(200),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => new Date(value.end).getTime() > new Date(value.start).getTime(), {
    message: "end must be after start",
    path: ["end"],
  })
  .refine(
    (value) =>
      new Date(value.end).getTime() - new Date(value.start).getTime() <= MAX_AVAILABILITY_SPAN_MS,
    { message: "Ask about at most 24 hours at a time", path: ["end"] },
  );

/** The organizer's busy time around a slot, for the scheduler's conflict warning. */
mailMeetingsRouter.post(
  "/mail/accounts/:aid/meetings/availability",
  validateParams(accountParams),
  validateBody(availabilitySchema),
  h(async (req, res) => {
    const { cid, aid } = req.params as z.infer<typeof accountParams>;
    const account = await loadAccount(cid, aid);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const body = req.body as z.infer<typeof availabilitySchema>;
    res.json(
      await calendarAvailability(account, {
        calendarId: body.calendarId,
        start: new Date(body.start),
        end: new Date(body.end),
      }),
    );
  }),
);

const scheduleSchema = z
  .object({
    calendarId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(8_000).optional(),
    start: z.string().regex(LOCAL_DATE_TIME, "Use local wall time, YYYY-MM-DDTHH:mm"),
    timeZone: z
      .string()
      .max(64)
      .refine(isMeetingTimeZone, "Use an IANA time zone such as Europe/Berlin"),
    durationMinutes: z.number().int().min(MIN_MEETING_MINUTES).max(MAX_MEETING_MINUTES),
    attendees: z
      .array(
        z
          .object({
            email: z.string().trim().email().max(320),
            name: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    addMeet: z.boolean().optional().default(true),
    sendInvites: z.boolean().optional().default(true),
    threadId: z.string().uuid().optional(),
    analysisAction: z
      .object({ analysisId: z.string().uuid(), actionId: z.string().min(1).max(40) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Create the meeting on a Google calendar, with a Google Meet link when asked,
 * and have Google email the invitations. The guests clear the do-not-email
 * and Policy gate first; a refused guest means nothing is created.
 */
mailMeetingsRouter.post(
  "/mail/accounts/:aid/meetings",
  validateParams(accountParams),
  validateBody(scheduleSchema),
  h(async (req, res) => {
    const { cid, aid } = req.params as z.infer<typeof accountParams>;
    const account = await loadAccount(cid, aid);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const body = req.body as z.infer<typeof scheduleSchema>;
    const meeting = await scheduleMeeting(account, body, { userId: req.userId ?? null });
    res.status(201).json({ meeting });
  }),
);
