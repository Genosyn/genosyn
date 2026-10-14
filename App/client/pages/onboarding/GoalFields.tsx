import React from "react";
import type { GoalDirection } from "@/lib/api";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { submitFormOnModEnter } from "@/lib/keyboard";
import {
  GOAL_TITLE_MAX,
  GOAL_UNIT_MAX,
  syncGoalDetails,
  type GoalDetailsEdited,
  type GoalDraft,
} from "@/lib/goalSentence";

/**
 * The company's first Goal as the setup guide asks for it: one sentence, and
 * the number in it. Both screens that ask for it (the new-company form and the
 * guide's Company step) draw the same fields, so they live here.
 */

const EMPTY_DRAFT: GoalDraft = { sentence: "", target: "", direction: "increase_to", unit: "" };

const DIRECTION_LABEL: Record<GoalDirection, string> = {
  increase_to: "Increase to target",
  decrease_to: "Decrease to target",
};

/**
 * The Goal being written. The target, direction and unit follow the sentence
 * as it is typed, until the person changes one of them: from then on that one
 * keeps their value.
 */
export function useGoalDraft() {
  const [draft, setDraft] = React.useState<GoalDraft>(EMPTY_DRAFT);
  const edited = React.useRef<GoalDetailsEdited>({});

  const setSentence = React.useCallback((sentence: string) => {
    setDraft((current) => ({ sentence, ...syncGoalDetails(sentence, current, edited.current) }));
  }, []);
  const setTarget = React.useCallback((target: string) => {
    // Emptying a box hands it back to the sentence rather than pinning a blank.
    edited.current = { ...edited.current, target: target.trim() !== "" };
    setDraft((current) => ({ ...current, target }));
  }, []);
  const setDirection = React.useCallback((direction: GoalDirection) => {
    edited.current = { ...edited.current, direction: true };
    setDraft((current) => ({ ...current, direction }));
  }, []);
  const setUnit = React.useCallback((unit: string) => {
    edited.current = { ...edited.current, unit: unit.trim() !== "" };
    setDraft((current) => ({ ...current, unit }));
  }, []);

  return { draft, setSentence, setTarget, setDirection, setUnit };
}

export type GoalDraftControls = ReturnType<typeof useGoalDraft>;

export function GoalFields({
  goal,
  disabled,
  autoFocus,
  optional = false,
  compact = false,
}: {
  goal: GoalDraftControls;
  disabled?: boolean;
  autoFocus?: boolean;
  /** A company that already has direction may leave the sentence blank. */
  optional?: boolean;
  /** For the narrow new-company card: the target and unit share a row, the direction takes its own. */
  compact?: boolean;
}) {
  const { draft } = goal;
  const hintId = React.useId();
  const targetField = (
    <Input
      label="Target"
      value={draft.target}
      onChange={(event) => goal.setTarget(event.target.value)}
      inputMode="decimal"
      placeholder="50"
      disabled={disabled}
      aria-required="true"
    />
  );
  const directionField = (
    <Select
      label="Direction"
      value={draft.direction}
      onChange={(event) => goal.setDirection(event.target.value as GoalDirection)}
      disabled={disabled}
      containerClassName={compact ? "col-span-2" : undefined}
    >
      {(Object.keys(DIRECTION_LABEL) as GoalDirection[]).map((direction) => (
        <option key={direction} value={direction}>
          {DIRECTION_LABEL[direction]}
        </option>
      ))}
    </Select>
  );
  const unitField = (
    <Input
      label="Unit"
      value={draft.unit}
      onChange={(event) => goal.setUnit(event.target.value)}
      placeholder="customers, $, %…"
      maxLength={GOAL_UNIT_MAX}
      disabled={disabled}
    />
  );
  return (
    <div className="space-y-3">
      <div>
        <Input
          label="Your Goal"
          value={draft.sentence}
          onChange={(event) => goal.setSentence(event.target.value)}
          placeholder="Reach 50 paying customers by March"
          maxLength={GOAL_TITLE_MAX}
          aria-describedby={hintId}
          autoFocus={autoFocus}
          disabled={disabled}
          required={!optional}
        />
        <p id={hintId} className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          One sentence with a number in it. Every AI Employee reads it before they work.
        </p>
      </div>
      {draft.sentence.trim() !== "" && (
        <div className="space-y-1.5">
          <div
            className={clsx(
              "grid gap-3",
              compact ? "grid-cols-2" : "sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]",
            )}
          >
            {targetField}
            {compact ? unitField : directionField}
            {compact ? directionField : unitField}
          </div>
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            We read these from your sentence. Change any that look wrong.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Mission and vision, for a company that wants to say more. Behind a closed
 * disclosure: the Goal is what a company must write, and these only sharpen
 * the work suggested for it.
 */
export function MissionVisionFields({
  mission,
  vision,
  onMission,
  onVision,
  disabled,
  defaultOpen = false,
}: {
  mission: string;
  vision: string;
  onMission: (value: string) => void;
  onVision: (value: string) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40"
    >
      <summary className="cursor-pointer select-none text-sm font-medium text-slate-700 dark:text-slate-200">
        Add a mission and vision (optional)
      </summary>
      <div className="mt-3 space-y-3">
        <Textarea
          label="Mission"
          value={mission}
          onChange={(event) => onMission(event.target.value)}
          onKeyDown={submitFormOnModEnter}
          placeholder="What do you do, for whom, and why?"
          rows={3}
          className="!min-h-24"
          maxLength={2000}
          disabled={disabled}
        />
        <Textarea
          label="Vision"
          value={vision}
          onChange={(event) => onVision(event.target.value)}
          onKeyDown={submitFormOnModEnter}
          placeholder="What should be true when the company succeeds?"
          rows={3}
          className="!min-h-24"
          maxLength={2000}
          disabled={disabled}
        />
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          They help us suggest fitting work. Add them any time in Settings → Company.
        </p>
      </div>
    </details>
  );
}
