import type { Repository } from "typeorm";
import type { ConversationMessage } from "../db/entities/ConversationMessage.js";
import type { AgentProgress } from "./agent/types.js";

type ProgressMessageRepository = Pick<Repository<ConversationMessage>, "update">;

/**
 * Serializes progress writes for one durable working message.
 *
 * The model-facing callback is synchronous, but database writes are not. A
 * small promise chain preserves milestone order and gives finalization a
 * `flush()` barrier so a late progress update can never overwrite the final
 * reply. Persistence failures are logged and swallowed: losing one milestone
 * must not abort hours of otherwise healthy employee work.
 */
export function createChatTurnProgressRecorder(options: {
  repository: ProgressMessageRepository;
  messageId: string;
  onProgress?: (progress: AgentProgress) => void;
  onPersistenceError?: (error: unknown) => void;
}) {
  let pending = Promise.resolve();

  function report(progress: AgentProgress): void {
    try {
      options.onProgress?.(progress);
    } catch {
      // A disconnected response is only a lost subscriber, not a failed turn.
    }

    pending = pending
      .then(async () => {
        await options.repository.update(
          { id: options.messageId, status: "working" },
          {
            progressPercent: progress.percent,
            progressLabel: progress.label,
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
    flush: () => pending,
  };
}
