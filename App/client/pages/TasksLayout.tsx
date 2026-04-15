import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { api, Company, Project } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";

export type TasksContextValue = {
  projects: Project[];
  reload: () => Promise<void>;
};

export const TasksContext = React.createContext<TasksContextValue | null>(null);

export function useTasks(): TasksContextValue {
  const ctx = React.useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used inside TasksLayout");
  return ctx;
}

/**
 * Sidebar: list of projects in the current company. Mirrors the shape of
 * EmployeesLayout so the app feels consistent when jumping between sections.
 */
export default function TasksLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [projects, setProjects] = React.useState<Project[] | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<Project[]>(`/api/companies/${company.id}/projects`);
      setProjects(list);
    } catch {
      setProjects([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const ctx = React.useMemo(
    () => ({ projects: projects ?? [], reload }),
    [projects, reload],
  );

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <FolderKanban size={14} /> Projects
        </div>
        <button
          onClick={() => navigate(`/c/${company.slug}/tasks/new`)}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          title="New project"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {projects === null ? (
          <div className="flex justify-center p-4">
            <Spinner size={16} />
          </div>
        ) : projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-slate-500">
            No projects yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {projects.map((p) => (
              <li key={p.id}>
                <NavLink
                  to={`/c/${company.slug}/tasks/p/${p.slug}`}
                  className={({ isActive }) =>
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
                    (isActive
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50")
                  }
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <span className="truncate text-xs text-slate-500">
                      {p.openTodos ?? 0} open · {p.totalTodos ?? 0} total
                    </span>
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                    {p.key}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <TasksContext.Provider value={ctx}>
      <ContextualLayout sidebar={sidebar}>
        <Outlet />
      </ContextualLayout>
    </TasksContext.Provider>
  );
}
