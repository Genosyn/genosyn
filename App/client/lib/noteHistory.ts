/**
 * Undo and redo for the Notes editor. The editor re-renders blocks itself, so
 * the browser's own undo can't see its changes; this keeps the steps instead.
 *
 * Each step stores the state *before* a change and the selection it had, so
 * undo puts the caret back where it was. A burst of typing in one block is
 * one step, as in Notion: keystrokes within `coalesceMs` of each other join
 * the step already open, and anything structural starts a new one.
 */

export type HistoryStep<T, S> = { state: T; selection: S };

export type ChangeKind = "typing" | "structure";

export class EditHistory<T, S> {
  private undoStack: Array<HistoryStep<T, S>> = [];
  private redoStack: Array<HistoryStep<T, S>> = [];
  private open: { key: string | undefined; at: number } | null = null;

  constructor(
    private readonly limit = 300,
    private readonly coalesceMs = 1000,
  ) {}

  /** Note the state as it was just before a change. */
  record(before: T, selection: S, kind: ChangeKind, key: string | undefined, now: number): void {
    this.redoStack = [];
    if (kind === "typing" && this.open && this.open.key === key && now - this.open.at < this.coalesceMs) {
      this.open.at = now;
      return;
    }
    this.undoStack.push({ state: before, selection });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.open = kind === "typing" ? { key, at: now } : null;
  }

  /** Close the open typing step, so the next keystroke starts a new one (caret moved, focus left). */
  seal(): void {
    this.open = null;
  }

  undo(current: T, selection: S): HistoryStep<T, S> | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ state: current, selection });
    this.open = null;
    return step;
  }

  redo(current: T, selection: S): HistoryStep<T, S> | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ state: current, selection });
    this.open = null;
    return step;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
  }
}
