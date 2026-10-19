import React from "react";
import { Plus, X } from "lucide-react";
import { formatMoney } from "@/lib/api";
import {
  type DiscountDraft,
  discountDraftProblem,
  discountFromDraft,
  NO_DISCOUNT_DRAFT,
} from "@/lib/discountForm";
import { discountLabel } from "../../../shared/documentDiscount";
import { clsx } from "@/components/ui/clsx";

/**
 * The Discount row in the totals of the estimate and invoice forms: an
 * `Add discount` link until there is one, then the amount taken off and the
 * box to type it in, as a percentage or a fixed amount in the document's
 * currency. The discount comes off before tax.
 */
export function DiscountField({
  draft,
  onChange,
  currency,
  discountCents,
}: {
  draft: DiscountDraft;
  onChange: (draft: DiscountDraft) => void;
  currency: string;
  /** What the discount takes off, as the totals work it out. */
  discountCents: number;
}) {
  // Only a discount the Member just added takes the cursor; one loaded with
  // the document never does.
  const [justAdded, setJustAdded] = React.useState(false);
  const problem = discountDraftProblem(draft);

  if (draft.mode === "none") {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setJustAdded(true);
            onChange({ mode: "percent", text: "" });
          }}
          className="inline-flex items-center gap-1 rounded-md py-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          <Plus size={12} /> Add discount
        </button>
      </div>
    );
  }

  const toggle = (mode: DiscountDraft["mode"], label: string) => (
    <button
      type="button"
      aria-pressed={draft.mode === mode}
      onClick={() => onChange({ mode, text: draft.text })}
      className={clsx(
        "h-8 px-2.5 text-xs font-medium",
        draft.mode === mode
          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-slate-500 dark:text-slate-400">
        <span>{discountLabel(discountFromDraft(draft))}</span>
        <span className="tabular-nums">
          {discountCents > 0
            ? `-${formatMoney(discountCents, currency)}`
            : formatMoney(0, currency)}
        </span>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <input
          value={draft.text}
          onChange={(e) => onChange({ mode: draft.mode, text: e.target.value })}
          autoFocus={justAdded}
          inputMode="decimal"
          aria-label={draft.mode === "percent" ? "Discount percentage" : "Discount amount"}
          aria-invalid={problem ? true : undefined}
          placeholder={draft.mode === "percent" ? "10" : "0.00"}
          className={clsx(
            "h-8 w-24 rounded-md border bg-white px-2 text-right text-sm tabular-nums dark:bg-slate-900",
            problem
              ? "border-red-400 dark:border-red-800"
              : "border-slate-200 dark:border-slate-700",
          )}
        />
        <div
          role="group"
          aria-label="Discount type"
          className="inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"
        >
          {toggle("percent", "%")}
          {toggle("amount", currency || "Amount")}
        </div>
        <button
          type="button"
          onClick={() => {
            setJustAdded(false);
            onChange(NO_DISCOUNT_DRAFT);
          }}
          aria-label="Remove discount"
          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
        >
          <X size={14} />
        </button>
      </div>
      {problem && <p className="text-right text-xs text-red-600 dark:text-red-400">{problem}</p>}
    </div>
  );
}
