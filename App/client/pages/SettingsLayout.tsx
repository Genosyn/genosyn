import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import {
  BarChart3,
  Building2,
  KeyRound,
  ScrollText,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import { Company } from "../lib/api";
import { Breadcrumbs, ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/settings/*`. Mirrors EmployeesLayout /
 * TasksLayout / BasesLayout so the company-level settings section feels
 * consistent with the rest of the app. Child routes read `company` and the
 * companies-changed callback from Outlet context.
 */

export type SettingsOutletCtx = {
  company: Company;
  onCompaniesChanged: () => void;
};

const SETTINGS_TAB_LABEL: Record<string, string> = {
  company: "Company",
  members: "Members",
  secrets: "Secrets",
  usage: "Usage",
  audit: "Audit log",
};

export default function SettingsLayout({
  company,
  onCompaniesChanged,
}: {
  company: Company;
  onCompaniesChanged: () => void;
}) {
  const location = useLocation();
  const base = `/c/${company.slug}/settings`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <SettingsIcon size={14} /> Settings
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={`${base}/company`} icon={<Building2 size={14} />} label="Company" />
        <SidebarLink to={`${base}/members`} icon={<Users size={14} />} label="Members" />
        <SidebarLink to={`${base}/secrets`} icon={<KeyRound size={14} />} label="Secrets" />
        <SidebarLink to={`${base}/usage`} icon={<BarChart3 size={14} />} label="Usage" />
        <SidebarLink to={`${base}/audit`} icon={<ScrollText size={14} />} label="Audit log" />
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
    const label = SETTINGS_TAB_LABEL[seg];
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
              { label: "Settings", to: tabCrumbs.length ? base : undefined },
              ...tabCrumbs,
            ]}
          />
        </div>
        <Outlet context={{ company, onCompaniesChanged } satisfies SettingsOutletCtx} />
      </div>
    </ContextualLayout>
  );
}
