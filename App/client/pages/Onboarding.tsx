import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bot,
  Check,
  Mail,
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
import { clsx } from "../components/ui/clsx";
import { useToast } from "../components/ui/Toast";
import { AuthShell } from "./Login";
import { EmailStep } from "./onboarding/EmailStep";
import { EmployeeStep } from "./onboarding/EmployeeStep";
import { FirstRequestStep } from "./onboarding/FirstRequestStep";

type OnboardingStep = "employee" | "email" | "first_task";

const STEPS: Array<{
  id: OnboardingStep;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "employee", label: "AI Employee", icon: Bot },
  { id: "email", label: "Email", icon: Mail },
  { id: "first_task", label: "First request", icon: Sparkles },
];

/**
 * The no-company gate. Once the row exists we refresh App's auth state before
 * navigating so `/c/:slug/onboarding` resolves in the company route tree
 * instead of briefly bouncing back through this gate.
 */
export default function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const company = await api.post<Company>("/api/companies", { name });
      await onDone();
      navigate(`/c/${company.slug}/onboarding`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Build your AI team">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />
        <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
          Start with a company, then Genosyn will guide you through hiring an AI Employee,
          connecting email, and making a useful first request.
        </p>
        <Input
          label="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme"
          autoFocus
          required
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
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [selectedEmployee, setSelectedEmployee] = React.useState<Employee | null>(null);
  const { toast } = useToast();

  const rawStep = searchParams.get("step");
  const step: OnboardingStep = STEPS.some((item) => item.id === rawStep)
    ? (rawStep as OnboardingStep)
    : "employee";

  const updateLocation = React.useCallback(
    (nextStep: OnboardingStep, employee?: Employee | null) => {
      const next = new URLSearchParams();
      next.set("step", nextStep);
      const id = employee?.id ?? selectedEmployee?.id;
      if (id) next.set("employee", id);
      setSearchParams(next);
    },
    [selectedEmployee, setSearchParams],
  );

  const loadEmployees = React.useCallback(async () => {
    const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
    setEmployees(list);
    const requestedId = searchParams.get("employee");
    setSelectedEmployee(
      list.find((employee) => employee.id === requestedId) ?? list[0] ?? null,
    );
  }, [company.id, searchParams]);

  React.useEffect(() => {
    loadEmployees().catch((err) => {
      setEmployees([]);
      toast((err as Error).message, "error");
    });
  }, [loadEmployees, toast]);

  return (
    <div className="min-h-full bg-slate-50/70 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
        <div className="mb-8 text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-400">
            Welcome to {company.name}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50 sm:text-3xl">
            Put your first AI Employee to work
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Hire a teammate, give them the right access, then start with one concrete request.
          </p>
        </div>

        <StepRail current={step} />

        {employees === null ? (
          <div className="flex justify-center py-24">
            <Spinner size={24} />
          </div>
        ) : step === "employee" ? (
          <EmployeeStep
            company={company}
            employee={selectedEmployee}
            onCreated={(employee) => {
              setEmployees((current) => [...(current ?? []), employee]);
              setSelectedEmployee(employee);
              updateLocation("employee", employee);
            }}
            onContinue={() => updateLocation("email")}
          />
        ) : selectedEmployee === null ? (
          <Card className="mx-auto max-w-xl">
            <CardBody className="p-8 text-center">
              <UserRound className="mx-auto text-slate-400" size={28} />
              <h2 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
                Hire an AI Employee first
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Email access and first requests need an AI Employee to belong to.
              </p>
              <Button className="mt-5" onClick={() => updateLocation("employee")}>
                Start hiring
              </Button>
            </CardBody>
          </Card>
        ) : step === "email" ? (
          <EmailStep
            company={company}
            employee={selectedEmployee}
            onBack={() => updateLocation("employee")}
            onContinue={() => updateLocation("first_task")}
          />
        ) : (
          <FirstRequestStep
            company={company}
            employee={selectedEmployee}
            onBack={() => updateLocation("email")}
          />
        )}
      </div>
    </div>
  );
}

function StepRail({ current }: { current: OnboardingStep }) {
  const currentIndex = STEPS.findIndex((step) => step.id === current);

  return (
    <ol className="mx-auto mb-8 grid max-w-2xl grid-cols-3" aria-label="Onboarding progress">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        const complete = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={step.id} className="relative flex flex-col items-center gap-2 text-center">
            {index > 0 && (
              <span
                className={clsx(
                  "absolute right-1/2 top-4 h-px w-full",
                  index <= currentIndex
                    ? "bg-indigo-400 dark:bg-indigo-600"
                    : "bg-slate-200 dark:bg-slate-800",
                )}
              />
            )}
            <span
              className={clsx(
                "relative z-10 grid h-8 w-8 place-items-center rounded-full border bg-white dark:bg-slate-950",
                active
                  ? "border-indigo-500 text-indigo-600 ring-4 ring-indigo-100 dark:text-indigo-300 dark:ring-indigo-950"
                  : complete
                    ? "border-indigo-500 bg-indigo-600 text-white dark:bg-indigo-500"
                    : "border-slate-200 text-slate-400 dark:border-slate-800",
              )}
            >
              {complete ? <Check size={14} /> : <Icon size={14} />}
            </span>
            <span
              className={clsx(
                "text-xs font-medium",
                active || complete
                  ? "text-slate-900 dark:text-slate-100"
                  : "text-slate-400 dark:text-slate-600",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
