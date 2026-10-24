import { Outlet } from "react-router-dom";
import { ContextualLayout } from "@/components/AppShell";
import { SectionRailHeader, SectionRailLinks } from "@/components/SectionRail";
import type { Company } from "@/lib/api";

export type SignatureOutletContext = { company: Company };

/** Rail links come from the subpage catalogue (`lib/subpages.ts`) the ⌘K palette searches. */
export default function SignatureLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <SectionRailHeader section="signatures" label="Signatures" />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SectionRailLinks section="signatures" companySlug={company.slug} viewer={company} />
      </nav>
      <div className="border-t border-slate-100 p-3 text-xs leading-5 text-slate-400 dark:border-slate-800 dark:text-slate-500">
        Every view, signature, and delivery is recorded in the request audit trail.
      </div>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies SignatureOutletContext} />
    </ContextualLayout>
  );
}
