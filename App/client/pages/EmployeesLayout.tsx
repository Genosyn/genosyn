import React from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { api, Company, Employee } from "../lib/api";
import { ContextualLayout, SidebarLink } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { EmployeesContext } from "./employeesContext";

/**
 * Sidebar for `/c/:slug/employees` (index) and `/c/:slug/employees/new`.
 * The per-employee detail tree lives under a sibling route with its own
 * sidebar — that way neither layout has to juggle two sidebar modes.
 */
export default function EmployeesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
      setEmployees(list);
    } catch {
      setEmployees([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Sub-pages (e.g. the employee General settings form) fire this when the
  // employee's display fields change — refresh the roster so sidebar names
  // and avatars reflect the edit without a full page reload.
  React.useEffect(() => {
    const handler = () => {
      reload();
    };
    window.addEventListener("genosyn:employee-updated", handler);
    return () => window.removeEventListener("genosyn:employee-updated", handler);
  }, [reload]);

  const ctx = React.useMemo(() => ({ employees: employees ?? [], reload }), [employees, reload]);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Users size={14} /> Employees
        </div>
        <button
          onClick={() => navigate(`/c/${company.slug}/employees/new`)}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="New employee"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {employees === null ? (
          <div className="flex justify-center p-4">
            <Spinner size={16} />
          </div>
        ) : employees.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No employees yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {employees.map((e) => (
              <li key={e.id}>
                <SidebarLink
                  to={`/c/${company.slug}/employees/${e.slug}`}
                  icon={
                    <Avatar
                      name={e.name}
                      kind="ai"
                      size="sm"
                      src={employeeAvatarUrl(company.id, e.id, e.avatarKey)}
                    />
                  }
                  label={
                    <span className="flex flex-col">
                      <span className="truncate text-sm font-medium">{e.name}</span>
                      <span className="truncate text-xs text-slate-500 dark:text-slate-400">{e.role}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <EmployeesContext.Provider value={ctx}>
      <ContextualLayout sidebar={sidebar}>
        <div className="mx-auto max-w-5xl p-8">
          <Outlet />
        </div>
      </ContextualLayout>
    </EmployeesContext.Provider>
  );
}
