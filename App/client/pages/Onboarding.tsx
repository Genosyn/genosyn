import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  Bot,
  Check,
  Compass,
  Mail,
  RefreshCw,
  Rocket,
  Sparkles,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { api, Company, Employee } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { clsx } from "../components/ui/clsx";
import { AuthShell } from "./Login";
import { EmailStep } from "./onboarding/EmailStep";
import { EmployeeStep } from "./onboarding/EmployeeStep";
import { FirstRequestStep } from "./onboarding/FirstRequestStep";
import { IntroStep } from "./onboarding/IntroStep";
import { DoneStep } from "./onboarding/DoneStep";
import { RecommendationsStep } from "./onboarding/RecommendationsStep";
import { STEP_WIDTH } from "./onboarding/OnboardingFrame";
import { selectOnboardingEmployee } from "../lib/onboardingRecommendations";
import { createCompanyAndSwitch } from "../lib/companySwitch";

type OnboardingStep =
  | "intro"
  | "employee"
  | "recommendations"
  | "email"
  | "first_request"
  | "done";

/**
 * The rail. `done` is deliberately absent — it is the terminal state, and shows
 * the rail with every step complete rather than adding a sixth dot.
 */
const STEPS: Array<{
  id: OnboardingStep;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  { id: "intro", label: "How it works", hint: "What an AI Employee is", icon: Compass },
  { id: "employee", label: "AI Employee", hint: "Hire one and connect a model", icon: Bot },
  { id: "recommendations", label: "Launch plan", hint: "Recurring work for the role", icon: Rocket },
  { id: "email", label: "Gmail", hint: "Optional mailbox access", icon: Mail },
  { id: "first_request", label: "First request", hint: "Watch them work", icon: Sparkles },
];

const ALL_STEPS: OnboardingStep[] = [...STEPS.map((step) => step.id), "done"];

/**
 * The no-company gate. Once the row exists we refresh App's auth state before
 * navigating so `/c/:slug/onboarding` resolves in the company route tree
 * instead of briefly bouncing back through this gate.
 */
export default function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [mission, setMission] = React.useState("");
  const [vision, setVision] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await createCompanyAndSwitch({
        createCompany: () =>
          api.post<Company>("/api/companies", {
            name: name.trim(),
            mission: mission.trim(),
            vision: vision.trim(),
          }),
        refreshCompanies: onDone,
        navigate,
        suffix: "/onboarding",
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Name your company"
      subtitle="Genosyn runs a company with AI Employees working alongside your team. First, the company they will work for — we explain the rest on the next screen."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />
        <Input
          label="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme"
          autoFocus
          required
        />
        <Textarea
          label="Mission (optional)"
          value={mission}
          onChange={(event) => setMission(event.target.value)}
          placeholder="What do you do, for whom, and why?"
          rows={3}
          className="min-h-24"
          maxLength={2000}
          hint="Used to pick the recurring work we suggest for your first AI Employee. You can write it later."
        />
        <Textarea
          label="Vision (optional)"
          value={vision}
          onChange={(event) => setVision(event.target.value)}
          placeholder="What should be true when the company succeeds?"
          rows={3}
          className="min-h-24"
          maxLength={2000}
        />
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create company and continue"}
        </Button>
      </form>
    </AuthShell>
  );
}

export function CompanyOnboarding({ company }: { company: Company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedEmployeeId = searchParams.get("employee");
  const requestedTemplateId = searchParams.get("template");
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  const [selectedEmployee, setSelectedEmployee] = React.useState<Employee | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | null>(
    requestedTemplateId,
  );

  const rawStep = searchParams.get("step");
  const step: OnboardingStep = ALL_STEPS.includes(rawStep as OnboardingStep)
    ? (rawStep as OnboardingStep)
    : "intro";

  const updateLocation = React.useCallback(
    (nextStep: OnboardingStep, employee?: Employee | null, templateId?: string | null) => {
      const next = new URLSearchParams();
      next.set("step", nextStep);
      const id = employee?.id ?? selectedEmployee?.id;
      if (id) next.set("employee", id);
      const nextTemplateId = templateId === undefined ? selectedTemplateId : templateId;
      if (nextTemplateId) next.set("template", nextTemplateId);
      setSearchParams(next);
    },
    [selectedEmployee, selectedTemplateId, setSearchParams],
  );

  React.useEffect(() => {
    setSelectedTemplateId(requestedTemplateId);
  }, [requestedTemplateId]);

  // Scroll back to the top on every step change: the steps differ enough in
  // height that advancing from a long one used to drop the member halfway down
  // the next. The pane scrolls, not the window.
  const scrollRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  React.useEffect(() => {
    let cancelled = false;
    setEmployees(null);
    setLoadError(null);
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (cancelled) return;
        setEmployees(list);
        setSelectedEmployee(selectOnboardingEmployee(list, requestedEmployeeId));
      })
      .catch((err) => {
        if (cancelled) return;
        // Distinct from "no employees yet" — an empty picker after a failed
        // request reads as "this instance has nothing", and invites a
        // duplicate hire.
        setEmployees([]);
        setSelectedEmployee(null);
        setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, requestedEmployeeId, reloadToken]);

  const needsEmployee = step !== "intro" && step !== "employee" && selectedEmployee === null;

  return (
    // The same scroll container every other page gets from `ContextualLayout`,
    // so the guide behaves like the rest of the app and the shell's "Skip to
    // main content" link has a target on the first screen a member ever sees.
    <main
      ref={scrollRef}
      id="main-content"
      tabIndex={-1}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900"
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
        <div className="mb-6 text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
            {company.name}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl dark:text-slate-50">
            {step === "done" ? "You are set up" : "Set up your first AI Employee"}
          </h1>
        </div>

        <StepRail current={step} onNavigate={updateLocation} />

        <div className={STEP_WIDTH}>
          {employees === null ? (
            <div
              className="flex justify-center py-24"
              role="status"
              aria-label="Loading AI Employees"
            >
              <Spinner size={24} />
            </div>
          ) : loadError !== null ? (
            <Card>
              <CardBody className="p-8 text-center">
                <AlertCircle className="mx-auto text-amber-500" size={26} />
                <h2 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  We could not load your AI Employees
                </h2>
                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {loadError}
                </p>
                <Button className="mt-5" onClick={() => setReloadToken((n) => n + 1)}>
                  <RefreshCw size={15} /> Try again
                </Button>
              </CardBody>
            </Card>
          ) : step === "intro" ? (
            <IntroStep company={company} onContinue={() => updateLocation("employee")} />
          ) : step === "employee" ? (
            <EmployeeStep
              company={company}
              employee={selectedEmployee}
              onCreated={(employee, templateId) => {
                setEmployees((current) => [...(current ?? []), employee]);
                setSelectedEmployee(employee);
                setSelectedTemplateId(templateId);
                updateLocation("employee", employee, templateId);
              }}
              onBack={() => updateLocation("intro")}
              onContinue={() => updateLocation("recommendations")}
            />
          ) : needsEmployee ? (
            <Card>
              <CardBody className="p-8 text-center">
                <UserRound className="mx-auto text-slate-400" size={28} />
                <h2 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Hire an AI Employee first
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  A launch plan, email access, and first requests all belong to an AI Employee.
                </p>
                <Button className="mt-5" onClick={() => updateLocation("employee")}>
                  Start hiring
                </Button>
              </CardBody>
            </Card>
          ) : step === "recommendations" ? (
            <RecommendationsStep
              company={company}
              employee={selectedEmployee as Employee}
              templateId={selectedTemplateId}
              onBack={() => updateLocation("employee")}
              onContinue={() => updateLocation("email")}
              continueLabel="Continue to Gmail"
            />
          ) : step === "email" ? (
            <EmailStep
              company={company}
              employee={selectedEmployee as Employee}
              onBack={() => updateLocation("recommendations")}
              onContinue={() => updateLocation("done")}
            />
          ) : step === "first_request" ? (
            <FirstRequestStep
              company={company}
              employee={selectedEmployee as Employee}
              onBack={() => updateLocation("done")}
            />
          ) : (
            <DoneStep
              company={company}
              employee={selectedEmployee as Employee}
              onOpenFirstRequest={() => updateLocation("first_request")}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function StepRail({
  current,
  onNavigate,
}: {
  current: OnboardingStep;
  onNavigate: (step: OnboardingStep) => void;
}) {
  const done = current === "done";
  const currentIndex = done ? -1 : STEPS.findIndex((s) => s.id === current);
  const active = STEPS[currentIndex] ?? null;
  // On the summary, setup really is finished — but the flow reaches it from
  // Gmail, so "First request" has not happened. Mark everything before it
  // complete and leave that last one open rather than certifying a skipped
  // step. Every rail entry stays reachable from here.
  const completeThrough = done ? STEPS.length - 1 : currentIndex;

  return (
    <div className="mb-6">
      {/* Mobile: a rail of five labels does not fit, so name the position. */}
      <p className="mb-4 text-center text-sm text-slate-500 sm:hidden dark:text-slate-400">
        {active ? (
          <>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Step {currentIndex + 1} of {STEPS.length}
            </span>{" "}
            · {active.label}
          </>
        ) : (
          <span className="font-medium text-slate-900 dark:text-slate-100">Setup complete</span>
        )}
      </p>

      <ol className="mx-auto hidden max-w-3xl grid-cols-5 sm:grid" aria-label="Setup progress">
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          const complete = index < completeThrough;
          const isActive = index === currentIndex;
          const revisitable = complete || (done && !complete);
          const label = `Step ${index + 1} of ${STEPS.length}: ${step.label}`;
          const dot = (
            <>
              <span
                className={clsx(
                  "relative z-10 grid h-8 w-8 place-items-center rounded-full border bg-white transition-colors dark:bg-slate-900",
                  isActive
                    ? "border-indigo-500 text-indigo-600 ring-4 ring-indigo-100 dark:text-indigo-300 dark:ring-indigo-500/20"
                    : complete
                      ? "border-indigo-500 bg-indigo-600 text-white dark:bg-indigo-500"
                      : "border-slate-200 text-slate-400 dark:border-slate-700 dark:text-slate-500",
                )}
              >
                {complete ? <Check size={14} /> : <Icon size={14} />}
              </span>
              <span
                className={clsx(
                  "text-xs font-medium",
                  isActive || complete
                    ? "text-slate-900 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400",
                )}
              >
                {step.label}
              </span>
              <span className="px-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
                {step.hint}
              </span>
            </>
          );

          return (
            <li
              key={step.id}
              aria-current={isActive ? "step" : undefined}
              className="relative flex flex-col items-center gap-1.5 text-center"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    "absolute right-1/2 top-4 h-px w-full",
                    index <= completeThrough
                      ? "bg-indigo-400 dark:bg-indigo-500"
                      : "bg-slate-200 dark:bg-slate-700",
                  )}
                />
              )}
              {revisitable ? (
                // Every step re-derives its state from the server, so moving
                // around is always safe — and the rail already looks clickable.
                <button
                  type="button"
                  onClick={() => onNavigate(step.id)}
                  aria-label={complete ? `${label} — completed, go back` : `${label} — go to step`}
                  className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-0.5 hover:opacity-80"
                >
                  {dot}
                </button>
              ) : (
                <span className="flex flex-col items-center gap-1.5 px-1 py-0.5">
                  <span className="sr-only">{label}</span>
                  {dot}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
