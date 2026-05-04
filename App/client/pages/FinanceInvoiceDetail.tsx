import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Mail,
  Plus,
  Printer,
  Send,
  Trash2,
} from "lucide-react";
import {
  api,
  displayInvoiceStatus,
  formatMoney,
  Invoice,
  InvoicePaymentMethod,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  sent: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  overdue: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Invoice detail. Phase A of the Finance milestone (M19).
 *
 * Renders the line items + payments and exposes the lifecycle actions
 * (Issue / Send / Mark paid / Void / Delete) appropriate to the current
 * status. The printable HTML lives at a separate route so File → Print
 * gives a clean PDF without app chrome.
 */
export default function FinanceInvoiceDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { invoiceSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [invoice, setInvoice] = React.useState<Invoice | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showPay, setShowPay] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!invoiceSlug) return;
    try {
      const inv = await api.get<Invoice>(
        `/api/companies/${company.id}/invoices/${invoiceSlug}`,
      );
      setInvoice(inv);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, invoiceSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function issue() {
    if (!invoice) return;
    setBusy(true);
    try {
      const fresh = await api.post<Invoice>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/issue`,
      );
      setInvoice(fresh);
      // Slug changes from `draft-…` to `inv-####` on issue — redirect.
      navigate(`/c/${company.slug}/finance/invoices/${fresh.slug}`, { replace: true });
      toast(`Issued as ${fresh.number}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!invoice) return;
    setBusy(true);
    try {
      const result = await api.post<{
        invoice: Invoice;
        send: { status: string; errorMessage: string };
      }>(`/api/companies/${company.id}/invoices/${invoice.slug}/send`);
      setInvoice(result.invoice);
      // Slug may have just changed if this was a draft.
      if (result.invoice.slug !== invoice.slug) {
        navigate(`/c/${company.slug}/finance/invoices/${result.invoice.slug}`, {
          replace: true,
        });
      }
      if (result.send.status === "sent") {
        toast("Invoice emailed to customer", "success");
      } else if (result.send.status === "skipped") {
        toast("No email transport configured — set one in Settings → Email", "info");
      } else {
        toast(`Email failed: ${result.send.errorMessage || "unknown"}`, "error");
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function voidInvoice() {
    if (!invoice) return;
    const ok = await dialog.confirm({
      title: `Void ${invoice.number}?`,
      message: "Voiding cannot be undone. The invoice stays in records but won't count toward outstanding balance.",
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const fresh = await api.post<Invoice>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/void`,
      );
      setInvoice(fresh);
      toast("Invoice voided", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!invoice) return;
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/invoices/${invoice.slug}`);
      navigate(`/c/${company.slug}/finance/invoices`);
    } catch (err) {
      toast((err as Error).message, "error");
      setBusy(false);
    }
  }

  async function deletePayment(paymentId: string) {
    if (!invoice) return;
    const ok = await dialog.confirm({
      title: "Delete this payment?",
      message: "The invoice balance will recompute and may revert from paid to sent.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      const fresh = await api.del<Invoice>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/payments/${paymentId}`,
      );
      setInvoice(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-sm text-slate-500">
        {loadError === "Invoice not found"
          ? "This invoice doesn't exist or was deleted."
          : loadError}
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  const ds = displayInvoiceStatus(invoice);
  const number = invoice.number || "DRAFT";

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Invoices", to: `/c/${company.slug}/finance/invoices` },
            { label: number },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/c/${company.slug}/finance/invoices`}
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
          {invoice.status === "draft" && (
            <Button onClick={issue} disabled={busy}>
              <CheckCircle2 size={14} /> Issue
            </Button>
          )}
          {(invoice.status === "sent" || invoice.status === "paid") && (
            <Button variant="secondary" onClick={send} disabled={busy}>
              <Mail size={14} /> Resend email
            </Button>
          )}
          {invoice.status === "draft" && (
            <Button onClick={send} disabled={busy}>
              <Send size={14} /> Issue & send
            </Button>
          )}
          {invoice.status !== "void" && invoice.status !== "draft" && (
            <Button
              variant="secondary"
              onClick={() => setShowPay(true)}
              disabled={busy}
            >
              <Plus size={14} /> Record payment
            </Button>
          )}
          <a
            href={`/api/companies/${company.id}/invoices/${invoice.slug}/html`}
            target="_blank"
            rel="noreferrer"
          >
            <Button variant="secondary" disabled={busy}>
              <Printer size={14} /> Print / PDF
            </Button>
          </a>
          {invoice.status !== "void" && invoice.status !== "draft" && (
            <Button variant="secondary" onClick={voidInvoice} disabled={busy}>
              <Ban size={14} /> Void
            </Button>
          )}
          {invoice.status === "draft" && (
            <Button variant="secondary" onClick={deleteDraft} disabled={busy}>
              <Trash2 size={14} /> Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="grid grid-cols-2 gap-6 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Bill to
                </div>
                <div className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                  {invoice.customer?.name ?? "—"}
                </div>
                <div className="text-slate-500 dark:text-slate-400">
                  {invoice.customer?.email}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Issued
                </div>
                <div className="mt-1 text-slate-700 dark:text-slate-200">
                  {new Date(invoice.issueDate).toISOString().slice(0, 10)}
                </div>
                <div className="mt-2 text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Due
                </div>
                <div className="text-slate-700 dark:text-slate-200">
                  {new Date(invoice.dueDate).toISOString().slice(0, 10)}
                </div>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="w-20 px-3 py-2 text-right font-medium">Qty</th>
                    <th className="w-32 px-3 py-2 text-right font-medium">Unit</th>
                    <th className="w-32 px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {invoice.lines.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="p-6 text-center text-sm text-slate-400">
                        No line items
                      </td>
                    </tr>
                  ) : (
                    invoice.lines.map((l) => (
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
                          {formatMoney(l.unitPriceCents, invoice.currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                          {formatMoney(l.lineTotalCents, invoice.currency)}
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
                  {formatMoney(invoice.subtotalCents, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-500 dark:text-slate-400">
                <span>Tax</span>
                <span className="tabular-nums">
                  {formatMoney(invoice.taxCents, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoney(invoice.totalCents, invoice.currency)}
                </span>
              </div>
              {invoice.paidCents > 0 && (
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>Paid</span>
                  <span className="tabular-nums">
                    {formatMoney(invoice.paidCents, invoice.currency)}
                  </span>
                </div>
              )}
              {invoice.balanceCents > 0 && (
                <div className="flex justify-between text-amber-700 dark:text-amber-400">
                  <span>Balance due</span>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(invoice.balanceCents, invoice.currency)}
                  </span>
                </div>
              )}
            </div>

            {(invoice.notes || invoice.footer) && (
              <div className="mt-6 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                {invoice.notes && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Notes
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                      {invoice.notes}
                    </div>
                  </div>
                )}
                {invoice.footer && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Footer
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-500 dark:text-slate-400">
                      {invoice.footer}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Payments
            </h3>
            {invoice.payments.length === 0 ? (
              <div className="mt-3 text-sm text-slate-400">No payments yet.</div>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {invoice.payments.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(p.amountCents, p.currency)}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {new Date(p.paidAt).toISOString().slice(0, 10)} ·{" "}
                        {p.method}
                        {p.reference ? ` · ${p.reference}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => deletePayment(p.id)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      aria-label="Delete payment"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Activity
            </h3>
            <ul className="mt-3 space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
              <li>Created {new Date(invoice.createdAt).toISOString().slice(0, 10)}</li>
              {invoice.sentAt && (
                <li>Issued {new Date(invoice.sentAt).toISOString().slice(0, 10)}</li>
              )}
              {invoice.paidAt && (
                <li>Paid {new Date(invoice.paidAt).toISOString().slice(0, 10)}</li>
              )}
              {invoice.voidedAt && (
                <li>Voided {new Date(invoice.voidedAt).toISOString().slice(0, 10)}</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {showPay && (
        <PaymentModal
          companyId={company.id}
          invoice={invoice}
          onClose={() => setShowPay(false)}
          onSaved={(fresh) => {
            setShowPay(false);
            setInvoice(fresh);
          }}
        />
      )}
    </div>
  );
}

function PaymentModal({
  companyId,
  invoice,
  onClose,
  onSaved,
}: {
  companyId: string;
  invoice: Invoice;
  onClose: () => void;
  onSaved: (fresh: Invoice) => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = React.useState(
    (invoice.balanceCents / 100).toFixed(2),
  );
  const [paidAt, setPaidAt] = React.useState(
    new Date().toISOString().slice(0, 10),
  );
  const [method, setMethod] = React.useState<InvoicePaymentMethod>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const fresh = await api.post<Invoice>(
        `/api/companies/${companyId}/invoices/${invoice.slug}/payments`,
        {
          amountCents: parseMoneyToCents(amount),
          currency: invoice.currency,
          paidAt: new Date(paidAt).toISOString(),
          method,
          reference: reference.trim(),
          notes,
        },
      );
      onSaved(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Record payment">
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          required
        />
        <Input
          label="Date"
          type="date"
          value={paidAt}
          onChange={(e) => setPaidAt(e.target.value)}
          required
        />
        <Select
          label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value as InvoicePaymentMethod)}
        >
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="stripe">Stripe</option>
          <option value="lightning">Lightning</option>
          <option value="other">Other</option>
        </Select>
        <Input
          label="Reference (optional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Bank txn id, Stripe charge id, …"
        />
        <Textarea
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || parseMoneyToCents(amount) <= 0}>
            Record payment
          </Button>
        </div>
      </form>
    </Modal>
  );
}
