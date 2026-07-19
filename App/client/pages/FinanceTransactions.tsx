import React from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { CheckCircle2, ChevronRight, Clock3, Search, Sparkles, Undo2 } from "lucide-react";
import { Account, api, formatMoney, LedgerEntry, LedgerReviewStatus } from "../lib/api";
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
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((entry) => (
              <li key={entry.id}>
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  onClick={() => setSelected(entry)}
                >
                  <div className="w-24 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
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
            ))}
          </ul>
        )}
      </div>

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
