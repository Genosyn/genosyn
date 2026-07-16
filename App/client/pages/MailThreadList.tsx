import React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import {
  MailThread,
  MailThreadView,
  ThreadActionName,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailOutletCtx } from "./MailLayout";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * The thread list — inbox / starred / sent / drafts / all / spam / trash,
 * plus user-label views, chosen via query params so the folder rail stays
 * plain links. Rows act like a mail client: unread weight, star toggle,
 * hover actions that write through to Gmail.
 */

const VIEW_TITLES: Record<MailThreadView, string> = {
  inbox: "Inbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  all: "All mail",
  spam: "Spam",
  trash: "Trash",
};

export default function MailThreadList() {
  const { company, account, labels, changeTick } =
    useOutletContext<MailOutletCtx>();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") ?? "inbox") as MailThreadView;
  const label = params.get("label") ?? "";
  const q = params.get("q") ?? "";

  const [threads, setThreads] = React.useState<MailThread[] | null>(null);
  const [nextBefore, setNextBefore] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [search, setSearch] = React.useState(q);
  const [syncing, setSyncing] = React.useState(false);

  const load = React.useCallback(
    async (append: boolean, before?: string) => {
      const res = await mailApi.threads(company.id, account.id, {
        view,
        label: label || undefined,
        q: q || undefined,
        before,
        limit: 50,
      });
      setThreads((prev) =>
        append && prev ? [...prev, ...res.threads] : res.threads,
      );
      setNextBefore(res.nextBefore);
    },
    [company.id, account.id, view, label, q],
  );

  React.useEffect(() => {
    let cancelled = false;
    setThreads(null);
    load(false).catch((err) => {
      if (!cancelled) toast((err as Error).message, "error");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Live refresh (sync pass / handover finished / action elsewhere).
  React.useEffect(() => {
    if (changeTick === 0) return;
    load(false).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick]);

  // Keep the box in sync when the URL's ?q= changes underneath us — e.g.
  // navigating to a folder link drops the param, and the box should clear
  // rather than keep showing a query that is no longer applied.
  React.useEffect(() => {
    setSearch(q);
  }, [q]);

  // Debounced search → ?q=
  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search.trim()) next.set("q", search.trim());
      else next.delete("q");
      if ((next.get("q") ?? "") !== (params.get("q") ?? "")) {
        setParams(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const act = async (thread: MailThread, action: ThreadActionName) => {
    try {
      await mailApi.threadAction(company.id, thread.id, action);
      await load(false);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      await mailApi.syncNow(company.id, account.id);
      toast("Sync started", "info");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setTimeout(() => setSyncing(false), 1500);
    }
  };

  const labelName = label
    ? labels.find((l) => l.gmailLabelId === label)?.name ?? label
    : null;
  const title = labelName ?? VIEW_TITLES[view] ?? "Inbox";

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col px-4 py-4 sm:px-6">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h1>
        <button
          onClick={syncNow}
          title="Sync now"
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
        >
          <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} />
        </button>
        <div className="relative ml-auto w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search mail…"
            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>
      </div>

      {threads === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : threads.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            title={q ? "No matching threads" : `Nothing in ${title}`}
            description={
              q
                ? "Try a different search — it matches senders, subjects, and snippets."
                : account.backfilledAt
                  ? "New mail shows up here within a minute of arriving."
                  : "The first sync is still importing your mailbox."
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                companySlug={company.slug}
                view={view}
                onAction={act}
              />
            ))}
          </ul>
          {nextBefore && (
            <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800">
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    await load(true, nextBefore);
                  } catch (err) {
                    toast((err as Error).message, "error");
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                {loadingMore ? <Spinner size={14} /> : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  companySlug,
  view,
  onAction,
}: {
  thread: MailThread;
  companySlug: string;
  view: MailThreadView;
  onAction: (t: MailThread, action: ThreadActionName) => Promise<void>;
}) {
  const starred = thread.labelIds.includes("STARRED");
  const inTrash = thread.labelIds.includes("TRASH");
  const inInbox = thread.labelIds.includes("INBOX");
  return (
    <li className="group relative">
      <Link
        to={`/c/${companySlug}/mail/t/${thread.id}`}
        className={clsx(
          "flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-900",
          thread.unread && "bg-indigo-50/30 dark:bg-indigo-500/5",
        )}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            void onAction(thread, starred ? "unstar" : "star");
          }}
          title={starred ? "Unstar" : "Star"}
          className={clsx(
            "shrink-0",
            starred
              ? "text-amber-400"
              : "text-slate-300 hover:text-slate-400 dark:text-slate-600",
          )}
        >
          <Star size={15} fill={starred ? "currentColor" : "none"} />
        </button>
        <span
          className={clsx(
            "w-40 shrink-0 truncate text-sm",
            thread.unread
              ? "font-semibold text-slate-900 dark:text-slate-100"
              : "text-slate-600 dark:text-slate-400",
          )}
        >
          {thread.participants || "(unknown sender)"}
          {thread.messageCount > 1 && (
            <span className="ml-1 text-xs font-normal text-slate-400">
              {thread.messageCount}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span
            className={clsx(
              thread.unread
                ? "font-semibold text-slate-900 dark:text-slate-100"
                : "text-slate-700 dark:text-slate-300",
            )}
          >
            {thread.subject || "(no subject)"}
          </span>
          {thread.snippet && (
            <span className="text-slate-400 dark:text-slate-500">
              {" — "}
              {thread.snippet}
            </span>
          )}
        </span>
        {thread.hasAttachments && (
          <Paperclip size={13} className="shrink-0 text-slate-400" />
        )}
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-400">
          {shortMailDate(thread.lastMessageAt)}
        </span>
      </Link>
      {/* Hover actions — float over the date column. */}
      <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-slate-200 bg-white px-1 py-0.5 shadow-sm group-hover:flex dark:border-slate-700 dark:bg-slate-900">
        <RowAction
          title={thread.unread ? "Mark read" : "Mark unread"}
          icon={thread.unread ? <MailOpen size={14} /> : <Mail size={14} />}
          onClick={() => onAction(thread, thread.unread ? "markRead" : "markUnread")}
        />
        {view !== "trash" && (
          <RowAction
            title={inInbox ? "Archive" : "Move to inbox"}
            icon={inInbox ? <Archive size={14} /> : <ArchiveRestore size={14} />}
            onClick={() => onAction(thread, inInbox ? "archive" : "moveToInbox")}
          />
        )}
        <RowAction
          title={inTrash ? "Restore from trash" : "Move to trash"}
          icon={inTrash ? <ArchiveRestore size={14} /> : <Trash2 size={14} />}
          onClick={() => onAction(thread, inTrash ? "untrash" : "trash")}
        />
      </div>
    </li>
  );
}

function RowAction({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.preventDefault();
        void onClick();
      }}
      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      {icon}
    </button>
  );
}
