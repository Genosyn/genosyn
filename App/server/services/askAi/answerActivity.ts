import { AppDataSource } from "../../db/datasource.js";
import { AskAiMessage } from "../../db/entities/AskAiMessage.js";
import type { ChatActivityEvent } from "../../../shared/chatActivity.js";
import type { AgentProgress } from "../agent/types.js";
import { INTERRUPTED_BEFORE_REPLY } from "../chat.js";
import {
  ChatTurnActivityRecorder,
  lastChatActivity,
  listChatActivity,
  nextChatActivityOrdinal,
  recordDetachedChatActivity,
  summarizeChatActivity,
} from "../chatTurnActivity.js";
import { followChatTurn, type FollowSend, type FollowSource } from "../chatTurnFollow.js";
import { openLiveTurn, releaseLiveTurn, type LiveTurn } from "../chatTurnLive.js";
import { createReplyTextSnapshotter } from "../chatTurnProgress.js";

/**
 * What an AI Employee is doing while it answers in Ask AI, and the Stop that
 * ends it.
 *
 * An answer can run for many minutes — reading Bases, building a chart,
 * running commands — and a Member watching "working…" for all of it cannot
 * tell progress from a hang. So an answer records its steps the way a direct
 * chat's reply does, through the same recorder, live record and follow stream
 * (`chatTurnActivity.ts`, `chatTurnLive.ts`, `chatTurnFollow.ts`): its rows are
 * `ConversationActivityEvent`s with the Ask AI conversation as
 * `conversationId` and the answer's {@link AskAiMessage} as `messageId`, and
 * the panel shows them on the same card as every other chat.
 *
 * Reads go through the conversation, which only its owner can open, and only
 * from a signed-in browser (`routes/askAi.ts`).
 *
 * Stopping is in-process when the answer runs here. When it runs on another
 * replica the row is finalized from here, and that replica notices within
 * {@link STILL_OWED_CHECK_MS} that the answer it is writing is no longer owed
 * and stops its AI Model too.
 */

/** How often a running answer checks it is still owed: a stop that landed elsewhere. */
const STILL_OWED_CHECK_MS = 5_000;
/** How often the answer's text so far is saved, for a reader on another replica. */
const REPLY_SNAPSHOT_MS = 1_500;

/** Answers running in this process, by their row's id. */
const running = new Map<string, AskAiAnswerRun>();

export type AskAiAnswerRunOptions = {
  /** Test seam: how often the run checks its row is still owed. */
  stillOwedCheckMs?: number;
};

/** One answer as it runs here: its live record, its recorded steps, and its Stop. */
export class AskAiAnswerRun {
  private readonly controller = new AbortController();
  private stoppedHere = false;
  private lostRow = false;
  private waitingForThread = false;
  private text = "";
  private released = false;
  private readonly watcher: ReturnType<typeof setInterval>;
  private readonly snapshot: ReturnType<typeof createReplyTextSnapshotter>;

  private constructor(
    readonly row: AskAiMessage,
    readonly recorder: ChatTurnActivityRecorder,
    readonly live: LiveTurn,
    options: AskAiAnswerRunOptions,
  ) {
    const repo = AppDataSource.getRepository(AskAiMessage);
    this.snapshot = createReplyTextSnapshotter({
      intervalMs: REPLY_SNAPSHOT_MS,
      save: (text) => repo.update({ id: row.id, status: "working" }, { content: text }),
      onPersistenceError: (error) => {
        console.error(`[ask-ai] reply snapshot save failed message=${row.id}`, error);
      },
    });
    this.watcher = setInterval(
      () => void this.checkStillOwed(),
      options.stillOwedCheckMs ?? STILL_OWED_CHECK_MS,
    );
    this.watcher.unref?.();
  }

  /** Start recording an answer this process is about to write. */
  static async open(
    row: AskAiMessage,
    options: AskAiAnswerRunOptions = {},
  ): Promise<AskAiAnswerRun> {
    const live = openLiveTurn(row.id, row.conversationId);
    // A new answer has recorded nothing yet; a failed look must not leave it owed.
    const firstOrdinal = await nextChatActivityOrdinal(row.id).catch(() => 1);
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: row.companyId,
        conversationId: row.conversationId,
        messageId: row.id,
        attempt: 1,
      },
      firstOrdinal,
      { live },
    );
    const run = new AskAiAnswerRun(row, recorder, live, options);
    running.set(row.id, run);
    return run;
  }

  /** Aborted when the answer must stop: a Member stopped it, here or elsewhere. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** A Member stopped this answer, here or on another replica. */
  get stopped(): boolean {
    return this.stoppedHere || this.lostRow;
  }

  /** Everything the employee has written so far. */
  get streamed(): string {
    return this.text;
  }

  /** Reply text as it streams: to whoever follows the answer, and saved now and then. */
  appendText(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    this.live.appendText(chunk);
    this.snapshot.report(this.text);
  }

  /** The employee's own milestone, from the progress control. */
  progress(progress: AgentProgress): void {
    this.recorder.progress(progress);
    this.live.progress(progress);
  }

  /** Another answer in this conversation is still being written; said once per wait. */
  waitForThread(): void {
    if (this.waitingForThread) return;
    this.waitingForThread = true;
    this.recorder.waiting("thread_busy");
  }

  /** Wait between tries, or until the answer is stopped. */
  pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      const signal = this.signal;
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** A Member asked to stop. False when there was nothing left to stop here. */
  stop(): boolean {
    if (this.released || this.stopped) return false;
    this.stoppedHere = true;
    this.recorder.stopped();
    this.controller.abort();
    return true;
  }

  /**
   * The answer's row was finished; record the end. `summary` is what the row
   * now says, or null when somebody else finished it — a stop from another
   * replica, which already wrote the end — and this run only lets go.
   */
  async end(summary: ReturnType<ChatTurnActivityRecorder["summarize"]> | null): Promise<void> {
    // The row holds the final text now; a snapshot still due would change nothing.
    this.snapshot.cancel();
    if (summary) {
      await this.recorder.finish(summary);
      this.live.finish();
    } else {
      await this.recorder.close();
      this.live.detach();
    }
  }

  /** Let go of everything this run holds. Safe to call more than once. */
  release(): void {
    if (this.released) return;
    this.released = true;
    clearInterval(this.watcher);
    this.snapshot.cancel();
    if (running.get(this.row.id) === this) running.delete(this.row.id);
    this.live.detach();
    releaseLiveTurn(this.live);
  }

  private async checkStillOwed(): Promise<void> {
    if (this.released || this.stopped) return;
    try {
      const row = await AppDataSource.getRepository(AskAiMessage).findOne({
        where: { id: this.row.id },
        select: { id: true, status: true },
      });
      if (row && row.status === "working") return;
      // Finished elsewhere — a stop that landed on another replica. Its end is
      // already written; this one stops its AI Model and lets go.
      this.lostRow = true;
      this.controller.abort();
    } catch {
      // A failed look proves nothing; the next one decides.
    }
  }
}

export type StopAskAiAnswerOutcome = "stopped" | "not_running";

/**
 * Stop one answer a Member is waiting on. One running here stops at once and
 * finishes its own row with what it had written. One that is queued behind
 * another employee never starts. One running elsewhere — or left behind by a
 * process that died — is finished from here, keeping the text it last saved.
 */
export async function stopAskAiAnswer(row: AskAiMessage): Promise<StopAskAiAnswerOutcome> {
  const local = running.get(row.id);
  if (local) {
    // Already stopping counts too: it finishes its own row in a moment.
    local.stop();
    return "stopped";
  }
  const repo = AppDataSource.getRepository(AskAiMessage);
  if (row.status === "queued") {
    const stopped = await repo.update(
      { id: row.id, status: "queued" },
      { status: "interrupted", content: INTERRUPTED_BEFORE_REPLY },
    );
    return stopped.affected === 1 ? "stopped" : "not_running";
  }
  if (row.status !== "working") return "not_running";
  const stopped = await repo.update(
    { id: row.id, status: "working" },
    {
      status: "interrupted",
      content: row.content.trim() ? row.content : INTERRUPTED_BEFORE_REPLY,
    },
  );
  if (stopped.affected !== 1) return "not_running";
  try {
    const endedAt = new Date();
    await recordDetachedChatActivity(
      {
        companyId: row.companyId,
        conversationId: row.conversationId,
        messageId: row.id,
        attempt: 1,
      },
      (recorder) => recorder.stopped(),
    );
    const summary = await summarizeChatActivity({
      messageId: row.id,
      status: "interrupted",
      startedAt: row.createdAt,
      endedAt,
    });
    await repo.update({ id: row.id }, { activityJson: JSON.stringify(summary) });
  } catch (error) {
    // The stop stands; only its record is missing a line.
    console.warn(`[ask-ai] could not record the stop of message ${row.id}`, error);
  }
  return "stopped";
}

/**
 * The summary of an answer that ended without its worker — a restart cut it
 * off — counted from its recorded steps up to the last of them. Empty when it
 * recorded none.
 */
export async function summarizeAbandonedAnswer(
  row: Pick<AskAiMessage, "id" | "createdAt">,
  status: string,
): Promise<string> {
  const last = await lastChatActivity(row.id);
  if (!last) return "";
  const endedAt = new Date(Date.parse(last.at) || row.createdAt.getTime());
  const summary = await summarizeChatActivity({
    messageId: row.id,
    status,
    startedAt: row.createdAt,
    endedAt: endedAt.getTime() < row.createdAt.getTime() ? row.createdAt : endedAt,
  });
  return JSON.stringify(summary);
}

/** One page of an answer's recorded steps, oldest first. */
export async function listAskAiAnswerActivity(
  row: Pick<AskAiMessage, "id" | "status">,
  after: number,
  limit: number,
): Promise<{ events: ChatActivityEvent[]; more: boolean; status: AskAiMessage["status"] }> {
  const events = await listChatActivity(row.id, after, limit + 1);
  return { events: events.slice(0, limit), more: events.length > limit, status: row.status };
}

/**
 * Follow one answer live, from the reader's cursor to its end: the steps, the
 * text as it is written, and what the AI Model is doing right now. A queued
 * answer is followed until its turn comes; a finished one replays what the
 * reader has not seen, sends the answer, and ends.
 */
export async function followAskAiAnswer(args: {
  messageId: string;
  after: number;
  send: FollowSend;
  signal: AbortSignal;
  /** The finished answer as the panel renders it, attachments included. */
  loadFinal: (row: AskAiMessage) => Promise<unknown>;
}): Promise<void> {
  const repo = AppDataSource.getRepository(AskAiMessage);
  const source: FollowSource = {
    async read() {
      const row = await repo.findOne({
        where: { id: args.messageId },
        select: { id: true, status: true, content: true, createdAt: true },
      });
      if (!row) return null;
      return {
        id: row.id,
        // Still owed either way: a queued answer is written once its turn comes.
        status: row.status === "queued" ? "working" : row.status,
        text: row.content,
        startedAt: row.createdAt,
        attempt: 1,
        progress: null,
      };
    },
    async finalFrames() {
      const row = await repo.findOneBy({ id: args.messageId });
      return row ? [{ event: "assistant", data: await args.loadFinal(row) }] : [];
    },
  };
  await followChatTurn({
    messageId: args.messageId,
    after: args.after,
    send: args.send,
    signal: args.signal,
    source,
  });
}
