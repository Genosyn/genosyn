import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { api, Company, Team } from "../lib/api";
import { rosterCards } from "../lib/employeeRoster";
import { useEmployees } from "./employeesContext";

/**
 * The `/c/:slug/employees` index pane: the company's AI Employees as a grid of
 * cards, each opening that employee's Chat, with Settings one click further.
 *
 * This page used to be an org chart drawn from reporting lines, with an inline
 * editor for who reports to whom. Reporting lines were removed, so it is the
 * roster again: name, role, and the employee's Team when it has one. A Team is
 * set on the employee's Settings → General and managed at Settings → Teams.
 */
export default function EmployeesIndex({ company }: { company: Company }) {
  const { employees } = useEmployees();
  const navigate = useNavigate();
  const [teams, setTeams] = React.useState<Team[] | null>(null);

  // Team badges are a detail on each card, so a failed fetch costs only the
  // badges — the roster itself comes from the layout and still renders.
  const reloadTeams = React.useCallback(() => {
    api
      .get<Team[]>(`/api/companies/${company.id}/teams`)
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [company.id]);

  React.useEffect(() => {
    reloadTeams();
  }, [reloadTeams]);

  useLiveRefetch("team", reloadTeams);

  const cards = React.useMemo(() => rosterCards(employees, teams), [employees, teams]);

  const crumbs = (
    <div className="mb-6">
      <Breadcrumbs items={[{ label: "Employees" }]} />
    </div>
  );

  if (cards.length === 0) {
    return (
      <>
        {crumbs}
        <div className="flex min-h-[50vh] items-center justify-center">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
              <Users size={20} />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              Hire your first AI employee
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Give them a name and a role, then write their Soul, define Skills, and schedule
              Routines.
            </p>
            <div className="mt-4 flex justify-center">
              <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
                <Plus size={14} /> New employee
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {crumbs}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Employees</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Open an AI Employee to chat with them or change their settings.
          </p>
        </div>
        <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
          <Plus size={14} /> New employee
        </Button>
      </div>
      <ul
        aria-label="AI Employees"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {cards.map(({ employee, teamName }) => (
          <li key={employee.id} className="min-w-0">
            <Link
              to={`/c/${company.slug}/employees/${employee.slug}`}
              className="group flex h-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
            >
              <Avatar
                name={employee.name}
                kind="ai"
                size="lg"
                src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-900 group-hover:text-slate-950 dark:text-slate-100 dark:group-hover:text-white">
                  {employee.name}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {employee.role || "No role set"}
                </div>
                {teamName && (
                  <span className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400"
                    />
                    <span className="truncate">{teamName}</span>
                  </span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
