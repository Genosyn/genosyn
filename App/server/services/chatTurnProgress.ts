import type { Repository } from "typeorm";
import type { ConversationMessage } from "../db/entities/ConversationMessage.js";
import type { AgentProgress } from "./agent/types.js";

type ProgressMessageRepository = Pick<Repository<ConversationMessage>, "update">;

/**
 * Lead with an immediate refresh, then guarantee one trailing refresh for the
 * newest milestone received during the quieting interval.
 */
export function createProgressRefreshNotifier(options: { notify: () => void; intervalMs: number }) {
  let lastNotifiedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    lastNotifiedAt = Date.now();
    try {
      options.notify();
    } catch {
      // A live-refresh subscriber must not escape from a timer or fail work.
    }
  };

  const report = () => {
    const elapsed = Date.now() - lastNotifiedAt;
    if (lastNotifiedAt === 0 || elapsed >= options.intervalMs) {
      if (timer) clearTimeout(timer);
      timer = null;
      notify();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      notify();
    }, options.intervalMs - elapsed);
    timer.unref?.();
  };

  return {
    report,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

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
  workerId?: string;
  onProgress?: (progress: AgentProgress) => void;
  onPersisted?: (progress: AgentProgress) => void;
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
        const updated = await options.repository.update(
          {
            id: options.messageId,
            status: "working",
            ...(options.workerId ? { turnWorkerId: options.workerId } : {}),
          },
          {
            progressPercent: progress.percent,
            progressLabel: progress.label,
          },
        );
        if (updated.affected !== 1) return;
        try {
          options.onPersisted?.(progress);
        } catch {
          // A live-refresh subscriber is best effort, just like a stream subscriber.
        }
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
