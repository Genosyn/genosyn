import type { Customer } from "./api";

/**
 * Who a document billed to this customer reaches: the email Send uses and the
 * billing address its "Bill to" prints. The invoice and estimate renderers
 * read both from the customer every time, never from a copy saved with the
 * document, so one added later still reaches documents already issued.
 * Whitespace alone prints nothing, so it counts as missing.
 */
export function customerBillTo(customer: Pick<Customer, "email" | "billingAddress">): {
  email: string;
  address: string;
} {
  return {
    email: (customer.email ?? "").trim(),
    address: (customer.billingAddress ?? "").trim(),
  };
}

/** `customers` with `fresh` in place of the row it re-reads, every other row as it was. */
export function withCustomerReread<C extends { id: string }>(
  customers: C[] | null,
  fresh: C,
): C[] | null {
  return customers?.map((customer) => (customer.id === fresh.id ? fresh : customer)) ?? null;
}
