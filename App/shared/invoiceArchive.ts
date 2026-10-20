/**
 * Which invoices and recurring invoice schedules can be archived.
 *
 * Archiving is filing: it takes a record out of the default lists and
 * changes nothing else. So it is kept for records nobody needs to act on — an
 * invoice with nothing left to collect, and a schedule that has stopped
 * billing. An invoice still owed money, or a schedule still running, stays in
 * front of the Members and AI Employees who look after it, and a hidden
 * receivable can never sit inside a balance nobody sees listed.
 *
 * Shared between client and server so the pages only offer what the server
 * will accept: the bulk endpoints skip a blocked record with this reason, and
 * the lists show it beside the checkbox they disable.
 */

/** Why an issued invoice with money owed can't be archived. */
export const INVOICE_BALANCE_DUE = "Has a balance due";

/** Why a schedule that still bills can't be archived. */
export const RECURRING_INVOICE_STILL_ACTIVE = "Still active";

/**
 * Why an invoice can't be archived yet, or null when it can. A draft owes
 * nothing until it is issued, and a void invoice owes nothing at all; an
 * issued one can be filed once it is settled — paid, credited, or written off.
 */
export function invoiceArchiveBlocker(invoice: {
  status: string;
  balanceCents: number;
}): string | null {
  if (invoice.status === "draft" || invoice.status === "void") return null;
  return invoice.balanceCents > 0 ? INVOICE_BALANCE_DUE : null;
}

/**
 * Why a recurring invoice schedule can't be archived yet, or null when it
 * can: a paused or ended schedule bills nobody, an active one bills on its
 * next run.
 */
export function recurringInvoiceArchiveBlocker(schedule: { status: string }): string | null {
  return schedule.status === "active" ? RECURRING_INVOICE_STILL_ACTIVE : null;
}
