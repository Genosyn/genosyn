import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AtSign,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  Company,
  Notification,
  NotificationKind,
} from "../lib/api";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "./ui/Avatar";
import { useCompanySocketSubscription } from "./CompanySocket";

/**
 * Bell + popover panel mounted in the top bar. Reads the per-user feed
 * exposed at `/api/companies/:cid/notifications` and patches state in
 * place when the server pushes `notification.new` / `notification.read`
 * frames over the shared company WebSocket. The 15-second poll is kept
 * as a backstop in case the socket missed a frame during reconnect.
 */
export function NotificationsPanel({
  company,
  meId,
}: {
  company: Company;
  meId: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [count, setCount] = React.useState(0);
  const [items, setItems] = React.useState<Notification[]>([]);
  const [loading, setLoading] = React.useState(false);

  const refreshCount = React.useCallback(async () => {
    try {
      const r = await api.get<{ count: number }>(
        `/api/companies/${company.id}/notifications/unread-count`,
      );
      setCount(r.count);
    } catch {
      // Stale count is preferable to a UI error toast — the panel will
      // recompute the next time the user opens it.
    }
  }, [company.id]);

  const refreshList = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ notifications: Notification[] }>(
        `/api/companies/${company.id}/notifications?limit=30`,
      );
      setItems(r.notifications);
    } finally {
      setLoading(false);
    }
  }, [company.id]);

  React.useEffect(() => {
    refreshCount();
    const interval = window.setInterval(refreshCount, 15_000);
    const onFocus = () => refreshCount();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshCount]);

  React.useEffect(() => {
    if (open) refreshList();
  }, [open, refreshList]);

  // Patch state in place from live WS frames. The hub broadcasts to every
  // socket in the company room, so each client filters on `userId` to
  // ignore frames that target a different teammate.
  useCompanySocketSubscription((ev) => {
    if (ev.type === "notification.new") {
      if (ev.userId !== meId) return;
      setItems((rows) => {
        if (rows.some((r) => r.id === ev.notification.id)) return rows;
        return [ev.notification, ...rows].slice(0, 50);
      });
      setCount((c) => c + 1);
    } else if (ev.type === "notification.read") {
      if (ev.userId !== meId) return;
      const ids = new Set(ev.notificationIds);
      const now = new Date().toISOString();
      setItems((rows) =>
        rows.map((r) =>
          ids.has(r.id) && !r.readAt ? { ...r, readAt: now } : r,
        ),
      );
      // Server is authoritative on the unread count. Re-poll after a read
      // frame so we don't double-decrement under StrictMode's twice-invoked
      // setter or miss a frame that read more rows than we currently hold.
      refreshCount();
    }
  });

  async function handleClick(n: Notification) {
    setOpen(false);
    if (!n.readAt) {
      try {
        await api.post(
          `/api/companies/${company.id}/notifications/mark-read`,
          { notificationId: n.id },
        );
        setItems((rows) =>
          rows.map((r) =>
            r.id === n.id ? { ...r, readAt: new Date().toISOString() } : r,
          ),
        );
        setCount((c) => Math.max(0, c - 1));
      } catch {
        // Navigation should win even if the read flag failed to persist.
      }
    }
    if (n.link) navigate(n.link);
  }

  async function handleMarkAll() {
    try {
      await api.post(
        `/api/companies/${company.id}/notifications/mark-all-read`,
      );
      const now = new Date().toISOString();
      setItems((rows) =>
        rows.map((r) => (r.readAt ? r : { ...r, readAt: now })),
      );
      setCount(0);
    } catch {
      // Same logic as above — surface nothing; the next refresh tells truth.
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={count > 0 ? `${count} unread` : "Notifications"}
        aria-label="Notifications"
      >
        <Bell size={16} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white tabular-nums">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-20 mt-2 w-[22rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Notifications
                </span>
                {count > 0 && (
                  <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
                    {count}
                  </span>
                )}
              </div>
              {items.some((i) => !i.readAt) && (
                <button
                  onClick={handleMarkAll}
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[26rem] overflow-y-auto">
              {loading && items.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-400 dark:text-slate-500">
                  Loading…
                </div>
              ) : items.length === 0 ? (
                <EmptyState />
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((n) => (
                    <li key={n.id}>
                      <NotificationRow
                        notification={n}
                        company={company}
                        onClick={() => handleClick(n)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <CheckCircle2
        size={20}
        className="text-emerald-500 dark:text-emerald-400"
      />
      <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
        You&apos;re all caught up
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        New mentions, reviews, and approvals show up here.
      </div>
    </div>
  );
}

function NotificationRow({
  notification: n,
  company,
  onClick,
}: {
  notification: Notification;
  company: Company;
  onClick: () => void;
}) {
  const unread = !n.readAt;
  const tone = KIND_TONE[n.kind] ?? KIND_TONE.mention;

  // Prefer the actor avatar; fall back to a kind-tinted icon square so the
  // row isn't visually empty when the actor has no picture / is "system".
  const actor = n.actor;
  const avatarSrc = actor
    ? actor.kind === "user" && actor.id
      ? memberAvatarUrl(company.id, actor.id, actor.avatarKey)
      : actor.kind === "ai" && actor.id
        ? employeeAvatarUrl(company.id, actor.id, actor.avatarKey)
        : null
    : null;

  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors " +
        (unread
          ? "bg-indigo-50/40 hover:bg-indigo-50 dark:bg-indigo-500/[0.06] dark:hover:bg-indigo-500/10"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
      }
    >
      <div className="relative">
        {actor ? (
          <Avatar
            name={actor.name}
            src={avatarSrc}
            kind={actor.kind === "ai" ? "ai" : "human"}
            size="md"
          />
        ) : (
          <div
            className={
              "flex h-8 w-8 items-center justify-center rounded-full " +
              tone.iconBg
            }
          >
            <KindIcon kind={n.kind} className={tone.iconFg} />
          </div>
        )}
        <span
          className={
            "absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white dark:ring-slate-900 " +
            tone.iconBg
          }
        >
          <KindIcon kind={n.kind} size={10} className={tone.iconFg} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {n.title}
          </div>
          {unread && (
            <span
              className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-500"
              aria-label="Unread"
            />
          )}
        </div>
        {n.body && (
          <div className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
            {n.body}
          </div>
        )}
        <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          {formatRelative(n.createdAt)}
        </div>
      </div>
    </button>
  );
}

function KindIcon({
  kind,
  size = 14,
  className,
}: {
  kind: NotificationKind;
  size?: number;
  className?: string;
}) {
  switch (kind) {
    case "mention":
      return <AtSign size={size} className={className} />;
    case "todo_review_requested":
      return <ClipboardCheck size={size} className={className} />;
    case "approval_pending":
      return <ShieldCheck size={size} className={className} />;
  }
}

const KIND_TONE: Record<
  NotificationKind,
  { iconBg: string; iconFg: string }
> = {
  mention: {
    iconBg: "bg-rose-100 dark:bg-rose-500/15",
    iconFg: "text-rose-600 dark:text-rose-300",
  },
  todo_review_requested: {
    iconBg: "bg-violet-100 dark:bg-violet-500/15",
    iconFg: "text-violet-600 dark:text-violet-300",
  },
  approval_pending: {
    iconBg: "bg-amber-100 dark:bg-amber-500/15",
    iconFg: "text-amber-600 dark:text-amber-300",
  },
};

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}
