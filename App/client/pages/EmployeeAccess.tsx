import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import { TopBar } from "../components/AppShell";
import { EmployeeAccessPanel } from "../components/employeeAccess/EmployeeAccessPanel";
import { buttonClassName } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { canOpenEmployeePage, employeePageAt } from "../lib/subpages";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Settings → Access: everything the company has that this AI Employee could be
 * granted — Connections, mailboxes, calendars, Repositories, notes, Bases,
 * charts, Resources, Vault items, Member browsers, Routines and the company
 * sections — with what it holds of each, and a way to grant, change or revoke
 * many at once.
 *
 * Arriving from the hire flow (`?welcome=1`) adds a note on top: granting
 * access is the next thing a new employee needs, and Chat is one click away
 * when you are done.
 */
export function EmployeeAccessPage() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const [searchParams] = useSearchParams();
  const welcome = searchParams.get("welcome") === "1";

  if (!canOpenEmployeePage(employeePageAt("/settings/access"), company)) {
    return (
      <>
        <TopBar title="Access" />
        <EmptyState
          title="You can't open this page"
          description="Ask an owner or admin about this AI Employee's access."
        />
      </>
    );
  }

  return (
    <>
      <TopBar title="Access" />
      <p className="-mt-3 mb-5 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Everything {emp.name} could be given access to, and what {emp.name} holds now. Tick what{" "}
        {emp.name} needs and grant it in one go; each Grant follows its own section&apos;s rules
        and is audited there.
      </p>
      {welcome && (
        <div className="mb-5 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 sm:flex-row sm:items-center dark:border-indigo-500/30 dark:bg-indigo-500/10">
          <Sparkles size={18} className="shrink-0 text-indigo-600 dark:text-indigo-300" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm leading-6">
            <div className="font-semibold text-indigo-950 dark:text-indigo-100">
              {emp.name} is hired. Next, choose what {emp.name} can reach.
            </div>
            <div className="text-indigo-900/80 dark:text-indigo-200/80">
              Without a Grant an AI Employee sees nothing of a mailbox, a notebook or Finance. Tick
              what the job needs, then press Grant.
            </div>
          </div>
          <Link
            to={`/c/${company.slug}/employees/${emp.slug}/chat`}
            className={buttonClassName({ variant: "secondary", className: "w-full sm:w-auto" })}
          >
            Done — meet {emp.name} <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      )}
      <EmployeeAccessPanel company={company} emp={emp} />
    </>
  );
}
