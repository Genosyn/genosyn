import React from "react";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections";
import { canOpenSubpage, railSubpages, type SubpageViewer } from "../lib/subpages";
import { SidebarLink } from "./AppShell";
import { CountBadge } from "./ui/Badge";
import { clsx } from "./ui/clsx";

/** A group heading inside a rail — "Folders", "Assigned to" — in sentence case. */
export const railHeadingClassName = "text-xs font-medium text-slate-500 dark:text-slate-400";

/**
 * A section rail's page links, drawn from the subpage catalogue in
 * `lib/subpages.ts` — the list the ⌘K palette searches — so a page added to a
 * rail is findable from the palette by construction.
 *
 * Only the links: each layout keeps its own header, footer, and `<nav>`.
 * `continued` is for a rail that draws its own links above these (Email's
 * folders), so the first group heading gets the spacing of a later one.
 *
 * `viewer` (the current `Company`, which carries the role and finance access)
 * leaves out the pages that person can't open, by the rule the palette uses
 * (`canOpenSubpage`), so a Member is never offered a link that can only
 * answer 403. A group left with no links loses its heading as well. Without a
 * viewer every page is drawn.
 *
 * `counts`, keyed by a page's catalogued path, puts a number beside that link
 * — how much waits there — and draws nothing for zero or an unknown count.
 */
export function SectionRailLinks({
  section,
  companySlug,
  viewer,
  continued = false,
  counts,
}: {
  section: SectionKey;
  companySlug: string;
  viewer?: SubpageViewer;
  continued?: boolean;
  counts?: Readonly<Record<string, number | null | undefined>>;
}) {
  const sectionPath = SECTION_BY_KEY[section].path;
  const pages = railSubpages(section).filter((page) => !viewer || canOpenSubpage(page, viewer));
  let group: string | undefined;
  return (
    <>
      {pages.map((page, index) => {
        const heading = page.navGroup && page.navGroup !== group ? page.navGroup : null;
        group = page.navGroup;
        const Icon = page.icon;
        return (
          <React.Fragment key={page.id}>
            {heading && (
              <div
                className={clsx(
                  "px-2 pb-1",
                  index === 0 && !continued ? "pt-2" : "pt-3",
                  "text-xs font-medium text-slate-500 dark:text-slate-400",
                )}
              >
                {heading}
              </div>
            )}
            <SidebarLink
              to={`/c/${companySlug}${page.path}`}
              // The section's landing page would otherwise stay highlighted
              // on every page beneath it.
              end={page.path === sectionPath}
              icon={<Icon size={14} />}
              label={
                <RailLabel text={page.navLabel ?? page.label} count={counts?.[page.path]} />
              }
            />
          </React.Fragment>
        );
      })}
    </>
  );
}

function RailLabel({ text, count }: { text: string; count: number | null | undefined }) {
  if (!count) return <>{text}</>;
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="truncate">{text}</span>
      <CountBadge count={count} aria-label={`${count} waiting`} />
    </span>
  );
}

/**
 * The top of a section's rail: the section's icon tile and name, as the top
 * nav's section pill draws them, with room for the rail's own actions (a "New"
 * button, a folder button) on the right.
 */
export function SectionRailHeader({
  section,
  label,
  actions,
}: {
  section: SectionKey;
  /** Defaults to the section's own name. */
  label?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const item = SECTION_BY_KEY[section];
  const Icon = item.icon;
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3 dark:border-slate-800">
      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
        <span
          aria-hidden="true"
          className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", item.iconBg)}
        >
          <Icon size={14} />
        </span>
        <span className="truncate">{label ?? item.label}</span>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/** A small icon button for a rail header — "New folder", "New routine". */
export function RailIconButton({
  label,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={clsx(
        "flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
        className,
      )}
    >
      {children}
    </button>
  );
}
