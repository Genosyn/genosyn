import React from "react";
import { api, type AIModel, type Company, type ModelEffort } from "@/lib/api";
import { companyModelPath } from "@/lib/companyModels";
import { errorMessage } from "@/lib/errors";
import { thinkingSettingsLine, thinkingSettingsSave } from "@/lib/thinkingLevel";
import { effortLabel, effortRank } from "../../../shared/thinkingLevels";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import { ModelSettingSection } from "./ModelSettingSection";

/**
 * How hard this AI Model thinks in chat: the level a conversation left on
 * Default starts at, and the highest level Members may choose — higher levels
 * take longer and cost more. Both apply to chat, Help and Repository work
 * sessions on this model, for every AI Employee on it; Routines keep the
 * model's own default. A custom endpoint offers levels only once an owner
 * turns them on, because nothing says whether a compatible server reads
 * `reasoning_effort`. It saves as it is picked; a Member reads it.
 */
export function ThinkingLevelPanel({
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
  // A model row from a server that does not describe thinking shows nothing.
  if (!model.thinking) return null;
  const thinking = model.thinking;
  const custom = model.authMode === "customEndpoint";
  const levels = thinking.levels;

  async function save(next: Parameters<typeof thinkingSettingsSave>[1]) {
    setError(null);
    setBusy(true);
    try {
      await api.put(
        companyModelPath(company.id, model.id, "/thinking"),
        thinkingSettingsSave(model, next),
      );
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const level = (value: string): ModelEffort | null =>
    levels.find((candidate) => candidate === value) ?? null;

  return (
    <ModelSettingSection
      title="Thinking level"
      description={
        <>
          <span className="text-slate-700 dark:text-slate-200">{thinkingSettingsLine(model)}</span>
          <span className="mt-0.5 block text-slate-400 dark:text-slate-500">
            {levels.length > 0
              ? "How hard the AI Model thinks before it answers in chat, Help and work sessions. Members pick a level per conversation; higher levels take longer and cost more. Routines use the AI Model's own default."
              : (thinking.unavailableReason ??
                "This AI Model doesn't offer thinking levels, so it uses its own default.")}
          </span>
        </>
      }
    >
      {(error || (canManage && (custom || levels.length > 0))) && (
        <div className="space-y-3">
          {canManage && custom && (
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
              <Checkbox
                label="Offer thinking levels on this server"
                checked={model.customThinkingLevels}
                disabled={busy}
                onChange={(event) => void save({ customThinkingLevels: event.target.checked })}
              />
              <span>
                Offer thinking levels
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Sends <code className="font-mono">reasoning_effort</code> (Off, Low, Medium,
                  High). Turn on only if the server reads it — vLLM and Ollama do for some models.
                  A level the server refuses is dropped for that reply, and the reply says so.
                </span>
              </span>
            </label>
          )}
          {canManage && levels.length > 0 && (
            <div className="flex flex-wrap gap-3">
              <label className="block w-56 max-w-full text-xs font-medium text-slate-700 dark:text-slate-200">
                Default for chat
                <Select
                  aria-label="Default thinking level for chat"
                  value={thinking.defaultLevel ?? ""}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  containerClassName="mt-1"
                  onChange={(event) => void save({ defaultEffort: level(event.target.value) })}
                >
                  <option value="">
                    {thinking.nativeDefault
                      ? `The AI Model's own (${effortLabel(thinking.nativeDefault)})`
                      : "The AI Model's own"}
                  </option>
                  {levels.map((candidate) => (
                    <option
                      key={candidate}
                      value={candidate}
                      // Above the ceiling a default could never run; lower the
                      // ceiling first instead, which brings the default down.
                      disabled={aboveCeiling(thinking.ceiling, candidate)}
                    >
                      {effortLabel(candidate)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block w-56 max-w-full text-xs font-medium text-slate-700 dark:text-slate-200">
                Highest Members may choose
                <Select
                  aria-label="Highest thinking level Members may choose"
                  value={thinking.ceiling ?? ""}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  containerClassName="mt-1"
                  onChange={(event) => void save({ effortCeiling: level(event.target.value) })}
                >
                  <option value="">No limit</option>
                  {levels.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {effortLabel(candidate)}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
          {error && <FormError message={error} />}
        </div>
      )}
    </ModelSettingSection>
  );
}

function aboveCeiling(ceiling: ModelEffort | null, level: ModelEffort): boolean {
  return ceiling !== null && effortRank(level) > effortRank(ceiling);
}
