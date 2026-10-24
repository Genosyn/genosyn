import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { ArrowRight, FileText, Landmark, Plus, Users, Wallet } from "lucide-react";
import { api, BankingAccount, Customer, formatMoney, InvoiceListItem } from "../lib/api";
import { summarizeSync } from "../lib/bankingSync";
import { newInvoicePath } from "../lib/invoiceKind";
import { canWriteFinance } from "../lib/subpages";
import { useNow } from "../lib/useNow";
import { SyncMark } from "./FinanceBankingAccounts";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Finance overview — landing page at `/c/:slug/finance`. Surfaces the
 * numbers a small business actually checks: outstanding receivables,
 * paid-this-period, customer count, and how many bank and card transactions
 * wait on Banking. Plus a recent-invoices feed and quick-action buttons.
 */
export default function FinanceIndex() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const [invoices, setInvoices] = React.useState<InvoiceListItem[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [banking, setBanking] = React.useState<BankingAccount[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  const reload = React.useCallback(() => {
    // Banking is a side panel here: if it fails, the rest of the overview stands.
    api
      .get<BankingAccount[]>(`/api/companies/${company.id}/banking/accounts`)
      .then(setBanking)
      .catch(() => setBanking([]));
    return Promise.all([
      // Archived invoices too: archiving files an invoice away, but its money
      // still counts in the totals below.
      api.get<InvoiceListItem[]>(`/api/companies/${company.id}/invoices?archived=true`),
      api.get<Customer[]>(`/api/companies/${company.id}/customers`),
    ])
      .then(([inv, cust]) => {
        setInvoices(inv);
        setCustomers(cust);
        setLoadError(false);
      })
      .catch(() => {
        setInvoices([]);
        setCustomers([]);
        setLoadError(true);
      });
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch(["invoice", "customer", "reconcile", "cardexpense"], reload);

  async function retry() {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }

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

  // The feed is a list, so it leaves archived invoices out as the others do,
  // and voided ones out as the invoice list's Active view does.
  const recent = React.useMemo(
    () =>
      (invoices ?? [])
        .filter((inv) => !inv.archivedAt && inv.status !== "void")
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 5),
    [invoices],
  );

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Finance" }]} />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">
            Finance
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What you&apos;re owed, what came in, and what&apos;s waiting on you.
          </p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Link to={newInvoicePath(`/c/${company.slug}/finance`)}>
              <Button>
                <Plus size={14} /> New invoice
              </Button>
            </Link>
          </div>
        )}
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load finance
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong loading invoices and customers.
          </p>
          <Button variant="secondary" className="mt-4" loading={retrying} onClick={retry}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
            <BankingCard companySlug={company.slug} accounts={banking} canWrite={canWrite} />
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
                No invoices yet.
                {canWrite && (
                  <>
                    {" "}
                    <Link
                      to={newInvoicePath(`/c/${company.slug}/finance`)}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      Create your first invoice
                    </Link>
                    .
                  </>
                )}
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
                          <span className="font-mono text-xs font-medium text-slate-700 dark:text-slate-200">
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

/** Bank and card transactions waiting on Banking, or a way to add the first account. */
function BankingCard({
  companySlug,
  accounts,
  canWrite,
}: {
  companySlug: string;
  accounts: BankingAccount[] | null;
  canWrite: boolean;
}) {
  const toReview = (accounts ?? []).reduce((sum, account) => sum + account.toReview, 0);
  const to = `/c/${companySlug}/finance/banking`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        <span className="text-slate-400 dark:text-slate-500">
          <Landmark size={16} />
        </span>
        Transactions to review
      </div>
      <div className="mt-2">
        {accounts === null ? (
          <div className="text-sm text-slate-400 dark:text-slate-500">—</div>
        ) : accounts.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            No bank accounts yet.
            {canWrite && (
              <>
                {" "}
                <Link to={to} className="text-indigo-600 hover:underline dark:text-indigo-400">
                  Add one
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            <Link to={to} className="group flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {toReview}
              </span>
              <span className="flex items-center gap-1 text-xs text-indigo-600 group-hover:underline dark:text-indigo-400">
                {toReview > 0 ? "Review" : "Open Banking"} <ArrowRight size={12} />
              </span>
            </Link>
            <BankingHealth accounts={accounts} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A line under the count only when an account needs a look — one that can't
 * sync, or has fallen behind. In step, the count says enough.
 */
function BankingHealth({ accounts }: { accounts: BankingAccount[] }) {
  const now = useNow(60_000);
  const health = summarizeSync(accounts, now);
  if (health.tone !== "error" && health.tone !== "stale") return null;
  return (
    <p
      className={
        health.tone === "error"
          ? "mt-1.5 flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300"
          : "mt-1.5 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300"
      }
    >
      <SyncMark tone={health.tone} />
      <span className="truncate">{health.label}</span>
    </p>
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
