/**
 * Recurring invoice names: a schedule is named after the customer it bills
 * unless someone names it.
 *
 * The New recurring invoice form pre-fills its Name with
 * {@link defaultRecurringInvoiceName}. The create route and the
 * `create_recurring_invoice` tool fall back to the same name when one is left
 * out or blank. Shared between client and server so the name the form shows
 * and the name the API saves can never disagree.
 */

/** The longest name a schedule may have. The create and edit schemas enforce it. */
export const RECURRING_INVOICE_NAME_MAX_LENGTH = 200;

/** The customer fields a default name is taken from. */
export type RecurringInvoiceNameSource = {
  name?: string | null;
  domain?: string | null;
  email?: string | null;
};

/** One line: every run of whitespace, including a line break an import kept, becomes one space. */
function singleLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Shorten a name to at most `max` UTF-16 code units, the unit zod's `.max()`
 * counts, without leaving half of a surrogate pair at the end.
 */
export function clipRecurringInvoiceName(
  value: string,
  max: number = RECURRING_INVOICE_NAME_MAX_LENGTH,
): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const last = value.charCodeAt(end - 1);
  // A high surrogate here would lose the low half that follows it.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end).trimEnd();
}

/**
 * The name a schedule takes when nobody names it: the customer's name. A
 * customer without one falls back to its domain, then its billing email, so
 * the name still says who is billed. Returns "" when the customer has none of
 * them.
 */
export function defaultRecurringInvoiceName(
  customer: RecurringInvoiceNameSource | null | undefined,
): string {
  if (!customer) return "";
  const label =
    singleLine(customer.name) || singleLine(customer.domain) || singleLine(customer.email);
  return clipRecurringInvoiceName(label);
}

/**
 * The name to save: the one given, trimmed, or the customer's when it is
 * missing or blank. Returns "" when neither exists, which the caller must
 * refuse. A given name is never shortened; the schemas reject one that is too
 * long.
 */
export function resolveRecurringInvoiceName(
  requested: string | null | undefined,
  customer: RecurringInvoiceNameSource | null | undefined,
): string {
  const given = (requested ?? "").trim();
  return given || defaultRecurringInvoiceName(customer);
}
