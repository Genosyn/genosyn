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
  displayInvoiceStatus,
  formatMoney,
  Invoice,
  InvoiceBulkAction,
  InvoiceListItem,
  InvoiceStatus,
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
import { invoiceArchiveBlocker } from "../../shared/invoiceArchive";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Every status tab, plus Active — everything not voided, which the list opens
 * on — and the Archived view that holds what was filed away.
 */
type StatusFilter = "active" | InvoiceStatus | "overdue" | "written_off" | "credited" | "archived";

const FILTERS: { key: Exclude<StatusFilter, "void" | "archived">; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "draft", label: "Drafts" },
  { key: "sent", label: "Sent" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "credited", label: "Credited" },
  { key: "written_off", label: "Written off" },
];

const STATUS_BADGE: Record<Exclude<StatusFilter, "active" | "archived">, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  overdue: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  credited: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  written_off: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/** Beside the disabled tick box of an invoice that still has money to collect. */
const BALANCE_DUE_HINT =
  "Has a balance due — it can be archived once it is paid, credited, or written off";

/**
 * Invoice list with status-tab filter. Phase A of the Finance milestone
 * (M19). Click any row to open the detail page. A read-only Member gets the
 * list without New invoice, the row checkboxes, or the row menu, whose every
 * entry is a write. It opens on Active: a voided invoice stays in the records
 * but leaves that view for its own Void tab, and an archived one leaves every
 * status tab for Archived. Only an invoice with nothing left to collect can be
 * archived, so the rest keep their tick box disabled.
 */
export default function FinanceInvoices() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const background = useBackgroundAction();
  const dialog = useDialog();
  const navigate = useNavigate();
  const [invoices, setInvoices] = React.useState<InvoiceListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("active");

  const reload = React.useCallback(async () => {
    // Archived rows come too: they fill the Archived view and its count.
    const list = await api.get<InvoiceListItem[]>(
      `/api/companies/${company.id}/invoices?archived=true`,
    );
    setInvoices(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setInvoices([]));
  }, [reload]);

  useLiveRefetch("invoice", reload);

  const filtered = React.useMemo(() => {
    if (!invoices) return null;
    if (filter === "archived") return invoices.filter((inv) => inv.archivedAt);
    const listed = invoices.filter((inv) => !inv.archivedAt);
    if (filter === "active") return listed.filter((inv) => inv.status !== "void");
    return listed.filter((inv) => displayInvoiceStatus(inv) === filter);
  }, [invoices, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      active: 0,
      draft: 0,
      sent: 0,
      overdue: 0,
      paid: 0,
      credited: 0,
      written_off: 0,
      void: 0,
      archived: 0,
    };
    for (const inv of invoices ?? []) {
      if (inv.archivedAt) {
        c.archived += 1;
        continue;
      }
      if (inv.status !== "void") c.active += 1;
      c[displayInvoiceStatus(inv)] += 1;
    }
    return c;
  }, [invoices]);

  const rows = React.useMemo(() => filtered ?? [], [filtered]);
  const selection = useArchiveSelection({
    rows,
    canSelect: (inv) => filter === "archived" || !invoiceArchiveBlocker(inv),
    view: filter,
    bulkUrl: `/api/companies/${company.id}/invoices/bulk`,
    noun: { one: "invoice", many: "invoices" },
    onChanged: (ids, action) => {
      const archivedAt = action === "archive" ? new Date().toISOString() : null;
      setInvoices(
        (current) =>
          current?.map((item) => (ids.has(item.id) ? { ...item, archivedAt } : item)) ?? current,
      );
    },
    onRevert: (inv) =>
      setInvoices(
        (current) => current?.map((item) => (item.id === inv.id ? inv : item)) ?? current,
      ),
  });
  const bulkAction: InvoiceBulkAction = filter === "archived" ? "restore" : "archive";

  async function deleteDraft(inv: InvoiceListItem) {
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      message: "Drafts can be permanently deleted. Issued invoices must be voided instead.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const originalIndex = invoices?.findIndex((item) => item.id === inv.id) ?? -1;
    setInvoices((current) => current?.filter((item) => item.id !== inv.id) ?? current);
    selection.forget([inv.id]);
    background(() => api.del(`/api/companies/${company.id}/invoices/${inv.slug}`), {
      title: "Couldn’t delete the invoice",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setInvoices((current) => {
          if (!current || current.some((item) => item.id === inv.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, inv);
          return next;
        });
      },
    });
  }

  async function duplicate(inv: InvoiceListItem) {
    try {
      const draft = await api.post<Invoice>(
        `/api/companies/${company.id}/invoices/${inv.slug}/duplicate`,
      );
      navigate(`/c/${company.slug}/finance/invoices/${draft.slug}/edit`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t duplicate the invoice" });
    }
  }

  async function voidInvoice(inv: InvoiceListItem) {
    const ok = await dialog.confirm({
      title: `Void ${inv.number}?`,
      message:
        "Voiding cannot be undone. The invoice stays in records but won't count toward outstanding balance.",
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    const optimistic = {
      ...inv,
      status: "void" as const,
      voidedAt: new Date().toISOString(),
    };
    setInvoices(
      (current) => current?.map((item) => (item.id === inv.id ? optimistic : item)) ?? current,
    );
    background(() => api.post<Invoice>(`/api/companies/${company.id}/invoices/${inv.slug}/void`), {
      title: "Couldn’t void the invoice",
      error: (error) => `${errorMessage(error)} The change was undone.`,
      onSuccess: (updated) => {
        setInvoices(
          (current) =>
            current?.map((item) => (item.id === inv.id ? { ...item, ...updated } : item)) ??
            current,
        );
      },
      onError: () => {
        setInvoices(
          (current) => current?.map((item) => (item.id === inv.id ? inv : item)) ?? current,
        );
      },
    });
  }

  const showBulkBar = canWrite && selection.selectedCount > 0;

  return (
    <div className={"page-shell p-8" + (showBulkBar ? " pb-28" : "")}>
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Invoices" }]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Invoices</h1>
        {canWrite && (
          <Link to={`/c/${company.slug}/finance/invoices/new`}>
            <Button>
              <Plus size={14} /> New invoice
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
            count={invoices ? counts[f.key] : null}
            onClick={() => setFilter(f.key)}
          />
        ))}
        {/* Void and Archived sit apart, outside Active. Kept together so the
            divider never ends a wrapped line; on a phone, where the tabs wrap
            anyway, it is dropped. */}
        <span className="flex items-center">
          <span
            aria-hidden
            className="mx-1 hidden h-5 w-px bg-slate-200 sm:block dark:bg-slate-700"
          />
          <FilterTab
            active={filter === "void"}
            label="Void"
            count={invoices ? counts.void : null}
            onClick={() => setFilter("void")}
          />
          <FilterTab
            active={filter === "archived"}
            label={<ArchivedTabLabel />}
            count={invoices ? counts.archived : null}
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
            {filter === "archived" ? "Nothing archived" : "No invoices in this view"}
          </h3>
          {filter === "archived" ? (
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
              Archived invoices wait here, out of the other tabs and customer pages. They keep their
              number, payments, and PDF, still count in every total, and you can restore them at any
              time.
            </p>
          ) : filter !== "active" ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Try a different status filter.
            </p>
          ) : canWrite ? (
            <>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Create one to start billing customers.
              </p>
              <div className="mt-4">
                <Link to={`/c/${company.slug}/finance/invoices/new`}>
                  <Button>
                    <Plus size={14} /> New invoice
                  </Button>
                </Link>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
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
                            ? "Select every invoice in view"
                            : "Select every invoice in view that can be archived"
                      }
                    />
                  </th>
                )}
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Issued</th>
                <th className="px-4 py-2 text-left font-medium">Due</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                {canWrite && <th className="w-10 px-4 py-2 text-right font-medium">&nbsp;</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((inv) => {
                const ds = displayInvoiceStatus(inv);
                const isSelected = selection.selectedIds.has(inv.id);
                const owed = !inv.archivedAt && invoiceArchiveBlocker(inv) !== null;
                return (
                  <tr
                    key={inv.id}
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
                          disabled={owed}
                          title={owed ? BALANCE_DUE_HINT : undefined}
                          onChange={(event) =>
                            selection.toggleOne(inv, (event.nativeEvent as MouseEvent).shiftKey)
                          }
                          label={`Select ${inv.number || "draft invoice"}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-mono text-xs">
                      <Link
                        to={`/c/${company.slug}/finance/invoices/${inv.slug}`}
                        className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {inv.number || "DRAFT"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                      {inv.customer?.name ?? "—"}
                      <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                        Issued by {inv.issuerSnapshot?.name ?? company.name}
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
                      {new Date(inv.issueDate).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {new Date(inv.dueDate).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(inv.totalCents, inv.currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          inv.balanceCents > 0
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-slate-400 dark:text-slate-500"
                        }
                      >
                        {formatMoney(inv.balanceCents, inv.currency)}
                      </span>
                    </td>
                    {canWrite && (
                      <td className="px-4 py-3 text-right">
                        <RowMenu
                          invoice={inv}
                          onDelete={() => deleteDraft(inv)}
                          onDuplicate={() => duplicate(inv)}
                          onMakeRecurring={() =>
                            navigate(
                              recurringInvoiceFromDocumentPath(`/c/${company.slug}/finance`, {
                                kind: "invoice",
                                slug: inv.slug,
                              }),
                            )
                          }
                          onVoid={() => voidInvoice(inv)}
                          onArchive={() =>
                            selection.runOne(inv, inv.archivedAt ? "restore" : "archive")
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
  invoice,
  onDelete,
  onDuplicate,
  onMakeRecurring,
  onVoid,
  onArchive,
}: {
  invoice: InvoiceListItem;
  onDelete: () => void;
  onDuplicate: () => void;
  onMakeRecurring: () => void;
  onVoid: () => void;
  onArchive: () => void;
}) {
  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  // Issued (sent / paid) invoices can only be voided, not deleted.
  const canVoid = !isDraft && !isVoid;
  const archived = !!invoice.archivedAt;
  // Restore is always on offer; Archive only once nothing is left to collect.
  const canArchive = archived || !invoiceArchiveBlocker(invoice);
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
          {canArchive && (
            <MenuItem
              icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              label={archived ? "Restore" : "Archive"}
              onSelect={() => {
                close();
                onArchive();
              }}
            />
          )}
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
