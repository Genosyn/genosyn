import React from "react";
import { ChevronRight } from "lucide-react";
import { useLocation } from "react-router-dom";
import { SECTION_BY_KEY, type SectionKey } from "../lib/sections";
import {
  canOpenSubpage,
  isAdvancedRailPage,
  onRailPage,
  railSubpages,
  type SubpageItem,
  type SubpageViewer,
} from "../lib/subpages";
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
 *
 * Pages catalogued in the Advanced group (`ADVANCED_NAV_GROUP`) are drawn last
 * under one toggle that starts closed — the rail stays a short list of what
 * people come for — and opens by itself while you are on one of its pages, so
 * a deep link never lands somewhere the rail pretends not to have. Its tooltip
 * names what is inside.
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
  const { pathname } = useLocation();
  const sectionPath = SECTION_BY_KEY[section].path;
  const pages = railSubpages(section).filter((page) => !viewer || canOpenSubpage(page, viewer));
  const everyday = pages.filter((page) => !isAdvancedRailPage(page));
  const advanced = pages.filter(isAdvancedRailPage);

  const link = (page: SubpageItem) => {
    const Icon = page.icon;
    return (
      <SidebarLink
        key={page.id}
        to={`/c/${companySlug}${page.path}`}
        // The section's landing page would otherwise stay highlighted
        // on every page beneath it.
        end={page.path === sectionPath}
        icon={<Icon size={14} />}
        label={<RailLabel text={page.navLabel ?? page.label} count={counts?.[page.path]} />}
      />
    );
  };

  let group: string | undefined;
  return (
    <>
      {everyday.map((page, index) => {
        const heading = page.navGroup && page.navGroup !== group ? page.navGroup : null;
        group = page.navGroup;
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
            {link(page)}
          </React.Fragment>
        );
      })}
      {advanced.length > 0 && (
        <RailAdvancedGroup
          names={advanced.map((page) => page.navLabel ?? page.label)}
          here={onRailPage(advanced, companySlug, pathname)}
          first={everyday.length === 0 && !continued}
        >
          {advanced.map(link)}
        </RailAdvancedGroup>
      )}
    </>
  );
}

/**
 * The closed Advanced toggle and the links under it — shared by the catalogued
 * rails above and the hand-written Admin rail. Open state is the rail's own:
 * it opens when the route enters the group (adjusted during render, so the
 * active link is there on the first paint) and otherwise stays however it was
 * left while you move around the section.
 */
export function RailAdvancedGroup({
  names,
  here,
  first = false,
  children,
}: {
  /** The pages inside, which the toggle's tooltip names. */
  names: string[];
  /** The page you are on is one of these. */
  here: boolean;
  /** Nothing is drawn above it, so it takes the rail's opening spacing. */
  first?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(here);
  const [wasHere, setWasHere] = React.useState(here);
  if (here !== wasHere) {
    setWasHere(here);
    if (here) setOpen(true);
  }
  const listId = React.useId();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={names.join(", ")}
        data-rail-advanced=""
        className={clsx(
          "flex w-full items-center gap-1 rounded-md px-2 pb-1 text-left",
          first ? "pt-2" : "pt-3",
          "text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40",
          "dark:text-slate-500 dark:hover:text-slate-300",
        )}
      >
        Advanced
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={clsx("shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && <div id={listId}>{children}</div>}
    </>
  );
}

function RailLabel({ text, count }: { text: string; count: number | null | undefined }) {
  if (!count) return <>{text}</>;
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="truncate">{text}</span>
      <span
        className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        aria-label={`${count} waiting`}
      >
        {count}
      </span>
    </span>
  );
}
