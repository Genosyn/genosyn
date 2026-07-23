import React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { CalendarClock, Plus, Users } from "lucide-react";
import { api, Company, Employee, RoutineWithMeta } from "../lib/api";
import { ContextualLayout } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Routines section shell — every scheduled routine in the company, in one
 * place. Routines belong to an AI employee, and until now that was the only
 * way to reach them: "what is scheduled around here?" meant opening each
 * employee in turn. The sidebar keeps the roster as a *filter* rather than a
 * hierarchy, so the whole company's schedule is the default view.
 *
 * The routine list is loaded once here and shared with both children, because
 * the detail page resolves its routine out of it (`:empSlug/:routineSlug` —
 * a routine slug is only unique per employee, so it takes both segments).
 */
export default function RoutinesLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [routines, setRoutines] = React.useState<RoutineWithMeta[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      const [rows, roster] = await Promise.all([
        api.get<RoutineWithMeta[]>(`/api/companies/${company.id}/routines`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      ]);
      setRoutines(rows);
      setEmployees(roster);
    } catch {
      setRoutines([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefetch(["routine", "run"], refresh);

  const ctx = React.useMemo<RoutinesContext>(
    () => ({ routines: routines ?? [], employees, loading: routines === null, refresh }),
    [routines, employees, refresh],
  );

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          routines={routines}
          employees={employees}
          onNew={() => navigate(`/c/${company.slug}/routines/new`)}
        />
      }
    >
      <Outlet context={ctx} />
    </ContextualLayout>
  );
}

export type RoutinesContext = {
  routines: RoutineWithMeta[];
  /** Full roster — a routine can be created for an employee that has none yet. */
  employees: Employee[];
  loading: boolean;
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  routines,
  employees,
  onNew,
}: {
  company: Company;
  routines: RoutineWithMeta[] | null;
  employees: Employee[];
  onNew: () => void;
}) {
  const location = useLocation();
  const base = `/c/${company.slug}/routines`;
  const activeEmployee = new URLSearchParams(location.search).get("employee");
  const onIndex = location.pathname === base;

  const countFor = (slug: string) =>
    (routines ?? []).filter((r) => r.employee?.slug === slug).length;

  // Only employees that actually own routines earn a filter row — a roster of
  // twenty with one routine between them would bury the thing you came for.
  const withRoutines = employees.filter((e) => countFor(e.slug) > 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <CalendarClock size={14} /> Routines
        </div>
        <button
          onClick={onNew}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="New routine"
          aria-label="New routine"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <NavLink
          to={base}
          end
          className={
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
            (onIndex && !activeEmployee
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
          }
        >
          <CalendarClock size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All routines</span>
          {routines !== null && (
            <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {routines.length}
            </span>
          )}
        </NavLink>

        {withRoutines.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <Users size={12} /> Assigned to
            </div>
            {withRoutines.map((e) => {
              const active = onIndex && activeEmployee === e.slug;
              return (
                <NavLink
                  key={e.id}
                  to={`${base}?employee=${e.slug}`}
                  className={
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm " +
                    (active
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
                  }
                >
                  <Avatar
                    name={e.name}
                    src={employeeAvatarUrl(company.id, e.id, e.avatarKey)}
                    kind="ai"
                    size="xs"
                  />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {countFor(e.slug)}
                  </span>
                </NavLink>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
