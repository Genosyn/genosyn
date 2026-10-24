import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { api, type Company, type Goal } from "../../lib/api";
import { goalBarFill, goalStandingLine, primaryGoal } from "../../lib/goalSummary";
import { useLiveRefetch } from "../CompanySocket";

/**
 * Where the company's Goal stands, for the day Home has nothing else to say.
 *
 * A quiet Home used to send a brand-new owner off to create a project. The one
 * thing a company on Genosyn is asked for is a Goal, so a quiet Home shows
 * that: its title and how far along it is, or, when none is written, the way
 * to write it. Reads the Goals list the Goals page reads, so it never shows a
 * different Goal than that page does.
 */
export function GoalGlance({ company }: { company: Company }) {
  const [goals, setGoals] = React.useState<Goal[] | null>(null);
  const canSet = company.role === "owner" || company.role === "admin";
  const goalsPath = `/c/${company.slug}/goals`;

  const load = React.useCallback(async () => {
    try {
      setGoals(await api.get<Goal[]>(`/api/companies/${company.id}/goals`));
    } catch {
      // Home is not the place for this to fail loudly. Without the list the
      // link to Goals below is still the right next step.
      setGoals((current) => current ?? []);
    }
  }, [company.id]);

  React.useEffect(() => {
    setGoals(null);
    void load();
  }, [load]);
  useLiveRefetch("goal", load);

  if (goals === null) {
    // Reserve the line so the card does not jump when the Goal arrives.
    return <div className="mt-1 h-4" aria-hidden="true" />;
  }

  const goal = primaryGoal(goals);
  if (!goal) {
    return (
      <Link
        to={goalsPath}
        className="mt-1 flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        {canSet ? "Set your Goal" : "See Goals"} <ChevronRight size={12} />
      </Link>
    );
  }

  const fill = goalBarFill(goal);
  return (
    <div className="mt-1 flex w-full max-w-sm flex-col items-center gap-1.5">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
        Your Goal
      </div>
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{goal.title}</div>
      {fill !== null && (
        <div
          role="progressbar"
          aria-label="Progress toward your Goal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill * 100)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400"
            style={{ width: `${Math.round(fill * 100)}%` }}
          />
        </div>
      )}
      <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {goalStandingLine(goal)}
      </div>
      <Link
        to={goalsPath}
        className="flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        See Goals <ChevronRight size={12} />
      </Link>
    </div>
  );
}
