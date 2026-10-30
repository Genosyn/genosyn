import { AppDataSource } from "../db/datasource.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import { contextUsagePercent } from "./agent/contextUsage.js";
import { listChatActivity, turnAcceptedAt } from "./chatTurnActivity.js";
import { liveTurnFor, type LiveTurnFrame } from "./chatTurnLive.js";
import type { AgentProgress } from "./agent/types.js";

/**
 * Follow one chat turn from any browser, from any point, to its end.
 *
 * The browser that sent a message hears its turn over that request's own
 * stream. This is how everyone else hears it — the same Member after a
 * reload, a second tab, a phone — and how the sender re-attaches when its
 * stream drops. It sends, in order:
 *
 *   turn       the turn's identity and server clock, first
 *   activity   every recorded event after the reader's cursor, then live
 *   snapshot   the reply text so far (replaces what the reader holds)
 *   chunk      reply text as it streams (appends), while the turn is local
 *   progress   the employee's own milestones
 *   context    how full the AI Model's context window is
 *   heartbeat  the server clock, every few seconds, so a reader can tell a
 *              quiet turn from a dead connection
 *   assistant  the final reply row, once the turn has finished (a direct
 *              chat's; a Workspace channel turn sends its own final frames)
 *   done       the end of the stream
 *
 * While the turn runs in this process the hand-over is exact: the in-memory
 * events and text are read and the subscription taken in one synchronous
 * step. When it runs elsewhere (another replica, or not yet picked up) the
 * persisted rows are polled instead, and the stream switches to the live
 * record the moment the turn appears here.
 *
 * A direct chat's turn is an assistant {@link ConversationMessage}; a
 * Workspace channel's is a `ChannelTurn`, read through its own
 * {@link FollowSource}. Either way the events are the same rows and the same
 * live record, and `present` decides what this reader may see of each one
 * (`shared/turnActivityAccess.ts`).
 */

export type FollowSend = (event: string, data: unknown) => void;

/** What a follower needs to know about the turn, whatever row it lives on. */
export type FollowedTurn = {
  id: string;
  /** `working` while it runs; anything else means it has finished. */
  status: string | null;
  /** The reply so far, as last saved. */
  text: string;
  /** When the Member asked — every elapsed clock counts from here. */
  startedAt: Date;
  attempt: number;
  /** The employee's own milestone as last saved, when the row keeps one. */
  progress: AgentProgress | null;
  /** Extra fields for the opening `turn` frame. */
  extra?: Record<string, unknown>;
};

export type FollowSource = {
  read(): Promise<FollowedTurn | null>;
  /** The frames that close the stream once the turn has finished, `done` excluded. */
  finalFrames(): Promise<Array<{ event: string; data: unknown }>>;
};

const POLL_MS = 1_000;
const HEARTBEAT_MS = 10_000;

/** A direct chat's turn, read from its assistant message. */
export function conversationTurnSource(
  messageId: string,
  loadFinal: (message: ConversationMessage) => Promise<unknown>,
): FollowSource {
  const repo = AppDataSource.getRepository(ConversationMessage);
  return {
    async read() {
      const row = await repo.findOne({
        where: { id: messageId },
        select: [
          "id",
          "conversationId",
          "status",
          "content",
          "createdAt",
          "turnDeadlineAt",
          "turnAttempt",
          "progressPercent",
          "progressLabel",
        ],
      });
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        text: row.content,
        startedAt: turnAcceptedAt(row),
        attempt: row.turnAttempt,
        progress:
          typeof row.progressPercent === "number" && row.progressLabel
            ? { percent: row.progressPercent, label: row.progressLabel }
            : null,
      };
    },
    async finalFrames() {
      const full = await repo.findOneBy({ id: messageId });
      return full ? [{ event: "assistant", data: await loadFinal(full) }] : [];
    },
  };
}

export async function followChatTurn(args: {
  messageId: string;
  /** The last ordinal the reader already holds. */
  after: number;
  send: FollowSend;
  signal: AbortSignal;
  /** Where the turn lives. Defaults to a direct chat's assistant message. */
  source?: FollowSource;
  /** The final reply as the chat renders it, attachments included (direct chat). */
  loadFinal?: (message: ConversationMessage) => Promise<unknown>;
  /** What this reader may see of one event; null hides it. Defaults to all of it. */
  present?: (event: ChatActivityEvent) => ChatActivityEvent | null;
  /** What this reader may see of a milestone; null hides it. Defaults to all of it. */
  presentProgress?: (progress: AgentProgress) => AgentProgress | null;
  pollMs?: number;
  heartbeatMs?: number;
}): Promise<void> {
  const source =
    args.source ??
    conversationTurnSource(args.messageId, args.loadFinal ?? (async (message) => message));
  const present = args.present ?? ((event: ChatActivityEvent) => event);
  const presentProgress = args.presentProgress ?? ((progress: AgentProgress) => progress);
  let cursor = Math.max(0, args.after);
  let lastText: string | null = null;
  let lastProgress = "";
  let announced = false;

  const sendEvents = (events: ChatActivityEvent[]) => {
    for (const event of events) {
      if (event.ordinal <= cursor) continue;
      cursor = event.ordinal;
      const shown = present(event);
      if (shown) args.send("activity", shown);
    }
  };
  const sendText = (text: string) => {
    if (text === lastText) return;
    lastText = text;
    args.send("snapshot", { text });
  };
  const sendProgress = (progress: AgentProgress) => {
    const shown = presentProgress(progress);
    if (shown) args.send("progress", shown);
  };

  const heartbeat = setInterval(() => {
    if (!args.signal.aborted) args.send("heartbeat", { now: new Date().toISOString() });
  }, args.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    for (;;) {
      if (args.signal.aborted) return;
      const row = await source.read();
      if (!row) {
        args.send("error", { message: "This reply no longer exists." });
        return;
      }
      if (!announced) {
        announced = true;
        args.send("turn", {
          messageId: row.id,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          attempt: row.attempt,
          now: new Date().toISOString(),
          ...(row.extra ?? {}),
        });
      }

      if (row.status !== "working") {
        sendEvents(await listChatActivity(args.messageId, cursor, 1_000));
        for (const frame of await source.finalFrames()) args.send(frame.event, frame.data);
        args.send("done", {});
        return;
      }

      const live = liveTurnFor(args.messageId);
      if (live) {
        const first = live.firstOrdinal;
        if (first === null || first > cursor + 1) {
          const older = await listChatActivity(args.messageId, cursor, 1_000);
          sendEvents(first === null ? older : older.filter((event) => event.ordinal < first));
        }
        if (args.signal.aborted) return;
        // Anything that happened during that read is still in memory; read it
        // and subscribe in the same tick so nothing slips between the two.
        if (live.isEnded) continue;
        sendEvents(live.eventsAfter(cursor));
        sendText(live.text);
        const ended = await new Promise<"final" | "detached" | "aborted">((resolve) => {
          let unsubscribe: () => void = () => undefined;
          const onAbort = () => {
            unsubscribe();
            resolve("aborted");
          };
          unsubscribe = live.subscribe((frame: LiveTurnFrame) => {
            if (frame.type === "activity") sendEvents([frame.event]);
            else if (frame.type === "text") {
              lastText = (lastText ?? "") + frame.delta;
              args.send("chunk", { text: frame.delta });
            } else if (frame.type === "progress") sendProgress(frame.progress);
            else if (frame.type === "context") {
              args.send("context", {
                tokens: frame.usage.promptTokens,
                window: frame.usage.contextWindow,
                percent: contextUsagePercent(frame.usage.promptTokens, frame.usage.contextWindow),
              });
            } else {
              unsubscribe();
              args.signal.removeEventListener("abort", onAbort);
              resolve(frame.type);
            }
          });
          args.signal.addEventListener("abort", onAbort, { once: true });
          if (args.signal.aborted) onAbort();
        });
        if (ended === "aborted") return;
        // Final or detached: the row says which on the next pass.
        continue;
      }

      // Not running here: read what the worker persisted.
      sendEvents(await listChatActivity(args.messageId, cursor, 500));
      sendText(row.text);
      const progress = row.progress;
      const progressKey = progress ? `${progress.percent}|${progress.label}` : "";
      if (
        progress &&
        progressKey !== lastProgress &&
        progress.percent >= 1 &&
        progress.percent <= 99
      ) {
        lastProgress = progressKey;
        sendProgress(progress);
      }
      await sleep(args.pollMs ?? POLL_MS, args.signal);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
