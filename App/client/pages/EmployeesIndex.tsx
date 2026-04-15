import React from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Users } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Breadcrumbs } from "../components/AppShell";
import { Company } from "../lib/api";
import { useEmployees } from "./employeesContext";

/**
 * The `/c/:slug` index pane. The sidebar already shows the roster — this
 * pane is deliberately minimal: either an empty state with a call-to-action,
 * or a "select one on the left" prompt when employees exist. Picking an
 * employee is done via the sidebar; showing a big dashboard here would
 * double up with the sidebar list.
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
      <div className="flex min-h-[50vh] items-center justify-center text-center text-sm text-slate-500 dark:text-slate-400">
        <div>
          <div className="text-base font-medium text-slate-700 dark:text-slate-200">Pick an employee</div>
          <div className="mt-1">Choose someone from the sidebar to chat, edit their
            workspace, or review their Soul.
          </div>
        </div>
      </div>
    </>
  );
}
