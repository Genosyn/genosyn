import React from "react";
import {
  CalendarClock,
  ChevronDown,
  Layers,
  PanelRight,
  Paperclip,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { Company } from "../lib/api";
import {
  ComposeInput,
  DRAFT_BULK_CHUNK,
  MailAccount,
  MailDraft,
  MailDraftFacet,
  MailDraftFilter,
  MailDraftSelection,
  MailDraftSendPreview,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { shouldIgnoreShortcut } from "../lib/keyboard";
import { type Command, useRegisterCommands } from "../components/CommandRegistry";
import { MailBulkSendDialog, type BulkProgress } from "./MailBulkSendDialog";
import { MailDraftDrawer } from "./MailDraftDrawer";
import { DraftAuthorAvatar, RoutineChip, authorName } from "../components/mail/DraftAuthor";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { EmptyState } from "../components/ui/EmptyState";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * The Drafts review queue.
 *
 * AI employees write drafts overnight; a human decides what actually goes out.
 * That makes this a triage surface, not a mail client — one dense row per
 * draft, attributed to the Routine and employee behind it, filterable by both,
 * and actionable in bulk from the keyboard. Deep reading happens in a drawer so
 * the list itself stays fast with hundreds of rows on screen.
 *
 * Two rules shape everything here:
 *   - A draft with no recipient can never be selected for sending. It is not a
 *     silent skip at send time, it is a checkbox that cannot be ticked.
 *   - No batch leaves without passing {@link MailBulkSendDialog}, which shows
 *     who is about to receive mail.
 */

const PAGE_SIZE = 100;

type GroupBy = "employee" | "routine" | "none";

/**
 * Either the rows someone ticked, or "everything matching the filter" minus
 * opt-outs — so selecting 300 drafts never means holding 300 ids.
 */
type Selection = { mode: "ids"; ids: Set<string> } | { mode: "all"; exclude: Set<string> };

type PendingBulk = { action: "send" | "discard"; preview: MailDraftSendPreview };

type MailDraftReviewProps = {
  companyId: string;
  companySlug: string;
  company: Company;
  account: MailAccount;
  changeTick: number;
  openCompose: (init?: Partial<ComposeInput>) => void;
};

export function MailDraftReview({
  companyId,
  companySlug,
  company,
  account,
  changeTick,
  openCompose,
}: MailDraftReviewProps) {
  const { toast } = useToast();
  const dialog = useDialog();

  const [rows, setRows] = React.useState<MailDraft[]>([]);
  const [facets, setFacets] = React.useState<{
    employees: MailDraftFacet[];
    routines: MailDraftFacet[];
  }>({ employees: [], routines: [] });
  const [totals, setTotals] = React.useState({ total: 0, sendable: 0, missingRecipient: 0 });
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [employeeId, setEmployeeId] = React.useState<string | undefined>();
  const [routineId, setRoutineId] = React.useState<string | undefined>();
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [groupBy, setGroupBy] = React.useState<GroupBy>("employee");

  const [selection, setSelection] = React.useState<Selection>({ mode: "ids", ids: new Set() });
  const [cursor, setCursor] = React.useState(0);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [drawerId, setDrawerId] = React.useState<string | null>(null);

  const [pending, setPending] = React.useState<PendingBulk | null>(null);
  const [progress, setProgress] = React.useState<BulkProgress | null>(null);
  /** Drafts a send refused, kept visible instead of vanishing into a toast. */
  const [failed, setFailed] = React.useState<Map<string, string>>(() => new Map());

  const filter = React.useMemo<MailDraftFilter>(
    () => ({ employeeId, routineId, q: query || undefined }),
    [employeeId, routineId, query],
  );

  // Debounced search box → the filter the queue actually loads on.
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const seq = React.useRef(0);
  const load = React.useCallback(
    async (append: boolean, offset?: number) => {
      const id = ++seq.current;
      if (!append) setLoading(true);
      setError(null);
      try {
        const res = await mailApi.drafts(companyId, account.id, {
          ...filter,
          offset,
          limit: PAGE_SIZE,
        });
        if (id !== seq.current) return;
        setRows((prev) => (append ? [...prev, ...res.drafts] : res.drafts));
        setNextOffset(res.nextOffset);
        setFacets(res.facets);
        setTotals(res.totals);
      } catch (err) {
        if (id !== seq.current) return;
        setError((err as Error).message);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [companyId, account.id, filter],
  );

  React.useEffect(() => {
    void load(false);
  }, [load]);

  // Live refresh when a sync or another surface changes the mailbox — but never
  // mid-batch, where it would fight the optimistic removals.
  const busyRef = React.useRef(false);
  busyRef.current = progress !== null;
  React.useEffect(() => {
    if (changeTick === 0 || busyRef.current) return;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick]);

  // ───────────────────────── selection ─────────────────────────

  const clearSelection = React.useCallback(
    () => setSelection({ mode: "ids", ids: new Set() }),
    [],
  );

  // Reset the selection whenever the filter moves — "all matching" means
  // something different the moment the filter does.
  React.useEffect(() => {
    clearSelection();
    setCursor(0);
  }, [filter, clearSelection]);

  const isSelected = React.useCallback(
    (draft: MailDraft) => {
      if (draft.missingRecipient) return false;
      return selection.mode === "ids"
        ? selection.ids.has(draft.id)
        : !selection.exclude.has(draft.id);
    },
    [selection],
  );

  const setSelected = React.useCallback((ids: string[], selected: boolean) => {
    if (ids.length === 0) return;
    setSelection((current) => {
      if (current.mode === "ids") {
        const next = new Set(current.ids);
        for (const id of ids) {
          if (selected) next.add(id);
          else next.delete(id);
        }
        return { mode: "ids", ids: next };
      }
      const next = new Set(current.exclude);
      for (const id of ids) {
        if (selected) next.delete(id);
        else next.add(id);
      }
      return { mode: "all", exclude: next };
    });
  }, []);

  const selectedCount =
    selection.mode === "ids"
      ? selection.ids.size
      : Math.max(0, totals.sendable - selection.exclude.size);
  const allSelected = selection.mode === "all" && selection.exclude.size === 0;

  const toggleAll = () => {
    if (selectedCount > 0) clearSelection();
    else setSelection({ mode: "all", exclude: new Set() });
  };

  // ───────────────────────── grouping ─────────────────────────

  const groups = React.useMemo(
    () => buildGroups(rows, groupBy, failed),
    [rows, groupBy, failed],
  );
  const flatRows = React.useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  React.useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, flatRows.length - 1)));
  }, [flatRows.length]);

  React.useEffect(() => {
    document
      .querySelector(`[data-draft-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // ───────────────────────── actions ─────────────────────────

  const removeRows = (ids: Iterable<string>) => {
    const gone = new Set(ids);
    setRows((prev) => prev.filter((row) => !gone.has(row.id)));
    // "All matching minus these" has to stay honest: a draft that no longer
    // exists must stop counting against the selection, or the header slowly
    // drifts below the number of drafts actually selected.
    setSelection((current) => {
      if (current.mode !== "all") return current;
      const kept = [...current.exclude].filter((id) => !gone.has(id));
      return kept.length === current.exclude.size
        ? current
        : { mode: "all", exclude: new Set(kept) };
    });
  };

  /** Single send stays optimistic — it matches how one-off sends already felt. */
  const sendOne = (draft: MailDraft) => {
    if (draft.missingRecipient) return;
    setDrawerId(null);
    removeRows([draft.id]);
    mailApi
      .sendDraft(companyId, draft.id)
      .then(() => {
        toast("Draft sent", "success");
        void load(false);
      })
      .catch((err: unknown) => {
        toast(
          `Couldn't send that draft: ${
            err instanceof Error ? err.message : "Unknown error"
          }. It is back in the queue.`,
          "error",
        );
        void load(false);
      });
  };

  const discardOne = async (draft: MailDraft) => {
    const ok = await dialog.confirm({
      title: "Discard this draft?",
      message: "It is deleted from this mailbox and from Gmail. This cannot be undone.",
      confirmLabel: "Discard",
      variant: "danger",
    });
    if (!ok) return;
    setDrawerId(null);
    removeRows([draft.id]);
    mailApi
      .discardDraft(companyId, draft.id)
      .then(() => void load(false))
      .catch((err: unknown) => {
        toast(`Couldn't discard: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
        void load(false);
      });
  };

  const selectionPayload = (): MailDraftSelection =>
    selection.mode === "ids"
      ? { ids: [...selection.ids] }
      : // "Select all" ticks every *sendable* draft — no-recipient rows have a
        // disabled checkbox — so the filter must say so too. Otherwise a bulk
        // discard would delete exactly the rows the UI refused to select.
        { filter: { ...filter, sendableOnly: true }, exclude: [...selection.exclude] };

  /** Resolve what a batch would do, then hand it to the confirmation dialog. */
  const openBulk = async (action: "send" | "discard", sel: MailDraftSelection) => {
    try {
      const preview = await mailApi.draftsSendPreview(companyId, account.id, sel);
      const count = action === "send" ? preview.sendable : preview.total;
      if (count === 0) {
        toast(
          action === "send"
            ? "Nothing to send — those drafts have no recipient yet."
            : "Nothing to discard.",
          "info",
        );
        return;
      }
      setPending({ action, preview });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  // ⌘K gets the one verb worth reaching for without the mouse. Held in a ref so
  // the command always runs the current closure instead of a stale one.
  const openBulkRef = React.useRef(openBulk);
  openBulkRef.current = openBulk;
  const draftCommands = React.useMemo<Command[]>(
    () =>
      totals.sendable > 0
        ? [
            {
              id: "mail.drafts.sendAll",
              label: `Send all ${totals.sendable} drafts`,
              icon: Send,
              group: "Drafts",
              keywords: ["bulk", "send", "all", "queue", "review"],
              run: () => void openBulkRef.current("send", { filter, exclude: [] }),
            },
          ]
        : [],
    [totals.sendable, filter],
  );
  useRegisterCommands(draftCommands);

  /**
   * Run a batch in chunks. Gmail is ~1-2s per send, so one request per hundreds
   * of drafts would simply time out; chunking also means the dialog can show
   * honest progress and a partial failure never loses the rest of the run.
   */
  const runBulk = async (action: "send" | "discard", ids: string[]) => {
    const succeeded: string[] = [];
    const failures: { id: string; reason: string }[] = [];
    setProgress({ done: 0, total: ids.length });

    for (let i = 0; i < ids.length; i += DRAFT_BULK_CHUNK) {
      const chunk = ids.slice(i, i + DRAFT_BULK_CHUNK);
      try {
        const res = await mailApi.draftsBulk(companyId, account.id, { action, ids: chunk });
        succeeded.push(...res.succeeded);
        failures.push(...res.skipped);
        removeRows(res.succeeded);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Request failed";
        for (const id of chunk) failures.push({ id, reason });
      }
      setProgress({ done: Math.min(i + chunk.length, ids.length), total: ids.length });
    }

    setProgress(null);
    setPending(null);
    clearSelection();

    if (failures.length > 0) {
      setFailed((prev) => {
        const next = new Map(prev);
        for (const failure of failures) next.set(failure.id, failure.reason);
        return next;
      });
    }

    const verb = action === "send" ? "Sent" : "Discarded";
    toast(
      failures.length === 0
        ? `${verb} ${succeeded.length}.`
        : `${verb} ${succeeded.length} · ${failures.length} left in Needs attention.`,
      failures.length === 0 ? "success" : "error",
    );
    await load(false);
  };

  const activeFilterCount = (employeeId ? 1 : 0) + (routineId ? 1 : 0) + (query ? 1 : 0);
  const drawerDraft = drawerId ? (rows.find((row) => row.id === drawerId) ?? null) : null;

  // ───────────────────────── keyboard ─────────────────────────

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      const row = flatRows[cursor];
      // Shift uppercases `event.key`; fold so Shift-modified keys still match.
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      // Deliberately j/k rather than the arrow keys — stealing arrows would
      // break ordinary scrolling for anyone not using the shortcuts.
      if (key === "j") {
        event.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(0, flatRows.length - 1)));
      } else if (key === "k") {
        event.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (key === "x" && row) {
        event.preventDefault();
        if (!row.missingRecipient) setSelected([row.id], !isSelected(row));
      } else if (key === "Enter" && row) {
        event.preventDefault();
        setExpandedId((id) => (id === row.id ? null : row.id));
      } else if (key === "o" && row) {
        event.preventDefault();
        setDrawerId(row.id);
      } else if (key === "e" && row) {
        event.preventDefault();
        // Never fire a one-off send into the middle of a running batch.
        if (!progress) sendOne(row);
      } else if (key === "Escape") {
        event.preventDefault();
        if (expandedId) setExpandedId(null);
        else clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatRows, cursor, isSelected, expandedId, progress, setSelected, clearSelection]);

  // ───────────────────────── render ─────────────────────────

  if (loading && rows.length === 0) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
        <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
          Couldn&apos;t load the review queue
        </div>
        <div className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">{error}</div>
        <Button className="mt-3" size="sm" variant="secondary" onClick={() => void load(false)}>
          Try again
        </Button>
      </div>
    );
  }

  if (totals.total === 0 && activeFilterCount === 0) {
    return (
      <EmptyState
        title="No drafts waiting"
        description="When an AI employee writes an email, it lands here for you to review and send."
      />
    );
  }

  return (
    <div className="pb-24">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
        {/* Header — what is here, and the one button that sends all of it. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Review queue
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <span className="tabular-nums">{totals.total}</span> to review ·{" "}
              <span className="tabular-nums">{totals.sendable}</span> ready
              {totals.missingRecipient > 0 && (
                <>
                  {" · "}
                  <span className="tabular-nums text-amber-600 dark:text-amber-400">
                    {totals.missingRecipient}
                  </span>{" "}
                  need a recipient
                </>
              )}
            </p>
          </div>
          <Button
            size="sm"
            disabled={totals.sendable === 0}
            onClick={() => void openBulk("send", { filter, exclude: [] })}
          >
            <Send size={14} /> Send all{totals.sendable > 0 ? ` (${totals.sendable})` : ""}
          </Button>
        </div>

        {/* Filters. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
          <FacetMenu
            label="AI employee"
            icon={<Users size={13} />}
            facets={facets.employees}
            value={employeeId}
            onChange={setEmployeeId}
          />
          <FacetMenu
            label="Routine"
            icon={<CalendarClock size={13} />}
            facets={facets.routines}
            value={routineId}
            onChange={setRoutineId}
          />
          <GroupByMenu value={groupBy} onChange={setGroupBy} />

          <div className="relative ml-auto w-full max-w-xs">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search drafts…"
              className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-7 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                title="Clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X size={12} />
              </button>
            )}
          </div>
          {activeFilterCount > 0 && (
            <button
              onClick={() => {
                setEmployeeId(undefined);
                setRoutineId(undefined);
                setSearch("");
              }}
              className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Select-all strip. */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
          <Checkbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            disabled={totals.sendable === 0}
            onChange={toggleAll}
            label="Select every sendable draft"
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
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>x</Kbd> select · <Kbd>e</Kbd> send ·{" "}
            <Kbd>o</Kbd> open
          </span>
        </div>

        {/* The queue. */}
        {flatRows.length === 0 ? (
          <div className="px-6 py-12">
            <EmptyState
              title="Nothing matches these filters"
              description="Try a different AI employee or routine, or clear the search."
            />
          </div>
        ) : (
          <ul>
            {groups.map((group) => {
              const selectable = group.rows.filter((row) => !row.missingRecipient);
              const groupSelected =
                selectable.length > 0 && selectable.every((row) => isSelected(row));
              return (
                <li key={group.key}>
                  <GroupHeaderRow
                    group={group}
                    selectable={selectable.length}
                    selected={groupSelected}
                    onToggle={() => setSelected(selectable.map((r) => r.id), !groupSelected)}
                    onSend={
                      selectable.length > 0
                        ? () => void openBulk("send", { ids: selectable.map((r) => r.id) })
                        : undefined
                    }
                    onDiscardAll={
                      group.tone === "attention"
                        ? () => void openBulk("discard", { ids: group.rows.map((r) => r.id) })
                        : undefined
                    }
                  />
                  <ul>
                    {group.rows.map((draft) => {
                      const index = flatRows.indexOf(draft);
                      return (
                        <DraftRow
                          key={draft.id}
                          draft={draft}
                          index={index}
                          companyId={companyId}
                          focused={index === cursor}
                          selected={isSelected(draft)}
                          expanded={expandedId === draft.id}
                          failure={failed.get(draft.id) ?? null}
                          onFocus={() => setCursor(index)}
                          onToggleSelect={() => setSelected([draft.id], !isSelected(draft))}
                          onToggleExpand={() =>
                            setExpandedId((id) => (id === draft.id ? null : draft.id))
                          }
                          onOpen={() => setDrawerId(draft.id)}
                          onSend={() => sendOne(draft)}
                          onDiscard={() => void discardOne(draft)}
                        />
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}

        {nextOffset !== null && (
          <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                try {
                  await load(true, nextOffset);
                } finally {
                  setLoadingMore(false);
                }
              }}
            >
              {loadingMore ? <Spinner size={14} /> : "Load more drafts"}
            </Button>
          </div>
        )}
      </div>

      {selectedCount > 0 && (
        <BulkBar
          count={selectedCount}
          // Only meaningful for "select all", where the filter's no-recipient
          // drafts really were left out. With hand-ticked rows the number would
          // describe drafts the person never touched.
          skipped={selection.mode === "all" ? totals.missingRecipient : 0}
          onSend={() => void openBulk("send", selectionPayload())}
          onDiscard={() => void openBulk("discard", selectionPayload())}
          onClear={clearSelection}
        />
      )}

      {pending && (
        <MailBulkSendDialog
          action={pending.action}
          preview={pending.preview}
          progress={progress}
          onCancel={() => {
            if (progress) return;
            setPending(null);
          }}
          onConfirm={() =>
            void runBulk(
              pending.action,
              pending.action === "send" ? pending.preview.sendableIds : pending.preview.ids,
            )
          }
        />
      )}

      {drawerDraft && (
        <MailDraftDrawer
          companyId={companyId}
          companySlug={companySlug}
          company={company}
          account={account}
          draft={drawerDraft}
          onClose={() => setDrawerId(null)}
          onSend={sendOne}
          onDiscard={(draft) => void discardOne(draft)}
          openCompose={openCompose}
        />
      )}
    </div>
  );
}

// ───────────────────────────── grouping ─────────────────────────────

type DraftGroup = {
  key: string;
  label: string;
  rows: MailDraft[];
  tone?: "attention";
};

/**
 * Anything blocked or broken is pulled into a pinned first group. A draft that
 * failed to send must not quietly rejoin a list of 300 — the whole point of the
 * queue is that nothing disappears without being accounted for.
 */
function buildGroups(
  rows: MailDraft[],
  groupBy: GroupBy,
  failed: Map<string, string>,
): DraftGroup[] {
  const attention = rows.filter((row) => row.missingRecipient || failed.has(row.id));
  const flagged = new Set(attention.map((row) => row.id));
  const rest = rows.filter((row) => !flagged.has(row.id));

  const groups: DraftGroup[] = [];
  if (attention.length > 0) {
    groups.push({ key: "__attention", label: "Needs attention", rows: attention, tone: "attention" });
  }

  if (groupBy === "none") {
    if (rest.length > 0) groups.push({ key: "__all", label: "Drafts", rows: rest });
    return groups;
  }

  const buckets = new Map<string, DraftGroup>();
  for (const row of rest) {
    const { key, label } = groupKey(row, groupBy);
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { key, label, rows: [row] });
  }
  return [...groups, ...buckets.values()];
}

function groupKey(row: MailDraft, groupBy: GroupBy): { key: string; label: string } {
  const author = row.author;
  if (groupBy === "routine") {
    if (author.kind === "employee" && author.routine) {
      return { key: `r:${author.routine.id}`, label: author.routine.name };
    }
    return { key: "r:none", label: "Not from a routine" };
  }
  if (author.kind === "employee") return { key: `e:${author.employee.id}`, label: author.employee.name };
  if (author.kind === "member") return { key: `m:${author.member.id}`, label: author.member.name };
  return { key: "u:none", label: authorName(author) };
}

// ───────────────────────────── pieces ─────────────────────────────

function GroupHeaderRow({
  group,
  selectable,
  selected,
  onToggle,
  onSend,
  onDiscardAll,
}: {
  group: DraftGroup;
  selectable: number;
  selected: boolean;
  onToggle: () => void;
  onSend?: () => void;
  onDiscardAll?: () => void;
}) {
  const attention = group.tone === "attention";
  return (
    <div
      className={clsx(
        "sticky top-0 z-10 flex items-center gap-2.5 border-y px-4 py-1.5 backdrop-blur",
        attention
          ? "border-amber-200 bg-amber-50/90 dark:border-amber-500/30 dark:bg-amber-500/10"
          : "border-slate-100 bg-slate-50/90 dark:border-slate-800/70 dark:bg-slate-900/80",
      )}
    >
      {selectable > 0 ? (
        <Checkbox checked={selected} onChange={onToggle} label={`Select ${group.label}`} />
      ) : (
        <span className="w-4" />
      )}
      {attention && <TriangleAlert size={13} className="text-amber-600 dark:text-amber-400" />}
      <span
        className={clsx(
          "text-xs font-semibold",
          attention ? "text-amber-800 dark:text-amber-200" : "text-slate-600 dark:text-slate-300",
        )}
      >
        {group.label}
      </span>
      <span className="text-xs tabular-nums text-slate-400">{group.rows.length}</span>
      <div className="ml-auto flex items-center gap-1">
        {onDiscardAll && (
          <button
            onClick={onDiscardAll}
            className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-white hover:text-red-600 dark:hover:bg-slate-800"
          >
            Discard all
          </button>
        )}
        {onSend && (
          <button
            onClick={onSend}
            className="rounded px-2 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-white dark:text-indigo-300 dark:hover:bg-slate-800"
          >
            Send {selectable}
          </button>
        )}
      </div>
    </div>
  );
}

function DraftRow({
  draft,
  index,
  companyId,
  focused,
  selected,
  expanded,
  failure,
  onFocus,
  onToggleSelect,
  onToggleExpand,
  onOpen,
  onSend,
  onDiscard,
}: {
  draft: MailDraft;
  index: number;
  companyId: string;
  focused: boolean;
  selected: boolean;
  expanded: boolean;
  failure: string | null;
  onFocus: () => void;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onOpen: () => void;
  onSend: () => void;
  onDiscard: () => void;
}) {
  return (
    <li
      data-draft-idx={index}
      onMouseEnter={onFocus}
      className={clsx(
        "group relative border-b border-slate-100 last:border-b-0 dark:border-slate-800/70",
        selected
          ? "bg-indigo-50/70 dark:bg-indigo-500/10"
          : "hover:bg-slate-50 dark:hover:bg-slate-900/60",
        focused && "ring-1 ring-inset ring-indigo-400/60 dark:ring-indigo-500/40",
      )}
    >
      <div className="flex items-start gap-3 px-4 py-2.5">
        <span className="pt-0.5">
          <Checkbox
            checked={selected}
            indeterminate={false}
            disabled={draft.missingRecipient}
            title={
              draft.missingRecipient ? "Add a recipient before this can be sent" : undefined
            }
            onChange={onToggleSelect}
            label={`Select ${draft.subject || "draft"}`}
          />
        </span>

        <span className="pt-0.5">
          <DraftAuthorAvatar author={draft.author} companyId={companyId} size="sm" />
        </span>

        <button
          type="button"
          onClick={onToggleExpand}
          onDoubleClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {draft.subject || "(no subject)"}
            </span>
            {draft.hasAttachments && <Paperclip size={12} className="shrink-0 text-slate-400" />}
            <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
              {shortMailDate(draft.createdAt)}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={clsx(
                "truncate text-xs",
                draft.missingRecipient
                  ? "font-medium text-amber-700 dark:text-amber-400"
                  : "text-slate-500 dark:text-slate-400",
              )}
            >
              {draft.missingRecipient ? "No recipient" : draft.toEmails}
            </span>
            <RoutineChip author={draft.author} />
          </span>
          <span className="mt-1 block truncate text-xs text-slate-400 dark:text-slate-500">
            {draft.snippet || draft.bodyPreview || "Empty draft"}
          </span>
          {failure && (
            <span className="mt-1 block truncate text-xs text-red-600 dark:text-red-400">
              Last attempt failed: {failure}
            </span>
          )}
        </button>

        {/* Row actions, revealed on hover — mirrors the thread list. */}
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <RowAction title="Open for review" onClick={onOpen}>
            <PanelRight size={14} />
          </RowAction>
          <RowAction title="Discard" onClick={onDiscard}>
            <Trash2 size={14} />
          </RowAction>
          <RowAction
            title={draft.missingRecipient ? "Add a recipient first" : "Send"}
            disabled={draft.missingRecipient}
            onClick={onSend}
          >
            <Send size={14} />
          </RowAction>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 pl-14 dark:border-slate-800/70 dark:bg-slate-900/40">
          <p className="whitespace-pre-wrap text-xs leading-5 text-slate-600 dark:text-slate-300">
            {draft.bodyPreview || "(empty draft)"}
          </p>
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={onOpen}>
              Open full draft
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function RowAction({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

function BulkBar({
  count,
  skipped,
  onSend,
  onDiscard,
  onClear,
}: {
  count: number;
  skipped: number;
  onSend: () => void;
  onDiscard: () => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <span className="px-1 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {count} selected
        </span>
        {skipped > 0 && (
          <span className="text-xs text-slate-400">{skipped} without a recipient skipped</span>
        )}
        <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <Button size="sm" onClick={onSend}>
          <Send size={14} /> Send selected
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          <Trash2 size={14} /> Discard
        </Button>
        <button
          onClick={onClear}
          aria-label="Clear selection"
          className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function FacetMenu({
  label,
  icon,
  facets,
  value,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  facets: MailDraftFacet[];
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const active = facets.find((facet) => facet.id === value);
  return (
    <Menu
      width={260}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          aria-expanded={open}
          className={clsx(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition",
            value
              ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
        >
          {icon}
          <span className="max-w-[9rem] truncate">{active ? active.name : label}</span>
          <ChevronDown size={12} className="text-slate-400" />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>{label}</MenuHeader>
          <MenuItem
            label="All"
            active={!value}
            onSelect={() => {
              onChange(undefined);
              close();
            }}
          />
          {facets.length > 0 && <MenuSeparator />}
          {facets.map((facet) => (
            <MenuItem
              key={facet.id ?? "none"}
              label={facet.name}
              hint={String(facet.count)}
              active={facet.id === value}
              onSelect={() => {
                onChange(facet.id ?? undefined);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

const GROUP_LABELS: Record<GroupBy, string> = {
  employee: "AI employee",
  routine: "Routine",
  none: "No grouping",
};

function GroupByMenu({ value, onChange }: { value: GroupBy; onChange: (next: GroupBy) => void }) {
  return (
    <Menu
      width={200}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          aria-expanded={open}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Layers size={13} />
          <span className="truncate">Group: {GROUP_LABELS[value]}</span>
          <ChevronDown size={12} className="text-slate-400" />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Group by</MenuHeader>
          {(Object.keys(GROUP_LABELS) as GroupBy[]).map((key) => (
            <MenuItem
              key={key}
              label={GROUP_LABELS[key]}
              active={key === value}
              onSelect={() => {
                onChange(key);
                close();
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
      {children}
    </kbd>
  );
}
