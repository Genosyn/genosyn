import React from "react";
import { Outlet } from "react-router-dom";
import {
  Ban,
  BarChart3,
  Bot,
  Contact2,
  Radar,
  Send,
  Target,
  TrendingUp,
} from "lucide-react";
import { Company } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/revenue/*` — the go-to-market half of the
 * product: the deal board, the people on those deals, the sequences that reach
 * them, and the reports that say whether any of it worked.
 *
 * Structure mirrors `CustomersLayout` / `FinanceLayout`: one vertical list of
 * section links, and children read `company` from Outlet context so each page
 * can build `/api/companies/:cid/...` URLs without re-deriving it from the
 * route.
 */

export type RevenueOutletCtx = {
  company: Company;
};

export default function RevenueLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/revenue`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <TrendingUp size={14} /> Revenue
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<BarChart3 size={14} />} label="Insights" />
        <SidebarLink to={`${base}/deals`} icon={<Target size={14} />} label="Deals" />
        <SidebarLink to={`${base}/contacts`} icon={<Contact2 size={14} />} label="Contacts" />
        <SidebarLink to={`${base}/sequences`} icon={<Send size={14} />} label="Sequences" />
        <SidebarLink to={`${base}/signals`} icon={<Radar size={14} />} label="Signals" />
        <SidebarLink
          to={`${base}/suppressions`}
          icon={<Ban size={14} />}
          label="Suppressions"
        />
        <SidebarLink to={`${base}/ai-access`} icon={<Bot size={14} />} label="AI access" />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies RevenueOutletCtx} />
    </ContextualLayout>
  );
}
