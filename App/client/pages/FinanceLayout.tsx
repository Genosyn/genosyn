import React from "react";
import { Outlet } from "react-router-dom";
import { Wallet } from "lucide-react";
import { Company } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { SectionRailLinks } from "../components/SectionRail";

/**
 * Sidebar + layout for `/c/:slug/finance/*`. Phase A of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Sub-nav mirrors the Settings layout: a vertical list of section links,
 * drawn from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette also
 * searches — add a Finance page there, not here.
 * Children read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type FinanceOutletCtx = {
  company: Company;
};

export default function FinanceLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Wallet size={14} /> Finance
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="finance" companySlug={company.slug} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies FinanceOutletCtx} />
    </ContextualLayout>
  );
}
