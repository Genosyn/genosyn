import { KeyRound, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { AccessBulkAction } from "@/lib/employeeAccess";
import { Button } from "@/components/ui/Button";

/**
 * The floating bar for a selection on the Access page, the way the Decision
 * stack draws its own: how many are ticked, and the three things a bulk change
 * can do. Each opens a confirmation that says, kind by kind, what will happen.
 */
export function AccessBulkBar({
  count,
  onAction,
  onClear,
}: {
  count: number;
  onAction: (action: AccessBulkAction) => void;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 sm:bottom-6 sm:px-4">
      <div
        role="toolbar"
        aria-label="Selected items"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full border border-slate-200 bg-white/95 px-1.5 py-1.5 shadow-lg backdrop-blur sm:gap-1 sm:px-3 sm:py-2 dark:border-slate-700 dark:bg-slate-900/95"
      >
        <span className="whitespace-nowrap px-1.5 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {count} selected
        </span>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-slate-200 sm:mx-1 dark:bg-slate-700" />
        <Button size="sm" variant="ghost" onClick={() => onAction("grant")}>
          {/* A phone keeps the words and drops the icons, so the bar fits. */}
          <KeyRound size={14} className="hidden sm:block" aria-hidden="true" /> Grant
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAction("set_level")}>
          <SlidersHorizontal size={14} className="hidden sm:block" aria-hidden="true" />
          <span className="sm:hidden">Level</span>
          <span className="hidden sm:inline">Change level</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAction("revoke")}>
          <Trash2 size={14} className="hidden sm:block" aria-hidden="true" /> Revoke
        </Button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection"
          className="ml-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
