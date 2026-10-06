import React from "react";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections";
import { railSubpages } from "../lib/subpages";
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
 */
export function SectionRailLinks({
  section,
  companySlug,
  continued = false,
}: {
  section: SectionKey;
  companySlug: string;
  continued?: boolean;
}) {
  const sectionPath = SECTION_BY_KEY[section].path;
  let group: string | undefined;
  return (
    <>
      {railSubpages(section).map((page, index) => {
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
