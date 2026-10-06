import React from "react";
import { Outlet } from "react-router-dom";
import { Wallet } from "lucide-react";
import { Company } from "../lib/api";
import { effectiveFinanceAccess } from "../lib/subpages";
import { Breadcrumbs, ContextualLayout } from "../components/AppShell";
import { SectionRailLinks } from "../components/SectionRail";
import { EmptyState } from "../components/ui/EmptyState";

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
  // Finance access None closes the whole section: every finance route answers
  // that Member 403, so no page here can load for them. Hiding the rail's
  // links alone would leave an empty rail beside a page that reads like an
  // outage ("Couldn't load finance", with a Try again that never works), and
  // they can still arrive here from the nav, `G F`, or a pasted invoice link.
  // So instead of the pages they get one plain note: Finance isn't open to
  // them, and who can change that. The product Integrations link
  // `ContextualLayout` adds stays, since that page reads only Connections,
  // which any Member may (the palette offers it to them as well).
  if (effectiveFinanceAccess(company) === "none") {
    return (
      <ContextualLayout>
        <FinanceClosed />
      </ContextualLayout>
    );
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Wallet size={14} /> Finance
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="finance" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies FinanceOutletCtx} />
    </ContextualLayout>
  );
}

function FinanceClosed() {
  return (
    <div className="page-shell p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Finance" }]} />
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900 dark:text-slate-100">Finance</h1>
      <EmptyState
        title="You don't have access to Finance"
        description="Owners and admins choose each Member's finance access. Ask one of them to change yours under Settings → Members."
      />
    </div>
  );
}
