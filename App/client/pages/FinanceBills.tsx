import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  api,
  BillListItem,
  BillStatus,
  displayBillStatus,
  formatMoney,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

type StatusFilter = "all" | BillStatus | "overdue";

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "sent", label: "Awaiting payment" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
];

const STATUS_BADGE: Record<StatusFilter, string> = {
  all: "",
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  overdue: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Bills list. Phase G of the Finance milestone (M19). Mirrors the
 * Invoices list — same status-tab filter, same row layout flipped to
 * "we owe them" framing.
 */
export default function FinanceBills() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [bills, setBills] = React.useState<BillListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  React.useEffect(() => {
    let alive = true;
    api
      .get<BillListItem[]>(`/api/companies/${company.id}/bills`)
      .then((list) => alive && setBills(list))
      .catch(() => alive && setBills([]));
    return () => {
      alive = false;
    };
  }, [company.id]);

  const filtered = React.useMemo(() => {
    if (!bills) return null;
    if (filter === "all") return bills;
    return bills.filter((b) => displayBillStatus(b) === filter);
  }, [bills, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      draft: 0,
      sent: 0,
      overdue: 0,
      paid: 0,
      void: 0,
    };
    for (const b of bills ?? []) {
      c.all += 1;
      c[displayBillStatus(b)] += 1;
    }
    return c;
  }, [bills]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Bills" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Bills
        </h1>
        <Link to={`/c/${company.slug}/finance/bills/new`}>
          <Button>
            <Plus size={14} /> New bill
          </Button>
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={
              "rounded-md px-3 py-1.5 text-xs font-medium transition " +
              (filter === f.key
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800")
            }
          >
            {f.label}
            {bills && (
              <span className="ml-1.5 text-[10px] tabular-nums text-slate-400">
                {counts[f.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {filtered === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No bills in this view
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {filter === "all" ? "Record a bill to start tracking what you owe." : "Try a different status filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Vendor</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Issued</th>
                <th className="px-4 py-2 text-left font-medium">Due</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((b) => {
                const ds = displayBillStatus(b);
                return (
                  <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        to={`/c/${company.slug}/finance/bills/${b.slug}`}
                        className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {b.number || "DRAFT"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                      {b.vendor?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                          STATUS_BADGE[ds]
                        }
                      >
                        {ds}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {new Date(b.issueDate).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {new Date(b.dueDate).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(b.totalCents, b.currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          b.balanceCents > 0
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-slate-400 dark:text-slate-500"
                        }
                      >
                        {formatMoney(b.balanceCents, b.currency)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
