import { LessThan, MoreThan, MoreThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { getChatSurfaceAdapter } from "../chatSurfaces/adapters.js";
import { truncateForSurface } from "../chatSurfaces/types.js";
import { decryptConnectionConfig } from "../integrations.js";
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

const channelQueues = new Map<string, Promise<void>>();

export function enqueueCustomerChannelReply(args: {
  channelId: string;
  messageId: string;
  reason: CustomerChannelReplyReason;
}): void {
  const previous = channelQueues.get(args.channelId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await replyToCustomerChannelMessage(args.messageId, args.reason);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[customer-channels] reply in ${args.channelId} failed:`,
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      if (channelQueues.get(args.channelId) === next) channelQueues.delete(args.channelId);
    });
  channelQueues.set(args.channelId, next);
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
 * Write and post the answer to one claimed message. Returns the employee's
 * kept reply, or null when nothing was posted.
 */
export async function replyToCustomerChannelMessage(
  messageId: string,
  reason: CustomerChannelReplyReason,
): Promise<CustomerChannelMessage | null> {
  const messages = AppDataSource.getRepository(CustomerChannelMessage);
  const message = await messages.findOneBy({ id: messageId });
  if (!message) return null;
  // Read the channel afresh: its reply mode or employee may have changed
  // since the message came in.
  const channel = await AppDataSource.getRepository(CustomerChannel).findOneBy({
    id: message.customerChannelId,
  });
  if (!channel || channel.replyMode === "notes" || !channel.employeeId) return null;
  if (reason === "question" && channel.replyMode !== "questions") return null;
  if (await customerChannelProblem(channel)) return null;
  if (reason === "question" && (await threadMovedOn(message))) return null;
  if ((await repliesInLastDay(channel.id)) >= MAX_REPLIES_PER_DAY) return null;

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
  if (!employee || !company || !customer || !connection || !model) return null;
  const adapter = getChatSurfaceAdapter(connection.provider);
  if (!adapter) return null;

  const thread = await threadMessages(channel.id, message.threadKey);
  const earlier =
    thread.length <= 1 ? await messagesBefore(channel.id, message.threadKey, message.postedAt) : [];

  const reply = await runReplyTurn({
    model,
    employee,
    system: composeReplySystemPrompt({ employee, company, customer, channel, reason }),
    user: composeReplyUserMessage({ channel, earlier, thread, replyTo: message }),
  });
  if (!reply) return null;
  if (reason === "question" && (await threadMovedOn(message))) return null;

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
  return kept;
}
