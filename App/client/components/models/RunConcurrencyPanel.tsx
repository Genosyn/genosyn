import React from "react";
import { api, type AIModel, type Company } from "@/lib/api";
import { companyModelPath } from "@/lib/companyModels";
import { errorMessage } from "@/lib/errors";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { ModelSettingSection } from "./ModelSettingSection";

const RUN_CONCURRENCY_CHOICES = [1, 2, 3, 4, 6, 8];

/**
 * How many Routine Runs may use this model at once.
 *
 * A model server you run yourself is usually one GPU: Runs served in parallel
 * slow each other down, and each one's time limit keeps running while it waits.
 * Runs beyond this limit wait in the queue instead and start, with their whole
 * time limit, when another finishes. The limit is shared by every AI Employee
 * that points at the same endpoint. It saves as it is picked; a Member reads it.
 */
export function RunConcurrencyPanel({
  company,
  model,
  canManage,
  onChanged,
}: {
  company: Pick<Company, "id">;
  model: AIModel;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const base = companyModelPath(company.id, model.id);
  const value = model.maxConcurrentRuns === null ? "default" : String(model.maxConcurrentRuns);
  const choices =
    model.maxConcurrentRuns && !RUN_CONCURRENCY_CHOICES.includes(model.maxConcurrentRuns)
      ? [...RUN_CONCURRENCY_CHOICES, model.maxConcurrentRuns].sort((a, b) => a - b)
      : RUN_CONCURRENCY_CHOICES;

  async function save(next: string) {
    setError(null);
    setBusy(true);
    try {
      await api.put(`${base}/run-concurrency`, {
        maxConcurrentRuns: next === "default" ? null : Number(next),
      });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const limit = model.effectiveMaxConcurrentRuns;
  const source =
    model.concurrencySource === "local-default"
      ? "the default for a model server on this machine or a private network"
      : model.concurrencySource === "configured"
        ? "set by hand"
        : "the default for a hosted model";

  return (
    <ModelSettingSection
      title="Concurrent Routine Runs"
      description={
        <>
          <span className="tabular-nums text-slate-700 dark:text-slate-200">
            {limit === null ? "No limit" : `${limit} at a time`}
          </span>{" "}
          · {source}
          <span className="mt-0.5 block text-slate-400 dark:text-slate-500">
            Routines beyond the limit wait in the queue and start when a Run on this model finishes;
            their time limit starts then. Lower it when a model you run yourself slows down under
            parallel work.
          </span>
        </>
      }
      aside={
        canManage && (
          <div className="w-36">
            <Select
              aria-label="Concurrent Routine Runs"
              value={value}
              disabled={busy}
              aria-busy={busy || undefined}
              onChange={(e) => void save(e.target.value)}
            >
              <option value="default">Default</option>
              {choices.map((n) => (
                <option key={n} value={String(n)}>
                  {n} at a time
                </option>
              ))}
              <option value="0">No limit</option>
            </Select>
          </div>
        )
      }
    >
      {error && <FormError message={error} />}
    </ModelSettingSection>
  );
}
