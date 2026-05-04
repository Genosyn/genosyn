import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  Account,
  api,
  formatMoney,
  LedgerEntry,
  LedgerEntrySource,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const SOURCE_BADGE: Record<LedgerEntrySource, { label: string; cls: string }> = {
  manual: {
    label: "Manual",
    cls: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  },
  invoice_issue: {
    label: "Invoice issued",
    cls: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  },
  invoice_payment: {
    label: "Payment",
    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  invoice_void: {
    label: "Reversal",
    cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
};

/**
 * Journal — chronological feed of every `LedgerEntry`. Phase B of the
 * Finance milestone (M19).
 *
 * Each row expands to show its `LedgerLine` legs. Auto-posted entries
 * (from invoice issue / payment / void) are not deletable here; only
 * `manual` entries can be deleted.
 */
export default function FinanceJournal() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [entries, setEntries] = React.useState<LedgerEntry[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [showNew, setShowNew] = React.useState(false);

  const reload = React.useCallback(async () => {
    const [es, as] = await Promise.all([
      api.get<LedgerEntry[]>(`/api/companies/${company.id}/ledger-entries`),
      api.get<Account[]>(`/api/companies/${company.id}/accounts`),
    ]);
    setEntries(es);
    setAccounts(as);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setEntries([]));
  }, [reload]);

  async function remove(e: LedgerEntry) {
    const ok = await dialog.confirm({
      title: "Delete this manual entry?",
      message: "The lines disappear from the trial balance immediately.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/ledger-entries/${e.id}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const accountById = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Journal" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Journal
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Every double-entry transaction in chronological order. Invoice
            issue / payment / void rows are auto-posted; manual rows are
            for accountant adjustments.
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus size={14} /> Manual entry
        </Button>
      </div>

      {entries === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No journal entries yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Issue an invoice or post a manual entry to populate the ledger.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                accountById={accountById}
                companySlug={company.slug}
                onDelete={() => remove(e)}
              />
            ))}
          </ul>
        </div>
      )}

      {showNew && (
        <NewEntryModal
          companyId={company.id}
          accounts={accounts}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EntryRow({
  entry,
  accountById,
  companySlug,
  onDelete,
}: {
  entry: LedgerEntry;
  accountById: Map<string, Account>;
  companySlug: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const badge = SOURCE_BADGE[entry.source];
  const total = entry.lines.reduce((s, l) => s + l.debitCents, 0);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
      >
        <span className="text-slate-400">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="w-24 font-mono text-xs text-slate-500 dark:text-slate-400">
          {new Date(entry.date).toISOString().slice(0, 10)}
        </span>
        <span
          className={
            "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
            badge.cls
          }
        >
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
          {entry.memo || <span className="text-slate-400">(no memo)</span>}
        </span>
        <span className="tabular-nums text-sm font-medium text-slate-900 dark:text-slate-100">
          {formatMoney(total, "USD")}
        </span>
        {entry.source === "manual" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            aria-label="Delete entry"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
          {entry.sourceRefId && entry.source !== "manual" && (
            <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              Source ref: <span className="font-mono">{entry.sourceRefId}</span>
              {entry.source === "invoice_issue" && (
                <>
                  {" · "}
                  <Link
                    to={`/c/${companySlug}/finance/invoices`}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    open invoice
                  </Link>
                </>
              )}
            </div>
          )}
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="w-20 px-2 py-1 text-left font-medium">Code</th>
                <th className="px-2 py-1 text-left font-medium">Account</th>
                <th className="px-2 py-1 text-left font-medium">Description</th>
                <th className="w-32 px-2 py-1 text-right font-medium">Debit</th>
                <th className="w-32 px-2 py-1 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((l) => {
                const a = accountById.get(l.accountId);
                return (
                  <tr key={l.id} className="border-t border-slate-100 dark:border-slate-700">
                    <td className="px-2 py-1 font-mono text-slate-500 dark:text-slate-400">
                      {a?.code ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200">
                      {a?.name ?? "(missing account)"}
                    </td>
                    <td className="px-2 py-1 text-slate-500 dark:text-slate-400">
                      {l.description}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {l.debitCents > 0 ? formatMoney(l.debitCents, "USD") : ""}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {l.creditCents > 0 ? formatMoney(l.creditCents, "USD") : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

type DraftLine = {
  key: string;
  accountId: string;
  side: "debit" | "credit";
  amountText: string;
  description: string;
};

function emptyLine(side: "debit" | "credit"): DraftLine {
  return {
    key: Math.random().toString(36).slice(2, 10),
    accountId: "",
    side,
    amountText: "",
    description: "",
  };
}

function NewEntryModal({
  companyId,
  accounts,
  onClose,
  onSaved,
}: {
  companyId: string;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = React.useState("");
  const [lines, setLines] = React.useState<DraftLine[]>([
    emptyLine("debit"),
    emptyLine("credit"),
  ]);
  const [busy, setBusy] = React.useState(false);

  const totals = React.useMemo(() => {
    let d = 0;
    let c = 0;
    for (const l of lines) {
      const cents = parseMoneyToCents(l.amountText);
      if (l.side === "debit") d += cents;
      else c += cents;
    }
    return { d, c, balanced: d === c && d > 0 };
  }, [lines]);

  function patch(idx: number, p: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...p } : l)));
  }

  function add(side: "debit" | "credit") {
    setLines((ls) => [...ls, emptyLine(side)]);
  }

  function remove(idx: number) {
    setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, i) => i !== idx)));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!totals.balanced) {
      toast("Debits and credits must match", "error");
      return;
    }
    setBusy(true);
    try {
      const payload = lines
        .filter((l) => l.accountId && parseMoneyToCents(l.amountText) > 0)
        .map((l) => {
          const cents = parseMoneyToCents(l.amountText);
          return {
            accountId: l.accountId,
            debitCents: l.side === "debit" ? cents : 0,
            creditCents: l.side === "credit" ? cents : 0,
            description: l.description,
          };
        });
      await api.post(`/api/companies/${companyId}/ledger-entries`, {
        date: new Date(date).toISOString(),
        memo,
        lines: payload,
      });
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New manual entry" size="xl">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <div className="sm:col-span-2">
            <Input
              label="Memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              maxLength={1000}
              placeholder="e.g. Bank charge for July"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Account</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="w-24 px-3 py-2 text-left font-medium">Side</th>
                <th className="w-32 px-3 py-2 text-right font-medium">Amount</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="px-2 py-2">
                    <select
                      value={l.accountId}
                      onChange={(e) => patch(i, { accountId: e.target.value })}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                      required
                    >
                      <option value="">— Pick account —</option>
                      {accounts
                        .filter((a) => !a.archivedAt)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} {a.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      value={l.description}
                      onChange={(e) => patch(i, { description: e.target.value })}
                      placeholder="Optional"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={l.side}
                      onChange={(e) =>
                        patch(i, { side: e.target.value as "debit" | "credit" })
                      }
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    >
                      <option value="debit">Debit</option>
                      <option value="credit">Credit</option>
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      value={l.amountText}
                      onChange={(e) => patch(i, { amountText: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      disabled={lines.length <= 2}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      aria-label="Remove line"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => add("debit")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              <Plus size={12} /> Debit line
            </button>
            <button
              type="button"
              onClick={() => add("credit")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              <Plus size={12} /> Credit line
            </button>
          </div>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-slate-500 dark:text-slate-400">Debits:</span>{" "}
              <span className="tabular-nums text-slate-900 dark:text-slate-100">
                {formatMoney(totals.d, "USD")}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-slate-400">Credits:</span>{" "}
              <span className="tabular-nums text-slate-900 dark:text-slate-100">
                {formatMoney(totals.c, "USD")}
              </span>
            </div>
            <div
              className={
                totals.balanced
                  ? "font-semibold text-emerald-600 dark:text-emerald-400"
                  : "font-semibold text-amber-600 dark:text-amber-400"
              }
            >
              {totals.balanced ? "Balanced" : "Unbalanced"}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !totals.balanced}>
            Post entry
          </Button>
        </div>
      </form>
    </Modal>
  );
}
