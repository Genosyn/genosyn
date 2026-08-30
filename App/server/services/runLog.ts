/**
 * Durable transcript buffering for Routine Runs.
 *
 * The live log is still held in memory for fast polling, but snapshots are
 * also written to `Run.logContent` while the Run is active. A process crash
 * can therefore lose at most the current checkpoint window instead of the
 * entire transcript.
 *
 * **M58 changes a pinned behaviour: the buffer is no longer head-only.** It
 * used to fill to the cap, append a truncation marker, and then discard every
 * later write — so on a long Run the one part nobody could read was the
 * ending. That is the part that matters. The final answer, the last tool
 * results, and whatever the Run did just before it stopped all live there, and
 * every downstream consumer reads from the end: the outcome checker grades the
 * transcript tail, the reflection turn reads the same tail, and a human
 * opening a Run scrolls to the bottom. All three were being handed a
 * truncation marker and asked to judge the work behind it.
 *
 * So the buffer keeps a head and a rolling tail, with a marker between them
 * naming how many bytes fell out of the middle. The middle is what a long Run
 * can afford to lose: scaffolding, repeated tool chatter, the same file read
 * four times. The total never grows — the cap is still
 * {@link RUN_LOG_MAX_BYTES}, so no `logContent` row is larger than it was.
 */

export const RUN_LOG_MAX_BYTES = 256 * 1024;
export const RUN_LOG_CHECKPOINT_INTERVAL_MS = 1000;

/**
 * The opening of the transcript is kept whole: the brief, the plan, and the
 * first few tool calls are where a reader works out what the Run thought it
 * was doing, and they are written once rather than accumulating.
 */
export const RUN_LOG_HEAD_BYTES = 192 * 1024;

/**
 * The rolling window at the end. Sized to comfortably contain the 24,000
 * characters the outcome checker and the reflection turn each read, so the
 * evidence those two grade is never the marker.
 */
export const RUN_LOG_TAIL_BYTES = 64 * 1024;

/**
 * Bytes held back from the content budget for the omission marker itself, so
 * the rendered value stays under the cap rather than overshooting it by the
 * marker's length the way the head-only buffer did. Generous: the longest
 * marker this can produce is under forty bytes. Caps under half a kilobyte
 * scale the reserve down with everything else and can therefore render a few
 * bytes over — a shape no caller has, and not worth a special case.
 */
const OMISSION_MARKER_RESERVE = 64;

/** Longest single-line preview of a tool result kept in the transcript. */
export const TOOL_RESULT_PREVIEW_CHARS = 300;

type DurableRunLogOptions = {
  persist: (content: string) => Promise<void>;
  cap?: number;
  /** Test seam: the head/tail split is meaningless at a toy cap otherwise. */
  headBytes?: number;
  tailBytes?: number;
  checkpointEveryMs?: number;
  onCheckpointError?: (error: unknown) => void;
};

/** One retained chunk, carrying its measured size so trimming never re-measures. */
type Chunk = { text: string; bytes: number };

export class DurableRunLog {
  private readonly headParts: string[] = [];
  private headSize = 0;

  /**
   * The tail is a deque: appended at the end, dropped from the front. `tailAt`
   * is the front cursor — `Array.prototype.shift()` on a buffer holding one
   * entry per streamed token would make trimming quadratic on exactly the Runs
   * that need it. Compacted when the dead prefix grows past half the array.
   */
  private readonly tailParts: Chunk[] = [];
  private tailAt = 0;
  private tailSize = 0;

  private omitted = 0;
  private revision = 0;
  private queuedRevision = 0;
  private persistedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  private readonly persist: (content: string) => Promise<void>;
  private readonly cap: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly checkpointEveryMs: number;
  private readonly onCheckpointError?: (error: unknown) => void;

  constructor(options: DurableRunLogOptions) {
    this.persist = options.persist;
    this.cap = options.cap ?? RUN_LOG_MAX_BYTES;
    this.checkpointEveryMs = options.checkpointEveryMs ?? RUN_LOG_CHECKPOINT_INTERVAL_MS;
    this.onCheckpointError = options.onCheckpointError;
    // A cap too small to hold both budgets shrinks them in proportion rather
    // than letting the head eat it whole: a caller who lowers the cap wants a
    // smaller transcript, not the head-only behaviour this class just left
    // behind.
    const reserve = Math.min(OMISSION_MARKER_RESERVE, Math.floor(this.cap / 8));
    const budget = Math.max(0, this.cap - reserve);
    const wantHead = Math.max(0, options.headBytes ?? RUN_LOG_HEAD_BYTES);
    const wantTail = Math.max(0, options.tailBytes ?? RUN_LOG_TAIL_BYTES);
    if (wantHead + wantTail <= budget) {
      this.headLimit = wantHead;
      this.tailLimit = wantTail;
    } else {
      this.headLimit = Math.floor((budget * wantHead) / (wantHead + wantTail || 1));
      this.tailLimit = budget - this.headLimit;
    }
  }

  /**
   * Append. Called once per streamed token, so it does no work proportional to
   * what is already buffered: sizes are carried on each chunk and the cap is
   * enforced by dropping from the front, never by re-measuring the whole log.
   */
  write(s: string): void {
    if (!s) return;
    let rest = s;

    if (this.headSize < this.headLimit) {
      const room = this.headLimit - this.headSize;
      const bytes = Buffer.byteLength(rest, "utf8");
      if (bytes <= room) {
        this.headParts.push(rest);
        this.headSize += bytes;
        this.changed();
        return;
      }
      // Sliced by code unit rather than by byte: the exact boundary costs a
      // decode of every token, and being a few bytes shy of the head budget on
      // multi-byte text is not worth that on the hot path.
      const fits = rest.slice(0, room);
      if (fits) {
        this.headParts.push(fits);
        this.headSize += Buffer.byteLength(fits, "utf8");
      }
      rest = rest.slice(fits.length);
      if (!rest) {
        this.changed();
        return;
      }
    }

    if (this.tailLimit === 0) {
      // No room for a tail at this cap — everything past the head is dropped,
      // and the marker says how much.
      this.omitted += Buffer.byteLength(rest, "utf8");
      this.changed();
      return;
    }

    const restBytes = Buffer.byteLength(rest, "utf8");
    this.tailParts.push({ text: rest, bytes: restBytes });
    this.tailSize += restBytes;
    this.trimTail();
    this.changed();
  }

  line(s: string): void {
    this.write(s + "\n");
  }

  value(): string {
    const head = this.headParts.join("");
    if (this.omitted === 0) return head + this.tailText();
    return head + `\n[… ${this.omitted} bytes omitted …]\n` + this.tailText();
  }

  /** True once any byte has been dropped — unchanged in meaning. */
  get isTruncated(): boolean {
    return this.omitted > 0;
  }

  /**
   * Persist the newest snapshot now. Checkpoints are serialized, so a slow
   * older write can never land after and overwrite a newer transcript.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    this.enqueueLatest();
    await this.pending;
  }

  /**
   * Flush the final running-state checkpoint and stop scheduling background
   * writes. The caller still performs the terminal Run save afterward.
   */
  async stopCheckpointing(): Promise<void> {
    if (this.stopped) {
      await this.pending;
      return;
    }
    this.stopped = true;
    this.clearTimer();
    this.enqueueLatest();
    await this.pending;
  }

  private tailText(): string {
    let out = "";
    for (let i = this.tailAt; i < this.tailParts.length; i++) out += this.tailParts[i].text;
    return out;
  }

  private trimTail(): void {
    while (this.tailSize > this.tailLimit && this.tailAt < this.tailParts.length) {
      const front = this.tailParts[this.tailAt];
      const excess = this.tailSize - this.tailLimit;
      if (front.bytes <= excess) {
        this.tailSize -= front.bytes;
        this.omitted += front.bytes;
        this.tailAt += 1;
        continue;
      }
      const kept = front.text.slice(excess);
      const keptBytes = Buffer.byteLength(kept, "utf8");
      this.omitted += front.bytes - keptBytes;
      this.tailSize -= front.bytes - keptBytes;
      this.tailParts[this.tailAt] = { text: kept, bytes: keptBytes };
    }
    if (this.tailAt > 64 && this.tailAt * 2 > this.tailParts.length) {
      this.tailParts.splice(0, this.tailAt);
      this.tailAt = 0;
    }
  }

  private changed(): void {
    this.revision += 1;
    if (!this.stopped) this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queuedRevision >= this.revision) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueLatest();
    }, this.checkpointEveryMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueueLatest(): void {
    if (this.queuedRevision >= this.revision) return;
    const revision = this.revision;
    const content = this.value();
    this.queuedRevision = revision;

    this.pending = this.pending.then(async () => {
      try {
        await this.persist(content);
        this.persistedRevision = Math.max(this.persistedRevision, revision);
      } catch (error) {
        this.onCheckpointError?.(error);
        // If this was still the newest queued snapshot, make it eligible for a
        // retry. A newer queued snapshot already contains this content.
        if (this.queuedRevision === revision) {
          this.queuedRevision = this.persistedRevision;
          if (!this.stopped) this.schedule();
        }
      }
    });
  }
}

/**
 * One transcript line for a tool result.
 *
 * The loop has always had the result content in hand and logged only whether
 * the call succeeded, which left the transcript unable to answer the one
 * question anybody asks of it: *what came back*. A Run that read an empty
 * inbox and a Run that read forty urgent messages produced the same line, and
 * the outcome checker — reading that transcript as its only evidence — was
 * then asked to decide whether the work was done.
 *
 * A preview, not the payload: tool results are the largest thing a Run
 * handles, and a full one would spend the whole transcript budget on a single
 * file read. Whitespace is collapsed so a hundred-line JSON blob stays one
 * line, which is also what keeps the head/tail accounting predictable.
 */
export function formatToolResultLine(
  name: string,
  result: { content?: string; isError?: boolean },
): string {
  const status = result.isError ? "error" : "ok";
  const collapsed = (result.content ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return `[tool:${name}] ${status}`;
  const preview =
    collapsed.length > TOOL_RESULT_PREVIEW_CHARS
      ? collapsed.slice(0, TOOL_RESULT_PREVIEW_CHARS - 1) + "…"
      : collapsed;
  return `[tool:${name}] ${status} — ${preview}`;
}
