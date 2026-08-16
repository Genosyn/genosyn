import type { Repository } from "typeorm";
import type { ConversationMessage } from "../db/entities/ConversationMessage.js";
import type { ContextUsage } from "./agent/types.js";

type ContextMessageRepository = Pick<Repository<ConversationMessage>, "update">;

/**
 * Records how full the model's context window is onto one durable chat turn.
 *
 * Shaped after {@link ./chatTurnProgress.createChatTurnProgressRecorder} and for
 * the same reasons — a synchronous model-facing callback, asynchronous writes,
 * one promise chain to keep them ordered, and a `flush()` barrier so a late
 * write cannot land after finalization. Persistence failures are logged and
 * swallowed: losing a gauge reading must not abort hours of employee work.
 *
 * Two differences from the progress recorder are deliberate:
 *
 *  - **It writes only on change.** A long turn calls the model dozens of times
 *    and the reading barely moves between adjacent steps. Progress milestones
 *    are authored by the employee and are rare; this fires on every provider
 *    response, so an unconditional write would put a hundred UPDATEs on the
 *    chat table for one message.
 *  - **It exposes `latest()`.** The finalize patch has to carry the last
 *    reading itself: it runs a conditional UPDATE guarded on `status=working`,
 *    and once it commits, every write this recorder could still make is dead.
 *    Folding the value into that patch is what makes the number survive the
 *    turn ending.
 */
export function createChatTurnContextUsageRecorder(options: {
  repository: ContextMessageRepository;
  messageId: string;
  workerId?: string;
  onContextUsage?: (usage: ContextUsage) => void;
  onPersistenceError?: (error: unknown) => void;
}) {
  let pending = Promise.resolve();
  let latest: ContextUsage | null = null;

  function report(usage: ContextUsage): void {
    try {
      options.onContextUsage?.(usage);
    } catch {
      // A disconnected response is only a lost subscriber, not a failed turn.
    }

    const unchanged =
      latest !== null &&
      latest.promptTokens === usage.promptTokens &&
      latest.contextWindow === usage.contextWindow;
    latest = usage;
    if (unchanged) return;

    pending = pending
      .then(async () => {
        await options.repository.update(
          {
            id: options.messageId,
            status: "working",
            ...(options.workerId ? { turnWorkerId: options.workerId } : {}),
          },
          {
            contextTokens: usage.promptTokens,
            contextWindow: usage.contextWindow,
          },
        );
      })
      .catch((error) => {
        try {
          options.onPersistenceError?.(error);
        } catch {
          // Diagnostics must not turn a contained checkpoint failure fatal.
        }
      });
  }

  return {
    report,
    /** The most recent reading, or null when the provider never reported one. */
    latest: () => latest,
    flush: () => pending,
  };
}
