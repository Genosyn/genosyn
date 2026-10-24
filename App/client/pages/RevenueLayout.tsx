import React from "react";
import { Outlet } from "react-router-dom";
import { Company } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { SectionRailHeader, SectionRailLinks } from "../components/SectionRail";

/**
 * Sidebar + layout for `/c/:slug/revenue/*` — the go-to-market half of the
 * product: the deal board, the people on those deals, the sequences that reach
 * them, and the reports that say whether any of it worked.
 *
 * Structure mirrors `CustomersLayout` / `FinanceLayout`: one vertical list of
 * section links, drawn from the subpage catalogue (`lib/subpages.ts`) the ⌘K
 * palette also searches. Children read `company` from Outlet context so each
 * page can build `/api/companies/:cid/...` URLs without re-deriving it from
 * the route.
 */

export type RevenueOutletCtx = {
  company: Company;
};

export default function RevenueLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="revenue" label="Revenue" />
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="revenue" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies RevenueOutletCtx} />
    </ContextualLayout>
  );
}
