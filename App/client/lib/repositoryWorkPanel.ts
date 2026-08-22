import type { RepositoryWorkTarget } from "./repositoryWorkLink";

/**
 * When the repository work panel is open in a chat thread, on what, and
 * whether it is collapsed.
 *
 * The rules are small but every one of them came from a way this could annoy
 * someone, so they live in a reducer with tests rather than in three effects
 * spread across the chat page:
 *
 *   - **Reopening a thread is not news.** Work sessions linked in history are
 *     recorded, not opened. Otherwise every visit to an old conversation would
 *     reopen a panel onto a diff that was reviewed weeks ago.
 *   - **A reply that arrives while you are reading it is news.** A session
 *     linked by a message that lands during the session opens the panel, which
 *     is what "show me repository work on the side" means for the case where
 *     the employee has only just started it.
 *   - **Closing it means closed.** A dismissed session is never reopened by a
 *     later poll or re-render; only a new session, or a click on its link,
 *     opens the panel again.
 *   - **Nothing is swapped out from under the reader.** New work arriving
 *     while an earlier session is open leaves the open one alone — its link is
 *     in the transcript when they want it.
 *   - **A click always shows the work.** Collapsed is part of this state
 *     rather than the panel's own, because chat cancels the link's navigation
 *     before the panel ever sees the click: a collapsed panel that stayed
 *     collapsed would turn that link into a dead one.
 */
export type RepositoryWorkPanelState = {
  /** The thread this state belongs to; switching threads resets it. */
  conversationId: string | null;
  /** What the panel is showing, or null when it is closed. */
  open: RepositoryWorkTarget | null;
  /** Whether the open panel is wound down to its rail. */
  collapsed: boolean;
  /** Sessions this thread has already put in front of the reader. */
  offered: string[];
};

export const initialRepositoryWorkPanelState: RepositoryWorkPanelState = {
  conversationId: null,
  open: null,
  collapsed: false,
  offered: [],
};

export type RepositoryWorkPanelEvent =
  /** The chat switched threads (or to no thread at all). */
  | { type: "thread"; conversationId: string | null }
  /**
   * The work sessions currently linked in the visible transcript, oldest
   * first. `live` is false for the transcript as it first loads and true once
   * messages are arriving into a thread the reader is already sitting in.
   */
  | { type: "transcript"; targets: RepositoryWorkTarget[]; live: boolean }
  /** Someone clicked a work-session link. */
  | { type: "open"; target: RepositoryWorkTarget }
  /** Someone wound the panel down to its rail, or back out of it. */
  | { type: "collapse"; collapsed: boolean }
  /** Someone closed the panel. */
  | { type: "close" };

export function sameWorkTarget(
  a: RepositoryWorkTarget | null,
  b: RepositoryWorkTarget | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.repositorySlug === b.repositorySlug && a.sessionId === b.sessionId;
}

export function repositoryWorkPanelReducer(
  state: RepositoryWorkPanelState,
  event: RepositoryWorkPanelEvent,
): RepositoryWorkPanelState {
  switch (event.type) {
    case "thread": {
      if (event.conversationId === state.conversationId) return state;
      return { conversationId: event.conversationId, open: null, collapsed: false, offered: [] };
    }
    case "transcript": {
      const fresh = event.targets.filter((target) => !state.offered.includes(target.sessionId));
      if (fresh.length === 0) return state;
      const offered = [...state.offered, ...fresh.map((target) => target.sessionId)];
      // Only a new session in a live thread opens the panel, and only when
      // nothing else is already open in it.
      const shouldOpen = event.live && !state.open;
      return {
        ...state,
        offered,
        open: shouldOpen ? fresh[fresh.length - 1] : state.open,
        collapsed: shouldOpen ? false : state.collapsed,
      };
    }
    case "open": {
      // Deliberately not a no-op when the same session is already open and
      // collapsed: chat has already cancelled the link's navigation by the
      // time this runs, so returning the state unchanged is a click that does
      // nothing at all.
      if (sameWorkTarget(state.open, event.target) && !state.collapsed) return state;
      return {
        ...state,
        open: event.target,
        collapsed: false,
        offered: state.offered.includes(event.target.sessionId)
          ? state.offered
          : [...state.offered, event.target.sessionId],
      };
    }
    case "collapse": {
      if (state.collapsed === event.collapsed) return state;
      return { ...state, collapsed: event.collapsed };
    }
    case "close": {
      if (!state.open) return state;
      // Reset the rail as well, so the next session does not open wound down.
      return { ...state, open: null, collapsed: false };
    }
    default:
      return state;
  }
}
