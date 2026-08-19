import { AppDataSource } from "../../db/datasource.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { writeUpMeeting } from "./followUps.js";
import { linkMeetingSafely } from "./revenueLink.js";
import { setMeetingStatus } from "./store.js";
import { transcribeMeeting } from "./transcribe.js";

/**
 * Everything that happens to a meeting once it has audio or text.
 *
 *   transcribe → link to Revenue → AI write-up → link again → ready
 *
 * The second link is not a mistake. The first one puts the call on the right
 * timelines as soon as we know who was there, so a human refreshing the
 * customer sees it immediately; the second refreshes those rows once the
 * summary exists, because a timeline entry reading "Meeting" is worth much
 * less than one carrying what was decided. Both are idempotent on
 * `Activity.meetingId`, which is what makes running it twice free.
 *
 * Ordering matters in one other place: linking runs **before** the write-up so
 * the follow-ups it files can carry the meeting's Deal and Account. A task
 * with no links lands in the queue attached to nothing, which is where
 * follow-ups go to be ignored.
 */

/** Meetings in flight in this process. A restart clears it, which is correct:
 * the passes it tracked died with the process and `status` is durable. */
const inFlight = new Set<string>();

export type ProcessResult = {
  transcribed: boolean;
  linked: number;
  actionItems: number;
  status: Meeting["status"];
  note: string;
};

/**
 * Drive one meeting to `ready`, or to `failed` with a reason a human can act
 * on. Safe to call repeatedly; each step checks whether it still has work.
 */
export async function processMeeting(companyId: string, meetingId: string): Promise<ProcessResult> {
  const base: ProcessResult = {
    transcribed: false,
    linked: 0,
    actionItems: 0,
    status: "processing",
    note: "",
  };
  if (inFlight.has(meetingId)) return { ...base, note: "Already processing." };
  inFlight.add(meetingId);

  try {
    const repo = AppDataSource.getRepository(Meeting);
    const meeting = await repo.findOneBy({ id: meetingId, companyId });
    if (!meeting) return { ...base, status: "failed", note: "Meeting not found." };

    // 1. Transcribe, when there is audio and no text yet.
    if (meeting.recordingPath && meeting.transcriptState !== "ready") {
      const result = await transcribeMeeting(companyId, meetingId);
      if ("error" in result) {
        await setMeetingStatus(companyId, meetingId, "failed", result.error);
        return { ...base, status: "failed", note: result.error };
      }
      base.transcribed = true;
    }

    const withText = await repo.findOneBy({ id: meetingId, companyId });
    if (!withText) return { ...base, status: "failed", note: "Meeting disappeared mid-pass." };
    if (!withText.transcriptText.trim()) {
      await setMeetingStatus(
        companyId,
        meetingId,
        "failed",
        "This meeting has no transcript. Upload a recording or paste a transcript.",
      );
      return { ...base, status: "failed", note: "No transcript." };
    }

    // 2. Put it on the right timelines before anything reads those links.
    const linked = await linkMeetingSafely(companyId, meetingId);
    base.linked = linked?.matched ?? 0;

    // 3. The write-up. A skip is not a failure — see `writeUpMeeting`.
    const writeUp = await writeUpMeeting(companyId, meetingId);
    if (writeUp.status === "ok") base.actionItems = writeUp.actionItems;
    if (writeUp.status !== "ok") base.note = writeUp.reason;

    // 4. Refresh the timeline rows now that the summary exists.
    if (writeUp.status === "ok") await linkMeetingSafely(companyId, meetingId);

    await setMeetingStatus(companyId, meetingId, "ready", base.note);
    return { ...base, status: "ready" };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    await setMeetingStatus(companyId, meetingId, "failed", note);
    return { ...base, status: "failed", note };
  } finally {
    inFlight.delete(meetingId);
  }
}

/** {@link processMeeting} that never rejects — for fire-and-forget callers. */
export function processMeetingInBackground(companyId: string, meetingId: string): void {
  void processMeeting(companyId, meetingId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[meetings] processing failed for ${meetingId}:`, err);
  });
}
