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
  X,
} from "lucide-react";
import {
  MailThread,
  MailThreadView,
  ThreadActionName,
  mailSyncDate,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailOutletCtx } from "./MailLayout";
import { MailDraftReview } from "./MailDraftReview";
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
  const { company, account, labels, changeTick, syncing, syncNow } =
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

  // Monotonic request id: an all-mail body search can take a while, and a
  // response that resolves after a newer request (folder switch, cleared
  // box) must not clobber the fresher list.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(
    async (append: boolean, before?: string) => {
      const seq = ++loadSeq.current;
      const res = await mailApi.threads(company.id, account.id, {
        view,
        label: label || undefined,
        q: q || undefined,
        before,
        limit: 50,
      });
      if (seq !== loadSeq.current) return;
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

  const labelName = label
    ? labels.find((l) => l.gmailLabelId === label)?.name ?? label
    : null;
  const searching = q.trim().length > 0;
  const title = searching ? "Search" : labelName ?? VIEW_TITLES[view] ?? "Inbox";
  const highlightTerms = React.useMemo(
    () => (searching ? extractHighlightTerms(q) : []),
    [searching, q],
  );
  const searchScopeLabel = React.useMemo(
    () => (searching ? describeSearchScope(q) : ""),
    [searching, q],
  );

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h1>
          <div
            className="text-xs text-slate-500 dark:text-slate-400"
            title={
              account.lastSyncAt
                ? new Date(account.lastSyncAt).toLocaleString()
                : undefined
            }
          >
            {account.lastSyncAt
              ? `Last synced ${mailSyncDate(account.lastSyncAt)}`
              : "Not synced yet"}
          </div>
        </div>
        <button
          onClick={() => void syncNow()}
          disabled={syncing || account.status === "paused"}
          title={account.status === "paused" ? "Resume sync in settings" : "Sync now"}
          aria-busy={syncing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} />
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <SearchBox value={search} onChange={setSearch} />
      </div>
      {searching && (
        <div className="mb-2 flex items-baseline gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {searchScopeLabel}
            {threads !== null && (
              <>
                {" · "}
                <span className="tabular-nums">
                  {threads.length}
                  {nextBefore ? "+" : ""}
                </span>{" "}
                {threads.length === 1 && !nextBefore ? "result" : "results"}
              </>
            )}
          </span>
          <span className="text-slate-400 dark:text-slate-500">
            Narrow with from:, in:archive, label:, before:2026-01-01…
          </span>
        </div>
      )}

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
                ? "It searches every message body across all mail. Try fewer terms, or operators like from:, subject:, has:attachment, is:unread."
                : account.backfilledAt
                  ? "New mail shows up here within a minute of arriving."
                  : "The first sync is still importing your mailbox."
            }
          />
        </div>
      ) : view === "drafts" && !searching && !label ? (
        <MailDraftReview
          companyId={company.id}
          companySlug={company.slug}
          threads={threads}
          changeTick={changeTick}
          hasMore={nextBefore !== null}
          loadingMore={loadingMore}
          onRefresh={() => load(false)}
          onLoadMore={async () => {
            if (!nextBefore) return;
            setLoadingMore(true);
            try {
              await load(true, nextBefore);
            } catch (err) {
              toast((err as Error).message, "error");
            } finally {
              setLoadingMore(false);
            }
          }}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                companySlug={company.slug}
                highlightTerms={highlightTerms}
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
// ───────────────────────────── search box ─────────────────────────────

/** Operator chips offered while the box is focused — one click appends. */
const SEARCH_OPERATORS: Array<{ op: string; hint: string }> = [
  { op: "from:", hint: "sender" },
  { op: "to:", hint: "recipient" },
  { op: "subject:", hint: "subject" },
  { op: "label:", hint: "label name" },
  { op: "in:archive", hint: "scope" },
  { op: "has:attachment", hint: "files" },
  { op: "is:unread", hint: "unread" },
  { op: "before:", hint: "date" },
];

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = React.useState(false);

  // "/" focuses the box from anywhere on the page (unless already typing).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      // Never steal focus out from under an open dialog (compose, confirm…) —
      // the search box would be occluded and keystrokes would edit it blind.
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const appendOperator = (op: string) => {
    const base = value.trim() ? `${value.trim()} ` : "";
    onChange(`${base}${op}`);
    inputRef.current?.focus();
  };

  return (
    <div className="relative ml-auto w-full max-w-sm">
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (value) onChange("");
            else inputRef.current?.blur();
          }
        }}
        placeholder="Search all mail…  ( / )"
        className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-8 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
      />
      {value && (
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
            inputRef.current?.focus();
          }}
          title="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
        >
          <X size={13} />
        </button>
      )}
      {focused && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Narrow your search
          </div>
          <div className="flex flex-wrap gap-1">
            {SEARCH_OPERATORS.map(({ op, hint }) => (
              <button
                key={op}
                onMouseDown={(e) => {
                  e.preventDefault();
                  appendOperator(op);
                }}
                title={hint}
                className="rounded-md border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
              >
                {op}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
            Terms combine (AND), &quot;quotes&quot; match phrases, and searches
            cover every message body across all mail.
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── highlighting ─────────────────────────────

/**
 * Mirror of the server grammar's scope rules, display-only: say what the
 * search actually covers when `in:` or `label:` narrows it. Kept honest by
 * the same defaults as `effectiveScope` on the server.
 */
function describeSearchScope(q: string): string {
  const SCOPES = ["inbox", "starred", "sent", "drafts", "all", "archive", "spam", "trash"];
  let label: string | null = null;
  for (const m of q.matchAll(/(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g)) {
    const op = m[1]?.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").trim();
    if (op === "in" && SCOPES.includes(value.toLowerCase())) {
      const scope = value.toLowerCase();
      return scope === "all" ? "Searching all mail" : `Searching ${scope}`;
    }
    if ((op === "label" || op === "in") && value && label === null) {
      label = value;
    }
  }
  if (label) {
    const l = label.toLowerCase();
    if (l === "spam" || l === "trash") return `Searching ${l}`;
    return `Searching label “${label}”`;
  }
  return "Searching all mail";
}

/** The plain terms worth highlighting — operator tokens don't mark text. */
function extractHighlightTerms(q: string): string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(/(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g)) {
    const op = m[1]?.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").trim();
    if (!value) continue;
    if (!op || op === "subject") terms.push(value);
  }
  return terms.filter((t) => t.length >= 2).slice(0, 8);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap query-term matches in <mark> — split on a capturing group keeps
 * matches at odd indices, so no stateful regex `.test` calls. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!text || terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-100 text-inherit dark:bg-amber-400/30"
          >
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

function ThreadRow({
  thread,
  companySlug,
  highlightTerms,
  onAction,
}: {
  thread: MailThread;
  companySlug: string;
  highlightTerms: string[];
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
          {thread.participants ? (
            <Highlight text={thread.participants} terms={highlightTerms} />
          ) : (
            "(unknown sender)"
          )}
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
            {thread.subject ? (
              <Highlight text={thread.subject} terms={highlightTerms} />
            ) : (
              "(no subject)"
            )}
          </span>
          {thread.snippet && (
            <span className="text-slate-400 dark:text-slate-500">
              {" — "}
              <Highlight text={thread.snippet} terms={highlightTerms} />
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
        {!inTrash && (
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
