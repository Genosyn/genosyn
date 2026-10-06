import { Bot, Library } from "lucide-react";
import { Outlet } from "react-router-dom";
import { ContextualLayout, SidebarLink } from "../components/AppShell";
import type { Company } from "../lib/api";

export type ResourcesOutletCtx = { company: Company };

/**
 * Sidebar + layout for `/c/:slug/resources/*`: the library itself and who among
 * the AI employees may write to it. The shared contextual shell adds the
 * product-scoped Integrations link beneath, in the same position as every other
 * product. Children that need the company read it from Outlet context.
 */
export default function ResourcesLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/resources`;
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Library size={14} /> Resources
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<Library size={14} />} label="Library" />
        <SidebarLink to={`${base}/ai-access`} icon={<Bot size={14} />} label="AI access" />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies ResourcesOutletCtx} />
    </ContextualLayout>
  );
}
