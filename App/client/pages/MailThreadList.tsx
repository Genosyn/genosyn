import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
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
  THREAD_BULK_CHUNK,
  ThreadActionName,
  mailSyncDate,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { shouldIgnoreShortcut } from "../lib/keyboard";
import { type Command, useRegisterCommands } from "../components/CommandRegistry";
import { MailOutletCtx } from "./MailLayout";
import { MailDraftReview } from "./MailDraftReview";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
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
  const { company, account, labels, changeTick, syncing, syncNow, openCompose } =
    useOutletContext<MailOutletCtx>();
  const { toast, background } = useToast();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") ?? "inbox") as MailThreadView;
  const label = params.get("label") ?? "";
  const q = params.get("q") ?? "";

  const [threads, setThreads] = React.useState<MailThread[] | null>(null);
  const [nextBefore, setNextBefore] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [search, setSearch] = React.useState(q);

  // Drafts are not browsed as threads — the review queue loads its own
  // draft-centric list (attribution, facets, bulk selection), so this page
  // hands the whole surface over rather than fetching threads nobody renders.
  const draftsReview = view === "drafts" && !q.trim() && !label;

  // Monotonic request id: an all-mail body search can take a while, and a
  // response that resolves after a newer request (folder switch, cleared
  // box) must not clobber the fresher list.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(
    async (append: boolean, before?: string) => {
      if (draftsReview) return;
      const seq = ++loadSeq.current;
      const res = await mailApi.threads(company.id, account.id, {
        view,
        label: label || undefined,
        q: q || undefined,
        before,
        limit: 50,
      });
      if (seq !== loadSeq.current) return;
      setThreads((prev) => (append && prev ? [...prev, ...res.threads] : res.threads));
      setNextBefore(res.nextBefore);
    },
    [company.id, account.id, view, label, q, draftsReview],
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

  const act = (thread: MailThread, action: ThreadActionName) => {
    const originalIndex = threads?.findIndex((row) => row.id === thread.id) ?? -1;
    setThreads((current) =>
      current ? applyThreadAction(current, thread.id, action, view) : current,
    );

    background(() => mailApi.threadAction(company.id, thread.id, action), {
      loading: "Updating email…",
      error: (error) =>
        `Couldn\u2019t update the email: ${
          error instanceof Error ? error.message : "Unknown error"
        }. The change was undone.`,
      onSuccess: ({ thread: updated }) => {
        if (!updated) return;
        setThreads(
          (current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? current,
        );
      },
      onError: () => {
        setThreads((current) => {
          if (!current || current.some((row) => row.id === thread.id)) {
            return current?.map((row) => (row.id === thread.id ? thread : row)) ?? current;
          }
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, thread);
          return next;
        });
      },
    });
  };

  // ───────────────────────── selection, bulk, keyboard ─────────────────────────

  const navigate = useNavigate();
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);
  /** Where a shift-click range started. */
  const anchorRef = React.useRef<string | null>(null);

  const rows = React.useMemo(() => threads ?? [], [threads]);
  const selectedCount = selectedIds.size;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  // A folder switch or a new search is a different set of rows — carrying a
  // selection across it would act on threads nobody can see any more.
  React.useEffect(() => {
    setSelectedIds(new Set());
    setCursor(0);
  }, [view, label, q]);

  const clearSelection = React.useCallback(() => setSelectedIds(new Set()), []);

  const toggleOne = React.useCallback(
    (thread: MailThread, extend: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        const index = rows.findIndex((row) => row.id === thread.id);
        const anchorIndex = anchorRef.current
          ? rows.findIndex((row) => row.id === anchorRef.current)
          : -1;
        // Shift-click extends from the last row touched, as every mail client does.
        if (extend && anchorIndex >= 0 && index >= 0) {
          const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
          const selecting = !next.has(thread.id);
          for (let i = from; i <= to; i += 1) {
            if (selecting) next.add(rows[i].id);
            else next.delete(rows[i].id);
          }
        } else if (next.has(thread.id)) {
          next.delete(thread.id);
        } else {
          next.add(thread.id);
        }
        anchorRef.current = thread.id;
        return next;
      });
    },
    [rows],
  );

  const toggleAll = () => {
    if (selectedCount > 0) clearSelection();
    else setSelectedIds(new Set(rows.map((row) => row.id)));
  };

  /**
   * Run one action across the selection, chunked so a large sweep cannot
   * outlive a proxy timeout. Failures are reported per item rather than
   * collapsing the whole run into a single error.
   */
  const runBulk = React.useCallback(
    async (action: ThreadActionName) => {
      const ids = [...selectedIds];
      if (ids.length === 0) return;
      setBulkBusy(true);
      const failures: { id: string; reason: string }[] = [];
      try {
        for (let i = 0; i < ids.length; i += THREAD_BULK_CHUNK) {
          const chunk = ids.slice(i, i + THREAD_BULK_CHUNK);
          const res = await mailApi.threadActionBulk(company.id, account.id, {
            action,
            ids: chunk,
          });
          failures.push(...res.skipped);
        }
        const done = ids.length - failures.length;
        toast(
          failures.length === 0
            ? `Updated ${done} ${done === 1 ? "thread" : "threads"}.`
            : `Updated ${done} · ${failures.length} failed.`,
          failures.length === 0 ? "success" : "error",
        );
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        setBulkBusy(false);
        clearSelection();
        await load(false).catch(() => {});
      }
    },
    [selectedIds, company.id, account.id, toast, clearSelection, load],
  );

  React.useEffect(() => {
    document.querySelector(`[data-thread-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Publish the selection's verbs to ⌘K. They appear only while something is
  // selected, so the palette never offers to archive nothing.
  const threadCommands = React.useMemo<Command[]>(() => {
    if (selectedCount === 0) return [];
    const suffix = `${selectedCount} selected`;
    return [
      {
        id: "mail.selected.archive",
        label: `Archive ${suffix}`,
        icon: Archive,
        group: "Email",
        keywords: ["bulk", "selection"],
        run: () => void runBulk("archive"),
      },
      {
        id: "mail.selected.read",
        label: `Mark ${suffix} as read`,
        icon: MailOpen,
        group: "Email",
        keywords: ["bulk", "selection"],
        run: () => void runBulk("markRead"),
      },
      {
        id: "mail.selected.star",
        label: `Star ${suffix}`,
        icon: Star,
        group: "Email",
        keywords: ["bulk", "selection"],
        run: () => void runBulk("star"),
      },
      {
        id: "mail.selected.trash",
        label: `Trash ${suffix}`,
        icon: Trash2,
        group: "Email",
        keywords: ["bulk", "selection", "delete"],
        run: () => void runBulk("trash"),
      },
    ];
  }, [selectedCount, runBulk]);
  useRegisterCommands(threadCommands);

  React.useEffect(() => {
    // The drafts queue owns its own keys while it is on screen.
    if (draftsReview) return;
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      const row = rows[cursor];
      // Shift makes `event.key` uppercase, so Shift+X (range-select) would miss
      // a bare "x" comparison. Fold single characters before matching.
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      // j/k rather than the arrow keys, so ordinary scrolling still works.
      if (key === "j") {
        event.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(0, rows.length - 1)));
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (!row) return;
      if (key === "x") {
        event.preventDefault();
        toggleOne(row, event.shiftKey);
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        navigate(`/c/${company.slug}/mail/t/${row.id}`);
        return;
      }
      // A sweep already in flight owns the selection; letting a second one
      // start would interleave two chunked runs over the same rows.
      if (bulkBusy) return;
      // With a selection up, single keys act on the selection — the same rule
      // every mail client uses, and the only one that isn't a nasty surprise.
      const applyTo = (action: ThreadActionName) => {
        if (selectedCount > 0) void runBulk(action);
        else act(row, action);
      };
      if (key === "e") {
        event.preventDefault();
        applyTo(row.labelIds.includes("INBOX") ? "archive" : "moveToInbox");
      } else if (key === "#") {
        event.preventDefault();
        applyTo(row.labelIds.includes("TRASH") ? "untrash" : "trash");
      } else if (key === "s") {
        event.preventDefault();
        applyTo(row.labelIds.includes("STARRED") ? "unstar" : "star");
      } else if (key === "u") {
        event.preventDefault();
        applyTo(row.unread ? "markRead" : "markUnread");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cursor, draftsReview, selectedCount, bulkBusy, runBulk, toggleOne, clearSelection]);

  // Rows leave the list under the cursor (archive, trash, a sync pass). Without
  // this the cursor strands past the end and every shortcut becomes a no-op.
  React.useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const labelName = label ? (labels.find((l) => l.gmailLabelId === label)?.name ?? label) : null;
  const searching = q.trim().length > 0;
  const title = searching ? "Search" : (labelName ?? VIEW_TITLES[view] ?? "Inbox");
  const highlightTerms = React.useMemo(
    () => (searching ? extractHighlightTerms(q) : []),
    [searching, q],
  );
  const searchScopeLabel = React.useMemo(
    () => (searching ? describeSearchScope(q) : ""),
    [searching, q],
  );

  return (
    <div
      className={clsx(
        "mx-auto flex min-h-full flex-col px-4 py-4 sm:px-6",
        draftsReview ? "max-w-[96rem]" : "max-w-5xl",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
          <div
            className="text-xs text-slate-500 dark:text-slate-400"
            title={account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString() : undefined}
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
        {/* The review queue carries its own scoped search; two boxes on one
            screen would just be a guessing game about which one applies. */}
        {!draftsReview && <SearchBox value={search} onChange={setSearch} />}
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

      {!draftsReview && <QuickFilters query={search} view={view} onChange={setSearch} />}

      {draftsReview ? (
        <MailDraftReview
          companyId={company.id}
          companySlug={company.slug}
          company={company}
          account={account}
          changeTick={changeTick}
          openCompose={openCompose}
        />
      ) : threads === null ? (
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
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
            <Checkbox
              checked={allSelected}
              indeterminate={selectedCount > 0 && !allSelected}
              onChange={toggleAll}
              label="Select every thread in view"
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {selectedCount > 0 ? (
                <span className="font-medium text-indigo-700 dark:text-indigo-300">
                  {selectedCount} selected
                </span>
              ) : (
                "Select all"
              )}
            </span>
            <span className="ml-auto hidden text-[11px] text-slate-400 sm:block">
              <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>x</Kbd> select · <Kbd>e</Kbd> archive ·{" "}
              <Kbd>s</Kbd> star
            </span>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {threads.map((t, index) => (
              <ThreadRow
                key={t.id}
                thread={t}
                index={index}
                focused={index === cursor}
                selected={selectedIds.has(t.id)}
                companySlug={company.slug}
                highlightTerms={highlightTerms}
                onAction={act}
                onFocus={() => setCursor(index)}
                onToggleSelect={(extend) => toggleOne(t, extend)}
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

      {selectedCount > 0 && !draftsReview && (
        <ThreadBulkBar
          count={selectedCount}
          busy={bulkBusy}
          onAction={(action) => void runBulk(action)}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

/**
 * Floating action bar for a thread selection. Deliberately a small, fixed set
 * of verbs — the long tail stays on the row hover menu, where it does not
 * tempt anyone into a 200-thread mistake.
 */
function ThreadBulkBar({
  count,
  busy,
  onAction,
  onClear,
}: {
  count: number;
  busy: boolean;
  onAction: (action: ThreadActionName) => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <span className="px-1 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {count} selected
        </span>
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("markRead")}>
          <MailOpen size={14} /> Read
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("star")}>
          <Star size={14} /> Star
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("archive")}>
          <Archive size={14} /> Archive
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("trash")}>
          <Trash2 size={14} /> Trash
        </Button>
        <button
          onClick={onClear}
          aria-label="Clear selection"
          className="ml-1 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
      {children}
    </kbd>
  );
}

// ───────────────────────────── quick filters ─────────────────────────────

/**
 * One-click narrowings that compile straight to the search grammar, so a chip
 * and a typed query are the same thing — no second filtering system to keep in
 * step with the first.
 */
const QUICK_FILTERS: Array<{ token: string; label: string }> = [
  { token: "is:unread", label: "Unread" },
  { token: "is:starred", label: "Starred" },
  { token: "has:attachment", label: "Has attachment" },
];

function QuickFilters({
  query,
  view,
  onChange,
}: {
  query: string;
  view: MailThreadView;
  onChange: (next: string) => void;
}) {
  const tokens = query.split(/\s+/).filter(Boolean);

  const toggle = (token: string) => {
    if (tokens.includes(token)) {
      onChange(tokens.filter((t) => t !== token).join(" "));
      return;
    }
    // A bare `is:unread` searches every folder, which is not what someone
    // standing in the Inbox means — pin the scope to the folder they are in.
    const next = [...tokens, token];
    const scoped = next.some((t) => t.startsWith("in:"));
    if (!scoped && view !== "all") next.unshift(`in:${view}`);
    onChange(next.join(" "));
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {QUICK_FILTERS.map(({ token, label }) => {
        const active = tokens.includes(token);
        return (
          <button
            key={token}
            type="button"
            onClick={() => toggle(token)}
            aria-pressed={active}
            className={clsx(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium transition",
              active
                ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300"
                : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800",
            )}
          >
            {label}
          </button>
        );
      })}
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

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
            Terms combine (AND), &quot;quotes&quot; match phrases, and searches cover every message
            body across all mail.
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
          <mark key={i} className="rounded-sm bg-amber-100 text-inherit dark:bg-amber-400/30">
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
  index,
  focused,
  selected,
  companySlug,
  highlightTerms,
  onAction,
  onFocus,
  onToggleSelect,
}: {
  thread: MailThread;
  index: number;
  focused: boolean;
  selected: boolean;
  companySlug: string;
  highlightTerms: string[];
  onAction: (t: MailThread, action: ThreadActionName) => void;
  onFocus: () => void;
  onToggleSelect: (extend: boolean) => void;
}) {
  const starred = thread.labelIds.includes("STARRED");
  const inTrash = thread.labelIds.includes("TRASH");
  const inInbox = thread.labelIds.includes("INBOX");
  return (
    <li
      data-thread-idx={index}
      onMouseEnter={onFocus}
      className={clsx(
        "group relative flex items-center gap-2.5 pl-4",
        selected
          ? "bg-indigo-50/70 dark:bg-indigo-500/10"
          : thread.unread
            ? "bg-indigo-50/30 dark:bg-indigo-500/5"
            : "hover:bg-slate-50 dark:hover:bg-slate-900",
        focused && "ring-1 ring-inset ring-indigo-400/60 dark:ring-indigo-500/40",
      )}
    >
      {/* Outside the link on purpose: a checkbox nested in an anchor still
          navigates on click, and stopPropagation does not prevent that. */}
      <Checkbox
        checked={selected}
        label={`Select ${thread.subject || "thread"}`}
        onChange={(event) =>
          onToggleSelect(Boolean((event.nativeEvent as MouseEvent).shiftKey))
        }
        className={clsx(
          !selected && "opacity-0 focus:opacity-100 group-hover:opacity-100",
          "transition-opacity",
        )}
      />
      <Link
        to={`/c/${companySlug}/mail/t/${thread.id}`}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4"
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            void onAction(thread, starred ? "unstar" : "star");
          }}
          title={starred ? "Unstar" : "Star"}
          className={clsx(
            "shrink-0",
            starred ? "text-amber-400" : "text-slate-300 hover:text-slate-400 dark:text-slate-600",
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
            <span className="ml-1 text-xs font-normal text-slate-400">{thread.messageCount}</span>
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
        {thread.hasAttachments && <Paperclip size={13} className="shrink-0 text-slate-400" />}
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

function applyThreadAction(
  rows: MailThread[],
  threadId: string,
  action: ThreadActionName,
  view: MailThreadView,
): MailThread[] {
  const removeFromView =
    (action === "archive" && view === "inbox") ||
    (action === "unstar" && view === "starred") ||
    (action === "trash" && view !== "trash") ||
    (action === "untrash" && view === "trash");
  if (removeFromView) return rows.filter((row) => row.id !== threadId);

  return rows.map((row) => {
    if (row.id !== threadId) return row;
    const labels = new Set(row.labelIds);
    if (action === "star") labels.add("STARRED");
    if (action === "unstar") labels.delete("STARRED");
    if (action === "archive") labels.delete("INBOX");
    if (action === "moveToInbox") {
      labels.add("INBOX");
      labels.delete("TRASH");
    }
    if (action === "trash") {
      labels.add("TRASH");
      labels.delete("INBOX");
    }
    if (action === "untrash") labels.delete("TRASH");
    return {
      ...row,
      labelIds: [...labels],
      unread: action === "markRead" ? false : action === "markUnread" ? true : row.unread,
    };
  });
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
