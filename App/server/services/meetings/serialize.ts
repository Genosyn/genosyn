import type { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import type { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import type { Meeting } from "../../db/entities/Meeting.js";
import type { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import type { MeetingTranscriptSegment } from "../../db/entities/MeetingTranscriptSegment.js";
import { parseAttendees } from "./store.js";

/**
 * Wire shapes for the Meetings API.
 *
 * Dates go out as ISO strings and `recordingPath` never leaves the server — it
 * is an on-disk location, and the client reaches the audio through the
 * download route that re-checks company scope rather than through a path it
 * was handed.
 */

export type CalendarAccountDTO = ReturnType<typeof serializeCalendarAccount>;

export function serializeCalendarAccount(row: CalendarAccount) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    calendarId: row.calendarId,
    address: row.address,
    displayName: row.displayName,
    timeZone: row.timeZone,
    status: row.status,
    statusMessage: row.statusMessage,
    syncState: row.syncState,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    syncStartedAt: row.syncStartedAt ? row.syncStartedAt.toISOString() : null,
    syncFinishedAt: row.syncFinishedAt ? row.syncFinishedAt.toISOString() : null,
    windowDays: row.windowDays,
    autoRecord: row.autoRecord,
    notetakerEmployeeId: row.notetakerEmployeeId,
    createdAt: row.createdAt.toISOString(),
  };
}

export type CalendarEventDTO = ReturnType<typeof serializeCalendarEvent>;

export function serializeCalendarEvent(row: CalendarEvent) {
  return {
    id: row.id,
    accountId: row.accountId,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    allDay: row.allDay,
    status: row.status,
    organizerEmail: row.organizerEmail,
    organizerName: row.organizerName,
    attendees: parseAttendees(row.attendeesJson),
    conferenceProvider: row.conferenceProvider,
    conferenceUrl: row.conferenceUrl,
    htmlLink: row.htmlLink,
    recurring: row.recurringEventId !== "",
  };
}

export type MeetingActionItem = {
  title: string;
  owner: string;
  dueAt: string | null;
  activityId: string | null;
};

function parseActionItems(json: string): MeetingActionItem[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as MeetingActionItem[]) : [];
  } catch {
    return [];
  }
}

export type MeetingDTO = ReturnType<typeof serializeMeeting>;

export function serializeMeeting(row: Meeting) {
  return {
    id: row.id,
    calendarEventId: row.calendarEventId,
    accountId: row.accountId,
    title: row.title,
    scheduledStartAt: row.scheduledStartAt ? row.scheduledStartAt.toISOString() : null,
    scheduledEndAt: row.scheduledEndAt ? row.scheduledEndAt.toISOString() : null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    conferenceProvider: row.conferenceProvider,
    conferenceUrl: row.conferenceUrl,
    status: row.status,
    statusMessage: row.statusMessage,
    recordingSource: row.recordingSource,
    hasRecording: row.recordingPath !== "",
    recordingMime: row.recordingMime,
    recordingBytes: Number(row.recordingBytes ?? 0),
    durationMs: row.durationMs,
    transcriptState: row.transcriptState,
    transcriptError: row.transcriptError,
    summaryText: row.summaryText,
    actionItems: parseActionItems(row.actionItemsJson),
    notetakerEmployeeId: row.notetakerEmployeeId,
    linkedAt: row.linkedAt ? row.linkedAt.toISOString() : null,
    summarisedAt: row.summarisedAt ? row.summarisedAt.toISOString() : null,
    customerId: row.customerId,
    dealId: row.dealId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeParticipant(row: MeetingParticipant) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    contactId: row.contactId,
    isOrganizer: row.isOrganizer,
    isInternal: row.isInternal,
    responseStatus: row.responseStatus,
  };
}

export function serializeSegment(row: MeetingTranscriptSegment) {
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    startMs: row.startMs,
    endMs: row.endMs,
    speaker: row.speaker,
    text: row.text,
  };
}
