import { Outlet } from "react-router-dom";
import { KeyRound, LockKeyhole, Plug } from "lucide-react";
import { ContextualLayout, SidebarLink } from "@/components/AppShell";
import type { Company } from "@/lib/api";

/**
 * Sidebar + layout for `/c/:slug/vault/*`. Mirrors CustomersLayout: the rail
 * is a short static list, and children read `company` from Outlet context so
 * each page can build `/api/companies/:cid/...` URLs without re-deriving it
 * from the route.
 *
 * "Integrations" is the rail's name for the external password managers this
 * Vault mirrors. They are still `VaultSource` rows and still not Integration
 * Connections — see the note in AGENTS.md §3 before wiring one into the
 * Integration catalog.
 */

export type VaultOutletCtx = {
  company: Company;
};

export default function VaultLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/vault`;
  // Every route behind Integrations is admin-gated on the server — a source
  // holds the master password to a whole external vault — so a Member is never
  // offered a link that can only answer 403.
  const canAdminister = company.role === "owner" || company.role === "admin";

  // Integrations is the only thing the rail adds, so a Member — who cannot see
  // it — gets no rail at all rather than 16rem of chrome whose one link is the
  // page they are already on. `ContextualLayout` reads an undefined `sidebar`
  // as "no rail", which also keeps the mobile drawer toggle off the top nav.
  const sidebar = canAdminister ? (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <KeyRound size={14} /> Vault
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<LockKeyhole size={14} />} label="Items" />
        <SidebarLink to={`${base}/integrations`} icon={<Plug size={14} />} label="Integrations" />
      </nav>
      <div className="border-t border-slate-100 p-3 text-xs leading-5 text-slate-400 dark:border-slate-800 dark:text-slate-500">
        Stored values stay encrypted until an authorized request needs them.
      </div>
    </div>
  ) : undefined;

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies VaultOutletCtx} />
    </ContextualLayout>
  );
}
