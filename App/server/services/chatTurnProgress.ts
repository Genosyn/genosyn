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

/**
 * Saves a working reply's text so far, at most once per interval.
 *
 * The text streams token by token to the browser that sent the message; a
 * browser that attaches later, and a stop that lands on another replica's
 * turn, can only read what was saved. A leading write after a quiet interval
 * and one trailing write for the newest text keep the saved copy within an
 * interval of the screen without a write per token. Every write is
 * conditional on the row still being this worker's `working` turn, so a late
 * one can never overwrite the final reply.
 */
export function createReplyTextSnapshotter(options: {
  repository: ProgressMessageRepository;
  messageId: string;
  workerId: string;
  intervalMs: number;
  onPersistenceError?: (error: unknown) => void;
}) {
  let latest: string | null = null;
  let written = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt = 0;
  let pending = Promise.resolve();
  let cancelled = false;

  const write = () => {
    timer = null;
    if (cancelled || latest === null || latest === written) return;
    const text = latest;
    written = text;
    lastWriteAt = Date.now();
    pending = pending
      .then(async () => {
        await options.repository.update(
          { id: options.messageId, status: "working", turnWorkerId: options.workerId },
          { content: text },
        );
      })
      .catch((error) => {
        try {
          options.onPersistenceError?.(error);
        } catch {
          // Diagnostics never fail the turn.
        }
      });
  };

  return {
    report(text: string): void {
      if (cancelled) return;
      latest = text;
      if (timer) return;
      const wait = Math.max(0, options.intervalMs - (Date.now() - lastWriteAt));
      timer = setTimeout(write, wait);
      timer.unref?.();
    },
    /** Wait for the write already started; a newer one still waiting is left to `cancel`. */
    flush: () => pending,
    cancel(): void {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
