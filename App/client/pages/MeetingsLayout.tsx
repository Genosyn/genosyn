import React from "react";
import { Outlet } from "react-router-dom";
import { Bot, CalendarDays, ListVideo, Settings2, Video } from "lucide-react";
import { Company } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/meetings/*` — the calendar half of the
 * product: what is coming up, what was recorded, and who may read it.
 *
 * Mirrors `RevenueLayout`: one vertical list of section links, and children
 * read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type MeetingsOutletCtx = {
  company: Company;
};

export default function MeetingsLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/meetings`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Video size={14} /> Meetings
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<CalendarDays size={14} />} label="Agenda" />
        <SidebarLink to={`${base}/recorded`} icon={<ListVideo size={14} />} label="Recorded" />
        <SidebarLink to={`${base}/calendars`} icon={<Settings2 size={14} />} label="Calendars" />
        <SidebarLink to={`${base}/ai-access`} icon={<Bot size={14} />} label="AI access" />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies MeetingsOutletCtx} />
    </ContextualLayout>
  );
}
