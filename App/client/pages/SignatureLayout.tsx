import { Bot, FilePlus2, FileSignature } from "lucide-react";
import { Outlet } from "react-router-dom";
import { ContextualLayout, SidebarLink } from "@/components/AppShell";
import type { Company } from "@/lib/api";

export type SignatureOutletContext = { company: Company };

export default function SignatureLayout({ company }: { company: Company }) {
  const base = `/c/${company.slug}/signatures`;
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <FileSignature size={14} /> Signatures
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        <SidebarLink to={base} end icon={<FileSignature size={14} />} label="Envelopes" />
        <SidebarLink to={`${base}/new`} icon={<FilePlus2 size={14} />} label="New envelope" />
        <SidebarLink to={`${base}/ai-access`} icon={<Bot size={14} />} label="AI access" />
      </nav>
      <div className="border-t border-slate-100 p-3 text-xs leading-5 text-slate-400 dark:border-slate-800 dark:text-slate-500">
        Every view, signature, and delivery is recorded in the envelope audit trail.
      </div>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <Outlet context={{ company } satisfies SignatureOutletContext} />
    </ContextualLayout>
  );
}
