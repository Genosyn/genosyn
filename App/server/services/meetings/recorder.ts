import { randomUUID } from "node:crypto";

import type { UpdateQueryBuilder } from "typeorm";

import { config } from "../../../config.js";
import { getMeetingsSettings } from "../runtimeSettings.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { companyDomains } from "./domains.js";
import { hasCalendarAccess } from "./grants.js";
import { processMeetingInBackground } from "./pipeline.js";
import {
  deleteRecording,
  isSupportedRecordingMime,
  mimeForFilename,
  writeRecording,
} from "./storage.js";
import { replaceTranscript } from "./store.js";
import { shouldAutoRecord } from "./store.js";

/**
 * How a meeting gets its audio.
 *
 * The driver owns the conference-specific browser work. This service owns the
 * durable lifecycle around it: one database claim, cancellation, storage, and
 * handing the finished recording to the processing pipeline.
 */
export type MeetingRecorder = {
  /** Stable id shown in logs and in the meeting's `recordingSource`. */
  readonly id: "notetaker";
  /** Can this recorder join the given conference URL right now? */
  canJoin(conferenceUrl: string): boolean;
  /** Join and record. Storage remains Genosyn's responsibility. */
  join(args: {
    companyId: string;
    meetingId: string;
    conferenceUrl: string;
    displayName: string;
    scheduledEndAt: Date | null;
    signal: AbortSignal;
    onJoined: () => Promise<void>;
  }): Promise<{ bytes: Buffer; mime: string; durationMs: number }>;
};

let recorder: MeetingRecorder | null = null;

/**
 * Install a join-capable recorder. Called at boot by whatever ships one; with
 * nothing registered, the meeting flow reports that joining is unavailable
 * rather than failing obscurely.
 */
export function registerMeetingRecorder(next: MeetingRecorder | null): void {
  recorder = next;
}

export function activeMeetingRecorder(): MeetingRecorder | null {
  return recorder;
}

/** Why a meeting cannot be joined, in a sentence a human can act on. */
export const NO_RECORDER_MESSAGE =
  "This deployment has no notetaker that can join a call. Upload the recording or paste the transcript instead.";

const NOTETAKER_JOIN_LEAD_MS = 30_000;
const ACTIVE_HEARTBEAT_MS = 15_000;
const ACTIVE_STALE_MS = 60_000;
const MAX_DUE_PER_PASS = 50;

type ActiveNotetaker = {
  controller: AbortController;
  heartbeat: NodeJS.Timeout | null;
  done: Promise<void>;
  automatic: boolean;
  claimed: Meeting;
  conferenceUrl: string;
  isLeaseHeld: () => boolean;
  leaseHolderId: string | null;
  heartbeatRunning: boolean;
  stopKind: "human" | "policy" | null;
};

/** Recorder calls currently owned by this App process. */
const activeNotetakers = new Map<string, ActiveNotetaker>();

const MEETING_LEASE_TTL_MS = 45_000;
export const STOP_NOTETAKER_MESSAGE = "A Member asked the notetaker to stop.";
const LEASE_LOST_MESSAGE = "The notetaker lost ownership of this meeting recording.";
const POLICY_STOP_PREFIX = "Notetaker stopping: ";

function meetingLeaseName(meetingId: string): string {
  return `meeting-notetaker:${meetingId}`;
}

type MeetingLeaseFence = Pick<ActiveNotetaker, "claimed" | "isLeaseHeld" | "leaseHolderId">;

/** Atomically fence a meeting write against the current Postgres lease row. */
function fenceMeetingUpdate(
  query: UpdateQueryBuilder<Meeting>,
  fence: MeetingLeaseFence | undefined,
): UpdateQueryBuilder<Meeting> {
  if (config.db.driver !== "postgres" || !fence?.leaseHolderId) return query;
  return query.andWhere(
    `EXISTS (
      SELECT 1 FROM "scheduler_leases" lease
      WHERE lease."name" = :meetingLeaseName
        AND lease."holderId" = :meetingLeaseHolder
        AND lease."expiresAt" > CURRENT_TIMESTAMP
    )`,
    {
      meetingLeaseName: meetingLeaseName(fence.claimed.id),
      meetingLeaseHolder: fence.leaseHolderId,
    },
  );
}

let backgroundProcessor = processMeetingInBackground;

/** A narrow test seam; production always leaves the default pipeline installed. */
export function setMeetingBackgroundProcessor(
  next: typeof processMeetingInBackground = processMeetingInBackground,
): void {
  backgroundProcessor = next;
}

export type IngestResult = { ok: true } | { ok: false; error: string };

/**
 * Attach a recording to a meeting.
 *
 * Refuses an unrecognised type rather than storing bytes it cannot name — the
 * `resources.ts` sniffer's habit of falling through to `text` and UTF-8
 * decoding a binary is the exact bug this check exists to avoid repeating.
 */
export async function attachRecording(args: {
  companyId: string;
  meetingId: string;
  bytes: Buffer;
  mime: string;
  filename: string;
}): Promise<IngestResult> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: args.meetingId, companyId: args.companyId });
  if (!meeting) return { ok: false, error: "Meeting not found." };

  if (args.bytes.length === 0) return { ok: false, error: "The uploaded recording is empty." };
  const maxRecordingBytes = getMeetingsSettings().maxRecordingBytes;
  if (args.bytes.length > maxRecordingBytes) {
    const mb = Math.round(maxRecordingBytes / (1024 * 1024));
    return { ok: false, error: `Recordings are limited to ${mb} MB.` };
  }

  const mime = isSupportedRecordingMime(args.mime)
    ? args.mime.toLowerCase()
    : mimeForFilename(args.filename);
  if (!mime) {
    return {
      ok: false,
      error:
        "That file type is not a recording we can read. Upload mp3, m4a, wav, webm, ogg, flac, mp4, or mov.",
    };
  }

  const recordingPath = writeRecording({
    companyId: args.companyId,
    meetingId: args.meetingId,
    bytes: args.bytes,
    mime,
    candidateId: `upload-${randomUUID()}`,
  });

  let published;
  try {
    published = await repo
      .createQueryBuilder()
      .update()
      .set({
        recordingPath,
        recordingMime: mime,
        recordingBytes: args.bytes.length,
        recordingSource: "upload",
        status: "processing",
        statusMessage: "",
        transcriptState: "queued",
        transcriptError: "",
        endedAt: meeting.endedAt ?? new Date(),
      })
      .where("id = :meetingId", { meetingId: args.meetingId })
      .andWhere("companyId = :companyId", { companyId: args.companyId })
      .andWhere("recordingPath = :expectedPath", { expectedPath: meeting.recordingPath })
      .execute();
  } catch (err) {
    deleteRecording(recordingPath);
    throw err;
  }
  if ((published.affected ?? 0) !== 1) {
    deleteRecording(recordingPath);
    return { ok: false, error: "The meeting recording changed while this upload was saving." };
  }
  abortActiveNotetaker(args.meetingId, "A Member uploaded a replacement recording.");
  if (meeting.recordingPath && meeting.recordingPath !== recordingPath) {
    deleteRecording(meeting.recordingPath);
  }
  return { ok: true };
}

/**
 * Attach a transcript somebody already has.
 *
 * The most useful path in the whole feature for a deployment with no
 * transcription backend at all: paste what Zoom or Meet produced and every
 * downstream step — linking, the AI write-up, the follow-up queue — runs
 * exactly as it would have.
 *
 * Lines shaped `Speaker: words` are split into speaker and text, because that
 * is what every conferencing tool emits and losing it would flatten a
 * conversation into a wall. Anything else becomes an unattributed line, which
 * is honest.
 */
export async function attachTranscript(args: {
  companyId: string;
  meetingId: string;
  text: string;
}): Promise<IngestResult> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: args.meetingId, companyId: args.companyId });
  if (!meeting) return { ok: false, error: "Meeting not found." };
  if (!args.text.trim()) return { ok: false, error: "The transcript is empty." };

  const segments = parseTranscriptText(args.text);
  if (segments.length === 0) return { ok: false, error: "The transcript is empty." };

  await replaceTranscript({
    companyId: args.companyId,
    meetingId: args.meetingId,
    segments,
  });
  // A partial UPDATE, not `repo.save(meeting)`. `replaceTranscript` has just
  // written `transcriptText` straight to the row, and saving the entity we
  // loaded *before* that would write its stale empty copy back over it — which
  // then makes the pipeline report "no transcript" on a meeting whose
  // transcript is visibly right there on the page.
  await repo.update(
    { id: args.meetingId },
    {
      recordingSource: meeting.recordingSource === "none" ? "transcript" : meeting.recordingSource,
      status: "processing",
      statusMessage: "",
      endedAt: meeting.endedAt ?? new Date(),
    },
  );
  abortActiveNotetaker(args.meetingId, "A Member supplied a transcript for this meeting.");
  return { ok: true };
}

/**
 * `Speaker: words` per line, with a leading `[00:12:34]` timestamp tolerated
 * because Zoom and Teams both emit one.
 *
 * The speaker pattern is deliberately tight — a short run of name-ish
 * characters before the first colon — so that a line like
 * "so the price is: forty" keeps its whole sentence instead of crediting it to
 * a speaker called "so the price is".
 */
const SPEAKER_LINE_RE = /^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s+)?([A-Za-z][-\w .']{0,40}):\s+(.*)$/;

export function parseTranscriptText(
  text: string,
): Array<{ startMs: number; endMs: number; speaker: string; text: string }> {
  const out: Array<{ startMs: number; endMs: number; speaker: string; text: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = SPEAKER_LINE_RE.exec(line);
    if (match) {
      out.push({ startMs: 0, endMs: 0, speaker: match[1].trim(), text: match[2].trim() });
    } else {
      out.push({ startMs: 0, endMs: 0, speaker: "", text: line });
    }
  }
  return out.filter((segment) => segment.text !== "");
}

type JoinValidation =
  | { action: "join"; meeting: Meeting; displayName: string }
  | { action: "defer" | "skip"; message: string };

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Re-read the calendar rows after the durable claim and immediately before
 * opening a browser. The meeting row is intentionally not trusted here: it is
 * a materialised plan, while the account and event rows carry the latest sync
 * and policy choices.
 */
async function validateClaimedJoin(
  claimed: Meeting,
  automatic: boolean,
  now = new Date(),
  fence?: MeetingLeaseFence,
): Promise<JoinValidation> {
  const isLeaseHeld = fence?.isLeaseHeld ?? (() => true);
  if (!isLeaseHeld()) return { action: "skip", message: LEASE_LOST_MESSAGE };
  const repo = AppDataSource.getRepository(Meeting);
  const durableClaim = await repo.findOneBy({ id: claimed.id, companyId: claimed.companyId });
  if (!durableClaim || !["joining", "recording"].includes(durableClaim.status)) {
    return { action: "skip", message: "The notetaker claim is no longer active." };
  }
  if (durableClaim.statusMessage === STOP_NOTETAKER_MESSAGE) {
    return { action: "skip", message: STOP_NOTETAKER_MESSAGE };
  }
  claimed = durableClaim;

  // A manually created meeting has no upstream policy to revalidate. This is
  // the ad-hoc path that existed before automatic dispatch and stays useful
  // even with no connected calendar.
  if (!claimed.calendarEventId || !claimed.accountId) {
    if (!claimed.conferenceUrl) {
      return { action: "skip", message: "This meeting has no conference link to join." };
    }
    const employee = claimed.notetakerEmployeeId
      ? await AppDataSource.getRepository(AIEmployee).findOneBy({
          id: claimed.notetakerEmployeeId,
          companyId: claimed.companyId,
        })
      : null;
    return {
      action: "join",
      meeting: claimed,
      displayName: employee?.name || "Genosyn Notetaker",
    };
  }

  const [account, event] = await Promise.all([
    AppDataSource.getRepository(CalendarAccount).findOneBy({
      id: claimed.accountId,
      companyId: claimed.companyId,
    }),
    AppDataSource.getRepository(CalendarEvent).findOneBy({
      id: claimed.calendarEventId,
      companyId: claimed.companyId,
      accountId: claimed.accountId,
    }),
  ]);
  if (!account || !event) {
    return { action: "skip", message: "The calendar or event is no longer connected." };
  }
  if (event.status !== "confirmed") {
    return { action: "skip", message: "The calendar event was cancelled or declined." };
  }
  if (event.allDay || !event.conferenceUrl) {
    return { action: "skip", message: "The calendar event no longer has a joinable call." };
  }
  if (automatic && event.conferenceProvider !== "meet") {
    return { action: "skip", message: "Automatic recording currently supports Google Meet only." };
  }
  if (event.endAt <= now) {
    return { action: "skip", message: "The calendar event has already ended." };
  }

  let employeeId = claimed.notetakerEmployeeId;
  if (automatic) {
    if (account.status === "paused") {
      return { action: "skip", message: "Automatic recording is paused for this calendar." };
    }
    if (account.status === "error") {
      const message = "Waiting for this calendar to sync successfully before joining.";
      if (!isLeaseHeld()) return { action: "skip", message: LEASE_LOST_MESSAGE };
      const deferUpdate = repo
        .createQueryBuilder()
        .update()
        .set({
          status: "scheduled",
          statusMessage: message,
          startedAt: null,
          endedAt: null,
        })
        .where("id = :id", { id: claimed.id })
        .andWhere("companyId = :companyId", { companyId: claimed.companyId })
        .andWhere("status = :status", { status: "joining" });
      await fenceMeetingUpdate(deferUpdate, fence).execute();
      return { action: "defer", message };
    }
    const domains = await companyDomains(claimed.companyId);
    if (!shouldAutoRecord({ account, event, domains })) {
      return { action: "skip", message: "Automatic recording was turned off for this event." };
    }
    employeeId = account.notetakerEmployeeId;
    if (event.startAt.getTime() > now.getTime() + NOTETAKER_JOIN_LEAD_MS) {
      if (!isLeaseHeld()) return { action: "skip", message: LEASE_LOST_MESSAGE };
      const rescheduleUpdate = repo
        .createQueryBuilder()
        .update()
        .set({
          title: event.summary || claimed.title,
          scheduledStartAt: event.startAt,
          scheduledEndAt: event.endAt,
          conferenceProvider: event.conferenceProvider,
          conferenceUrl: event.conferenceUrl,
          notetakerEmployeeId: employeeId,
          status: "scheduled",
          statusMessage: "The calendar event was rescheduled.",
          startedAt: null,
          endedAt: null,
        })
        .where("id = :id", { id: claimed.id })
        .andWhere("companyId = :companyId", { companyId: claimed.companyId })
        .andWhere("status = :status", { status: "joining" });
      await fenceMeetingUpdate(rescheduleUpdate, fence).execute();
      return { action: "defer", message: "The calendar event was rescheduled." };
    }
  }
  if (!employeeId || !(await hasCalendarAccess(employeeId, account.id, "record"))) {
    return {
      action: "skip",
      message: "The assigned AI Employee does not have Record access to this calendar.",
    };
  }

  const current = repo.create({
    ...claimed,
    title: event.summary || claimed.title,
    scheduledStartAt: event.startAt,
    scheduledEndAt: event.endAt,
    conferenceProvider: event.conferenceProvider,
    conferenceUrl: event.conferenceUrl,
    notetakerEmployeeId: employeeId,
  });
  if (!isLeaseHeld()) return { action: "skip", message: LEASE_LOST_MESSAGE };
  const refreshUpdate = repo
    .createQueryBuilder()
    .update()
    .set({
      title: current.title,
      scheduledStartAt: current.scheduledStartAt,
      scheduledEndAt: current.scheduledEndAt,
      conferenceProvider: current.conferenceProvider,
      conferenceUrl: current.conferenceUrl,
      notetakerEmployeeId: current.notetakerEmployeeId,
    })
    .where("id = :id", { id: claimed.id })
    .andWhere("companyId = :companyId", { companyId: claimed.companyId })
    .andWhere("status = :status", { status: "joining" });
  const refreshed = await fenceMeetingUpdate(refreshUpdate, fence).execute();
  if ((refreshed.affected ?? 0) !== 1) {
    return { action: "skip", message: "The notetaker claim is no longer active." };
  }
  const employee = employeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: employeeId,
        companyId: claimed.companyId,
      })
    : null;
  return {
    action: "join",
    meeting: current,
    displayName: employee?.name || "Genosyn Notetaker",
  };
}

async function settleClaim(
  claimed: Pick<Meeting, "id" | "companyId">,
  status: "failed" | "skipped",
  message: string,
  fence?: MeetingLeaseFence,
): Promise<void> {
  if (fence && !fence.isLeaseHeld()) return;
  const endedAt = status === "failed" ? new Date() : undefined;
  const query = AppDataSource.getRepository(Meeting)
    .createQueryBuilder()
    .update()
    .set({ status, statusMessage: message.slice(0, 500), ...(endedAt ? { endedAt } : {}) })
    .where("id = :id", { id: claimed.id })
    .andWhere("companyId = :companyId", { companyId: claimed.companyId })
    .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] });
  await fenceMeetingUpdate(query, fence).execute();
}

async function activePolicyViolation(active: ActiveNotetaker): Promise<string | null> {
  const meeting = await AppDataSource.getRepository(Meeting).findOneBy({
    id: active.claimed.id,
    companyId: active.claimed.companyId,
  });
  if (!meeting || !["joining", "recording"].includes(meeting.status)) {
    return "The meeting is no longer recording.";
  }
  if (meeting.statusMessage === STOP_NOTETAKER_MESSAGE) return STOP_NOTETAKER_MESSAGE;
  if (meeting.statusMessage.startsWith(POLICY_STOP_PREFIX)) return meeting.statusMessage;
  if (!meeting.calendarEventId || !meeting.accountId) return null;

  const [account, event] = await Promise.all([
    AppDataSource.getRepository(CalendarAccount).findOneBy({
      id: meeting.accountId,
      companyId: meeting.companyId,
    }),
    AppDataSource.getRepository(CalendarEvent).findOneBy({
      id: meeting.calendarEventId,
      accountId: meeting.accountId,
      companyId: meeting.companyId,
    }),
  ]);
  if (!account || !event) return "The calendar or event was disconnected.";
  if (event.status !== "confirmed") return "The calendar event was cancelled.";
  if (event.endAt <= new Date()) return "The calendar event ended.";
  if (event.conferenceProvider !== "meet" || event.conferenceUrl !== active.conferenceUrl) {
    return "The conference link changed or is no longer a supported Google Meet link.";
  }

  let employeeId = meeting.notetakerEmployeeId;
  if (active.automatic) {
    if (account.status === "paused") return "Automatic recording was paused for this calendar.";
    const domains = await companyDomains(meeting.companyId);
    if (!shouldAutoRecord({ account, event, domains })) {
      return "Automatic recording was turned off for this event.";
    }
    employeeId = account.notetakerEmployeeId;
    if (employeeId !== meeting.notetakerEmployeeId) {
      return "The calendar's assigned notetaker changed.";
    }
  }
  if (!employeeId || !(await hasCalendarAccess(employeeId, account.id, "record"))) {
    return "The assigned AI Employee no longer has Record access to this calendar.";
  }
  return null;
}

async function pulseActiveNotetaker(active: ActiveNotetaker): Promise<void> {
  if (active.heartbeatRunning) return;
  active.heartbeatRunning = true;
  try {
    if (!active.isLeaseHeld()) {
      active.controller.abort(new Error(LEASE_LOST_MESSAGE));
      return;
    }
    const violation = await activePolicyViolation(active);
    if (!active.isLeaseHeld()) {
      active.controller.abort(new Error(LEASE_LOST_MESSAGE));
      return;
    }
    if (violation) {
      active.stopKind = violation === STOP_NOTETAKER_MESSAGE ? "human" : "policy";
      if (violation !== STOP_NOTETAKER_MESSAGE && !violation.startsWith(POLICY_STOP_PREFIX)) {
        const stopUpdate = AppDataSource.getRepository(Meeting)
          .createQueryBuilder()
          .update()
          .set({ statusMessage: `${POLICY_STOP_PREFIX}${violation}`.slice(0, 500) })
          .where("id = :meetingId", { meetingId: active.claimed.id })
          .andWhere("companyId = :companyId", { companyId: active.claimed.companyId })
          .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] });
        await fenceMeetingUpdate(stopUpdate, active).execute();
      }
      active.controller.abort(new Error(violation));
      return;
    }
    const heartbeatUpdate = AppDataSource.getRepository(Meeting)
      .createQueryBuilder()
      .update()
      .set({ updatedAt: new Date() })
      .where("id = :meetingId", { meetingId: active.claimed.id })
      .andWhere("companyId = :companyId", { companyId: active.claimed.companyId })
      .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] });
    await fenceMeetingUpdate(heartbeatUpdate, active).execute();
  } finally {
    active.heartbeatRunning = false;
  }
}

function beginHeartbeat(active: ActiveNotetaker): NodeJS.Timeout {
  const heartbeat = setInterval(() => {
    void pulseActiveNotetaker(active).catch((err) => {
      // A failed authority check is unsafe: stop, and let the lifecycle's
      // terminal catch report any later persistence failure.
      active.controller.abort(new Error(`Notetaker policy heartbeat failed: ${errorMessage(err)}`));
    });
  }, ACTIVE_HEARTBEAT_MS);
  heartbeat.unref();
  return heartbeat;
}

/** Run policy/ownership checks immediately (also a deterministic test seam). */
export async function checkActiveNotetakersNow(): Promise<void> {
  await Promise.all([...activeNotetakers.values()].map((active) => pulseActiveNotetaker(active)));
}

/** Test-only ownership-loss seam; production ownership comes from SchedulerLease. */
export function setActiveNotetakerLeaseHeldForTests(meetingId: string, held: boolean): boolean {
  const active = activeNotetakers.get(meetingId);
  if (!active) return false;
  active.isLeaseHeld = () => held;
  return true;
}

async function runClaimedNotetaker(
  claimed: Meeting,
  driver: MeetingRecorder,
  active: ActiveNotetaker,
  now?: Date,
): Promise<void> {
  let recordingPath = "";
  let joinedAt: Date | null = null;
  try {
    const validation = await validateClaimedJoin(claimed, active.automatic, now, active);
    if (validation.action !== "join") {
      if (validation.action === "skip") {
        await settleClaim(
          claimed,
          validation.message === STOP_NOTETAKER_MESSAGE || active.automatic ? "skipped" : "failed",
          validation.message,
          active,
        );
      }
      return;
    }

    const current = validation.meeting;
    active.conferenceUrl = current.conferenceUrl;
    if (!driver.canJoin(current.conferenceUrl)) {
      throw new Error("The built-in notetaker cannot join this conference link.");
    }
    if (!active.isLeaseHeld()) throw new Error(LEASE_LOST_MESSAGE);
    if (active.controller.signal.aborted) {
      throw active.controller.signal.reason ?? new Error("The notetaker was stopped.");
    }

    const result = await driver.join({
      companyId: current.companyId,
      meetingId: current.id,
      conferenceUrl: current.conferenceUrl,
      displayName: validation.displayName,
      scheduledEndAt: current.scheduledEndAt,
      signal: active.controller.signal,
      onJoined: async () => {
        if (!active.isLeaseHeld()) throw new Error(LEASE_LOST_MESSAGE);
        const candidateJoinedAt = new Date();
        const joinedUpdate = AppDataSource.getRepository(Meeting)
          .createQueryBuilder()
          .update()
          .set({ status: "recording", startedAt: candidateJoinedAt })
          .where("id = :id", { id: current.id })
          .andWhere("companyId = :companyId", { companyId: current.companyId })
          .andWhere("status = :status", { status: "joining" })
          // A remote Stop can land while the guest is in Google's lobby.
          // Never turn that durable request back into `recording` merely
          // because admission and the heartbeat raced one another.
          .andWhere("statusMessage = :emptyStatusMessage", { emptyStatusMessage: "" });
        const joined = await fenceMeetingUpdate(joinedUpdate, active).execute();
        if ((joined.affected ?? 0) !== 1) {
          const durable = await AppDataSource.getRepository(Meeting).findOneBy({
            id: current.id,
            companyId: current.companyId,
          });
          if (durable?.statusMessage === STOP_NOTETAKER_MESSAGE) {
            throw new Error(STOP_NOTETAKER_MESSAGE);
          }
          if (durable?.statusMessage.startsWith(POLICY_STOP_PREFIX)) {
            throw new Error(durable.statusMessage);
          }
          throw new Error("The notetaker claim is no longer active.");
        }
        joinedAt ??= candidateJoinedAt;
      },
    });
    // A driver may finalize a valid partial recording while handling abort.
    // Preserve those bytes; the signal only means "leave the call", not
    // "discard everything already captured".
    if (result.bytes.length === 0) throw new Error("The notetaker returned an empty recording.");
    const maxRecordingBytes = getMeetingsSettings().maxRecordingBytes;
    if (result.bytes.length > maxRecordingBytes) {
      const mb = Math.round(maxRecordingBytes / (1024 * 1024));
      throw new Error(`Recordings are limited to ${mb} MB.`);
    }
    const mime = result.mime.toLowerCase();
    if (!isSupportedRecordingMime(mime)) {
      throw new Error(`The notetaker returned an unsupported recording type (${result.mime}).`);
    }
    if (!active.isLeaseHeld()) throw new Error(LEASE_LOST_MESSAGE);

    recordingPath = writeRecording({
      companyId: current.companyId,
      meetingId: current.id,
      bytes: result.bytes,
      mime,
      candidateId: `notetaker-${randomUUID()}`,
    });
    if (!active.isLeaseHeld()) {
      deleteRecording(recordingPath);
      recordingPath = "";
      return;
    }
    const finalUpdate = AppDataSource.getRepository(Meeting)
      .createQueryBuilder()
      .update()
      .set({
        recordingPath,
        recordingMime: mime,
        recordingBytes: result.bytes.length,
        recordingSource: "notetaker",
        durationMs: Math.max(0, Math.trunc(result.durationMs)),
        status: "processing",
        statusMessage: "",
        transcriptState: "queued",
        transcriptError: "",
        startedAt: joinedAt ?? current.startedAt ?? new Date(),
        endedAt: new Date(),
      })
      .where("id = :id", { id: current.id })
      .andWhere("companyId = :companyId", { companyId: current.companyId })
      .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] });
    const stored = await fenceMeetingUpdate(finalUpdate, active).execute();
    if ((stored.affected ?? 0) !== 1) {
      deleteRecording(recordingPath);
      return;
    }
    recordingPath = "";
    try {
      backgroundProcessor(current.companyId, current.id);
    } catch (err) {
      // The durable `processing` row is enough for the ordinary heartbeat to
      // retry. Never discard a published recording because wake-up failed.
      // eslint-disable-next-line no-console
      console.error(`[meetings] could not wake processing for ${current.id}:`, err);
    }
  } catch (err) {
    if (recordingPath) deleteRecording(recordingPath);
    if (!active.isLeaseHeld()) return;
    const reason = active.controller.signal.aborted
      ? errorMessage(active.controller.signal.reason ?? "The notetaker was stopped.")
      : errorMessage(err);
    const stoppedBeforeAdmission =
      joinedAt === null &&
      (active.stopKind !== null ||
        reason === STOP_NOTETAKER_MESSAGE ||
        reason.startsWith(POLICY_STOP_PREFIX));
    await settleClaim(claimed, stoppedBeforeAdmission ? "skipped" : "failed", reason, active);
  } finally {
    const registered = activeNotetakers.get(claimed.id);
    if (registered?.controller === active.controller) {
      if (active.heartbeat) clearInterval(active.heartbeat);
      activeNotetakers.delete(claimed.id);
    }
  }
}

async function claimNotetaker(args: {
  companyId: string;
  meetingId: string;
  retryFailed: boolean;
}): Promise<Meeting | null> {
  const query = AppDataSource.getRepository(Meeting)
    .createQueryBuilder()
    .update()
    .set({
      status: "joining",
      statusMessage: "",
      startedAt: null,
      endedAt: null,
    })
    .where("id = :meetingId", { meetingId: args.meetingId })
    .andWhere("companyId = :companyId", { companyId: args.companyId });
  if (args.retryFailed) {
    query.andWhere("(status = :scheduled OR (status = :failed AND recordingPath = :empty))", {
      scheduled: "scheduled",
      failed: "failed",
      empty: "",
    });
  } else {
    query.andWhere("status = :scheduled", { scheduled: "scheduled" });
  }
  const claimed = await query.execute();
  if ((claimed.affected ?? 0) !== 1) return null;
  return AppDataSource.getRepository(Meeting).findOneBy({
    id: args.meetingId,
    companyId: args.companyId,
  });
}

async function startNotetakerInternal(args: {
  companyId: string;
  meetingId: string;
  retryFailed: boolean;
  automatic: boolean;
  now?: Date;
}): Promise<IngestResult> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: args.meetingId, companyId: args.companyId });
  if (!meeting) return { ok: false, error: "Meeting not found." };
  if (!meeting.conferenceUrl && !meeting.calendarEventId) {
    return { ok: false, error: "This meeting has no conference link to join." };
  }

  const driver = activeMeetingRecorder();
  const claimed = await claimNotetaker(args);
  if (!claimed) {
    return {
      ok: false,
      error: "This meeting is not scheduled, or another notetaker already claimed it.",
    };
  }
  if (!driver) {
    await settleClaim(claimed, "failed", NO_RECORDER_MESSAGE);
    return { ok: false, error: NO_RECORDER_MESSAGE };
  }

  const controller = new AbortController();
  const active: ActiveNotetaker = {
    controller,
    heartbeat: null,
    done: Promise.resolve(),
    automatic: args.automatic,
    claimed,
    conferenceUrl: claimed.conferenceUrl,
    isLeaseHeld: () => false,
    leaseHolderId: null,
    heartbeatRunning: false,
    stopKind: null,
  };
  activeNotetakers.set(claimed.id, active);
  // Deliberately not awaited. The shared due-dispatch lease ends after the
  // durable claim. A distinct per-meeting lease fences this one recording from
  // stale owners for the duration of the call.
  active.done = withSchedulerLease(
    meetingLeaseName(claimed.id),
    MEETING_LEASE_TTL_MS,
    async (lease) => {
      active.isLeaseHeld = lease.isHeld;
      active.leaseHolderId = lease.holderId;
      active.heartbeat = beginHeartbeat(active);
      await runClaimedNotetaker(claimed, driver, active, args.now);
    },
  )
    .then(() => undefined)
    .catch((err) => {
      // Terminally consume lifecycle failures. `runClaimedNotetaker` persists
      // ordinary adapter errors; this catch covers a failed settle/cleanup.
      // eslint-disable-next-line no-console
      console.error(`[meetings] notetaker lifecycle failed for ${claimed.id}:`, err);
    })
    .finally(() => {
      const registered = activeNotetakers.get(claimed.id);
      if (registered?.controller === controller) {
        if (registered.heartbeat) clearInterval(registered.heartbeat);
        activeNotetakers.delete(claimed.id);
      }
    });
  return { ok: true };
}

/**
 * Ask the registered recorder to join a call and return after the atomic
 * claim. A failed join is retried only when the caller says so explicitly;
 * failures with an existing recording belong in `/process`, not in a new call.
 */
export async function startNotetaker(args: {
  companyId: string;
  meetingId: string;
  retryFailed?: boolean;
}): Promise<IngestResult> {
  return startNotetakerInternal({
    ...args,
    retryFailed: args.retryFailed === true,
    automatic: false,
  });
}

/** Durably request that the current recorder leave, across App replicas. */
export async function stopNotetaker(args: {
  companyId: string;
  meetingId: string;
}): Promise<IngestResult> {
  const result = await AppDataSource.getRepository(Meeting)
    .createQueryBuilder()
    .update()
    .set({ statusMessage: STOP_NOTETAKER_MESSAGE })
    .where("id = :meetingId", { meetingId: args.meetingId })
    .andWhere("companyId = :companyId", { companyId: args.companyId })
    .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] })
    .execute();
  if ((result.affected ?? 0) !== 1) {
    return { ok: false, error: "This meeting does not have an active notetaker." };
  }
  const active = activeNotetakers.get(args.meetingId);
  if (active) active.stopKind = "human";
  abortActiveNotetaker(args.meetingId, STOP_NOTETAKER_MESSAGE);
  return { ok: true };
}

/** Stop one in-process recorder. Its lifecycle settles to `failed`. */
export function abortActiveNotetaker(
  meetingId: string,
  reason = "The notetaker was stopped.",
): boolean {
  const active = activeNotetakers.get(meetingId);
  if (!active) return false;
  active.controller.abort(new Error(reason));
  return true;
}

/** Stop every in-process recorder, used by graceful shutdown and tests. */
export function abortAllActiveNotetakers(reason = "The App is shutting down."): number {
  let aborted = 0;
  for (const meetingId of activeNotetakers.keys()) {
    if (abortActiveNotetaker(meetingId, reason)) aborted += 1;
  }
  return aborted;
}

/** Abort active calls and wait briefly for drivers to finalize partial audio. */
export async function shutdownMeetingNotetakers(
  reason = "The App is shutting down.",
  timeoutMs = 10_000,
): Promise<number> {
  const activeIds = [...activeNotetakers.keys()];
  const runs = activeIds.map(
    (meetingId) => activeNotetakers.get(meetingId)?.done ?? Promise.resolve(),
  );
  abortAllActiveNotetakers(reason);
  if (runs.length === 0) return 0;
  let timeout: NodeJS.Timeout | null = null;
  await Promise.race([
    Promise.allSettled(runs),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, Math.max(0, timeoutMs));
      timeout.unref();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return activeIds.filter((meetingId) => !activeNotetakers.has(meetingId)).length;
}

export type NotetakerRecoveryResult = { recovered: number; failed: number };

/**
 * Re-open claims whose owning process disappeared. SQLite is single-process,
 * so every untracked row is stale immediately after boot. Postgres may have a
 * healthy recorder on another replica, whose heartbeat keeps `updatedAt`
 * newer than the conservative stale cutoff.
 */
export async function recoverStaleNotetakers(
  now = new Date(),
  staleAfterMs = config.db.driver === "postgres" ? ACTIVE_STALE_MS : 0,
): Promise<NotetakerRecoveryResult> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const candidates = await AppDataSource.getRepository(Meeting)
    .createQueryBuilder("meeting")
    .where("meeting.status IN (:...statuses)", { statuses: ["joining", "recording"] })
    .andWhere("meeting.updatedAt <= :cutoff", { cutoff })
    .orderBy("meeting.updatedAt", "ASC")
    .take(MAX_DUE_PER_PASS)
    .getMany();

  let recovered = 0;
  let failed = 0;
  for (const meeting of candidates) {
    if (activeNotetakers.has(meeting.id)) continue;
    const recoveredWithLease = await withSchedulerLease(
      meetingLeaseName(meeting.id),
      MEETING_LEASE_TTL_MS,
      async (lease) => {
        const current = await AppDataSource.getRepository(Meeting).findOneBy({
          id: meeting.id,
          companyId: meeting.companyId,
        });
        if (!current || !["joining", "recording"].includes(current.status)) return null;
        const event = current.calendarEventId
          ? await AppDataSource.getRepository(CalendarEvent).findOneBy({
              id: current.calendarEventId,
              companyId: current.companyId,
            })
          : null;
        const stopped = current.statusMessage === STOP_NOTETAKER_MESSAGE;
        const retry = !stopped && Boolean(event && event.endAt > now);
        const recoveryUpdate = AppDataSource.getRepository(Meeting)
          .createQueryBuilder()
          .update()
          .set(
            retry
              ? {
                  title: event?.summary || current.title,
                  scheduledStartAt: event?.startAt ?? current.scheduledStartAt,
                  scheduledEndAt: event?.endAt ?? current.scheduledEndAt,
                  conferenceProvider: event?.conferenceProvider ?? current.conferenceProvider,
                  conferenceUrl: event?.conferenceUrl ?? current.conferenceUrl,
                  status: "scheduled",
                  statusMessage: "The previous notetaker process stopped; retrying the live call.",
                  startedAt: null,
                  endedAt: null,
                }
              : {
                  status: "failed",
                  statusMessage: stopped
                    ? STOP_NOTETAKER_MESSAGE
                    : "The notetaker process stopped before it saved a recording.",
                  endedAt: now,
                },
          )
          .where("id = :id", { id: current.id })
          .andWhere("companyId = :companyId", { companyId: current.companyId })
          .andWhere("status IN (:...statuses)", { statuses: ["joining", "recording"] })
          .andWhere("updatedAt <= :cutoff", { cutoff });
        const result = await fenceMeetingUpdate(recoveryUpdate, {
          claimed: current,
          isLeaseHeld: lease.isHeld,
          leaseHolderId: lease.holderId,
        }).execute();
        if ((result.affected ?? 0) !== 1) return null;
        return retry ? "recovered" : "failed";
      },
    );
    if (recoveredWithLease === "recovered") recovered += 1;
    if (recoveredWithLease === "failed") failed += 1;
  }
  return { recovered, failed };
}

export type DueDispatchResult = {
  due: number;
  claimed: number;
  recovered: number;
  recoveryFailed: number;
};

/** Find due calendar meetings and launch each one after its atomic claim. */
export async function dispatchDueMeetings(now = new Date()): Promise<DueDispatchResult> {
  const recovery = await recoverStaleNotetakers(now);
  const joinBy = new Date(now.getTime() + NOTETAKER_JOIN_LEAD_MS);
  const due = await AppDataSource.getRepository(Meeting)
    .createQueryBuilder("meeting")
    .innerJoin(
      CalendarEvent,
      "event",
      "event.id = meeting.calendarEventId AND event.companyId = meeting.companyId",
    )
    .where("meeting.status = :status", { status: "scheduled" })
    .andWhere("event.startAt <= :joinBy", { joinBy })
    .andWhere("event.endAt > :now", { now })
    .orderBy("event.startAt", "ASC")
    .limit(MAX_DUE_PER_PASS)
    .getMany();

  let claimed = 0;
  for (const meeting of due) {
    const result = await startNotetakerInternal({
      companyId: meeting.companyId,
      meetingId: meeting.id,
      retryFailed: false,
      automatic: true,
      now,
    });
    if (result.ok) claimed += 1;
  }
  return {
    due: due.length,
    claimed,
    recovered: recovery.recovered,
    recoveryFailed: recovery.failed,
  };
}
