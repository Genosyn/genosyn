import React from "react";
import { Outlet } from "react-router-dom";

import { ContextualLayout } from "@/components/AppShell";
import { SectionRailHeader, SectionRailLinks } from "@/components/SectionRail";
import type { Company } from "@/lib/api";

export type TldrsOutletContext = {
  company: Company;
};

/**
 * Company-wide TLDR feed plus the schedule that produces it. Rail links come
 * from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches.
 */
export default function TldrsLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="tldrs" label="What happened" />
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="tldrs" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies TldrsOutletContext} />
    </ContextualLayout>
  );
}
