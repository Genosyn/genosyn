import React from "react";
import { Outlet } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  FileText,
  Layers,
  LineChart,
  NotebookPen,
  Package,
  Percent,
  Users,
  Wallet,
} from "lucide-react";
import { Company } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";

/**
 * Sidebar + layout for `/c/:slug/finance/*`. Phase A of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Sub-nav mirrors the Settings layout: a vertical list of section links.
 * Children read `company` from Outlet context so each page can build
 * `/api/companies/:cid/...` URLs without re-deriving it from the route.
 */

export type FinanceOutletCtx = {
  company: Company;
};

export default function FinanceLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/finance`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Wallet size={14} /> Finance
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<BarChart3 size={14} />} label="Overview" />
        <SidebarLink
          to={`${base}/invoices`}
          icon={<FileText size={14} />}
          label="Invoices"
        />
        <SidebarLink
          to={`${base}/customers`}
          icon={<Users size={14} />}
          label="Customers"
        />
        <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Ledger
        </div>
        <SidebarLink
          to={`${base}/journal`}
          icon={<NotebookPen size={14} />}
          label="Journal"
        />
        <SidebarLink
          to={`${base}/accounts`}
          icon={<BookOpen size={14} />}
          label="Accounts"
        />
        <SidebarLink
          to={`${base}/trial-balance`}
          icon={<Layers size={14} />}
          label="Trial balance"
        />
        <SidebarLink
          to={`${base}/reports`}
          icon={<LineChart size={14} />}
          label="Reports"
        />
        <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          Catalog
        </div>
        <SidebarLink
          to={`${base}/products`}
          icon={<Package size={14} />}
          label="Products"
        />
        <SidebarLink
          to={`${base}/tax-rates`}
          icon={<Percent size={14} />}
          label="Tax rates"
        />
      </nav>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies FinanceOutletCtx} />
    </ContextualLayout>
  );
}
