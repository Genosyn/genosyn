import React from "react";
import type { ReusableModel } from "@/lib/api";
import { describeModel } from "@/lib/modelSummary";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";

/**
 * The AI Models other AI Employees in the company already run on, each one
 * click away — the key is copied on the server, so there is nothing to paste
 * and usage is billed to the same account. Offered wherever an AI Model is
 * added: an employee's first one, and another one later.
 */
export function CompanyModelOffers({
  offers,
  reusing,
  error,
  onUse,
}: {
  offers: readonly ReusableModel[];
  /** The offer whose copy is being made, while it is. */
  reusing: string | null;
  error: string | null;
  onUse: (offer: ReusableModel) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
        Already connected in your company
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
                {offer.employeeName} runs on it
                {offer.endpointHost ? ` · ${offer.endpointHost}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onUse(offer)}
              loading={reusing === offer.id}
              disabled={reusing !== null}
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
