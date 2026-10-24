import React from "react";
import { AlertTriangle, Mail, MapPin, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { api, type Customer } from "@/lib/api";
import { customerBillTo, missingDetailsError, missingDetailsPatch } from "@/lib/customerBillTo";

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
 * A missing one is added right here, and saved to the customer rather than
 * the document, since the customer is where every document billed to them
 * reads it from.
 */
export function CustomerBillTo({
  companyId,
  customer,
  kind,
  onCustomerSaved,
}: {
  companyId: string;
  customer: Customer | null;
  kind: BillToKind;
  /** Takes the customer as saved, once a detail added here is on its record. */
  onCustomerSaved: (customer: Customer) => void;
}) {
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
        <AddMissingDetails
          // Another customer starts closed, with nothing typed for this one.
          key={customer.id}
          companyId={companyId}
          customer={customer}
          needsEmail={!email}
          needsAddress={!address}
          onSaved={onCustomerSaved}
        />
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
 * Fields for whichever detail the customer is missing, opened from a link
 * under the warnings. They sit inside the document's own form, so both
 * buttons are plain buttons and Enter in the email saves the customer
 * instead of submitting the document.
 */
function AddMissingDetails({
  companyId,
  customer,
  needsEmail,
  needsAddress,
  onSaved,
}: {
  companyId: string;
  customer: Customer;
  needsEmail: boolean;
  needsAddress: boolean;
  onSaved: (customer: Customer) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);
  const patch = missingDetailsPatch(customer, { email, address });

  const close = () => {
    setOpen(false);
    setEmail("");
    setAddress("");
    setError(null);
  };

  const save = async () => {
    if (!patch || saving) return;
    // The document's form is never submitted, so ask the email field's own check.
    if (emailRef.current && !emailRef.current.reportValidity()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.patch<Customer>(
        `/api/companies/${companyId}/customers/${customer.slug}`,
        patch,
      );
      onSaved(saved);
      close();
    } catch (err) {
      setError(missingDetailsError(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <p className="pl-[18px]">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="touch-target relative inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <Plus size={11} aria-hidden />
          {needsEmail && needsAddress
            ? "Add email and billing address"
            : needsEmail
              ? "Add email"
              : "Add billing address"}
        </button>
      </p>
    );
  }

  return (
    <div className="!mt-2 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      {needsEmail && (
        <Input
          ref={emailRef}
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
          maxLength={200}
          placeholder="ap@example.com"
          autoFocus
        />
      )}
      {needsAddress && (
        <Textarea
          label="Billing address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Street address, city, postcode, country"
          className="!min-h-20"
          autoFocus={!needsEmail}
        />
      )}
      <p className="text-slate-500 dark:text-slate-400">
        Saved to {customer.name}, so every document billed to them uses it.
      </p>
      <FormError message={error} />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          loading={saving}
          disabled={!patch}
          onClick={() => void save()}
        >
          Save to customer
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
