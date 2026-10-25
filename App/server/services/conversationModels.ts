import { In, IsNull, Not } from "typeorm";

import type { ModelEffort } from "../../shared/modelEffort.js";
import { AppDataSource } from "../db/datasource.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { attachedModels } from "./models.js";
import { isModelConnected } from "./providers.js";

/** The AI Model a thread last ran a turn on, and the effort that turn used. */
export type ThreadModelChoice = {
  modelId: string;
  /** Null when that turn used the AI Model's default effort. */
  effort: ModelEffort | null;
};

/**
 * Which AI Model, at which effort, a chat thread should reopen on.
 *
 * Every accepted turn already persists the brain it ran on
 * (`ConversationMessage.modelId`) and how hard it was asked to think
 * (`ConversationMessage.effort`), so a thread knows what it has been talking
 * to. Reopening it on the employee's *current* active model instead silently
 * swaps brains mid-thread: the human sees a familiar transcript continued by a
 * different model, with a different context window, different tool habits, and
 * a different bill. These helpers hand the composer the thread's own model so
 * a past conversation carries on where it left off.
 *
 * A thread's model is only offered while it is still attached to this
 * employee and still connected. A deleted or disconnected row is skipped in
 * favour of the most recent turn that does qualify, and a thread with nothing
 * usable resolves to null so the caller falls back to the active model. The
 * effort always comes from the same turn as the model: it is a setting of that
 * model, and the composer only reapplies it while the model still supports it.
 */
export async function lastChatModelChoices(
  employeeId: string,
  conversationIds: string[],
): Promise<Map<string, ThreadModelChoice | null>> {
  const resolved = new Map<string, ThreadModelChoice | null>(
    conversationIds.map((id) => [id, null]),
  );
  if (resolved.size === 0) return resolved;

  const { models } = await attachedModels(employeeId);
  const usable = new Set(
    models.filter((model) => isModelConnected(model)).map((model) => model.id),
  );
  if (usable.size === 0) return resolved;

  // Only assistant turns carry a model, so the NOT NULL filter already drops
  // every human message. The winner per thread is picked in JS rather than with
  // a per-thread `LIMIT 1` query: the sidebar asks about every thread at once,
  // and one indexed read beats N round-trips on both SQLite and Postgres.
  const turns = await AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: In([...resolved.keys()]), modelId: Not(IsNull()) },
    select: { id: true, conversationId: true, modelId: true, effort: true, createdAt: true },
    order: { createdAt: "DESC" },
  });
  for (const turn of turns) {
    if (resolved.get(turn.conversationId)) continue;
    if (!turn.modelId || !usable.has(turn.modelId)) continue;
    resolved.set(turn.conversationId, { modelId: turn.modelId, effort: turn.effort ?? null });
  }
  return resolved;
}

/** {@link lastChatModelChoices} for a single thread. */
export async function lastChatModelChoice(
  employeeId: string,
  conversationId: string,
): Promise<ThreadModelChoice | null> {
  const resolved = await lastChatModelChoices(employeeId, [conversationId]);
  return resolved.get(conversationId) ?? null;
}
