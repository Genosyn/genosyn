import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import {
  Archive,
  BarChart3,
  Building2,
  KeyRound,
  Mail,
  Network,
  Plug,
  ScrollText,
  Settings as SettingsIcon,
  User,
  Users,
} from "lucide-react";
import { Company, Me } from "../lib/api";
import { Breadcrumbs, ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/settings/*`. Mirrors EmployeesLayout /
 * TasksLayout / BasesLayout so the company-level settings section feels
 * consistent with the rest of the app. Child routes read `company`, the
 * current user, and the refresh callback from Outlet context.
 */

export type SettingsOutletCtx = {
  company: Company;
  me: Me;
  onCompaniesChanged: () => void;
};

const SETTINGS_TAB_LABEL: Record<string, string> = {
  profile: "Profile",
  company: "Company",
  members: "Members",
  teams: "Teams",
  integrations: "Integrations",
  email: "Email",
  providers: "Providers",
  logs: "Logs",
  secrets: "Secrets",
  backup: "Backup",
  usage: "Usage",
  audit: "Audit log",
};

export default function SettingsLayout({
  company,
  me,
  onCompaniesChanged,
}: {
  company: Company;
  me: Me;
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
        <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Your account
        </div>
        <SidebarLink to={`${base}/profile`} icon={<User size={14} />} label="Profile" />
        <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Company
        </div>
        <SidebarLink to={`${base}/company`} icon={<Building2 size={14} />} label="Company" />
        <SidebarLink to={`${base}/members`} icon={<Users size={14} />} label="Members" />
        <SidebarLink to={`${base}/teams`} icon={<Network size={14} />} label="Teams" />
        <SidebarLink to={`${base}/integrations`} icon={<Plug size={14} />} label="Integrations" />
        <SidebarLink to={`${base}/email`} icon={<Mail size={14} />} label="Email" />
        <SidebarLink to={`${base}/secrets`} icon={<KeyRound size={14} />} label="Secrets" />
        <SidebarLink to={`${base}/backup`} icon={<Archive size={14} />} label="Backup" />
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
        <Outlet context={{ company, me, onCompaniesChanged } satisfies SettingsOutletCtx} />
      </div>
    </ContextualLayout>
  );
}
