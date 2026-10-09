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
 * which customer it starts with and how its Name follows the customer.
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
