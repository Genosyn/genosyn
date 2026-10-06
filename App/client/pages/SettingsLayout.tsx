import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Settings as SettingsIcon } from "lucide-react";
import { Company, Me } from "../lib/api";
import { Breadcrumbs, ContextualLayout } from "../components/AppShell";
import { SectionRailLinks } from "../components/SectionRail";

/**
 * Sidebar + layout for `/c/:slug/settings/*`. Mirrors EmployeesLayout /
 * TasksLayout / BasesLayout so the company-level settings section feels
 * consistent with the rest of the app. Child routes read `company`, the
 * current user, and the refresh callback from Outlet context. Rail links come
 * from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches.
 */

export type SettingsOutletCtx = {
  company: Company;
  me: Me;
  onCompaniesChanged: () => void;
};

const SETTINGS_TAB_LABEL: Record<string, string> = {
  company: "Company",
  members: "Members",
  teams: "Teams",
  tags: "Tags",
  policies: "Policies",
  integrations: "Integrations",
  browsers: "Browsers",
  email: "Email",
  providers: "Providers",
  logs: "Logs",
  secrets: "Environment secrets",
  "api-keys": "API keys",
  usage: "Usage",
  sso: "Single sign-on",
  audit: "Audit log",
  "system-health": "System Health",
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
        <SectionRailLinks section="settings" companySlug={company.slug} />
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
      <div className="page-shell p-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[{ label: "Settings", to: tabCrumbs.length ? base : undefined }, ...tabCrumbs]}
          />
        </div>
        <Outlet context={{ company, me, onCompaniesChanged } satisfies SettingsOutletCtx} />
      </div>
    </ContextualLayout>
  );
}
