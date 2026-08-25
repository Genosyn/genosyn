import React from "react";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";

import { MailAnalysisSettings as MailAnalysisSettingsData, mailApi } from "../lib/mail";
import { analysisEmployeeOptions, analysisReadinessNote } from "../lib/mailAnalysis";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { errorMessage } from "../lib/errors";

/**
 * The "AI analysis" card on Email settings.
 *
 * Three controls, and one sentence that matters more than all of them: who
 * would read the next email to arrive, and on what. A toggle that says "on"
 * while nothing is happening — because no granted employee has a connected
 * model — is the failure this card is built to prevent, so the readiness line
 * is always present and always specific.
 */
export function MailAnalysisSettingsCard({
  companyId,
  accountId,
}: {
  companyId: string;
  accountId: string;
}) {
  const dialog = useDialog();
  const [data, setData] = React.useState<MailAnalysisSettingsData | null>(null);
  const [saving, setSaving] = React.useState(false);
  /** A load that never arrived — the card has nothing else to show. */
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setData(await mailApi.analysisSettings(companyId, accountId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the AI analysis settings"));
    }
  }, [companyId, accountId]);

  React.useEffect(() => {
    setData(null);
    setLoadError(null);
    void load();
  }, [load]);

  const save = async (input: {
    enabled?: boolean;
    employeeId?: string | null;
    modelId?: string | null;
  }) => {
    if (!data || saving) return;
    const snapshot = data;
    // Optimistic, then reconciled: the server also reports who the change
    // actually resolves to, which is the half the Member came here to see.
    setData({
      ...data,
      enabled: input.enabled ?? data.enabled,
      employeeId: input.employeeId !== undefined ? input.employeeId : data.employeeId,
      modelId:
        input.modelId !== undefined
          ? input.modelId
          : input.employeeId !== undefined
            ? null
            : data.modelId,
    });
    setSaving(true);
    try {
      const result = await mailApi.patchAnalysisSettings(companyId, accountId, input);
      setData((current) =>
        current
          ? {
              ...current,
              enabled: result.account.aiAnalysisEnabled,
              employeeId: result.account.aiAnalysisEmployeeId,
              modelId: result.account.aiAnalysisModelId,
              resolved: result.resolved,
            }
          : current,
      );
    } catch (err) {
      setData(snapshot);
      void dialog.error(err, { title: "Couldn\u2019t save the AI analysis setting" });
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        {loadError ? (
          <FormError message={loadError} />
        ) : (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Spinner size={14} /> Loading AI analysis settings…
          </div>
        )}
      </section>
    );
  }

  const options = analysisEmployeeOptions(data.roster);
  const chosen = data.employeeId
    ? data.roster.find((entry) => entry.id === data.employeeId)
    : undefined;
  const models = chosen?.models ?? [];
  const note = analysisReadinessNote({ enabled: data.enabled, resolved: data.resolved });

  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI analysis</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Read every email as it arrives and put one-click next steps on it — draft the reply,
            raise the invoice or the quote, unsubscribe, file it, or hand it to a teammate. Nothing
            runs on its own: the buttons wait for you, and act with your access, not the
            employee&apos;s.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data.enabled}
          aria-label="Analyse new email with AI"
          disabled={saving}
          onClick={() => void save({ enabled: !data.enabled })}
          className={clsx(
            "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-60",
            data.enabled ? "bg-violet-600" : "bg-slate-200 dark:bg-slate-700",
          )}
        >
          <span
            className={clsx(
              "block h-4 w-4 rounded-full bg-white transition-transform",
              data.enabled && "translate-x-4",
            )}
          />
        </button>
      </div>

      <div
        className={clsx(
          "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
          note.tone === "ok" &&
            "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300",
          note.tone === "warn" &&
            "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200",
          note.tone === "off" &&
            "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400",
        )}
      >
        {note.tone === "ok" ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
        ) : note.tone === "warn" ? (
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        ) : null}
        <span>{note.text}</span>
      </div>

      {data.enabled && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select
            label="AI employee"
            value={data.employeeId ?? ""}
            disabled={saving}
            onChange={(event) => void save({ employeeId: event.target.value || null })}
            emptyMessage="No AI employees yet"
          >
            <option value="">Choose automatically</option>
            {options.map((option) => (
              <option key={option.entry.id} value={option.entry.id} disabled={!option.eligible}>
                {option.entry.name} — {option.detail}
              </option>
            ))}
          </Select>

          <Select
            label="AI model"
            value={data.modelId ?? ""}
            disabled={saving || !chosen || models.length === 0}
            onChange={(event) => void save({ modelId: event.target.value || null })}
          >
            <option value="">{chosen ? "Their active model" : "Choose an employee first"}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.provider} · {model.model}
                {model.isActive ? " (active)" : ""}
              </option>
            ))}
          </Select>
        </div>
      )}
    </section>
  );
}
