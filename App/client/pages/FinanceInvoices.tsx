import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Ban, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
  api,
  displayInvoiceStatus,
  formatMoney,
  Invoice,
  InvoiceListItem,
  InvoiceStatus,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Menu, MenuItem } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

type StatusFilter = "all" | InvoiceStatus | "overdue";

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "sent", label: "Sent" },
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
 * Invoice list with status-tab filter. Phase A of the Finance milestone
 * (M19). Click any row to open the detail page.
 */
export default function FinanceInvoices() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [invoices, setInvoices] = React.useState<InvoiceListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  const reload = React.useCallback(async () => {
    const list = await api.get<InvoiceListItem[]>(
      `/api/companies/${company.id}/invoices`,
    );
    setInvoices(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setInvoices([]));
  }, [reload]);

  async function deleteDraft(inv: InvoiceListItem) {
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      message: "Drafts can be permanently deleted. Issued invoices must be voided instead.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/invoices/${inv.slug}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
    try {
      await api.post<Invoice>(
        `/api/companies/${company.id}/invoices/${inv.slug}/void`,
      );
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const filtered = React.useMemo(() => {
    if (!invoices) return null;
    if (filter === "all") return invoices;
    return invoices.filter((inv) => displayInvoiceStatus(inv) === filter);
  }, [invoices, filter]);

  const counts = React.useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      draft: 0,
      sent: 0,
      overdue: 0,
      paid: 0,
      void: 0,
    };
    for (const inv of invoices ?? []) {
      c.all += 1;
      c[displayInvoiceStatus(inv)] += 1;
    }
    return c;
  }, [invoices]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Invoices" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Invoices
        </h1>
        <Link to={`/c/${company.slug}/finance/invoices/new`}>
          <Button>
            <Plus size={14} /> New invoice
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
            {invoices && (
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
            No invoices in this view
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {filter === "all"
              ? "Create one to start billing customers."
              : "Try a different status filter."}
          </p>
          {filter === "all" && (
            <div className="mt-4">
              <Link to={`/c/${company.slug}/finance/invoices/new`}>
                <Button>
                  <Plus size={14} /> New invoice
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
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Issued</th>
                <th className="px-4 py-2 text-left font-medium">Due</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="w-10 px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((inv) => {
                const ds = displayInvoiceStatus(inv);
                return (
                  <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
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
                    <td className="px-4 py-3 text-right">
                      <RowMenu
                        invoice={inv}
                        onDelete={() => deleteDraft(inv)}
                        onVoid={() => voidInvoice(inv)}
                      />
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

function RowMenu({
  invoice,
  onDelete,
  onVoid,
}: {
  invoice: InvoiceListItem;
  onDelete: () => void;
  onVoid: () => void;
}) {
  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  // Issued (sent / paid) invoices can only be voided, not deleted.
  const canVoid = !isDraft && !isVoid;
  if (!isDraft && !canVoid) return null;
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
