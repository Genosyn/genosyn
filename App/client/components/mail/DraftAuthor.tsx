import React from "react";
import { Link } from "react-router-dom";
import { CalendarClock, HelpCircle } from "lucide-react";
import { MailDraftAuthor } from "../../lib/mail";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "../ui/Avatar";
import { clsx } from "../ui/clsx";

/**
 * Rendering for "who wrote this draft".
 *
 * Shared by the queue rows and the review drawer so the same draft never reads
 * two different ways. The unattributed case is deliberately plain: drafts that
 * predate attribution — and anything Gmail synced in — genuinely have no known
 * author, and inventing one would be worse than admitting it.
 */

export function authorName(author: MailDraftAuthor): string {
  if (author.kind === "employee") return author.employee.name;
  if (author.kind === "member") return author.member.name;
  return "Unattributed";
}

export function DraftAuthorAvatar({
  author,
  companyId,
  size = "sm",
}: {
  author: MailDraftAuthor;
  companyId: string;
  size?: "xs" | "sm" | "md";
}) {
  if (author.kind === "employee") {
    return (
      <Avatar
        name={author.employee.name}
        kind="ai"
        size={size}
        src={employeeAvatarUrl(companyId, author.employee.id, author.employee.avatarKey)}
        title={`${author.employee.name} · ${author.employee.role}`}
      />
    );
  }
  if (author.kind === "member") {
    return (
      <Avatar
        name={author.member.name}
        size={size}
        src={memberAvatarUrl(companyId, author.member.id, author.member.avatarKey)}
        title={author.member.name}
      />
    );
  }
  return (
    <span
      title="No recorded author"
      aria-label="Unattributed"
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
        size === "xs" ? "h-5 w-5" : size === "sm" ? "h-6 w-6" : "h-8 w-8",
      )}
    >
      <HelpCircle size={size === "md" ? 15 : 12} />
    </span>
  );
}

/** The routine a draft came out of — the queue's most useful grouping key. */
export function RoutineChip({ author }: { author: MailDraftAuthor }) {
  if (author.kind !== "employee" || !author.routine) return null;
  return (
    <span
      title={`Routine: ${author.routine.name}`}
      className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
    >
      <CalendarClock size={10} className="shrink-0" />
      <span className="truncate">{author.routine.name}</span>
    </span>
  );
}

/** One line of provenance for the drawer: who, from which routine, when. */
export function DraftAuthorLine({
  author,
  companyId,
  companySlug,
  createdAt,
}: {
  author: MailDraftAuthor;
  companyId: string;
  companySlug: string;
  createdAt: string | null;
}) {
  const when = createdAt ? new Date(createdAt).toLocaleString() : null;

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900/50">
      <DraftAuthorAvatar author={author} companyId={companyId} size="md" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium text-slate-900 dark:text-slate-100">
          {author.kind === "employee" ? (
            <>
              Drafted by {author.employee.name}
              <span className="font-normal text-slate-400"> · {author.employee.role}</span>
            </>
          ) : author.kind === "member" ? (
            <>Composed by {author.member.name}</>
          ) : (
            <>Unattributed draft</>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {author.kind === "employee" && author.routine ? (
            <Link
              to={`/c/${companySlug}/employees/${author.employee.slug}/routines/${author.routine.slug}`}
              className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
            >
              <CalendarClock size={11} /> {author.routine.name}
            </Link>
          ) : author.kind === "employee" ? (
            <span>Not from a routine</span>
          ) : author.kind === "none" ? (
            <span>Written before drafts recorded their author, or synced from Gmail</span>
          ) : null}
          {when && <span>{when}</span>}
        </div>
      </div>
    </div>
  );
}
