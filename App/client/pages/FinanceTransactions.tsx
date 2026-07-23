import React from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Search,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  Account,
  api,
  formatMoney,
  LedgerBulkAction,
  LedgerBulkResult,
  LedgerEntry,
  LedgerReviewStatus,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

type ReviewSummary = {
  unreviewed: number;
  aiReviewed: number;
  approved: number;
};

const STATUS_TABS: Array<{
  value: LedgerReviewStatus;
  label: string;
  description: string;
}> = [
  {
    value: "unreviewed",
    label: "Needs review",
    description: "Posted transactions not checked yet",
  },
  {
    value: "ai_reviewed",
    label: "AI reviewed",
    description: "Category proposals ready for a human",
  },
  {
    value: "approved",
    label: "Approved",
    description: "Final human sign-off complete",
  },
];

const STATUS_STYLE: Record<LedgerReviewStatus, string> = {
  unreviewed:
    "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  ai_reviewed:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-500/10 dark:text-violet-300",
  approved:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300",
};

function statusLabel(status: LedgerReviewStatus): string {
  if (status === "ai_reviewed") return "AI reviewed";
  if (status === "approved") return "Approved";
  return "Needs review";
}

function sourceLabel(source: LedgerEntry["source"]): string {
  return source
    .replace("invoice_", "invoice ")
    .replace("brex_card_", "card ")
    .replace("ledger_reclass", "category change")
    .replaceAll("_", " ");
}

/** A checkbox that can render the third "some but not all" state, which HTML
 *  only exposes through the imperative `indeterminate` property. */
function TriCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
  className = "",
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  ariaLabel: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      className={
        "h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-indigo-600 dark:border-slate-600 " +
        className
      }
    />
  );
}

export default function FinanceTransactions() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get("status");
  const status: LedgerReviewStatus =
    rawStatus === "ai_reviewed" || rawStatus === "approved" ? rawStatus : "unreviewed";
  const [rows, setRows] = React.useState<LedgerEntry[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[] | null>(null);
  const [summary, setSummary] = React.useState<ReviewSummary | null>(null);
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<LedgerEntry | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<"approve" | "delete" | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const canApprove = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      const [entries, accountRows, counts] = await Promise.all([
        api.get<LedgerEntry[]>(
          `/api/companies/${company.id}/ledger-entries?reviewStatus=${status}&limit=500`,
        ),
        api.get<Account[]>(`/api/companies/${company.id}/accounts`),
        api.get<ReviewSummary>(`/api/companies/${company.id}/ledger-review-summary`),
      ]);
      setRows(entries);
      setAccounts(accountRows);
      setSummary(counts);
      setSelected((current) =>
        current ? (entries.find((entry) => entry.id === current.id) ?? null) : null,
      );
    } catch (err) {
      setRows([]);
      setAccounts([]);
      toast((err as Error).message || "Could not load transactions", "error");
    }
  }, [company.id, status, toast]);

  React.useEffect(() => {
    setRows(null);
    setSelectedIds(new Set());
    void reload();
  }, [reload]);

  const accountById = React.useMemo(
    () => new Map((accounts ?? []).map((account) => [account.id, account])),
    [accounts],
  );
  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows ?? [];
    return (rows ?? []).filter((entry) => {
      const accountText = entry.lines
        .map((line) => {
          const account = accountById.get(line.accountId);
          return `${account?.code ?? ""} ${account?.name ?? ""}`;
        })
        .join(" ");
      return `${entry.memo} ${entry.source} ${accountText}`.toLowerCase().includes(needle);
    });
  }, [accountById, rows, search]);

  // Selection is kept as a set of ids and reconciled against the loaded rows so
  // a lingering id (deleted or filtered away) never drives a bulk call.
  const selectedEntries = React.useMemo(
    () => (rows ?? []).filter((entry) => selectedIds.has(entry.id)),
    [rows, selectedIds],
  );
  const selectedCount = selectedEntries.length;
  const selectedInView = filtered.filter((entry) => selectedIds.has(entry.id)).length;
  const allSelected = filtered.length > 0 && selectedInView === filtered.length;
  const someSelected = selectedInView > 0 && !allSelected;

  const anyApprovable = selectedEntries.some((entry) => entry.reviewStatus !== "approved");
  const anyReturnable = selectedEntries.some((entry) => entry.reviewStatus === "ai_reviewed");
  const anyDeletable = selectedEntries.some(
    (entry) => entry.source === "manual" && entry.reviewStatus !== "approved",
  );

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllInView() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) filtered.forEach((entry) => next.delete(entry.id));
      else filtered.forEach((entry) => next.add(entry.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function runBulk(action: LedgerBulkAction, toAccountId?: string) {
    const ids = selectedEntries.map((entry) => entry.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const result = await api.post<LedgerBulkResult>(
        `/api/companies/${company.id}/ledger-entries/bulk`,
        { action, ids, toAccountId },
      );
      const okN = result.succeeded.length;
      const skipN = result.skipped.length;
      const verb =
        action === "approve"
          ? "Approved"
          : action === "return"
            ? "Returned"
            : action === "delete"
              ? "Deleted"
              : "Recategorized";
      if (okN > 0) {
        toast(
          `${verb} ${okN} transaction${okN === 1 ? "" : "s"}${
            skipN ? ` · ${skipN} skipped` : ""
          }`,
          skipN ? "info" : "success",
        );
      } else {
        toast(
          skipN ? `Nothing changed — ${result.skipped[0].reason}` : "Nothing to update",
          "error",
        );
      }
      setConfirmAction(null);
      setPickerOpen(false);
      clearSelection();
      await reload();
    } catch (err) {
      toast((err as Error).message || "Bulk action failed", "error");
    } finally {
      setBulkBusy(false);
    }
  }

  function pickStatus(next: LedgerReviewStatus) {
    setSearchParams(next === "unreviewed" ? {} : { status: next });
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-8">
      <Breadcrumbs
        items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Transactions" }]}
      />
      <div className="mt-5">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Transaction review
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Check every posting and its account categories. AI employees can prepare category changes,
          but only a human owner or admin can apply them and give final approval.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {STATUS_TABS.map((tab) => {
          const count =
            tab.value === "unreviewed"
              ? summary?.unreviewed
              : tab.value === "ai_reviewed"
                ? summary?.aiReviewed
                : summary?.approved;
          const Icon =
            tab.value === "unreviewed"
              ? Clock3
              : tab.value === "ai_reviewed"
                ? Sparkles
                : CheckCircle2;
          return (
            <button
              key={tab.value}
              onClick={() => pickStatus(tab.value)}
              className={
                "rounded-xl border p-4 text-left shadow-sm transition " +
                (status === tab.value
                  ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 dark:border-indigo-700 dark:bg-indigo-500/10 dark:ring-indigo-900"
                  : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600")
              }
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <Icon size={15} /> {tab.label}
                </span>
                <span className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {count ?? "—"}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{tab.description}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {statusLabel(status)} transactions
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Open a row to inspect every debit and credit before deciding.
            </p>
          </div>
          <label className="relative block sm:w-72">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-2.5 text-slate-400"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search memo, source, or account"
              className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-indigo-900"
            />
          </label>
        </div>

        {rows === null || accounts === null ? (
          <div className="flex justify-center p-16">
            <Spinner size={20} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-14 text-center">
            <CheckCircle2 className="mx-auto text-slate-300 dark:text-slate-600" size={28} />
            <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              No {statusLabel(status).toLowerCase()} transactions
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              New ledger postings appear here automatically.
            </p>
          </div>
        ) : (
          <>
            <div
              className={
                "sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-2 backdrop-blur " +
                (selectedCount > 0
                  ? "border-indigo-200 bg-indigo-50/90 dark:border-indigo-900 dark:bg-indigo-950/70"
                  : "border-slate-100 bg-white/90 dark:border-slate-800 dark:bg-slate-900/90")
              }
            >
              <TriCheckbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={toggleAllInView}
                ariaLabel={allSelected ? "Clear selection" : "Select all transactions"}
              />
              {selectedCount === 0 ? (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Select transactions to approve, recategorize, or delete together.
                </span>
              ) : (
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
                    {selectedCount} selected
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {canApprove && anyApprovable && (
                      <Button
                        size="sm"
                        onClick={() => setConfirmAction("approve")}
                        disabled={bulkBusy}
                      >
                        <CheckCircle2 size={14} /> Approve
                      </Button>
                    )}
                    {canApprove && anyReturnable && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void runBulk("return")}
                        disabled={bulkBusy}
                      >
                        <Undo2 size={14} /> Return
                      </Button>
                    )}
                    {canApprove && anyApprovable && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setPickerOpen(true)}
                        disabled={bulkBusy}
                      >
                        <Tags size={14} /> Change category
                      </Button>
                    )}
                    {anyDeletable && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setConfirmAction("delete")}
                        disabled={bulkBusy}
                      >
                        <Trash2 size={14} /> Delete
                      </Button>
                    )}
                    <button
                      onClick={clearSelection}
                      disabled={bulkBusy}
                      aria-label="Clear selection"
                      className="rounded-md p-1.5 text-slate-500 hover:bg-white/70 hover:text-slate-700 disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              )}
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((entry) => {
                const isSelected = selectedIds.has(entry.id);
                return (
                  <li
                    key={entry.id}
                    className={
                      "flex items-center gap-3 pl-4 transition-colors " +
                      (isSelected
                        ? "bg-indigo-50/70 dark:bg-indigo-950/40"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/50")
                    }
                  >
                    <TriCheckbox
                      checked={isSelected}
                      onChange={() => toggleOne(entry.id)}
                      ariaLabel={`Select ${entry.memo || "transaction"}`}
                    />
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-4 text-left"
                      onClick={() => setSelected(entry)}
                    >
                      <div className="hidden w-24 shrink-0 font-mono text-xs text-slate-500 sm:block dark:text-slate-400">
                        {new Date(entry.date).toISOString().slice(0, 10)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                          {entry.memo || "Untitled transaction"}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="capitalize">{sourceLabel(entry.source)}</span>
                          <span>·</span>
                          <span>{entry.lines.length} ledger lines</span>
                          {entry.reviewedByEmployee && (
                            <>
                              <span>·</span>
                              <span className="text-violet-600 dark:text-violet-300">
                                Reviewed by {entry.reviewedByEmployee.name}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <span
                        className={`hidden rounded-full border px-2 py-0.5 text-[10px] font-semibold sm:inline-flex ${STATUS_STYLE[entry.reviewStatus]}`}
                      >
                        {statusLabel(entry.reviewStatus)}
                      </span>
                      <div className="w-28 text-right text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(entry.totalCents, "USD")}
                      </div>
                      <ChevronRight size={15} className="text-slate-400" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {confirmAction && (
        <BulkConfirmModal
          action={confirmAction}
          count={selectedCount}
          busy={bulkBusy}
          onClose={() => (bulkBusy ? undefined : setConfirmAction(null))}
          onConfirm={() => void runBulk(confirmAction)}
        />
      )}

      {pickerOpen && accounts && (
        <BulkCategoryModal
          accounts={accounts}
          count={selectedCount}
          busy={bulkBusy}
          onClose={() => (bulkBusy ? undefined : setPickerOpen(false))}
          onApply={(accountId) => void runBulk("recategorize", accountId)}
        />
      )}

      {selected && accounts && (
        <TransactionReviewModal
          key={`${selected.id}-${selected.reviewStatus}-${selected.reviewedAt ?? ""}`}
          companyId={company.id}
          canApprove={company.role === "owner" || company.role === "admin"}
          entry={selected}
          accounts={accounts}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            setSelected(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function BulkConfirmModal({
  action,
  count,
  busy,
  onClose,
  onConfirm,
}: {
  action: "approve" | "delete";
  count: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isDelete = action === "delete";
  const plural = count === 1 ? "" : "s";
  return (
    <Modal
      open
      onClose={onClose}
      title={isDelete ? "Delete transactions" : "Approve transactions"}
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {isDelete ? (
          <>
            You&apos;re about to delete {count} selected transaction{plural}. Only unapproved,
            manually posted drafts are removed — approved or auto-posted entries are skipped and left
            untouched.
          </>
        ) : (
          <>
            Approve {count} selected transaction{plural}? Any staged category changes are posted to
            the ledger and each transaction gets final human sign-off. Rows already approved are
            skipped.
          </>
        )}
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={isDelete ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {busy ? (
            <Spinner size={14} />
          ) : isDelete ? (
            <Trash2 size={14} />
          ) : (
            <CheckCircle2 size={14} />
          )}
          {isDelete ? "Delete" : "Approve"} {count}
        </Button>
      </div>
    </Modal>
  );
}

function BulkCategoryModal({
  accounts,
  count,
  busy,
  onClose,
  onApply,
}: {
  accounts: Account[];
  count: number;
  busy: boolean;
  onClose: () => void;
  onApply: (accountId: string) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [picked, setPicked] = React.useState<string | null>(null);
  const options = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return accounts
      .filter((account) => !account.archivedAt)
      .filter((account) => account.type === "expense" || account.type === "revenue")
      .filter(
        (account) => !needle || `${account.code} ${account.name}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, search]);
  const groups: Array<{ label: string; list: Account[] }> = [
    { label: "Expense", list: options.filter((account) => account.type === "expense") },
    { label: "Revenue", list: options.filter((account) => account.type === "revenue") },
  ];
  const plural = count === 1 ? "" : "s";

  return (
    <Modal open onClose={onClose} title="Change category" size="lg">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Apply one category to {count} selected transaction{plural} and approve them. Each
        transaction&apos;s single expense or revenue line moves to the category you pick;
        transactions with a different shape — no matching line, or more than one — are skipped so you
        can open them individually.
      </p>
      <label className="relative mt-4 block">
        <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-400" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search categories"
          className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-indigo-900"
        />
      </label>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
        {options.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No matching categories
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {groups.map((group) =>
              group.list.length === 0 ? null : (
                <div key={group.label}>
                  <div className="bg-slate-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {group.label}
                  </div>
                  {group.list.map((account) => (
                    <button
                      key={account.id}
                      onClick={() => setPicked(account.id)}
                      className={
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm " +
                        (picked === account.id
                          ? "bg-indigo-50 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/50")
                      }
                    >
                      <span className="font-mono text-xs text-slate-400">{account.code}</span>
                      <span className="truncate text-slate-700 dark:text-slate-200">
                        {account.name}
                      </span>
                      {picked === account.id && (
                        <CheckCircle2
                          size={14}
                          className="ml-auto text-indigo-600 dark:text-indigo-300"
                        />
                      )}
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => picked && onApply(picked)} disabled={busy || !picked}>
          {busy ? <Spinner size={14} /> : <Tags size={14} />} Apply &amp; approve
        </Button>
      </div>
    </Modal>
  );
}

function TransactionReviewModal({
  companyId,
  canApprove,
  entry,
  accounts,
  onClose,
  onChanged,
}: {
  companyId: string;
  canApprove: boolean;
  entry: LedgerEntry;
  accounts: Account[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const accountById = React.useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const proposedByLine = React.useMemo(
    () => new Map(entry.reviewChanges.map((change) => [change.lineId, change.toAccountId])),
    [entry.reviewChanges],
  );
  const [categories, setCategories] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      entry.lines.map((line) => [line.id, proposedByLine.get(line.id) ?? line.accountId]),
    ),
  );
  const [note, setNote] = React.useState(entry.reviewNote ?? "");
  const [busy, setBusy] = React.useState(false);

  const changes = entry.lines
    .filter((line) => categories[line.id] && categories[line.id] !== line.accountId)
    .map((line) => ({ lineId: line.id, accountId: categories[line.id] }));

  async function approve() {
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/ledger-entries/${entry.id}/approve`, {
        changes,
        note,
      });
      toast(
        changes.length > 0
          ? "Transaction approved and category changes posted"
          : "Transaction approved",
        "success",
      );
      await onChanged();
    } catch (err) {
      toast((err as Error).message || "Could not approve transaction", "error");
    } finally {
      setBusy(false);
    }
  }

  async function returnToQueue() {
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/ledger-entries/${entry.id}/return`, {
        note,
      });
      toast("Transaction returned to the AI review queue", "success");
      await onChanged();
    } catch (err) {
      toast((err as Error).message || "Could not return transaction", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Review transaction" size="xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {entry.memo || "Untitled transaction"}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {new Date(entry.date).toISOString().slice(0, 10)} ·{" "}
            <span className="capitalize">{sourceLabel(entry.source)}</span> · ID{" "}
            <span className="font-mono">{entry.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(entry.totalCents, "USD")}
          </div>
          <span
            className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[entry.reviewStatus]}`}
          >
            {statusLabel(entry.reviewStatus)}
          </span>
        </div>
      </div>

      {entry.reviewedByEmployee && (
        <div className="mt-5 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-500/10 dark:text-violet-200">
          <div className="flex items-center gap-2 font-medium">
            <Sparkles size={14} /> {entry.reviewedByEmployee.name} semi-approved this
          </div>
          <p className="mt-1 text-xs text-violet-700 dark:text-violet-300">
            Any category changes below are proposals only. They enter the ledger when a human gives
            final approval.
          </p>
        </div>
      )}

      <div className="mt-5 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Ledger line</th>
              <th className="px-3 py-2 text-left font-medium">Account category</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Debit</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {entry.lines.map((line) => {
              const current = accountById.get(line.accountId);
              const editable = current?.type === "expense" || current?.type === "revenue";
              return (
                <tr key={line.id}>
                  <td className="px-3 py-3">
                    <div className="text-slate-800 dark:text-slate-100">
                      {line.description || "No description"}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-slate-400">
                      {line.id.slice(0, 8)}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {editable ? (
                      <select
                        value={categories[line.id] ?? line.accountId}
                        onChange={(event) =>
                          setCategories((values) => ({
                            ...values,
                            [line.id]: event.target.value,
                          }))
                        }
                        disabled={!canApprove || entry.reviewStatus === "approved" || busy}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm disabled:opacity-70 dark:border-slate-700 dark:bg-slate-950"
                      >
                        {accounts
                          .filter(
                            (account) => !account.archivedAt && account.type === current?.type,
                          )
                          .map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.code} {account.name}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <div>
                        <div className="text-slate-700 dark:text-slate-200">
                          {current ? `${current.code} ${current.name}` : "Missing account"}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          Control account · reviewed, not recategorized
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {line.debitCents > 0 ? formatMoney(line.debitCents, "USD") : "—"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {line.creditCents > 0 ? formatMoney(line.creditCents, "USD") : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <label className="mt-5 block">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Review note</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={!canApprove || entry.reviewStatus === "approved" || busy}
          maxLength={2000}
          rows={3}
          placeholder="Why the categories are correct, or what needs another look"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-70 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-indigo-900"
        />
      </label>

      {!canApprove && entry.reviewStatus !== "approved" && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          You can inspect this transaction, but final approval is limited to company owners and
          admins.
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Close
        </Button>
        {canApprove && entry.reviewStatus === "ai_reviewed" && (
          <Button variant="ghost" onClick={returnToQueue} disabled={busy}>
            <Undo2 size={14} /> Return for another look
          </Button>
        )}
        {canApprove && entry.reviewStatus !== "approved" && (
          <Button onClick={approve} disabled={busy}>
            {busy ? <Spinner size={14} /> : <CheckCircle2 size={14} />}
            Approve transaction
          </Button>
        )}
      </div>
    </Modal>
  );
}
