import React from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Calendar,
  FolderTree,
  MessageSquare,
  Settings as SettingsIcon,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, Company, Employee } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";

/**
 * Sidebar + layout for a single selected employee. The sidebar switches from
 * the employee-list view to the employee's own sub-navigation:
 *   Chat · Workspace · Soul · Skills · Routines · Settings
 *
 * Child routes read the loaded `Employee` via Outlet context so they don't
 * each re-fetch on mount.
 */
export default function EmployeeLayout({ company }: { company: Company }) {
  const { empSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [emp, setEmp] = React.useState<Employee | null | undefined>(undefined);

  React.useEffect(() => {
    (async () => {
      try {
        const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
        const found = list.find((x) => x.slug === empSlug) ?? null;
        setEmp(found);
      } catch {
        setEmp(null);
      }
    })();
  }, [company.id, empSlug]);

  if (emp === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (emp === null) {
    // Unknown employee — bounce back to the list.
    navigate(`/c/${company.slug}`, { replace: true });
    return null;
  }

  const base = `/c/${company.slug}/employees/${emp.slug}`;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 px-3 py-3">
        <button
          onClick={() => navigate(`/c/${company.slug}`)}
          className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft size={12} /> All employees
        </button>
        <div className="mt-2 text-sm font-semibold text-slate-900">{emp.name}</div>
        <div className="text-xs text-slate-500">{emp.role}</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={`${base}/chat`} icon={<MessageSquare size={14} />} label="Chat" />
        <SidebarLink to={`${base}/workspace`} icon={<FolderTree size={14} />} label="Workspace" />
        <SidebarLink to={`${base}/skills`} icon={<Wrench size={14} />} label="Skills" />
        <SidebarLink to={`${base}/routines`} icon={<Calendar size={14} />} label="Routines" />
        <SidebarLink to={`${base}/settings`} icon={<SettingsIcon size={14} />} label="Settings" />
      </nav>
      <div className="border-t border-slate-100 p-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!confirm(`Delete ${emp.name}? This removes their workspace too.`)) return;
            try {
              await api.del(`/api/companies/${company.id}/employees/${emp.id}`);
              navigate(`/c/${company.slug}`);
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        >
          <Trash2 size={12} /> Delete employee
        </Button>
      </div>
    </div>
  );

  return (
    <ContextualLayout sidebar={sidebar}>
      <div className="mx-auto max-w-5xl p-8">
        <Outlet context={{ company, emp }} />
      </div>
    </ContextualLayout>
  );
}

export type EmployeeOutletCtx = { company: Company; emp: Employee };
