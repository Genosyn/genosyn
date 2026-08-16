import { In, IsNull, Not } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { isModelConnected } from "./providers.js";

/**
 * Which AI Model a chat thread should reopen on.
 *
 * Every accepted turn already persists the brain it ran on
 * (`ConversationMessage.modelId`), so a thread knows what it has been talking
 * to. Reopening it on the employee's *current* active model instead silently
 * swaps brains mid-thread: the human sees a familiar transcript continued by a
 * different model, with a different context window, different tool habits, and
 * a different bill. These helpers hand the composer the thread's own model so
 * a past conversation carries on where it left off.
 *
 * A thread's model is only offered while it is still one of this employee's
 * models and still connected. A deleted or disconnected row is skipped in
 * favour of the most recent turn that does qualify, and a thread with nothing
 * usable resolves to null so the caller falls back to the active model.
 */
export async function lastChatModelIds(
  employeeId: string,
  conversationIds: string[],
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>(conversationIds.map((id) => [id, null]));
  if (resolved.size === 0) return resolved;

  const models = await AppDataSource.getRepository(AIModel).find({ where: { employeeId } });
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
    select: { id: true, conversationId: true, modelId: true, createdAt: true },
    order: { createdAt: "DESC" },
  });
  for (const turn of turns) {
    if (resolved.get(turn.conversationId)) continue;
    if (!turn.modelId || !usable.has(turn.modelId)) continue;
    resolved.set(turn.conversationId, turn.modelId);
  }
  return resolved;
}

/** {@link lastChatModelIds} for a single thread. */
export async function lastChatModelId(
  employeeId: string,
  conversationId: string,
): Promise<string | null> {
  const resolved = await lastChatModelIds(employeeId, [conversationId]);
  return resolved.get(conversationId) ?? null;
}
