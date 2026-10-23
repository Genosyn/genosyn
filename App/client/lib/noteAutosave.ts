/**
 * Autosave for a note: there is no Save button, only a quiet "Saving…" /
 * "Saved". Edits are saved shortly after typing pauses, and at least every
 * few seconds during a long burst; one save runs at a time; a failed save
 * retries with backoff; and leaving the page flushes what is pending.
 *
 * Saves carry the version they were edited from. When the server has moved
 * on (an AI Employee saved the page meanwhile) it answers with a conflict and
 * its version; the edits are merged onto it and saved again, so neither
 * side's work is dropped.
 *
 * Timers and the save itself are injected, which is what the tests drive.
 */

import { mergeSnapshots, type NoteSnapshot } from "./noteMerge.js";
import { sameSnapshot } from "./noteDrafts.js";

export type ServerVersion = { snapshot: NoteSnapshot; version: string };

export type SaveOutcome =
  | { kind: "saved"; server: ServerVersion }
  | { kind: "conflict"; server: ServerVersion }
  | { kind: "error"; error: unknown };

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export type AutosaveTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

export type AutosaverOptions = {
  save: (snapshot: NoteSnapshot, baseVersion: string, options: { keepalive: boolean }) => Promise<SaveOutcome>;
  /** The status changed; `error` is the last failure while status is "error". */
  onStatus?: (status: AutosaveStatus, error?: unknown) => void;
  /** The server now holds this version. */
  onSaved?: (server: ServerVersion) => void;
  /** Edits were merged onto a newer server version; show `snapshot` in the editor. */
  onMerged?: (snapshot: NoteSnapshot, conflicts: number) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  retryDelaysMs?: readonly number[];
  timers?: AutosaveTimers;
};

/** Titles save trimmed, and blank as "Untitled" — compare the way the server stores them. */
export function normalizeSnapshot(snapshot: NoteSnapshot): NoteSnapshot {
  return { title: snapshot.title.trim() || "Untitled", body: snapshot.body, icon: snapshot.icon };
}

const defaultTimers: AutosaveTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  // Elapsed time, not wall time: a clock change mid-burst can't stall a save.
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

export class Autosaver {
  private server: ServerVersion;
  private current: NoteSnapshot;
  private timer: unknown = null;
  private firstUnsavedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private retries = 0;
  private status: AutosaveStatus = "idle";
  private disposed = false;
  private readonly timers: AutosaveTimers;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(
    initial: ServerVersion,
    private readonly options: AutosaverOptions,
  ) {
    this.server = initial;
    this.current = initial.snapshot;
    this.timers = options.timers ?? defaultTimers;
    this.debounceMs = options.debounceMs ?? 700;
    this.maxWaitMs = options.maxWaitMs ?? 4000;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 3000, 8000, 15000, 30000];
  }

  get dirty(): boolean {
    return !sameSnapshot(normalizeSnapshot(this.current), normalizeSnapshot(this.server.snapshot));
  }

  get state(): AutosaveStatus {
    return this.status;
  }

  get serverVersion(): ServerVersion {
    return this.server;
  }

  get snapshot(): NoteSnapshot {
    return this.current;
  }

  get saving(): boolean {
    return this.inFlight !== null;
  }

  private setStatus(status: AutosaveStatus, error?: unknown) {
    if (this.disposed) return;
    this.status = status;
    this.options.onStatus?.(status, error);
  }

  private clearTimer() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.run(false);
    }, delay);
  }

  /** The editor changed. */
  update(snapshot: NoteSnapshot): void {
    if (this.disposed) return;
    this.current = snapshot;
    if (!this.dirty) {
      this.firstUnsavedAt = null;
      this.clearTimer();
      if (!this.inFlight && this.status !== "error") this.setStatus(this.status === "idle" ? "idle" : "saved");
      return;
    }
    const now = this.timers.now();
    if (this.firstUnsavedAt === null) this.firstUnsavedAt = now;
    if (this.status !== "saving") this.setStatus("pending");
    if (this.inFlight) return;
    const waited = now - this.firstUnsavedAt;
    this.schedule(Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - waited)));
  }

  /** Save now, if anything is unsaved. Resolves once nothing is in flight. */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    if (this.dirty) await this.run(Boolean(options.keepalive));
  }

  /** Retry a failed save straight away. */
  retry(): Promise<void> {
    this.retries = 0;
    return this.flush();
  }

  /**
   * The server copy changed under us (a live update). Returns what the editor
   * should now show: the server's version when nothing is unsaved, or our
   * edits merged onto it.
   */
  serverChanged(server: ServerVersion): { snapshot: NoteSnapshot; conflicts: number } | null {
    if (this.disposed || this.inFlight) return null;
    if (server.version === this.server.version) return null;
    const base = this.server.snapshot;
    this.server = server;
    if (sameSnapshot(this.current, base) || !this.dirtyAgainst(base)) {
      this.current = server.snapshot;
      return { snapshot: server.snapshot, conflicts: 0 };
    }
    const merged = mergeSnapshots(base, this.current, server.snapshot);
    this.current = merged.snapshot;
    if (this.dirty) this.schedule(0);
    return merged;
  }

  private dirtyAgainst(base: NoteSnapshot): boolean {
    return !sameSnapshot(normalizeSnapshot(this.current), normalizeSnapshot(base));
  }

  /**
   * The page is going away: stop scheduling and send what's unsaved without
   * waiting for an answer (after any save already in flight). The browser
   * copy in noteDrafts covers a send that never lands.
   */
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.disposed = true;
    const finish = () => {
      if (!this.dirty) return;
      void this.options
        .save(normalizeSnapshot(this.current), this.server.version, { keepalive: true })
        .catch(() => undefined);
    };
    if (this.inFlight) void this.inFlight.then(finish);
    else finish();
  }

  private run(keepalive: boolean): Promise<void> {
    if (this.disposed || this.inFlight || !this.dirty) return this.inFlight ?? Promise.resolve();
    const sent = normalizeSnapshot(this.current);
    const base = this.server;
    this.setStatus("saving");
    const done = this.options
      .save(sent, base.version, { keepalive })
      .catch((error: unknown): SaveOutcome => ({ kind: "error", error }))
      .then((outcome) => this.settle(outcome, base));
    this.inFlight = done.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private settle(outcome: SaveOutcome, base: ServerVersion) {
    if (outcome.kind === "saved") {
      this.retries = 0;
      this.server = outcome.server;
      if (this.disposed) return;
      this.options.onSaved?.(outcome.server);
      this.afterSave();
      return;
    }
    if (outcome.kind === "conflict") {
      this.retries = 0;
      const merged = mergeSnapshots(base.snapshot, this.current, outcome.server.snapshot);
      this.server = outcome.server;
      this.current = merged.snapshot;
      if (this.disposed) return;
      this.options.onMerged?.(merged.snapshot, merged.conflicts);
      this.afterSave();
      return;
    }
    if (this.disposed) return;
    this.retries++;
    this.setStatus("error", outcome.error);
    const delay = this.retryDelaysMs[Math.min(this.retries - 1, this.retryDelaysMs.length - 1)];
    this.schedule(delay);
  }

  private afterSave() {
    if (this.dirty) {
      this.firstUnsavedAt = this.timers.now();
      this.setStatus("pending");
      this.schedule(this.debounceMs);
    } else {
      this.firstUnsavedAt = null;
      this.setStatus("saved");
    }
  }
}
