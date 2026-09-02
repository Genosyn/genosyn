import React from "react";
import { Link } from "react-router-dom";
import { ArrowDown, Bot, ExternalLink, Hash, Lock, User as UserIcon } from "lucide-react";

import { useCompanySocket, useCompanySocketSubscription } from "@/components/CompanySocket";
import { MessageList } from "@/components/workspace/MessageList";
import { ChannelComposer, type ChannelComposerHandle } from "@/components/workspace/Composer";
import { TypingPill, useChannelTyping } from "@/components/workspace/TypingPill";
import { Button, buttonClassName } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import type { Company, HomeChannel, Me } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { firstUnreadMessageId, unreadCountIn } from "@/lib/unreadMessages";
import {
  Mentionable,
  WorkspaceChannel,
  WorkspaceMessage,
  WsInboundEvent,
  workspaceApi,
  workspaceChannelHref,
} from "@/lib/workspace";
import { applyWorkspaceMessageEvent, mergeWorkspaceMessages } from "@/lib/workspaceMessages";

/**
 * Reading — and answering — an unread channel without leaving Home.
 *
 * Clicking an unread channel used to hand the whole page over to the
 * Workspace, which is a lot to ask of someone who wanted to know what the four
 * messages in #youtube said. This opens them where they are, lands them on the
 * line where their unread run starts, and puts the real composer under it, so
 * the common case — read it, answer it, move on — never costs a navigation.
 * The Workspace is still one button away for everything else.
 *
 * The composer is `ChannelComposer`, the same one the Workspace page uses, for
 * the reason `MessageList`'s own comment gives: the peek's placeholder had been
 * telling people to "@mention an AI employee" above a plain textarea that had
 * never heard of an @. Two composers for one channel is two answers to every
 * question about how a message gets written.
 *
 * Messages are read-only here on purpose. Editing, deleting and reacting are
 * things you do while living in a conversation; this is a peek at one, and the
 * hover toolbar on every row would be four affordances competing with the one
 * that matters. Reactions other people left still render — who reacted is part
 * of reading the message.
 */

/** Floor for the first page. A short unread run still wants context above it. */
const PEEK_PAGE_SIZE = 30;
/** The server's own ceiling on `limit` (`routes/workspace.ts`). */
const MAX_PAGE_SIZE = 200;
/** How close to the bottom still counts as "following the conversation". */
const PINNED_SLACK_PX = 120;

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
  /** The full channel row, for the topic and member count the Home payload omits. */
  const [detail, setDetail] = React.useState<WorkspaceChannel | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  const [hasOlder, setHasOlder] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [archived, setArchived] = React.useState(false);
  /** Something arrived below the fold while the reader was up in the history. */
  const [newBelow, setNewBelow] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const composerRef = React.useRef<ChannelComposerHandle>(null);
  const dialog = useDialog();
  const typers = useChannelTyping(channel.id, me.id);

  // The socket is live from the moment this modal mounts, but `messages`
  // doubles as the loading flag and cannot hold anything until the first page
  // lands. Frames that arrive in that window queue here as *events*, not as
  // messages: an edit or a delete for a row still in flight has nothing to
  // apply itself to yet, and materialising the buffer early would consume the
  // frame and lose it.
  const pendingEvents = React.useRef<WsInboundEvent[]>([]);
  const loaded = React.useRef(false);
  /** Whether the first paint has already put the reader where they belong. */
  const landed = React.useRef(false);
  /** Whether the reader is sitting at the bottom, following along. */
  const pinned = React.useRef(true);
  /** Set before a prepend so the layout effect can hold the reader's place. */
  const prependAnchor = React.useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const lastMessageId = React.useRef<string | null>(null);

  // Frozen the moment the modal opens. Marking the channel read (which we do
  // on close) must not slide the "New" line up through the messages the
  // person is still reading.
  const [unreadFrom] = React.useState<string | null>(channel.lastReadAt);

  const channelHref = workspaceChannelHref(company.slug, channel.id);

  /**
   * Ask for enough history to cover the run the badge is counting.
   *
   * One flat page of 30 was the old behaviour, and on a channel with 47 unread
   * it drew the "New" line on the topmost row it happened to fetch — claiming
   * the unread run starts where the request stopped. A line in the wrong place
   * is worse than no line.
   */
  const firstPageSize = Math.min(MAX_PAGE_SIZE, Math.max(PEEK_PAGE_SIZE, channel.unreadCount + 10));

  React.useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    landed.current = false;
    pinned.current = true;
    lastMessageId.current = null;
    pendingEvents.current = [];
    setMessages(null);
    setLoadError(null);
    setNewBelow(false);
    (async () => {
      try {
        const [list, mentions, row] = await Promise.all([
          workspaceApi.listMessages(company.id, channel.id, { limit: firstPageSize }),
          // Without the directory every @mention in every message renders as
          // an unresolved grey pill, which reads as a typo the author made —
          // and the composer's own @ autocomplete has nothing to offer.
          workspaceApi.mentionables(company.id).catch(() => [] as Mentionable[]),
          // Topic and members. Optional: the peek is still worth showing to
          // someone whose channel row we could not re-read.
          workspaceApi.getChannel(company.id, channel.id).catch(() => null),
        ]);
        if (cancelled) return;
        setMentionables(mentions);
        setDetail(row);
        if (row?.archivedAt) setArchived(true);
        loaded.current = true;
        setHasOlder(list.length >= firstPageSize);
        // Replay whatever the socket delivered while this was in flight, in
        // arrival order, over the page that just landed.
        setMessages(
          pendingEvents.current.reduce(
            (acc, event) => applyWorkspaceMessageEvent(acc, event, { meId: me.id }),
            list,
          ),
        );
        pendingEvents.current = [];
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Couldn’t load this channel"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, channel.id, firstPageSize, me.id, reloadToken]);

  /**
   * Land on the unread line, not on the newest message.
   *
   * If twenty-five of the loaded rows are new, the bottom of the run is the
   * one place you have definitely not been. Slack lands on the divider; so
   * does this. Only on the first paint — after that the reader owns the
   * scroll position.
   */
  React.useLayoutEffect(() => {
    if (messages === null || landed.current) return;
    landed.current = true;
    lastMessageId.current = messages.at(-1)?.id ?? null;
    const divider = scrollRef.current?.querySelector<HTMLElement>("[data-unread-divider]");
    if (divider) {
      divider.scrollIntoView({ block: "start" });
      pinned.current = false;
    } else {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  /**
   * Follow the conversation only while the reader is actually at the bottom.
   *
   * The old effect scrolled on every change of the list, so a teammate editing
   * a three-day-old message threw you out of the history you were reading.
   */
  React.useLayoutEffect(() => {
    if (messages === null || !landed.current) return;

    const anchor = prependAnchor.current;
    if (anchor) {
      // Older messages just went in above; hold the reader's place rather than
      // letting the browser's scroll anchoring guess.
      const viewport = scrollRef.current;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      }
      prependAnchor.current = null;
      return;
    }

    const newestId = messages.at(-1)?.id ?? null;
    if (newestId === lastMessageId.current) return;
    const newest = messages.at(-1);
    lastMessageId.current = newestId;
    const isMine =
      newest?.author?.kind === "user" && "id" in newest.author && newest.author.id === me.id;
    if (pinned.current || isMine) endRef.current?.scrollIntoView({ block: "end" });
    else setNewBelow(true);
  }, [messages, me.id]);

  // The conversation carries on while the modal is open — an employee
  // answering a mention should appear here, not on the next page load.
  useCompanySocketSubscription((event) => {
    if (!("channelId" in event) || event.channelId !== channel.id) return;

    if (event.type === "channel.archive") {
      setArchived(true);
      return;
    }
    if (event.type === "channel.update") {
      setDetail(event.channel);
      return;
    }
    if (!isChannelMessageEvent(event)) return;

    if (loaded.current) {
      setMessages((prev) =>
        prev === null ? prev : applyWorkspaceMessageEvent(prev, event, { meId: me.id }),
      );
    } else {
      pendingEvents.current.push(event);
    }
  });

  // After the socket reconnects (the laptop woke up), re-sync once: the hub
  // replays nothing, and closing this modal marks the channel read — so a
  // message missed during the drop would be buried by the very act of
  // dismissing the badge that was pointing at it.
  const { status: wsStatus } = useCompanySocket();
  const previousWsStatus = React.useRef(wsStatus);
  React.useEffect(() => {
    const wasClosed = previousWsStatus.current === "closed";
    previousWsStatus.current = wsStatus;
    if (!wasClosed || wsStatus !== "open" || !loaded.current) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await workspaceApi.listMessages(company.id, channel.id, {
          limit: firstPageSize,
        });
        if (cancelled) return;
        setMessages((prev) => mergeWorkspaceMessages(prev ?? [], list));
      } catch {
        // Nothing to say here — the transcript on screen is still the one we
        // had, and closing still reports the truth to Home.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsStatus, company.id, channel.id, firstPageSize]);

  async function loadOlder() {
    const oldest = messages?.[0];
    if (!oldest || loadingOlder) return;
    const viewport = scrollRef.current;
    setLoadingOlder(true);
    try {
      const older = await workspaceApi.listMessages(company.id, channel.id, {
        before: oldest.createdAt,
        limit: PEEK_PAGE_SIZE,
      });
      if (viewport) {
        prependAnchor.current = {
          scrollHeight: viewport.scrollHeight,
          scrollTop: viewport.scrollTop,
        };
      }
      setHasOlder(older.length >= PEEK_PAGE_SIZE);
      setMessages((prev) => mergeWorkspaceMessages(older, prev ?? []));
    } catch (err) {
      prependAnchor.current = null;
      setLoadError(errorMessage(err, "Couldn’t load earlier messages"));
    } finally {
      setLoadingOlder(false);
    }
  }

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

  /**
   * The one dismissal path: the X, Escape, the scrim and both footer buttons.
   *
   * A half-written reply is work, and every one of those exits would throw it
   * away without asking. Peeling an open autocomplete is a separate job that
   * belongs to Escape alone — see `onEscape` below.
   */
  function requestClose(markRead: boolean) {
    const finish = () => {
      if (markRead) void closeAndMarkRead();
      else onClose();
    };
    if (!composerRef.current?.hasDraft()) return finish();
    void (async () => {
      const discard = await dialog.confirm({
        title: "Discard your reply?",
        message: `Your unsent message in ${channel.label} will be lost.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep writing",
        variant: "danger",
      });
      if (discard) finish();
    })();
  }

  const unreadFromMessageId = React.useMemo(
    () => (messages === null ? null : firstUnreadMessageId(messages, unreadFrom, { meId: me.id })),
    [messages, unreadFrom, me.id],
  );
  // The badge you clicked, plus anything that has landed since.
  const unreadCount =
    messages === null
      ? channel.unreadCount
      : Math.max(channel.unreadCount, unreadCountIn(messages, unreadFrom, { meId: me.id }));

  return (
    <Modal
      open
      onClose={() => requestClose(true)}
      // Escape with the @ menu up should close the menu, not the modal and the
      // unread badge with it. `ModalChrome` listens on `window` in the capture
      // phase, so the composer's own Escape branch can never win that race;
      // this is how the modal hands the inner surface its turn.
      onEscape={() => composerRef.current?.dismissPopup() ?? false}
      title={channel.label}
      description={<ChannelMeta channel={channel} detail={detail} unreadCount={unreadCount} />}
      size="lg"
      padded={false}
      footer={
        <>
          <Link
            to={channelHref}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
            onClick={onClose}
          >
            <ExternalLink size={14} /> Open in Workspace
          </Link>
          {/* The only genuinely new verb on this surface. Every other exit —
              the X, Escape, the scrim — spends the badge that brought you
              here; this is how you say "not now" and keep it. */}
          <Button size="sm" variant="secondary" onClick={() => requestClose(false)}>
            Keep unread
          </Button>
          {/* Marking read is a claim that you saw the messages, and until they
              arrive there is nothing to have seen — `closeAndMarkRead` refuses
              in that window, so the button must not pretend otherwise. The X,
              Escape and Keep unread all still close. */}
          <Button size="sm" disabled={messages === null} onClick={() => requestClose(true)}>
            Mark read &amp; close
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        <div className="relative">
          <div
            ref={scrollRef}
            role="log"
            tabIndex={0}
            aria-label={`Messages in ${channel.label}`}
            className="max-h-[40vh] overflow-y-auto overscroll-contain px-2 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40 sm:max-h-[min(32rem,60vh)] sm:px-3"
            onScroll={(event) => {
              const el = event.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK_PX;
              if (pinned.current) setNewBelow(false);
            }}
          >
            {messages === null && loadError ? (
              <div className="space-y-3 px-2 py-6">
                <FormError message={loadError} />
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setReloadToken((n) => n + 1)}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            ) : messages === null ? (
              <div
                className="flex h-[12rem] items-center justify-center gap-2 text-sm text-slate-500 sm:h-[20rem] dark:text-slate-400"
                role="status"
                aria-live="polite"
              >
                <Spinner size={18} /> Loading messages…
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-[12rem] flex-col items-center justify-center gap-1 px-4 text-center text-sm text-slate-500 sm:h-[20rem] dark:text-slate-400">
                <span>Nothing to catch up on here.</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  Say something to start it off.
                </span>
              </div>
            ) : (
              // `justify-end` against a definite `min-h` is what seats a short
              // conversation on the composer instead of stranding it at the
              // top of a fixed box with 500px of white underneath. It sits on
              // the *content* wrapper, never on the scroll container, where it
              // would push the oldest rows out of reach.
              <div className="flex min-h-[12rem] flex-col justify-end sm:min-h-[20rem]">
                {hasOlder && (
                  <div className="flex justify-center pb-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={loadingOlder}
                      onClick={() => void loadOlder()}
                    >
                      {loadingOlder ? <Spinner size={12} /> : null}
                      {loadingOlder ? "Loading…" : "Load earlier messages"}
                    </Button>
                  </div>
                )}
                <FormError message={loadError} className="mb-2" />
                <MessageList
                  messages={messages}
                  meId={me.id}
                  mentionables={mentionables}
                  unreadFromMessageId={unreadFromMessageId}
                  onAttachmentUrl={(id) => workspaceApi.attachmentUrl(company.id, id)}
                />
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Something landed below the fold while you were reading history.
              Silently yanking the viewport is the alternative, and it is the
              reason chat apps all grew this button. */}
          {newBelow && (
            <button
              type="button"
              onClick={() => {
                pinned.current = true;
                setNewBelow(false);
                endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
              }}
              className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-md hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              <ArrowDown size={12} /> New messages
            </button>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-200/70 px-4 py-3 sm:px-5 dark:border-slate-800">
          {typers.length > 0 && (
            <div className="mb-1.5">
              <TypingPill typers={typers} />
            </div>
          )}
          {archived ? (
            <p className="py-1 text-sm text-slate-500 dark:text-slate-400">
              This channel has been archived. You can still read it in the Workspace.
            </p>
          ) : messages === null ? (
            // A composer over a channel that has not loaded is a trap: the
            // message posts, and the reply it provokes lands in a transcript
            // nobody is holding. Say so instead of accepting the message.
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-500">
              {loadError ? "Reload the conversation to reply." : "Loading the conversation…"}
            </div>
          ) : (
            <ChannelComposer
              ref={composerRef}
              company={company}
              channel={{ id: channel.id, kind: channel.kind, label: channel.label }}
              mentionables={mentionables}
              onSent={(sent) =>
                setMessages((prev) =>
                  prev === null ? [sent] : mergeWorkspaceMessages(prev, [sent]),
                )
              }
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The line under the title. Everything the row on Home could not carry: what
 * kind of room this is, how many people are in it, and what it is for.
 *
 * Inline elements only — `Modal` renders `description` inside a `<p>`.
 */
function ChannelMeta({
  channel,
  detail,
  unreadCount,
}: {
  channel: HomeChannel;
  detail: WorkspaceChannel | null;
  unreadCount: number;
}) {
  const withAi = detail?.members.some((m) => m.kind === "ai") ?? false;
  const Icon =
    channel.kind === "dm" ? (withAi ? Bot : UserIcon) : channel.kind === "private" ? Lock : Hash;
  const kindLabel =
    channel.kind === "dm"
      ? withAi
        ? "Direct message with an AI Employee"
        : "Direct message"
      : channel.kind === "private"
        ? "Private channel"
        : "Channel";
  const memberCount = detail?.members.length ?? 0;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        {unreadCount > 99 ? "99+" : unreadCount} new
      </span>
      <span className="inline-flex items-center gap-1">
        <Icon size={12} aria-hidden="true" className="shrink-0" />
        {kindLabel}
      </span>
      {memberCount > 0 && (
        <span>
          · {memberCount} member{memberCount === 1 ? "" : "s"}
        </span>
      )}
      {detail?.topic ? (
        <span className="min-w-0 max-w-full truncate border-l border-slate-200 pl-2 dark:border-slate-700">
          {detail.topic}
        </span>
      ) : null}
    </span>
  );
}

/** The frames that change what is in the transcript, as opposed to the room. */
function isChannelMessageEvent(event: WsInboundEvent): boolean {
  return (
    event.type === "message.new" ||
    event.type === "message.edit" ||
    event.type === "message.delete" ||
    event.type === "reaction.add" ||
    event.type === "reaction.remove"
  );
}
