import React from "react";
import { FileText, Settings2, Sparkles } from "lucide-react";
import { Outlet } from "react-router-dom";

import { ContextualLayout, SidebarLink } from "@/components/AppShell";
import type { Company } from "@/lib/api";

export type TldrsOutletContext = {
  company: Company;
};

/** Company-wide TLDR feed plus the schedule that produces it. */
export default function TldrsLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/tldrs`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Sparkles size={14} /> TLDRs
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<FileText size={14} />} label="Briefings" />
        <SidebarLink to={`${base}/settings`} icon={<Settings2 size={14} />} label="Settings" />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies TldrsOutletContext} />
    </ContextualLayout>
  );
}
