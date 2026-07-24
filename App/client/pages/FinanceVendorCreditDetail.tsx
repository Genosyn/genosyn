import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Ban, Plus, Trash2, Undo2 } from "lucide-react";
import { api, VendorCreditDetail, formatMoney, parseMoneyToCents } from "../lib/api";
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

export default function FinanceVendorCreditDetail() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { creditSlug } = useParams();
  const { toast } = useToast();
  const dialog = useDialog();
  const [credit, setCredit] = React.useState<VendorCreditDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showApply, setShowApply] = React.useState(false);
  const [showRefund, setShowRefund] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!creditSlug) return;
    try {
      setCredit(
        await api.get<VendorCreditDetail>(`/api/companies/${company.id}/vendor-credits/${creditSlug}`),
      );
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, creditSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);
  useLiveRefetch("bill", reload);

  async function unapply(appId: string) {
    if (!credit) return;
    if (!(await dialog.confirm({ title: "Unapply this credit?", message: "The amount goes back onto the bill.", confirmLabel: "Unapply" }))) return;
    try {
      setCredit(await api.del<VendorCreditDetail>(`/api/companies/${company.id}/vendor-credits/${credit.slug}/applications/${appId}`));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function voidRefund(refundId: string) {
    if (!credit) return;
    if (!(await dialog.confirm({ title: "Reverse this refund?", message: "Reverses the cash-in entry and reopens the credit.", confirmLabel: "Reverse" }))) return;
    try {
      setCredit(await api.del<VendorCreditDetail>(`/api/companies/${company.id}/vendor-refunds/${refundId}`));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function voidCredit() {
    if (!credit) return;
    if (!(await dialog.confirm({ title: `Void ${credit.number}?`, message: "Reverses the credit's postings. Only possible while nothing is applied or refunded.", variant: "danger", confirmLabel: "Void" }))) return;
    try {
      setCredit(await api.post<VendorCreditDetail>(`/api/companies/${company.id}/vendor-credits/${credit.slug}/void`, {}));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loadError) {
    return <div className="mx-auto max-w-3xl p-8 text-sm text-slate-500">{loadError === "Vendor credit not found" ? "This vendor credit doesn't exist." : loadError}</div>;
  }
  if (!credit) {
    return <div className="flex justify-center p-12"><Spinner /></div>;
  }

  const canApply = credit.status === "issued" && credit.openCents > 0;
  const canVoid = credit.status === "issued" && credit.openCents === credit.totalCents;

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Vendor credits", to: `/c/${company.slug}/finance/vendor-credits` },
            { label: credit.number || "Draft" },
          ]}
        />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to={`/c/${company.slug}/finance/vendor-credits`} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{credit.number || "Draft"}</h1>
          <span className={"inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " + (STATUS_BADGE[credit.status] ?? STATUS_BADGE.draft)}>
            {credit.status}
          </span>
        </div>
        <div className="flex gap-2">
          {canApply && <Button onClick={() => setShowApply(true)}><Plus size={14} /> Apply to bill</Button>}
          {canApply && <Button variant="secondary" onClick={() => setShowRefund(true)}><Undo2 size={14} /> Record refund</Button>}
          {canVoid && <Button variant="secondary" onClick={voidCredit}><Ban size={14} /> Void</Button>}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["Total", credit.totalCents], ["Applied", credit.appliedCents], ["Refunded", credit.refundedCents], ["Open", credit.openCents]] as [string, number][]).map(([label, cents]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(cents, credit.currency)}</div>
          </div>
        ))}
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Lines</h3>
        <ul className="mt-3 space-y-1 text-sm">
          {credit.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-2">
              <span className="text-slate-700 dark:text-slate-200">{l.description}</span>
              <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(l.lineTotalCents, credit.currency)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Applications</h3>
        {credit.applications.length === 0 ? (
          <div className="mt-3 text-sm text-slate-400">Not applied to any bill yet.</div>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {credit.applications.map((a) => (
              <li key={a.id} className={"flex items-center justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" + (a.reversedAt ? " opacity-60" : "")}>
                <div>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(a.amountCents, credit.currency)}</span>{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">→ {a.billNumber ?? "bill"} · {new Date(a.appliedAt).toISOString().slice(0, 10)}{a.reversedAt ? " · reversed" : ""}</span>
                </div>
                {!a.reversedAt && (
                  <button onClick={() => unapply(a.id)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400" aria-label="Unapply">
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
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Refunds</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {credit.refunds.map((r) => (
              <li key={r.id} className={"flex items-center justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" + (r.reversedAt ? " opacity-60" : "")}>
                <div>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(r.amountCents, credit.currency)}</span>{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">{new Date(r.refundedAt).toISOString().slice(0, 10)}{r.method ? ` · ${r.method}` : ""}{r.reversedAt ? " · reversed" : ""}</span>
                </div>
                {!r.reversedAt && (
                  <button onClick={() => voidRefund(r.id)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400" aria-label="Reverse refund">
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showApply && (
        <VendorApplyModal companyId={company.id} creditSlug={credit.slug} currency={credit.currency} maxCents={credit.openCents} onClose={() => setShowApply(false)} onSaved={(fresh) => { setShowApply(false); setCredit(fresh); }} />
      )}
      {showRefund && (
        <VendorRefundModal companyId={company.id} creditSlug={credit.slug} currency={credit.currency} maxCents={credit.openCents} onClose={() => setShowRefund(false)} onSaved={(fresh) => { setShowRefund(false); setCredit(fresh); }} />
      )}
    </div>
  );
}

function VendorApplyModal({ companyId, creditSlug, currency, maxCents, onClose, onSaved }: { companyId: string; creditSlug: string; currency: string; maxCents: number; onClose: () => void; onSaved: (fresh: VendorCreditDetail) => void; }) {
  const { toast } = useToast();
  const [billSlug, setBillSlug] = React.useState("");
  const [amount, setAmount] = React.useState((maxCents / 100).toFixed(2));
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    const amountCents = parseMoneyToCents(amount);
    if (!billSlug.trim()) return toast("Enter the bill number", "error");
    if (amountCents <= 0) return toast("Enter a positive amount", "error");
    setBusy(true);
    try {
      onSaved(await api.post<VendorCreditDetail>(`/api/companies/${companyId}/vendor-credits/${creditSlug}/apply`, { billSlug: billSlug.trim().toLowerCase(), amountCents }));
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Apply credit to a bill">
      <div className="space-y-3">
        <Input label="Bill number" placeholder="ACME-BIL-0001" value={billSlug} onChange={(e) => setBillSlug(e.target.value)} />
        <Input label={`Amount (${currency})`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Applying…" : "Apply"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function VendorRefundModal({ companyId, creditSlug, currency, maxCents, onClose, onSaved }: { companyId: string; creditSlug: string; currency: string; maxCents: number; onClose: () => void; onSaved: (fresh: VendorCreditDetail) => void; }) {
  const { toast } = useToast();
  const [amount, setAmount] = React.useState((maxCents / 100).toFixed(2));
  const [method, setMethod] = React.useState("bank_transfer");
  const [busy, setBusy] = React.useState(false);
  async function submit() {
    const amountCents = parseMoneyToCents(amount);
    if (amountCents <= 0) return toast("Enter a positive amount", "error");
    setBusy(true);
    try {
      onSaved(await api.post<VendorCreditDetail>(`/api/companies/${companyId}/vendor-credits/${creditSlug}/refund`, { amountCents, method: method.trim() || undefined }));
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Record supplier refund">
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">Cash the supplier paid you back against this credit. Posts DR Bank / CR Vendor Credits.</p>
        <Input label={`Amount (${currency})`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <Input label="Method" value={method} onChange={(e) => setMethod(e.target.value)} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Recording…" : "Record refund"}</Button>
        </div>
      </div>
    </Modal>
  );
}
