import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { MeetingTranscriptSegment } from "../../db/entities/MeetingTranscriptSegment.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { decryptConnectionConfig, getConnection, persistConnectionConfigIfCurrent } from "../integrations.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
  hasGoogleCalendarScope,
} from "../../integrations/providers/google/auth.js";
import type { IntegrationConfig, IntegrationRuntimeContext } from "../../integrations/types.js";
import { listCalendars } from "./calendarClient.js";

/**
 * CalendarAccount lifecycle + the token seam between the Meetings section and
 * the Integrations framework.
 *
 * A CalendarAccount borrows the OAuth credentials of a `google`
 * IntegrationConnection. This module is the only place the Meetings code
 * touches `encryptedConfig`, and it follows the recipe `services/mail/
 * accounts.ts` established: decrypt → `ensureFreshGoogleToken` (refreshes when
 * under 60s to expiry) → re-encrypt and persist **if and only if** the token
 * actually rotated, using a compare-and-swap against the ciphertext we read.
 *
 * Skipping that persist is the subtle, expensive bug: the refresh token gets
 * re-spent on every pass, and Google eventually stops honouring it.
 */

/**
 * A fresh Calendar-capable access token, with any rotation persisted.
 *
 * Throws with a sentence a human can act on when the Connection is unusable —
 * wrong provider, or consent that never carried the calendar scope. The scope
 * is checked before the refresh so a mis-scoped Connection reports the real
 * problem instead of a confusing 403 two calls later.
 */
async function freshCalendarCredential(conn: IntegrationConnection): Promise<string> {
  if (conn.provider !== "google") {
    throw new Error("Calendars require a Google connection.");
  }
  const cfg = decryptConnectionConfig(conn);
  const credentialSnapshot = conn.encryptedConfig;
  let rotated: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      rotated = next;
    },
  };
  if (!hasGoogleCalendarScope(currentGoogleGrantedScope(ctx))) {
    throw new Error(
      "This Google connection was authorized without the Calendar scope. Reconnect it with Calendar selected.",
    );
  }
  await ensureFreshGoogleToken(ctx);
  const token = currentGoogleAccessToken(ctx);
  if (rotated) {
    const persisted = await persistConnectionConfigIfCurrent({
      connectionId: conn.id,
      companyId: conn.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: rotated,
    });
    // Somebody else won the compare-and-swap. Retryable, not fatal.
    if (!persisted) {
      throw new Error("The Google Connection changed while its token refreshed. Try again.");
    }
  }
  return token;
}

export async function freshCalendarAccessToken(conn: IntegrationConnection): Promise<string> {
  return freshCalendarCredential(conn);
}

/** Resolve the account's Connection and return a fresh access token. */
export async function accessTokenForAccount(account: CalendarAccount): Promise<string> {
  const conn = await getConnection(account.companyId, account.connectionId);
  if (!conn) {
    throw new Error(
      "The Google connection behind this calendar was deleted. Remove the calendar and connect again.",
    );
  }
  return freshCalendarCredential(conn);
}

/** Calendars on a Connection that are not already mirrored — the connect picker. */
export async function listConnectableCalendars(
  companyId: string,
  connectionId: string,
): Promise<Array<{ calendarId: string; summary: string; primary: boolean; timeZone: string }>> {
  const conn = await getConnection(companyId, connectionId);
  if (!conn) throw new Error("Connection not found.");
  const token = await freshCalendarCredential(conn);
  const existing = new Set(
    (
      await AppDataSource.getRepository(CalendarAccount).find({
        where: { companyId, connectionId },
        select: { calendarId: true },
      })
    ).map((row) => row.calendarId),
  );
  return listCalendars(token)
    .then((entries) =>
      entries
        .filter((entry) => !!entry.id && !existing.has(entry.id))
        // A calendar you can only see free/busy on cannot be mirrored:
        // Google returns no summary, no attendees, and no conference data.
        .filter((entry) => entry.accessRole !== "freeBusyReader")
        .map((entry) => ({
          calendarId: entry.id,
          summary: entry.summary ?? entry.id,
          primary: entry.primary === true,
          timeZone: entry.timeZone ?? "",
        })),
    );
}

export async function listCalendarAccounts(companyId: string): Promise<CalendarAccount[]> {
  return AppDataSource.getRepository(CalendarAccount).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
}

export async function getCalendarAccount(
  companyId: string,
  id: string,
): Promise<CalendarAccount | null> {
  return AppDataSource.getRepository(CalendarAccount).findOneBy({ id, companyId });
}

/**
 * Connect a calendar. Verifies the Connection can actually speak Calendar
 * before writing a row, so a mis-scoped connection fails here rather than on
 * the first heartbeat where nobody is watching.
 */
export async function createCalendarAccount(args: {
  companyId: string;
  connectionId: string;
  calendarId: string;
  createdByUserId: string | null;
}): Promise<CalendarAccount> {
  const conn = await getConnection(args.companyId, args.connectionId);
  if (!conn) throw new Error("Connection not found.");
  const token = await freshCalendarCredential(conn);

  const entries = await listCalendars(token);
  const entry = entries.find((row) => row.id === args.calendarId);
  if (!entry) {
    throw new Error("That calendar is not visible on this Google connection.");
  }

  const repo = AppDataSource.getRepository(CalendarAccount);
  const existing = await repo.findOneBy({
    companyId: args.companyId,
    connectionId: args.connectionId,
    calendarId: args.calendarId,
  });
  if (existing) return existing;

  return repo.save(
    repo.create({
      companyId: args.companyId,
      connectionId: args.connectionId,
      calendarId: args.calendarId,
      address: conn.accountHint || "",
      displayName: entry.summary ?? args.calendarId,
      timeZone: entry.timeZone ?? "",
      status: "active",
      createdByUserId: args.createdByUserId,
    }),
  );
}

export type CalendarAccountPatch = {
  status?: CalendarAccount["status"];
  autoRecord?: CalendarAccount["autoRecord"];
  notetakerEmployeeId?: string | null;
  windowDays?: number;
};

export async function updateCalendarAccount(
  companyId: string,
  id: string,
  patch: CalendarAccountPatch,
): Promise<CalendarAccount | null> {
  const repo = AppDataSource.getRepository(CalendarAccount);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) return null;

  if (patch.status !== undefined) {
    row.status = patch.status;
    if (patch.status !== "error") row.statusMessage = "";
  }
  if (patch.autoRecord !== undefined) row.autoRecord = patch.autoRecord;
  if (patch.notetakerEmployeeId !== undefined) row.notetakerEmployeeId = patch.notetakerEmployeeId;
  if (patch.windowDays !== undefined) {
    // Clamped rather than validated away: a calendar mirror is a cache, and a
    // window somebody typed 100000 into is a slow full re-list every pass.
    row.windowDays = Math.max(1, Math.min(365, Math.trunc(patch.windowDays)));
  }
  return repo.save(row);
}

/**
 * Remove a calendar and everything derived from it.
 *
 * Deliberately leaves the Connection alone — Gmail or Drive may still be using
 * it — and deliberately deletes the meetings, because a meeting whose calendar
 * is gone has no way to be refreshed, re-linked, or re-recorded. The Activity
 * rows already written onto Contact timelines survive: they are evidence that
 * the call happened, and that stays true after somebody disconnects a calendar.
 */
export async function deleteCalendarAccount(companyId: string, id: string): Promise<boolean> {
  const repo = AppDataSource.getRepository(CalendarAccount);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) return false;

  const meetings = await AppDataSource.getRepository(Meeting).find({
    where: { companyId, accountId: id },
    select: { id: true },
  });
  const meetingIds = meetings.map((m) => m.id);
  if (meetingIds.length > 0) {
    await AppDataSource.getRepository(MeetingTranscriptSegment).delete({ meetingId: In(meetingIds) });
    await AppDataSource.getRepository(MeetingParticipant).delete({ meetingId: In(meetingIds) });
    await AppDataSource.getRepository(Meeting).delete({ id: In(meetingIds) });
  }
  await AppDataSource.getRepository(CalendarEvent).delete({ accountId: id });
  await AppDataSource.getRepository(EmployeeCalendarGrant).delete({ accountId: id });
  await repo.delete({ id });
  return true;
}
