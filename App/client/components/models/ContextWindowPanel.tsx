import React from "react";
import { Edit3, Plug, X } from "lucide-react";
import { api, type AIModel, type Company, type Employee } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/Button";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { ModelSettingSection } from "./ModelSettingSection";

/**
 * The model's context window, and the ways to fix it when nobody knows it.
 *
 * For nearly everyone the number is found on its own, or simply isn't reported,
 * and never needs a thought — which is why it lives in the card's Advanced
 * section. It is still load-bearing: a Run budgets against it to decide when to
 * drop older tool results, so while it is unknown a long Routine can only find
 * out it has overrun once the provider rejects a turn. That is why a window set
 * by hand, and an unknown one on a server you run yourself, are named on the
 * closed Advanced line (`modelAdvancedSummary`).
 *
 * Plenty of servers don't report one — plain Ollama, OpenAI's own API — so
 * "unknown" is a normal resting state. A retry is offered only when there is
 * someone to ask; otherwise an owner types the number in. The server re-asks
 * every three hours on its own, so "Ask the provider" is a shortcut, not the
 * only way back to the truth. A Member reads the number and changes nothing.
 */
export function ContextWindowPanel({
  company,
  emp,
  model,
  canManage,
  onChanged,
}: {
  company: Pick<Company, "id">;
  emp: Pick<Employee, "id">;
  model: AIModel;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(model.contextWindow ?? ""));
  const [busy, setBusy] = React.useState<null | "probe" | "save" | "clear">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}`;

  async function probe() {
    setError(null);
    setNotice(null);
    setBusy("probe");
    try {
      const updated = await api.post<AIModel>(`${base}/refresh`);
      // Neither outcome shows on its own: a probe that came back empty leaves
      // the reading at "Unknown", and one that confirms the number already
      // there re-renders it identically.
      if (!updated.contextWindow) {
        setError("The endpoint still doesn’t report a context window — set it by hand.");
      } else {
        setNotice(`Context window: ${updated.contextWindow.toLocaleString()} tokens`);
      }
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function save(next: number | null) {
    setError(null);
    setNotice(null);
    setBusy(next === null ? "clear" : "save");
    try {
      await api.put(`${base}/context-window`, { contextWindow: next });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const parsed = Number(draft.trim());
  const draftValid = /^\d+$/.test(draft.trim()) && parsed >= 1024 && parsed <= 20_000_000;

  return (
    <ModelSettingSection
      title="Context window"
      description={
        <>
          {model.contextWindow ? (
            <>
              <span className="tabular-nums text-slate-700 dark:text-slate-200">
                {model.contextWindow.toLocaleString()}
              </span>{" "}
              tokens ·{" "}
              {model.contextWindowSource === "manual" ? "set by hand" : "reported by the provider"}
            </>
          ) : (
            <>
              Unknown — Runs on this model can&apos;t budget their context, and only notice an
              over-long prompt once the provider rejects it.
            </>
          )}
          {model.contextWindowProbeable && model.contextWindowSource !== "manual" && (
            <span className="mt-0.5 block text-slate-400 dark:text-slate-500">
              Rechecked every 3 hours, so a restarted server&apos;s new limit lands on its own.
            </span>
          )}
        </>
      }
      aside={
        canManage && (
          <>
            {model.contextWindowProbeable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={probe}
                loading={busy === "probe"}
                disabled={busy !== null}
              >
                <Plug size={14} />
                Ask the provider
              </Button>
            )}
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(String(model.contextWindow ?? ""));
                  setEditing(true);
                }}
                disabled={busy !== null}
              >
                <Edit3 size={14} /> Set manually
              </Button>
            )}
            {model.contextWindowSource === "manual" && !editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => save(null)}
                loading={busy === "clear"}
                disabled={busy !== null}
              >
                <X size={14} /> Clear
              </Button>
            )}
          </>
        )
      }
    >
      {(error || notice || editing) && (
        <div className="flex flex-col gap-2">
          <FormError message={error} />
          <FormSuccess message={notice} />
          {editing && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draftValid) void save(parsed);
              }}
            >
              <div className="w-44">
                <Input
                  label="Tokens"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="65536"
                  inputMode="numeric"
                  autoFocus
                />
              </div>
              <Button
                type="submit"
                size="sm"
                loading={busy === "save"}
                disabled={busy !== null || !draftValid}
              >
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={busy !== null}
              >
                Cancel
              </Button>
              <p className="w-full text-xs text-slate-500 dark:text-slate-400">
                Whatever the server was launched with — vLLM&apos;s <code>--max-model-len</code>,
                llama.cpp&apos;s <code>-c</code>, or the model&apos;s documented limit. A number set
                here wins over anything the provider reports.
              </p>
            </form>
          )}
        </div>
      )}
    </ModelSettingSection>
  );
}
