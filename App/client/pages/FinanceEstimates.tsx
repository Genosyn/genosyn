import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Ban,
  Copy,
  MoreHorizontal,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  api,
  DisplayEstimateStatus,
  displayEstimateStatus,
  Estimate,
  EstimateBulkAction,
  EstimateListItem,
  formatMoney,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { recurringInvoiceFromDocumentPath } from "../lib/recurringInvoiceForm";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Checkbox } from "../components/ui/Checkbox";
import { Spinner } from "../components/ui/Spinner";
import { Menu, MenuItem } from "../components/ui/Menu";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { ArchiveBulkBar, ArchivedTabLabel, FilterTab } from "../components/finance/ArchiveControls";
import { useArchiveSelection } from "../components/finance/useArchiveSelection";
import { FinanceOutletCtx } from "./FinanceLayout";

/** Every status tab, plus the Archived view that holds what was filed away. */
type StatusFilter = "all" | DisplayEstimateStatus | "archived";

const FILTERS: { key: Exclude<StatusFilter, "archived">; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "sent", label: "Sent" },
  { key: "expired", label: "Expired" },
  { key: "accepted", label: "Accepted" },
  { key: "declined", label: "Declined" },
  { key: "invoiced", label: "Invoiced" },
  { key: "void", label: "Void" },
];

const STATUS_BADGE: Record<DisplayEstimateStatus, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  expired: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  declined: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  invoiced: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Estimate (Quotation) list with status-tab filter. Mirrors the
 * Invoices list — click any row to open the detail page, and a read-only
 * Member gets neither New estimate, the row checkboxes, nor the all-writes
 * row menu. Archived estimates leave the status tabs for their own view;
 * select rows to archive or restore them together.
 */
export default function FinanceEstimates() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const background = useBackgroundAction();
  const dialog = useDialog();
  const navigate = useNavigate();
  const [estimates, setEstimates] = React.useState<EstimateListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  const reload = React.useCallback(async () => {
    // Archived rows come too: they fill the Archived view and its count.
    const list = await api.get<EstimateListItem[]>(
      `/api/companies/${company.id}/estimates?archived=true`,
    );
    setEstimates(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setEstimates([]));
  }, [reload]);

  useLiveRefetch("estimate", reload);

  async function deleteDraft(est: EstimateListItem) {
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      message: "Drafts can be permanently deleted. Issued estimates must be voided instead.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const originalIndex = estimates?.findIndex((item) => item.id === est.id) ?? -1;
    setEstimates((current) => current?.filter((item) => item.id !== est.id) ?? current);
    selection.forget([est.id]);
    background(() => api.del(`/api/companies/${company.id}/estimates/${est.slug}`), {
      title: "Couldn’t delete the estimate",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setEstimates((current) => {
          if (!current || current.some((item) => item.id === est.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, est);
          return next;
        });
      },
    });
  }

  async function duplicate(est: EstimateListItem) {
    try {
      const draft = await api.post<Estimate>(
        `/api/companies/${company.id}/estimates/${est.slug}/duplicate`,
      );
      navigate(`/c/${company.slug}/finance/estimates/${draft.slug}/edit`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t duplicate the estimate" });
    }
  }

  async function voidEstimate(est: EstimateListItem) {
    const ok = await dialog.confirm({
      title: `Void ${est.number}?`,
      message:
        "Voiding cannot be undone. The estimate stays in records but is marked as cancelled.",
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    const optimistic = {
      ...est,
      status: "void" as const,
      voidedAt: new Date().toISOString(),
    };
    setEstimates(
      (current) => current?.map((item) => (item.id === est.id ? optimistic : item)) ?? current,
    );
    background(
      () => api.post<Estimate>(`/api/companies/${company.id}/estimates/${est.slug}/void`),
      {
        title: "Couldn’t void the estimate",
        error: (error) => `${errorMessage(error)} The change was undone.`,
        onSuccess: (updated) => {
          setEstimates(
            (current) =>
              current?.map((item) => (item.id === est.id ? { ...item, ...updated } : item)) ??
              current,
          );
        },
        onError: () => {
          setEstimates(
            (current) => current?.map((item) => (item.id === est.id ? est : item)) ?? current,
          );
        },
      },
    );
  }

  const filtered = React.useMemo(() => {
    if (!estimates) return null;
    if (filter === "archived") return estimates.filter((est) => est.archivedAt);
    const active = estimates.filter((est) => !est.archivedAt);
    if (filter === "all") return active;
    return active.filter((est) => displayEstimateStatus(est) === filter);
  }, [estimates, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      draft: 0,
      sent: 0,
      expired: 0,
      accepted: 0,
      declined: 0,
      invoiced: 0,
      void: 0,
      archived: 0,
    };
    for (const est of estimates ?? []) {
      if (est.archivedAt) {
        c.archived += 1;
        continue;
      }
      c.all += 1;
      c[displayEstimateStatus(est)] += 1;
    }
    return c;
  }, [estimates]);

  const rows = React.useMemo(() => filtered ?? [], [filtered]);
  const selection = useArchiveSelection({
    rows,
    canSelect: () => true,
    view: filter,
    bulkUrl: `/api/companies/${company.id}/estimates/bulk`,
    noun: { one: "estimate", many: "estimates" },
    onChanged: (ids, action) => {
      const archivedAt = action === "archive" ? new Date().toISOString() : null;
      setEstimates(
        (current) =>
          current?.map((item) => (ids.has(item.id) ? { ...item, archivedAt } : item)) ?? current,
      );
    },
    onRevert: (est) =>
      setEstimates(
        (current) => current?.map((item) => (item.id === est.id ? est : item)) ?? current,
      ),
  });
  const bulkAction: EstimateBulkAction = filter === "archived" ? "restore" : "archive";

  const showBulkBar = canWrite && selection.selectedCount > 0;

  return (
    <div className={"page-shell p-8" + (showBulkBar ? " pb-28" : "")}>
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Estimates" }]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Estimates</h1>
        {canWrite && (
          <Link to={`/c/${company.slug}/finance/estimates/new`}>
            <Button>
              <Plus size={14} /> New estimate
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
            count={estimates ? counts[f.key] : null}
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
            count={estimates ? counts.archived : null}
            onClick={() => setFilter("archived")}
          />
        </span>
      </div>

      {filtered === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {filter === "archived" ? "Nothing archived" : "No estimates in this view"}
          </h3>
          {filter === "archived" ? (
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
              Archived estimates wait here, out of the other tabs and customer pages. They keep
              their number, status, and PDF, and you can restore them at any time.
            </p>
          ) : filter !== "all" ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Try a different status filter.
            </p>
          ) : canWrite ? (
            <>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Send your first quotation to a customer.
              </p>
              <div className="mt-4">
                <Link to={`/c/${company.slug}/finance/estimates/new`}>
                  <Button>
                    <Plus size={14} /> New estimate
                  </Button>
                </Link>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
              <tr>
                {canWrite && (
                  <th className="w-10 py-2 pl-4 pr-0 text-left font-medium">
                    <Checkbox
                      checked={selection.allSelected}
                      indeterminate={selection.selectedCount > 0}
                      onChange={selection.toggleAll}
                      label={
                        selection.allSelected ? "Clear selection" : "Select every estimate in view"
                      }
                    />
                  </th>
                )}
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Issued</th>
                <th className="px-4 py-2 text-left font-medium">Valid until</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                {canWrite && <th className="w-10 px-4 py-2 text-right font-medium">&nbsp;</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((est) => {
                const ds = displayEstimateStatus(est);
                const isSelected = selection.selectedIds.has(est.id);
                return (
                  <tr
                    key={est.id}
                    className={
                      isSelected
                        ? "bg-indigo-50/70 dark:bg-indigo-950/40"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    }
                  >
                    {canWrite && (
                      <td className="w-10 py-3 pl-4 pr-0">
                        <Checkbox
                          checked={isSelected}
                          onChange={(event) =>
                            selection.toggleOne(est, (event.nativeEvent as MouseEvent).shiftKey)
                          }
                          label={`Select ${est.number || "draft estimate"}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        to={`/c/${company.slug}/finance/estimates/${est.slug}`}
                        className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {est.number || "DRAFT"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                      {est.customer?.name ?? "—"}
                      <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                        Issued by {est.issuerSnapshot?.name ?? company.name}
                      </div>
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
                      {new Date(est.issueDate).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {new Date(est.validUntil).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(est.totalCents, est.currency)}
                    </td>
                    {canWrite && (
                      <td className="px-4 py-3 text-right">
                        <RowMenu
                          estimate={est}
                          onDelete={() => deleteDraft(est)}
                          onDuplicate={() => duplicate(est)}
                          onMakeRecurring={() =>
                            navigate(
                              recurringInvoiceFromDocumentPath(`/c/${company.slug}/finance`, {
                                kind: "estimate",
                                slug: est.slug,
                              }),
                            )
                          }
                          onVoid={() => voidEstimate(est)}
                          onArchive={() =>
                            selection.runOne(est, est.archivedAt ? "restore" : "archive")
                          }
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
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

function RowMenu({
  estimate,
  onDelete,
  onDuplicate,
  onMakeRecurring,
  onVoid,
  onArchive,
}: {
  estimate: EstimateListItem;
  onDelete: () => void;
  onDuplicate: () => void;
  onMakeRecurring: () => void;
  onVoid: () => void;
  onArchive: () => void;
}) {
  const isDraft = estimate.status === "draft";
  const isVoid = estimate.status === "void";
  const canVoid = !isDraft && !isVoid;
  const archived = !!estimate.archivedAt;
  return (
    <Menu
      align="right"
      width={176}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          onClick={onClick}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Row menu"
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Copy size={14} />}
            label="Duplicate"
            onSelect={() => {
              close();
              onDuplicate();
            }}
          />
          <MenuItem
            icon={<Repeat size={14} />}
            label="Make recurring"
            onSelect={() => {
              close();
              onMakeRecurring();
            }}
          />
          <MenuItem
            icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            label={archived ? "Restore" : "Archive"}
            onSelect={() => {
              close();
              onArchive();
            }}
          />
          {canVoid && (
            <MenuItem
              icon={<Ban size={14} />}
              label="Void"
              onSelect={() => {
                close();
                onVoid();
              }}
            />
          )}
          {isDraft && (
            <MenuItem
              icon={<Trash2 size={14} className="text-red-500" />}
              label={<span className="text-red-600 dark:text-red-400">Delete</span>}
              onSelect={() => {
                close();
                onDelete();
              }}
            />
          )}
        </>
      )}
    </Menu>
  );
}
