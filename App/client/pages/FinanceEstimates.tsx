import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { Ban, Copy, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
  api,
  DisplayEstimateStatus,
  displayEstimateStatus,
  Estimate,
  EstimateListItem,
  formatMoney,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Menu, MenuItem } from "../components/ui/Menu";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

type StatusFilter = "all" | DisplayEstimateStatus;

const FILTERS: { key: StatusFilter; label: string }[] = [
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
 * Invoices list — click any row to open the detail page.
 */
export default function FinanceEstimates() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast, background } = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const [estimates, setEstimates] = React.useState<EstimateListItem[] | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("all");

  const reload = React.useCallback(async () => {
    const list = await api.get<EstimateListItem[]>(`/api/companies/${company.id}/estimates`);
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
    background(() => api.del(`/api/companies/${company.id}/estimates/${est.slug}`), {
      loading: "Deleting estimate draft…",
      success: "Estimate draft deleted",
      error: (error) =>
        `Couldn\u2019t delete the estimate: ${
          error instanceof Error ? error.message : "Unknown error"
        }. It has been restored.`,
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
      toast("Estimate duplicated as draft", "success");
      navigate(`/c/${company.slug}/finance/estimates/${draft.slug}/edit`);
    } catch (err) {
      toast((err as Error).message, "error");
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
        loading: "Voiding estimate…",
        success: "Estimate voided",
        error: (error) =>
          `Couldn\u2019t void the estimate: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The change was undone.`,
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
    if (filter === "all") return estimates;
    return estimates.filter((est) => displayEstimateStatus(est) === filter);
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
    };
    for (const est of estimates ?? []) {
      c.all += 1;
      c[displayEstimateStatus(est)] += 1;
    }
    return c;
  }, [estimates]);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Estimates" }]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Estimates</h1>
        <Link to={`/c/${company.slug}/finance/estimates/new`}>
          <Button>
            <Plus size={14} /> New estimate
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
            {estimates && (
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
            No estimates in this view
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {filter === "all"
              ? "Send your first quotation to a customer."
              : "Try a different status filter."}
          </p>
          {filter === "all" && (
            <div className="mt-4">
              <Link to={`/c/${company.slug}/finance/estimates/new`}>
                <Button>
                  <Plus size={14} /> New estimate
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
                <th className="px-4 py-2 text-left font-medium">Valid until</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="w-10 px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((est) => {
                const ds = displayEstimateStatus(est);
                return (
                  <tr key={est.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
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
                    <td className="px-4 py-3 text-right">
                      <RowMenu
                        estimate={est}
                        onDelete={() => deleteDraft(est)}
                        onDuplicate={() => duplicate(est)}
                        onVoid={() => voidEstimate(est)}
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
  estimate,
  onDelete,
  onDuplicate,
  onVoid,
}: {
  estimate: EstimateListItem;
  onDelete: () => void;
  onDuplicate: () => void;
  onVoid: () => void;
}) {
  const isDraft = estimate.status === "draft";
  const isVoid = estimate.status === "void";
  const canVoid = !isDraft && !isVoid;
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
