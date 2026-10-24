import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, FileText, Repeat, type LucideIcon } from "lucide-react";
import { api, type Company, type Customer } from "@/lib/api";
import { INVOICE_KINDS, invoiceKindPath, type InvoiceKind } from "@/lib/invoiceKind";
import { Breadcrumbs } from "@/components/AppShell";
import { clsx } from "@/components/ui/clsx";

/**
 * One-time or recurring, on screen (`lib/invoiceKind.ts` holds the rules):
 * the question New invoice asks before anything is filled in, and the switch
 * both new-invoice forms keep at the top.
 */

/** How each answer reads, in the question and on the switch. */
const KIND_COPY: Record<
  InvoiceKind,
  { label: string; title: string; blurb: string; icon: LucideIcon }
> = {
  "one-time": {
    label: "One-time",
    title: "One-time invoice",
    blurb:
      "Bill once — for a project, an order, or a single month. You issue and send it when it’s ready.",
    icon: FileText,
  },
  recurring: {
    label: "Recurring",
    title: "Recurring invoice",
    blurb:
      "Bill on a schedule — a monthly retainer, an annual licence. Each run creates a fresh invoice.",
    icon: Repeat,
  },
};

/** What the question calls a customer: their name, else the domain or email that stands in for it. */
function customerName(customer: Pick<Customer, "name" | "domain" | "email">): string {
  return customer.name.trim() || customer.domain.trim() || customer.email.trim();
}

/**
 * The customer a link asked for, once the list arrives. Only a courtesy: the
 * form after either answer loads the customers itself and says what went
 * wrong, so a failure here just leaves the name out.
 */
function useRequestedCustomer(companyId: string, customerId: string | null): Customer | null {
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  React.useEffect(() => {
    setCustomer(null);
    if (!customerId) return;
    let cancelled = false;
    api
      .get<Customer[]>(`/api/companies/${companyId}/customers`)
      .then((list) => {
        if (!cancelled) setCustomer(list.find((c) => c.id === customerId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [companyId, customerId]);
  return customer;
}

/**
 * New invoice's first step: is this a one-time invoice or a recurring one?
 * Asked before anything is filled in, so a schedule is never set up as a
 * one-off by mistake. Each answer is a link that keeps the customer the page
 * was opened for. Neither is picked for the person: the question takes focus,
 * so a screen reader reads it and Tab lands on the first answer, and the
 * arrow keys move between the two.
 */
export function InvoiceKindChoice({
  company,
  customerId,
}: {
  company: Company;
  /** The customer the link asked for (`?customerId=`), kept through either answer. */
  customerId: string | null;
}) {
  const financeBase = `/c/${company.slug}/finance`;
  const id = React.useId();
  const questionRef = React.useRef<HTMLHeadingElement>(null);
  const answerRefs = React.useRef<Array<HTMLAnchorElement | null>>([]);
  const customer = useRequestedCustomer(company.id, customerId);

  React.useEffect(() => {
    questionRef.current?.focus();
  }, []);

  function moveBetweenAnswers(event: React.KeyboardEvent<HTMLAnchorElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    answerRefs.current[(index + step + INVOICE_KINDS.length) % INVOICE_KINDS.length]?.focus();
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: financeBase },
            { label: "Invoices", to: `${financeBase}/invoices` },
            { label: "New" },
          ]}
        />
      </div>

      <div className="mb-6 flex items-center gap-3">
        <Link
          to={`${financeBase}/invoices`}
          aria-label="Back to invoices"
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">New invoice</h1>
      </div>

      <section aria-labelledby={`${id}-question`} className="max-w-3xl">
        <h2
          id={`${id}-question`}
          ref={questionRef}
          tabIndex={-1}
          className="text-lg font-semibold text-slate-900 focus:outline-none dark:text-slate-100"
        >
          Is this a one-time invoice or a recurring invoice?
        </h2>
        {customerId && (
          // The line is held open while the name loads, so the answers don't jump.
          <p className="mt-1 min-h-5 text-sm text-slate-500 dark:text-slate-400">
            {customer && (
              <>
                For{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {customerName(customer)}
                </span>
                , whichever you choose.
              </>
            )}
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {INVOICE_KINDS.map((kind, index) => {
            const copy = KIND_COPY[kind];
            const Icon = copy.icon;
            return (
              <Link
                key={kind}
                ref={(element) => {
                  answerRefs.current[index] = element;
                }}
                to={invoiceKindPath(kind, financeBase, customerId)}
                aria-labelledby={`${id}-${kind}-title`}
                aria-describedby={`${id}-${kind}-blurb`}
                onKeyDown={(event) => moveBetweenAnswers(event, index)}
                className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40 focus-visible:border-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:border-slate-700 dark:bg-slate-900 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/5"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition group-hover:bg-indigo-100 group-hover:text-indigo-700 dark:bg-slate-800 dark:text-slate-300 dark:group-hover:bg-indigo-500/15 dark:group-hover:text-indigo-300">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <span
                  id={`${id}-${kind}-title`}
                  className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100"
                >
                  {copy.title}
                </span>
                <span
                  id={`${id}-${kind}-blurb`}
                  className="mt-1 text-sm text-slate-500 dark:text-slate-400"
                >
                  {copy.blurb}
                </span>
              </Link>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
          Picked the wrong one? Both forms have a switch at the top, and whatever you&apos;ve
          entered comes along.
        </p>
      </section>
    </div>
  );
}

/**
 * At the top of both new-invoice forms: which kind this is, and the other
 * kind one click away. The link replaces this page — the switch changes the
 * answer rather than stepping forward — and hands over what was typed in
 * `state` (`invoiceDraftState`). While the form is saving it is held still.
 */
export function InvoiceKindSwitch({
  current,
  to,
  state,
  disabled = false,
}: {
  current: InvoiceKind;
  /** The other kind's form (`switchInvoiceKindPath`). */
  to: string;
  /** Router state carrying the draft. */
  state: unknown;
  disabled?: boolean;
}) {
  const segment = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium";
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div
        role="group"
        aria-label="Invoice type"
        className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {INVOICE_KINDS.map((kind) => {
          const copy = KIND_COPY[kind];
          const Icon = copy.icon;
          const content = (
            <>
              <Icon size={14} aria-hidden="true" />
              {copy.label}
            </>
          );
          if (kind === current) {
            return (
              <span
                key={kind}
                aria-current="page"
                className={clsx(
                  segment,
                  "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200",
                )}
              >
                {content}
              </span>
            );
          }
          if (disabled) {
            return (
              <span
                key={kind}
                aria-disabled="true"
                className={clsx(segment, "cursor-not-allowed text-slate-400 dark:text-slate-500")}
              >
                {content}
              </span>
            );
          }
          return (
            <Link
              key={kind}
              to={to}
              state={state}
              replace
              className={clsx(
                segment,
                "text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
              )}
            >
              {content}
            </Link>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {current === "one-time" ? "Billed once." : "Billed on a schedule."} Switching keeps what
        you&apos;ve entered.
      </p>
    </div>
  );
}
