import React from "react";
import { Link, Outlet } from "react-router-dom";
import { Building2, Contact2, FileSignature } from "lucide-react";
import { Company } from "../lib/api";
import { Breadcrumbs, ContextualLayout } from "../components/AppShell";
import { SectionRailLinks } from "../components/SectionRail";
import { buttonClassName } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

/**
 * Sidebar + layout for `/c/:slug/customers/*`. Customers used to live inside
 * the Finance section; they now stand alone as their own top-level section
 * (accounts + signed contracts), since they're a CRM concern that outgrew
 * the invoicing context. Rail links come from the subpage catalogue
 * (`lib/subpages.ts`) the ⌘K palette also searches, and leave out what the
 * viewer can't open: the customer list is served by the finance routes, so a
 * Member without finance access sees Contracts only.
 *
 * Children read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type CustomersOutletCtx = {
  company: Company;
};

export default function CustomersLayout({ company }: { company: Company }) {
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Contact2 size={14} /> Customers
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SectionRailLinks section="customers" companySlug={company.slug} viewer={company} />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies CustomersOutletCtx} />
    </ContextualLayout>
  );
}

/**
 * In place of a Customers page for a Member without finance access. Every
 * page here but Contracts reads or writes through the finance routes — the
 * list, a customer's overview, statement, and edit form, and the New customer
 * form — so each checks that access itself and shows this rather than mount
 * a load that could only answer 403. Revenue → Accounts lists the same
 * accounts and Contracts stays open to them, so the note links to both rather
 * than leaving them at a dead end — on a phone the rail with Contracts in it
 * is folded away.
 */
export function CustomersClosed({
  companySlug,
  page,
}: {
  companySlug: string;
  /** The list (and the form that adds to it), or one customer's own pages. */
  page: "list" | "customer";
}) {
  const link = buttonClassName({ variant: "secondary", size: "sm" });
  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Customers" }]} />
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900 dark:text-slate-100">Customers</h1>
      <EmptyState
        title={
          page === "list"
            ? "You don't have access to the customer list"
            : "You don't have access to this customer's page"
        }
        description="Customer pages follow finance access, which owners and admins choose for each Member. Ask one of them to change yours under Settings → Members. Revenue → Accounts lists the same accounts, and Contracts stays open to you."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`/c/${companySlug}/revenue/accounts`} className={link}>
              <Building2 size={14} /> Revenue accounts
            </Link>
            <Link to={`/c/${companySlug}/customers/contracts`} className={link}>
              <FileSignature size={14} /> Contracts
            </Link>
          </div>
        }
      />
    </div>
  );
}
