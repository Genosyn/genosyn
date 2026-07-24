import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Copy,
  Download,
  Mail,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  api,
  displayInvoiceStatus,
  formatMoney,
  Invoice,
  InvoicePaymentMethod,
  InvoiceWriteOff,
  InvoiceWriteOffKind,
  CustomerCreditApplicationRow,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
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
  credited: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  written_off: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

const STATUS_LABEL: Record<string, string> = {
  written_off: "Written off",
  credited: "Credited",
};

type InvoiceEmailDetails = {
  toAddress: string;
  alwaysCcAddress: string;
  fromAddress: string;
  replyTo: string;
  configured: boolean;
  source: "company_provider" | "global_smtp" | "console";
};

type InvoiceResendActivity = {
  id: string;
  createdAt: string;
  status: "sent" | "skipped" | "failed";
  toAddress: string;
  ccAddress: string;
  fromAddress: string;
  replyTo: string;
  pdfRequested: boolean;
  pdfAttached: boolean;
  hasMessage: boolean;
  errorMessage: string;
};

type InvoiceDetailPayload = Invoice & {
  emailDetails: InvoiceEmailDetails;
  resendActivities: InvoiceResendActivity[];
  writeOffs: InvoiceWriteOff[];
  creditApplications: CustomerCreditApplicationRow[];
};

type InvoiceSendResponse = {
  invoice: Invoice;
  send: {
    status: "sent" | "skipped" | "failed";
    errorMessage: string;
    pdfRequested: boolean;
    pdfAttached: boolean;
  };
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
  const [emailDetails, setEmailDetails] =
    React.useState<InvoiceEmailDetails | null>(null);
  const [resendActivities, setResendActivities] = React.useState<
    InvoiceResendActivity[]
  >([]);
  const [writeOffs, setWriteOffs] = React.useState<InvoiceWriteOff[]>([]);
  const [creditApplications, setCreditApplications] = React.useState<
    CustomerCreditApplicationRow[]
  >([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showPay, setShowPay] = React.useState(false);
  const [showWriteOff, setShowWriteOff] = React.useState(false);
  const [showCreditNote, setShowCreditNote] = React.useState(false);
  const [showResend, setShowResend] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!invoiceSlug) return;
    try {
      const inv = await api.get<InvoiceDetailPayload>(
        `/api/companies/${company.id}/invoices/${invoiceSlug}`,
      );
      setInvoice(inv);
      setEmailDetails(inv.emailDetails);
      setResendActivities(inv.resendActivities);
      setWriteOffs(inv.writeOffs ?? []);
      setCreditApplications(inv.creditApplications ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [company.id, invoiceSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("invoice", reload);

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
      const result = await api.post<InvoiceSendResponse>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/send`,
      );
      setInvoice(result.invoice);
      // Slug may have just changed if this was a draft.
      if (result.invoice.slug !== invoice.slug) {
        navigate(`/c/${company.slug}/finance/invoices/${result.invoice.slug}`, {
          replace: true,
        });
      }
      if (result.send.status === "sent") {
        if (result.send.pdfRequested && !result.send.pdfAttached) {
          toast("Invoice emailed, but the PDF attachment could not be generated", "info");
        } else {
          toast("Invoice emailed to customer", "success");
        }
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

  async function duplicate() {
    if (!invoice) return;
    setBusy(true);
    try {
      const draft = await api.post<Invoice>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/duplicate`,
      );
      toast("Invoice duplicated as draft", "success");
      navigate(`/c/${company.slug}/finance/invoices/${draft.slug}/edit`);
    } catch (err) {
      toast((err as Error).message, "error");
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

  async function reverseWriteOff(writeOffId: string) {
    if (!invoice) return;
    const ok = await dialog.confirm({
      title: "Reverse this write-off?",
      message:
        "The amount goes back onto the invoice's open balance and a reversing journal entry is posted (also the bad-debt-recovery path).",
      confirmLabel: "Reverse",
    });
    if (!ok) return;
    try {
      const fresh = await api.del<Invoice & { writeOffs: InvoiceWriteOff[] }>(
        `/api/companies/${company.id}/invoices/${invoice.slug}/write-offs/${writeOffId}`,
      );
      setInvoice(fresh);
      setWriteOffs(fresh.writeOffs ?? []);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function unapplyCredit(app: CustomerCreditApplicationRow) {
    if (!app.creditSlug) return;
    const ok = await dialog.confirm({
      title: "Unapply this credit?",
      message:
        "The credited amount goes back onto the invoice's balance and the credit note becomes available to apply elsewhere.",
      confirmLabel: "Unapply",
    });
    if (!ok) return;
    try {
      await api.del(
        `/api/companies/${company.id}/credit-notes/${app.creditSlug}/applications/${app.id}`,
      );
      await reload();
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
              (STATUS_BADGE[ds] ?? STATUS_BADGE.draft)
            }
          >
            {STATUS_LABEL[ds] ?? ds}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {invoice.status === "draft" && (
            <>
              <Link
                to={`/c/${company.slug}/finance/invoices/${invoice.slug}/edit`}
              >
                <Button variant="secondary" disabled={busy}>
                  <Pencil size={14} /> Edit
                </Button>
              </Link>
              <Button onClick={send} disabled={busy}>
                <Send size={14} /> Issue & send
              </Button>
            </>
          )}
          {invoice.status === "sent" && (
            <Button onClick={() => setShowPay(true)} disabled={busy}>
              <Plus size={14} /> Record payment
            </Button>
          )}
          {invoice.status === "sent" && invoice.balanceCents > 0 && (
            <Button
              variant="secondary"
              onClick={() => setShowWriteOff(true)}
              disabled={busy}
            >
              <Ban size={14} /> Write off
            </Button>
          )}
          {(invoice.status === "sent" || invoice.status === "paid") &&
            invoice.balanceCents > 0 && (
              <Button
                variant="secondary"
                onClick={() => setShowCreditNote(true)}
                disabled={busy}
              >
                <Undo2 size={14} /> Credit note
              </Button>
            )}
          {invoice.status === "paid" && (
            <Button
              variant="secondary"
              onClick={() => setShowResend(true)}
              disabled={busy}
            >
              <Mail size={14} /> Resend email
            </Button>
          )}

          <Menu
            align="right"
            width={208}
            trigger={({ ref, onClick }) => (
              <Button
                ref={ref}
                variant="secondary"
                onClick={onClick}
                disabled={busy}
                aria-label="More actions"
              >
                <MoreHorizontal size={14} />
              </Button>
            )}
          >
            {(close) => (
              <>
                {invoice.status === "draft" && (
                  <MenuItem
                    icon={<CheckCircle2 size={14} />}
                    label="Issue without sending"
                    onSelect={() => {
                      close();
                      issue();
                    }}
                  />
                )}
                {invoice.status === "sent" && (
                  <MenuItem
                    icon={<Mail size={14} />}
                    label="Resend email"
                    onSelect={() => {
                      close();
                      setShowResend(true);
                    }}
                  />
                )}
                {invoice.status === "paid" && (
                  <MenuItem
                    icon={<Plus size={14} />}
                    label="Record payment"
                    onSelect={() => {
                      close();
                      setShowPay(true);
                    }}
                  />
                )}
                <MenuItem
                  icon={<Download size={14} />}
                  label="Download PDF"
                  onSelect={() => {
                    close();
                    window.location.href = `/api/companies/${company.id}/invoices/${invoice.slug}/pdf`;
                  }}
                />
                <MenuItem
                  icon={<Copy size={14} />}
                  label="Duplicate"
                  onSelect={() => {
                    close();
                    duplicate();
                  }}
                />
                {invoice.status !== "void" && invoice.status !== "draft" && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Ban size={14} className="text-red-500" />}
                      label={
                        <span className="text-red-600 dark:text-red-400">
                          Void
                        </span>
                      }
                      onSelect={() => {
                        close();
                        voidInvoice();
                      }}
                    />
                  </>
                )}
                {invoice.status === "draft" && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 size={14} className="text-red-500" />}
                      label={
                        <span className="text-red-600 dark:text-red-400">
                          Delete
                        </span>
                      }
                      onSelect={() => {
                        close();
                        deleteDraft();
                      }}
                    />
                  </>
                )}
              </>
            )}
          </Menu>
        </div>
      </div>

      <div className="space-y-6">
        <div>
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

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Payments
          </h3>
          {invoice.payments.length === 0 ? (
            <div className="mt-3 text-sm text-slate-400">No payments yet.</div>
          ) : (
            <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
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
        {(writeOffs.length > 0 || creditApplications.length > 0) && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Adjustments
            </h3>
            <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {writeOffs.map((w) => (
                <li
                  key={w.id}
                  className={
                    "flex items-start justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" +
                    (w.reversedAt ? " opacity-60" : "")
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                      {formatMoney(w.amountCents, w.currency)}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {new Date(w.writeOffDate).toISOString().slice(0, 10)} ·{" "}
                      {w.kind === "bad_debt" ? "Bad debt" : "Residual"}
                      {w.reversedAt ? " · reversed" : ""}
                    </div>
                    {w.note ? (
                      <div className="mt-0.5 truncate text-xs text-slate-400">
                        {w.note}
                      </div>
                    ) : null}
                  </div>
                  {!w.reversedAt && (
                    <button
                      onClick={() => reverseWriteOff(w.id)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      aria-label="Reverse write-off"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {creditApplications.length > 0 && (
              <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {creditApplications.map((a) => (
                  <li
                    key={a.id}
                    className={
                      "flex items-start justify-between gap-2 rounded-md border border-slate-100 p-2 dark:border-slate-800" +
                      (a.reversedAt ? " opacity-60" : "")
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(a.amountCents, invoice.currency)}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {new Date(a.appliedAt).toISOString().slice(0, 10)} · Credit{" "}
                        {a.creditNumber ?? "note"}
                        {a.reversedAt ? " · reversed" : ""}
                      </div>
                    </div>
                    {!a.reversedAt && (
                      <button
                        onClick={() => unapplyCredit(a)}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                        aria-label="Unapply credit"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Activity
          </h3>
          <ul className="mt-3 grid gap-1.5 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2 lg:grid-cols-3">
            <li>
              Created {new Date(invoice.createdAt).toISOString().slice(0, 10)}
            </li>
            {invoice.sentAt && (
              <li>
                Issued {new Date(invoice.sentAt).toISOString().slice(0, 10)}
              </li>
            )}
            {invoice.paidAt && (
              <li>
                Paid {new Date(invoice.paidAt).toISOString().slice(0, 10)}
              </li>
            )}
            {invoice.voidedAt && (
              <li>
                Voided {new Date(invoice.voidedAt).toISOString().slice(0, 10)}
              </li>
            )}
            {resendActivities.map((activity) => (
              <li key={activity.id} className="sm:col-span-2 lg:col-span-3">
                <span
                  className={
                    activity.status === "sent"
                      ? "font-medium text-slate-700 dark:text-slate-200"
                      : activity.status === "failed"
                        ? "font-medium text-red-600 dark:text-red-400"
                        : "font-medium text-amber-700 dark:text-amber-400"
                  }
                >
                  {activity.status === "sent"
                    ? "Email resent"
                    : activity.status === "failed"
                      ? "Email resend failed"
                      : "Email resend skipped"}
                </span>{" "}
                to {activity.toAddress || "the customer"} ·{" "}
                {new Date(activity.createdAt).toLocaleString()}
                {activity.pdfAttached && " · PDF attached"}
                {activity.pdfRequested && !activity.pdfAttached &&
                  " · PDF unavailable"}
                {activity.hasMessage && " · Custom message included"}
                {activity.ccAddress && (
                  <span className="block text-slate-400 dark:text-slate-500">
                    Cc {activity.ccAddress}
                  </span>
                )}
                {activity.fromAddress && (
                  <span className="block text-slate-400 dark:text-slate-500">
                    From {activity.fromAddress}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {showResend && emailDetails && (
        <ResendInvoiceModal
          companyId={company.id}
          invoice={invoice}
          details={emailDetails}
          onClose={() => setShowResend(false)}
          onFinished={() => {
            setShowResend(false);
            void reload();
          }}
        />
      )}

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

      {showWriteOff && (
        <WriteOffModal
          companyId={company.id}
          invoice={invoice}
          onClose={() => setShowWriteOff(false)}
          onSaved={(fresh, wos) => {
            setShowWriteOff(false);
            setInvoice(fresh);
            setWriteOffs(wos);
          }}
        />
      )}

      {showCreditNote && (
        <CreditNoteModal
          companyId={company.id}
          invoice={invoice}
          onClose={() => setShowCreditNote(false)}
          onSaved={() => {
            setShowCreditNote(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function CreditNoteModal({
  companyId,
  invoice,
  onClose,
  onSaved,
}: {
  companyId: string;
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = React.useState<"full" | "amount">("full");
  const [amount, setAmount] = React.useState((invoice.balanceCents / 100).toFixed(2));
  const [applyNow, setApplyNow] = React.useState(true);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const body: Record<string, unknown> = { mode, applyNow, reason: reason.trim() || undefined };
    if (mode === "amount") {
      const amountCents = parseMoneyToCents(amount);
      if (amountCents <= 0) {
        toast("Enter a positive amount", "error");
        return;
      }
      body.amountCents = amountCents;
    }
    setBusy(true);
    try {
      await api.post(
        `/api/companies/${companyId}/invoices/${invoice.slug}/credit-note`,
        body,
      );
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Credit note">
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A credit note reduces this sale — it reverses revenue (and tax on a full
          credit) into Sales Returns, and can be applied to the invoice to lower
          what the customer owes.
        </p>
        <Select label="Amount" value={mode} onChange={(e) => setMode(e.target.value as "full" | "amount")}>
          <option value="full">Full — credit the whole invoice</option>
          <option value="amount">Partial — a specific amount</option>
        </Select>
        {mode === "amount" && (
          <Input
            label={`Amount (${invoice.currency}, ex-tax)`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        )}
        <Textarea
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={applyNow}
            onChange={(e) => setApplyNow(e.target.checked)}
          />
          Apply to this invoice now (reduce its balance)
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create credit note"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function WriteOffModal({
  companyId,
  invoice,
  onClose,
  onSaved,
}: {
  companyId: string;
  invoice: Invoice;
  onClose: () => void;
  onSaved: (fresh: Invoice, writeOffs: InvoiceWriteOff[]) => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = React.useState(
    (invoice.balanceCents / 100).toFixed(2),
  );
  const [kind, setKind] = React.useState<InvoiceWriteOffKind>("bad_debt");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const amountCents = parseMoneyToCents(amount);
    if (amountCents <= 0) {
      toast("Enter a positive amount", "error");
      return;
    }
    if (amountCents > invoice.balanceCents) {
      toast("Amount exceeds the invoice's open balance", "error");
      return;
    }
    setBusy(true);
    try {
      const fresh = await api.post<Invoice & { writeOffs: InvoiceWriteOff[] }>(
        `/api/companies/${companyId}/invoices/${invoice.slug}/write-off`,
        { amountCents, kind, note: note.trim() || undefined },
      );
      onSaved(fresh, fresh.writeOffs ?? []);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Write off">
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A write-off clears part of this invoice&apos;s balance without a
          payment and without reversing the sale. Bad debt posts to Bad Debt
          Expense; the revenue stays recognized in its original period.
        </p>
        <Input
          label={`Amount (${invoice.currency})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
        <Select
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as InvoiceWriteOffKind)}
        >
          <option value="bad_debt">Bad debt (uncollectible)</option>
          <option value="residual">Residual / small balance</option>
        </Select>
        <Textarea
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Writing off…" : "Write off"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ResendInvoiceModal({
  companyId,
  invoice,
  details,
  onClose,
  onFinished,
}: {
  companyId: string;
  invoice: Invoice;
  details: InvoiceEmailDetails;
  onClose: () => void;
  onFinished: () => void;
}) {
  const { toast } = useToast();
  const [to, setTo] = React.useState(details.toAddress);
  const [cc, setCc] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [attachPdf, setAttachPdf] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  async function resend(e: React.FormEvent) {
    e.preventDefault();
    const toRecipients = parseRecipientInput(to);
    const ccRecipients = parseRecipientInput(cc);
    if (toRecipients.length === 0) {
      toast("Add at least one To recipient", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<InvoiceSendResponse>(
        `/api/companies/${companyId}/invoices/${invoice.slug}/send`,
        { to: toRecipients, cc: ccRecipients, message: message.trim(), attachPdf },
      );
      if (result.send.status === "sent") {
        if (result.send.pdfRequested && !result.send.pdfAttached) {
          toast("Email resent, but the PDF attachment could not be generated", "info");
        } else {
          toast("Invoice email resent", "success");
        }
      } else if (result.send.status === "skipped") {
        toast("No email transport configured — set one in Settings → Email", "info");
      } else {
        toast(`Email failed: ${result.send.errorMessage || "unknown"}`, "error");
      }
      onFinished();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Resend ${invoice.number || "invoice"}`}>
      <form onSubmit={resend} className="space-y-5">
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-sm dark:border-slate-700 dark:bg-slate-800/50">
          <dl className="divide-y divide-slate-200 dark:divide-slate-700">
            <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
              <dt className="text-slate-500 dark:text-slate-400">From</dt>
              <dd className="break-all font-medium text-slate-900 dark:text-slate-100">
                {details.fromAddress || "No sender configured"}
              </dd>
            </div>
            {details.alwaysCcAddress && (
              <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
                <dt className="text-slate-500 dark:text-slate-400">Always Cc</dt>
                <dd className="break-all text-slate-700 dark:text-slate-200">
                  {details.alwaysCcAddress}
                </dd>
              </div>
            )}
            <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
              <dt className="text-slate-500 dark:text-slate-400">To</dt>
              <dd>
                <Input
                  type="email"
                  multiple
                  required
                  aria-label="To recipients"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="name@example.com, other@example.com"
                  className="h-9"
                />
              </dd>
            </div>
            <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
              <dt className="pt-2 text-slate-500 dark:text-slate-400">Cc</dt>
              <dd>
                <Input
                  type="email"
                  multiple
                  aria-label="Cc recipients"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="Optional"
                  className="h-9"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Additional recipients only. Finance → Settings recipients are
                  always included. Separate multiple addresses with commas.
                </p>
              </dd>
            </div>
            {details.replyTo && (
              <div className="grid grid-cols-[5rem_1fr] gap-3 px-4 py-3">
                <dt className="text-slate-500 dark:text-slate-400">Reply to</dt>
                <dd className="break-all text-slate-700 dark:text-slate-200">
                  {details.replyTo}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {!details.configured && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            No email transport is configured. This attempt will be logged, but
            no email will be delivered.
          </div>
        )}

        <Textarea
          label="Message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a short note for the customer…"
          maxLength={4000}
          rows={5}
        />

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-3 dark:border-slate-700">
          <input
            type="checkbox"
            checked={attachPdf}
            onChange={(e) => setAttachPdf(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800"
          />
          <span className="flex min-w-0 gap-2">
            <Paperclip
              size={16}
              className="mt-0.5 shrink-0 text-slate-400"
            />
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                Attach invoice as PDF
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {invoice.number || "invoice"}.pdf
              </span>
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !to.trim()}>
            <Mail size={14} /> {busy ? "Sending…" : "Resend email"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function parseRecipientInput(value: string): string[] {
  const seen = new Set<string>();
  return value.split(",").flatMap((address) => {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
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
  const [allowOverpayment, setAllowOverpayment] = React.useState(false);
  const cents = parseMoneyToCents(amount);
  const overpay = cents > invoice.balanceCents;

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
          allowOverpayment,
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
        <div>
          <Input
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
          />
          <p className={`mt-1 text-xs ${overpay ? "text-amber-600 dark:text-amber-400" : "text-slate-500"}`}>
            {overpay
              ? `Exceeds the ${formatMoney(invoice.balanceCents, invoice.currency)} balance due`
              : `Balance due: ${formatMoney(invoice.balanceCents, invoice.currency)}`}
          </p>
          {overpay && (
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={allowOverpayment}
                onChange={(e) => setAllowOverpayment(e.target.checked)}
              />
              Record the excess as an on-account customer credit
            </label>
          )}
        </div>
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
          <Button type="submit" disabled={busy || cents <= 0 || overpay}>
            Record payment
          </Button>
        </div>
      </form>
    </Modal>
  );
}
