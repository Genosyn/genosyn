import type { OnboardingStatus } from "./api";

/**
 * The steps Home's "Get started" checklist shows a new company's owners and
 * admins, worked out from what the company really has (`OnboardingStatus`,
 * derived on the server from its rows) rather than from a flag, so a step done
 * anywhere — the setup guide, an employee's settings, the Routines page —
 * ticks itself off.
 *
 * Each undone step links to the place that does it, usually the step of the
 * setup guide it belongs to. Kept apart from the component so the order and
 * the wording can be tested without a DOM.
 */

export type GetStartedStepId = "goal" | "hire" | "model" | "routine" | "team";

export type GetStartedStep = {
  id: GetStartedStepId;
  title: string;
  description: string;
  done: boolean;
  /** Where the step is done, under the company. */
  href: string;
  /** The button's label while the step is undone. */
  action: string;
};

export function getStartedSteps({
  companySlug,
  status,
  memberCount,
}: {
  companySlug: string;
  status: OnboardingStatus;
  /** Members of the company, the person reading included. */
  memberCount: number;
}): GetStartedStep[] {
  const base = `/c/${companySlug}`;
  const employee = status.employee;
  const guide = (step: string) => {
    const params = new URLSearchParams({ step });
    if (employee) params.set("employee", employee.id);
    return `${base}/onboarding?${params.toString()}`;
  };
  const goalSet = status.nextStep !== "company";
  const scheduled = status.scheduledRoutineCount > 0;

  return [
    {
      id: "goal",
      title: "Set your company's Goal",
      description: goalSet
        ? "Every AI Employee reads it before they work."
        : "One sentence with a number in it. Every AI Employee works toward it.",
      done: goalSet,
      href: guide("company"),
      action: "Write the Goal",
    },
    {
      id: "hire",
      title: "Hire your first AI Employee",
      description: employee
        ? `${employee.name}, ${employee.role}.`
        : "Pick a starting role. They arrive with a Soul and Skills you can edit.",
      done: employee !== null,
      href: guide("employee"),
      action: "Hire",
    },
    {
      id: "model",
      title: employee ? `Connect ${employee.name}'s AI Model` : "Connect an AI Model",
      description:
        "Claude, OpenAI, or your own endpoint. Without one, an AI Employee can't answer or run a Routine.",
      done: status.modelConnected,
      href: guide("employee"),
      action: "Connect",
    },
    {
      id: "routine",
      title: employee ? `Give ${employee.name} a Routine` : "Give your AI Employee a Routine",
      description: scheduled
        ? `${status.scheduledRoutineCount} scheduled — work starts by itself, no one has to press start.`
        : "Work that runs on its own schedule, like a morning briefing or a weekly report.",
      done: scheduled,
      href: employee ? guide("recommendations") : `${base}/routines`,
      action: "Choose Routines",
    },
    {
      id: "team",
      title: "Invite your team",
      description:
        memberCount > 1
          ? `${memberCount} people work here.`
          : "Add the people who'll work beside your AI Employees and answer what they ask.",
      done: memberCount > 1,
      href: `${base}/settings/members`,
      action: "Invite",
    },
  ];
}

/** The step to do next: the first one not done, or null when they all are. */
export function nextGetStartedStep(steps: GetStartedStep[]): GetStartedStep | null {
  return steps.find((step) => !step.done) ?? null;
}

/**
 * Whether Home shows the checklist. It appears while the company can't work
 * yet — no Goal, or no connected AI Model, the setup banner's old condition —
 * and once it has appeared it stays to see the optional steps through, until
 * they are all done or the person hides it. A company that was set up before
 * the checklist existed never meets it, so an upgrade doesn't put a to-do list
 * on an established company's Home.
 */
export function showsGetStarted({
  complete,
  next,
  hidden,
  started,
}: {
  /** `OnboardingStatus.complete`: a Goal and a connected AI Model. */
  complete: boolean;
  next: GetStartedStep | null;
  hidden: boolean;
  /** The checklist has appeared for this company in this browser before. */
  started: boolean;
}): boolean {
  if (hidden || !next) return false;
  return !complete || started;
}

/** Where a company's "hide the checklist" choice is kept, in this browser. */
export function getStartedHiddenKey(companyId: string): string {
  return `genosyn.getStarted.hidden.${companyId}`;
}

/** Where it is noted that the checklist has appeared for a company, in this browser. */
export function getStartedStartedKey(companyId: string): string {
  return `genosyn.getStarted.started.${companyId}`;
}
