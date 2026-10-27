import { AppDataSource } from "../../db/datasource.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import {
  CustomerChannelMessage,
  type CustomerChannelAuthorKind,
} from "../../db/entities/CustomerChannelMessage.js";
import type { InboundChatTurn } from "../chatSurfaces/types.js";
import { enqueueCustomerChannelReply, type CustomerChannelReplyReason } from "./replies.js";

/**
 * A group message from an external chat surface, checked against the customer
 * channels and — when it was posted in one — kept and, if the channel's reply
 * mode says so, answered.
 *
 * Called by the shared chat-surface core before anything else looks at a group
 * turn, so a customer channel never reaches the ordinary path: no sighting is
 * recorded for the people in it (they are customers, and can never link a
 * Member account), no bind link is offered, and no Member's authority is
 * carried into a reply the customer will read.
 */

/** A message is kept up to this long. Slack allows forty thousand characters. */
const KEPT_TEXT_CHARS = 8_000;

function authorKindOf(turn: InboundChatTurn): CustomerChannelAuthorKind {
  return turn.outsideWorkspace ? "customer" : "team";
}

/**
 * Why this message gets an answer, or null when it gets none.
 *
 * A mention is answered unless the channel only takes notes. Without one, only
 * a channel set to answer customer questions answers, and only someone from
 * outside the company's workspace — colleagues talking to each other, or to
 * the customer, are never interrupted. A message that names the employee is
 * left to the copy Slack sends as a mention, which is the one answered.
 */
export function replyReasonFor(
  channel: Pick<CustomerChannel, "replyMode">,
  turn: Pick<InboundChatTurn, "overheard" | "mentionsEmployee">,
  authorKind: CustomerChannelAuthorKind,
): CustomerChannelReplyReason | null {
  if (channel.replyMode === "notes") return null;
  if (!turn.overheard) return "mention";
  if (turn.mentionsEmployee) return null;
  if (channel.replyMode === "questions" && authorKind === "customer") return "question";
  return null;
}

/** Keep the message once, however many times the platform delivers it. */
async function keepMessage(
  channel: CustomerChannel,
  turn: InboundChatTurn,
): Promise<CustomerChannelMessage> {
  const messages = AppDataSource.getRepository(CustomerChannelMessage);
  if (turn.externalMessageId) {
    const existing = await messages.findOneBy({
      customerChannelId: channel.id,
      externalMessageId: turn.externalMessageId,
    });
    if (existing) return existing;
  }
  const postedAt = turn.sentAt ?? new Date();
  try {
    return await messages.save(
      messages.create({
        companyId: channel.companyId,
        customerChannelId: channel.id,
        externalMessageId: turn.externalMessageId,
        threadKey: turn.externalThreadId ?? turn.externalMessageId ?? "",
        authorKind: authorKindOf(turn),
        authorExternalId: turn.externalUserId,
        authorLabel: (turn.externalUserLabel ?? "").slice(0, 200),
        text: turn.text.slice(0, KEPT_TEXT_CHARS),
        postedAt,
        notedAt: null,
        replyClaimedAt: null,
      }),
    );
  } catch (err) {
    // A mention arrives as two events at once. The unique index decides which
    // copy is kept, and the loser reads the winner's row back.
    if (turn.externalMessageId) {
      const kept = await messages.findOneBy({
        customerChannelId: channel.id,
        externalMessageId: turn.externalMessageId,
      });
      if (kept) return kept;
    }
    throw err;
  }
}

/** Move the channel's clock forward, never back — deliveries arrive out of order. */
export async function touchCustomerChannel(channelId: string, at: Date): Promise<void> {
  await AppDataSource.getRepository(CustomerChannel)
    .createQueryBuilder()
    .update(CustomerChannel)
    .set({ lastMessageAt: at })
    .where("id = :id AND (lastMessageAt IS NULL OR lastMessageAt < :at)", { id: channelId, at })
    .execute();
}

/**
 * Claim the one answer this message may get. A conditional update rather than
 * a read, so two deliveries racing each other cannot both win.
 */
async function claimReply(messageId: string): Promise<boolean> {
  const claimed = await AppDataSource.getRepository(CustomerChannelMessage)
    .createQueryBuilder()
    .update(CustomerChannelMessage)
    .set({ replyClaimedAt: new Date() })
    .where("id = :id AND replyClaimedAt IS NULL", { id: messageId })
    .execute();
  return (claimed.affected ?? 0) > 0;
}

/**
 * Handle a group turn that may belong to a customer channel. Returns false
 * when it does not, leaving the turn to the ordinary chat-surface path.
 */
export async function routeCustomerChannelTurn(turn: InboundChatTurn): Promise<boolean> {
  if (!turn.group || !turn.externalChannelId) return false;
  const channel = await AppDataSource.getRepository(CustomerChannel).findOneBy({
    connectionId: turn.connectionId,
    externalChannelId: turn.externalChannelId,
  });
  if (!channel || channel.companyId !== turn.companyId) return false;

  const message = await keepMessage(channel, turn);
  await touchCustomerChannel(channel.id, message.postedAt);

  const reason = replyReasonFor(channel, turn, message.authorKind);
  if (reason && (await claimReply(message.id))) {
    // Queued rather than awaited: a socket hands every message in the
    // workspace through one delivery line, and a model turn on it would hold
    // up the messages of every other channel behind this one.
    enqueueCustomerChannelReply({ channelId: channel.id, messageId: message.id, reason });
  }
  return true;
}
