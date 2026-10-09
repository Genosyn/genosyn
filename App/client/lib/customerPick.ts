/**
 * Starting a document from a customer's page — an invoice, an estimate, a
 * recurring invoice, a signature request — carries that customer along as
 * `?customerId=`, so the form opens with them picked instead of whoever is
 * first in the list.
 */
export const CUSTOMER_PICK_PARAM = "customerId";

/** `path`, asking the form there to start with `customerId` picked. */
export function withCustomerPick(path: string, customerId?: string | null): string {
  if (!customerId) return path;
  return `${path}?${new URLSearchParams({ [CUSTOMER_PICK_PARAM]: customerId })}`;
}

/** The customer a link to a form asked for, or null when it asked for none. */
export function requestedCustomerPick(params: URLSearchParams): string | null {
  const value = params.get(CUSTOMER_PICK_PARAM)?.trim();
  return value ? value : null;
}

export type InitialCustomerPick<C> = {
  customer: C | null;
  /** The link asked for a customer the form cannot offer (archived, deleted, or another company's). */
  requestedUnavailable: boolean;
};

/**
 * The customer a new document starts with: the one the link asked for, else
 * the first in the list — or nobody, for a form where the customer is
 * optional. A requested customer the list does not offer is never swapped for
 * another, which could bill the wrong account: the form starts with no
 * customer and says why.
 */
export function initialCustomerPick<C extends { id: string }>(
  customers: readonly C[],
  requestedId: string | null,
  { fallbackToFirst = true }: { fallbackToFirst?: boolean } = {},
): InitialCustomerPick<C> {
  if (requestedId) {
    const requested = customers.find((customer) => customer.id === requestedId) ?? null;
    return { customer: requested, requestedUnavailable: requested === null };
  }
  return {
    customer: fallbackToFirst ? (customers[0] ?? null) : null,
    requestedUnavailable: false,
  };
}
