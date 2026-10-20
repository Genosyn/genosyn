import type { LedgerEntrySource } from "./api";

/**
 * What posted a journal entry, in plain words — the badge on the Journal, the
 * origin on Entry review, and a match suggestion on Banking all read it here.
 */
export const LEDGER_SOURCE_LABEL: Record<LedgerEntrySource, string> = {
  manual: "Manual",
  invoice_issue: "Invoice issued",
  invoice_revision: "Invoice revised",
  invoice_payment: "Payment",
  invoice_void: "Reversal",
  credit_note_issue: "Credit note",
  credit_note_apply: "Credit applied",
  credit_note_unapply: "Credit unapplied",
  credit_note_void: "Credit voided",
  customer_refund: "Refund",
  customer_refund_void: "Refund reversed",
  invoice_writeoff: "Write-off",
  invoice_writeoff_reversal: "Write-off reversed",
  vendor_credit_issue: "Vendor credit",
  vendor_credit_apply: "Vendor credit applied",
  vendor_credit_unapply: "Vendor credit unapplied",
  vendor_credit_void: "Vendor credit voided",
  vendor_refund: "Vendor refund",
  vendor_refund_void: "Vendor refund reversed",
  bank_categorization: "Bank categorized",
  bank_categorization_void: "Bank uncategorized",
  brex_card_expense: "Card expense",
  brex_card_refund: "Card refund",
  brex_card_payment: "Card payment",
  brex_card_reclass: "Reclassification",
  ledger_reclass: "Approved category",
};

/**
 * Bills, the period close, and applied proposals post as `manual` entries
 * told apart by their `sourceRefId` (the source column has no bill kinds), so
 * they are named by that.
 */
const MANUAL_ORIGINS: ReadonlyArray<[prefix: string, label: string]> = [
  ["bill_payment_reversal:", "Bill payment reversed"],
  ["bill_payment:", "Bill payment"],
  ["bill_issue:", "Bill"],
  ["bill_void:", "Bill voided"],
  ["finance_proposal:", "Manual"],
];

export function ledgerSourceLabel(source: string, sourceRefId?: string | null): string {
  if (source === "manual" && sourceRefId) {
    const origin = MANUAL_ORIGINS.find(([prefix]) => sourceRefId.startsWith(prefix));
    // The period close is the one manual entry keyed by a bare id.
    return origin ? origin[1] : sourceRefId.includes(":") ? "Manual" : "Period close";
  }
  return LEDGER_SOURCE_LABEL[source as LedgerEntrySource] ?? "Journal entry";
}

/**
 * Only an entry someone posted by hand can be deleted, and only until it is
 * approved: everything else is managed by the bill, period, or proposal that
 * posted it, and the server refuses the rest.
 */
export function isDeletableManualEntry(entry: {
  source: string;
  sourceRefId: string | null;
  reviewStatus: string;
}): boolean {
  return entry.source === "manual" && !entry.sourceRefId && entry.reviewStatus !== "approved";
}
