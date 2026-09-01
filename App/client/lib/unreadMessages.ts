import type { WorkspaceMessage } from "./workspace";

/**
 * Where a channel's unread run starts.
 *
 * The server counts unread as "messages after my `lastReadAt` that I did not
 * write myself" (`hydrateChannel` in `services/workspaceChat.ts`), and the
 * badge on Home is that count. A surface that shows the messages has to draw
 * its "new" line by the *same* rule, or the line and the number disagree —
 * which is worse than having no line at all.
 *
 * Kept here, away from the components, because it is the part that has to
 * match the server exactly.
 */

/** Who is looking. `null` for a viewer we have no id for — then nothing is "mine". */
export type UnreadViewer = { meId: string | null };

/**
 * True when `message` counts toward the viewer's unread badge.
 *
 * Own messages never do: writing in a channel is not something you then have
 * to catch up on. Deleted messages still count — the server counts rows, and a
 * line drawn past a tombstone would sit in a different place than the badge.
 */
export function countsAsUnread(
  message: WorkspaceMessage,
  lastReadAt: string | null,
  viewer: UnreadViewer,
): boolean {
  const author = message.author;
  if (author && author.kind === "user" && viewer.meId && author.id === viewer.meId) return false;
  if (!lastReadAt) return true;
  const read = Date.parse(lastReadAt);
  const sent = Date.parse(message.createdAt);
  // An unparseable timestamp on either side means we cannot say it is new.
  // Treating it as read keeps a broken date from planting the line at the top.
  if (Number.isNaN(read) || Number.isNaN(sent)) return false;
  return sent > read;
}

/**
 * The id of the first message in the unread run, or null when the loaded page
 * has none — either everything is read, or the unread messages are older than
 * the page we fetched.
 *
 * `messages` must be oldest-first, the order the list endpoint returns.
 */
export function firstUnreadMessageId(
  messages: readonly WorkspaceMessage[],
  lastReadAt: string | null,
  viewer: UnreadViewer,
): string | null {
  for (const message of messages) {
    if (countsAsUnread(message, lastReadAt, viewer)) return message.id;
  }
  return null;
}

/** How many of the loaded messages are unread. Used to caption the line. */
export function unreadCountIn(
  messages: readonly WorkspaceMessage[],
  lastReadAt: string | null,
  viewer: UnreadViewer,
): number {
  let n = 0;
  for (const message of messages) {
    if (countsAsUnread(message, lastReadAt, viewer)) n += 1;
  }
  return n;
}
