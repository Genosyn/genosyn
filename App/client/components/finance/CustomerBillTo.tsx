import React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ExternalLink, Mail, MapPin } from "lucide-react";
import { api, type Customer } from "@/lib/api";
import { customerBillTo } from "@/lib/customerBillTo";

export type BillToKind = "invoice" | "estimate" | "recurringInvoice";

const MISSING: Record<BillToKind, { email: string; address: string }> = {
  invoice: {
    email: "No email on file — add one to send this invoice.",
    address: "No billing address on file — the invoice prints without one.",
  },
  estimate: {
    email: "No email on file — add one to send this estimate.",
    address: "No billing address on file — the estimate prints without one.",
  },
  recurringInvoice: {
    email: "No email on file — add one so this schedule's invoices can be emailed.",
    address: "No billing address on file — this schedule's invoices print without one.",
  },
};

/**
 * Under a document form's Customer field: the email the document is sent to
 * and the billing address its "Bill to" prints, or a small warning for
 * whichever the customer is missing. Both are read from the customer whenever
 * the document is rendered or sent, so adding one later still reaches this
 * document; the warning is a reminder, never a reason the form can't save.
 *
 * Edit customer opens in a new tab so a half-filled form survives, and the
 * customer is re-read when the person comes back to this one.
 */
export function CustomerBillTo({
  companyId,
  companySlug,
  customer,
  kind,
  onCustomerReread,
}: {
  companyId: string;
  companySlug: string;
  customer: Customer | null;
  kind: BillToKind;
  /** Takes the customer as it is now, re-read on coming back to this tab. */
  onCustomerReread: (customer: Customer) => void;
}) {
  useRereadOnReturn(companyId, customer?.slug ?? null, onCustomerReread);
  if (!customer) return null;
  const { email, address } = customerBillTo(customer);
  const missing = MISSING[kind];
  return (
    <div className="mt-2 space-y-1 text-xs">
      {email ? (
        <p className="flex gap-1.5 text-slate-500 dark:text-slate-400">
          <Mail size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span className="sr-only">Email: </span>
          <span className="min-w-0 break-all">{email}</span>
        </p>
      ) : (
        <MissingLine>{missing.email}</MissingLine>
      )}
      {address ? (
        <p className="flex gap-1.5 text-slate-500 dark:text-slate-400">
          <MapPin size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span className="sr-only">Billing address: </span>
          <span className="min-w-0 whitespace-pre-line break-words">{address}</span>
        </p>
      ) : (
        <MissingLine>{missing.address}</MissingLine>
      )}
      {(!email || !address) && (
        <p className="pl-[18px]">
          <Link
            to={`/c/${companySlug}/customers/${customer.slug}/edit`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Edit customer <ExternalLink size={11} aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
        </p>
      )}
    </div>
  );
}

function MissingLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-1.5 text-amber-700 dark:text-amber-300">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * Calls `onReread` with the customer as it is now each time the person comes
 * back to this tab, as they do from the one Edit customer opened. A tab that
 * opened as its own window never hid this one, so focus counts as coming back
 * too; the two arrive together on a tab switch, and only the first re-reads.
 */
function useRereadOnReturn(
  companyId: string,
  customerSlug: string | null,
  onReread: (customer: Customer) => void,
) {
  const onRereadRef = React.useRef(onReread);
  onRereadRef.current = onReread;
  React.useEffect(() => {
    if (!customerSlug) return;
    let current = true;
    let reading = false;
    const reread = () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      api
        .get<Customer>(`/api/companies/${companyId}/customers/${customerSlug}`)
        .then(
          (fresh) => {
            if (current) onRereadRef.current(fresh);
          },
          // Nothing to report: what is shown stays, and the form saves by id.
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    };
    document.addEventListener("visibilitychange", reread);
    window.addEventListener("focus", reread);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", reread);
      window.removeEventListener("focus", reread);
    };
  }, [companyId, customerSlug]);
}
