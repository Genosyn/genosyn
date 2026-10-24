import { ChevronRight, ScrollText, X } from "lucide-react";
import { Link } from "react-router-dom";

import { LetterBadgePill } from "@/components/boardLetters/LetterBadgePill";
import type { BoardLetterSummary, Company } from "@/lib/api";
import { letterStatusBadge, traceBadge } from "@/lib/boardLetters";
import { canOpenSubpage, subpageAt } from "@/lib/subpages";

/** Whether {@link BoardLetterCard} shows anything. Home's all-clear asks the same. */
export function showsBoardLetter(
  company: Company,
  letter: BoardLetterSummary | null | undefined,
): letter is BoardLetterSummary {
  return Boolean(letter) && canOpenSubpage(subpageAt("/tldrs/letters"), company);
}

/**
 * The newest letter to the board this owner or admin has not read.
 *
 * It sits above the latest TLDR: both are context rather than an interruption,
 * and a letter comes once a month, to the board alone. The server sends one
 * only to owners and admins, and the card checks the Letters page's own access
 * too, so it never offers a Member a link they could not open. Opening the
 * letter, from here or anywhere else, or pressing Dismiss takes it off this
 * person's Home and nobody else's.
 */
export function BoardLetterCard({
  company,
  letter,
  unreadCount,
  onDismiss,
}: {
  company: Company;
  letter: BoardLetterSummary | null;
  /** Letters this person has not read, the one shown included. */
  unreadCount: number;
  onDismiss: (letter: BoardLetterSummary) => void;
}) {
  if (!showsBoardLetter(company, letter)) return null;
  const letters = `/c/${company.slug}/tldrs/letters`;
  const href = `${letters}/${letter.number}`;
  const status = letterStatusBadge(letter);
  const trace = traceBadge(letter);
  const more = Math.max(0, unreadCount - 1);
  // The auditor is named only once it has given an opinion. A letter nobody
  // audited says so in its badge and never reads as audited here.
  const audited = letter.auditStatus === "clean" || letter.auditStatus === "exceptions";
  const writer = letter.writer.name || "A former AI Employee";

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300">
          <ScrollText size={15} />
        </span>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Letter to the board
        </h2>
        <span className="inline-flex h-5 items-center rounded-full bg-slate-100 px-2 text-xs font-medium tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {unreadCount}
        </span>
        <Link
          to={letters}
          className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          All letters <ChevronRight size={12} />
        </Link>
      </div>

      <article className="flex items-start gap-3 px-4 py-4 sm:gap-4 sm:px-5">
        <div className="w-10 shrink-0 text-center sm:w-12">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            No.
          </div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-100">
            {letter.number}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <Link
                to={href}
                className="font-medium text-slate-900 hover:text-indigo-700 dark:text-slate-100 dark:hover:text-indigo-300"
              >
                {letter.monthLabel}
              </Link>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <LetterBadgePill badge={status} />
                {trace && <LetterBadgePill badge={trace} />}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(letter)}
              className="-mr-1 inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label={`Dismiss Letter No. ${letter.number}`}
            >
              <X size={13} /> Dismiss
            </button>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
            {letter.summary || `The letter for ${letter.monthLabel} is ready to read.`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-slate-500 dark:text-slate-400">
              {writer}
              {audited && letter.auditor ? ` · audited by ${letter.auditor.name}` : ""}
            </span>
            <Link
              to={href}
              className="inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Read the letter <ChevronRight size={12} />
            </Link>
          </div>
        </div>
      </article>

      {more > 0 && (
        <Link
          to={letters}
          className="block border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-center text-xs font-medium text-indigo-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 dark:text-indigo-400 dark:hover:bg-slate-900"
        >
          {more} more unread {more === 1 ? "letter" : "letters"}
        </Link>
      )}
    </section>
  );
}
