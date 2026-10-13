import { ChevronDown, CircleSlash, Clock3, X } from "lucide-react";
import type { DecisionSnoozeDuration } from "@/lib/api";
import { SNOOZE_OPTIONS } from "@/components/decisions/DecisionCard";
import { Button } from "@/components/ui/Button";
import { Menu, MenuHeader, MenuItem } from "@/components/ui/Menu";
import { clsx } from "@/components/ui/clsx";

/**
 * The floating bar for a selection on the Decision stack. Its verbs only take
 * rows off without acting on them — Dismiss (a Decision is dismissed, an
 * email discarded, a work plan declined) and Snooze (Decisions only). There
 * is no bulk answer, Send now or Approve & start: each of those is a gate a
 * person passes one row at a time.
 */
export function StackBulkBar({
  count,
  canSnooze,
  busy,
  onDismiss,
  onSnooze,
  onClear,
}: {
  count: number;
  /** Only Decisions snooze; a selection holding a review cannot. */
  canSnooze: boolean;
  busy: "dismiss" | "snooze" | null;
  onDismiss: () => void;
  onSnooze: (duration: DecisionSnoozeDuration, label: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected items"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full border border-slate-200 bg-white/95 px-1.5 py-2 shadow-lg backdrop-blur sm:gap-1 sm:px-3 dark:border-slate-700 dark:bg-slate-900/95"
      >
        <span className="whitespace-nowrap px-1 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {count} selected
        </span>
        <span
          aria-hidden="true"
          className="mx-0.5 h-4 w-px shrink-0 bg-slate-200 sm:mx-1 dark:bg-slate-700"
        />
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "dismiss"}
          disabled={busy !== null}
          onClick={onDismiss}
          title="Take the selected items off the stack without acting on them. Decisions are dismissed, emails discarded and work plans declined."
        >
          {/* A phone keeps the words and drops the icons, so the bar fits. */}
          <CircleSlash size={14} className="hidden sm:block" /> Dismiss
        </Button>
        <Menu
          align="right"
          side="top"
          width={200}
          trigger={({ ref, onClick, open }) => (
            <Button
              ref={ref}
              type="button"
              size="sm"
              variant="ghost"
              loading={busy === "snooze"}
              disabled={busy !== null || !canSnooze}
              onClick={onClick}
              aria-haspopup="menu"
              aria-expanded={open}
              title={
                canSnooze
                  ? undefined
                  : "Only Decisions can be snoozed. Email and work reviews can be dismissed."
              }
            >
              <Clock3 size={14} className="hidden sm:block" />
              Snooze
              <ChevronDown
                size={13}
                className={clsx("hidden transition-transform sm:block", open && "rotate-180")}
              />
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuHeader>Snooze for</MenuHeader>
              {SNOOZE_OPTIONS.map((option) => (
                <MenuItem
                  key={option.duration}
                  label={option.label}
                  onSelect={() => {
                    close();
                    onSnooze(option.duration, option.label);
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        <button
          type="button"
          onClick={onClear}
          disabled={busy !== null}
          aria-label="Clear selection"
          title="Clear selection"
          className="ml-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
