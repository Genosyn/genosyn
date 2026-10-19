import {
  discountProblem,
  type DocumentDiscount,
  type DocumentTotals,
  documentTotals,
  NO_DISCOUNT,
} from "../../shared/documentDiscount.js";
import { parseMoneyToCents } from "./api";

/**
 * The discount box on the estimate and invoice forms, as typed: whether it
 * is a percentage or an amount, and the text in it. `none` until the Member
 * adds one.
 */
export type DiscountMode = "none" | "percent" | "amount";

export type DiscountDraft = { mode: DiscountMode; text: string };

export const NO_DISCOUNT_DRAFT: DiscountDraft = { mode: "none", text: "" };

/** What the form shows for a saved document's discount. */
export function discountDraftFrom(doc: DocumentDiscount): DiscountDraft {
  if (doc.discountPercent > 0) {
    return { mode: "percent", text: String(Number(doc.discountPercent.toFixed(2))) };
  }
  if (doc.discountAmountCents > 0) {
    return { mode: "amount", text: (doc.discountAmountCents / 100).toFixed(2) };
  }
  return NO_DISCOUNT_DRAFT;
}

/** The discount the form would save; an empty or unreadable box is none. */
export function discountFromDraft(draft: DiscountDraft): DocumentDiscount {
  if (draft.mode === "percent") {
    const percent = Number(draft.text.replace(/[%\s]/g, ""));
    return { discountPercent: Number.isFinite(percent) ? percent : 0, discountAmountCents: 0 };
  }
  if (draft.mode === "amount") {
    return { discountPercent: 0, discountAmountCents: parseMoneyToCents(draft.text) };
  }
  return NO_DISCOUNT;
}

/** Why the typed discount can't be saved, or null — said where it was typed. */
export function discountDraftProblem(draft: DiscountDraft): string | null {
  if (draft.mode === "none") return null;
  return discountProblem(discountFromDraft(draft));
}

/** A line as the form holds it while it is being typed. */
export type PreviewLine = { quantityText: string; priceText: string; taxRateId: string };

export type PreviewTaxRate = { id: string; ratePercent: number; inclusive: boolean };

/**
 * The totals the estimate and invoice forms show as you type: each line
 * priced the way the server prices it, then the discount taken off before
 * tax (`shared/documentDiscount.ts`), so what you see is what Save stores.
 */
export function previewTotals(
  lines: ReadonlyArray<PreviewLine>,
  taxRates: ReadonlyArray<PreviewTaxRate>,
  draft: DiscountDraft,
): DocumentTotals {
  const priced = lines.map((l) => {
    const gross = Math.round((Number(l.quantityText) || 0) * parseMoneyToCents(l.priceText));
    const rate = taxRates.find((r) => r.id === l.taxRateId);
    const pct = rate?.ratePercent ?? 0;
    if (pct <= 0) {
      return { lineSubtotalCents: gross, lineTaxCents: 0, lineTotalCents: gross, taxPercent: 0 };
    }
    if (rate?.inclusive) {
      const tax = Math.round((gross * pct) / (100 + pct));
      return {
        lineSubtotalCents: gross - tax,
        lineTaxCents: tax,
        lineTotalCents: gross,
        taxPercent: pct,
      };
    }
    const tax = Math.round((gross * pct) / 100);
    return {
      lineSubtotalCents: gross,
      lineTaxCents: tax,
      lineTotalCents: gross + tax,
      taxPercent: pct,
    };
  });
  return documentTotals(priced, discountFromDraft(draft));
}
