import { LessThan, MoreThan, MoreThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { getChatSurfaceAdapter } from "../chatSurfaces/adapters.js";
import { truncateForSurface } from "../chatSurfaces/types.js";
import { decryptConnectionConfig } from "../integrations.js";
import { ModelUnavailableError } from "../agent/modelOutage.js";
import { isModelAvailable } from "../modelAvailability.js";
import {
  parseWaitPayload,
  waitForModel,
  type ModelWaitHandler,
  type ModelWaitResult,
} from "../modelWaits.js";
import { getActiveModel } from "../models.js";
import { customerChannelProblem } from "./store.js";
import { composeReplySystemPrompt, composeReplyUserMessage, runReplyTurn } from "./turns.js";

/**
 * Answering in a customer channel.
 *
 * Every rule here exists to keep an AI Employee that talks in a room full of
 * customers from being the thing people mute:
 *
 *  - **One answer per message.** The claim is taken when the message is kept
 *    (`inbound.ts`); this module only ever runs for a claimed one.
 *  - **One turn at a time per channel**, in the order messages arrived, so a
 *    reply is written from a thread that already holds the one before it.
 *  - **An unprompted answer only while it is still the newest word.** If a
 *    colleague has replied, the question is theirs; if the customer has
 *    written again, the newer message gets the turn and sees this one. The
 *    same check runs again after the model answers, so a reply written while
 *    the thread moved on is dropped rather than posted out of date.
 *  - **At most {@link MAX_REPLIES_PER_DAY} posts a channel a day**, so a
 *    misunderstanding cannot become a flood.
 *  - Nothing at all when the channel's employee cannot work: unassigned, no
 *    longer granted the Connection, stood down, or without an AI Model.
 */

export type CustomerChannelReplyReason = "mention" | "question";

export const MAX_REPLIES_PER_DAY = 100;

/** The thread as the model reads it, newest last. */
const THREAD_MESSAGES = 40;
/** Messages from before the thread began, for a thread that is one message long. */
const EARLIER_MESSAGES = 10;

/**
 * How long an answer waits for an unavailable AI Model. A question in a shared
 * channel answered a day late answers a conversation that has moved on — the
 * team will have stepped in, and the notes still record what was asked.
 */
export const CUSTOMER_REPLY_WAIT_MS = 24 * 60 * 60_000;

const channelQueues = new Map<string, Promise<unknown>>();

/** Run `work` after everything already queued for this channel, one at a time. */
function inChannelQueue<T>(channelId: string, work: () => Promise<T>): Promise<T> {
  const previous = channelQueues.get(channelId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.catch(() => undefined);
  channelQueues.set(channelId, tail);
  void tail.finally(() => {
    if (channelQueues.get(channelId) === tail) channelQueues.delete(channelId);
  });
  return result;
}

export function enqueueCustomerChannelReply(args: {
  channelId: string;
  messageId: string;
  reason: CustomerChannelReplyReason;
}): void {
  void inChannelQueue(args.channelId, () =>
    replyToCustomerChannelMessage(args.messageId, args.reason),
  ).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[customer-channels] reply in ${args.channelId} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/** Wait for every queued reply. For tests, and for an orderly shutdown. */
export async function settleCustomerChannelReplies(): Promise<void> {
  while (channelQueues.size > 0) {
    await Promise.all([...channelQueues.values()]);
  }
}

async function threadMessages(
  channelId: string,
  threadKey: string,
): Promise<CustomerChannelMessage[]> {
  const rows = await AppDataSource.getRepository(CustomerChannelMessage).find({
    where: { customerChannelId: channelId, threadKey },
    order: { postedAt: "DESC" },
    take: THREAD_MESSAGES,
  });
  return rows.reverse();
}

async function messagesBefore(
  channelId: string,
  threadKey: string,
  before: Date,
): Promise<CustomerChannelMessage[]> {
  const rows = await AppDataSource.getRepository(CustomerChannelMessage).find({
    where: { customerChannelId: channelId, threadKey: Not(threadKey), postedAt: LessThan(before) },
    order: { postedAt: "DESC" },
    take: EARLIER_MESSAGES,
  });
  return rows.reverse();
}

/** Has a person written in the thread since this message? */
async function threadMovedOn(message: CustomerChannelMessage): Promise<boolean> {
  const newer = await AppDataSource.getRepository(CustomerChannelMessage).count({
    where: {
      customerChannelId: message.customerChannelId,
      threadKey: message.threadKey,
      postedAt: MoreThan(message.postedAt),
      authorKind: Not("employee"),
    },
  });
  return newer > 0;
}

export async function repliesInLastDay(channelId: string): Promise<number> {
  return AppDataSource.getRepository(CustomerChannelMessage).count({
    where: {
      customerChannelId: channelId,
      authorKind: "employee",
      postedAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    },
  });
}

/**
 * Since a message that waited for its AI Model: has the employee already
 * answered in the thread, has a colleague, or has a newer message in the
 * thread taken the answer (it is answered, or waits to be, with this one in
 * view)? Any of these, and a late answer would repeat or contradict the room.
 */
async function answeredSinceWaiting(message: CustomerChannelMessage): Promise<boolean> {
  const later = await AppDataSource.getRepository(CustomerChannelMessage).find({
    where: {
      customerChannelId: message.customerChannelId,
      threadKey: message.threadKey,
      postedAt: MoreThan(message.postedAt),
    },
    select: { id: true, authorKind: true, replyClaimedAt: true },
  });
  return later.some(
    (row) =>
      row.authorKind === "employee" ||
      row.authorKind === "team" ||
      (row.replyClaimedAt !== null && row.id !== message.id),
  );
}

/**
 * Write and post the answer to one claimed message. Returns the employee's
 * kept reply, or null when nothing was posted.
 */
export async function replyToCustomerChannelMessage(
  messageId: string,
  reason: CustomerChannelReplyReason,
): Promise<CustomerChannelMessage | null> {
  const answered = await answerCustomerChannelMessage(messageId, reason, { resumed: false });
  return answered.kind === "posted" ? answered.kept : null;
}

type ReplyOutcome =
  | { kind: "posted"; kept: CustomerChannelMessage }
  | { kind: "skipped" }
  /** Its AI Model is unavailable: the answer waits and is written when it is back. */
  | { kind: "waiting" };

async function answerCustomerChannelMessage(
  messageId: string,
  reason: CustomerChannelReplyReason,
  options: { resumed: boolean },
): Promise<ReplyOutcome> {
  const skipped: ReplyOutcome = { kind: "skipped" };
  const messages = AppDataSource.getRepository(CustomerChannelMessage);
  const message = await messages.findOneBy({ id: messageId });
  if (!message) return skipped;
  // Read the channel afresh: its reply mode or employee may have changed
  // since the message came in — or while its answer waited for the AI Model.
  const channel = await AppDataSource.getRepository(CustomerChannel).findOneBy({
    id: message.customerChannelId,
  });
  if (!channel || channel.replyMode === "notes" || !channel.employeeId) return skipped;
  if (reason === "question" && channel.replyMode !== "questions") return skipped;
  // Nothing at all when the employee cannot work — a Standdown placed while
  // the answer waited included: a stood-down employee posts nothing, however
  // the wait began.
  if (await customerChannelProblem(channel)) return skipped;
  if (reason === "question" && (await threadMovedOn(message))) return skipped;
  if (options.resumed && (await answeredSinceWaiting(message))) return skipped;
  if ((await repliesInLastDay(channel.id)) >= MAX_REPLIES_PER_DAY) return skipped;

  const [employee, company, customer, connection, model] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: channel.employeeId,
      companyId: channel.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: channel.companyId }),
    AppDataSource.getRepository(Customer).findOneBy({
      id: channel.customerId,
      companyId: channel.companyId,
    }),
    AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: channel.connectionId,
      companyId: channel.companyId,
    }),
    getActiveModel(channel.employeeId),
  ]);
  if (!employee || !company || !customer || !connection || !model) return skipped;
  const adapter = getChatSurfaceAdapter(connection.provider);
  if (!adapter) return skipped;

  // Its AI Model is unavailable: the message keeps its claim — no second
  // delivery can answer it — and its answer waits for the model, to be
  // written then under every rule above, checked again at that moment.
  const wait = async (): Promise<ReplyOutcome> => {
    await waitForModel({
      kind: "customer_channel_reply",
      targetId: message.id,
      companyId: channel.companyId,
      employeeId: employee.id,
      model,
      groupKey: `${channel.id}:${message.threadKey}`,
      payload: { reason },
    });
    return { kind: "waiting" };
  };
  if (!modelAnswers(model)) return wait();

  const thread = await threadMessages(channel.id, message.threadKey);
  const earlier =
    thread.length <= 1 ? await messagesBefore(channel.id, message.threadKey, message.postedAt) : [];

  let reply: string | null;
  try {
    reply = await runReplyTurn({
      model,
      employee,
      system: composeReplySystemPrompt({ employee, company, customer, channel, reason }),
      user: composeReplyUserMessage({ channel, earlier, thread, replyTo: message }),
    });
  } catch (error) {
    if (error instanceof ModelUnavailableError) return wait();
    throw error;
  }
  if (!reply) return skipped;
  if (reason === "question" && (await threadMovedOn(message))) return skipped;
  if (options.resumed && (await answeredSinceWaiting(message))) return skipped;

  const text = truncateForSurface(reply, adapter.textLimit);
  const sent = await adapter.send({
    connectionId: connection.id,
    config: decryptConnectionConfig(connection),
    // Always in the thread: a reply pasted into a customer's channel is the
    // difference between a helpful colleague and a nuisance.
    replyTo: { channel: channel.externalChannelId, thread_ts: message.threadKey },
    text,
  });
  const postedAt = new Date();
  const kept = await messages.save(
    messages.create({
      companyId: channel.companyId,
      customerChannelId: channel.id,
      externalMessageId: sent?.externalMessageId ?? null,
      threadKey: message.threadKey,
      authorKind: "employee",
      authorExternalId: employee.id,
      authorLabel: employee.name.slice(0, 200),
      text,
      postedAt,
      notedAt: null,
      // Its own words never ask for an answer.
      replyClaimedAt: postedAt,
    }),
  );
  await AppDataSource.getRepository(CustomerChannel)
    .createQueryBuilder()
    .update(CustomerChannel)
    .set({ lastMessageAt: postedAt })
    .where("id = :id", { id: channel.id })
    .execute();
  return { kind: "posted", kept };
}

function modelAnswers(model: Parameters<typeof isModelAvailable>[0]): boolean {
  try {
    return isModelAvailable(model);
  } catch {
    return true;
  }
}

/**
 * An answer that waited for its AI Model, written once the model is back: in
 * the channel's queue, so it is still one turn at a time and in order, and
 * through every rule a fresh message meets — the reply mode, the employee
 * able to work (no Standdown), the newest-word rule, the day's limit — plus
 * one more: if anyone answered in the thread meanwhile, nothing is posted.
 * The turn is the same restricted one-tool turn on the channel's instructions,
 * with nobody's authority. Given up after a day; the notes still record it.
 */
export const customerChannelReplyWait: ModelWaitHandler = {
  concurrency: 4,
  maxAgeMs: () => CUSTOMER_REPLY_WAIT_MS,
  resume: async (wait: AIModelWait): Promise<ModelWaitResult> => {
    const message = await AppDataSource.getRepository(CustomerChannelMessage).findOneBy({
      id: wait.targetId,
    });
    if (!message) return { status: "done" };
    const reason = parseWaitPayload<{ reason: CustomerChannelReplyReason }>(wait).reason;
    if (reason !== "mention" && reason !== "question") return { status: "done" };
    try {
      const outcome = await inChannelQueue(message.customerChannelId, () =>
        answerCustomerChannelMessage(message.id, reason, { resumed: true }),
      );
      return outcome.kind === "waiting" ? { status: "waiting" } : { status: "done" };
    } catch (err) {
      // As for a fresh message: a failed post is logged, never tried twice —
      // Slack may have taken it.
      // eslint-disable-next-line no-console
      console.error(
        `[customer-channels] an answer that waited for its AI Model failed:`,
        err instanceof Error ? err.message : err,
      );
      return { status: "done" };
    }
  },
  abandon: async () => {
    // Nothing to post a day late; the message is kept for the notes.
  },
};
