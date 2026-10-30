import type { WorkspaceMessage } from "./workspace";
import { mergeWorkspaceMessages } from "./workspaceMessages";

/**
 * A channel's history as the Workspace and the Home peek scroll back through
 * it: `GET …/workspace/channels/:channelId/history`, newest page first and
 * each page oldest first, with the cursor that reads further back
 * (`pageChannelMessages` on the server).
 *
 * Scrolling up used to ask for the messages written before the oldest one on
 * screen — a timestamp. SQLite stamps a message to the second, so every other
 * message sharing that second was skipped, and a busy channel lost a few at
 * every page boundary. The cursor names the oldest message itself, by
 * (createdAt, id), so the next page starts exactly where the last one ended.
 */

/** The most messages one history page holds. */
export const WORKSPACE_HISTORY_MAX = 200;

/** One page of a channel's history, as the server answers it. */
export type ChannelHistoryPage = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  note?: string;
  /** Oldest first. */
  messages: WorkspaceMessage[];
};

/** The URL of one page: the newest messages, or those after `cursor` going back. */
export function channelHistoryUrl(
  companyId: string,
  channelId: string,
  page: { cursor?: string | null; limit: number },
): string {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(Math.trunc(page.limit), 1), WORKSPACE_HISTORY_MAX)));
  if (page.cursor) params.set("cursor", page.cursor);
  return `/api/companies/${companyId}/workspace/channels/${channelId}/history?${params.toString()}`;
}

/** Where older messages carry on after this page; null when it reached the start. */
export function olderCursorOf(page: ChannelHistoryPage): string | null {
  return page.hasMore ? page.nextCursor : null;
}

/**
 * A page folded into the messages already on screen. What is on screen wins a
 * collision: a socket frame may have brought a fresher copy (an edit, a
 * reaction) of a message the page also holds.
 */
export function foldHistoryPage(
  loaded: WorkspaceMessage[],
  page: ChannelHistoryPage,
): { messages: WorkspaceMessage[]; olderCursor: string | null } {
  return { messages: mergeWorkspaceMessages(page.messages, loaded), olderCursor: olderCursorOf(page) };
}
