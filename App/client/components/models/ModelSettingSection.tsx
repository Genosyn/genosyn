import React from "react";

/**
 * One setting inside a model card's Advanced section: its name, a line on what
 * it is or how it stands, and its controls. Sections stack with a hairline
 * between them, so the Advanced section reads as one list rather than boxes
 * inside boxes. Each is a labelled region, so the settings can be reached by
 * name.
 */
export function ModelSettingSection({
  title,
  description,
  aside,
  headingId,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Controls beside the title — a button or a picker. */
  aside?: React.ReactNode;
  /** A stable id for the heading, when something else points at it. */
  headingId?: string;
  children?: React.ReactNode;
}) {
  const generated = React.useId();
  const id = headingId ?? generated;
  return (
    <section aria-labelledby={id} className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h4 id={id} className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {title}
          </h4>
          {description && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</div>
          )}
        </div>
        {aside && (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1">{aside}</div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

/** The settings of one Advanced section, one under another. */
export function ModelSettingList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-slate-100 dark:divide-slate-800">{children}</div>;
}
