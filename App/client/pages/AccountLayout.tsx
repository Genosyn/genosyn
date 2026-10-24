import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Company, Me } from "../lib/api";
import { Breadcrumbs, ContextualLayout } from "../components/AppShell";
import { SectionRailHeader, SectionRailLinks } from "../components/SectionRail";

/**
 * Sidebar + layout for `/c/:slug/account/*`. The Account section holds settings
 * that belong to the signed-in person, not the company they're currently
 * viewing — profile, password, notifications, and security. It mirrors
 * the company Settings section so the two feel consistent, but its pages are
 * deliberately global to the user's account. Child routes read `me` and the
 * refresh callback from Outlet context. Rail links come from the subpage
 * catalogue (`lib/subpages.ts`) the ⌘K palette searches.
 */

export type AccountOutletCtx = {
  company: Company;
  me: Me;
  onCompaniesChanged: () => void;
};

const ACCOUNT_TAB_LABEL: Record<string, string> = {
  profile: "Profile",
  security: "Security",
};

export default function AccountLayout({
  company,
  me,
  onCompaniesChanged,
}: {
  company: Company;
  me: Me;
  onCompaniesChanged: () => void;
}) {
  const location = useLocation();
  const base = `/c/${company.slug}/account`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="account" label="Account" />
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="account" companySlug={company.slug} viewer={company} />
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
    const label = ACCOUNT_TAB_LABEL[seg];
    if (!label) return;
    const isLast = i === segments.length - 1;
    tabCrumbs.push({ label, to: isLast ? undefined : acc });
  });

  return (
    <ContextualLayout sidebar={sidebar}>
      <div className="page-shell p-8">
        <div className="mb-4">
          <Breadcrumbs
            items={[
              { label: "Account", to: tabCrumbs.length ? `${base}/profile` : undefined },
              ...tabCrumbs,
            ]}
          />
        </div>
        <Outlet context={{ company, me, onCompaniesChanged } satisfies AccountOutletCtx} />
      </div>
    </ContextualLayout>
  );
}
