import React from "react";
import type { AIModel } from "@/lib/api";
import { offerLine } from "@/lib/companyModels";
import { describeModel } from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";

/**
 * The AI Models the company already has, each one click from being this
 * employee's too. Using one attaches the very same model — its keys, its
 * settings, its usage on the same account — so there is nothing to paste and
 * nothing to keep in step. Offered wherever an AI Model is added: an
 * employee's first one, and another one later.
 */
export function CompanyModelOffers({
  offers,
  attaching,
  error,
  onUse,
}: {
  offers: readonly AIModel[];
  /** The offer being attached, while it is. */
  attaching: string | null;
  error: string | null;
  onUse: (offer: AIModel) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
        Already in your company
      </div>
      <ul className="flex flex-col gap-2">
        {offers.map((offer) => (
          <li
            key={offer.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
          >
            <div className="min-w-0">
              <div className="break-words text-sm text-slate-900 dark:text-slate-100">
                {describeModel(offer)}
              </div>
              <div className="break-words text-xs text-slate-500 dark:text-slate-400">
                {offerLine(offer)}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onUse(offer)}
              loading={attaching === offer.id}
              disabled={attaching !== null}
            >
              Use this one
            </Button>
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </div>
  );
}
