import React from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, Sparkles } from "lucide-react";

import {
  MailAnalysisInstructionsState,
  MailAnalysisSettings as MailAnalysisSettingsData,
  mailApi,
} from "../lib/mail";
import {
  analysisEmployeeOptions,
  analysisInstructionsEdit,
  analysisReadinessNote,
} from "../lib/mailAnalysis";
import { MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH } from "../../shared/mailAnalysisInstructions";
import { Button } from "../components/ui/Button";
import { clsx } from "../components/ui/clsx";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { errorMessage } from "../lib/errors";

/**
 * The "AI analysis" card on Email settings.
 *
 * Four controls, and one sentence that matters more than all of them: who
 * would read the next email to arrive, and on what. A toggle that says "on"
 * while nothing is happening — because no granted employee has a connected
 * model — is the failure this card is built to prevent, so the readiness line
 * is always present and always specific.
 *
 * The instructions box is the part that acts. It says, right under it, the
 * whole list of what can happen on its own and that every step shows on the
 * email, where all but an unsubscribe can be undone, because "the AI changed
 * my inbox" is only acceptable when the person knew exactly how far it could go.
 */
export function MailAnalysisSettingsCard({
  companyId,
  accountId,
  canManageAccess = true,
}: {
  companyId: string;
  accountId: string;
  /** Whether the viewer can change AI access, which the readiness line points to. */
  canManageAccess?: boolean;
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
      void dialog.error(err, { title: "Couldn’t save the AI analysis setting" });
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
  const note = analysisReadinessNote({
    enabled: data.enabled,
    resolved: data.resolved,
    canManageAccess,
  });

  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI analysis</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Read every email as it arrives, follow your instructions, and put one-click next steps
            on it — draft the reply, raise the invoice or the quote, unsubscribe, file it, or hand
            it to a teammate. Only your instructions run on their own; the buttons wait for you,
            and act with your access, not the employee&apos;s.
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
        <>
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

          <AnalysisInstructions
            companyId={companyId}
            accountId={accountId}
            saved={data.instructions}
            usingDefault={data.usingDefaultInstructions}
            busyElsewhere={saving}
            onSaved={(state) =>
              setData((current) => (current ? { ...current, ...state } : current))
            }
          />
        </>
      )}
    </section>
  );
}

/**
 * The instructions box. Free text on purpose — people say what they want in
 * their own words, one line each — with the default already in it, so the
 * first thing anyone sees is a working example rather than an empty field.
 */
function AnalysisInstructions({
  companyId,
  accountId,
  saved,
  usingDefault,
  busyElsewhere,
  onSaved,
}: {
  companyId: string;
  accountId: string;
  saved: string;
  usingDefault: boolean;
  /** Another control on the card is saving; wait for it. */
  busyElsewhere: boolean;
  onSaved: (state: MailAnalysisInstructionsState) => void;
}) {
  const [draft, setDraft] = React.useState(saved);
  const [busy, setBusy] = React.useState<"save" | "restore" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fieldId = React.useId();
  const hintId = React.useId();

  // A save (or Restore default) hands down new text; show it. Edits typed
  // since are the person's, so only a change in what was saved replaces them.
  const lastSaved = React.useRef(saved);
  React.useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setDraft(saved);
  }, [saved]);

  const edit = analysisInstructionsEdit({ draft, saved, usingDefault });

  const submit = async (instructions: string | null, kind: "save" | "restore") => {
    if (busy || busyElsewhere) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await mailApi.patchAnalysisSettings(companyId, accountId, { instructions });
      lastSaved.current = result.instructions;
      setDraft(result.instructions);
      onSaved({
        instructions: result.instructions,
        usingDefaultInstructions: result.usingDefaultInstructions,
      });
    } catch (err) {
      setError(
        errorMessage(
          err,
          kind === "restore"
            ? "Couldn’t restore the default instructions"
            : "Couldn’t save the instructions",
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800"
      onSubmit={(event) => {
        event.preventDefault();
        if (edit.canSave) void submit(draft, "save");
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={fieldId}
          className="text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          Instructions
        </label>
        {usingDefault && !edit.dirty && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            Default
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Every new email is checked against these. Write what you want in your own words, one
        instruction per line.
      </p>
      <div className="mt-2">
        <Textarea
          id={fieldId}
          aria-describedby={hintId}
          value={draft}
          rows={4}
          maxLength={MAX_MAIL_ANALYSIS_INSTRUCTIONS_LENGTH}
          spellCheck
          disabled={busy !== null}
          className="min-h-[104px] leading-6"
          placeholder={"For example:\nStar emails from customers that need a reply."}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (edit.canSave) void submit(draft, "save");
            }
          }}
        />
      </div>
      <p id={hintId} className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
        On its own, the AI employee can only star, mark as read, archive, add a label your
        instruction names, or unsubscribe when the email has a verified one-click unsubscribe
        (Gmail mailboxes). It never replies, sends, forwards or deletes. Everything it does shows
        on the email, and all but an unsubscribe can be undone there. Leave the box empty to only
        get a summary and suggestions.
      </p>
      <FormError message={error ?? (edit.dirty ? edit.problem : null)} className="mt-2" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          loading={busy === "save"}
          disabled={!edit.canSave || busy !== null || busyElsewhere}
        >
          Save instructions
        </Button>
        {edit.dirty && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setDraft(saved);
              setError(null);
            }}
          >
            Cancel
          </Button>
        )}
        {edit.canRestore && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={busy === "restore"}
            disabled={busy !== null || busyElsewhere}
            onClick={() => void submit(null, "restore")}
          >
            <RotateCcw size={14} /> Restore default
          </Button>
        )}
        <span className="text-xs text-slate-400 sm:ml-auto dark:text-slate-500">
          {edit.countLabel}
        </span>
      </div>
    </form>
  );
}
