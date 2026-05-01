import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AtSign,
  Bot,
  CheckCheck,
  ChevronDown,
  Hash,
  Lock,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Send,
  Smile,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react";
import { Company, Me } from "../lib/api";
import {
  Mentionable,
  WorkspaceAttachment,
  WorkspaceAuthor,
  WorkspaceChannel,
  WorkspaceDirectory,
  WorkspaceMessage,
  WsInboundEvent,
  workspaceApi,
} from "../lib/workspace";
import {
  useCompanySocket,
  useCompanySocketSubscription,
} from "../components/CompanySocket";
import { EmojiPicker } from "../components/workspace/EmojiPicker";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";

/**
 * Slack-style workspace chat:
 *
 *   ┌────────────────────┬─────────────────────────────────────────┐
 *   │ Channels           │ #channel · topic          [members]      │
 *   │   # general        │ ─────────────────────────────────────── │
 *   │   # random         │  messages (virtual-ish scroll)          │
 *   │ Direct messages    │                                         │
 *   │   🟢 Alice         │ ─────────────────────────────────────── │
 *   │   🤖 Ada           │  [attach] [emoji]  Message…  [send]    │
 *   └────────────────────┴─────────────────────────────────────────┘
 *
 * Realtime: a single WebSocket per company streams every event; the page
 * filters to the active channel. The composer renders unsent attachments
 * as chips and sends their ids along with the message body.
 */

type WorkspaceProps = {
  company: Company;
  me: Me;
};

export default function Workspace({ company, me }: WorkspaceProps) {
  const { channelId: urlChannelId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [channels, setChannels] = React.useState<WorkspaceChannel[] | null>(null);
  const [activeChannelId, setActiveChannelId] = React.useState<string | null>(
    urlChannelId ?? null,
  );
  const [directory, setDirectory] = React.useState<WorkspaceDirectory | null>(null);
  const [mentionables, setMentionables] = React.useState<Mentionable[]>([]);
  const [messages, setMessages] = React.useState<Record<string, WorkspaceMessage[]>>(
    {},
  );
  const [onlineUsers, setOnlineUsers] = React.useState<Set<string>>(new Set());
  const [typing, setTyping] = React.useState<
    Record<string, { kind: "user" | "ai"; id: string; name: string; until: number }[]>
  >({});
  const [showNewChannel, setShowNewChannel] = React.useState(false);
  const [showNewDM, setShowNewDM] = React.useState(false);

  // Mirrors activeChannelId so the long-lived WS handler reads the latest
  // value instead of the one captured when the socket was opened. Without
  // this, a message arriving in the channel the user is currently viewing
  // would still bump unreadCount because the closure saw activeChannelId
  // as null/stale.
  const activeChannelIdRef = React.useRef<string | null>(activeChannelId);
  React.useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Tracks every message id we've already counted toward an unread badge so
  // a duplicate `message.new` frame (a flaky reconnect, two providers briefly
  // overlapping during a remount, etc.) doesn't compound the badge past the
  // server-authoritative count.
  const countedMessageIdsRef = React.useRef<Set<string>>(new Set());

  // ──────────────── Initial load + realtime wiring ─────────────────────

  // Load channels / directory / mentionables once per company. Do NOT
  // depend on urlChannelId here: the previous version refetched on every
  // channel switch, and the response (with server-side unreadCount that
  // races the markRead request) would clobber the local optimistic
  // "I just read this" state, leaving stale unread badges on channels the
  // user had already opened.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, dir, ments] = await Promise.all([
          workspaceApi.listChannels(company.id),
          workspaceApi.directory(company.id),
          workspaceApi.mentionables(company.id),
        ]);
        if (cancelled) return;
        setChannels(list);
        setDirectory(dir);
        setMentionables(ments);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, toast]);

  // Re-sync channels (and their server-authoritative unreadCount) from the
  // server. WS-driven local increments can drift past the real count over a
  // long-lived tab — a duplicate frame, a missed mark-read, another tab
  // marking a channel read — and there's no other path to reconcile.
  // Preserves unreadCount=0 on the active channel so a refetch that races
  // an in-flight markRead doesn't re-paint the badge the user just cleared.
  const refetchChannels = React.useCallback(async () => {
    try {
      const list = await workspaceApi.listChannels(company.id);
      setChannels(() =>
        list.map((c) =>
          c.id === activeChannelIdRef.current ? { ...c, unreadCount: 0 } : c,
        ),
      );
    } catch {
      // Silent — background reconciliation, not a user action.
    }
  }, [company.id]);

  React.useEffect(() => {
    const onFocus = () => refetchChannels();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchChannels]);

  // After the WS reconnects (e.g. the laptop woke up), re-sync once. The hub
  // doesn't replay missed frames, so without this the badges keep whatever
  // count they had when the connection dropped.
  const { status: wsStatus } = useCompanySocket();
  const prevWsStatusRef = React.useRef(wsStatus);
  React.useEffect(() => {
    if (prevWsStatusRef.current !== "open" && wsStatus === "open") {
      // Skip the very first transition; the mount fetch already ran.
      if (prevWsStatusRef.current !== "connecting") {
        refetchChannels();
      }
    }
    prevWsStatusRef.current = wsStatus;
  }, [wsStatus, refetchChannels]);

  // Land on the first channel if the URL has no channel and channels
  // have loaded. Separate from the data load so we don't refetch.
  React.useEffect(() => {
    if (urlChannelId || !channels || channels.length === 0) return;
    if (activeChannelId) return;
    const first = channels[0];
    setActiveChannelId(first.id);
    navigate(`/c/${company.slug}/workspace/${first.id}`, { replace: true });
  }, [urlChannelId, channels, activeChannelId, company.slug, navigate]);

  // Keep activeChannelId in sync with the URL (e.g. browser back/forward
  // or deep-linking after channels have loaded).
  React.useEffect(() => {
    if (!urlChannelId) return;
    if (urlChannelId === activeChannelId) return;
    setActiveChannelId(urlChannelId);
  }, [urlChannelId, activeChannelId]);

  // Subscribe to inbound frames on the shared per-company socket. The
  // provider in AppShell owns the connection so the bell, the chat surface,
  // and any future live feature share one socket.
  useCompanySocketSubscription((ev) => handleWsEvent(ev));

  function handleWsEvent(ev: WsInboundEvent) {
    switch (ev.type) {
      case "hello":
        return;
      case "message.new": {
        const alreadyCounted = countedMessageIdsRef.current.has(ev.message.id);
        countedMessageIdsRef.current.add(ev.message.id);
        setMessages((prev) => {
          const cur = prev[ev.channelId] ?? [];
          if (cur.some((m) => m.id === ev.message.id)) return prev;
          return { ...prev, [ev.channelId]: [...cur, ev.message] };
        });
        const isActiveChannel = ev.channelId === activeChannelIdRef.current;
        if (!alreadyCounted) {
          setChannels((prev) => {
            if (!prev) return prev;
            return prev.map((c) => {
              if (c.id !== ev.channelId) return c;
              const unreadDelta =
                ev.message.author?.kind === "user" && ev.message.author.id === me.id
                  ? 0
                  : isActiveChannel
                    ? 0
                    : 1;
              return {
                ...c,
                lastMessageAt: ev.message.createdAt,
                unreadCount: c.unreadCount + unreadDelta,
              };
            });
          });
        }
        // If the message landed in the channel the user is viewing, push
        // lastReadAt forward server-side so a reload doesn't re-surface it.
        if (isActiveChannel) {
          workspaceApi.markRead(company.id, ev.channelId).catch(() => {});
        }
        // Clear the typing pill for the author — their message just landed.
        const author = ev.message.author;
        if (author && author.kind !== "system") {
          setTyping((prev) => {
            const cur = prev[ev.channelId];
            if (!cur || cur.length === 0) return prev;
            const pruned = cur.filter(
              (t) => !(t.kind === author.kind && t.id === author.id),
            );
            if (pruned.length === cur.length) return prev;
            return { ...prev, [ev.channelId]: pruned };
          });
        }
        return;
      }
      case "message.edit": {
        setMessages((prev) => {
          const cur = prev[ev.channelId];
          if (!cur) return prev;
          return {
            ...prev,
            [ev.channelId]: cur.map((m) =>
              m.id === ev.messageId
                ? { ...m, content: ev.content, editedAt: ev.editedAt }
                : m,
            ),
          };
        });
        return;
      }
      case "message.delete": {
        setMessages((prev) => {
          const cur = prev[ev.channelId];
          if (!cur) return prev;
          return {
            ...prev,
            [ev.channelId]: cur.map((m) =>
              m.id === ev.messageId
                ? {
                    ...m,
                    content: "",
                    deletedAt: new Date().toISOString(),
                    attachments: [],
                  }
                : m,
            ),
          };
        });
        return;
      }
      case "reaction.add":
      case "reaction.remove": {
        setMessages((prev) => {
          const cur = prev[ev.channelId];
          if (!cur) return prev;
          return {
            ...prev,
            [ev.channelId]: cur.map((m) => {
              if (m.id !== ev.messageId) return m;
              const rs = [...m.reactions];
              const idx = rs.findIndex((r) => r.emoji === ev.emoji);
              if (ev.type === "reaction.add") {
                const isMe = ev.by.kind === "user" && ev.by.id === me.id;
                if (idx === -1) {
                  rs.push({
                    emoji: ev.emoji,
                    count: 1,
                    byMe: isMe,
                    actors: [ev.by],
                  });
                } else {
                  rs[idx] = {
                    ...rs[idx],
                    count: rs[idx].count + 1,
                    byMe: rs[idx].byMe || isMe,
                    actors: [...rs[idx].actors, ev.by],
                  };
                }
              } else if (idx !== -1) {
                const remaining = rs[idx].actors.filter(
                  (a) => !(a.kind === ev.by.kind && a.id === ev.by.id),
                );
                if (remaining.length === 0) rs.splice(idx, 1);
                else {
                  rs[idx] = {
                    ...rs[idx],
                    count: remaining.length,
                    actors: remaining,
                    byMe: remaining.some(
                      (a) => a.kind === "user" && a.id === me.id,
                    ),
                  };
                }
              }
              return { ...m, reactions: rs };
            }),
          };
        });
        return;
      }
      case "presence": {
        setOnlineUsers((prev) => {
          const next = new Set(prev);
          if (ev.online) next.add(ev.userId);
          else next.delete(ev.userId);
          return next;
        });
        return;
      }
      case "typing": {
        // Self-typing echoes back over the WS; suppress those so the user
        // doesn't see their own name in the "Alice is typing…" pill.
        if (ev.by.kind === "user" && ev.by.id === me.id) return;
        setTyping((prev) => {
          const cur = prev[ev.channelId] ?? [];
          const without = cur.filter(
            (t) => !(t.kind === ev.by.kind && t.id === ev.by.id),
          );
          return {
            ...prev,
            [ev.channelId]: [
              ...without,
              {
                kind: ev.by.kind,
                id: ev.by.id,
                name: ev.by.name,
                until: Date.now() + 6_000,
              },
            ],
          };
        });
        return;
      }
      default:
        return;
    }
  }

  // ──────────────── Channel selection + history ────────────────────────

  React.useEffect(() => {
    if (!activeChannelId) return;
    if (messages[activeChannelId]) return;
    (async () => {
      try {
        const list = await workspaceApi.listMessages(company.id, activeChannelId);
        setMessages((prev) => ({ ...prev, [activeChannelId]: list }));
      } catch (e) {
        toast((e as Error).message, "error");
      }
    })();
  }, [activeChannelId, company.id, messages, toast]);

  // Mark the active channel read whenever it changes, AND once the channel
  // list finishes loading (depending on `channelsLoaded`). Without the
  // load-time trigger, navigating directly to /workspace/:channelId left a
  // stale unread badge: the optimistic local clear ran before `channels`
  // existed, then the listChannels response arrived with the server-side
  // unreadCount and re-painted the badge.
  const channelsLoaded = channels !== null;
  React.useEffect(() => {
    if (!activeChannelId || !channelsLoaded) return;
    workspaceApi.markRead(company.id, activeChannelId).catch(() => {});
    setChannels((prev) =>
      prev ? prev.map((c) => (c.id === activeChannelId ? { ...c, unreadCount: 0 } : c)) : prev,
    );
  }, [activeChannelId, company.id, channelsLoaded]);

  // Sweep expired typing entries every second so pills fade out when a
  // typer stops sending the event. Runs on the outer component to keep one
  // timer for all channels.
  React.useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [cid, arr] of Object.entries(prev)) {
          const alive = arr.filter((t) => t.until > now);
          if (alive.length !== arr.length) changed = true;
          if (alive.length > 0) next[cid] = alive;
        }
        return changed ? next : prev;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, []);

  function selectChannel(id: string) {
    setActiveChannelId(id);
    navigate(`/c/${company.slug}/workspace/${id}`);
  }

  const activeChannel = channels?.find((c) => c.id === activeChannelId) ?? null;

  // ──────────────── Layout ─────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-1">
      <WorkspaceSidebar
        me={me}
        channels={channels}
        directory={directory}
        activeChannelId={activeChannelId}
        onlineUsers={onlineUsers}
        onSelect={selectChannel}
        onNewChannel={() => setShowNewChannel(true)}
        onNewDM={() => setShowNewDM(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-slate-950">
        {activeChannel ? (
          <ChannelView
            key={activeChannel.id}
            company={company}
            me={me}
            channel={activeChannel}
            messages={messages[activeChannel.id] ?? null}
            directory={directory}
            mentionables={mentionables}
            typing={typing[activeChannel.id] ?? []}
            onAttachmentUrl={(id) => workspaceApi.attachmentUrl(company.id, id)}
            onChannelUpdated={(updated) => {
              setChannels((prev) =>
                prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
              );
            }}
          />
        ) : (
          <EmptyWorkspace
            onCreate={() => setShowNewChannel(true)}
            onStartDm={() => setShowNewDM(true)}
          />
        )}
      </main>

      <NewChannelModal
        open={showNewChannel}
        company={company}
        directory={directory}
        onClose={() => setShowNewChannel(false)}
        onCreated={(ch) => {
          setShowNewChannel(false);
          setChannels((prev) => (prev ? [ch, ...prev] : [ch]));
          selectChannel(ch.id);
        }}
      />
      <NewDMModal
        open={showNewDM}
        company={company}
        directory={directory}
        meId={me.id}
        onClose={() => setShowNewDM(false)}
        onOpened={(ch) => {
          setShowNewDM(false);
          setChannels((prev) => {
            if (!prev) return [ch];
            return prev.some((c) => c.id === ch.id) ? prev : [ch, ...prev];
          });
          selectChannel(ch.id);
        }}
      />
    </div>
  );
}

// ────────────────────────── Sidebar ─────────────────────────────────────

function WorkspaceSidebar({
  me,
  channels,
  directory,
  activeChannelId,
  onlineUsers,
  onSelect,
  onNewChannel,
  onNewDM,
}: {
  me: Me;
  channels: WorkspaceChannel[] | null;
  directory: WorkspaceDirectory | null;
  activeChannelId: string | null;
  onlineUsers: Set<string>;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
  onNewDM: () => void;
}) {
  const publicChannels = (channels ?? []).filter((c) => c.kind === "public");
  const privateChannels = (channels ?? []).filter((c) => c.kind === "private");
  const dms = (channels ?? []).filter((c) => c.kind === "dm");

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Workspace chat
        </div>
      </div>
      <SidebarSection
        title="Channels"
        action={<AddButton onClick={onNewChannel} label="Create channel" />}
      >
        {publicChannels.map((c) => (
          <ChannelRow
            key={c.id}
            icon={<Hash size={14} />}
            label={c.name || "channel"}
            active={c.id === activeChannelId}
            unread={c.unreadCount}
            onClick={() => onSelect(c.id)}
          />
        ))}
        {privateChannels.map((c) => (
          <ChannelRow
            key={c.id}
            icon={<Lock size={14} />}
            label={c.name || "channel"}
            active={c.id === activeChannelId}
            unread={c.unreadCount}
            onClick={() => onSelect(c.id)}
          />
        ))}
        {publicChannels.length === 0 && privateChannels.length === 0 && (
          <EmptyHint label="No channels yet." />
        )}
      </SidebarSection>
      <SidebarSection
        title="Direct messages"
        action={<AddButton onClick={onNewDM} label="New DM" />}
      >
        {dms.map((c) => {
          const other = dmCounterpart(c, me.id);
          const onlineDot =
            other?.kind === "user" && onlineUsers.has(other.id) ? (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            ) : null;
          return (
            <ChannelRow
              key={c.id}
              icon={other?.kind === "ai" ? <Bot size={14} /> : <UserIcon size={14} />}
              label={other?.name ?? "(empty)"}
              right={onlineDot}
              active={c.id === activeChannelId}
              unread={c.unreadCount}
              onClick={() => onSelect(c.id)}
            />
          );
        })}
        {dms.length === 0 && <EmptyHint label="No direct messages." />}
      </SidebarSection>
    </aside>
  );
}

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="border-b border-slate-100 py-2 dark:border-slate-800">
      <div className="flex items-center justify-between px-4 py-1">
        <button
          className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${open ? "" : "-rotate-90"}`}
          />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="px-2 py-1">{children}</div>}
    </div>
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Plus size={14} />
    </button>
  );
}

function ChannelRow({
  icon,
  label,
  active,
  unread,
  right,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  unread?: number;
  right?: React.ReactNode;
  onClick: () => void;
}) {
  const unreadBadge =
    unread && unread > 0 ? (
      <span className="ml-auto rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold text-white">
        {unread > 99 ? "99+" : unread}
      </span>
    ) : right ? (
      <span className="ml-auto">{right}</span>
    ) : null;
  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm " +
        (active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : unread && unread > 0
            ? "font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
            : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      <span className="text-slate-400 dark:text-slate-500">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {unreadBadge}
    </button>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="px-2 py-1 text-xs italic text-slate-400 dark:text-slate-500">
      {label}
    </div>
  );
}

function dmCounterpart(c: WorkspaceChannel, meId: string): WorkspaceAuthor | null {
  return (
    c.members.find(
      (m) => !(m.kind === "user" && "id" in m && m.id === meId),
    ) ?? null
  );
}

// ────────────────────────── Channel view ────────────────────────────────

function ChannelView({
  company,
  me,
  channel,
  messages,
  directory,
  mentionables,
  typing,
  onAttachmentUrl,
  onChannelUpdated,
}: {
  company: Company;
  me: Me;
  channel: WorkspaceChannel;
  messages: WorkspaceMessage[] | null;
  directory: WorkspaceDirectory | null;
  mentionables: Mentionable[];
  typing: { kind: "user" | "ai"; id: string; name: string; until: number }[];
  onAttachmentUrl: (id: string) => string;
  onChannelUpdated: (c: WorkspaceChannel) => void;
}) {
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const [showMembers, setShowMembers] = React.useState(false);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages?.length, channel.id]);

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-6 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <ChannelIcon channel={channel} meId={me.id} />
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {channelTitle(channel, me.id)}
          </div>
          {channel.topic && (
            <div className="border-l border-slate-200 pl-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {channel.topic}
            </div>
          )}
        </div>
        <div className="ml-auto">
          <button
            onClick={() => setShowMembers(true)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <AtSign size={12} /> {channel.members.length} member
            {channel.members.length === 1 ? "" : "s"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {messages === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-slate-400 dark:text-slate-500">
            <div>
              <div className="mb-1 text-base font-medium text-slate-600 dark:text-slate-300">
                {channelTitle(channel, me.id)}
              </div>
              Start the conversation. @mention an AI employee to bring them in.
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            meId={me.id}
            mentionables={mentionables}
            onAttachmentUrl={onAttachmentUrl}
            onEdit={async (m, content) => {
              await workspaceApi.editMessage(company.id, m.id, content);
            }}
            onDelete={async (m) => {
              await workspaceApi.deleteMessage(company.id, m.id);
            }}
            onReact={async (m, emoji) => {
              await workspaceApi.toggleReaction(company.id, m.id, emoji);
            }}
          />
        )}
        <div ref={endRef} />
      </div>

      {typing.length > 0 && <TypingPill typers={typing} />}

      <Composer
        company={company}
        channel={channel}
        directory={directory}
        mentionables={mentionables}
      />

      <MembersModal
        open={showMembers}
        onClose={() => setShowMembers(false)}
        channel={channel}
        directory={directory}
        company={company}
        onChanged={onChannelUpdated}
      />
    </>
  );
}

function ChannelIcon({ channel, meId }: { channel: WorkspaceChannel; meId: string }) {
  if (channel.kind === "dm") {
    const other = dmCounterpart(channel, meId);
    return other?.kind === "ai" ? (
      <Bot size={16} className="text-indigo-500" />
    ) : (
      <UserIcon size={16} className="text-slate-400" />
    );
  }
  if (channel.kind === "private")
    return <Lock size={16} className="text-slate-400" />;
  return <Hash size={16} className="text-slate-400" />;
}

function channelTitle(c: WorkspaceChannel, meId: string): string {
  if (c.kind === "dm") {
    const other = dmCounterpart(c, meId);
    return other?.name ?? "Direct message";
  }
  return c.name ?? "channel";
}

// ────────────────────────── Message list ────────────────────────────────

function MessageList({
  messages,
  meId,
  mentionables,
  onAttachmentUrl,
  onEdit,
  onDelete,
  onReact,
}: {
  messages: WorkspaceMessage[];
  meId: string;
  mentionables: Mentionable[];
  onAttachmentUrl: (id: string) => string;
  onEdit: (m: WorkspaceMessage, content: string) => Promise<void>;
  onDelete: (m: WorkspaceMessage) => Promise<void>;
  onReact: (m: WorkspaceMessage, emoji: string) => Promise<void>;
}) {
  // Group adjacent messages by author within 5-minute windows for a cleaner
  // Slack-like layout: first message renders full (avatar + name + ts),
  // subsequent ones indent and hide the header.
  let prev: WorkspaceMessage | null = null;
  return (
    <div className="space-y-0.5">
      {messages.map((m) => {
        const bundled = isBundled(prev, m);
        prev = m;
        return (
          <MessageRow
            key={m.id}
            message={m}
            bundled={bundled}
            meId={meId}
            mentionables={mentionables}
            onAttachmentUrl={onAttachmentUrl}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        );
      })}
    </div>
  );
}

function isBundled(prev: WorkspaceMessage | null, m: WorkspaceMessage): boolean {
  if (!prev) return false;
  if (prev.authorKind !== m.authorKind) return false;
  const pa = authorId(prev.author);
  const ma = authorId(m.author);
  if (!pa || !ma || pa !== ma) return false;
  const gap = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return gap < 5 * 60 * 1000;
}

function authorId(a: WorkspaceAuthor | null): string | null {
  if (!a) return null;
  if (a.kind === "system") return "system";
  return a.id;
}

function MessageRow({
  message,
  bundled,
  meId,
  mentionables,
  onAttachmentUrl,
  onEdit,
  onDelete,
  onReact,
}: {
  message: WorkspaceMessage;
  bundled: boolean;
  meId: string;
  mentionables: Mentionable[];
  onAttachmentUrl: (id: string) => string;
  onEdit: (m: WorkspaceMessage, content: string) => Promise<void>;
  onDelete: (m: WorkspaceMessage) => Promise<void>;
  onReact: (m: WorkspaceMessage, emoji: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const dialog = useDialog();
  const { toast } = useToast();

  const isMine =
    message.author?.kind === "user" && "id" in message.author && message.author.id === meId;
  const isDeleted = !!message.deletedAt;
  const ts = new Date(message.createdAt);
  const timeLabel = ts.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const dateLabel = ts.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      className={
        "group relative flex gap-3 rounded-md px-2 py-1 " +
        (bundled ? "" : "mt-3 ") +
        "hover:bg-slate-50 dark:hover:bg-slate-900"
      }
    >
      <div className="w-10 shrink-0">
        {!bundled ? (
          <Avatar author={message.author} />
        ) : (
          <div className="mt-1 hidden h-4 w-full text-right text-[10px] text-slate-400 group-hover:block dark:text-slate-500">
            {timeLabel}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!bundled && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {message.author?.name ?? "(unknown)"}
            </span>
            {message.author?.kind === "ai" && (
              <span className="rounded bg-indigo-50 px-1 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                AI
              </span>
            )}
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              {dateLabel} · {timeLabel}
            </span>
            {message.editedAt && (
              <span className="text-[11px] text-slate-400 dark:text-slate-500">(edited)</span>
            )}
          </div>
        )}

        {editing ? (
          <div className="mt-1 flex items-center gap-2">
            <textarea
              className="min-h-[36px] w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await onEdit(message, draft);
                  setEditing(false);
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(message.content);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : isDeleted ? (
          <div className="mt-0.5 text-sm italic text-slate-400 dark:text-slate-500">
            This message was deleted.
          </div>
        ) : (
          <MessageBody content={message.content} mentionables={mentionables} />
        )}

        {!isDeleted && message.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <AttachmentPreview
                key={a.id}
                attachment={a}
                url={onAttachmentUrl(a.id)}
              />
            ))}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(message, r.emoji)}
                title={r.actors.map((a) => a.name).join(", ")}
                className={
                  "flex h-6 items-center gap-1 rounded-full px-2 text-xs " +
                  (r.byMe
                    ? "border border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-200"
                    : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300")
                }
              >
                <span>{r.emoji}</span>
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!editing && !isDeleted && (
        <div className="absolute right-2 top-1 hidden items-center gap-1 rounded-md border border-slate-200 bg-white shadow-sm group-hover:flex dark:border-slate-700 dark:bg-slate-900">
          <div className="relative">
            <button
              onClick={() => setEmojiOpen((o) => !o)}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
              title="Add reaction"
            >
              <Smile size={14} />
            </button>
            {emojiOpen && (
              <EmojiPicker
                onPick={(e) => onReact(message, e)}
                onClose={() => setEmojiOpen(false)}
              />
            )}
          </div>
          {isMine && (
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
              title="More"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-30 mt-1 w-32 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <button
                  onClick={() => {
                    setEditing(true);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Edit
                </button>
                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    const ok = await dialog.confirm({
                      title: "Delete message?",
                      message: "This can't be undone.",
                      confirmLabel: "Delete",
                      variant: "danger",
                    });
                    if (!ok) return;
                    try {
                      await onDelete(message);
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ author }: { author: WorkspaceAuthor | null }) {
  if (!author)
    return <div className="h-9 w-9 rounded-md bg-slate-200 dark:bg-slate-700" />;
  if (author.kind === "ai") {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
        <Bot size={18} />
      </div>
    );
  }
  if (author.kind === "system")
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
        <MessagesSquare size={16} />
      </div>
    );
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-100 text-sm font-semibold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
      {initials(author.name)}
    </div>
  );
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function MessageBody({
  content,
  mentionables,
}: {
  content: string;
  mentionables: Mentionable[];
}) {
  // Full GitHub-flavored markdown (bold, lists, code fences, tables, links)
  // via marked + DOMPurify — same pipeline as the 1:1 EmployeeChat. We
  // post-process the sanitized HTML to wrap `@handle` and `#base/foo`
  // tokens in clickable pills backed by the mentionables directory. The
  // walker skips inside <code>/<pre>/<a> so code samples and already-linked
  // text aren't corrupted.
  const html = React.useMemo(() => {
    const raw = marked.parse(content ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    const safe = DOMPurify.sanitize(raw);
    return linkifyMentions(safe, mentionables);
  }, [content, mentionables]);

  return (
    <div
      className="chat-md mt-0.5 break-words text-sm text-slate-700 dark:text-slate-200"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleMentionClickCapture}
    />
  );
}

/**
 * Intercept clicks on mention pills: we render them as anchors with
 * `data-mention-href` so React Router's link click interception still
 * delegates through the normal page-level handler. Using an anchor + href
 * keeps middle-click / cmd-click working too (opens in a new tab).
 */
function handleMentionClickCapture(_e: React.MouseEvent<HTMLDivElement>): void {
  // The anchors already have the right href — no extra JS needed here. The
  // handler is kept as a hook point for a future "jump to channel" action
  // that we might want to intercept without a full page nav.
}

const MENTION_RE =
  /(^|[\s(])([@#][a-z0-9][a-z0-9/_-]{0,80}[a-z0-9])/gi;

function linkifyMentions(html: string, mentionables: Mentionable[]): string {
  if (typeof document === "undefined") return html;
  // "First wins" — listCompanyMentionables emits users first, then AI, so a
  // human handle is preferred over a colliding AI slug when both exist in
  // the directory (the server's handle guard normally prevents this, but
  // older data can still collide).
  const byHandle = new Map<string, Mentionable>();
  for (const m of mentionables) {
    const k = m.handle.toLowerCase();
    if (!byHandle.has(k)) byHandle.set(k, m);
  }
  const container = document.createElement("div");
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const skip = new Set(["CODE", "PRE", "A"]);
  const nodes: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    let p: Node | null = node.parentNode;
    let safeToWrap = true;
    while (p && p !== container) {
      if (p instanceof HTMLElement && skip.has(p.tagName)) {
        safeToWrap = false;
        break;
      }
      p = p.parentNode;
    }
    if (safeToWrap) nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const t of nodes) {
    const text = t.nodeValue ?? "";
    if (!/[@#]/.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) {
        frag.appendChild(document.createTextNode(text.slice(last, start)));
      }
      const token = m[2];
      const hit = byHandle.get(token.toLowerCase());
      if (hit) {
        const a = document.createElement("a");
        a.href = hit.href;
        a.className = mentionPillClass(hit.kind);
        a.title = hit.label + (hit.sublabel ? ` · ${hit.sublabel}` : "");
        a.textContent = token;
        frag.appendChild(a);
      } else {
        // Unresolved — render as a greyed pill so the author notices the
        // typo instead of it silently looking like normal text.
        const span = document.createElement("span");
        span.className =
          "rounded bg-slate-100 px-1 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
        span.textContent = token;
        frag.appendChild(span);
      }
      last = start + token.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    if (frag.childNodes.length > 0) t.parentNode?.replaceChild(frag, t);
  }
  return container.innerHTML;
}

function mentionPillClass(kind: Mentionable["kind"]): string {
  const core = "rounded px-1 no-underline hover:underline ";
  switch (kind) {
    case "user":
      return core + "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300";
    case "ai":
      return core + "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300";
    case "channel":
      return core + "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300";
    case "base":
    case "base_table":
      return core + "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
    case "connection":
      return core + "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300";
  }
}

function AttachmentPreview({
  attachment,
  url,
}: {
  attachment: WorkspaceAttachment;
  url: string;
}) {
  if (attachment.isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={attachment.filename}
          className="max-h-64 max-w-xs rounded-lg border border-slate-200 object-cover dark:border-slate-700"
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Paperclip size={12} />
      <span className="max-w-[240px] truncate">{attachment.filename}</span>
      <span className="text-slate-400 dark:text-slate-500">
        {formatBytes(attachment.sizeBytes)}
      </span>
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ────────────────────────── Composer ────────────────────────────────────

function Composer({
  company,
  channel,
  directory,
  mentionables,
}: {
  company: Company;
  channel: WorkspaceChannel;
  directory: WorkspaceDirectory | null;
  mentionables: Mentionable[];
}) {
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<WorkspaceAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const { toast } = useToast();

  // Reset the draft when the active channel changes — prevents leaking a
  // half-written message into the next room.
  React.useEffect(() => {
    setDraft("");
    setAttachments([]);
  }, [channel.id]);

  function autoResize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    setSending(true);
    try {
      await workspaceApi.sendMessage(company.id, channel.id, {
        content: draft,
        attachmentIds: attachments.map((a) => a.id),
      });
      setDraft("");
      setAttachments([]);
      setEmojiOpen(false);
      setMentionOpen(false);
      autoResize(textRef.current);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const f of Array.from(files)) {
      try {
        const a = await workspaceApi.uploadAttachment(company.id, f);
        setAttachments((prev) => [...prev, a]);
      } catch (err) {
        toast(`Upload failed: ${(err as Error).message}`, "error");
      }
    }
  }

  // Autocomplete fires as soon as the caret sits right after `@` or `#`.
  // `mentionPrefix` carries the trigger char so the matcher can stay
  // simple — `@` hits users+AI, `#` hits channels/bases/tables/connections.
  const [mentionPrefix, setMentionPrefix] = React.useState<"@" | "#" | null>(null);

  function updateDraft(next: string) {
    setDraft(next);
    autoResize(textRef.current);
    const el = textRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? next.length;
    const head = next.slice(0, caret);
    const m = head.match(/([@#])([a-z0-9/_-]*)$/i);
    if (m) {
      setMentionOpen(true);
      setMentionPrefix(m[1] as "@" | "#");
      setMentionQuery(m[2].toLowerCase());
    } else {
      setMentionOpen(false);
      setMentionPrefix(null);
    }
  }

  function insertMention(handle: string) {
    const el = textRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const head = draft.slice(0, caret);
    const tail = draft.slice(caret);
    const replaced = head.replace(/[@#][a-z0-9/_-]*$/i, `${handle} `);
    setDraft(replaced + tail);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
      autoResize(el);
    });
  }

  const mentionCandidates = React.useMemo(() => {
    if (!mentionPrefix) return [] as Mentionable[];
    const kinds =
      mentionPrefix === "@"
        ? new Set(["user", "ai"])
        : new Set(["channel", "base", "base_table", "connection"]);
    return mentionables
      .filter((x) => kinds.has(x.kind))
      .filter((x) => {
        if (!mentionQuery) return true;
        const q = mentionQuery;
        return (
          x.handle.toLowerCase().includes(q) ||
          x.label.toLowerCase().includes(q)
        );
      })
      .slice(0, 30);
  }, [mentionables, mentionPrefix, mentionQuery]);

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <Paperclip size={12} className="text-slate-400" />
              <span className="max-w-[180px] truncate">{a.filename}</span>
              <span className="text-slate-400">{formatBytes(a.sizeBytes)}</span>
              <button
                onClick={() =>
                  setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                }
                className="ml-1 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-2 focus-within:border-indigo-400 dark:border-slate-700 dark:bg-slate-900">
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          multiple
          onChange={(e) => onFiles(e.target.files)}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Attach file"
          aria-label="Attach file"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            } else if (e.key === "Escape") {
              setMentionOpen(false);
              setEmojiOpen(false);
            }
          }}
          placeholder={`Message ${channelPlaceholder(channel)}`}
          className="min-h-[28px] w-full resize-none bg-transparent px-1 py-1 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
          rows={1}
        />
        <div className="relative">
          <button
            onClick={() => setEmojiOpen((o) => !o)}
            className="mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Emoji"
            aria-label="Emoji"
          >
            <Smile size={16} />
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => setDraft((d) => d + e)}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>
        <Button size="sm" disabled={sending} onClick={handleSend}>
          {sending ? <Spinner size={12} /> : <Send size={14} />}
          Send
        </Button>

        {mentionOpen && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-12 z-20 mb-2 w-72 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {mentionPrefix === "@" ? "People" : "Resources"}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {mentionCandidates.map((x) => (
                <button
                  key={`${x.kind}-${x.handle}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    insertMention(x.handle);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <MentionIcon kind={x.kind} />
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {x.handle}
                  </span>
                  <span className="ml-auto truncate text-xs text-slate-500 dark:text-slate-400">
                    {x.label}
                    {x.sublabel ? ` · ${x.sublabel}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
        Press <kbd className="rounded border border-slate-200 px-1 dark:border-slate-700">Enter</kbd> to send · <kbd className="rounded border border-slate-200 px-1 dark:border-slate-700">Shift+Enter</kbd> newline · <span className="font-mono">@</span> for people · <span className="font-mono">#</span> for channels, bases &amp; connections
      </div>
    </div>
  );
}

function MentionIcon({ kind }: { kind: Mentionable["kind"] }) {
  const cls = "shrink-0";
  switch (kind) {
    case "user":
      return <UserIcon size={14} className={cls + " text-emerald-500"} />;
    case "ai":
      return <Bot size={14} className={cls + " text-indigo-500"} />;
    case "channel":
      return <Hash size={14} className={cls + " text-sky-500"} />;
    case "base":
    case "base_table":
      return <Hash size={14} className={cls + " text-amber-500"} />;
    case "connection":
      return <Hash size={14} className={cls + " text-violet-500"} />;
  }
}

function channelPlaceholder(c: WorkspaceChannel): string {
  if (c.kind === "dm") return "your recipient";
  return `#${c.name ?? "channel"}`;
}

function TypingPill({
  typers,
}: {
  typers: { kind: "user" | "ai"; id: string; name: string; until: number }[];
}) {
  const names = typers.map((t) => t.name).filter(Boolean);
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;
  return (
    <div className="shrink-0 border-t border-slate-100 px-6 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <span className="inline-flex items-center gap-1">
        <TypingDots />
        {label}…
      </span>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
    </span>
  );
}

// ────────────────────────── Empty state ─────────────────────────────────

function EmptyWorkspace({
  onCreate,
  onStartDm,
}: {
  onCreate: () => void;
  onStartDm: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md p-8 text-center">
        <div className="mb-3 flex justify-center text-indigo-500">
          <MessagesSquare size={36} />
        </div>
        <h2 className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
          Your workspace chat
        </h2>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          Create a channel for your team, or start a DM with a teammate or AI employee.
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={onCreate}>
            <Hash size={14} /> New channel
          </Button>
          <Button variant="secondary" onClick={onStartDm}>
            <UserIcon size={14} /> Start DM
          </Button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Modals ──────────────────────────────────────

function NewChannelModal({
  open,
  company,
  directory,
  onClose,
  onCreated,
}: {
  open: boolean;
  company: Company;
  directory: WorkspaceDirectory | null;
  onClose: () => void;
  onCreated: (c: WorkspaceChannel) => void;
}) {
  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [kind, setKind] = React.useState<"public" | "private">("public");
  const [pickedUsers, setPickedUsers] = React.useState<Set<string>>(new Set());
  const [pickedEmps, setPickedEmps] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) {
      setName("");
      setTopic("");
      setKind("public");
      setPickedUsers(new Set());
      setPickedEmps(new Set());
    }
  }, [open]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const ch = await workspaceApi.createChannel(company.id, {
        name: name.trim(),
        topic: topic.trim(),
        kind,
        memberUserIds: Array.from(pickedUsers),
        employeeIds: Array.from(pickedEmps),
      });
      onCreated(ch);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create a channel">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="general"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Topic (optional)
          </label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Team updates and announcements"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Privacy
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => setKind("public")}
              className={
                "flex-1 rounded-md border px-3 py-2 text-left text-sm " +
                (kind === "public"
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-200"
                  : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800")
              }
            >
              <div className="flex items-center gap-2 font-medium">
                <Hash size={14} /> Public
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Everyone in the company can join.
              </div>
            </button>
            <button
              onClick={() => setKind("private")}
              className={
                "flex-1 rounded-md border px-3 py-2 text-left text-sm " +
                (kind === "private"
                  ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-200"
                  : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800")
              }
            >
              <div className="flex items-center gap-2 font-medium">
                <Lock size={14} /> Private
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Only members you invite can see it.
              </div>
            </button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Add people (optional)
          </label>
          <MemberPicker
            directory={directory}
            selectedUsers={pickedUsers}
            selectedEmps={pickedEmps}
            onToggleUser={(id) =>
              setPickedUsers((prev) => {
                const n = new Set(prev);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onToggleEmp={(id) =>
              setPickedEmps((prev) => {
                const n = new Set(prev);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || creating} onClick={create}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function NewDMModal({
  open,
  company,
  directory,
  meId,
  onClose,
  onOpened,
}: {
  open: boolean;
  company: Company;
  directory: WorkspaceDirectory | null;
  meId: string;
  onClose: () => void;
  onOpened: (c: WorkspaceChannel) => void;
}) {
  const [q, setQ] = React.useState("");
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  async function openWith(target: { targetUserId: string } | { targetEmployeeId: string }) {
    try {
      const ch = await workspaceApi.openDm(company.id, target);
      onOpened(ch);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const users = (directory?.members ?? []).filter(
    (m) =>
      m.id !== meId &&
      (!q.trim() ||
        m.name.toLowerCase().includes(q.toLowerCase()) ||
        m.email.toLowerCase().includes(q.toLowerCase())),
  );
  const emps = (directory?.employees ?? []).filter(
    (e) =>
      !q.trim() ||
      e.name.toLowerCase().includes(q.toLowerCase()) ||
      e.slug.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Modal open={open} onClose={onClose} title="Start a direct message">
      <div className="space-y-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search teammates or AI employees"
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {users.length > 0 && (
            <div>
              <div className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Teammates
              </div>
              {users.map((u) => (
                <button
                  key={u.id}
                  onClick={() => openWith({ targetUserId: u.id })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                    {initials(u.name)}
                  </div>
                  <span className="font-medium">{u.name}</span>
                  <span className="ml-auto truncate text-xs text-slate-400">{u.email}</span>
                </button>
              ))}
            </div>
          )}
          {emps.length > 0 && (
            <div>
              <div className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                AI employees
              </div>
              {emps.map((e) => (
                <button
                  key={e.id}
                  onClick={() => openWith({ targetEmployeeId: e.id })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                    <Bot size={12} />
                  </div>
                  <span className="font-medium">{e.name}</span>
                  <span className="ml-auto truncate text-xs text-slate-400">{e.role}</span>
                </button>
              ))}
            </div>
          )}
          {users.length === 0 && emps.length === 0 && (
            <div className="py-8 text-center text-sm text-slate-400">
              No matches.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MembersModal({
  open,
  onClose,
  channel,
  directory,
  company,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  channel: WorkspaceChannel;
  directory: WorkspaceDirectory | null;
  company: Company;
  onChanged: (c: WorkspaceChannel) => void;
}) {
  const [adding, setAdding] = React.useState<
    | null
    | { kind: "user"; id: string }
    | { kind: "ai"; id: string }
  >(null);
  const { toast } = useToast();

  async function add(target: "user" | "ai", id: string) {
    setAdding({ kind: target, id });
    try {
      const updated = await workspaceApi.addMembers(company.id, channel.id, {
        userIds: target === "user" ? [id] : [],
        employeeIds: target === "ai" ? [id] : [],
      });
      onChanged(updated);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setAdding(null);
    }
  }

  const memberUserIds = new Set(
    channel.members.filter((m) => m.kind === "user").map((m) => (m as WorkspaceAuthor & { id: string }).id),
  );
  const memberEmpIds = new Set(
    channel.members.filter((m) => m.kind === "ai").map((m) => (m as WorkspaceAuthor & { id: string }).id),
  );
  const addableUsers = (directory?.members ?? []).filter(
    (u) => !memberUserIds.has(u.id),
  );
  const addableEmps = (directory?.employees ?? []).filter(
    (e) => !memberEmpIds.has(e.id),
  );

  return (
    <Modal open={open} onClose={onClose} title="Members">
      <div className="space-y-4">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            In this channel
          </div>
          <div className="space-y-1">
            {channel.members.map((m) => (
              <div
                key={`${m.kind}-${"id" in m ? m.id : "system"}`}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
              >
                {m.kind === "ai" ? (
                  <Bot size={14} className="text-indigo-500" />
                ) : (
                  <UserIcon size={14} className="text-slate-400" />
                )}
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {m.name}
                </span>
                {m.kind === "ai" && (
                  <span className="rounded bg-indigo-50 px-1 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                    AI
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        {(addableUsers.length > 0 || addableEmps.length > 0) && (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Add people
            </div>
            <div className="space-y-1">
              {addableUsers.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                >
                  <UserIcon size={14} className="text-slate-400" />
                  <span className="font-medium">{u.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={adding?.kind === "user" && adding.id === u.id}
                    className="ml-auto"
                    onClick={() => add("user", u.id)}
                  >
                    Add
                  </Button>
                </div>
              ))}
              {addableEmps.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
                >
                  <Bot size={14} className="text-indigo-500" />
                  <span className="font-medium">{e.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={adding?.kind === "ai" && adding.id === e.id}
                    className="ml-auto"
                    onClick={() => add("ai", e.id)}
                  >
                    Add
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MemberPicker({
  directory,
  selectedUsers,
  selectedEmps,
  onToggleUser,
  onToggleEmp,
}: {
  directory: WorkspaceDirectory | null;
  selectedUsers: Set<string>;
  selectedEmps: Set<string>;
  onToggleUser: (id: string) => void;
  onToggleEmp: (id: string) => void;
}) {
  if (!directory)
    return (
      <div className="py-4 text-center">
        <Spinner size={16} />
      </div>
    );
  return (
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">
      {directory.members.map((u) => (
        <button
          key={u.id}
          onClick={() => onToggleUser(u.id)}
          className={
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm " +
            (selectedUsers.has(u.id)
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10"
              : "hover:bg-slate-50 dark:hover:bg-slate-800")
          }
        >
          <UserIcon size={14} className="text-slate-400" />
          <span>{u.name}</span>
          {selectedUsers.has(u.id) && (
            <CheckCheck size={14} className="ml-auto text-indigo-500" />
          )}
        </button>
      ))}
      {directory.employees.map((e) => (
        <button
          key={e.id}
          onClick={() => onToggleEmp(e.id)}
          className={
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm " +
            (selectedEmps.has(e.id)
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10"
              : "hover:bg-slate-50 dark:hover:bg-slate-800")
          }
        >
          <Bot size={14} className="text-indigo-500" />
          <span>{e.name}</span>
          <span className="text-xs text-slate-400">({e.slug})</span>
          {selectedEmps.has(e.id) && (
            <CheckCheck size={14} className="ml-auto text-indigo-500" />
          )}
        </button>
      ))}
    </div>
  );
}
