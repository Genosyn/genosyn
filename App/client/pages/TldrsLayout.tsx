import React from "react";
import { Sparkles } from "lucide-react";
import { Outlet } from "react-router-dom";

import { ContextualLayout } from "@/components/AppShell";
import { SectionRailLinks } from "@/components/SectionRail";
import type { Company } from "@/lib/api";

export type TldrsOutletContext = {
  company: Company;
};

/**
 * Company-wide TLDR feed plus the schedule that produces it. Rail links come
 * from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches.
 */
export default function TldrsLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Sparkles size={14} /> TLDRs
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="tldrs" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies TldrsOutletContext} />
    </ContextualLayout>
  );
}
