/**
 * A copy of unsaved note edits kept in the browser, so a closed tab, a
 * reload, a crash or a dropped connection never loses what was typed. The
 * draft is written on every change and removed once the server has the same
 * content; on the next open it is restored — merged with anything saved since
 * by someone else — and saved.
 */

import { mergeSnapshots, type NoteSnapshot } from "./noteMerge.js";

export type NoteDraft = {
  v: 1;
  noteId: string;
  snapshot: NoteSnapshot;
  /** The server version the edits started from. */
  base: NoteSnapshot;
  baseVersion: string;
  savedAt: number;
};

/** Drafts older than this are stale: the person has moved on. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function draftKey(companyId: string, noteId: string): string {
  return `genosyn.notes.draft.${companyId}.${noteId}`;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isSnapshot(value: unknown): value is NoteSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && typeof v.body === "string" && typeof v.icon === "string";
}

export function readDraft(storage: DraftStorage | null, key: string): NoteDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NoteDraft>;
    if (
      parsed.v !== 1 ||
      typeof parsed.noteId !== "string" ||
      !isSnapshot(parsed.snapshot) ||
      !isSnapshot(parsed.base) ||
      typeof parsed.baseVersion !== "string" ||
      typeof parsed.savedAt !== "number"
    ) {
      return null;
    }
    return parsed as NoteDraft;
  } catch {
    return null;
  }
}

export function writeDraft(storage: DraftStorage | null, key: string, draft: NoteDraft): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage blocked or unavailable: nothing to clear.
  }
}

/** The browser's localStorage, or null where it is blocked. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function sameSnapshot(a: NoteSnapshot, b: NoteSnapshot): boolean {
  return a.title === b.title && a.body === b.body && a.icon === b.icon;
}

export type DraftRecovery =
  | { kind: "none" }
  | { kind: "discard" }
  | { kind: "restore"; snapshot: NoteSnapshot; conflicts: number };

/**
 * What to do with a draft found when a note opens. Restore it when it holds
 * edits the server lacks — as written if nobody saved in between, merged
 * with their changes if someone did.
 */
export function planDraftRecovery(
  draft: NoteDraft | null,
  server: NoteSnapshot & { version: string },
  now: number,
): DraftRecovery {
  if (!draft) return { kind: "none" };
  if (now - draft.savedAt > DRAFT_MAX_AGE_MS) return { kind: "discard" };
  const current: NoteSnapshot = { title: server.title, body: server.body, icon: server.icon };
  if (sameSnapshot(draft.snapshot, current)) return { kind: "discard" };
  if (sameSnapshot(draft.snapshot, draft.base)) return { kind: "discard" };
  if (draft.baseVersion === server.version || sameSnapshot(draft.base, current)) {
    return { kind: "restore", snapshot: draft.snapshot, conflicts: 0 };
  }
  const merged = mergeSnapshots(draft.base, draft.snapshot, current);
  return { kind: "restore", snapshot: merged.snapshot, conflicts: merged.conflicts };
}
