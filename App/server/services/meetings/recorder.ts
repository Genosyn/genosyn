import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { isSupportedRecordingMime, mimeForFilename, writeRecording } from "./storage.js";
import { replaceTranscript, setMeetingStatus } from "./store.js";

/**
 * How a meeting gets its audio.
 *
 * One implementation ships today — a recording or a transcript handed to a
 * meeting — and that is a deliberate scope, not an oversight. A notetaker that
 * dials into the call itself needs an audio stack the App image does not carry
 * (Xvfb gives Chrome a display, not a sound card) and needs the service-worker
 * block in `browserChromium.ts` relaxed, which that file documents as "the
 * security boundary". Both are decisions before they are patches.
 *
 * So the seam exists and the driver does not. Everything downstream of the
 * audio — transcription, contact linking, the AI write-up, the follow-up queue
 * — is written against {@link MeetingRecorder} rather than against an upload,
 * which means a join driver registers here and changes nothing else.
 */
export type MeetingRecorder = {
  /** Stable id shown in logs and in the meeting's `recordingSource`. */
  readonly id: "notetaker";
  /** Can this recorder join the given conference URL right now? */
  canJoin(conferenceUrl: string): boolean;
  /** Join, record, and store. Resolves when the recording is on disk. */
  join(args: { companyId: string; meetingId: string; conferenceUrl: string }): Promise<void>;
};

let recorder: MeetingRecorder | null = null;

/**
 * Install a join-capable recorder. Called at boot by whatever ships one; with
 * nothing registered, the meeting flow reports that joining is unavailable
 * rather than failing obscurely.
 */
export function registerMeetingRecorder(next: MeetingRecorder): void {
  recorder = next;
}

export function activeMeetingRecorder(): MeetingRecorder | null {
  return recorder;
}

/** Why a meeting cannot be joined, in a sentence a human can act on. */
export const NO_RECORDER_MESSAGE =
  "This deployment has no notetaker that can join a call. Upload the recording or paste the transcript instead.";

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
  if (args.bytes.length > config.meetings.maxRecordingBytes) {
    const mb = Math.round(config.meetings.maxRecordingBytes / (1024 * 1024));
    return { ok: false, error: `Recordings are limited to ${mb} MB.` };
  }

  const mime = isSupportedRecordingMime(args.mime)
    ? args.mime.toLowerCase()
    : mimeForFilename(args.filename);
  if (!mime) {
    return {
      ok: false,
      error: "That file type is not a recording we can read. Upload mp3, m4a, wav, webm, ogg, flac, mp4, or mov.",
    };
  }

  const recordingPath = writeRecording({
    companyId: args.companyId,
    meetingId: args.meetingId,
    bytes: args.bytes,
    mime,
  });

  await repo.update(
    { id: args.meetingId },
    {
      recordingPath,
      recordingMime: mime,
      recordingBytes: args.bytes.length,
      recordingSource: "upload",
      status: "processing",
      statusMessage: "",
      transcriptState: "queued",
      transcriptError: "",
      endedAt: meeting.endedAt ?? new Date(),
    },
  );
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

/**
 * Ask the registered recorder to join a call.
 *
 * Marks the meeting `joining` before handing off so the UI reflects the
 * attempt, and settles it to `failed` with the reason when there is nobody to
 * hand off to — which, on a stock deployment, is always.
 */
export async function startNotetaker(args: {
  companyId: string;
  meetingId: string;
}): Promise<IngestResult> {
  const meeting = await AppDataSource.getRepository(Meeting).findOneBy({
    id: args.meetingId,
    companyId: args.companyId,
  });
  if (!meeting) return { ok: false, error: "Meeting not found." };
  if (!meeting.conferenceUrl) {
    return { ok: false, error: "This meeting has no conference link to join." };
  }

  const active = activeMeetingRecorder();
  if (!active || !active.canJoin(meeting.conferenceUrl)) {
    await setMeetingStatus(args.companyId, args.meetingId, "failed", NO_RECORDER_MESSAGE);
    return { ok: false, error: NO_RECORDER_MESSAGE };
  }

  await setMeetingStatus(args.companyId, args.meetingId, "joining");
  try {
    await active.join({
      companyId: args.companyId,
      meetingId: args.meetingId,
      conferenceUrl: meeting.conferenceUrl,
    });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setMeetingStatus(args.companyId, args.meetingId, "failed", error);
    return { ok: false, error };
  }
}
