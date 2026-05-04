import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Ban, CheckCircle2, Plus, Trash2 } from "lucide-react";
import {
  api,
  Bill,
  BillPaymentMethod,
  displayBillStatus,
  formatMoney,
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
 * Bill detail. Phase G of the Finance milestone (M19). Mirrors
 * FinanceInvoiceDetail with the actions flipped to the AP side
 * (record payment = "we paid them" rather than "they paid us").
 */
export default function FinanceBillDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { billSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [bill, setBill] = React.useState<Bill | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showPay, setShowPay] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!billSlug) return;
    try {
      const b = await api.get<Bill>(`/api/companies/${company.id}/bills/${billSlug}`);
      setBill(b);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [company.id, billSlug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function issue() {
    if (!bill) return;
    setBusy(true);
    try {
      const fresh = await api.post<Bill>(
        `/api/companies/${company.id}/bills/${bill.slug}/issue`,
      );
      setBill(fresh);
      navigate(`/c/${company.slug}/finance/bills/${fresh.slug}`, { replace: true });
      toast(`Issued as ${fresh.number}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function voidIt() {
    if (!bill) return;
    const ok = await dialog.confirm({
      title: `Void ${bill.number}?`,
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const fresh = await api.post<Bill>(`/api/companies/${company.id}/bills/${bill.slug}/void`);
      setBill(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!bill) return;
    const ok = await dialog.confirm({
      title: "Delete this draft?",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/bills/${bill.slug}`);
      navigate(`/c/${company.slug}/finance/bills`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deletePayment(pid: string) {
    if (!bill) return;
    const ok = await dialog.confirm({
      title: "Delete this payment?",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      const fresh = await api.del<Bill>(
        `/api/companies/${company.id}/bills/${bill.slug}/payments/${pid}`,
      );
      setBill(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (!bill) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }
  const ds = displayBillStatus(bill);
  const number = bill.number || "DRAFT";

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Bills", to: `/c/${company.slug}/finance/bills` },
            { label: number },
          ]}
        />
      </div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/c/${company.slug}/finance/bills`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{number}</h1>
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
          {bill.status === "draft" && (
            <Button onClick={issue} disabled={busy}>
              <CheckCircle2 size={14} /> Issue
            </Button>
          )}
          {bill.status !== "void" && bill.status !== "draft" && (
            <Button variant="secondary" onClick={() => setShowPay(true)} disabled={busy}>
              <Plus size={14} /> Record payment
            </Button>
          )}
          {bill.status !== "void" && bill.status !== "draft" && (
            <Button variant="secondary" onClick={voidIt} disabled={busy}>
              <Ban size={14} /> Void
            </Button>
          )}
          {bill.status === "draft" && (
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
                  Vendor
                </div>
                <div className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                  {bill.vendor?.name ?? "—"}
                </div>
                {bill.vendorRef && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Their ref: {bill.vendorRef}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Issued
                </div>
                <div className="mt-1 text-slate-700 dark:text-slate-200">
                  {new Date(bill.issueDate).toISOString().slice(0, 10)}
                </div>
                <div className="mt-2 text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Due
                </div>
                <div className="text-slate-700 dark:text-slate-200">
                  {new Date(bill.dueDate).toISOString().slice(0, 10)}
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
                  {bill.lines.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="p-6 text-center text-sm text-slate-400">
                        No line items
                      </td>
                    </tr>
                  ) : (
                    bill.lines.map((l) => (
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
                          {formatMoney(l.unitPriceCents, bill.currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                          {formatMoney(l.lineTotalCents, bill.currency)}
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
                  {formatMoney(bill.subtotalCents, bill.currency)}
                </span>
              </div>
              <div className="flex justify-between text-slate-500 dark:text-slate-400">
                <span>Tax</span>
                <span className="tabular-nums">
                  {formatMoney(bill.taxCents, bill.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
                <span>Total</span>
                <span className="tabular-nums">
                  {formatMoney(bill.totalCents, bill.currency)}
                </span>
              </div>
              {bill.paidCents > 0 && (
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>Paid</span>
                  <span className="tabular-nums">
                    {formatMoney(bill.paidCents, bill.currency)}
                  </span>
                </div>
              )}
              {bill.balanceCents > 0 && (
                <div className="flex justify-between text-amber-700 dark:text-amber-400">
                  <span>Balance due</span>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(bill.balanceCents, bill.currency)}
                  </span>
                </div>
              )}
            </div>

            {bill.notes && (
              <div className="mt-6 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Notes
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                  {bill.notes}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Payments made
            </h3>
            {bill.payments.length === 0 ? (
              <div className="mt-3 text-sm text-slate-400">No payments yet.</div>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {bill.payments.map((p) => (
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
        </div>
      </div>

      {showPay && (
        <PaymentModal
          companyId={company.id}
          bill={bill}
          onClose={() => setShowPay(false)}
          onSaved={(fresh) => {
            setShowPay(false);
            setBill(fresh);
          }}
        />
      )}
    </div>
  );
}

function PaymentModal({
  companyId,
  bill,
  onClose,
  onSaved,
}: {
  companyId: string;
  bill: Bill;
  onClose: () => void;
  onSaved: (fresh: Bill) => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = React.useState((bill.balanceCents / 100).toFixed(2));
  const [paidAt, setPaidAt] = React.useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = React.useState<BillPaymentMethod>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const fresh = await api.post<Bill>(
        `/api/companies/${companyId}/bills/${bill.slug}/payments`,
        {
          amountCents: parseMoneyToCents(amount),
          currency: bill.currency,
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
        <Input label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        <Input label="Date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required />
        <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value as BillPaymentMethod)}>
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="stripe">Stripe</option>
          <option value="lightning">Lightning</option>
          <option value="other">Other</option>
        </Select>
        <Input label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || parseMoneyToCents(amount) <= 0}>Record payment</Button>
        </div>
      </form>
    </Modal>
  );
}
