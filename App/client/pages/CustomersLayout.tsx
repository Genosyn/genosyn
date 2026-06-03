import React from "react";
import { Outlet } from "react-router-dom";
import { Contact2, FileSignature, Users } from "lucide-react";
import { Company } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/customers/*`. Customers used to live inside
 * the Finance section; they now stand alone as their own top-level section
 * (accounts + signed contracts), since they're a CRM concern that outgrew
 * the invoicing context.
 *
 * Children read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type CustomersOutletCtx = {
  company: Company;
};

export default function CustomersLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/customers`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Contact2 size={14} /> Customers
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<Users size={14} />} label="Customers" />
        <SidebarLink
          to={`${base}/contracts`}
          icon={<FileSignature size={14} />}
          label="Contracts"
        />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies CustomersOutletCtx} />
    </ContextualLayout>
  );
}
