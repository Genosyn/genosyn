import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { FileText, Plus, Repeat, Send } from "lucide-react";
import {
  api,
  financeSubsidiaries,
  Subsidiary,
  formatMoney,
  RecurringInvoiceBulkAction,
  RecurringInvoiceListItem,
  RecurringInvoiceStatus,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { describeCron } from "../lib/schedule";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { ArchiveBulkBar, ArchivedTabLabel, FilterTab } from "../components/finance/ArchiveControls";
import { useArchiveSelection } from "../components/finance/useArchiveSelection";
import { recurringInvoiceArchiveBlocker } from "../../shared/invoiceArchive";
import { FinanceOutletCtx } from "./FinanceLayout";

/** Every status tab, plus the Archived view that holds what was filed away. */
type StatusFilter = "all" | RecurringInvoiceStatus | "archived";

const FILTERS: { key: Exclude<StatusFilter, "archived">; label: string }[] = [
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

/** Beside the disabled tick box of a schedule that still bills. */
const STILL_ACTIVE_HINT = "Still billing — pause or end the schedule to archive it";

/**
 * Recurring invoices list. Each row is a scheduled template that
 * auto-generates a new `Invoice` on its cron tick. A read-only Member gets
 * the list without New schedule or the row checkboxes. Archived schedules
 * leave the status tabs for their own view; only a paused or ended one can be
 * archived, since an active one would go on billing from out of sight.
 */
export default function FinanceRecurringInvoices() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const navigate = useNavigate();
  const [rows, setRows] = React.useState<RecurringInvoiceListItem[] | null>(null);
  const [subsidiaries, setSubsidiaries] = React.useState<Subsidiary[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  const reload = React.useCallback(() => {
    Promise.all([
      // Archived rows come too: they fill the Archived view and its count.
      api.get<RecurringInvoiceListItem[]>(
        `/api/companies/${company.id}/recurring-invoices?archived=true`,
      ),
      financeSubsidiaries.list(company.id),
    ])
      .then(([list, issuers]) => {
        setRows(list);
        setSubsidiaries(issuers);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Could not load the recurring invoices"));
        setRows([]);
      });
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("recurringinvoice", reload);

  const filtered = React.useMemo(() => {
    if (!rows) return null;
    if (filter === "archived") return rows.filter((r) => r.archivedAt);
    const listed = rows.filter((r) => !r.archivedAt);
    if (filter === "all") return listed;
    return listed.filter((r) => r.status === filter);
  }, [rows, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      active: 0,
      paused: 0,
      ended: 0,
      archived: 0,
    };
    for (const r of rows ?? []) {
      if (r.archivedAt) {
        c.archived += 1;
        continue;
      }
      c.all += 1;
      c[r.status] += 1;
    }
    return c;
  }, [rows]);

  const shown = React.useMemo(() => filtered ?? [], [filtered]);
  const selection = useArchiveSelection({
    rows: shown,
    canSelect: (r) => filter === "archived" || !recurringInvoiceArchiveBlocker(r),
    view: filter,
    bulkUrl: `/api/companies/${company.id}/recurring-invoices/bulk`,
    noun: { one: "schedule", many: "schedules" },
    onChanged: (ids, action) => {
      const archivedAt = action === "archive" ? new Date().toISOString() : null;
      setRows(
        (current) =>
          current?.map((item) => (ids.has(item.id) ? { ...item, archivedAt } : item)) ?? current,
      );
    },
    onRevert: (ri) =>
      setRows((current) => current?.map((item) => (item.id === ri.id ? ri : item)) ?? current),
  });
  const bulkAction: RecurringInvoiceBulkAction = filter === "archived" ? "restore" : "archive";
  const showBulkBar = canWrite && selection.selectedCount > 0;

  return (
    <div className={"page-shell p-8" + (showBulkBar ? " pb-28" : "")}>
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
            Schedule an invoice template to bill on a repeating cadence — e.g. monthly retainers or
            annual licences. Each run creates a fresh invoice.
          </p>
        </div>
        {canWrite && (
          <Link to={`/c/${company.slug}/finance/recurring-invoices/new`}>
            <Button>
              <Plus size={14} /> New schedule
            </Button>
          </Link>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
        {FILTERS.map((f) => (
          <FilterTab
            key={f.key}
            active={filter === f.key}
            label={f.label}
            count={rows ? counts[f.key] : null}
            onClick={() => setFilter(f.key)}
          />
        ))}
        {/* Kept together so the divider never ends a wrapped line; on a phone,
            where the tabs wrap anyway, it is dropped. */}
        <span className="flex items-center">
          <span
            aria-hidden
            className="mx-1 hidden h-5 w-px bg-slate-200 sm:block dark:bg-slate-700"
          />
          <FilterTab
            active={filter === "archived"}
            label={<ArchivedTabLabel />}
            count={rows ? counts.archived : null}
            onClick={() => setFilter("archived")}
          />
        </span>
      </div>

      {loadError ? (
        <FormError message={loadError} />
      ) : filtered === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <Repeat size={28} className="mx-auto text-slate-300 dark:text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            {filter === "archived" ? "Nothing archived" : "No recurring invoices yet"}
          </h3>
          {filter === "archived" ? (
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
              Archived schedules wait here, out of the other tabs and customer pages. They keep
              their cadence, lines, and run history, and you can restore them at any time.
            </p>
          ) : filter !== "all" ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Try a different status filter.
            </p>
          ) : canWrite ? (
            <>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Set up a schedule once — Genosyn handles the rest.
              </p>
              <div className="mt-4">
                <Link to={`/c/${company.slug}/finance/recurring-invoices/new`}>
                  <Button>
                    <Plus size={14} /> New schedule
                  </Button>
                </Link>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  {canWrite && (
                    <th className="w-10 py-2 pl-4 pr-0 text-left font-medium">
                      <Checkbox
                        checked={selection.allSelected}
                        indeterminate={selection.selectedCount > 0}
                        disabled={!selection.anySelectable}
                        title={
                          selection.anySelectable ? undefined : "Nothing in view can be archived"
                        }
                        onChange={selection.toggleAll}
                        label={
                          selection.allSelected
                            ? "Clear selection"
                            : filter === "archived"
                              ? "Select every schedule in view"
                              : "Select every schedule in view that can be archived"
                        }
                      />
                    </th>
                  )}
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-left font-medium">Schedule</th>
                  <th className="px-4 py-2 text-left font-medium">Each run</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Next run</th>
                  <th className="px-4 py-2 text-right font-medium">Runs</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map((r) => {
                  const isSelected = selection.selectedIds.has(r.id);
                  const billing = !r.archivedAt && recurringInvoiceArchiveBlocker(r) !== null;
                  return (
                    <tr
                      key={r.id}
                      className={
                        "cursor-pointer " +
                        (isSelected
                          ? "bg-indigo-50/70 dark:bg-indigo-950/40"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/40")
                      }
                      onClick={() =>
                        navigate(`/c/${company.slug}/finance/recurring-invoices/${r.slug}`)
                      }
                    >
                      {canWrite && (
                        // The whole row opens the schedule; a click beside the
                        // tick box must not.
                        <td
                          className="w-10 py-3 pl-4 pr-0"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            disabled={billing}
                            title={billing ? STILL_ACTIVE_HINT : undefined}
                            onChange={(event) =>
                              selection.toggleOne(r, (event.nativeEvent as MouseEvent).shiftKey)
                            }
                            label={`Select ${r.name}`}
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                        {r.name}
                      </td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                        {r.customer?.name ?? "—"}
                        <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                          Issued by{" "}
                          {r.subsidiaryId
                            ? (subsidiaries.find((item) => item.id === r.subsidiaryId)?.name ??
                              "Subsidiary unavailable")
                            : company.name}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {describeCron(r.cronExpr, r.intervalCount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-300">
                        {r.autoSend ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Send size={13} className="text-indigo-500" /> Issue + email
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <FileText size={13} className="text-slate-400" /> Draft only
                          </span>
                        )}
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
                        {r.status === "active" &&
                          r.latestRun?.status === "pending" &&
                          r.latestRun.lastError && (
                            <div
                              className="mt-1 text-xs text-amber-600 dark:text-amber-400"
                              title={r.latestRun.lastError}
                            >
                              Retrying
                            </div>
                          )}
                        {r.latestRun?.status === "failed" && (
                          <div
                            className="mt-1 text-xs text-red-600 dark:text-red-400"
                            title={r.latestRun.lastError}
                          >
                            Email not sent
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {r.status === "active" ? formatRelative(r.nextRunAt) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                        {r.runsCreated}
                        {r.maxRuns ? ` / ${r.maxRuns}` : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(r.totalCents, r.currency)}
                        <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                          {r.currency}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showBulkBar && (
        <ArchiveBulkBar
          count={selection.selectedCount}
          action={bulkAction}
          busy={selection.busy}
          onRun={() => void selection.run(bulkAction)}
          onClear={selection.clear}
        />
      )}
    </div>
  );
}
