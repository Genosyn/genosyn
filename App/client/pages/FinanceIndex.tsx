import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { ArrowRight, FileText, Plus, Users, Wallet } from "lucide-react";
import { api, Customer, formatMoney, InvoiceListItem } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Finance overview — landing page at `/c/:slug/finance`. Surfaces the
 * three numbers a small business actually checks: outstanding receivables,
 * paid-this-period, customer count. Plus a recent-invoices feed and
 * quick-action buttons. Phase A; richer dashboards (P&L, cash flow) land
 * in Phase C.
 */
export default function FinanceIndex() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [invoices, setInvoices] = React.useState<InvoiceListItem[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[] | null>(null);

  React.useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<InvoiceListItem[]>(`/api/companies/${company.id}/invoices`),
      api.get<Customer[]>(`/api/companies/${company.id}/customers`),
    ])
      .then(([inv, cust]) => {
        if (!alive) return;
        setInvoices(inv);
        setCustomers(cust);
      })
      .catch(() => {
        if (!alive) return;
        setInvoices([]);
        setCustomers([]);
      });
    return () => {
      alive = false;
    };
  }, [company.id]);

  const loading = invoices === null || customers === null;

  // Group balance + paid totals by currency. A multi-currency company would
  // be misleading if we summed across currencies. Phase E will introduce
  // FX so we can present a single home-currency total.
  const totals = React.useMemo(() => {
    const open = new Map<string, number>();
    const paidThisMonth = new Map<string, number>();
    if (!invoices) return { open, paidThisMonth };
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    for (const inv of invoices) {
      if (inv.status === "sent" || inv.status === "paid") {
        if (inv.balanceCents > 0) {
          open.set(inv.currency, (open.get(inv.currency) ?? 0) + inv.balanceCents);
        }
      }
      if (inv.paidAt && new Date(inv.paidAt).getTime() >= startOfMonth.getTime()) {
        paidThisMonth.set(
          inv.currency,
          (paidThisMonth.get(inv.currency) ?? 0) + inv.paidCents,
        );
      }
    }
    return { open, paidThisMonth };
  }, [invoices]);

  const recent = React.useMemo(
    () =>
      [...(invoices ?? [])]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 5),
    [invoices],
  );

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Finance" }]} />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Finance
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Customers, invoices, and revenue at a glance.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/c/${company.slug}/finance/invoices/new`}>
            <Button>
              <Plus size={14} /> New invoice
            </Button>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              icon={<Wallet size={16} />}
              label="Outstanding"
              entries={Array.from(totals.open.entries())}
              emptyHint="No open invoices"
            />
            <StatCard
              icon={<FileText size={16} />}
              label="Paid this month"
              entries={Array.from(totals.paidThisMonth.entries())}
              emptyHint="No payments yet"
            />
            <StatCard
              icon={<Users size={16} />}
              label="Customers"
              entries={[]}
              fallback={
                <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {customers?.length ?? 0}
                </div>
              }
            />
          </div>

          <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Recent invoices
              </h2>
              <Link
                to={`/c/${company.slug}/finance/invoices`}
                className="flex items-center gap-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                See all <ArrowRight size={12} />
              </Link>
            </div>
            {recent.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                No invoices yet.{" "}
                <Link
                  to={`/c/${company.slug}/finance/invoices/new`}
                  className="text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Create your first invoice
                </Link>
                .
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {recent.map((inv) => (
                  <li key={inv.id}>
                    <Link
                      to={`/c/${company.slug}/finance/invoices/${inv.slug}`}
                      className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-200">
                            {inv.number || "DRAFT"}
                          </span>
                          <span className="truncate text-sm text-slate-700 dark:text-slate-200">
                            {inv.customer?.name ?? "—"}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Due{" "}
                          {new Date(inv.dueDate).toISOString().slice(0, 10)} ·{" "}
                          {inv.status}
                        </div>
                      </div>
                      <div className="text-right text-sm tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(inv.totalCents, inv.currency)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  entries,
  emptyHint,
  fallback,
}: {
  icon: React.ReactNode;
  label: string;
  entries: [string, number][];
  emptyHint?: string;
  fallback?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        <span className="text-slate-400 dark:text-slate-500">{icon}</span>
        {label}
      </div>
      <div className="mt-2">
        {fallback ? (
          fallback
        ) : entries.length === 0 ? (
          <div className="text-sm text-slate-400 dark:text-slate-500">
            {emptyHint ?? "—"}
          </div>
        ) : (
          <ul className="space-y-1">
            {entries.map(([cur, cents]) => (
              <li
                key={cur}
                className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100"
              >
                {formatMoney(cents, cur)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
