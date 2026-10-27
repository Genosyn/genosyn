import { In, IsNull, LessThan, Not } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import { parseDueDate } from "../meetings/followUps.js";
import { getActiveModel } from "../models.js";
import { recordActivity } from "../revenue/activities.js";
import { createFollowUpTask } from "../revenue/followUps.js";
import { hasRevenueAccess } from "../revenue/grants.js";
import { customerChannelProblem, pendingMessages } from "./store.js";
import {
  MAX_NOTE_FOLLOW_UPS,
  composeNotesSystemPrompt,
  composeNotesUserMessage,
  runNotesTurn,
} from "./turns.js";

/**
 * Notes: what was said in a customer channel, written onto the Customer's
 * timeline by the AI Employee that works it.
 *
 * This is the meeting write-up applied to a different input, and it keeps
 * that write-up's rules: a short summary of what was decided, asked and
 * promised — not a transcript — and a Follow-up only for something somebody on
 * the company's side committed to. The summary becomes a `note` Activity on
 * the Customer, authored by the employee, which a Member can correct or delete
 * like any other note. Follow-ups land in the queue people already work from,
 * assigned to the employee so someone owns them, and only when the employee
 * holds Revenue write access — exactly as a meeting's do.
 *
 * Unlike a meeting a channel never ends, so notes are written when it goes
 * quiet: {@link NOTES_QUIET_MS} after the newest message, or
 * {@link NOTES_MAX_WAIT_MS} after the oldest one still waiting, whichever comes
 * first, so a channel that never stops talking is still written up.
 *
 * The model reads the messages in a restricted one-tool turn (`turns.ts`) and
 * the server files what it submitted. Nothing a customer typed can make the
 * turn reach a company tool, choose which record the notes go on, or change
 * who a Follow-up is assigned to.
 */

export const NOTES_QUIET_MS = 30 * 60_000;
export const NOTES_MAX_WAIT_MS = 4 * 60 * 60_000;
/** After an attempt, successful or not, before the channel is tried again. */
export const NOTES_RETRY_MS = 15 * 60_000;
/** Messages in one set of notes. A backlog is written up over several. */
export const MAX_MESSAGES_PER_NOTE = 300;
/** Already-noted messages shown before the new ones, for context. */
const EARLIER_MESSAGES = 8;
/** Kept messages already in notes are pruned after this long. */
export const NOTED_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Notes turns per pass, so one busy pass cannot run all afternoon. */
const MAX_CHANNELS_PER_PASS = 10;

export type CustomerChannelNotesResult =
  | { status: "written"; activityId: string | null; followUps: number; messages: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type PendingWindow = { count: number; oldest: Date; newest: Date };

/** Whether this channel's waiting messages are due for notes at `now`. */
export function notesDue(
  channel: Pick<CustomerChannel, "notesAttemptedAt">,
  pending: PendingWindow | null,
  now: number,
): boolean {
  if (!pending || pending.count === 0) return false;
  if (channel.notesAttemptedAt && now - channel.notesAttemptedAt.getTime() < NOTES_RETRY_MS) {
    return false;
  }
  return (
    now - pending.newest.getTime() >= NOTES_QUIET_MS ||
    now - pending.oldest.getTime() >= NOTES_MAX_WAIT_MS
  );
}

async function pendingWindows(channelIds: string[]): Promise<Map<string, PendingWindow>> {
  if (channelIds.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(CustomerChannelMessage)
    .createQueryBuilder("message")
    .select("message.customerChannelId", "customerChannelId")
    .addSelect("COUNT(*)", "count")
    .addSelect("MIN(message.postedAt)", "oldest")
    .addSelect("MAX(message.postedAt)", "newest")
    .where("message.customerChannelId IN (:...channelIds)", { channelIds })
    .andWhere("message.notedAt IS NULL")
    .groupBy("message.customerChannelId")
    .getRawMany<{
      customerChannelId: string;
      count: string | number;
      oldest: string | Date;
      newest: string | Date;
    }>();
  return new Map(
    rows.map((row) => [
      row.customerChannelId,
      { count: Number(row.count), oldest: asDate(row.oldest), newest: asDate(row.newest) },
    ]),
  );
}

/** SQLite hands aggregates back as text in its own format; Postgres as a Date. */
function asDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
      ? `${text.replace(" ", "T")}Z`
      : text,
  );
}

async function recordAttempt(channelId: string, error: string): Promise<void> {
  await AppDataSource.getRepository(CustomerChannel).update(
    { id: channelId },
    { notesAttemptedAt: new Date(), notesError: error.slice(0, 500) },
  );
}

function failureDetail(err: unknown): string {
  return redactSensitiveText(err instanceof Error ? err.message : String(err)).slice(0, 400);
}

/**
 * Write notes for whatever the channel holds that is not in notes yet.
 *
 * `force` skips the waiting rules, for an admin pressing Write notes now. The
 * readiness rules are never skipped: no employee, no Grant, a Standdown or no
 * AI Model each write nothing and say why.
 */
export async function writeCustomerChannelNotes(
  channelId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<CustomerChannelNotesResult> {
  const channel = await AppDataSource.getRepository(CustomerChannel).findOneBy({ id: channelId });
  if (!channel) return { status: "skipped", reason: "Customer channel not found." };
  const pending = await pendingMessages(channel.id, MAX_MESSAGES_PER_NOTE);
  if (pending.length === 0) {
    return { status: "skipped", reason: "Nothing new has been said since the last notes." };
  }
  if (!options.force) {
    const window = await pendingWindows([channel.id]);
    if (!notesDue(channel, window.get(channel.id) ?? null, options.now ?? Date.now())) {
      return { status: "skipped", reason: "The channel is still talking." };
    }
  }

  // Not recorded as the channel's error: the problem is worked out afresh
  // every time the channel is shown, so a copy here would only go stale the
  // moment someone fixed it.
  const problem = await customerChannelProblem(channel);
  if (problem) return { status: "skipped", reason: problem };
  const employeeId = channel.employeeId as string;
  const [employee, company, customer, model] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: employeeId,
      companyId: channel.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: channel.companyId }),
    AppDataSource.getRepository(Customer).findOneBy({
      id: channel.customerId,
      companyId: channel.companyId,
    }),
    getActiveModel(employeeId),
  ]);
  if (!employee || !company || !model) {
    const reason = "The AI Employee working this channel could not be loaded.";
    await recordAttempt(channel.id, reason);
    return { status: "failed", reason };
  }
  if (!customer) {
    const reason = "The Customer this channel is linked to no longer exists. Link it to another.";
    await recordAttempt(channel.id, reason);
    return { status: "failed", reason };
  }

  const earlier = (
    await AppDataSource.getRepository(CustomerChannelMessage).find({
      where: {
        customerChannelId: channel.id,
        notedAt: Not(IsNull()),
        postedAt: LessThan(pending[0].postedAt),
      },
      order: { postedAt: "DESC" },
      take: EARLIER_MESSAGES,
    })
  ).reverse();

  let notes;
  try {
    notes = await runNotesTurn({
      model,
      employee,
      system: composeNotesSystemPrompt({ employee, company, customer, channel }),
      user: composeNotesUserMessage({ channel, customer, earlier, pending }),
    });
  } catch (err) {
    const reason = failureDetail(err);
    await recordAttempt(channel.id, reason);
    return { status: "failed", reason };
  }

  const first = pending[0];
  const last = pending[pending.length - 1];
  const where = channel.name ? `#${channel.name}` : "a customer channel";
  const summary = notes.summary.trim();
  let activityId: string | null = null;
  if (summary) {
    const activity = await recordActivity(
      channel.companyId,
      {
        kind: "note",
        subject: `Notes from ${where} on Slack`,
        bodyText: summary,
        occurredAt: last.postedAt,
        customerId: customer.id,
        meta: {
          source: "customer_channel",
          customerChannelId: channel.id,
          provider: channel.provider,
          externalChannelId: channel.externalChannelId,
          channelName: channel.name,
          messages: pending.length,
          from: first.postedAt.toISOString(),
          to: last.postedAt.toISOString(),
        },
      },
      { employeeId: employee.id },
    );
    activityId = activity.id;
  }

  // Filing a Follow-up is a Revenue write, so it needs the employee's own
  // Revenue access, exactly as a meeting's do. The summary does not: the
  // channel was linked to this Customer by an admin, and writing down what was
  // said there is what linking it asked for.
  let followUps = 0;
  if (notes.followUps.length > 0 && (await hasRevenueAccess(employee.id, "write"))) {
    for (const item of notes.followUps.slice(0, MAX_NOTE_FOLLOW_UPS)) {
      try {
        await createFollowUpTask(
          channel.companyId,
          {
            subject: item.title,
            bodyText: item.owner
              ? `Promised by ${item.owner} in ${where} on Slack.`
              : `From ${where} on Slack.`,
            dueAt: parseDueDate(item.dueDate.trim()),
            assignedEmployeeId: employee.id,
            customerId: customer.id,
          },
          { employeeId: employee.id },
        );
        followUps += 1;
      } catch (err) {
        // One rejected Follow-up must not lose the notes or the others.
        // eslint-disable-next-line no-console
        console.warn(`[customer-channels] could not file a follow-up for ${channel.id}:`, err);
      }
    }
  }

  const notedAt = new Date();
  await AppDataSource.getRepository(CustomerChannelMessage).update(
    { id: In(pending.map((message) => message.id)) },
    { notedAt },
  );
  await AppDataSource.getRepository(CustomerChannel).update(
    { id: channel.id },
    { lastNotedAt: notedAt, notesAttemptedAt: notedAt, notesError: "" },
  );
  await AppDataSource.getRepository(CustomerChannelMessage).delete({
    customerChannelId: channel.id,
    notedAt: LessThan(new Date(notedAt.getTime() - NOTED_MESSAGE_RETENTION_MS)),
  });
  return { status: "written", activityId, followUps, messages: pending.length };
}

/**
 * One pass over every customer channel: write notes for those that are due.
 * `assertLeaseHeld` throws once another replica has taken the pass over.
 */
export async function runCustomerChannelNotesPass(
  assertLeaseHeld: () => void = () => undefined,
  now = Date.now(),
): Promise<number> {
  const channels = await AppDataSource.getRepository(CustomerChannel).find({
    where: { employeeId: Not(IsNull()) },
    order: { lastNotedAt: "ASC" },
  });
  const windows = await pendingWindows(channels.map((channel) => channel.id));
  const due = channels.filter((channel) => notesDue(channel, windows.get(channel.id) ?? null, now));
  let turns = 0;
  let written = 0;
  for (const channel of due) {
    // Only a channel that reached the model counts against the pass. One that
    // cannot be worked right now is skipped in a few reads, and must not keep
    // a healthy channel behind it waiting.
    if (turns >= MAX_CHANNELS_PER_PASS) break;
    assertLeaseHeld();
    const result = await writeCustomerChannelNotes(channel.id, { now });
    if (result.status !== "skipped") turns += 1;
    if (result.status === "written") written += 1;
  }
  return written;
}
