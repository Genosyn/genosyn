import React from "react";
import { Outlet } from "react-router-dom";
import {
  BarChart3,
  Bot,
  Cable,
  FlaskConical,
  Images,
  Megaphone,
  Target,
} from "lucide-react";

import { ContextualLayout, SidebarLink } from "../components/AppShell";
import type { Company } from "../lib/api";

export type MarketingOutletCtx = { company: Company };

export default function MarketingLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/marketing`;
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Megaphone size={14} /> Marketing
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<BarChart3 size={14} />} label="Overview" />
        <SidebarLink to={`${base}/campaigns`} icon={<Target size={14} />} label="Campaigns" />
        <SidebarLink to={`${base}/creative`} icon={<Images size={14} />} label="Creative" />
        <SidebarLink
          to={`${base}/experiments`}
          icon={<FlaskConical size={14} />}
          label="Experiments"
        />
        <SidebarLink to={`${base}/ai-access`} icon={<Bot size={14} />} label="AI access" />
        <SidebarLink
          to={`${base}/integrations`}
          icon={<Cable size={14} />}
          label="Connections"
        />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies MarketingOutletCtx} />
    </ContextualLayout>
  );
}
