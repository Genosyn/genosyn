import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  AtSign,
  Bot,
  CheckCheck,
  ChevronDown,
  Copy,
  Hash,
  Lock,
  MessagesSquare,
  Plug,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  User as UserIcon,
} from "lucide-react";
import { Company, Me } from "../lib/api";
import {
  Mentionable,
  WorkspaceAuthor,
  WorkspaceChannel,
  WorkspaceChannelWebhookSettings,
  WorkspaceDirectory,
  WorkspaceMessage,
  WsInboundEvent,
  workspaceApi,
  workspaceChannelHref,
} from "../lib/workspace";
import { applyWorkspaceMessageEvent, mergeWorkspaceMessages } from "../lib/workspaceMessages";
import { copyToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { useCompanySocket, useCompanySocketSubscription } from "../components/CompanySocket";
import { ChannelComposer } from "../components/workspace/Composer";
import { initials, MessageList } from "../components/workspace/MessageList";
import { TypingPill, useChannelTyping } from "../components/workspace/TypingPill";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import { PlanLimitBanner } from "../components/FeatureGateCard";
import { SidebarLink } from "../components/AppShell";

/**
 * Slack-style workspace chat:
 *
 *   ┌────────────────────┬─────────────────────────────────────────┐
 *   │ Channels           │ #channel · topic         [settings]      │
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

const WORKSPACE_MESSAGE_PAGE_SIZE = 40;

export default function Workspace({ company, me }: WorkspaceProps) {
  const { channelId: urlChannelId } = useParams();
  const navigate = useNavigate();
  const dialog = useDialog();

  const [channels, setChannels] = React.useState<WorkspaceChannel[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = React.useState<string | null>(urlChannelId ?? null);
  const [directory, setDirectory] = React.useState<WorkspaceDirectory | null>(null);
  const [mentionables, setMentionables] = React.useState<Mentionable[]>([]);
  const [messages, setMessages] = React.useState<Record<string, WorkspaceMessage[]>>({});
  const [messageHistoryLoaded, setMessageHistoryLoaded] = React.useState<Record<string, boolean>>(
    {},
  );
  const [hasOlderMessages, setHasOlderMessages] = React.useState<Record<string, boolean>>({});
  const [loadingOlderMessages, setLoadingOlderMessages] = React.useState<Record<string, boolean>>(
    {},
  );
  const [messageErrors, setMessageErrors] = React.useState<Record<string, string | null>>({});
  const [onlineUsers, setOnlineUsers] = React.useState<Set<string>>(new Set());
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
  const loadingOlderChannelIdsRef = React.useRef<Set<string>>(new Set());

  // ──────────────── Initial load + realtime wiring ─────────────────────

  // Load channels / directory / mentionables once per company. Do NOT
  // depend on urlChannelId here: the previous version refetched on every
  // channel switch, and the response (with server-side unreadCount that
  // races the markRead request) would clobber the local optimistic
  // "I just read this" state, leaving stale unread badges on channels the
  // user had already opened.
  React.useEffect(() => {
    let cancelled = false;
    setChannels(null);
    setLoadError(null);
    setDirectory(null);
    setMentionables([]);
    setMessages({});
    setMessageHistoryLoaded({});
    setHasOlderMessages({});
    setLoadingOlderMessages({});
    setMessageErrors({});
    countedMessageIdsRef.current.clear();
    loadingOlderChannelIdsRef.current.clear();
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
        if (cancelled) return;
        setLoadError(errorMessage(e, "Could not load the workspace"));
        setChannels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id]);

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
        list.map((c) => (c.id === activeChannelIdRef.current ? { ...c, unreadCount: 0 } : c)),
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
    navigate(workspaceChannelHref(company.slug, first.id), { replace: true });
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
          const next = applyWorkspaceMessageEvent(cur, ev, { meId: me.id });
          return next === cur ? prev : { ...prev, [ev.channelId]: next };
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
        return;
      }
      case "message.edit":
      case "message.delete":
      case "reaction.add":
      case "reaction.remove": {
        setMessages((prev) => {
          const cur = prev[ev.channelId];
          if (!cur) return prev;
          const next = applyWorkspaceMessageEvent(cur, ev, { meId: me.id });
          return next === cur ? prev : { ...prev, [ev.channelId]: next };
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
      // `typing` is handled by `useChannelTyping` in the channel being
      // viewed. The page used to keep a channel-keyed map of typers, but
      // nothing ever rendered one for a channel you were not looking at.
      case "channel.archive": {
        const remaining = (channels ?? []).filter((channel) => channel.id !== ev.channelId);
        setChannels(remaining);
        if (activeChannelIdRef.current === ev.channelId) {
          const next = remaining[0] ?? null;
          setActiveChannelId(next?.id ?? null);
          navigate(
            next ? workspaceChannelHref(company.slug, next.id) : `/c/${company.slug}/workspace`,
            {
              replace: true,
            },
          );
        }
        return;
      }
      default:
        return;
    }
  }

  // ──────────────── Channel selection + history ────────────────────────

  const activeMessageHistoryLoaded = activeChannelId
    ? messageHistoryLoaded[activeChannelId] === true
    : false;

  React.useEffect(() => {
    if (!activeChannelId) return;
    if (activeMessageHistoryLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await workspaceApi.listMessages(company.id, activeChannelId, {
          limit: WORKSPACE_MESSAGE_PAGE_SIZE,
        });
        if (cancelled) return;
        setMessages((prev) => ({
          ...prev,
          [activeChannelId]: mergeWorkspaceMessages(list, prev[activeChannelId] ?? []),
        }));
        setHasOlderMessages((prev) => ({
          ...prev,
          [activeChannelId]: list.length === WORKSPACE_MESSAGE_PAGE_SIZE,
        }));
        setMessageHistoryLoaded((prev) => ({
          ...prev,
          [activeChannelId]: true,
        }));
        setMessageErrors((prev) => ({ ...prev, [activeChannelId]: null }));
      } catch (e) {
        if (cancelled) return;
        setMessageErrors((prev) => ({
          ...prev,
          [activeChannelId]: errorMessage(e, "Could not load the messages"),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, activeMessageHistoryLoaded, company.id]);

  async function loadOlderChannelMessages(channelId: string): Promise<boolean> {
    if (loadingOlderChannelIdsRef.current.has(channelId)) return false;
    if (!hasOlderMessages[channelId]) return false;
    const current = messages[channelId];
    if (!current || current.length === 0) return false;

    loadingOlderChannelIdsRef.current.add(channelId);
    setLoadingOlderMessages((prev) => ({ ...prev, [channelId]: true }));
    setMessageErrors((prev) => ({ ...prev, [channelId]: null }));
    try {
      const list = await workspaceApi.listMessages(company.id, channelId, {
        before: current[0].createdAt,
        limit: WORKSPACE_MESSAGE_PAGE_SIZE,
      });
      setMessages((prev) => ({
        ...prev,
        [channelId]: mergeWorkspaceMessages(list, prev[channelId] ?? []),
      }));
      setHasOlderMessages((prev) => ({
        ...prev,
        [channelId]: list.length === WORKSPACE_MESSAGE_PAGE_SIZE,
      }));
      return list.length > 0;
    } catch (e) {
      setMessageErrors((prev) => ({
        ...prev,
        [channelId]: errorMessage(e, "Could not load earlier messages"),
      }));
      return false;
    } finally {
      loadingOlderChannelIdsRef.current.delete(channelId);
      setLoadingOlderMessages((prev) => ({ ...prev, [channelId]: false }));
    }
  }

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

  function selectChannel(id: string) {
    setActiveChannelId(id);
    navigate(workspaceChannelHref(company.slug, id));
  }

  async function archiveWorkspaceChannel(channelId: string) {
    try {
      await workspaceApi.archiveChannel(company.id, channelId);
      const remaining = (channels ?? []).filter((channel) => channel.id !== channelId);
      setChannels(remaining);
      if (activeChannelIdRef.current === channelId) {
        const next = remaining[0] ?? null;
        setActiveChannelId(next?.id ?? null);
        navigate(
          next ? workspaceChannelHref(company.slug, next.id) : `/c/${company.slug}/workspace`,
          { replace: true },
        );
      }
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t archive the conversation" });
    }
  }

  const activeChannel = channels?.find((c) => c.id === activeChannelId) ?? null;

  // ──────────────── Layout ─────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-1">
      <WorkspaceSidebar
        companySlug={company.slug}
        me={me}
        channels={channels}
        activeChannelId={activeChannelId}
        onlineUsers={onlineUsers}
        onSelect={selectChannel}
        onNewChannel={() => setShowNewChannel(true)}
        onNewDM={() => setShowNewDM(true)}
        onArchive={archiveWorkspaceChannel}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-slate-950">
        {loadError ? (
          <FormError message={loadError} className="m-6" />
        ) : channels === null ? (
          <WorkspaceLoading label="Loading workspace…" />
        ) : activeChannel ? (
          <ChannelView
            key={activeChannel.id}
            company={company}
            me={me}
            channel={activeChannel}
            messages={
              messageHistoryLoaded[activeChannel.id] ? (messages[activeChannel.id] ?? []) : null
            }
            messagesError={messageErrors[activeChannel.id] ?? null}
            hasOlderMessages={hasOlderMessages[activeChannel.id] ?? false}
            loadingOlderMessages={loadingOlderMessages[activeChannel.id] ?? false}
            onLoadOlderMessages={() => loadOlderChannelMessages(activeChannel.id)}
            directory={directory}
            mentionables={mentionables}
            onAttachmentUrl={(id) => workspaceApi.attachmentUrl(company.id, id)}
            onChannelUpdated={(updated) => {
              setChannels((prev) =>
                prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
              );
            }}
            onArchive={() => archiveWorkspaceChannel(activeChannel.id)}
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
        // Only real channels count toward the plan cap — the channels state
        // still holds DM rows (kind "dm"), which are never limited.
        channelCount={(channels ?? []).filter((c) => c.kind !== "dm").length}
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
  companySlug,
  me,
  channels,
  activeChannelId,
  onlineUsers,
  onSelect,
  onNewChannel,
  onNewDM,
  onArchive,
}: {
  companySlug: string;
  me: Me;
  channels: WorkspaceChannel[] | null;
  activeChannelId: string | null;
  onlineUsers: Set<string>;
  onSelect: (id: string) => void;
  onNewChannel: () => void;
  onNewDM: () => void;
  onArchive: (id: string) => void;
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
      {channels === null ? (
        <div
          className="flex items-center gap-2 px-4 py-4 text-xs text-slate-500 dark:text-slate-400"
          role="status"
        >
          <Spinner size={14} />
          Loading channels…
        </div>
      ) : (
        <>
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
                  action={
                    <button
                      onClick={() => onArchive(c.id)}
                      className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                      title="Archive direct message"
                      aria-label={`Archive direct message with ${other?.name ?? "former employee"}`}
                    >
                      <Archive size={12} />
                    </button>
                  }
                />
              );
            })}
            {dms.length === 0 && <EmptyHint label="No direct messages." />}
          </SidebarSection>
        </>
      )}
      <nav className="mt-auto border-t border-slate-100 p-2 dark:border-slate-800">
        <SidebarLink
          to={`/c/${companySlug}/workspace/integrations`}
          icon={<Plug size={14} />}
          label="Integrations"
        />
      </nav>
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
          <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
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
  action,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  unread?: number;
  right?: React.ReactNode;
  action?: React.ReactNode;
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
    <div
      className={
        "group flex w-full items-center rounded-md text-sm " +
        (active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          : unread && unread > 0
            ? "font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800"
            : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="text-slate-400 dark:text-slate-500">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {unreadBadge}
      </button>
      {action && <span className="pr-1">{action}</span>}
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return <div className="px-2 py-1 text-xs italic text-slate-400 dark:text-slate-500">{label}</div>;
}

function dmCounterpart(c: WorkspaceChannel, meId: string): WorkspaceAuthor | null {
  return c.members.find((m) => !(m.kind === "user" && "id" in m && m.id === meId)) ?? null;
}

// ────────────────────────── Channel view ────────────────────────────────

function ChannelView({
  company,
  me,
  channel,
  messages,
  messagesError,
  hasOlderMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  directory,
  mentionables,
  onAttachmentUrl,
  onChannelUpdated,
  onArchive,
}: {
  company: Company;
  me: Me;
  channel: WorkspaceChannel;
  messages: WorkspaceMessage[] | null;
  messagesError: string | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => Promise<boolean>;
  directory: WorkspaceDirectory | null;
  mentionables: Mentionable[];
  onAttachmentUrl: (id: string) => string;
  onChannelUpdated: (c: WorkspaceChannel) => void;
  onArchive: () => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = React.useRef<string | null>(null);
  const loadingOlderLocallyRef = React.useRef(false);
  const scrollPreservationRef = React.useRef<{
    firstMessageId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [showMembers, setShowMembers] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null);
  const typers = useChannelTyping(channel.id, me.id);

  React.useLayoutEffect(() => {
    if (messages === null) return;
    const viewport = scrollRef.current;
    if (!viewport) return;

    const preservation = scrollPreservationRef.current;
    if (preservation) {
      const firstMessageId = messages[0]?.id ?? null;
      if (firstMessageId !== preservation.firstMessageId) {
        viewport.scrollTop =
          viewport.scrollHeight - preservation.scrollHeight + preservation.scrollTop;
        scrollPreservationRef.current = null;
      } else {
        // A realtime message can arrive at the bottom while an older page is
        // in flight. Move the baseline forward so the later prepend only
        // compensates for rows inserted above the reader.
        preservation.scrollHeight = viewport.scrollHeight;
        preservation.scrollTop = viewport.scrollTop;
      }
      lastMessageIdRef.current = messages.at(-1)?.id ?? null;
      return;
    }

    const lastMessageId = messages.at(-1)?.id ?? null;
    if (
      lastMessageIdRef.current === null ||
      (lastMessageId !== null && lastMessageId !== lastMessageIdRef.current)
    ) {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
    lastMessageIdRef.current = lastMessageId;
  }, [messages]);

  async function loadOlderFromScroll(viewport: HTMLDivElement) {
    if (loadingOlderLocallyRef.current || loadingOlderMessages) return;
    loadingOlderLocallyRef.current = true;
    scrollPreservationRef.current = {
      firstMessageId: messages?.[0]?.id ?? "",
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    };
    try {
      const loaded = await onLoadOlderMessages();
      if (!loaded) scrollPreservationRef.current = null;
    } finally {
      window.requestAnimationFrame(() => {
        loadingOlderLocallyRef.current = false;
      });
    }
  }

  // Cancel any in-progress edit when switching channels.
  React.useEffect(() => {
    setEditingMessageId(null);
  }, [channel.id]);

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
        <div className="ml-auto flex items-center gap-1">
          {channel.kind === "dm" && (
            <button
              onClick={onArchive}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              title="Archive direct message"
            >
              <Archive size={12} /> Archive
            </button>
          )}
          {channel.kind !== "dm" && (
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              title="Channel settings"
            >
              <SettingsIcon size={12} /> Settings
            </button>
          )}
          {channel.kind === "dm" && (
            <button
              onClick={() => setShowMembers(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <AtSign size={12} /> {channel.members.length} member
              {channel.members.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onScroll={(event) => {
          if (
            messages !== null &&
            messages.length > 0 &&
            hasOlderMessages &&
            event.currentTarget.scrollTop <= 96
          ) {
            void loadOlderFromScroll(event.currentTarget);
          }
        }}
      >
        {messages === null && messagesError ? (
          <FormError message={messagesError} />
        ) : messages === null ? (
          <WorkspaceLoading label="Loading messages…" />
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
          <>
            {hasOlderMessages && (
              <div
                className="flex h-8 items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                role={loadingOlderMessages ? "status" : undefined}
              >
                {loadingOlderMessages && (
                  <>
                    <Spinner size={14} />
                    Loading earlier messages…
                  </>
                )}
              </div>
            )}
            <FormError message={messagesError} className="mb-2" />
            <MessageList
              messages={messages}
              meId={me.id}
              mentionables={mentionables}
              onAttachmentUrl={onAttachmentUrl}
              editingMessageId={editingMessageId}
              onSetEditing={setEditingMessageId}
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
          </>
        )}
        <div ref={endRef} />
      </div>

      {typers.length > 0 && (
        <div className="shrink-0 border-t border-slate-100 px-6 py-1.5 dark:border-slate-800">
          <TypingPill typers={typers} />
        </div>
      )}

      <ChannelComposer
        company={company}
        channel={{
          id: channel.id,
          kind: channel.kind,
          label: channel.kind === "dm" ? "your recipient" : `#${channel.name ?? "channel"}`,
        }}
        mentionables={mentionables}
        editLast={{
          messages: messages ?? [],
          meId: me.id,
          onEdit: setEditingMessageId,
        }}
        className="shrink-0 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950"
      />

      {channel.kind === "dm" && (
        <MembersModal
          open={showMembers}
          onClose={() => setShowMembers(false)}
          channel={channel}
          directory={directory}
          company={company}
          onChanged={onChannelUpdated}
        />
      )}
      {channel.kind !== "dm" && (
        <ChannelSettingsModal
          open={showSettings}
          onClose={() => setShowSettings(false)}
          channel={channel}
          directory={directory}
          company={company}
          onChanged={onChannelUpdated}
          onArchive={onArchive}
        />
      )}
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
  if (channel.kind === "private") return <Lock size={16} className="text-slate-400" />;
  return <Hash size={16} className="text-slate-400" />;
}

function channelTitle(c: WorkspaceChannel, meId: string): string {
  if (c.kind === "dm") {
    const other = dmCounterpart(c, meId);
    return other?.name ?? "Direct message";
  }
  return c.name ?? "channel";
}

function WorkspaceLoading({ label }: { label: string }) {
  return (
    <div
      className="flex h-full flex-1 items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400"
      role="status"
      aria-live="polite"
    >
      <Spinner size={18} />
      {label}
    </div>
  );
}

function EmptyWorkspace({ onCreate, onStartDm }: { onCreate: () => void; onStartDm: () => void }) {
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
  channelCount,
  onClose,
  onCreated,
}: {
  open: boolean;
  company: Company;
  directory: WorkspaceDirectory | null;
  /** Non-DM channels only — DMs never count toward the plan cap. */
  channelCount: number;
  onClose: () => void;
  onCreated: (c: WorkspaceChannel) => void;
}) {
  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [kind, setKind] = React.useState<"public" | "private">("public");
  const [pickedUsers, setPickedUsers] = React.useState<Set<string>>(new Set());
  const [pickedEmps, setPickedEmps] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setName("");
      setTopic("");
      setKind("public");
      setPickedUsers(new Set());
      setPickedEmps(new Set());
      setError(null);
    }
  }, [open]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
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
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  const maxChannels = company.entitlements.maxChannels;
  const atChannelCap = maxChannels !== null && channelCount >= maxChannels;

  return (
    <Modal open={open} onClose={onClose} title="Create a channel">
      <div className="space-y-4">
        {/* Plan-limit upsell (M56). Informational only — creation stays
          enabled and the server's 402 surfaces in the modal's FormError. */}
        {atChannelCap && (
          <PlanLimitBanner
            message={`Your Free plan includes ${maxChannels} Channel${maxChannels === 1 ? "" : "s"}.`}
            company={company}
          />
        )}
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
        <FormError message={error} />
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
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setQ("");
      setError(null);
    }
  }, [open]);

  async function openWith(target: { targetUserId: string } | { targetEmployeeId: string }) {
    setError(null);
    try {
      const ch = await workspaceApi.openDm(company.id, target);
      onOpened(ch);
    } catch (e) {
      setError(errorMessage(e));
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
        <FormError message={error} />
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
            <div className="py-8 text-center text-sm text-slate-400">No matches.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ChannelSettingsModal({
  open,
  onClose,
  channel,
  directory,
  company,
  onChanged,
  onArchive,
}: {
  open: boolean;
  onClose: () => void;
  channel: WorkspaceChannel;
  directory: WorkspaceDirectory | null;
  company: Company;
  onChanged: (c: WorkspaceChannel) => void;
  onArchive: () => void;
}) {
  const [name, setName] = React.useState(channel.name ?? "");
  const [topic, setTopic] = React.useState(channel.topic);
  const [saving, setSaving] = React.useState(false);
  const [webhook, setWebhook] = React.useState<WorkspaceChannelWebhookSettings | null>(null);
  const [loadingWebhook, setLoadingWebhook] = React.useState(false);
  const [changingWebhook, setChangingWebhook] = React.useState(false);
  const [generalError, setGeneralError] = React.useState<string | null>(null);
  const [webhookError, setWebhookError] = React.useState<string | null>(null);
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);
  const dialog = useDialog();

  React.useEffect(() => {
    if (!open) return;
    setName(channel.name ?? "");
    setTopic(channel.topic);
    setWebhook(null);
    setGeneralError(null);
    setWebhookError(null);
    setCopyNotice(null);
    setLoadingWebhook(true);
    workspaceApi
      .getChannelWebhook(company.id, channel.id)
      .then(setWebhook)
      .catch((error: unknown) => {
        setWebhookError(errorMessage(error, "Could not load webhook settings"));
      })
      .finally(() => setLoadingWebhook(false));
  }, [channel.id, channel.name, channel.topic, company.id, open]);

  async function saveGeneral() {
    if (!name.trim()) return;
    setSaving(true);
    setGeneralError(null);
    try {
      const updated = await workspaceApi.updateChannel(company.id, channel.id, {
        name: name.trim(),
        topic: topic.trim(),
      });
      onChanged(updated);
    } catch (error) {
      setGeneralError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function changeWebhook(enabled: boolean, regenerate = false) {
    setChangingWebhook(true);
    setWebhookError(null);
    setCopyNotice(null);
    try {
      const updated = await workspaceApi.updateChannelWebhook(company.id, channel.id, {
        enabled,
        regenerate,
      });
      setWebhook(updated);
      if (regenerate && updated.enabled && updated.url) {
        setCopyNotice("Webhook URL regenerated. The previous URL no longer works.");
      }
    } catch (error) {
      setWebhookError(errorMessage(error));
    } finally {
      setChangingWebhook(false);
    }
  }

  async function archive() {
    const ok = await dialog.confirm({
      title: `Archive #${channel.name ?? "channel"}?`,
      message:
        "The channel will leave the sidebar and its incoming webhook will stop immediately. Message history is preserved.",
      confirmLabel: "Archive",
      variant: "danger",
    });
    if (!ok) return;
    onClose();
    onArchive();
  }

  return (
    <Modal open={open} onClose={onClose} title="Channel settings" size="lg">
      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">General</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Change how this channel appears in Workspace.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Topic
            </label>
            <textarea
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              maxLength={280}
              rows={2}
              className="w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <FormError message={generalError} />
          <div className="flex justify-end">
            <Button disabled={saving || !name.trim()} onClick={saveGeneral}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </section>

        <section className="space-y-3 border-t border-slate-100 pt-5 dark:border-slate-800">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Members</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                See who is in this channel and add Members or AI employees.
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {channel.members.length} member{channel.members.length === 1 ? "" : "s"}
            </span>
          </div>
          <ChannelMembersSettings
            channel={channel}
            directory={directory}
            company={company}
            onChanged={onChanged}
          />
        </section>

        <section className="space-y-3 border-t border-slate-100 pt-5 dark:border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Incoming webhook
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Use services that already send Slack incoming webhooks. JSON text, blocks, and
              attachments become messages in this channel.
            </p>
          </div>
          <FormError message={webhookError} />
          {loadingWebhook ? (
            <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
              <Spinner size={14} /> Loading webhook settings…
            </div>
          ) : webhook?.enabled && webhook.url ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
                <div className="mb-2 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                  Webhook enabled
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700 dark:bg-slate-950 dark:text-slate-200">
                    {webhook.url}
                  </code>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      setWebhookError(null);
                      setCopyNotice(null);
                      const copied = await copyToClipboard(webhook.url!);
                      if (copied) setCopyNotice("Webhook URL copied");
                      else setWebhookError("Could not access clipboard");
                    }}
                  >
                    <Copy size={13} /> Copy
                  </Button>
                </div>
              </div>
              <FormSuccess message={copyNotice} />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                The URL is a credential. Keep it secret. This URL always posts to this channel, even
                if a Slack payload names a different one.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={changingWebhook}
                  onClick={() => changeWebhook(true, true)}
                >
                  <RefreshCw size={13} /> Regenerate URL
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={changingWebhook}
                  onClick={() => changeWebhook(false)}
                >
                  Disable
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Enabling creates a unique Slack-compatible URL for this channel.
              </p>
              <Button
                size="sm"
                disabled={changingWebhook || loadingWebhook}
                onClick={() => changeWebhook(true)}
              >
                Enable incoming webhook
              </Button>
            </div>
          )}
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5 dark:border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Archive channel
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Hide the channel and disable its webhook while preserving history.
            </p>
          </div>
          <Button variant="danger" onClick={archive}>
            <Archive size={14} /> Archive
          </Button>
        </section>
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
  return (
    <Modal open={open} onClose={onClose} title="Members">
      <div className="space-y-4">
        <ChannelMembersSettings
          channel={channel}
          directory={directory}
          company={company}
          onChanged={onChanged}
        />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChannelMembersSettings({
  channel,
  directory,
  company,
  onChanged,
}: {
  channel: WorkspaceChannel;
  directory: WorkspaceDirectory | null;
  company: Company;
  onChanged: (c: WorkspaceChannel) => void;
}) {
  const [adding, setAdding] = React.useState<
    null | { kind: "user"; id: string } | { kind: "ai"; id: string }
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  async function add(target: "user" | "ai", id: string) {
    setAdding({ kind: target, id });
    setError(null);
    try {
      const updated = await workspaceApi.addMembers(company.id, channel.id, {
        userIds: target === "user" ? [id] : [],
        employeeIds: target === "ai" ? [id] : [],
      });
      onChanged(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(null);
    }
  }

  const memberUserIds = new Set(
    channel.members
      .filter((member) => member.kind === "user")
      .map((member) => (member as WorkspaceAuthor & { id: string }).id),
  );
  const memberEmployeeIds = new Set(
    channel.members
      .filter((member) => member.kind === "ai")
      .map((member) => (member as WorkspaceAuthor & { id: string }).id),
  );
  const addableUsers = (directory?.members ?? []).filter((user) => !memberUserIds.has(user.id));
  const addableEmployees = (directory?.employees ?? []).filter(
    (employee) => !memberEmployeeIds.has(employee.id),
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          In this channel
        </div>
        <div className="space-y-1">
          {channel.members.map((member) => (
            <div
              key={`${member.kind}-${"id" in member ? member.id : "system"}`}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
            >
              {member.kind === "ai" ? (
                <Bot size={14} className="text-indigo-500" />
              ) : (
                <UserIcon size={14} className="text-slate-400" />
              )}
              <span className="font-medium text-slate-900 dark:text-slate-100">{member.name}</span>
              {member.kind === "ai" && (
                <span className="rounded bg-indigo-50 px-1 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                  AI
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      {(addableUsers.length > 0 || addableEmployees.length > 0) && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Add people
          </div>
          <div className="space-y-1">
            {addableUsers.map((user) => (
              <div key={user.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
                <UserIcon size={14} className="text-slate-400" />
                <span className="font-medium">{user.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={adding?.kind === "user" && adding.id === user.id}
                  className="ml-auto"
                  onClick={() => add("user", user.id)}
                >
                  Add
                </Button>
              </div>
            ))}
            {addableEmployees.map((employee) => (
              <div
                key={employee.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
              >
                <Bot size={14} className="text-indigo-500" />
                <span className="font-medium">{employee.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={adding?.kind === "ai" && adding.id === employee.id}
                  className="ml-auto"
                  onClick={() => add("ai", employee.id)}
                >
                  Add
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
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
          {selectedUsers.has(u.id) && <CheckCheck size={14} className="ml-auto text-indigo-500" />}
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
          {selectedEmps.has(e.id) && <CheckCheck size={14} className="ml-auto text-indigo-500" />}
        </button>
      ))}
    </div>
  );
}
