/**
 * Where the keyboard cursor was when a thread was opened from a mail list, so
 * the list can put it back when the Member returns — with Back, or after
 * archiving, trashing or marking the thread unread, which now return to the
 * list on their own. Without it every return started at the top row, and a
 * keyboard triage of a long inbox meant pressing `j` back down to where it was.
 *
 * Module state rather than React state: the list unmounts while the thread is
 * open, and only one list is ever on screen.
 */

export type ReturnCursor = {
  /** Which list: mailbox, folder, label and search together. */
  key: string;
  threadId: string;
  index: number;
};

let remembered: ReturnCursor | null = null;

/** The identity of one list, as the cursor memory compares it. */
export function mailListKey(parts: {
  accountId: string;
  view: string;
  label: string;
  q: string;
}): string {
  return JSON.stringify([parts.accountId, parts.view, parts.label, parts.q]);
}

export function rememberReturnCursor(next: ReturnCursor): void {
  remembered = next;
}

/**
 * The cursor remembered for list `key`, handed out once: a later reload of
 * the same list starts where the person is, not where they were.
 */
export function takeReturnCursor(key: string): ReturnCursor | null {
  const found = remembered?.key === key ? remembered : null;
  remembered = null;
  return found;
}

/** The row to put the cursor on: the same thread, else the one now in its place. */
export function returnCursorIndex(back: ReturnCursor, rows: ReadonlyArray<{ id: string }>): number {
  const same = rows.findIndex((row) => row.id === back.threadId);
  if (same >= 0) return same;
  return Math.max(0, Math.min(back.index, rows.length - 1));
}
