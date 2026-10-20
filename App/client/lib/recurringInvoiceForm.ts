import {
  defaultRecurringInvoiceName,
  resolveRecurringInvoiceName,
  type RecurringInvoiceNameSource,
} from "../../shared/recurringInvoiceName.js";
import {
  CUSTOMER_PICK_PARAM,
  initialCustomerPick,
  requestedCustomerPick,
  withCustomerPick,
  type InitialCustomerPick,
} from "./customerPick.js";

/**
 * The pure half of the recurring invoice form (`FinanceRecurringInvoiceNew`):
 * which customer it starts with, what it copies from the invoice or estimate
 * it was made from, and how its Name follows the customer.
 *
 * A new schedule's Name starts as its customer's name and follows the
 * customer while the person picks a different one. Typing a name takes it
 * over: after that a customer change leaves it alone. Clearing the field hands
 * the name back to the customer. The field stays empty while it is being
 * edited, because the form never fights a keystroke. Saved empty, it uses the
 * customer's name, and the next customer picked fills it in again. An existing
 * schedule starts with the name it was saved with and does not follow, so
 * changing its customer never renames it.
 */
export type RecurringInvoiceNameState = {
  /** Exactly what the Name field shows. */
  value: string;
  /** Whether a customer change replaces {@link value} with that customer's name. */
  followsCustomer: boolean;
};

/** A new schedule is named after its customer and follows it. */
export function initialRecurringInvoiceName(
  customer: RecurringInvoiceNameSource | null | undefined,
): RecurringInvoiceNameState {
  return { value: defaultRecurringInvoiceName(customer), followsCustomer: true };
}

/** An existing schedule keeps the name it was saved with, whatever its customer. */
export function existingRecurringInvoiceName(name: string): RecurringInvoiceNameState {
  return { value: name, followsCustomer: false };
}

/**
 * The person edited the Name field. A name with any text in it is theirs from
 * now on. A blank one hands the name back to the customer.
 */
export function typedRecurringInvoiceName(value: string): RecurringInvoiceNameState {
  return { value, followsCustomer: value.trim() === "" };
}

/** The customer changed: a name that follows it becomes the new customer's. */
export function changeRecurringInvoiceNameCustomer(
  state: RecurringInvoiceNameState,
  customer: RecurringInvoiceNameSource | null | undefined,
): RecurringInvoiceNameState {
  return state.followsCustomer ? initialRecurringInvoiceName(customer) : state;
}

/**
 * The name the form saves: what the field holds, trimmed, or the customer's
 * name when it is blank, the same rule the create API applies. "" means there
 * is nothing to save.
 */
export function recurringInvoiceNameToSave(
  state: RecurringInvoiceNameState,
  customer: RecurringInvoiceNameSource | null | undefined,
): string {
  return resolveRecurringInvoiceName(state.value, customer);
}

/**
 * The query parameter that picks the customer on the New recurring invoice
 * form — the one every new-document form reads (`lib/customerPick.ts`).
 */
export const RECURRING_INVOICE_CUSTOMER_PARAM = CUSTOMER_PICK_PARAM;

/** Link to the New recurring invoice form, optionally starting with one customer picked. */
export function newRecurringInvoicePath(financeBase: string, customerId?: string | null): string {
  return withCustomerPick(`${financeBase}/recurring-invoices/new`, customerId);
}

/** The customer a link to the form asked for, or null when it asked for none. */
export function requestedRecurringInvoiceCustomerId(params: URLSearchParams): string | null {
  return requestedCustomerPick(params);
}

/**
 * An invoice or estimate a new schedule starts as a copy of — Make recurring
 * on either. The document itself never changes.
 */
export type RecurringInvoiceSourceKind = "invoice" | "estimate";

export type RecurringInvoiceSourceRef = { kind: RecurringInvoiceSourceKind; slug: string };

/** The query parameter that names the document a new schedule copies. */
export const RECURRING_INVOICE_SOURCE_PARAMS: Record<RecurringInvoiceSourceKind, string> = {
  invoice: "fromInvoice",
  estimate: "fromEstimate",
};

/** Link to the New recurring invoice form, starting as a copy of `source`. */
export function recurringInvoiceFromDocumentPath(
  financeBase: string,
  source: RecurringInvoiceSourceRef,
): string {
  const params = new URLSearchParams({ [RECURRING_INVOICE_SOURCE_PARAMS[source.kind]]: source.slug });
  return `${financeBase}/recurring-invoices/new?${params}`;
}

/** The document a link asked the form to copy, or null. An invoice wins if both are named. */
export function requestedRecurringInvoiceSource(
  params: URLSearchParams,
): RecurringInvoiceSourceRef | null {
  for (const kind of ["invoice", "estimate"] as const) {
    const slug = params.get(RECURRING_INVOICE_SOURCE_PARAMS[kind])?.trim();
    if (slug) return { kind, slug };
  }
  return null;
}

/** What a schedule copies from an invoice or estimate. */
export type RecurringInvoiceSourceDocument = {
  customerId: string;
  subsidiaryId: string | null;
  currency: string;
  issueDate: string;
  /** An invoice's; an estimate has none. */
  dueDate?: string | null;
  notes: string;
  footer: string;
  /** The whole-document discount taken, pre-tax. */
  discountCents: number;
  lines: ReadonlyArray<{
    productId: string | null;
    description: string;
    quantity: number;
    unitPriceCents: number;
    taxRateId: string | null;
    taxPercent: number;
    sortOrder: number;
  }>;
};

/** The ids the form can still offer: a line pointing anywhere else is cut loose. */
export type RecurringInvoicePrefillOptions = {
  productIds: ReadonlySet<string>;
  taxRateIds: ReadonlySet<string>;
  subsidiaryIds: ReadonlySet<string>;
};

export type RecurringInvoicePrefillLine = {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
};

export type RecurringInvoicePrefill = {
  customerId: string;
  /** "" issues from the company itself. */
  subsidiaryId: string;
  currency: string;
  /** The source invoice's payment terms; null for an estimate, which keeps the form's default. */
  daysUntilDue: number | null;
  notes: string;
  footer: string;
  lines: RecurringInvoicePrefillLine[];
  /**
   * The source's discount, which a schedule cannot carry: each invoice it
   * creates bills the full line prices. 0 when there was none.
   */
  droppedDiscountCents: number;
  /** Taxed lines whose tax rate has since been deleted, so they start untaxed here. */
  untaxedLines: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from issue to due, within the 0–365 the form accepts; null when unknown. */
function paymentTermsDays(issueDate: string, dueDate: string | null | undefined): number | null {
  if (!dueDate) return null;
  const days = Math.round((new Date(dueDate).getTime() - new Date(issueDate).getTime()) / DAY_MS);
  if (!Number.isFinite(days)) return null;
  return Math.min(365, Math.max(0, days));
}

/**
 * A new schedule's starting values, copied from an invoice or estimate: who it
 * bills and from which entity, in what currency and on what terms, for which
 * lines, with what notes and footer. The schedule itself is the person's to
 * choose — a document has no cadence to copy.
 *
 * A line keeps its description, quantity and price. A product or tax rate the
 * form no longer offers is dropped rather than carried as an id nothing shows,
 * and a taxed line that loses its rate is counted so the form can say so. An
 * issuer that still exists is kept even when archived, so the form's own
 * warning asks for an active one instead of a different entity being swapped in.
 */
export function recurringInvoicePrefill(
  source: RecurringInvoiceSourceDocument,
  options: RecurringInvoicePrefillOptions,
): RecurringInvoicePrefill {
  let untaxedLines = 0;
  const lines = [...source.lines]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((line) => {
      const taxRateId =
        line.taxRateId && options.taxRateIds.has(line.taxRateId) ? line.taxRateId : null;
      if (!taxRateId && line.taxPercent > 0) untaxedLines += 1;
      return {
        productId: line.productId && options.productIds.has(line.productId) ? line.productId : null,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        taxRateId,
      };
    });
  return {
    customerId: source.customerId,
    subsidiaryId:
      source.subsidiaryId && options.subsidiaryIds.has(source.subsidiaryId)
        ? source.subsidiaryId
        : "",
    currency: source.currency,
    daysUntilDue: paymentTermsDays(source.issueDate, source.dueDate),
    notes: source.notes,
    footer: source.footer,
    lines,
    droppedDiscountCents: Math.max(0, source.discountCents),
    untaxedLines,
  };
}

export type InitialRecurringInvoiceCustomer<C> = InitialCustomerPick<C>;

/**
 * The customer a new schedule starts with: the one the link asked for, else the
 * first in the list. A requested customer the list does not offer is never
 * swapped for another, which could bill the wrong account. The form starts with
 * no customer and says why.
 */
export function initialRecurringInvoiceCustomer<C extends { id: string }>(
  customers: readonly C[],
  requestedId: string | null,
): InitialRecurringInvoiceCustomer<C> {
  return initialCustomerPick(customers, requestedId);
}
