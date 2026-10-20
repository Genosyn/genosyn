import { CARD_CATEGORY_ON_BANKING, isCardCategoryEntry } from "./cardCategory.js";

/**
 * Whether Entry review can change an entry's categories, and why not.
 *
 * Entry review approves a category change by posting a `ledger_reclass` entry
 * keyed on the entry it re-files, and leaves that entry's own lines as they
 * were posted. Whatever later reverses the entry — voiding an invoice, a bill
 * or a credit, deleting a payment, reversing a refund or a write-off — reverses
 * the change with it, from the lines as the books hold them now
 * (`bookedLines` in `server/services/ledger.ts`). So a reviewed category never
 * outlives the entry it moved, and Entry review refuses the changes that could:
 *
 * - `card` / `bank`: a card purchase's or a bank transaction's category is
 *   changed on Banking, which knows where the transaction is filed now
 *   (`shared/cardCategory.ts`; a bank transaction is undone there and
 *   categorized again).
 * - `reversal`: a reversal's categories are those of the entry it reverses.
 * - `reversed`: a change approved after an entry was reversed would outlive
 *   the reversal.
 *
 * The server works out each entry's lock (`hydrateLedgerEntries`) and refuses a
 * change on a locked one with its reason; Entry review shows a locked entry's
 * categories without a picker.
 */
export type EntryCategoryLock = "card" | "bank" | "reversal" | "reversed";

/** Why Entry review won't change a locked entry's categories. */
export const ENTRY_CATEGORY_LOCK_REASON: Record<EntryCategoryLock, string> = {
  card: CARD_CATEGORY_ON_BANKING,
  bank: "A bank transaction's category is changed on Banking — approve it here as it is",
  reversal: "A reversal's categories follow the entry it reverses — approve it here as it is",
  reversed:
    "This entry has been reversed, so its categories stay as they are — approve it here as it is",
};

type EntryKey = { id: string; source: string; sourceRefId: string | null };

/** A bank transaction categorized on Banking, and its undoing. */
const BANK_CATEGORY_SOURCES: ReadonlySet<string> = new Set([
  "bank_categorization",
  "bank_categorization_void",
]);

/**
 * How each entry something can reverse is keyed, and the key its reversal is
 * posted under. Bills post as `manual` entries told apart by their
 * `sourceRefId`. Bank and card transactions are left out: Banking owns them.
 */
export function reversalKey(entry: EntryKey): { source: string; sourceRefId: string } | null {
  const ref = entry.sourceRefId;
  if (!ref) return null;
  switch (entry.source) {
    case "invoice_issue":
    case "invoice_revision":
      return { source: "invoice_void", sourceRefId: ref };
    case "invoice_payment":
      return { source: "invoice_void", sourceRefId: `${ref}-deletion` };
    case "credit_note_issue":
      return { source: "credit_note_void", sourceRefId: ref };
    case "credit_note_apply":
      return { source: "credit_note_unapply", sourceRefId: ref };
    case "customer_refund":
      return { source: "customer_refund_void", sourceRefId: ref };
    case "invoice_writeoff":
      return { source: "invoice_writeoff_reversal", sourceRefId: ref };
    case "vendor_credit_issue":
      return { source: "vendor_credit_void", sourceRefId: ref };
    case "vendor_credit_apply":
      return { source: "vendor_credit_unapply", sourceRefId: ref };
    case "vendor_refund":
      return { source: "vendor_refund_void", sourceRefId: ref };
    case "manual":
      if (ref.startsWith("bill_issue:")) {
        return { source: "manual", sourceRefId: `bill_void:${ref.slice("bill_issue:".length)}` };
      }
      if (ref.startsWith("bill_payment:")) {
        return {
          source: "manual",
          sourceRefId: `bill_payment_reversal:${ref.slice("bill_payment:".length)}`,
        };
      }
      return null;
    default:
      return null;
  }
}

/** The reversals {@link reversalKey} names, by what posted them. */
const REVERSAL_SOURCES: ReadonlySet<string> = new Set([
  "invoice_void",
  "credit_note_void",
  "credit_note_unapply",
  "customer_refund_void",
  "invoice_writeoff_reversal",
  "vendor_credit_void",
  "vendor_credit_unapply",
  "vendor_refund_void",
]);

function isReversal(entry: EntryKey): boolean {
  if (REVERSAL_SOURCES.has(entry.source)) return true;
  const ref = entry.sourceRefId ?? "";
  return (
    entry.source === "manual" &&
    (ref.startsWith("bill_void:") || ref.startsWith("bill_payment_reversal:"))
  );
}

/**
 * The lock an entry carries by what posted it, before anything reversed it.
 * Whether it has been reversed since is the server's to look up.
 */
export function entryCategoryLockBySource(entry: EntryKey): EntryCategoryLock | null {
  if (isCardCategoryEntry(entry)) return "card";
  if (BANK_CATEGORY_SOURCES.has(entry.source)) return "bank";
  if (isReversal(entry)) return "reversal";
  return null;
}
