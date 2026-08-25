import type { RepositoryWorkTarget } from "./repositoryWorkLink";
import type { RepositoryWorkPanelMemory } from "./repositoryWorkPanel";

/**
 * What the panels docked beside a chat thread were left showing, remembered
 * across a reload.
 *
 * Neither panel is a dialog. One is a diff somebody is halfway through
 * reviewing and the other is a browser they are watching work, and reloading
 * the page — or coming back to the tab tomorrow — is not a request to close
 * either of them. Everything stored here is a decision a Member made with a
 * click: which work session is open, whether it is wound down to its rail,
 * which browser sessions they have already sent away. Only another click
 * takes it back.
 *
 * One localStorage key holds every thread's memory as a most-recent-first
 * list rather than a key per conversation: a Member who chats daily would
 * otherwise accumulate thousands of entries they can neither see nor clear,
 * and where a panel was left is not worth that. Entries that fall off the end
 * of the list cost only the memory itself — the panel opens fresh next time.
 */

/** How the live browser panel was left in one thread. */
export type BrowserLivePanelMemory = {
  /**
   * Browser sessions the reader has already sent away. Recorded per session
   * rather than as one "hidden" flag for the thread: dismissing the browser
   * you are watching now should not blind you to the one the employee opens
   * an hour later, the same way closing one work session does not suppress
   * the next.
   */
  dismissed: string[];
  /** Whether the panel is wound down to its rail. */
  collapsed: boolean;
};

/** Everything remembered about one thread's companion panels. */
export type ChatPanelMemory = {
  work?: RepositoryWorkPanelMemory;
  browser?: BrowserLivePanelMemory;
};

type StoredEntry = { id: string } & ChatPanelMemory;

export const CHAT_PANEL_MEMORY_KEY = "genosyn.chatPanels.v1";

/** Threads remembered at once. Older ones fall off the end. */
export const CHAT_PANEL_MEMORY_LIMIT = 50;

/**
 * Session ids kept per thread. `offered` and `dismissed` grow once per work
 * or browser session, so a long-running thread would otherwise write an
 * ever-growing list on every click. Only recent ids can be re-offered by an
 * arriving message anyway.
 */
export const CHAT_PANEL_MEMORY_ID_LIMIT = 50;

/** Only the two methods this module uses, so a test can pass a fake. */
export type ChatPanelMemoryStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The store to remember panels in, or null where there isn't one. Reading
 * `window.localStorage` is itself what throws in a sandboxed frame, so the
 * access is guarded rather than only the calls made through it.
 */
export function chatPanelMemoryStorage(): ChatPanelMemoryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.slice(-CHAT_PANEL_MEMORY_ID_LIMIT);
}

function parseTarget(value: unknown): RepositoryWorkTarget | null {
  if (!isRecord(value)) return null;
  const { repositorySlug, sessionId } = value;
  if (typeof repositorySlug !== "string" || !repositorySlug) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  return { repositorySlug, sessionId };
}

function parseWork(value: unknown): RepositoryWorkPanelMemory | null {
  if (!isRecord(value)) return null;
  return {
    open: parseTarget(value.open),
    collapsed: value.collapsed === true,
    offered: parseIds(value.offered),
  };
}

function parseBrowser(value: unknown): BrowserLivePanelMemory | null {
  if (!isRecord(value)) return null;
  return { dismissed: parseIds(value.dismissed), collapsed: value.collapsed === true };
}

/**
 * Every stored entry, most recent first.
 *
 * Anything unreadable is treated as nothing at all rather than repaired: this
 * is a convenience, and a half-parsed entry that reopens the wrong session is
 * worse than opening none.
 */
function readEntries(storage: ChatPanelMemoryStorage | null): StoredEntry[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(CHAT_PANEL_MEMORY_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: StoredEntry[] = [];
  for (const row of parsed) {
    if (!isRecord(row)) continue;
    const id = row.id;
    if (typeof id !== "string" || !id) continue;
    const work = parseWork(row.work);
    const browser = parseBrowser(row.browser);
    if (!work && !browser) continue;
    const entry: StoredEntry = { id };
    if (work) entry.work = work;
    if (browser) entry.browser = browser;
    entries.push(entry);
    if (entries.length >= CHAT_PANEL_MEMORY_LIMIT) break;
  }
  return entries;
}

/** How this thread's panels were left. Empty for a thread we've never stored. */
export function readChatPanelMemory(
  storage: ChatPanelMemoryStorage | null,
  conversationId: string | null | undefined,
): ChatPanelMemory {
  if (!conversationId) return {};
  const entry = readEntries(storage).find((row) => row.id === conversationId);
  if (!entry) return {};
  return { work: entry.work, browser: entry.browser };
}

/**
 * Record how one panel was left, leaving the other panel's memory for this
 * thread alone — the two write independently, and a browser dismissal must
 * not erase which work session is open.
 */
export function writeChatPanelMemory(
  storage: ChatPanelMemoryStorage | null,
  conversationId: string | null | undefined,
  patch: ChatPanelMemory,
): void {
  if (!storage || !conversationId) return;
  const entries = readEntries(storage);
  const previous = entries.find((row) => row.id === conversationId);
  const work = patch.work ?? previous?.work;
  const browser = patch.browser ?? previous?.browser;
  if (!work && !browser) return;

  const merged: StoredEntry = { id: conversationId };
  if (work) {
    merged.work = {
      open: work.open,
      collapsed: work.collapsed,
      offered: work.offered.slice(-CHAT_PANEL_MEMORY_ID_LIMIT),
    };
  }
  if (browser) {
    merged.browser = {
      dismissed: browser.dismissed.slice(-CHAT_PANEL_MEMORY_ID_LIMIT),
      collapsed: browser.collapsed,
    };
  }

  // Front of the list, so the threads that fall off the end are the ones
  // nobody has touched in a long time.
  const next = [merged, ...entries.filter((row) => row.id !== conversationId)].slice(
    0,
    CHAT_PANEL_MEMORY_LIMIT,
  );
  try {
    storage.setItem(CHAT_PANEL_MEMORY_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or disabled. Where a panel was left is not worth an
    // exception on the way to rendering it.
  }
}
