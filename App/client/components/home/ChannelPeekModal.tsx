import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Send } from "lucide-react";

import { MessageList, mergeWorkspaceMessages } from "@/components/workspace/MessageList";
import { useCompanySocketSubscription } from "@/components/CompanySocket";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import type { Company, HomeChannel, Me } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { firstUnreadMessageId } from "@/lib/unreadMessages";
import { Mentionable, WorkspaceMessage, workspaceApi } from "@/lib/workspace";

/**
 * Reading — and answering — an unread channel without leaving Home.
 *
 * Clicking an unread channel used to hand the whole page over to the
 * Workspace, which is a lot to ask of someone who wanted to know what the four
 * messages in #youtube said. This opens them where they are, draws the line
 * where their unread run starts, and puts a composer under it, so the common
 * case — read it, answer it, move on — never costs a navigation. The Workspace
 * is still one button away for everything else.
 *
 * Messages are read-only here on purpose. Editing, deleting and reacting are
 * things you do while living in a conversation; this is a peek at one, and the
 * hover toolbar on every row would be four affordances competing with the one
 * that matters.
 */

const PEEK_PAGE_SIZE = 30;

export function ChannelPeekModal({
  company,
  me,
  channel,
  onClose,
  onRead,
}: {
  company: Company;
  me: Me;
  channel: HomeChannel;
  onClose: () => void;
  /** Channel was marked read here; let Home drop the row and refresh. */
  onRead: (channelId: string) => void;
}) {
  const [messages, setMessages] = React.useState<WorkspaceMessage[] | null>(null);
  const [mentionables, setMentionables] = React.useState<Mentionable[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);

  // The socket is live from the moment this modal mounts, but `messages`
  // doubles as the loading flag and cannot hold anything until the first page
  // lands. Anything that arrives in that window waits here — without it, a
  // message posted while the modal was opening (your own reply included)
  // would be dropped and stay invisible until a reload.
  const pendingLive = React.useRef<WorkspaceMessage[]>([]);
  const loaded = React.useRef(false);

  // Frozen the moment the modal opens. Marking the channel read (which we do
  // on close) must not slide the "New" line up through the messages the
  // person is still reading.
  const [unreadFrom] = React.useState<string | null>(channel.lastReadAt);

  const channelHref = `/c/${company.slug}/workspace/${channel.id}`;

  React.useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    pendingLive.current = [];
    setMessages(null);
    setLoadError(null);
    (async () => {
      try {
        const [list, mentions] = await Promise.all([
          workspaceApi.listMessages(company.id, channel.id, { limit: PEEK_PAGE_SIZE }),
          // Without the directory every @mention in every message renders as
          // an unresolved grey pill, which reads as a typo the author made.
          workspaceApi.mentionables(company.id).catch(() => [] as Mentionable[]),
        ]);
        if (cancelled) return;
        setMentionables(mentions);
        loaded.current = true;
        // Fold in whatever the socket delivered while this was in flight.
        // `mergeWorkspaceMessages` is by id, so a message in both is one row.
        setMessages(mergeWorkspaceMessages(list, pendingLive.current));
        pendingLive.current = [];
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, channel.id]);

  // Land on the newest message, the way opening a channel does.
  React.useEffect(() => {
    if (messages === null) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // The conversation carries on while the modal is open — an employee
  // answering a mention should appear here, not on the next page load.
  useCompanySocketSubscription((event) => {
    if (!("channelId" in event) || event.channelId !== channel.id) return;

    /** Apply to the loaded list, or to the buffer while it is still loading. */
    function revise(update: (list: WorkspaceMessage[]) => WorkspaceMessage[]) {
      if (loaded.current) setMessages((prev) => (prev === null ? prev : update(prev)));
      else pendingLive.current = update(pendingLive.current);
    }

    if (event.type === "message.new") {
      const arrived = event.message;
      revise((list) => mergeWorkspaceMessages(list, [arrived]));
    }
    if (event.type === "message.delete") {
      const { messageId } = event;
      revise((list) =>
        list.map((m) => (m.id === messageId ? { ...m, deletedAt: new Date().toISOString() } : m)),
      );
    }
    if (event.type === "message.edit") {
      const { messageId, content, editedAt } = event;
      revise((list) => list.map((m) => (m.id === messageId ? { ...m, content, editedAt } : m)));
    }
  });

  /**
   * Closing is what marks the channel read. Opening would be too eager — the
   * modal can be dismissed by Escape a moment after a mis-click, and the badge
   * that told you to look is not something to spend on a mis-click.
   */
  async function closeAndMarkRead() {
    onClose();
    // Only when the messages actually arrived. Marking read is a claim that
    // you saw them, and a channel that failed to load is one you did not —
    // clearing the badge there would hide the thing that was trying to reach
    // you behind a network blip.
    if (!loaded.current) return;
    try {
      await workspaceApi.markRead(company.id, channel.id);
      onRead(channel.id);
    } catch {
      // The badge stays up and the next Home refetch reports the truth. There
      // is no surface left to put an error on — the modal has closed.
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await workspaceApi.sendMessage(company.id, channel.id, { content });
      setDraft("");
      // The socket echoes this back too; merging by id makes the double
      // delivery a no-op and keeps the reply visible if the socket is down.
      if (loaded.current) {
        setMessages((prev) => (prev === null ? [sent] : mergeWorkspaceMessages(prev, [sent])));
      } else {
        pendingLive.current = mergeWorkspaceMessages(pendingLive.current, [sent]);
      }
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const unreadFromMessageId = React.useMemo(
    () => (messages === null ? null : firstUnreadMessageId(messages, unreadFrom, { meId: me.id })),
    [messages, unreadFrom, me.id],
  );

  return (
    <Modal
      open
      onClose={closeAndMarkRead}
      title={channel.label}
      description={`${channel.unreadCount} unread ${channel.unreadCount === 1 ? "message" : "messages"}`}
      size="xl"
      footer={
        <>
          <Link
            to={channelHref}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            <ExternalLink size={14} /> Open in Workspace
          </Link>
          <Button size="sm" variant="secondary" onClick={closeAndMarkRead}>
            Mark read &amp; close
          </Button>
        </>
      }
    >
      <div className="flex h-[55vh] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {messages === null && loadError ? (
            <FormError message={loadError} />
          ) : messages === null ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-slate-400 dark:text-slate-500">
              Nothing here yet. Say something to start it off.
            </div>
          ) : (
            <MessageList
              messages={messages}
              meId={me.id}
              mentionables={mentionables}
              unreadFromMessageId={unreadFromMessageId}
              onAttachmentUrl={(id) => workspaceApi.attachmentUrl(company.id, id)}
            />
          )}
          <div ref={endRef} />
        </div>

        <div className="mt-3 shrink-0 border-t border-slate-200 pt-3 dark:border-slate-800">
          <FormError message={sendError} className="mb-2" />
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={`Reply in ${channel.label}… (@mention an AI employee to bring them in)`}
              className="min-h-[42px] w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <Button onClick={() => void send()} disabled={sending || draft.trim() === ""}>
              {sending ? <Spinner size={14} /> : <Send size={14} />} Send
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
