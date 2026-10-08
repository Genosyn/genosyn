import { GitBranch } from "lucide-react";
import { Outlet } from "react-router-dom";
import { ContextualLayout } from "@/components/AppShell";
import { SectionRailLinks } from "@/components/SectionRail";
import type { Company } from "@/lib/api";

/**
 * Sidebar + layout for `/c/:slug/decisions/*`: the active stack — what still
 * needs someone — and the History of what was answered, dismissed, or
 * reviewed. Keeping History on its own page is what keeps the stack short
 * enough to clear. Rail links come from the subpage catalogue
 * (`lib/subpages.ts`) the ⌘K palette searches.
 */
export default function DecisionsLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <GitBranch size={14} /> Decision stack
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SectionRailLinks section="decisions" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet />
    </ContextualLayout>
  );
}
