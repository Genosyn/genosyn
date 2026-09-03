import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { CalendarEvent } from "../db/entities/CalendarEvent.js";
import { CALENDAR_ACCESS_LEVELS } from "../db/entities/EmployeeCalendarGrant.js";
import { CALENDAR_AUTO_RECORD_MODES } from "../db/entities/CalendarAccount.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  createCalendarAccount,
  deleteCalendarAccount,
  getCalendarAccount,
  listCalendarAccounts,
  listConnectableCalendars,
  updateCalendarAccount,
} from "../services/meetings/accounts.js";
import { syncCalendarAccount } from "../services/meetings/calendarSync.js";
import {
  deleteCalendarGrant,
  listCalendarGrants,
  upsertCalendarGrant,
} from "../services/meetings/grants.js";
import { processMeeting, processMeetingInBackground } from "../services/meetings/pipeline.js";
import {
  attachRecording,
  attachTranscript,
  startNotetaker,
  stopNotetaker,
} from "../services/meetings/recorder.js";
import { linkMeeting } from "../services/meetings/revenueLink.js";
import {
  serializeCalendarAccount,
  serializeCalendarEvent,
  serializeMeeting,
  serializeParticipant,
  serializeSegment,
} from "../services/meetings/serialize.js";
import { readRecording } from "../services/meetings/storage.js";
import { getMeetingsSettings } from "../services/runtimeSettings.js";
import {
  addParticipants,
  armMeetingsForAccount,
  createAdHocMeeting,
  getMeeting,
  listMeetings,
  listParticipants,
  listTranscriptSegments,
} from "../services/meetings/store.js";

/**
 * Meetings API (M44).
 *
 * Mounted at `/api/companies/:cid`, so every path here starts `/meetings`.
 * Route order is load-bearing: the literal segments (`/meetings/calendars`,
 * `/meetings/events`, `/meetings/ai-access`) are declared **before**
 * `/meetings/:id`, because Express matches in declaration order and `:id`
 * would otherwise swallow all three.
 */
export const meetingsRouter = Router({ mergeParams: true });

meetingsRouter.use(requireAuth);
meetingsRouter.use(requireCompanyMember);

/**
 * Who may change the recording *policy*, as opposed to working with meetings.
 *
 * Two decisions are admin-only, and they are the two that can put a bot in a
 * room nobody invited it to:
 *
 *   - `/meetings/ai-access` (grant + revoke) — a `record` grant lets an AI
 *     Employee read every transcript on a calendar and start the notetaker on
 *     a live call. Granting that is the same class of act as
 *     `/revenue/ai-access` or `/signatures/ai-access`, and is gated the same.
 *   - `/meetings/calendars` and `/meetings/calendars/:id` — connecting a
 *     calendar spends a Google Connection's credentials, and the PATCH body
 *     carries `autoRecord` and `notetakerEmployeeId`, which together decide
 *     whether a recorder joins uninvited (see `CalendarAccount`).
 *
 * Everything else stays collaborative, which is why the matchers are shaped
 * the way they are rather than a bare `/meetings` prefix:
 *
 *   - `/meetings/calendars/:id/sync` is deliberately *outside* the gate. It
 *     refreshes the mirror under whatever policy an admin already set — it
 *     cannot arm a meeting a policy would not have armed — and the Sync button
 *     in `client/pages/MeetingsCalendars.tsx` is shown to every member, unlike
 *     the connect/disconnect/auto-record controls beside it.
 *   - Meeting-level work (create, upload a recording or transcript, add
 *     attendees, process, link, start the notetaker on one call) is ordinary
 *     use of the section by a human who can already see the meeting, so it
 *     stays open to members — the same line revenue draws by gating
 *     `/revenue/ai-access` while leaving contact writes alone.
 *
 * `onRoutePaths` is load-bearing: this router is mounted at
 * `/api/companies/:cid` alongside its siblings, so an unscoped `.use()` guard
 * would also intercept requests bound for routers mounted after it. The regexes
 * are anchored so `/meetings/calendars/:id/sync` does not fall in.
 */
meetingsRouter.use(
  onRoutePaths(
    ["/meetings/ai-access", /^\/meetings\/calendars$/, /^\/meetings\/calendars\/[^/]+$/],
    requireCompanyRoleForMutations("admin"),
  ),
);

/**
 * Express 4 does not await a handler, so a rejected promise escapes as an
 * unhandled rejection and takes the process with it. Every async handler goes
 * through this — the same wrapper `routes/revenue.ts` uses and for the same
 * reason.
 */
function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function userId(req: Request): string | null {
  return (req as unknown as { user?: { id?: string } }).user?.id ?? null;
}

/**
 * Recordings are buffered in memory rather than streamed to multer's disk
 * store: `services/meetings/storage.ts` owns where a recording lives (it is
 * app-private, outside the company tree), and multer's disk storage would need
 * `req.company` set before it runs just to put the bytes somewhere we then
 * move them from.
 *
 * The multer limit is a **fixed** ceiling rather than the configured cap. This
 * router is constructed once at boot, so a limit read here would freeze
 * whatever the cap was at startup and ignore every later change at Admin →
 * Runtime. The ceiling exists only to stop an unbounded body from filling
 * memory; the operator's actual cap is enforced in the handler below, against
 * the live setting, and is what the caller is told about.
 */
const RECORDING_UPLOAD_CEILING_BYTES = 100 * 1024 * 1024;

const recordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECORDING_UPLOAD_CEILING_BYTES, files: 1 },
});

/** Turn multer's own refusals into the 400 the client can render. */
const acceptRecording: RequestHandler = (req, res, next) => {
  recordingUpload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      const mb = Math.round(RECORDING_UPLOAD_CEILING_BYTES / (1024 * 1024));
      res.status(400).json({
        error:
          err.code === "LIMIT_FILE_SIZE"
            ? `That recording is over the ${mb} MB upload ceiling.`
            : "That upload could not be read. Send one recording as the `file` field.",
      });
      return;
    }
    next(err);
  });
};

// ───────────────────────────── calendars ─────────────────────────────

meetingsRouter.get(
  "/meetings/calendars",
  h(async (req, res) => {
    const accounts = await listCalendarAccounts(cid(req));
    res.json({ calendars: accounts.map(serializeCalendarAccount) });
  }),
);

/** Google Connections that could back a calendar, for the connect dialog. */
meetingsRouter.get(
  "/meetings/calendars/candidates",
  h(async (req, res) => {
    const connections = await AppDataSource.getRepository(IntegrationConnection).find({
      where: { companyId: cid(req), provider: "google" },
      order: { createdAt: "ASC" },
    });
    res.json({
      connections: connections.map((row) => ({
        id: row.id,
        accountHint: row.accountHint,
        status: row.status,
      })),
    });
  }),
);

const connectableQuery = z.object({ connectionId: z.string().uuid() });

meetingsRouter.get(
  "/meetings/calendars/connectable",
  h(async (req, res) => {
    const parsed = connectableQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "A connectionId is required." });
      return;
    }
    try {
      const calendars = await listConnectableCalendars(cid(req), parsed.data.connectionId);
      res.json({ calendars });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Could not list calendars." });
    }
  }),
);

const createCalendarBody = z.object({
  connectionId: z.string().uuid(),
  calendarId: z.string().min(1).max(500),
});

meetingsRouter.post(
  "/meetings/calendars",
  validateBody(createCalendarBody),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof createCalendarBody>;
    try {
      const account = await createCalendarAccount({
        companyId: cid(req),
        connectionId: body.connectionId,
        calendarId: body.calendarId,
        createdByUserId: userId(req),
      });
      await recordAudit({
        companyId: cid(req),
        actorUserId: userId(req),
        action: "meetings.calendar.connect",
        targetType: "calendar",
        targetId: account.id,
        targetLabel: account.displayName,
      });
      res.status(201).json({ calendar: serializeCalendarAccount(account) });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Could not connect calendar." });
    }
  }),
);

const patchCalendarBody = z.object({
  status: z.enum(["active", "paused"]).optional(),
  autoRecord: z.enum(CALENDAR_AUTO_RECORD_MODES as [string, ...string[]]).optional(),
  notetakerEmployeeId: z.string().uuid().nullable().optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
});

meetingsRouter.patch(
  "/meetings/calendars/:id",
  validateBody(patchCalendarBody),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof patchCalendarBody>;
    let account;
    try {
      account = await updateCalendarAccount(cid(req), (req.params as Record<string, string>).id, {
        status: body.status,
        autoRecord: body.autoRecord as "off" | "external" | "all" | undefined,
        notetakerEmployeeId: body.notetakerEmployeeId,
        windowDays: body.windowDays,
      });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "Could not update calendar." });
      return;
    }
    if (!account) {
      res.status(404).json({ error: "Calendar not found." });
      return;
    }
    res.json({ calendar: serializeCalendarAccount(account) });
  }),
);

meetingsRouter.delete(
  "/meetings/calendars/:id",
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const removed = await deleteCalendarAccount(cid(req), id);
    if (!removed) {
      res.status(404).json({ error: "Calendar not found." });
      return;
    }
    await recordAudit({
      companyId: cid(req),
      actorUserId: userId(req),
      action: "meetings.calendar.disconnect",
      targetType: "calendar",
      targetId: id,
    });
    res.json({ ok: true });
  }),
);

meetingsRouter.post(
  "/meetings/calendars/:id/sync",
  h(async (req, res) => {
    const account = await getCalendarAccount(cid(req), (req.params as Record<string, string>).id);
    if (!account) {
      res.status(404).json({ error: "Calendar not found." });
      return;
    }
    try {
      const result = await syncCalendarAccount(account);
      const armed = await armMeetingsForAccount(account);
      res.json({ ...result, armed });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Sync failed." });
    }
  }),
);

// ───────────────────────────── agenda ─────────────────────────────

const eventsQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  accountId: z.string().uuid().optional(),
});

meetingsRouter.get(
  "/meetings/events",
  h(async (req, res) => {
    const parsed = eventsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid date range." });
      return;
    }
    const now = new Date();
    const from = parsed.data.from ? new Date(parsed.data.from) : now;
    const to = parsed.data.to
      ? new Date(parsed.data.to)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const qb = AppDataSource.getRepository(CalendarEvent)
      .createQueryBuilder("event")
      .where("event.companyId = :cid", { cid: cid(req) })
      .andWhere("event.status != :cancelled", { cancelled: "cancelled" })
      .andWhere("event.startAt < :to AND event.endAt > :from", { from, to })
      .orderBy("event.startAt", "ASC")
      .take(500);
    if (parsed.data.accountId) {
      qb.andWhere("event.accountId = :accountId", { accountId: parsed.data.accountId });
    }
    const events = await qb.getMany();
    res.json({ events: events.map(serializeCalendarEvent) });
  }),
);

// ───────────────────────────── AI access ─────────────────────────────

meetingsRouter.get(
  "/meetings/ai-access",
  h(async (req, res) => {
    res.json({ grants: await listCalendarGrants(cid(req)) });
  }),
);

const grantBody = z.object({
  employeeId: z.string().uuid(),
  accountId: z.string().uuid(),
  accessLevel: z.enum(CALENDAR_ACCESS_LEVELS as [string, ...string[]]),
});

meetingsRouter.put(
  "/meetings/ai-access",
  validateBody(grantBody),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof grantBody>;
    try {
      await upsertCalendarGrant({
        companyId: cid(req),
        employeeId: body.employeeId,
        accountId: body.accountId,
        accessLevel: body.accessLevel as "read" | "record",
      });
      res.json({ grants: await listCalendarGrants(cid(req)) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Could not save grant." });
    }
  }),
);

const revokeBody = z.object({
  employeeId: z.string().uuid(),
  accountId: z.string().uuid(),
});

meetingsRouter.post(
  "/meetings/ai-access/revoke",
  validateBody(revokeBody),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof revokeBody>;
    await deleteCalendarGrant({ companyId: cid(req), ...body });
    res.json({ grants: await listCalendarGrants(cid(req)) });
  }),
);

// ───────────────────────────── meetings ─────────────────────────────

const listQuery = z.object({
  status: z
    .enum(["scheduled", "joining", "recording", "processing", "ready", "failed", "skipped"])
    .optional(),
  customerId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

meetingsRouter.get(
  "/meetings",
  h(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid filter." });
      return;
    }
    const rows = await listMeetings(cid(req), parsed.data);
    res.json({ meetings: rows.map(serializeMeeting) });
  }),
);

const createMeetingBody = z.object({
  title: z.string().min(1).max(300),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  conferenceUrl: z.string().url().max(2000).optional().or(z.literal("")),
  notetakerEmployeeId: z.string().uuid().nullable().optional(),
  attendeeEmails: z.array(z.string().max(320)).max(100).optional(),
});

const meetingIdParams = z
  .object({
    cid: z.string().uuid(),
    id: z.string().uuid(),
  })
  .strict();

meetingsRouter.post(
  "/meetings",
  validateBody(createMeetingBody),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof createMeetingBody>;
    const meeting = await createAdHocMeeting({
      companyId: cid(req),
      title: body.title,
      scheduledStartAt: body.scheduledStartAt ? new Date(body.scheduledStartAt) : null,
      conferenceUrl: body.conferenceUrl ?? "",
      notetakerEmployeeId: body.notetakerEmployeeId ?? null,
      createdByUserId: userId(req),
      attendeeEmails: body.attendeeEmails,
    });
    res.status(201).json({ meeting: serializeMeeting(meeting) });
  }),
);

meetingsRouter.get(
  "/meetings/:id",
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const meeting = await getMeeting(cid(req), id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found." });
      return;
    }
    const [participants, segments] = await Promise.all([
      listParticipants(cid(req), id),
      listTranscriptSegments(cid(req), id),
    ]);
    res.json({
      meeting: serializeMeeting(meeting),
      participants: participants.map(serializeParticipant),
      transcript: segments.map(serializeSegment),
    });
  }),
);

meetingsRouter.post(
  "/meetings/:id/recording",
  acceptRecording,
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "No recording was uploaded." });
      return;
    }
    // The operator's cap, read live rather than frozen into multer at boot.
    const maxRecordingBytes = getMeetingsSettings().maxRecordingBytes;
    if (file.buffer.length > maxRecordingBytes) {
      const mb = Math.round(maxRecordingBytes / (1024 * 1024));
      res.status(400).json({ error: `Recordings are limited to ${mb} MB.` });
      return;
    }
    const result = await attachRecording({
      companyId: cid(req),
      meetingId: id,
      bytes: file.buffer,
      mime: file.mimetype,
      filename: file.originalname,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    // Transcription is minutes of work; the client watches `transcriptState`.
    processMeetingInBackground(cid(req), id);
    const meeting = await getMeeting(cid(req), id);
    res.json({ meeting: meeting ? serializeMeeting(meeting) : null });
  }),
);

const transcriptBody = z.object({ text: z.string().min(1).max(2_000_000) });

meetingsRouter.post(
  "/meetings/:id/transcript",
  validateBody(transcriptBody),
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const body = req.body as z.infer<typeof transcriptBody>;
    const result = await attachTranscript({ companyId: cid(req), meetingId: id, text: body.text });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    processMeetingInBackground(cid(req), id);
    const meeting = await getMeeting(cid(req), id);
    res.json({ meeting: meeting ? serializeMeeting(meeting) : null });
  }),
);

const attendeesBody = z.object({
  emails: z.array(z.string().max(320)).min(1).max(100),
});

meetingsRouter.post(
  "/meetings/:id/attendees",
  validateBody(attendeesBody),
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    const meeting = await getMeeting(cid(req), id);
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found." });
      return;
    }
    const body = req.body as z.infer<typeof attendeesBody>;
    const added = await addParticipants(meeting, body.emails);
    // A new attendee is exactly the case where re-linking pays off: the person
    // may already be a Contact, and the call belongs on their timeline now.
    if (meeting.transcriptText.trim()) await linkMeeting(cid(req), id);
    const participants = await listParticipants(cid(req), id);
    res.json({ added, participants: participants.map(serializeParticipant) });
  }),
);

meetingsRouter.post(
  "/meetings/:id/process",
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    if (!(await getMeeting(cid(req), id))) {
      res.status(404).json({ error: "Meeting not found." });
      return;
    }
    const result = await processMeeting(cid(req), id);
    const meeting = await getMeeting(cid(req), id);
    res.json({ result, meeting: meeting ? serializeMeeting(meeting) : null });
  }),
);

meetingsRouter.post(
  "/meetings/:id/link",
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    if (!(await getMeeting(cid(req), id))) {
      res.status(404).json({ error: "Meeting not found." });
      return;
    }
    res.json({ result: await linkMeeting(cid(req), id) });
  }),
);

meetingsRouter.post(
  "/meetings/:id/notetaker",
  h(async (req, res) => {
    const id = (req.params as Record<string, string>).id;
    // This route is an explicit human retry. Automatic dispatch never retries
    // failed rows on its own, but the meeting page deliberately offers the
    // button again after a recoverable admission or host-runtime failure.
    const result = await startNotetaker({ companyId: cid(req), meetingId: id, retryFailed: true });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const meeting = await getMeeting(cid(req), id);
    res.json({ meeting: meeting ? serializeMeeting(meeting) : null });
  }),
);

meetingsRouter.post(
  "/meetings/:id/notetaker/stop",
  validateParams(meetingIdParams),
  h(async (req, res) => {
    const id = (req.params as z.infer<typeof meetingIdParams>).id;
    const result = await stopNotetaker({ companyId: cid(req), meetingId: id });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const meeting = await getMeeting(cid(req), id);
    res.json({ meeting: meeting ? serializeMeeting(meeting) : null });
  }),
);

meetingsRouter.get(
  "/meetings/:id/recording",
  h(async (req, res) => {
    const meeting = await getMeeting(cid(req), (req.params as Record<string, string>).id);
    if (!meeting || !meeting.recordingPath) {
      res.status(404).json({ error: "No recording on this meeting." });
      return;
    }
    const bytes = readRecording(meeting.recordingPath);
    if (!bytes) {
      res.status(404).json({ error: "The stored recording is missing from disk." });
      return;
    }
    res.setHeader("Content-Type", meeting.recordingMime || "application/octet-stream");
    res.setHeader("Content-Length", String(bytes.length));
    res.send(bytes);
  }),
);
