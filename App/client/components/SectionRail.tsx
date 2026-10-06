import React from "react";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections";
import { canOpenSubpage, railSubpages, type SubpageViewer } from "../lib/subpages";
import { SidebarLink } from "./AppShell";
import { clsx } from "./ui/clsx";

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
 */
export function SectionRailLinks({
  section,
  companySlug,
  viewer,
  continued = false,
}: {
  section: SectionKey;
  companySlug: string;
  viewer?: SubpageViewer;
  continued?: boolean;
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
                  "text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500",
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
              label={page.navLabel ?? page.label}
            />
          </React.Fragment>
        );
      })}
    </>
  );
}
