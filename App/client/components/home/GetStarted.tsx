import React from "react";
import { Link } from "react-router-dom";
import { Check, Rocket, X } from "lucide-react";
import { api, type Company, type OnboardingStatus } from "../../lib/api";
import {
  getStartedHiddenKey,
  getStartedStartedKey,
  getStartedSteps,
  nextGetStartedStep,
  showsGetStarted,
  type GetStartedStep,
} from "../../lib/getStarted";
import { SetupBanner } from "../SetupBanner";
import { buttonClassName } from "../ui/Button";
import { clsx } from "../ui/clsx";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readFlag(key: string): boolean {
  try {
    return browserStorage()?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    browserStorage()?.setItem(key, "1");
  } catch {
    // Storage refused: the choice holds for this visit only.
  }
}

/**
 * Home's "Get started" checklist: the handful of things that turn a new
 * company into one whose AI Employees work on their own, each with the button
 * that does it, ticked off as the company really gets there.
 *
 * Owners and admins only — hiring and connecting an AI Model are theirs. It
 * appears while the company can't work yet and stays until every step is done
 * or they hide it (`showsGetStarted`). Hiding it in a company that still can't
 * work (no Goal, or no AI Model) leaves the one-line setup banner in its
 * place, so the way back into the guide is never lost.
 */
export function GetStarted({
  company,
  memberCount,
  onShownChange,
}: {
  company: Company;
  /** Members of the company; null until Home has loaded them. */
  memberCount: number | null;
  /**
   * Whether the checklist itself is on screen, so Home can hold back other
   * asks (turning on push notifications) until setup is done: one next step
   * at a time.
   */
  onShownChange?: (shown: boolean) => void;
}) {
  const canSetUp = company.role === "owner" || company.role === "admin";
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [hidden, setHidden] = React.useState(() => readFlag(getStartedHiddenKey(company.id)));
  const [started, setStarted] = React.useState(() => readFlag(getStartedStartedKey(company.id)));

  React.useEffect(() => {
    setHidden(readFlag(getStartedHiddenKey(company.id)));
    setStarted(readFlag(getStartedStartedKey(company.id)));
    if (!canSetUp) return;
    let cancelled = false;
    setStatus(null);
    setFailed(false);
    api
      .get<OnboardingStatus>(`/api/companies/${company.id}/onboarding-status`)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A checklist is not worth an error state — Home loads without it.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, canSetUp]);

  const steps =
    canSetUp && status && memberCount !== null
      ? getStartedSteps({ companySlug: company.slug, status, memberCount })
      : null;
  const next = steps ? nextGetStartedStep(steps) : null;
  const shown =
    status !== null && showsGetStarted({ complete: status.complete, next, hidden, started });

  // Once it has appeared for a company, it stays to see the optional steps
  // through after the company can work.
  React.useEffect(() => {
    if (!shown || started) return;
    writeFlag(getStartedStartedKey(company.id));
    setStarted(true);
  }, [company.id, shown, started]);
  // Said only once it is known, so Home doesn't show the push prompt for the
  // moment the checklist takes to load and then take it away again.
  const settled = !canSetUp || hidden || failed || (status !== null && memberCount !== null);

  React.useEffect(() => {
    if (settled) onShownChange?.(shown);
  }, [onShownChange, settled, shown]);
  React.useEffect(() => () => onShownChange?.(false), [onShownChange]);

  if (!canSetUp) return null;
  if (hidden) return <SetupBanner company={company} />;
  if (!shown || !steps || !next) return null;
  const done = steps.filter((step) => step.done).length;

  function hide() {
    writeFlag(getStartedHiddenKey(company.id));
    setHidden(true);
  }

  return (
    <section
      aria-labelledby="get-started-title"
      className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start gap-3 px-4 pt-4 sm:px-5">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
        >
          <Rocket size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="get-started-title"
            className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            Get {company.name} running
          </h2>
          <p className="mt-0.5 text-sm leading-6 text-slate-500 dark:text-slate-400">
            A few steps, and your AI Employees start working on their own.
          </p>
        </div>
        <button
          type="button"
          onClick={hide}
          aria-label="Hide the setup checklist"
          title="Hide the setup checklist"
          className="-mr-1 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          <X size={15} />
        </button>
      </div>
      <div className="mx-4 mt-3 flex items-center gap-3 sm:mx-5">
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${steps.length} done`}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-indigo-600 transition-[width] duration-500 motion-reduce:transition-none dark:bg-indigo-400"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </div>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400"
        >
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="mt-4 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
        {steps.map((step, index) => (
          <StepRow key={step.id} step={step} number={index + 1} isNext={step.id === next.id} />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  number,
  isNext,
}: {
  step: GetStartedStep;
  number: number;
  isNext: boolean;
}) {
  return (
    <li
      className={clsx(
        "flex items-start gap-3 px-4 py-3 sm:items-center sm:px-5",
        isNext && "bg-indigo-50/40 dark:bg-indigo-500/5",
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums sm:mt-0",
          step.done
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            : isNext
              ? "border-2 border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
              : "border border-slate-300 text-slate-500 dark:border-slate-600 dark:text-slate-400",
        )}
      >
        {step.done ? <Check size={13} strokeWidth={3} /> : number}
      </span>
      {/* On a phone the button goes under the words rather than squeezing them. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={clsx(
              "text-sm font-medium",
              step.done
                ? "text-slate-500 dark:text-slate-400"
                : "text-slate-900 dark:text-slate-100",
            )}
          >
            {step.title}
            {step.done && <span className="sr-only"> (done)</span>}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {step.description}
          </p>
        </div>
        {!step.done && (
          <Link
            to={step.href}
            className={buttonClassName({
              variant: isNext ? "primary" : "secondary",
              size: "sm",
              className: "shrink-0",
            })}
          >
            {step.action}
          </Link>
        )}
      </div>
    </li>
  );
}
