import type { Customer } from "./api";

/**
 * One line that tells customers apart in a picker, so two accounts with
 * similar names are never confused: "Acme Corp — acme.com · ap@acme.com".
 * Whichever of domain and email is empty is left out.
 */
export function customerOptionLabel(customer: Pick<Customer, "name" | "domain" | "email">): string {
  const details = [customer.domain, customer.email]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  return details.length > 0 ? `${customer.name} — ${details.join(" · ")}` : customer.name;
}
