import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import type { LetterBadge } from "@/lib/boardLetters";

const TONE_CLASS: Record<LetterBadge["tone"], string> = {
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  warn: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
  bad: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
  neutral: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  working: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
};

/** One of a letter's badges (`lib/boardLetters.ts`), on the Letters pages and on Home. */
export function LetterBadgePill({ badge }: { badge: LetterBadge }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE_CLASS[badge.tone],
      )}
    >
      {badge.tone === "working" && <Spinner size={10} />}
      {badge.label}
    </span>
  );
}
