import React from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { api, type AIModel, type Company } from "@/lib/api";
import { companyModelPath } from "@/lib/companyModels";
import { errorDetail, errorMessage } from "@/lib/errors";
import { modelOutageNotice } from "@/lib/modelOutage";
import { useNow } from "@/lib/useNow";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";

/**
 * Said on an AI Model's card while the model is unavailable — its service
 * can't be reached, is failing, is overloaded or keeps every key rate-limited:
 * since when, why, what is waiting for it and when Genosyn checks it next. The
 * work waits instead of failing and carries on by itself once a check finds the
 * model answering, so nothing here needs pressing; "Check now" only asks
 * sooner. Owners and admins see the button; a Member sees the same words.
 */
export function ModelOutageNotice({
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
  const now = useNow(15_000).getTime();
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const notice = modelOutageNotice(model.availability, now);
  if (!notice) return null;

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      await api.post(companyModelPath(company.id, model.id, "/availability/check"));
    } catch (err) {
      setError(err);
    } finally {
      setChecking(false);
      // Answering or not, the card now shows what the check found.
      onChanged();
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <CloudOff size={14} className="mt-px shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{notice.headline}</p>
          <p>{notice.detail}</p>
          <p>{notice.work}</p>
          <p className="tabular-nums text-amber-800 dark:text-amber-200">
            {notice.nextCheck}
            {notice.checks ? ` · ${notice.checks}` : ""}
          </p>
        </div>
        {canManage && (
          <Button size="sm" variant="secondary" onClick={checkNow} loading={checking}>
            <RefreshCw size={14} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        )}
      </div>
      <FormError message={error ? errorMessage(error) : null} detail={errorDetail(error)} />
    </div>
  );
}
