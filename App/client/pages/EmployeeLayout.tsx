import React from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BookText,
  Brain,
  Calendar,
  MessageSquare,
  Plug,
  PlugZap,
  Settings as SettingsIcon,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, Company, Employee } from "../lib/api";
import { Breadcrumbs, ContextualLayout, SidebarLink } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";

/**
 * Sidebar + layout for a single selected employee. The sidebar switches from
 * the employee-list view to the employee's own sub-navigation:
 *   Chat · Skills · Routines · Journal · Memory · Connections · MCP · Settings
 *
 * Child routes read the loaded `Employee` via Outlet context so they don't
 * each re-fetch on mount.
 */
const EMP_TAB_LABEL: Record<string, string> = {
  chat: "Chat",
  skills: "Skills",
  routines: "Routines",
  journal: "Journal",
  memory: "Memory",
  connections: "Connections",
  mcp: "MCP",
  settings: "Settings",
  general: "General",
  soul: "Soul",
  model: "Model",
};

export default function EmployeeLayout({ company }: { company: Company }) {
  const { empSlug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [emp, setEmp] = React.useState<Employee | null | undefined>(undefined);

  const refreshEmp = React.useCallback(async () => {
    try {
      const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
      const found = list.find((x) => x.slug === empSlug) ?? null;
      setEmp(found);
    } catch {
      setEmp(null);
    }
  }, [company.id, empSlug]);

  React.useEffect(() => {
    refreshEmp();
  }, [refreshEmp]);

  React.useEffect(() => {
    const handler = () => {
      refreshEmp();
    };
    window.addEventListener("genosyn:employee-updated", handler);
    return () => window.removeEventListener("genosyn:employee-updated", handler);
  }, [refreshEmp]);

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
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <button
          onClick={() => navigate(`/c/${company.slug}`)}
          className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft size={12} /> All employees
        </button>
        <div className="mt-2 flex items-center gap-2">
          <Avatar
            name={emp.name}
            kind="ai"
            size="lg"
            src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {emp.name}
            </div>
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
              {emp.role}
            </div>
          </div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarLink to={`${base}/chat`} icon={<MessageSquare size={14} />} label="Chat" />
        <SidebarLink to={`${base}/skills`} icon={<Wrench size={14} />} label="Skills" />
        <SidebarLink to={`${base}/routines`} icon={<Calendar size={14} />} label="Routines" />
        <SidebarLink to={`${base}/journal`} icon={<BookText size={14} />} label="Journal" />
        <SidebarLink to={`${base}/memory`} icon={<Brain size={14} />} label="Memory" />
        <SidebarLink to={`${base}/connections`} icon={<PlugZap size={14} />} label="Connections" />
        <SidebarLink to={`${base}/mcp`} icon={<Plug size={14} />} label="MCP" />
        <SidebarLink to={`${base}/settings`} icon={<SettingsIcon size={14} />} label="Settings" />
      </nav>
      <div className="border-t border-slate-100 p-3 dark:border-slate-800">
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            const ok = await dialog.confirm({
              title: `Fire ${emp.name}?`,
              message: "Their workspace on disk, conversations, routines, and skills will be removed.",
              confirmLabel: "Delete employee",
              variant: "danger",
            });
            if (!ok) return;
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

  // Segments after the employee slug (e.g. `settings/soul`) become the trailing
  // breadcrumbs. Each known segment gets a label from EMP_TAB_LABEL; unknown
  // segments are skipped so the chain stays clean.
  const afterBase = location.pathname.startsWith(base)
    ? location.pathname.slice(base.length).replace(/^\/+/, "")
    : "";
  const segments = afterBase ? afterBase.split("/").filter(Boolean) : [];
  const tabCrumbs: { label: string; to?: string }[] = [];
  let acc = base;
  segments.forEach((seg, i) => {
    acc = `${acc}/${seg}`;
    const label = EMP_TAB_LABEL[seg];
    if (!label) return;
    const isLast = i === segments.length - 1;
    tabCrumbs.push({ label, to: isLast ? undefined : acc });
  });

  // Chat gets the full main pane — it has its own header with breadcrumb
  // context (avatar + name + thread title), so the app breadcrumb is
  // redundant and the max-w wrapper just wastes horizontal space.
  const fullBleed = location.pathname.endsWith("/chat");

  return (
    <ContextualLayout sidebar={sidebar}>
      {fullBleed ? (
        <Outlet context={{ company, emp }} />
      ) : (
        <div className="mx-auto max-w-5xl p-8">
          <div className="mb-4">
            <Breadcrumbs
              items={[
                { label: "Employees", to: `/c/${company.slug}` },
                { label: emp.name, to: tabCrumbs.length ? base : undefined },
                ...tabCrumbs,
              ]}
            />
          </div>
          <Outlet context={{ company, emp }} />
        </div>
      )}
    </ContextualLayout>
  );
}

export type EmployeeOutletCtx = { company: Company; emp: Employee };
