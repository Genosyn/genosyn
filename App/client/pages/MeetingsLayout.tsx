import React from "react";
import { Outlet } from "react-router-dom";
import { Company } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { SectionRailHeader, SectionRailLinks } from "../components/SectionRail";

/**
 * Sidebar + layout for `/c/:slug/meetings/*` — the calendar half of the
 * product: what is coming up, what was recorded, and who may read it.
 *
 * Mirrors `RevenueLayout`: one vertical list of section links, drawn from the
 * subpage catalogue (`lib/subpages.ts`) the ⌘K palette also searches, and
 * children read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type MeetingsOutletCtx = {
  company: Company;
};

export default function MeetingsLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="meetings" label="Meetings" />
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="meetings" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies MeetingsOutletCtx} />
    </ContextualLayout>
  );
}
