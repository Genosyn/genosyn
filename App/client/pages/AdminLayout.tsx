import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Activity, Archive, LayoutDashboard, ServerCog } from "lucide-react";
import { Company, Me } from "../lib/api";
import { Breadcrumbs, ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/admin/*`. The Admin section holds surfaces that
 * describe the whole deployment rather than a single company — the instance
 * health dashboard and install-wide backups. It mirrors the company Settings
 * section so the two feel consistent, but its pages are deliberately system-
 * wide. Child routes read `company` (for URL context) and `me` from Outlet
 * context; the health + backup data itself is not company-scoped.
 */

export type AdminOutletCtx = {
  company: Company;
  me: Me;
};

const ADMIN_TAB_LABEL: Record<string, string> = {
  overview: "Overview",
  "instance-health": "Instance Health",
  backup: "Backups",
};

export default function AdminLayout({
  company,
  me,
}: {
  company: Company;
  me: Me;
}) {
  const location = useLocation();
  const base = `/c/${company.slug}/admin`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <ServerCog size={14} /> Admin
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Instance
        </div>
        <SidebarLink
          to={`${base}/overview`}
          icon={<LayoutDashboard size={14} />}
          label="Overview"
        />
        <SidebarLink
          to={`${base}/instance-health`}
          icon={<Activity size={14} />}
          label="Instance Health"
        />
        <SidebarLink to={`${base}/backup`} icon={<Archive size={14} />} label="Backups" />
      </nav>
    </div>
  );

  const afterBase = location.pathname.startsWith(base)
    ? location.pathname.slice(base.length).replace(/^\/+/, "")
    : "";
  const segments = afterBase ? afterBase.split("/").filter(Boolean) : [];
  const tabCrumbs: { label: string; to?: string }[] = [];
  let acc = base;
  segments.forEach((seg, i) => {
    acc = `${acc}/${seg}`;
    const label = ADMIN_TAB_LABEL[seg];
    if (!label) return;
    const isLast = i === segments.length - 1;
    tabCrumbs.push({ label, to: isLast ? undefined : acc });
  });

  return (
    <ContextualLayout sidebar={sidebar}>
      <div className="mx-auto max-w-4xl p-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[
              { label: "Admin", to: tabCrumbs.length ? `${base}/overview` : undefined },
              ...tabCrumbs,
            ]}
          />
        </div>
        <Outlet context={{ company, me } satisfies AdminOutletCtx} />
      </div>
    </ContextualLayout>
  );
}
