import React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, RotateCcw, Search, Tag, X } from "lucide-react";
import { Account, api, BankingBulkAction, BankingBulkResult, Company } from "../lib/api";
import {
  BULK_PROGRESS,
  type BankingRow,
  type CategoryGroup,
  categoryGroups,
  planFor,
  rowKey,
  sendToReviewConfirmation,
  skippedSummary,
  unselectableReason,
} from "../lib/bankingBulk";
import { errorMessage } from "../lib/errors";
import { chunk, toggleSelection } from "../lib/selection";
import { canWriteFinance } from "../lib/subpages";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { useDialog } from "../components/ui/Dialog";
import { useCloseOnEscape, useCloseOnPressOutside } from "../components/ui/Menu";
import { ButtonSpinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * Banking's selection and its bulk bar: tick transactions — one by one, a run
 * with shift-click, or every one in view — then Categorize them under one
 * category, Mark reviewed the card purchases waiting, or Send to review what
 * is done. The bar offers only what the ticked rows can take
 * (`lib/bankingBulk.ts`), and the server applies each row's own rules again.
 *
 * Rows that changed leave the selection, and leave the list when the tab no
 * longer holds them. A row that was skipped stays ticked, and the error
 * modal says why.
 */

/** Half what the server takes, so one request never holds the database for long. */
const BULK_CHUNK = 100;

const FAILED_VERB: Record<BankingBulkAction, string> = {
  categorize: "categorize",
  mark_reviewed: "mark reviewed",
  send_to_review: "send back to review",
};

export type BankingBulk = ReturnType<typeof useBankingBulk>;

export function useBankingBulk({
  company,
  rows,
  loaded,
  view,
  onChanged,
}: {
  company: Company;
  /** The rows on screen, in the order shown. A selection is only read through them. */
  rows: BankingRow[];
  /** Every row loaded, search aside. A ticked row that leaves them is forgotten. */
  loaded: BankingRow[];
  /** The account and tab on screen. Another one is a fresh selection. */
  view: string;
  onChanged: () => Promise<void>;
}) {
  const enabled = canWriteFinance(company);
  const dialog = useDialog();
  const [keys, setKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState<{
    action: BankingBulkAction;
    done: number;
    total: number;
  } | null>(null);
  const running = React.useRef(false);
  /** The row a shift-click extends from: the last one ticked by hand. */
  const anchor = React.useRef<string | null>(null);

  const selectable = React.useMemo(
    () => rows.filter((row) => unselectableReason(row) === null),
    [rows],
  );
  const orderRef = React.useRef<string[]>([]);
  orderRef.current = selectable.map(rowKey);
  const selected = selectable.filter((row) => keys.has(rowKey(row)));
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  React.useEffect(() => {
    anchor.current = null;
    setKeys(new Set());
  }, [view]);

  const loadedKey = React.useMemo(() => loaded.map(rowKey).join(" "), [loaded]);
  React.useEffect(() => {
    const present = new Set(loadedKey ? loadedKey.split(" ") : []);
    setKeys((current) => {
      const kept = [...current].filter((key) => present.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [loadedKey]);

  // Escape clears the selection, unless something nearer the focus — an open
  // menu, a dialog, a field being typed in — took the key first.
  const hasSelection = keys.size > 0;
  React.useEffect(() => {
    if (!hasSelection) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || running.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      anchor.current = null;
      setKeys(new Set());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasSelection]);

  const toggle = React.useCallback((row: BankingRow, extend: boolean) => {
    const key = rowKey(row);
    // Read and move the anchor outside the updater, which StrictMode runs twice.
    const from = anchor.current;
    anchor.current = key;
    setKeys((current) => toggleSelection(current, orderRef.current, key, from, extend));
  }, []);

  function toggleAll() {
    anchor.current = null;
    setKeys((current) => {
      const next = new Set(current);
      for (const row of selectable) {
        if (allSelected) next.delete(rowKey(row));
        else next.add(rowKey(row));
      }
      return next;
    });
  }

  function clear() {
    anchor.current = null;
    setKeys(new Set());
  }

  async function run(action: BankingBulkAction, category?: Account) {
    if (running.current) return;
    // A card purchase takes only an expense category; the picker said those
    // stay as they are, so they aren't sent only to be skipped.
    const targets = planFor(selected)[action].filter(
      (row) => !category || category.type === "expense" || row.kind === "bank",
    );
    if (targets.length === 0) return;
    if (action === "send_to_review") {
      const confirmation = sendToReviewConfirmation(targets);
      if (confirmation && !(await dialog.confirm(confirmation))) return;
    }
    running.current = true;
    setBusy({ action, done: 0, total: targets.length });
    const changed = new Set<string>();
    const skipped: BankingBulkResult["skipped"] = [];
    let failure: unknown = null;
    try {
      for (const part of chunk(targets, BULK_CHUNK)) {
        const result = await api.post<BankingBulkResult>(
          `/api/companies/${company.id}/banking/bulk`,
          {
            action,
            ...(category ? { accountId: category.id } : {}),
            bankTransactionIds: part.filter((row) => row.kind === "bank").map((row) => row.id),
            cardTransactionIds: part.filter((row) => row.kind === "card").map((row) => row.id),
          },
        );
        for (const id of result.succeeded.bank) changed.add(rowKey({ kind: "bank", id }));
        for (const id of result.succeeded.card) changed.add(rowKey({ kind: "card", id }));
        skipped.push(...result.skipped);
        setBusy((current) => current && { ...current, done: current.done + part.length });
      }
    } catch (err) {
      failure = err;
    } finally {
      // Whatever went through stays done, even when a later part failed.
      setKeys((current) => {
        const next = new Set(current);
        for (const key of changed) next.delete(key);
        return next;
      });
      running.current = false;
      setBusy(null);
    }
    if (changed.size > 0) await onChanged();
    const title = `Couldn’t ${FAILED_VERB[action]} the selected transactions`;
    if (failure) {
      const reason = errorMessage(failure);
      void dialog.error(
        changed.size > 0
          ? `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${changed.size} of ${targets.length} went through.`
          : failure,
        { title },
      );
    } else if (skipped.length > 0) {
      const summary = skippedSummary(skipped, action, changed.size);
      void dialog.alert({
        title: summary.title,
        variant: "danger",
        confirmLabel: "Close",
        message: (
          <div className="space-y-2">
            <ul className="space-y-1">
              {summary.reasons.map(({ reason, count }) => (
                <li key={reason} className="flex gap-2">
                  <span
                    aria-hidden
                    className="mt-2 h-1 w-1 shrink-0 rounded-full bg-current opacity-50"
                  />
                  <span>
                    {reason}
                    {skipped.length > 1 && (
                      <span className="tabular-nums text-slate-400 dark:text-slate-500">
                        {" "}
                        · {count}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {summary.rest && <p>{summary.rest}</p>}
            <p className="text-slate-500 dark:text-slate-400">
              {skipped.length === 1 ? "It is still ticked." : "They are still ticked."}
            </p>
          </div>
        ),
      });
    }
  }

  return {
    /** Whether this Member may change finances, and so tick rows at all. */
    enabled,
    keys,
    /** The ticked rows still on screen — what the bar counts and acts on. */
    selected,
    selectableCount: selectable.length,
    allSelected,
    busy,
    toggle,
    toggleAll,
    clear,
    run,
  };
}

/**
 * The checkbox over the list that ticks everything in view, and how many are.
 * The list comes a page at a time, so while older pages wait behind Load
 * older (`partial`) it says "in view": it ticks what is loaded, never rows the
 * person hasn't seen.
 */
export function BankingSelectAll({
  bulk,
  searching,
  partial = false,
}: {
  bulk: BankingBulk;
  searching: boolean;
  partial?: boolean;
}) {
  const count = bulk.selected.length;
  const none = bulk.selectableCount === 0;
  return (
    <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/30">
      <Checkbox
        checked={bulk.allSelected}
        indeterminate={count > 0}
        disabled={none || bulk.busy !== null}
        title={none ? "Nothing in view can be changed in bulk" : undefined}
        onChange={bulk.toggleAll}
        label={
          bulk.allSelected
            ? "Clear selection"
            : searching && !partial
              ? "Select every matching transaction"
              : "Select every transaction in view"
        }
      />
      <span className="text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300">
        {count > 0
          ? `${count} of ${bulk.selectableCount} selected`
          : none
            ? "Nothing here to change in bulk"
            : partial
              ? `Select all ${bulk.selectableCount} in view`
              : searching
                ? `Select all ${bulk.selectableCount} matching`
                : `Select all ${bulk.selectableCount}`}
      </span>
      {count > 0 && (
        <button
          type="button"
          onClick={bulk.clear}
          disabled={bulk.busy !== null}
          className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-60 dark:text-indigo-400"
        >
          Clear
        </button>
      )}
      {!none && (
        <span className="ml-auto hidden text-xs text-slate-400 sm:inline dark:text-slate-500">
          Shift-click to select a range
        </span>
      )}
    </div>
  );
}

/**
 * The floating bar over a selection. Each verb shows only when a ticked row
 * can take it, and acts on just those rows.
 */
export function BankingBulkBar({
  bulk,
  accounts,
  bankLedgerAccountOf,
}: {
  bulk: BankingBulk;
  accounts: Account[];
  bankLedgerAccountOf: (feedId: string) => string | undefined;
}) {
  const plan = planFor(bulk.selected);
  const { busy } = bulk;
  const [picking, setPicking] = React.useState(false);
  const categorizeRef = React.useRef<HTMLButtonElement>(null);
  const groups = categoryGroups(accounts, plan.categorize, bankLedgerAccountOf);
  const waiting = plan.mark_reviewed.length;
  const done = plan.send_to_review.length;

  // A selection that can no longer take a category closes the picker.
  const canCategorize = plan.categorize.length > 0;
  React.useEffect(() => {
    if (!canCategorize) setPicking(false);
  }, [canCategorize]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected transactions"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full border border-slate-200 bg-white/95 py-1.5 pl-2 pr-1.5 shadow-lg backdrop-blur sm:gap-1 dark:border-slate-700 dark:bg-slate-900/95"
      >
        <span
          aria-live="polite"
          className="flex items-center gap-2 whitespace-nowrap px-1.5 text-sm font-medium text-slate-700 dark:text-slate-200"
        >
          {busy ? (
            <>
              <ButtonSpinner className="text-indigo-600 dark:text-indigo-400" />
              <span className="tabular-nums">
                {BULK_PROGRESS[busy.action]}{" "}
                {busy.total > BULK_CHUNK ? `${busy.done} of ${busy.total}` : busy.total}…
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-indigo-600 px-1.5 text-xs font-semibold tabular-nums text-white dark:bg-indigo-500">
                {bulk.selected.length}
              </span>
              selected
            </>
          )}
        </span>
        <span
          aria-hidden="true"
          className="mx-0.5 h-4 w-px shrink-0 bg-slate-200 sm:mx-1 dark:bg-slate-700"
        />
        {canCategorize && (
          <Button
            ref={categorizeRef}
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setPicking((open) => !open)}
            loading={busy?.action === "categorize"}
            disabled={busy !== null}
            aria-haspopup="dialog"
            aria-expanded={picking}
            title={`File ${plural(plan.categorize.length, "transaction")} under one category`}
          >
            <Tag size={14} className="hidden sm:block" />
            Categorize
            <ChevronDown
              size={13}
              className={clsx("transition-transform", picking && "rotate-180")}
            />
          </Button>
        )}
        {waiting > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void bulk.run("mark_reviewed")}
            loading={busy?.action === "mark_reviewed"}
            disabled={busy !== null}
            aria-label="Mark reviewed"
            title={`Keep the categories of ${plural(waiting, "card purchase")} waiting for review, and move ${waiting === 1 ? "it" : "them"} to Done`}
          >
            {/* A phone keeps the icons, so the bar fits. */}
            <Check size={14} />
            <span className="hidden sm:inline">Mark reviewed</span>
          </Button>
        )}
        {done > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void bulk.run("send_to_review")}
            loading={busy?.action === "send_to_review"}
            disabled={busy !== null}
            aria-label="Send to review"
            title={`Put ${plural(done, "done transaction")} back in To review`}
          >
            <RotateCcw size={14} />
            <span className="hidden sm:inline">Send to review</span>
          </Button>
        )}
        <button
          type="button"
          onClick={bulk.clear}
          disabled={busy !== null}
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          className="ml-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={14} />
        </button>
      </div>
      {picking && canCategorize && (
        <CategoryPicker
          anchorRef={categorizeRef}
          groups={groups}
          rows={plan.categorize}
          onApply={(category) => {
            setPicking(false);
            void bulk.run("categorize", category);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function normalise(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/**
 * The category list Categorize opens above the bar: search, pick one, and
 * the footer says what will happen before Categorize does it. Enter picks the
 * highlighted category, and Enter on the picked one applies it.
 */
function CategoryPicker({
  anchorRef,
  groups,
  rows,
  onApply,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  groups: CategoryGroup[];
  /** The ticked rows Categorize acts on. */
  rows: BankingRow[];
  onApply: (category: Account) => void;
  onClose: () => void;
}) {
  const listId = React.useId();
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<Account | null>(null);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const markPressInside = useCloseOnPressOutside(true, onClose, anchorRef);
  useCloseOnEscape(true, onClose);

  React.useLayoutEffect(() => {
    function place() {
      const trigger = anchorRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 16);
      const left = Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8),
      );
      setPosition({ left, bottom: window.innerHeight - rect.top + 12, width });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef]);

  const terms = normalise(query).split(/\s+/).filter(Boolean);
  const shown = groups
    .map((group) => ({
      ...group,
      accounts: group.accounts.filter((account) => {
        const text = normalise(`${account.code} ${account.name} ${group.label}`);
        return terms.every((term) => text.includes(term));
      }),
    }))
    .filter((group) => group.accounts.length > 0);
  const flat = shown.flatMap((group) => group.accounts);
  const activeAccount = flat[Math.min(active, flat.length - 1)];

  React.useEffect(() => setActive(0), [query]);

  // Keep the highlighted category in view as the arrow keys move it.
  React.useEffect(() => {
    if (!activeAccount) return;
    document.getElementById(`${listId}-${activeAccount.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeAccount, listId]);

  function choose(account: Account) {
    if (picked?.id === account.id) onApply(account);
    else setPicked(account);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeAccount) choose(activeAccount);
    }
  }

  const cards = rows.filter((row) => row.kind === "card").length;
  const cardsLeft = picked && picked.type !== "expense" ? cards : 0;
  const applies = rows.length - cardsLeft;

  if (!position || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="Categorize the selected transactions"
      onMouseDownCapture={markPressInside}
      style={{ left: position.left, bottom: position.bottom, width: position.width }}
      className="fixed z-50 flex max-h-[min(30rem,calc(100vh-7rem))] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <label className="relative block">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeAccount ? `${listId}-${activeAccount.id}` : undefined}
            aria-label="Search categories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search categories"
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Categories"
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No category matches “{query.trim()}”.
          </p>
        ) : (
          shown.map((group) => (
            <div key={group.type} role="group" aria-label={group.label}>
              <div className="sticky top-0 z-10 bg-white/95 px-3 pb-1 pt-2 text-xs font-medium text-slate-400 backdrop-blur dark:bg-slate-900/95 dark:text-slate-500 inline-block first-letter:uppercase">
                {group.label}
              </div>
              {group.accounts.map((account) => {
                const isPicked = picked?.id === account.id;
                const isActive = activeAccount?.id === account.id;
                return (
                  <button
                    key={account.id}
                    id={`${listId}-${account.id}`}
                    type="button"
                    role="option"
                    aria-selected={isPicked}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(flat.indexOf(account))}
                    onClick={() => choose(account)}
                    onDoubleClick={() => onApply(account)}
                    className={clsx(
                      "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm",
                      isPicked
                        ? "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200"
                        : isActive
                          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                          : "text-slate-700 dark:text-slate-200",
                    )}
                  >
                    <span
                      className={clsx(
                        "w-10 shrink-0 font-mono text-xs tabular-nums",
                        isPicked
                          ? "text-indigo-500 dark:text-indigo-300"
                          : "text-slate-400 dark:text-slate-500",
                      )}
                    >
                      {account.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{account.name}</span>
                    <Check
                      aria-hidden="true"
                      size={14}
                      className={clsx(
                        "shrink-0 text-indigo-600 dark:text-indigo-400",
                        !isPicked && "invisible",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-slate-100 bg-slate-50/80 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-slate-600 dark:text-slate-300">
            {picked ? (
              <>
                <span className="tabular-nums">{plural(applies, "transaction")}</span> to{" "}
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {picked.code} {picked.name}
                </span>
              </>
            ) : (
              <>Pick a category for {plural(rows.length, "transaction")}</>
            )}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => picked && onApply(picked)}
            disabled={!picked || applies === 0}
          >
            Categorize
          </Button>
        </div>
        {cardsLeft > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            A card purchase takes only an expense category, so{" "}
            {cardsLeft === 1 ? "the card purchase stays" : `the ${cardsLeft} card purchases stay`}{" "}
            as {cardsLeft === 1 ? "it is" : "they are"}.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
