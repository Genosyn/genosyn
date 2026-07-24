import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Ban, Plus, Trash2, Undo2 } from "lucide-react";
import {
  api,
  CreditNoteDetail,
  CustomerRefundRow,
  formatMoney,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  issued: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

export default function FinanceCreditNoteDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { creditSlug } = useParams();
  const { toast } = useToast();
  const dialog = useDialog();
  const [credit, setCredit] = React.useState<CreditNoteDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showApply, setShowApply] = React.useState(false);
  const [showRefund, setShowRefund] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!creditSlug) return;
    try {
      setCredit(
        await api.get<CreditNoteDetail>(
          `/api/companies/${company.id}/credit-notes/${creditSlug}`,
        ),
      );
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, creditSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);
  useLiveRefetch("invoice", reload);

  async function unapply(appId: string) {
    if (!credit) return;
    const ok = await dialog.confirm({
      title: "Unapply this credit?",
      message: "The amount goes back onto the invoice and the credit becomes available again.",
      confirmLabel: "Unapply",
    });
    if (!ok) return;
    try {
      setCredit(
        await api.del<CreditNoteDetail>(
          `/api/companies/${company.id}/credit-notes/${credit.slug}/applications/${appId}`,
        ),
      );
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function voidRefund(refundId: string) {
    if (!credit) return;
    const ok = await dialog.confirm({
      title: "Reverse this refund?",
      message: "Posts a reversing entry (money came back) and reopens the credit balance.",
      confirmLabel: "Reverse",
    });
    if (!ok) return;
    try {
      setCredit(
        await api.del<CreditNoteDetail>(
          `/api/companies/${company.id}/customer-refunds/${refundId}`,
        ),
      );
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function voidCredit() {
    if (!credit) return;
    const ok = await dialog.confirm({
      title: `Void ${credit.number}?`,
      message: "Reverses the credit note's postings. Only possible while nothing is applied.",
      variant: "danger",
      confirmLabel: "Void",
    });
    if (!ok) return;
    try {
      setCredit(
        await api.post<CreditNoteDetail>(
          `/api/companies/${company.id}/credit-notes/${credit.slug}/void`,
          {},
        ),
      );
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-sm text-slate-500">
        {loadError === "Credit note not found"
          ? "This credit note doesn't exist."
          : loadError}
      </div>
    );
  }
  if (!credit) {
    return (
      <div className="flex justify-center p-12">
        <Spinner />
      </div>
    );
  }

  const canVoid = credit.kind === "credit_memo" && credit.status === "issued" && credit.openCents === credit.totalCents;
  const canApply = credit.status === "issued" && credit.openCents > 0;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Credit notes", to: `/c/${company.slug}/finance/credit-notes` },
            { label: credit.number || "Draft" },
          ]}
        />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to={`/c/${company.slug}/finance/credit-notes`}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {credit.number || "Draft"}
          </h1>
          <span
            className={
              "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
              (STATUS_BADGE[credit.status] ?? STATUS_BADGE.draft)
            }
          >
            {credit.status}
          </span>
        </div>
        <div className="flex gap-2">
          {canApply && (
            <Button onClick={() => setShowApply(true)}>
              <Plus size={14} /> Apply to invoice
            </Button>
          )}
          {canApply && (
            <Button variant="secondary" onClick={() => setShowRefund(true)}>
              <Undo2 size={14} /> Refund
            </Button>
          )}
          {canVoid && (
            <Button variant="secondary" onClick={voidCredit}>
              <Ban size={14} /> Void
            </Button>
          )}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Total", credit.totalCents],
          ["Applied", credit.appliedCents],
          ["Refunded", credit.refundedCents],
          ["Open", credit.openCents],
        ].map(([label, cents]) => (
          <div
            key={label as string}
            className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {label}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {formatMoney(cents as number, credit.currency)}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Lines
        </h3>
        <ul className="mt-3 space-y-1 text-sm">
          {credit.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-2">
              <span className="text-slate-700 dark:text-slate-200">{l.description}</span>
              <span className="tabular-nums text-slate-900 dark:text-slate-100">
                {formatMoney(l.lineTotalCents, credit.currency)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Applications
        </h3>
        {credit.applications.length === 0 ? (
          <div className="mt-3 text-sm text-slate-400">Not applied to any invoice yet.</div>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {credit.applications.map((a) => (
              <li
                key={a.id}
                className={
                  "flex items-center justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" +
                  (a.reversedAt ? " opacity-60" : "")
                }
              >
                <div>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {formatMoney(a.amountCents, credit.currency)}
                  </span>{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    → {a.invoiceNumber ?? "invoice"} ·{" "}
                    {new Date(a.appliedAt).toISOString().slice(0, 10)}
                    {a.reversedAt ? " · reversed" : ""}
                  </span>
                </div>
                {!a.reversedAt && (
                  <button
                    onClick={() => unapply(a.id)}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    aria-label="Unapply"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {credit.refunds.length > 0 && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Refunds
          </h3>
          <ul className="mt-3 space-y-2 text-sm">
            {credit.refunds.map((r) => (
              <li
                key={r.id}
                className={
                  "flex items-center justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" +
                  (r.reversedAt ? " opacity-60" : "")
                }
              >
                <div>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {formatMoney(r.amountCents, credit.currency)}
                  </span>{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {new Date(r.refundedAt).toISOString().slice(0, 10)}
                    {r.method ? ` · ${r.method}` : ""}
                    {r.reversedAt ? " · reversed" : ""}
                  </span>
                </div>
                {!r.reversedAt && (
                  <button
                    onClick={() => voidRefund(r.id)}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    aria-label="Reverse refund"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showApply && (
        <ApplyCreditModal
          companyId={company.id}
          creditSlug={credit.slug}
          currency={credit.currency}
          maxCents={credit.openCents}
          onClose={() => setShowApply(false)}
          onSaved={(fresh) => {
            setShowApply(false);
            setCredit(fresh);
          }}
        />
      )}

      {showRefund && (
        <RefundModal
          companyId={company.id}
          creditSlug={credit.slug}
          currency={credit.currency}
          maxCents={credit.openCents}
          onClose={() => setShowRefund(false)}
          onSaved={(fresh) => {
            setShowRefund(false);
            setCredit(fresh);
          }}
        />
      )}
    </div>
  );
}

function RefundModal({
  companyId,
  creditSlug,
  currency,
  maxCents,
  onClose,
  onSaved,
}: {
  companyId: string;
  creditSlug: string;
  currency: string;
  maxCents: number;
  onClose: () => void;
  onSaved: (fresh: CreditNoteDetail) => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = React.useState((maxCents / 100).toFixed(2));
  const [method, setMethod] = React.useState("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const amountCents = parseMoneyToCents(amount);
    if (amountCents <= 0) {
      toast("Enter a positive amount", "error");
      return;
    }
    setBusy(true);
    try {
      const fresh = await api.post<CreditNoteDetail>(
        `/api/companies/${companyId}/credit-notes/${creditSlug}/refund`,
        { amountCents, method: method.trim() || undefined, reference: reference.trim() || undefined },
      );
      onSaved(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Refund credit">
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Pay cash back to the customer against this credit&apos;s open balance. Posts
          DR Customer Credits / CR Bank.
        </p>
        <Input
          label={`Amount (${currency})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
        <Input label="Method" value={method} onChange={(e) => setMethod(e.target.value)} />
        <Input
          label="Reference (optional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Refunding…" : "Refund"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ApplyCreditModal({
  companyId,
  creditSlug,
  currency,
  maxCents,
  onClose,
  onSaved,
}: {
  companyId: string;
  creditSlug: string;
  currency: string;
  maxCents: number;
  onClose: () => void;
  onSaved: (fresh: CreditNoteDetail) => void;
}) {
  const { toast } = useToast();
  const [invoiceSlug, setInvoiceSlug] = React.useState("");
  const [amount, setAmount] = React.useState((maxCents / 100).toFixed(2));
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const amountCents = parseMoneyToCents(amount);
    if (!invoiceSlug.trim()) {
      toast("Enter the invoice number to apply to", "error");
      return;
    }
    if (amountCents <= 0) {
      toast("Enter a positive amount", "error");
      return;
    }
    setBusy(true);
    try {
      const fresh = await api.post<CreditNoteDetail>(
        `/api/companies/${companyId}/credit-notes/${creditSlug}/apply`,
        { invoiceSlug: invoiceSlug.trim().toLowerCase(), amountCents },
      );
      onSaved(fresh);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Apply credit to an invoice">
      <div className="space-y-3">
        <Input
          label="Invoice number"
          placeholder="ACME-CORP-INV-0001"
          value={invoiceSlug}
          onChange={(e) => setInvoiceSlug(e.target.value)}
        />
        <Input
          label={`Amount (${currency})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
        <p className="text-xs text-slate-400">
          Capped at the credit&apos;s open balance and the invoice&apos;s outstanding
          balance, whichever is smaller.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
