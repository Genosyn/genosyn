import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  Download,
  Mail,
  Pencil,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  api,
  displayEstimateStatus,
  Estimate,
  formatMoney,
  Invoice,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  expired: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  declined: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  invoiced: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Estimate detail. Renders the line items and exposes the lifecycle
 * actions (Issue / Send / Accept / Decline / Convert / Void / Delete)
 * appropriate to the current status. The printable HTML lives at a
 * separate route so File → Print gives a clean PDF without app chrome.
 */
export default function FinanceEstimateDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { estimateSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!estimateSlug) return;
    try {
      const est = await api.get<Estimate>(
        `/api/companies/${company.id}/estimates/${estimateSlug}`,
      );
      setEstimate(est);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, estimateSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function issue() {
    if (!estimate) return;
    setBusy(true);
    try {
      const fresh = await api.post<Estimate>(
        `/api/companies/${company.id}/estimates/${estimate.slug}/issue`,
      );
      setEstimate(fresh);
      navigate(`/c/${company.slug}/finance/estimates/${fresh.slug}`, {
        replace: true,
      });
      toast(`Issued as ${fresh.number}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!estimate) return;
    setBusy(true);
    try {
      const result = await api.post<{
        estimate: Estimate;
        send: { status: string; errorMessage: string };
      }>(`/api/companies/${company.id}/estimates/${estimate.slug}/send`);
      setEstimate(result.estimate);
      if (result.estimate.slug !== estimate.slug) {
        navigate(
          `/c/${company.slug}/finance/estimates/${result.estimate.slug}`,
          { replace: true },
        );
      }
      if (result.send.status === "sent") {
        toast("Estimate emailed to customer", "success");
      } else if (result.send.status === "skipped") {
        toast(
          "No email transport configured — set one in Settings → Email",
          "info",
        );
      } else {
        toast(
          `Email failed: ${result.send.errorMessage || "unknown"}`,
          "error",
        );
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!estimate) return;
    setBusy(true);
    try {
      const fresh = await api.post<Estimate>(
        `/api/companies/${company.id}/estimates/${estimate.slug}/accept`,
      );
      setEstimate(fresh);
      toast("Estimate marked as accepted", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!estimate) return;
    const ok = await dialog.confirm({
      title: `Mark ${estimate.number || "estimate"} as declined?`,
      message:
        "The customer has chosen not to proceed. You can still void it later if needed.",
      confirmLabel: "Mark declined",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const fresh = await api.post<Estimate>(
        `/api/companies/${company.id}/estimates/${estimate.slug}/decline`,
      );
      setEstimate(fresh);
      toast("Estimate marked as declined", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    if (!estimate) return;
    const ok = await dialog.confirm({
      title: `Convert ${estimate.number || "estimate"} to an invoice?`,
      message:
        "A new invoice will be created from these line items and immediately issued. The estimate stays linked to the new invoice.",
      confirmLabel: "Convert",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api.post<{ estimate: Estimate; invoice: Invoice }>(
        `/api/companies/${company.id}/estimates/${estimate.slug}/convert`,
        {},
      );
      setEstimate(result.estimate);
      toast(`Invoiced as ${result.invoice.number}`, "success");
      navigate(
        `/c/${company.slug}/finance/invoices/${result.invoice.slug}`,
      );
    } catch (err) {
      toast((err as Error).message, "error");
      setBusy(false);
    }
  }

  async function voidEstimate() {
    if (!estimate) return;
    const ok = await dialog.confirm({
      title: `Void ${estimate.number}?`,
      message:
        "Voiding cannot be undone. The estimate stays in records but is marked as cancelled.",
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const fresh = await api.post<Estimate>(
        `/api/companies/${company.id}/estimates/${estimate.slug}/void`,
      );
      setEstimate(fresh);
      toast("Estimate voided", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!estimate) return;
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(
        `/api/companies/${company.id}/estimates/${estimate.slug}`,
      );
      navigate(`/c/${company.slug}/finance/estimates`);
    } catch (err) {
      toast((err as Error).message, "error");
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-sm text-slate-500">
        {loadError === "Estimate not found"
          ? "This estimate doesn't exist or was deleted."
          : loadError}
      </div>
    );
  }
  if (!estimate) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const ds = displayEstimateStatus(estimate);
  const number = estimate.number || "DRAFT";
  const isConverted = !!estimate.invoiceId;
  const isTerminal =
    estimate.status === "void" ||
    estimate.status === "declined" ||
    isConverted;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Estimates", to: `/c/${company.slug}/finance/estimates` },
            { label: number },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/c/${company.slug}/finance/estimates`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {number}
          </h1>
          <span
            className={
              "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
              STATUS_BADGE[ds]
            }
          >
            {ds}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {estimate.status === "draft" && (
            <Link
              to={`/c/${company.slug}/finance/estimates/${estimate.slug}/edit`}
            >
              <Button variant="secondary" disabled={busy}>
                <Pencil size={14} /> Edit
              </Button>
            </Link>
          )}
          {estimate.status === "draft" && (
            <Button onClick={issue} disabled={busy}>
              <CheckCircle2 size={14} /> Issue
            </Button>
          )}
          {estimate.status === "draft" && (
            <Button onClick={send} disabled={busy}>
              <Send size={14} /> Issue & send
            </Button>
          )}
          {(estimate.status === "sent" || estimate.status === "accepted") &&
            !isConverted && (
              <Button variant="secondary" onClick={send} disabled={busy}>
                <Mail size={14} /> Resend email
              </Button>
            )}
          {estimate.status === "sent" && !isConverted && (
            <Button onClick={accept} disabled={busy}>
              <CheckCircle2 size={14} /> Mark accepted
            </Button>
          )}
          {estimate.status === "sent" && !isConverted && (
            <Button variant="secondary" onClick={decline} disabled={busy}>
              <XCircle size={14} /> Mark declined
            </Button>
          )}
          {(estimate.status === "sent" || estimate.status === "accepted") &&
            !isConverted && (
              <Button onClick={convert} disabled={busy}>
                <ArrowRight size={14} /> Convert to invoice
              </Button>
            )}
          <a
            href={`/api/companies/${company.id}/estimates/${estimate.slug}/pdf`}
            download={`${estimate.number || "draft"}.pdf`}
          >
            <Button variant="secondary" disabled={busy}>
              <Download size={14} /> Download PDF
            </Button>
          </a>
          {!isTerminal && estimate.status !== "draft" && (
            <Button variant="secondary" onClick={voidEstimate} disabled={busy}>
              <Ban size={14} /> Void
            </Button>
          )}
          {estimate.status === "draft" && (
            <Button variant="secondary" onClick={deleteDraft} disabled={busy}>
              <Trash2 size={14} /> Delete
            </Button>
          )}
        </div>
      </div>

      {isConverted && estimate.invoice && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
          <div className="flex items-center justify-between gap-3">
            <div className="text-slate-700 dark:text-slate-200">
              Converted to invoice{" "}
              <Link
                to={`/c/${company.slug}/finance/invoices/${estimate.invoice.slug}`}
                className="font-mono font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                {estimate.invoice.number}
              </Link>
              {estimate.convertedAt &&
                ` on ${new Date(estimate.convertedAt).toISOString().slice(0, 10)}`}
              .
            </div>
            <Link
              to={`/c/${company.slug}/finance/invoices/${estimate.invoice.slug}`}
            >
              <Button variant="secondary">
                Open invoice <ArrowRight size={14} />
              </Button>
            </Link>
          </div>
        </div>
      )}

      <div className="space-y-6">
        <div>
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="grid grid-cols-2 gap-6 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Prepared for
                </div>
                <div className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                  {estimate.customer?.name ?? "—"}
                </div>
                <div className="text-slate-500 dark:text-slate-400">
                  {estimate.customer?.email}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Issued
                </div>
                <div className="mt-1 text-slate-700 dark:text-slate-200">
                  {new Date(estimate.issueDate).toISOString().slice(0, 10)}
                </div>
                <div className="mt-2 text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Valid until
                </div>
                <div className="text-slate-700 dark:text-slate-200">
                  {new Date(estimate.validUntil).toISOString().slice(0, 10)}
                </div>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      Description
                    </th>
                    <th className="w-20 px-3 py-2 text-right font-medium">
                      Qty
                    </th>
                    <th className="w-32 px-3 py-2 text-right font-medium">
                      Unit
                    </th>
                    <th className="w-32 px-3 py-2 text-right font-medium">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {estimate.lines.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="p-6 text-center text-sm text-slate-400"
                      >
                        No line items
                      </td>
                    </tr>
                  ) : (
                    estimate.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                          {l.description}
                          {l.taxPercent > 0 && (
                            <div className="text-xs text-slate-400">
                              {l.taxName} {l.taxPercent}%
                              {l.taxInclusive ? " incl." : ""}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                          {l.quantity}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                          {formatMoney(l.unitPriceCents, estimate.currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                          {formatMoney(l.lineTotalCents, estimate.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 ml-auto w-72 space-y-1 text-sm">
              <div className="flex justify-between text-slate-500 dark:text-slate-400">
                <span>Subtotal</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.subtotalCents, estimate.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-500 dark:text-slate-400">
                <span>Tax</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.taxCents, estimate.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoney(estimate.totalCents, estimate.currency)}
                </span>
              </div>
            </div>

            {(estimate.notes || estimate.footer) && (
              <div className="mt-6 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                {estimate.notes && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Notes
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                      {estimate.notes}
                    </div>
                  </div>
                )}
                {estimate.footer && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Footer
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-500 dark:text-slate-400">
                      {estimate.footer}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Activity
          </h3>
          <ul className="mt-3 grid gap-1.5 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2 lg:grid-cols-3">
            <li>
              Created {new Date(estimate.createdAt).toISOString().slice(0, 10)}
            </li>
            {estimate.sentAt && (
              <li>
                Sent {new Date(estimate.sentAt).toISOString().slice(0, 10)}
              </li>
            )}
            {estimate.acceptedAt && (
              <li>
                Accepted{" "}
                {new Date(estimate.acceptedAt).toISOString().slice(0, 10)}
              </li>
            )}
            {estimate.declinedAt && (
              <li>
                Declined{" "}
                {new Date(estimate.declinedAt).toISOString().slice(0, 10)}
              </li>
            )}
            {estimate.convertedAt && (
              <li>
                Invoiced{" "}
                {new Date(estimate.convertedAt).toISOString().slice(0, 10)}
              </li>
            )}
            {estimate.voidedAt && (
              <li>
                Voided {new Date(estimate.voidedAt).toISOString().slice(0, 10)}
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
