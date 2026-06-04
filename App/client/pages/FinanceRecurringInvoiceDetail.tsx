import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Ban,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  api,
  formatMoney,
  Invoice,
  RecurringInvoice,
  RecurringInvoiceStatus,
} from "../lib/api";
import { describeCron } from "../lib/schedule";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<RecurringInvoiceStatus, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  ended: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
};

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * Recurring-invoice detail. Shows the schedule, the template line items,
 * and the lifecycle controls (pause / resume / end / run-now / delete).
 */
export default function FinanceRecurringInvoiceDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { recurringSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [ri, setRi] = React.useState<RecurringInvoice | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!recurringSlug) return;
    try {
      const fresh = await api.get<RecurringInvoice>(
        `/api/companies/${company.id}/recurring-invoices/${recurringSlug}`,
      );
      setRi(fresh);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, recurringSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function patchStatus(next: RecurringInvoiceStatus) {
    if (!ri) return;
    setBusy(true);
    try {
      const updated = await api.patch<RecurringInvoice>(
        `/api/companies/${company.id}/recurring-invoices/${ri.slug}`,
        { status: next },
      );
      setRi(updated);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    if (!ri) return;
    setBusy(true);
    try {
      const result = await api.post<{
        recurringInvoice: RecurringInvoice;
        invoice: Invoice;
        emailStatus: "sent" | "skipped" | "failed" | "not_attempted";
        emailError: string;
      }>(`/api/companies/${company.id}/recurring-invoices/${ri.slug}/run-now`);
      setRi(result.recurringInvoice);
      if (result.emailStatus === "failed") {
        toast(`Invoice generated, but email failed: ${result.emailError}`, "error");
      } else {
        toast(
          ri.autoSend
            ? `Generated invoice ${result.invoice.number || "(draft)"} and sent.`
            : `Generated draft invoice ${result.invoice.slug}.`,
          "success",
        );
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!ri) return;
    const ok = await dialog.confirm({
      title: `Delete "${ri.name}"?`,
      message:
        "This removes the recurring schedule. Invoices it has already generated stay in your records.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(
        `/api/companies/${company.id}/recurring-invoices/${ri.slug}`,
      );
      navigate(`/c/${company.slug}/finance/recurring-invoices`);
    } catch (err) {
      toast((err as Error).message, "error");
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: "Error" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {loadError}
        </div>
      </div>
    );
  }

  if (!ri) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const totalPreview = ri.lines.reduce((sum, l) => {
    return sum + Math.round(l.quantity * l.unitPriceCents);
  }, 0);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: ri.name },
          ]}
        />
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            to={`/c/${company.slug}/finance/recurring-invoices`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {ri.name}
              </h1>
              <span
                className={
                  "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                  STATUS_BADGE[ri.status]
                }
              >
                {ri.status}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              <Repeat size={12} className="mr-1 inline" />
              {describeCron(ri.cronExpr, ri.intervalCount)}
              {" — billing "}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {ri.customer?.name ?? "—"}
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ri.status === "active" && (
            <Button
              variant="secondary"
              onClick={() => patchStatus("paused")}
              disabled={busy}
            >
              <Pause size={14} /> Pause
            </Button>
          )}
          {ri.status === "paused" && (
            <Button
              variant="secondary"
              onClick={() => patchStatus("active")}
              disabled={busy}
            >
              <Play size={14} /> Resume
            </Button>
          )}
          {ri.status !== "ended" && (
            <Button onClick={runNow} disabled={busy}>
              <PlayCircle size={14} /> Run now
            </Button>
          )}
          <Link to={`/c/${company.slug}/finance/recurring-invoices/${ri.slug}/edit`}>
            <Button variant="secondary" disabled={busy}>
              <Pencil size={14} /> Edit
            </Button>
          </Link>
          {ri.status !== "ended" && (
            <Button
              variant="secondary"
              onClick={() => patchStatus("ended")}
              disabled={busy}
              title="End this schedule. Invoices it already created stay in your records."
            >
              <Ban size={14} /> End
            </Button>
          )}
          <Button variant="danger" onClick={destroy} disabled={busy}>
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Schedule
          </h3>
          <dl className="space-y-2 text-sm">
            <Row label="Repeats" value={describeCron(ri.cronExpr, ri.intervalCount)} />
            <Row
              label="Next run"
              value={ri.status === "active" ? formatStamp(ri.nextRunAt) : "—"}
            />
            <Row label="Last run" value={formatStamp(ri.lastRunAt)} />
            <Row
              label="Runs created"
              value={
                ri.maxRuns
                  ? `${ri.runsCreated} / ${ri.maxRuns}`
                  : String(ri.runsCreated)
              }
            />
            {ri.endsOn && (
              <Row
                label="Ends on"
                value={new Date(ri.endsOn).toISOString().slice(0, 10)}
              />
            )}
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Billing
          </h3>
          <dl className="space-y-2 text-sm">
            <Row label="Customer" value={ri.customer?.name ?? "—"} />
            <Row label="Email" value={ri.customer?.email || "—"} />
            <Row label="Currency" value={ri.currency} />
            <Row label="Days until due" value={`${ri.daysUntilDue} days`} />
            <Row
              label="Auto-send"
              value={ri.autoSend ? "Issue + email each tick" : "Create draft only"}
            />
            <Row
              label="Total per invoice"
              value={formatMoney(totalPreview, ri.currency)}
            />
          </dl>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Latest run
          </h3>
          {ri.lastInvoiceSlug ? (
            <Link
              to={`/c/${company.slug}/finance/invoices/${ri.lastInvoiceSlug}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Open last generated invoice →
            </Link>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              This schedule hasn&apos;t fired yet.{" "}
              {ri.status === "active" && ri.nextRunAt
                ? `Next run: ${formatStamp(ri.nextRunAt)}.`
                : ri.status === "paused"
                  ? "Resume it to start scheduling runs."
                  : ""}
            </p>
          )}
          {ri.runsCreated > 0 && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              All generated invoices show up in the regular{" "}
              <Link
                to={`/c/${company.slug}/finance/invoices`}
                className="text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Invoices
              </Link>{" "}
              list — filter by this customer to see only theirs.
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Line items template
          </h3>
        </div>
        {ri.lines.length === 0 ? (
          <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
            No line items yet — edit this schedule to add some.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Description</th>
                <th className="w-24 px-4 py-2 text-right font-medium">Qty</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Unit price</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {ri.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                    {l.description}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {l.quantity}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoney(l.unitPriceCents, ri.currency)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {formatMoney(
                      Math.round(l.quantity * l.unitPriceCents),
                      ri.currency,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(ri.notes || ri.footer) && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ri.notes && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Notes
              </h3>
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                {ri.notes}
              </p>
            </div>
          )}
          {ri.footer && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Footer
              </h3>
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                {ri.footer}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="text-right text-sm text-slate-800 dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}
