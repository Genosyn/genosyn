import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { getActiveModel } from "../models.js";
import { createFollowUpTask } from "../revenue/followUps.js";
import { hasRevenueAccess } from "../revenue/grants.js";
import { listParticipants } from "./store.js";

/**
 * The AI write-up: transcript in, summary and dated follow-ups out.
 *
 * Structured deliberately as an **injectable seam**, the way `sequenceTick`
 * and `signalTick` are. `services/meetings/boot.ts` is the only module that
 * knows both halves, so importing the meeting pipeline in a test does not drag
 * the agent runtime — and therefore every model provider — in with it.
 *
 * What the employee is asked for is narrow on purpose. Not "summarise this",
 * which produces a paragraph nobody reads, but: what was decided, what was
 * promised, and by when. Promises are the only part that becomes a row.
 */

export type MeetingWriteUp = {
  summary: string;
  actionItems: Array<{
    title: string;
    /** ISO date, or empty when the call named no date. */
    dueDate: string;
    /** Free text as spoken — "us", "Priya", "the customer". */
    owner: string;
  }>;
};

/** Injected by boot; absent in tests and on a model-less install. */
export type MeetingWriteUpAuthor = (args: {
  meeting: Meeting;
  employeeId: string;
  prompt: string;
}) => Promise<MeetingWriteUp | null>;

let author: MeetingWriteUpAuthor | null = null;

export function setMeetingWriteUpAuthor(next: MeetingWriteUpAuthor): void {
  author = next;
}

/** Transcript characters put in front of the model. Roughly an hour of speech;
 * beyond that the tail is dropped rather than the head, because a call's
 * commitments cluster at the end and its pleasantries at the start. */
const TRANSCRIPT_PROMPT_CAP = 60_000;

/** A meeting is not a to-do list generator. More than this and the model is
 * inventing work rather than recording it. */
const MAX_ACTION_ITEMS = 10;

function transcriptForPrompt(meeting: Meeting): string {
  const text = meeting.transcriptText;
  if (text.length <= TRANSCRIPT_PROMPT_CAP) return text;
  return `…[earlier transcript truncated]\n${text.slice(text.length - TRANSCRIPT_PROMPT_CAP)}`;
}

export async function composeWriteUpPrompt(meeting: Meeting): Promise<string> {
  const participants = await listParticipants(meeting.companyId, meeting.id);
  const attendeeLines = participants.map((row) => {
    const who = row.displayName ? `${row.displayName} <${row.email}>` : row.email;
    const tags = [row.isOrganizer ? "organizer" : "", row.isInternal ? "internal" : "external"]
      .filter(Boolean)
      .join(", ");
    return `- ${who}${tags ? ` (${tags})` : ""}${row.contactId ? " — known Contact" : ""}`;
  });

  return [
    `You are writing up a meeting you attended: **${meeting.title || "Untitled meeting"}**.`,
    meeting.scheduledStartAt ? `It started ${meeting.scheduledStartAt.toISOString()}.` : "",
    "",
    "## Who was there",
    attendeeLines.length > 0 ? attendeeLines.join("\n") : "- (nobody recorded)",
    "",
    "## Transcript",
    transcriptForPrompt(meeting),
    "",
    "---",
    "## What to produce",
    "Reply with JSON and nothing else, in exactly this shape:",
    "```json",
    '{"summary": "markdown", "actionItems": [{"title": "...", "dueDate": "YYYY-MM-DD", "owner": "..."}]}',
    "```",
    "",
    "`summary`: what was actually decided and what changed, in a few short markdown paragraphs or bullets. Written for a colleague who was not on the call and will read it in thirty seconds. No preamble, no restating the agenda, no 'the participants discussed'.",
    "",
    `\`actionItems\`: only things somebody actually committed to, at most ${MAX_ACTION_ITEMS}. Each one names a real next action, not a topic. If a date was said out loud, put it in \`dueDate\`; if not, leave \`dueDate\` empty rather than inventing one. \`owner\` is who promised it, in the words the call used.`,
    "",
    "If nothing was committed to, return an empty `actionItems` array. An empty list is a correct answer and a made-up task is not.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Pull the write-up out of a model reply.
 *
 * Models fence JSON, prefix it with prose, or both. This takes the first
 * balanced `{…}` run rather than trusting the whole reply to parse, and
 * returns null instead of throwing so a malformed answer degrades to "no
 * write-up" rather than failing the meeting.
 */
export function parseWriteUp(reply: string): MeetingWriteUp | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { summary?: unknown; actionItems?: unknown };

  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  const actionItems: MeetingWriteUp["actionItems"] = [];
  if (Array.isArray(body.actionItems)) {
    for (const raw of body.actionItems.slice(0, MAX_ACTION_ITEMS)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as { title?: unknown; dueDate?: unknown; owner?: unknown };
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (!title) continue;
      actionItems.push({
        title: title.slice(0, 400),
        dueDate: typeof item.dueDate === "string" ? item.dueDate.trim() : "",
        owner: typeof item.owner === "string" ? item.owner.trim().slice(0, 200) : "",
      });
    }
  }
  if (!summary && actionItems.length === 0) return null;
  return { summary, actionItems };
}

/** `YYYY-MM-DD` at UTC noon, so a timezone shift cannot move it a day. */
export function parseDueDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export type WriteUpResult =
  | { status: "ok"; actionItems: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Read the transcript, write the summary, file the follow-ups.
 *
 * Follow-ups become `task` activities through `createFollowUpTask`, which
 * means they land in the Follow-ups queue humans already work from rather than
 * in a second inbox nobody opens. They are assigned to the notetaker employee
 * so somebody owns them, and carry the meeting's Contact/Deal/Account links so
 * they show up on the right timeline.
 *
 * Degrades quietly and specifically: no employee, no model, no transcript and
 * no revenue write access are all `skipped` with a reason, never `failed`. A
 * fresh install records meetings long before anybody connects a model, and
 * turning that into an error on every call would make the feature feel broken.
 */
export async function writeUpMeeting(companyId: string, meetingId: string): Promise<WriteUpResult> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: meetingId, companyId });
  if (!meeting) return { status: "skipped", reason: "Meeting not found." };
  if (!meeting.transcriptText.trim()) {
    return { status: "skipped", reason: "This meeting has no transcript yet." };
  }
  const employeeId = meeting.notetakerEmployeeId;
  if (!employeeId) {
    return { status: "skipped", reason: "No AI Employee is assigned to this meeting." };
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return { status: "skipped", reason: "The assigned AI Employee is gone." };
  if (!(await getActiveModel(employeeId))) {
    return { status: "skipped", reason: "The assigned AI Employee has no AI Model connected." };
  }
  if (!author) {
    return { status: "skipped", reason: "The meeting write-up runtime is not installed." };
  }

  const prompt = await composeWriteUpPrompt(meeting);
  let writeUp: MeetingWriteUp | null;
  try {
    writeUp = await author({ meeting, employeeId, prompt });
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!writeUp) {
    return { status: "failed", reason: "The AI Employee did not return a usable write-up." };
  }

  // Filing follow-ups is a Revenue write. An employee without it still gets to
  // produce the summary — reading a transcript is not a privileged act — but
  // its promises stay on the meeting page instead of entering the queue.
  const mayFile = await hasRevenueAccess(employeeId, "write");
  const filed: Array<{ title: string; owner: string; dueAt: string | null; activityId: string | null }> = [];

  for (const item of writeUp.actionItems) {
    const dueAt = parseDueDate(item.dueDate);
    if (!mayFile) {
      filed.push({ title: item.title, owner: item.owner, dueAt: dueAt?.toISOString() ?? null, activityId: null });
      continue;
    }
    try {
      const activity = await createFollowUpTask(
        companyId,
        {
          subject: item.title,
          bodyText: item.owner ? `Committed by ${item.owner} on “${meeting.title}”.` : `From “${meeting.title}”.`,
          dueAt,
          assignedEmployeeId: employeeId,
          contactId: null,
          dealId: meeting.dealId,
          customerId: meeting.customerId,
        },
        { employeeId },
      );
      filed.push({
        title: item.title,
        owner: item.owner,
        dueAt: dueAt?.toISOString() ?? null,
        activityId: activity.id,
      });
    } catch (err) {
      // One rejected link must not lose the other nine commitments.
      // eslint-disable-next-line no-console
      console.warn(`[meetings] could not file a follow-up for meeting ${meetingId}:`, err);
      filed.push({ title: item.title, owner: item.owner, dueAt: dueAt?.toISOString() ?? null, activityId: null });
    }
  }

  meeting.summaryText = writeUp.summary;
  meeting.actionItemsJson = JSON.stringify(filed);
  meeting.summarisedAt = new Date();
  await repo.save(meeting);

  return { status: "ok", actionItems: filed.length };
}
