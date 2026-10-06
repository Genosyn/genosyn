import React from "react";
import { Outlet } from "react-router-dom";
import { Megaphone } from "lucide-react";

import { ContextualLayout } from "../components/AppShell";
import { SectionRailLinks } from "../components/SectionRail";
import type { Company } from "../lib/api";

export type MarketingOutletCtx = { company: Company };

/** Rail links come from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches. */
export default function MarketingLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Megaphone size={14} /> Marketing
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="marketing" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies MarketingOutletCtx} />
    </ContextualLayout>
  );
}
