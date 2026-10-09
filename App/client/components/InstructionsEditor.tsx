import React from "react";
import { RotateCcw } from "lucide-react";

import { errorMessage } from "../lib/errors";
import type { InstructionsEditState } from "../lib/instructionsEdit";
import { Button } from "./ui/Button";
import { clsx } from "./ui/clsx";
import { FormError } from "./ui/FormError";
import { Textarea } from "./ui/Textarea";

/** What a save answers with: the text the box should now show. */
export type InstructionsSaveResult = { instructions: string; usingDefault: boolean };

/**
 * An instructions box: free text, one instruction per line, that an AI
 * Employee follows on its own — a mailbox's AI analysis instructions and the
 * Decision stack's. Free text on purpose — people say what they want in their
 * own words — with the default already in it, so the first thing anyone sees
 * is a working example rather than an empty field.
 *
 * Every box behaves the same way: a **Default** pill while it follows the
 * default, **Save instructions** (also ⌘/Ctrl+Enter) only once something
 * really changed, **Cancel** to drop an edit, **Restore default** once the
 * saved text is the owner's own, problems inline beside the box and never in
 * a toast, and `loading` on the button that was pressed. What each feature
 * says about its box — the line under the label, the hint under the field,
 * the count for an emptied box — comes from its caller.
 */
export function InstructionsEditor({
  saved,
  usingDefault,
  edit: computeEdit,
  onSave,
  onSaved,
  description,
  hint,
  placeholder,
  maxLength,
  label = "Instructions",
  rows = 4,
  busyElsewhere = false,
  readOnly = false,
  readOnlyNote,
  saveErrorFallback = "Couldn’t save the instructions",
  restoreErrorFallback = "Couldn’t restore the default instructions",
  className = "mt-5 border-t border-slate-100 pt-4 dark:border-slate-800",
}: {
  /** The text the box follows now: the owner's own, or the default. */
  saved: string;
  usingDefault: boolean;
  /** The feature's rules for the box (`lib/instructionsEdit.ts`). */
  edit: (args: { draft: string; saved: string; usingDefault: boolean }) => InstructionsEditState;
  /** Store the typed text, or `null` to restore the default. Throws to refuse. */
  onSave: (instructions: string | null) => Promise<InstructionsSaveResult>;
  onSaved?: (result: InstructionsSaveResult) => void;
  /** One line under the label: what the instructions are for. */
  description: React.ReactNode;
  /** Under the field: everything that can happen because of them. */
  hint: React.ReactNode;
  placeholder: string;
  maxLength: number;
  label?: string;
  rows?: number;
  /** Another control on the same card is saving; wait for it. */
  busyElsewhere?: boolean;
  /** Shown but not editable — a viewer who may read the instructions only. */
  readOnly?: boolean;
  /** Why a read-only box cannot be edited, shown where the buttons would be. */
  readOnlyNote?: React.ReactNode;
  saveErrorFallback?: string;
  restoreErrorFallback?: string;
  className?: string;
}) {
  const [draft, setDraft] = React.useState(saved);
  const [busy, setBusy] = React.useState<"save" | "restore" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fieldId = React.useId();
  const hintId = React.useId();

  // A save (or Restore default, or another person's change) hands down new
  // text; show it. Edits typed since are the person's, so only a change in
  // what was saved replaces them.
  const lastSaved = React.useRef(saved);
  React.useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setDraft(saved);
  }, [saved]);

  const edit = computeEdit({ draft, saved, usingDefault });

  const submit = async (instructions: string | null, kind: "save" | "restore") => {
    if (readOnly || busy || busyElsewhere) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await onSave(instructions);
      lastSaved.current = result.instructions;
      setDraft(result.instructions);
      onSaved?.(result);
    } catch (err) {
      setError(errorMessage(err, kind === "restore" ? restoreErrorFallback : saveErrorFallback));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className={className}
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
          {label}
        </label>
        {usingDefault && !edit.dirty && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            Default
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
      <div className="mt-2">
        <Textarea
          id={fieldId}
          aria-describedby={hintId}
          value={draft}
          rows={rows}
          maxLength={maxLength}
          spellCheck
          readOnly={readOnly}
          disabled={busy !== null}
          className={clsx("min-h-[104px] leading-6", readOnly && "bg-slate-50 dark:bg-slate-900/60")}
          placeholder={placeholder}
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
        {hint}
      </p>
      <FormError message={error ?? (edit.dirty ? edit.problem : null)} className="mt-2" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {readOnly ? (
          readOnlyNote && (
            <span className="text-xs text-slate-500 dark:text-slate-400">{readOnlyNote}</span>
          )
        ) : (
          <>
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
          </>
        )}
        <span className="text-xs text-slate-400 sm:ml-auto dark:text-slate-500">
          {edit.countLabel}
        </span>
      </div>
    </form>
  );
}
