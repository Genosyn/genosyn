import { ApiError, type Customer } from "./api";
import { errorMessage } from "./errors";

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

export type MissingDetailsPatch = { email?: string; billingAddress?: string };

/**
 * What a document form writes to the customer when someone adds a missing
 * email or billing address under its Customer field: each detail the customer
 * is missing and the person filled in, trimmed. A detail already on file is
 * never part of it, so this can only fill a gap, not overwrite. Null when
 * there is nothing to save.
 */
export function missingDetailsPatch(
  customer: Pick<Customer, "email" | "billingAddress">,
  draft: { email: string; address: string },
): MissingDetailsPatch | null {
  const onFile = customerBillTo(customer);
  const email = draft.email.trim();
  const address = draft.address.trim();
  const patch: MissingDetailsPatch = {};
  if (!onFile.email && email) patch.email = email;
  if (!onFile.address && address) patch.billingAddress = address;
  return patch.email !== undefined || patch.billingAddress !== undefined ? patch : null;
}

/**
 * The sentence for a refused save of those details. The server checks an
 * email more strictly than the browser does (`a@b` passes one and not the
 * other) and refuses with the bare word "ValidationError", so name the field.
 */
export function missingDetailsError(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    const issues = (error.data as { issues?: { path?: unknown[] }[] } | null)?.issues;
    if (issues?.some((issue) => issue.path?.[0] === "email")) {
      return "Enter a valid email address, like ap@example.com.";
    }
  }
  return errorMessage(error, "Couldn't save to the customer.");
}

/** `customers` with `saved` in place of its row, every other row as it was. */
export function withSavedCustomer<C extends { id: string }>(
  customers: C[] | null,
  saved: C,
): C[] | null {
  return customers?.map((customer) => (customer.id === saved.id ? saved : customer)) ?? null;
}
