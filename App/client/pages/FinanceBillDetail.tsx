import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Ban, CheckCircle2, Plus, Trash2, Undo2 } from "lucide-react";
import {
  api,
  Bill,
  BillPaymentMethod,
  displayBillStatus,
  formatExchangeRate,
  formatMoney,
  parseMoneyToCents,
  VendorCreditDetail,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Textarea } from "../components/ui/Textarea";
import { FormError } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import { DocumentLinesTable } from "@/components/finance/DocumentLinesTable";
import { RecordHistory } from "@/components/RecordHistory";
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
 * (record payment = "we paid them" rather than "they paid us"). A read-only
 * Member gets the bill without any of them.
 */
export default function FinanceBillDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const { billSlug } = useParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const [bill, setBill] = React.useState<Bill | null>(null);
  /** What the bill's and its payments' locked rates convert into. */
  const [homeCurrency, setHomeCurrency] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<null | "issue" | "void">(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deletingPaymentId, setDeletingPaymentId] = React.useState<string | null>(null);
  const [showPay, setShowPay] = React.useState(false);
  const [showCredit, setShowCredit] = React.useState(false);

  // True once this slug has loaded. Issuing a draft re-slugs the bill from
  // `bdraft-…` to `bil-nnnn`, and the socket refetch that write triggers can
  // land in the moment before we navigate to the new URL. Reading that 404 as
  // "deleted" is what made Issue blank the page out from under the bill it had
  // just issued — so once we have something on screen, a failed background
  // refetch leaves it there and waits for the next one.
  const shown = React.useRef(false);

  const reload = React.useCallback(async () => {
    if (!billSlug) return;
    try {
      const b = await api.get<Bill & { homeCurrency: string }>(
        `/api/companies/${company.id}/bills/${billSlug}`,
      );
      setBill(b);
      setHomeCurrency(b.homeCurrency ?? null);
      shown.current = true;
      setLoadError(null);
    } catch (err) {
      if (shown.current) return;
      setLoadError(errorMessage(err, "Could not load the bill"));
    }
  }, [company.id, billSlug]);

  React.useEffect(() => {
    // A different bill is a fresh page: its own 404 is worth showing.
    shown.current = false;
    reload();
  }, [reload]);

  useLiveRefetch("bill", reload);

  async function issue() {
    if (!bill) return;
    setBusy("issue");
    try {
      const fresh = await api.post<Bill>(
        `/api/companies/${company.id}/bills/${bill.slug}/issue`,
      );
      setBill(fresh);
      navigate(`/c/${company.slug}/finance/bills/${fresh.slug}`, { replace: true });
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t issue the bill" });
    } finally {
      setBusy(null);
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
    setBusy("void");
    try {
      const fresh = await api.post<Bill>(`/api/companies/${company.id}/bills/${bill.slug}/void`);
      setBill(fresh);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t void the bill" });
    } finally {
      setBusy(null);
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
    setDeleting(true);
    try {
      await api.del(`/api/companies/${company.id}/bills/${bill.slug}`);
      navigate(`/c/${company.slug}/finance/bills`);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the draft" });
    } finally {
      setDeleting(false);
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
    setDeletingPaymentId(pid);
    try {
      const fresh = await api.del<Bill>(
        `/api/companies/${company.id}/bills/${bill.slug}/payments/${pid}`,
      );
      setBill(fresh);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the payment" });
    } finally {
      setDeletingPaymentId(null);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-sm text-slate-500">
        {loadError === "Bill not found"
          ? "This bill doesn't exist or was deleted."
          : loadError}
      </div>
    );
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
  // Locked rates are shown only on a bill in a currency other than home.
  const home = homeCurrency ?? bill.currency;
  const foreign = bill.currency.toUpperCase() !== home.toUpperCase();

  return (
    <div className="page-shell p-4 sm:p-8">
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
            className="touch-target relative rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">{number}</h1>
          <span
            className={
              "inline-block rounded-full px-2 py-0.5 text-xs font-medium first-letter:uppercase " +
              STATUS_BADGE[ds]
            }
          >
            {ds}
          </span>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {bill.status === "draft" && (
              <Button onClick={issue} loading={busy === "issue"} disabled={busy !== null}>
                <CheckCircle2 size={14} /> Issue
              </Button>
            )}
            {bill.status !== "void" && bill.status !== "draft" && (
              <Button variant="secondary" onClick={() => setShowPay(true)} disabled={busy !== null}>
                <Plus size={14} /> Record payment
              </Button>
            )}
            {bill.status !== "void" && bill.status !== "draft" && bill.balanceCents > 0 && (
              <Button
                variant="secondary"
                onClick={() => setShowCredit(true)}
                disabled={busy !== null}
              >
                <Undo2 size={14} /> Vendor credit
              </Button>
            )}
            {bill.status !== "void" && bill.status !== "draft" && (
              <Button
                variant="secondary"
                onClick={voidIt}
                loading={busy === "void"}
                disabled={busy !== null}
              >
                <Ban size={14} /> Void
              </Button>
            )}
            {bill.status === "draft" && (
              <Button
                variant="secondary"
                onClick={deleteDraft}
                loading={deleting}
                disabled={busy !== null}
              >
                <Trash2 size={14} /> Delete
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="grid grid-cols-2 gap-6 text-sm">
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
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
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Issued
                </div>
                <div className="mt-1 text-slate-700 dark:text-slate-200">
                  {new Date(bill.issueDate).toISOString().slice(0, 10)}
                </div>
                <div className="text-xs font-medium mt-2 text-slate-500 dark:text-slate-400">
                  Due
                </div>
                <div className="text-slate-700 dark:text-slate-200">
                  {new Date(bill.dueDate).toISOString().slice(0, 10)}
                </div>
              </div>
            </div>

            <DocumentLinesTable lines={bill.lines} currency={bill.currency} />

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
              {foreign && bill.exchangeRate !== null && (
                <div
                  className="flex justify-between text-xs text-slate-400 dark:text-slate-500"
                  title="Locked when the bill was issued: its payments and vendor credits clear the payable at this rate."
                >
                  <span>
                    Booked in {home} at {formatExchangeRate(bill.exchangeRate)}
                  </span>
                  <span className="tabular-nums">
                    {formatMoney(Math.round(bill.totalCents * bill.exchangeRate), home)}
                  </span>
                </div>
              )}
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
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Notes
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                  {bill.notes}
                </div>
              </div>
            )}
          </div>
          <RecordHistory
            className="mt-6"
            companyId={company.id}
            companySlug={company.slug}
            targetType="bill"
            targetId={bill.id}
            noun="this bill"
            currency={bill.currency}
            milestones={[
              { label: "Bill created", at: bill.createdAt, covers: ["create"] },
              { label: "Bill issued", at: bill.receivedAt, covers: ["issue"] },
              { label: "Bill paid", at: bill.paidAt, covers: ["payment"] },
              { label: "Bill voided", at: bill.voidedAt, covers: ["void"] },
            ]}
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">
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
                      {foreign && p.exchangeRate !== null && (
                        <div
                          className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                          title="The rate of the day it was paid, locked when the payment was recorded."
                        >
                          {formatMoney(Math.round(p.amountCents * p.exchangeRate), home)} at{" "}
                          {formatExchangeRate(p.exchangeRate)}
                        </div>
                      )}
                    </div>
                    {canWrite && (
                      <button
                        onClick={() => deletePayment(p.id)}
                        disabled={deletingPaymentId === p.id}
                        aria-busy={deletingPaymentId === p.id || undefined}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                        aria-label="Delete payment"
                      >
                        {deletingPaymentId === p.id ? (
                          <ButtonSpinner size={12} />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </button>
                    )}
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

      {showCredit && (
        <VendorCreditModal
          companyId={company.id}
          bill={bill}
          onClose={() => setShowCredit(false)}
          onCreated={(credit) => {
            setShowCredit(false);
            navigate(`/c/${company.slug}/finance/vendor-credits/${credit.slug}`);
          }}
        />
      )}
    </div>
  );
}

function VendorCreditModal({
  companyId,
  bill,
  onClose,
  onCreated,
}: {
  companyId: string;
  bill: Bill;
  onClose: () => void;
  onCreated: (credit: VendorCreditDetail) => void;
}) {
  const [mode, setMode] = React.useState<"full" | "amount">("full");
  const [amount, setAmount] = React.useState((bill.balanceCents / 100).toFixed(2));
  const [applyNow, setApplyNow] = React.useState(true);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    const body: Record<string, unknown> = { mode, applyNow, reason: reason.trim() || undefined };
    if (mode === "amount") {
      const amountCents = parseMoneyToCents(amount);
      if (amountCents <= 0) {
        setError("Enter a positive amount");
        return;
      }
      body.amountCents = amountCents;
    }
    setBusy(true);
    try {
      onCreated(
        await api.post<VendorCreditDetail>(
          `/api/companies/${companyId}/bills/${bill.slug}/vendor-credit`,
          body,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Vendor credit">
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Record a credit the supplier gave you against this bill — it reverses the
          expense (and input tax on a full credit) and can be applied to reduce what
          you owe.
        </p>
        <Select label="Amount" value={mode} onChange={(e) => setMode(e.target.value as "full" | "amount")}>
          <option value="full">Full — credit the whole bill</option>
          <option value="amount">Partial — a specific amount</option>
        </Select>
        {mode === "amount" && (
          <Input
            label={`Amount (${bill.currency}, ex-tax)`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        )}
        <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} />
          Apply to this bill now (reduce its balance)
        </label>
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy}>{busy ? "Creating…" : "Create vendor credit"}</Button>
        </div>
      </div>
    </Modal>
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
  const [amount, setAmount] = React.useState((bill.balanceCents / 100).toFixed(2));
  const [paidAt, setPaidAt] = React.useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = React.useState<BillPaymentMethod>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cents = parseMoneyToCents(amount);
  const overpay = cents > bill.balanceCents;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Record payment">
      <form onSubmit={save} className="space-y-4">
        <div>
          <Input label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
          <p className={`mt-1 text-xs ${overpay ? "text-amber-600 dark:text-amber-400" : "text-slate-500"}`}>
            {overpay
              ? `Exceeds the ${formatMoney(bill.balanceCents, bill.currency)} balance due`
              : `Balance due: ${formatMoney(bill.balanceCents, bill.currency)}`}
          </p>
        </div>
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
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={cents <= 0 || overpay}>Record payment</Button>
        </div>
      </form>
    </Modal>
  );
}
