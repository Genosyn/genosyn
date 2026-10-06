import React from "react";

export type AiAccessToggleOption<L extends string> = {
  value: L;
  label: string;
  icon: React.ReactNode;
  /** Classes for the option while it is selected, so each level keeps its colour. */
  selectedClassName: string;
};

/**
 * The per-employee level control on the section "AI access" pages that give
 * every AI Employee a level (Resources, Routines): a segmented control, as a
 * radio group. The arrow keys move the selection like any other radio group,
 * and only the selected option is in the tab order. Disabled for Members who
 * can see the setting but not change it.
 */
export function AiAccessToggle<L extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  /** Accessible name of the group, e.g. "Routines access for Ada". */
  label: string;
  /** Narrowest first, the same order as the page's level cards. */
  options: AiAccessToggleOption<L>[];
  value: L;
  disabled: boolean;
  onChange: (level: L) => void;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg border border-slate-200 bg-slate-100/70 p-0.5 dark:border-slate-700 dark:bg-slate-800/60"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed " +
              (active
                ? option.selectedClassName
                : "text-slate-400 enabled:hover:text-slate-700 dark:text-slate-500 dark:enabled:hover:text-slate-200") +
              (disabled && !active ? " opacity-60" : "")
            }
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
