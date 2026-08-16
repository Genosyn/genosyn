import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Compass } from "lucide-react";
import { api, Company, OnboardingStatus } from "../lib/api";

/**
 * "Finish setting up" — the way back into the first-run guide.
 *
 * Setup asks members to go and create an API key at another company, so many of
 * them leave halfway through. The guide used to be unreachable afterwards: it
 * appears in no nav, no command palette, and no link anywhere in the app, so
 * leaving was a one-way door and whatever was half-finished stayed that way.
 *
 * The status is derived server-side from the company's real state rather than a
 * stored flag, so this disappears by itself the moment setup is genuinely done
 * — including when it was finished outside the guide.
 */
export function SetupBanner({ company }: { company: Company }) {
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null);
  // Hiring an AI Employee and connecting its AI Model are both admin-only, so
  // a plain Member following this banner would hit a 403 with no way to
  // dismiss it. Same gate the rest of the client uses for admin affordances.
  const canSetUp = company.role === "owner" || company.role === "admin";

  React.useEffect(() => {
    if (!canSetUp) return;
    let cancelled = false;
    setStatus(null);
    api
      .get<OnboardingStatus>(`/api/companies/${company.id}/onboarding-status`)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A banner is not worth an error state — stay quiet and let Home load.
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, canSetUp]);

  if (!canSetUp || !status || status.complete) return null;

  const employee = status.employee;
  const params = new URLSearchParams({ step: status.nextStep });
  if (employee) params.set("employee", employee.id);

  return (
    <div className="mt-5 flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 sm:flex-row sm:items-center dark:border-indigo-500/30 dark:bg-indigo-500/10">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
        <Compass size={17} />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {employee
            ? `Finish setting up ${employee.name}`
            : `${company.name} has no AI Employees yet`}
        </div>
        <p className="mt-0.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {employee
            ? `They still need an AI Model connected — until then ${employee.name} cannot answer a request or run a Routine.`
            : "The setup guide explains how AI Employees work and walks you through hiring your first one."}
        </p>
      </div>
      <Link
        to={`/c/${company.slug}/onboarding?${params.toString()}`}
        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700 sm:ml-auto dark:bg-indigo-500 dark:hover:bg-indigo-600"
      >
        {employee ? "Finish setup" : "Open the guide"} <ArrowRight size={15} />
      </Link>
    </div>
  );
}
