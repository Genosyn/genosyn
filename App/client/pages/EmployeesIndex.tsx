import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Company } from "../lib/api";
import { useEmployees } from "./employeesContext";

/**
 * The `/c/:slug` index pane. Shows the company roster as a clickable grid
 * so a member can pick an employee without first scanning the sidebar.
 * The sidebar still mirrors the roster — keeping the grid here gives the
 * landing pane a real purpose and makes the "who works here" answer
 * unmissable on first load.
 */
export default function EmployeesIndex({ company }: { company: Company }) {
  const { employees } = useEmployees();
  const navigate = useNavigate();

  const crumbs = (
    <div className="mb-6">
      <Breadcrumbs items={[{ label: "Employees" }]} />
    </div>
  );

  if (employees.length === 0) {
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
            Give them a name and a role, then write their Soul, define Skills, and
            schedule Routines.
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
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Employees
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Pick someone to chat, edit their workspace, or review their Soul.
          </p>
        </div>
        <Button onClick={() => navigate(`/c/${company.slug}/employees/new`)}>
          <Plus size={14} /> New employee
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {employees.map((e) => (
          <li key={e.id}>
            <Link
              to={`/c/${company.slug}/employees/${e.slug}`}
              className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
            >
              <Avatar
                name={e.name}
                kind="ai"
                size="lg"
                src={employeeAvatarUrl(company.id, e.id, e.avatarKey)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-900 group-hover:text-slate-950 dark:text-slate-100 dark:group-hover:text-white">
                  {e.name}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {e.role || "No role set"}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
