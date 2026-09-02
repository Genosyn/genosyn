import type { WorkspaceMessage, WsInboundEvent } from "./workspace";

/**
 * How a loaded list of channel messages answers to a live socket frame.
 *
 * Two surfaces read the same channel — the Workspace page and the unread peek
 * on Home — and until this existed each carried its own hand-rolled reducer.
 * They had already drifted three ways: the peek stamped a tombstone that kept
 * the deleted body in memory, appended without re-sorting, and dropped every
 * reaction frame on the floor, so an emoji added while you were peeking never
 * appeared. `MessageList` renders reactions on a read-only surface on purpose;
 * it was simply never fed them.
 *
 * Kept out of the components, beside `unreadMessages.ts`, because it is pure
 * list arithmetic with no DOM in it — which is what makes it unit-testable and
 * what makes one copy of it worth having.
 *
 * Every function here returns the *same array reference* when the frame changed
 * nothing, so a caller can `if (next === list) return prev` and skip a render.
 */

/** Who is looking — decides whether a reaction reads as `byMe`. */
export type MessageViewer = { meId: string };

/**
 * Merge message groups into one list, newest last, de-duplicated by id.
 *
 * Later groups win on a collision, which is what lets a caller fold a socket
 * echo over the page it just fetched: the live copy is the fresher one.
 */
export function mergeWorkspaceMessages(...groups: WorkspaceMessage[][]): WorkspaceMessage[] {
  const byId = new Map<string, WorkspaceMessage>();
  for (const group of groups) {
    for (const message of group) byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const timeDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return timeDelta || a.id.localeCompare(b.id);
  });
}

/**
 * Apply one inbound frame to one channel's loaded messages.
 *
 * The caller is responsible for checking that the frame belongs to the channel
 * this list is for — the socket is company-wide — and for anything a frame
 * means *beyond* the list (unread badges, marking read, clearing a typing
 * pill). Frames this does not understand return the list untouched, so a
 * caller can hand it every frame it sees.
 */
export function applyWorkspaceMessageEvent(
  list: WorkspaceMessage[],
  event: WsInboundEvent,
  viewer: MessageViewer,
): WorkspaceMessage[] {
  switch (event.type) {
    case "message.new": {
      // Sorted insert rather than a bare append: a frame can overtake the page
      // fetch it belongs after, and a message that renders out of order is a
      // conversation that reads as nonsense.
      if (list.some((m) => m.id === event.message.id)) return list;
      return mergeWorkspaceMessages(list, [event.message]);
    }
    case "message.edit": {
      return replaceMessage(list, event.messageId, (m) => ({
        ...m,
        content: event.content,
        editedAt: event.editedAt,
      }));
    }
    case "message.delete": {
      // Drop the body and the attachments with the timestamp. `MessageList`
      // hides both behind its tombstone, so keeping them would be invisible
      // and wrong — a deleted message whose text is still in the tab.
      return replaceMessage(list, event.messageId, (m) => ({
        ...m,
        content: "",
        attachments: [],
        deletedAt: m.deletedAt ?? new Date().toISOString(),
      }));
    }
    case "reaction.add": {
      return replaceMessage(list, event.messageId, (m) =>
        withReaction(m, event.emoji, event.by, viewer),
      );
    }
    case "reaction.remove": {
      return replaceMessage(list, event.messageId, (m) =>
        withoutReaction(m, event.emoji, event.by, viewer),
      );
    }
    default:
      return list;
  }
}

/**
 * Map one message by id, returning `list` unchanged when the message is not
 * here — or when `update` decided it had nothing to change. A duplicate
 * reaction frame reaches the second case, and copying the array for it would
 * hand every caller a new identity for a frame that meant nothing.
 */
function replaceMessage(
  list: WorkspaceMessage[],
  messageId: string,
  update: (message: WorkspaceMessage) => WorkspaceMessage,
): WorkspaceMessage[] {
  const index = list.findIndex((m) => m.id === messageId);
  if (index === -1) return list;
  const updated = update(list[index]);
  if (updated === list[index]) return list;
  const next = list.slice();
  next[index] = updated;
  return next;
}

function withReaction(
  message: WorkspaceMessage,
  emoji: string,
  by: { kind: "user" | "ai"; id: string; name: string },
  viewer: MessageViewer,
): WorkspaceMessage {
  const reactions = [...message.reactions];
  const index = reactions.findIndex((r) => r.emoji === emoji);
  const isMe = by.kind === "user" && by.id === viewer.meId;
  if (index === -1) {
    reactions.push({ emoji, count: 1, byMe: isMe, actors: [by] });
  } else {
    const current = reactions[index];
    // The server re-broadcasts to the actor too, and a double frame must not
    // count the same person twice.
    if (current.actors.some((a) => a.kind === by.kind && a.id === by.id)) return message;
    reactions[index] = {
      ...current,
      count: current.count + 1,
      byMe: current.byMe || isMe,
      actors: [...current.actors, by],
    };
  }
  return { ...message, reactions };
}

function withoutReaction(
  message: WorkspaceMessage,
  emoji: string,
  by: { kind: "user" | "ai"; id: string },
  viewer: MessageViewer,
): WorkspaceMessage {
  const index = message.reactions.findIndex((r) => r.emoji === emoji);
  if (index === -1) return message;
  const reactions = [...message.reactions];
  const remaining = reactions[index].actors.filter((a) => !(a.kind === by.kind && a.id === by.id));
  if (remaining.length === reactions[index].actors.length) return message;
  if (remaining.length === 0) reactions.splice(index, 1);
  else {
    reactions[index] = {
      ...reactions[index],
      count: remaining.length,
      actors: remaining,
      byMe: remaining.some((a) => a.kind === "user" && a.id === viewer.meId),
    };
  }
  return { ...message, reactions };
}
