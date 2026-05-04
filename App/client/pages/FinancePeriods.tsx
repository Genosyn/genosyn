import React from "react";
import { useOutletContext } from "react-router-dom";
import { Download, Lock, Plus, Trash2, Unlock } from "lucide-react";
import { AccountingPeriod, api } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Periods + accountant exports. Phase F of the Finance milestone (M19).
 *
 * Two sections:
 *   - Periods: define fiscal months/quarters/years, then close them
 *     to roll P&L into Retained Earnings and lock the window.
 *   - Exports: download CSVs of customers / invoices / general
 *     journal / trial balance for handing off to the company's
 *     external accountant.
 */
export default function FinancePeriods() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();

  const [periods, setPeriods] = React.useState<AccountingPeriod[] | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    const list = await api.get<AccountingPeriod[]>(
      `/api/companies/${company.id}/periods`,
    );
    setPeriods(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setPeriods([]));
  }, [reload]);

  async function close(p: AccountingPeriod) {
    const ok = await dialog.confirm({
      title: `Close ${p.name}?`,
      message:
        "Posts a closing entry that rolls revenue and expenses into 3100 Retained Earnings, then locks every entry dated inside the period.",
      confirmLabel: "Close period",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/companies/${company.id}/periods/${p.id}/close`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function reopen(p: AccountingPeriod) {
    const ok = await dialog.confirm({
      title: `Re-open ${p.name}?`,
      message: "Removes the closing entry and unlocks the window for edits.",
      variant: "danger",
      confirmLabel: "Re-open",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/companies/${company.id}/periods/${p.id}/reopen`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: AccountingPeriod) {
    const ok = await dialog.confirm({
      title: `Delete ${p.name}?`,
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/periods/${p.id}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const exports = [
    {
      key: "customers",
      label: "Customers",
      desc: "All customer records with billing address and tax number.",
      url: `/api/companies/${company.id}/exports/customers.csv`,
    },
    {
      key: "invoices",
      label: "Invoices",
      desc: "Invoice ledger with status, totals, and balances.",
      url: `/api/companies/${company.id}/exports/invoices.csv`,
    },
    {
      key: "journal",
      label: "General journal",
      desc: "Every ledger entry line in chronological order.",
      url: `/api/companies/${company.id}/exports/journal.csv`,
    },
    {
      key: "trial-balance",
      label: "Trial balance",
      desc: "Snapshot of debits, credits, and balances per account.",
      url: `/api/companies/${company.id}/exports/trial-balance.csv`,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Periods & exports" },
          ]}
        />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Periods & exports
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Define your fiscal periods and close them at month/quarter end.
        Closed periods are locked — no entry can post inside them
        until you re-open. CSV exports below are what most external
        accountants ask for.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Accounting periods
          </h2>
          <Button onClick={() => setShowNew(true)} size="sm">
            <Plus size={14} /> New period
          </Button>
        </div>
        {periods === null ? (
          <div className="flex justify-center p-8">
            <Spinner size={20} />
          </div>
        ) : periods.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            No periods defined yet. Create your first one to start
            closing books at month-end.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="w-32 px-4 py-2 text-left font-medium">Start</th>
                <th className="w-32 px-4 py-2 text-left font-medium">End</th>
                <th className="w-24 px-4 py-2 text-left font-medium">Status</th>
                <th className="w-48 px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {periods.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {p.name}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {p.startDate.slice(0, 10)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {p.endDate.slice(0, 10)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                        (p.status === "closed"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300")
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {p.status === "open" ? (
                        <>
                          <Button onClick={() => close(p)} disabled={busy} size="sm">
                            <Lock size={12} /> Close
                          </Button>
                          <button
                            onClick={() => remove(p)}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                            aria-label="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        <Button
                          onClick={() => reopen(p)}
                          disabled={busy}
                          variant="secondary"
                          size="sm"
                        >
                          <Unlock size={12} /> Re-open
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            CSV exports
          </h2>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {exports.map((e) => (
            <li key={e.key} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {e.label}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {e.desc}
                </div>
              </div>
              <a href={e.url} download>
                <Button variant="secondary" size="sm">
                  <Download size={14} /> Download
                </Button>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {showNew && (
        <NewPeriodModal
          companyId={company.id}
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

function NewPeriodModal({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const [name, setName] = React.useState(
    monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }),
  );
  const [startDate, setStartDate] = React.useState(
    monthStart.toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = React.useState(
    monthEnd.toISOString().slice(0, 10),
  );
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/periods`, {
        name: name.trim(),
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate + "T23:59:59.999Z").toISOString(),
      });
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New accounting period">
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g. May 2026 or Q2 2026"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Start date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
          <Input
            label="End date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create period
          </Button>
        </div>
      </form>
    </Modal>
  );
}
