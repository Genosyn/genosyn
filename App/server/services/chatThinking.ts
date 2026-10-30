import type { ModelEffort } from "../../shared/modelEffort.js";
import {
  resolveThinking,
  type ResolvedThinking,
  type TurnThinking,
} from "../../shared/thinkingLevels.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { Conversation } from "../db/entities/Conversation.js";
import { modelThinking } from "./modelEffort.js";

/**
 * A chat conversation's thinking level, from the Member's choice to what each
 * reply ran at. The rules live in `shared/thinkingLevels.ts`, so the composer
 * shows exactly what the server runs; this module applies them to rows.
 *
 *   1. A Member sets the conversation's level (`Conversation.effort`, null for
 *      Default) from the composer; it sticks to the conversation.
 *   2. Accepting a message resolves that level against the AI Model the turn
 *      runs on — its levels, its owners' default and ceiling — and stores the
 *      level to send on the durable turn (`ConversationMessage.effort`) and
 *      the record the reply shows (`thinkingJson`).
 *   3. When the turn runs, the stored level is checked against the model again
 *      (it may have been edited meanwhile) and moved, never refused.
 *   4. If the AI Model refuses the level mid-turn, the runtime carries on at
 *      the model's own default and the record says so.
 */

/** What a turn accepted on `model` sends, and the record its reply keeps. */
export function chatTurnThinking(
  model: AIModel | null,
  requested: ModelEffort | null,
): { effort: ModelEffort | null; thinking: TurnThinking | null } {
  if (!model) return { effort: null, thinking: null };
  const resolved = resolveThinking(modelThinking(model), requested);
  return {
    effort: resolved.send,
    thinking: { level: resolved.level, requested, adjusted: resolved.adjusted },
  };
}

/**
 * The level a stored turn runs at on `model` now. A turn sent with no level
 * stays at the model's own default; one whose level the model no longer
 * offers, or the company's ceiling no longer allows, moves to the nearest
 * level that is.
 */
export function runTimeThinking(model: AIModel, effort: ModelEffort | null): ResolvedThinking {
  if (effort === null) return { send: null, level: null, requested: null, adjusted: null };
  return resolveThinking(modelThinking(model), effort);
}

/** The reply's record once the turn moved its level when it ran. */
export function thinkingAfterRunTimeChange(
  recorded: TurnThinking | null,
  resolved: ResolvedThinking,
): TurnThinking {
  return {
    level: resolved.level,
    requested: recorded?.requested ?? resolved.requested,
    adjusted: resolved.adjusted,
  };
}

/** The reply's record once the AI Model refused `refused` and answered at its own default. */
export function thinkingAfterRefusal(
  recorded: TurnThinking | null,
  refused: ModelEffort,
): TurnThinking {
  return { level: null, requested: recorded?.requested ?? null, adjusted: "rejected", refused };
}

/**
 * The conversation level a message is sent at: the level the message names,
 * which becomes the conversation's, else the conversation's own. Null is
 * Default, as is a conversation the Member does not own — which the turn
 * itself then refuses.
 */
export async function conversationEffortForMessage(args: {
  conversationId: string;
  employeeId: string;
  ownerUserId: string;
  /** The level the message names; undefined when it names none. */
  effort: ModelEffort | null | undefined;
}): Promise<ModelEffort | null> {
  if (args.effort !== undefined) {
    const updated = await setConversationEffort({ ...args, effort: args.effort });
    return updated?.effort ?? null;
  }
  const conversation = await AppDataSource.getRepository(Conversation).findOne({
    where: { id: args.conversationId, employeeId: args.employeeId, ownerUserId: args.ownerUserId },
    select: { id: true, effort: true },
  });
  return conversation?.effort ?? null;
}

/**
 * Set the thinking level of a conversation its owner holds. Null is Default.
 * Returns the conversation, or null when the Member does not own it — a
 * legacy thread must be claimed first, like sending to it.
 */
export async function setConversationEffort(args: {
  conversationId: string;
  employeeId: string;
  ownerUserId: string;
  effort: ModelEffort | null;
}): Promise<Conversation | null> {
  const repo = AppDataSource.getRepository(Conversation);
  const conversation = await repo.findOneBy({
    id: args.conversationId,
    employeeId: args.employeeId,
    ownerUserId: args.ownerUserId,
  });
  if (!conversation) return null;
  if (conversation.effort !== args.effort) {
    // A setting, not activity: it must not move the thread up the sidebar.
    await repo.update({ id: conversation.id }, { effort: args.effort, updatedAt: conversation.updatedAt });
    conversation.effort = args.effort;
  }
  return conversation;
}
