import React from "react";
import { AlertCircle, Check, ChevronDown, Lightbulb } from "lucide-react";
import type { ModelEffort } from "../../../shared/modelEffort";
import { effortLabel } from "../../../shared/thinkingLevels";
import type { ComposerThinking } from "../../lib/thinkingLevel";
import { Menu, MenuSeparator } from "../ui/Menu";
import { clsx } from "../ui/clsx";

/**
 * The chat composer's thinking level: a quiet button that always says the
 * level the next message runs at ("Thinking · Medium"), opening a menu of
 * every level. Default comes first, saying what it means on this AI Model;
 * levels the model cannot run, or its owners do not allow, stay listed but
 * disabled, each with the reason. When the conversation's level is moved for
 * this model, the button carries a mark and the menu says why — the level is
 * never dropped without a word.
 */
export function ThinkingLevelPicker({
  thinking,
  onChange,
}: {
  thinking: ComposerThinking;
  /** The conversation's new level; null is Default. */
  onChange: (effort: ModelEffort | null) => void;
}) {
  const noLevels = thinking.unavailableReason !== null;
  return (
    <Menu
      side="top"
      align="right"
      width={300}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={thinking.title}
          title={thinking.title}
          data-thinking-level={thinking.resolved.level ?? "default"}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-500 outline-none transition hover:border-slate-300 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-8 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
        >
          <Lightbulb size={12} aria-hidden="true" />
          <span aria-hidden="true">Thinking ·</span>
          <span aria-hidden="true" className="font-medium text-slate-700 dark:text-slate-200">
            {thinking.label}
          </span>
          {thinking.note && (
            <AlertCircle
              size={12}
              aria-hidden="true"
              className="text-amber-600 dark:text-amber-400"
            />
          )}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
    >
      {(close) => {
        const choose = (effort: ModelEffort | null) => {
          close();
          if (effort !== thinking.chosen) onChange(effort);
        };
        return (
          <div role="group" aria-label="Thinking level">
            <div className="px-2 pb-1.5 pt-1">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
                Thinking level
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                How hard the AI Model thinks before it answers. Higher levels take longer and cost
                more. It stays with this conversation.
              </p>
            </div>
            {thinking.note && (
              <p className="mx-1 mb-1 flex gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertCircle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{thinking.note}</span>
              </p>
            )}
            <LevelRow
              label="Default"
              hint={thinking.defaultRow.label}
              detail={thinking.defaultRow.detail}
              active={thinking.chosen === null}
              onSelect={() => choose(null)}
            />
            <MenuSeparator />
            {noLevels && (
              <p className="px-2 pb-1 text-xs text-slate-500 dark:text-slate-400">
                {thinking.unavailableReason}
              </p>
            )}
            {thinking.options.map((option) => (
              <LevelRow
                key={option.level}
                label={effortLabel(option.level)}
                active={thinking.chosen === option.level}
                disabled={!option.available}
                // A model with no levels says why once, above, not on every row.
                detail={noLevels ? null : option.reason}
                onSelect={() => choose(option.level)}
              />
            ))}
          </div>
        );
      }}
    </Menu>
  );
}

/** One level in the menu: its name, a check when chosen, and why it is unavailable. */
function LevelRow({
  label,
  hint,
  detail,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  hint?: string;
  detail?: string | null;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="menuitemradio"
      type="button"
      aria-checked={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        disabled
          ? "cursor-not-allowed text-slate-400 dark:text-slate-500"
          : active
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
      )}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {active && <Check size={14} aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span>{label}</span>
          {hint && <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
        </span>
        {detail && (
          <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{detail}</span>
        )}
      </span>
    </button>
  );
}
