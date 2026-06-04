import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { Plus, Repeat } from "lucide-react";
import {
  api,
  formatMoney,
  RecurringInvoiceListItem,
  RecurringInvoiceStatus,
} from "../lib/api";
import { describeCron } from "../lib/schedule";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

type StatusFilter = "all" | RecurringInvoiceStatus;

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "ended", label: "Ended" },
];

const STATUS_BADGE: Record<RecurringInvoiceStatus, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  ended: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Recurring invoices list. Each row is a scheduled template that
 * auto-generates a new `Invoice` on its cron tick.
 */
export default function FinanceRecurringInvoices() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = React.useState<RecurringInvoiceListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  React.useEffect(() => {
    api
      .get<RecurringInvoiceListItem[]>(
        `/api/companies/${company.id}/recurring-invoices`,
      )
      .then(setRows)
      .catch((err: Error) => {
        toast(err.message, "error");
        setRows([]);
      });
  }, [company.id, toast]);

  const filtered = React.useMemo(() => {
    if (!rows) return null;
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      active: 0,
      paused: 0,
      ended: 0,
    };
    for (const r of rows ?? []) {
      c.all += 1;
      c[r.status] += 1;
    }
    return c;
  }, [rows]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Recurring invoices" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Recurring invoices
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Schedule an invoice template to bill on a repeating cadence — e.g.
            monthly retainers or annual licences. Each run creates a fresh
            invoice.
          </p>
        </div>
        <Link to={`/c/${company.slug}/finance/recurring-invoices/new`}>
          <Button>
            <Plus size={14} /> New schedule
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
            {rows && (
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
          <Repeat size={28} className="mx-auto text-slate-300 dark:text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            No recurring invoices yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {filter === "all"
              ? "Set up a schedule once — Genosyn handles the rest."
              : "Try a different status filter."}
          </p>
          {filter === "all" && (
            <div className="mt-4">
              <Link to={`/c/${company.slug}/finance/recurring-invoices/new`}>
                <Button>
                  <Plus size={14} /> New schedule
                </Button>
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Schedule</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Next run</th>
                <th className="px-4 py-2 text-right font-medium">Runs</th>
                <th className="px-4 py-2 text-left font-medium">Currency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  onClick={() =>
                    navigate(
                      `/c/${company.slug}/finance/recurring-invoices/${r.slug}`,
                    )
                  }
                >
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                    {r.name}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                    {r.customer?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {describeCron(r.cronExpr, r.intervalCount)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                        STATUS_BADGE[r.status]
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {r.status === "active" ? formatRelative(r.nextRunAt) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {r.runsCreated}
                    {r.maxRuns ? ` / ${r.maxRuns}` : ""}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {formatMoney(0, r.currency).replace(/[\d.,]/g, "").trim() ||
                      r.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
