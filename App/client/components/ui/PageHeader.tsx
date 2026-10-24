import React from "react";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { clsx } from "./clsx";

/**
 * The top of a page: where you are, what this is, and what you can do here.
 *
 *   <PageHeader
 *     breadcrumbs={[{ label: "Revenue", to: "…" }, { label: "Contacts" }]}
 *     title="Contacts"
 *     description="Everyone in the sales process, most recently touched first."
 *     actions={<Button>New contact</Button>}
 *   />
 *
 * One title size and one rhythm for every section, so moving between pages
 * never shifts where the eye lands. On a phone the actions drop below the
 * title instead of squeezing it into a column; from `sm` up they sit to its
 * right. `aside` sits beside the title itself — a status badge, a count.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  aside,
  meta,
  className,
}: {
  title: React.ReactNode;
  /** One or two quiet sentences: what this page is for. */
  description?: React.ReactNode;
  /** Buttons for this page. The primary one goes last. */
  actions?: React.ReactNode;
  breadcrumbs?: Crumb[];
  /** Beside the title: a status badge, a count. */
  aside?: React.ReactNode;
  /** Below the description: facts about the record — a schedule, an owner. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={clsx("mb-6", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="mb-3">
          <Breadcrumbs items={breadcrumbs} />
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-50">
              {title}
            </h1>
            {aside}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
              {description}
            </p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              {meta}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * A heading inside a page: a group of cards, a section of a form. Sentence
 * case, with an optional count and actions on the right.
 */
export function SectionHeader({
  title,
  description,
  actions,
  count,
  icon,
  as: Heading = "h2",
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  count?: React.ReactNode;
  icon?: React.ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={clsx("mb-3 flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <Heading className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {icon && (
            <span aria-hidden="true" className="flex shrink-0 text-slate-500 dark:text-slate-400">
              {icon}
            </span>
          )}
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined && count !== null && (
            <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
              {count}
            </span>
          )}
        </Heading>
        {description && (
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The small label above a card's content — "Assigned to", "Schedule" — in
 * sentence case at 12px rather than tracked-out capitals.
 */
export function Eyebrow({
  children,
  icon,
  className,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400",
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="flex shrink-0">
          {icon}
        </span>
      )}
      {children}
    </div>
  );
}
