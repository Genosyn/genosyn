/**
 * Durable transcript buffering for Routine Runs.
 *
 * The live log is still held in memory for fast polling, but snapshots are
 * also written to `Run.logContent` while the Run is active. A process crash
 * can therefore lose at most the current checkpoint window instead of the
 * entire transcript.
 */

export const RUN_LOG_MAX_BYTES = 256 * 1024;
export const RUN_LOG_CHECKPOINT_INTERVAL_MS = 1000;

type DurableRunLogOptions = {
  persist: (content: string) => Promise<void>;
  cap?: number;
  checkpointEveryMs?: number;
  onCheckpointError?: (error: unknown) => void;
};

export class DurableRunLog {
  private readonly parts: string[] = [];
  private size = 0;
  private truncated = false;
  private revision = 0;
  private queuedRevision = 0;
  private persistedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  private readonly persist: (content: string) => Promise<void>;
  private readonly cap: number;
  private readonly checkpointEveryMs: number;
  private readonly onCheckpointError?: (error: unknown) => void;

  constructor(options: DurableRunLogOptions) {
    this.persist = options.persist;
    this.cap = options.cap ?? RUN_LOG_MAX_BYTES;
    this.checkpointEveryMs = options.checkpointEveryMs ?? RUN_LOG_CHECKPOINT_INTERVAL_MS;
    this.onCheckpointError = options.onCheckpointError;
  }

  write(s: string): void {
    if (!s || this.truncated) return;
    const bytes = Buffer.byteLength(s, "utf8");
    if (this.size + bytes <= this.cap) {
      this.parts.push(s);
      this.size += bytes;
      this.changed();
      return;
    }

    const remaining = this.cap - this.size;
    if (remaining > 0) {
      const tail = s.slice(0, remaining);
      this.parts.push(tail);
      this.size += Buffer.byteLength(tail, "utf8");
    }
    this.parts.push(`\n[truncated — output exceeded ${this.cap} bytes]\n`);
    this.truncated = true;
    this.changed();
  }

  line(s: string): void {
    this.write(s + "\n");
  }

  value(): string {
    return this.parts.join("");
  }

  get isTruncated(): boolean {
    return this.truncated;
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
